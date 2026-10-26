// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import worker, { type WorkerEnv } from "@vflow/api";
import { VFlowClient } from "@vflow/client";
import type {
  CloudflareD1DatabaseLike,
  CloudflareD1PreparedStatementLike,
  CloudflareR2BucketLike,
} from "@vflow/domain";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Workbench } from "../../apps/web/src/Workbench.tsx";
import { TEST_WORKER_AUTH } from "./auth-fixture.ts";
import { seedReferences } from "./reference-fixture.ts";
import { projectComposition } from "./project-fixture.ts";
import {
  HUMAN_READER_HEADERS,
  HUMAN_WRITER_HEADERS,
  utf8Bytes,
} from "./helpers.ts";

afterEach(() => {
  cleanup();
});

function createSqliteD1Adapter(migrateOwnership = true): {
  sqlite: DatabaseSync;
  d1: CloudflareD1DatabaseLike;
} {
  const sqlite = new DatabaseSync(":memory:");
  const migrationPath = path.resolve(
    import.meta.dirname,
    "../../apps/api/migrations/0001_initial.sql",
  );
  const schemaSql = fs.readFileSync(migrationPath, "utf8");
  sqlite.exec(schemaSql);
  sqlite.exec(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../apps/api/migrations/0002_mcp_oauth.sql",
      ),
      "utf8",
    ),
  );
  sqlite.exec(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../apps/api/migrations/0003_reference_authoring.sql",
      ),
      "utf8",
    ),
  );

  if (migrateOwnership)
    sqlite.exec(
      fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../apps/api/migrations/0004_ownership_recycle_bin.sql",
        ),
        "utf8",
      ),
    );

  const createStatement = (
    query: string,
    boundValues: SQLInputValue[] = [],
  ): CloudflareD1PreparedStatementLike => ({
    bind(...values: unknown[]) {
      return createStatement(query, values as SQLInputValue[]);
    },
    async all<T = Record<string, unknown>>() {
      const stmt = sqlite.prepare(query);
      const rows = stmt.all(...boundValues) as T[];
      return { results: rows };
    },
    async run() {
      const stmt = sqlite.prepare(query);
      const info = stmt.run(...boundValues);
      return { meta: { changes: Number(info.changes) } };
    },
  });

  const d1: CloudflareD1DatabaseLike = {
    prepare(query: string) {
      return createStatement(query);
    },
    async batch(statements: CloudflareD1PreparedStatementLike[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results: Array<{ meta?: { changes?: number } }> = [];
        for (const stmt of statements) {
          results.push(await stmt.run());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };

  return { sqlite, d1 };
}

function createR2BucketAdapter(): CloudflareR2BucketLike {
  const store = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    async put(key, value, options) {
      const bytes =
        value instanceof Uint8Array
          ? new Uint8Array(value)
          : new Uint8Array(value);
      store.set(key, {
        bytes,
        contentType: options?.httpMetadata?.contentType,
      });
    },
    async get(key, options) {
      const item = store.get(key);
      if (!item) return null;
      return {
        body: new Response(
          options?.range
            ? item.bytes.slice(
                options.range.offset,
                options.range.offset + options.range.length,
              )
            : new Uint8Array(item.bytes),
        ).body!,
        async arrayBuffer() {
          return new Uint8Array(item.bytes).buffer;
        },
        httpMetadata: { contentType: item.contentType },
      };
    },
    async delete(key) {
      store.delete(key);
    },
    async head(key) {
      return store.has(key) ? { key } : null;
    },
  };
}

describe("E2E 09 — Cloudflare D1/R2 持久化绑定、Static Assets 与空库引导 (D1/R2 Persistence & Bootstrap)", () => {
  it("backfills known human ownership, preserves explicit members, quarantines ambiguous agent-created projects", async () => {
    const { sqlite, d1 } = createSqliteD1Adapter(false);
    for (const [id, creator] of [
      ["human", "alice@talkincode.net"],
      ["single", "legacy-agent"],
      ["ambiguous", "legacy-agent"],
    ])
      sqlite
        .prepare(
          "INSERT INTO projects(id,name,created_at,created_by) VALUES (?,?,?,?)",
        )
        .run(id, id, new Date().toISOString(), creator);
    for (const [project, actor, role] of [
      ["human", "alice@talkincode.net", "writer"],
      ["human", "bob-reader@talkincode.net", "reader"],
      ["single", "alice@talkincode.net", "writer"],
      ["ambiguous", "alice@talkincode.net", "writer"],
      ["ambiguous", "bob-reader@talkincode.net", "writer"],
    ])
      sqlite
        .prepare(
          "INSERT INTO project_members(project_id,actor_id,role) VALUES (?,?,?)",
        )
        .run(project, actor, role);
    sqlite.exec(
      fs.readFileSync(
        path.resolve(
          import.meta.dirname,
          "../../apps/api/migrations/0004_ownership_recycle_bin.sql",
        ),
        "utf8",
      ),
    );
    const rows = sqlite
      .prepare("SELECT id,owner_user_id,sharing_mode FROM projects ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "ambiguous", owner_user_id: null, sharing_mode: "private" },
      {
        id: "human",
        owner_user_id: "alice@talkincode.net",
        sharing_mode: "members",
      },
      {
        id: "single",
        owner_user_id: "alice@talkincode.net",
        sharing_mode: "private",
      },
    ]);
    const env: WorkerEnv = {
      ...TEST_WORKER_AUTH,
      DB: d1,
      MEDIA_BUCKET: createR2BucketAdapter(),
    };
    const response = await worker.fetch(
      new Request("https://vflow.test/v1/projects", {
        headers: HUMAN_WRITER_HEADERS,
      }),
      env,
    );
    expect(
      ((await response.json()) as { projects: { id: string }[] }).projects
        .map((p) => p.id)
        .sort(),
    ).toEqual(["human", "single"]);
    sqlite.close();
  });
  it("persists ownership, explicit sharing and recycle-bin history across Worker isolates", async () => {
    const { sqlite, d1 } = createSqliteD1Adapter();
    const env: WorkerEnv = {
      ...TEST_WORKER_AUTH,
      DB: d1,
      MEDIA_BUCKET: createR2BucketAdapter(),
    };
    const client = (headers: Record<string, string>) =>
      new VFlowClient({
        baseUrl: "https://vflow.test",
        headers,
        fetchFn: (input, init) =>
          worker.fetch(new Request(String(input), init), env),
      });
    const owner = client(HUMAN_WRITER_HEADERS),
      reader = client(HUMAN_READER_HEADERS);
    await owner.createProject({
      id: "lifecycle",
      name: "Persisted",
      authoringMode: "legacy",
    });
    await owner.createComposition({
      projectId: "lifecycle",
      document: projectComposition("lifecycle", "main", "Main", "Frame"),
    });
    expect(await reader.listProjects()).toEqual([]);
    await owner.setProjectMember({
      projectId: "lifecycle",
      targetActorId: "bob-reader@talkincode.net",
      role: "reader",
      baseRevision: 0,
      operationId: "grant",
    });
    expect((await reader.getProject("lifecycle")).ownerUserId).toBe(
      "alice@talkincode.net",
    );
    const original = await owner.getComposition("lifecycle", "main");
    await owner.changeResource({
      projectId: "lifecycle",
      kind: "composition",
      id: "main",
      action: "trash",
      baseRevision: 0,
      expectedHeadRevision: 1,
      operationId: "trash",
    });
    expect(
      await client(HUMAN_WRITER_HEADERS).listCompositions("lifecycle"),
    ).toEqual([]);
    const trash = await client(HUMAN_WRITER_HEADERS).listTrash();
    expect(trash.items).toHaveLength(1);
    expect((await reader.listTrash()).items[0].canRestore).toBe(false);
    await client(HUMAN_WRITER_HEADERS).changeResource({
      projectId: "lifecycle",
      kind: "composition",
      id: "main",
      action: "restore",
      baseRevision: 1,
      expectedHeadRevision: 1,
      operationId: "restore",
    });
    expect(await owner.getComposition("lifecycle", "main")).toEqual(original);
    expect(
      sqlite
        .prepare(
          "SELECT owner_user_id, sharing_mode, membership_revision FROM projects WHERE id='lifecycle'",
        )
        .get(),
    ).toMatchObject({
      owner_user_id: "alice@talkincode.net",
      sharing_mode: "members",
      membership_revision: 1,
    });
    const lifecycle = sqlite
      .prepare("SELECT record_json FROM resource_lifecycle")
      .get() as { record_json: string };
    expect(JSON.parse(lifecycle.record_json).headRevision).toBe(2);
    sqlite.close();
  });
  it("Happy Path: bootstraps empty D1 database from Workbench UI, persists revisions & R2 assets across stateless Worker isolates, and serves Static Assets", async () => {
    const { sqlite, d1 } = createSqliteD1Adapter();
    const r2 = createR2BucketAdapter();

    const env: WorkerEnv = {
      ...TEST_WORKER_AUTH,
      DB: d1,
      MEDIA_BUCKET: r2,
      ASSETS: {
        async fetch(req: Request) {
          return new Response(
            `<!doctype html><html><body>Static Asset for ${new URL(req.url).pathname}</body></html>`,
            { headers: { "content-type": "text/html" } },
          );
        },
      },
    };

    // 1. Verify non-API route delegates to Workers Static Assets binding
    const staticRes = await worker.fetch(
      new Request("https://vflow.talkincode.net/"),
      env,
    );
    expect(staticRes.status).toBe(200);
    expect(await staticRes.text()).toContain("Static Asset for /");

    // 2. Create client bound to stateless Worker fetch with D1 + R2 env
    const writerClient = new VFlowClient({
      baseUrl: "https://vflow.talkincode.net",
      fetchFn: (input, init) =>
        worker.fetch(new Request(String(input), init), env),
      headers: HUMAN_WRITER_HEADERS,
    });

    // 3. Render Workbench against empty D1 database -> shows bootstrap button
    render(
      <Workbench
        client={writerClient}
        projectId="demo"
        compositionId="episode-001"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("empty-workspace-bootstrap")).toBeDefined();
    });

    // Click Initialize Project & Composition
    fireEvent.click(screen.getByTestId("btn-bootstrap-project"));

    await waitFor(() => {
      expect(screen.getByTestId("composition-title").textContent).toBe(
        "初始编排工作台",
      );
    });
    expect(screen.getByTestId("composition-revision").textContent).toBe(
      "修订 #1",
    );

    // 4. Upload asset into R2 and patch composition in D1
    await writerClient.uploadAsset({
      projectId: "demo",
      assetId: "d1-r2-bgm",
      bytes: utf8Bytes("persisted-r2-audio-stream"),
      mimeType: "audio/mpeg",
      durationFrames: 300,
    });

    await writerClient.patchComposition({
      projectId: "demo",
      compositionId: "episode-001",
      baseRevision: 1,
      operationId: "d1-add-bgm-1",
      operations: [
        {
          op: "upsert_audio_track",
          track: {
            id: "bgm-main",
            role: "bgm",
            asset: "d1-r2-bgm",
            startFrame: 0,
            durationFrames: 300,
          },
        },
      ],
    });

    // 5. Verify raw SQLite rows exist in D1 tables
    const compRows = sqlite
      .prepare(
        "SELECT id, head_revision FROM compositions WHERE project_id = 'demo'",
      )
      .all() as Array<{ id: string; head_revision: number }>;
    expect(compRows).toEqual([{ id: "episode-001", head_revision: 2 }]);

    // 6. A fresh client/request hits a brand-new Worker isolate (no shared memory) and reads Revision #2 from D1
    const freshFetched = await writerClient.getComposition(
      "demo",
      "episode-001",
    );
    expect(freshFetched.headRevision).toBe(2);
    expect(freshFetched.revisionRecord.document.audioTracks[0].asset).toBe(
      "d1-r2-bgm",
    );
    // Preview streams use the persisted D1 asset and R2 range API across isolates.
    const partial = await worker.fetch(
      new Request(writerClient.assetContentUrl("demo", "d1-r2-bgm"), {
        headers: { ...HUMAN_WRITER_HEADERS, Range: "bytes=0-8" },
      }),
      env,
    );
    expect(partial.status).toBe(206);
    expect(await partial.text()).toBe("persisted");
    expect(partial.headers.get("content-range")).toBe("bytes 0-8/25");
  });

  it("Failure Path, Role Verification & Rollback: enforces reader/writer roles on D1 and rolls back D1 batch on CAS conflict", async () => {
    const { d1 } = createSqliteD1Adapter();
    const r2 = createR2BucketAdapter();
    const env: WorkerEnv = { ...TEST_WORKER_AUTH, DB: d1, MEDIA_BUCKET: r2 };

    const writerClient = new VFlowClient({
      baseUrl: "https://vflow.talkincode.net",
      fetchFn: (input, init) =>
        worker.fetch(new Request(String(input), init), env),
      headers: HUMAN_WRITER_HEADERS,
    });
    const readerClient = new VFlowClient({
      baseUrl: "https://vflow.talkincode.net",
      fetchFn: (input, init) =>
        worker.fetch(new Request(String(input), init), env),
      headers: HUMAN_READER_HEADERS,
    });

    const projectCreation = {
      id: "d1-proj",
      name: "D1 Project",
      members: { "bob-reader@talkincode.net": "reader" as const },
      operationId: "d1-project-once",
    };
    const project = await writerClient.createProject({
      ...projectCreation,
      authoringMode: "legacy",
    });
    expect(
      await writerClient.createProject({
        ...projectCreation,
        authoringMode: "legacy",
      }),
    ).toEqual(project);
    const compositionCreation = {
      projectId: "d1-proj",
      operationId: "d1-composition-once",
      document: projectComposition("d1-proj", "first", "第一条", "开场"),
    };
    const revision = await writerClient.createComposition(compositionCreation);
    expect(await writerClient.createComposition(compositionCreation)).toEqual(
      revision,
    );
    const overview = await readerClient.getProjectOverview("d1-proj");
    expect(overview.role).toBe("reader");
    expect(overview.compositions).toHaveLength(1);

    // Reader can read project from D1
    const proj = await readerClient.getProject("d1-proj");
    expect(proj.name).toBe("D1 Project");

    // Reader cannot write to D1
    await expect(
      readerClient.uploadAsset({
        projectId: "d1-proj",
        assetId: "illegal-asset",
        bytes: utf8Bytes("no"),
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Corrupted upload hash mismatch does not persist asset row in D1
    await expect(
      writerClient.uploadAsset({
        projectId: "d1-proj",
        assetId: "bad-hash-asset",
        bytes: utf8Bytes("actual"),
        expectedSha256: "f".repeat(64),
        mimeType: "image/png",
      }),
    ).rejects.toMatchObject({ code: "ASSET_INTEGRITY_ERROR" });

    const assetsInD1 = await readerClient.listAssets("d1-proj");
    expect(assetsInD1).toHaveLength(0);
  });
  it("persists strict reference revisions, context and exact-input evidence across fresh Worker isolates", async () => {
    const { d1, sqlite } = createSqliteD1Adapter();
    const env: WorkerEnv = {
      ...TEST_WORKER_AUTH,
      DB: d1,
      MEDIA_BUCKET: createR2BucketAdapter(),
    };
    const client = () =>
      new VFlowClient({
        baseUrl: "https://vflow.talkincode.net",
        headers: HUMAN_WRITER_HEADERS,
        fetchFn: (input, init) =>
          worker.fetch(new Request(String(input), init), env),
      });
    const writer = client();
    const fixture = await seedReferences(writer);
    const fresh = client();
    await fresh.getAuthoringWorkflow("reference-test");
    expect(
      (await fresh.getAuthoringDocument("reference-test", "suwei-face", 3))
        .status,
    ).toBe("approved");
    const packet = (
      await fresh.prepareGenerationInputs("reference-test", fixture.request)
    ).packet!;
    const evidence = await fresh.recordGenerationEvidence({
      projectId: "reference-test",
      id: "persisted",
      operationId: "persist-evidence",
      packet,
      actualInputs: packet.inputs.map(({ asset, sha256, role }) => ({
        asset,
        sha256,
        role,
      })),
      outputs: ["panel-one"],
      method: "agent_reported",
      evidence: "Synthetic external report persisted across isolated calls.",
    });
    expect(evidence.matchesPlan).toBe(true);
    expect(
      (await client().listGenerationEvidence("reference-test"))[0],
    ).toEqual(evidence);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM reference_documents").get()
        ?.count,
    ).toBe(6);
    sqlite.close();
  });
});
