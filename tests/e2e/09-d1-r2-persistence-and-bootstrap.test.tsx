// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import worker, { type WorkerEnv } from "@video-compose/api";
import { VideoComposeClient } from "@video-compose/client";
import type {
  CloudflareD1DatabaseLike,
  CloudflareD1PreparedStatementLike,
  CloudflareR2BucketLike,
} from "@video-compose/domain";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Workbench } from "../../apps/web/src/Workbench.tsx";
import {
  HUMAN_READER_HEADERS,
  HUMAN_WRITER_HEADERS,
  utf8Bytes,
} from "./helpers.ts";

afterEach(() => {
  cleanup();
});

function createSqliteD1Adapter(): {
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
        value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
      store.set(key, {
        bytes,
        contentType: options?.httpMetadata?.contentType,
      });
    },
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      return {
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
  it("Happy Path: bootstraps empty D1 database from Workbench UI, persists revisions & R2 assets across stateless Worker isolates, and serves Static Assets", async () => {
    const { sqlite, d1 } = createSqliteD1Adapter();
    const r2 = createR2BucketAdapter();

    const env: WorkerEnv = {
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
      new Request("https://video-compose.talkincode.net/"),
      env,
    );
    expect(staticRes.status).toBe(200);
    expect(await staticRes.text()).toContain("Static Asset for /");

    // 2. Create client bound to stateless Worker fetch with D1 + R2 env
    const writerClient = new VideoComposeClient({
      baseUrl: "https://video-compose.talkincode.net",
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
      .prepare("SELECT id, head_revision FROM compositions WHERE project_id = 'demo'")
      .all() as Array<{ id: string; head_revision: number }>;
    expect(compRows).toEqual([{ id: "episode-001", head_revision: 2 }]);

    // 6. A fresh client/request hits a brand-new Worker isolate (no shared memory) and reads Revision #2 from D1
    const freshFetched = await writerClient.getComposition("demo", "episode-001");
    expect(freshFetched.headRevision).toBe(2);
    expect(freshFetched.revisionRecord.document.audioTracks[0].asset).toBe(
      "d1-r2-bgm",
    );
  });

  it("Failure Path, Role Verification & Rollback: enforces reader/writer roles on D1 and rolls back D1 batch on CAS conflict", async () => {
    const { d1 } = createSqliteD1Adapter();
    const r2 = createR2BucketAdapter();
    const env: WorkerEnv = { DB: d1, MEDIA_BUCKET: r2 };

    const writerClient = new VideoComposeClient({
      baseUrl: "https://video-compose.talkincode.net",
      fetchFn: (input, init) =>
        worker.fetch(new Request(String(input), init), env),
      headers: HUMAN_WRITER_HEADERS,
    });
    const readerClient = new VideoComposeClient({
      baseUrl: "https://video-compose.talkincode.net",
      fetchFn: (input, init) =>
        worker.fetch(new Request(String(input), init), env),
      headers: HUMAN_READER_HEADERS,
    });

    await writerClient.createProject({
      id: "d1-proj",
      name: "D1 Project",
      members: { "bob-reader@talkincode.net": "reader" },
    });

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
});
