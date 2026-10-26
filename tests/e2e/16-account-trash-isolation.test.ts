import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApiApp } from "@vflow/api";
import {
  createTestHarness,
  HUMAN_WRITER_HEADERS,
  HUMAN_READER_HEADERS,
} from "./helpers.ts";
import { TEST_AUTH_CONFIG } from "./auth-fixture.ts";
import { projectComposition } from "./project-fixture.ts";

async function seed(h: ReturnType<typeof createTestHarness>, id = "private") {
  await h.writerClient.createProject({ id, name: id });
  await h.writerClient.getAuthoringWorkflow(id);
  const bytes = new Uint8Array(
    await fs.readFile(
      path.resolve(import.meta.dirname, "../fixtures/preview.png"),
    ),
  );
  await h.writerClient.uploadAsset({
    projectId: id,
    assetId: "picture",
    mimeType: "image/png",
    bytes,
  });
  const doc = projectComposition(id, "main", "Main", "Frame");
  doc.shots[doc.sequence[0]].candidates.images = [{ asset: "picture" }];
  await h.writerClient.createComposition({
    projectId: id,
    document: doc,
    operationId: "initial",
  });
  await h.writerClient.createSubject({
    projectId: id,
    id: "hero",
    kind: "character",
    name: "Hero",
    definition: { description: "One identity", invariants: [] },
    variants: {
      default: {
        description: "Default",
        referencePack: [{ asset: "picture", status: "candidate" }],
      },
    },
    defaultVariant: "default",
  });
  return doc;
}
describe("E2E 16 — private accounts, explicit sharing, recycle-bin lifecycle and verified sessions", () => {
  it("defaults to the verified account, denies cross-user nested reads and ignores forged identity headers", async () => {
    const h = createTestHarness();
    await seed(h);
    const own = await h.writerClient.getProject("private");
    expect(own.ownerUserId).toBe("alice@talkincode.net");
    expect(own.sharingMode).toBe("private");
    expect(await h.readerClient.listProjects()).toEqual([]);
    await h.readerClient.callMcpTool("project_create", {
      id: "bob",
      name: "Bob",
      ownerUserId: "alice@talkincode.net",
      userId: "alice@talkincode.net",
    });
    expect((await h.readerClient.getProject("bob")).ownerUserId).toBe(
      "bob-reader@talkincode.net",
    );
    const denied = [
      () => h.readerClient.getComposition("private", "main"),
      () => h.readerClient.listSubjects("private"),
      () => h.readerClient.listAssets("private"),
      () => h.readerClient.getAuthoringWorkflow("private"),
      () =>
        h.readerClient.exportCompositionBundle({
          projectId: "private",
          compositionId: "main",
          format: "json",
        }),
      () => h.readerClient.getCompositionHistory("private", "main"),
    ];
    for (const read of denied)
      await expect(read()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.readerClient.callMcpTool("asset_search", { projectId: "private" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { app } = createApiApp(h.domain, TEST_AUTH_CONFIG);
    const forged = await app.request("/v1/projects/private", {
      headers: {
        ...HUMAN_READER_HEADERS,
        "cf-access-authenticated-user-email": "alice@talkincode.net",
        "x-user-id": "alice@talkincode.net",
        "x-agent-id": "alice@talkincode.net",
      },
    });
    expect(forged.status).toBe(403);
    const token = HUMAN_WRITER_HEADERS["cf-access-jwt-assertion"];
    const pieces = token.split(".");
    pieces[1] = btoa(
      JSON.stringify({
        email: "alice@talkincode.net",
        iss: TEST_AUTH_CONFIG.access!.issuer,
        aud: TEST_AUTH_CONFIG.access!.audience,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).replace(/=/g, "");
    const invalid = await app.request("/v1/session", {
      headers: {
        "cf-access-authenticated-user-email": "alice@talkincode.net",
        "cf-access-jwt-assertion": pieces.join("."),
      },
    });
    expect(invalid.status).toBe(401);
    const missingConfig = createApiApp();
    expect(
      (
        await missingConfig.app.request("/v1/session", {
          headers: HUMAN_WRITER_HEADERS,
        })
      ).status,
    ).toBe(401);
    const unmapped = createApiApp(undefined, {
      ...TEST_AUTH_CONFIG,
      allowedServiceTokens: {
        unmapped: {
          secret: "synthetic-only",
          defaultActorId: "agent",
          ownerUserId: "",
        },
      },
    });
    expect(
      (
        await unmapped.app.request("/v1/session", {
          headers: {
            "cf-access-client-id": "unmapped",
            "cf-access-client-secret": "synthetic-only",
          },
        })
      ).status,
    ).toBe(401);
    const asset = await app.request(
      "/v1/projects/private/assets/picture/content",
      { headers: HUMAN_READER_HEADERS },
    );
    expect(asset.status).toBe(403);
    const good = await app.request(
      "/v1/projects/private/assets/picture/content",
      { headers: HUMAN_WRITER_HEADERS },
    );
    expect(good.status).toBe(200);
    expect(good.headers.get("cache-control")).toBe("private, no-store");
    expect((await h.writerClient.getSession()).actor.userId).toBe(
      "alice@talkincode.net",
    );
  });
  it("shares only by owner authorization, preserves reader/writer limits and revokes access atomically", async () => {
    const h = createTestHarness();
    await seed(h);
    const grant = {
      projectId: "private",
      targetActorId: "bob-reader@talkincode.net",
      role: "reader" as const,
      baseRevision: 0,
      operationId: "share",
    };
    h.domain.store.injectFaultOnce("setProjectMemberRole");
    await expect(h.writerClient.setProjectMember(grant)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect(await h.readerClient.listProjects()).toEqual([]);
    const shared = await h.writerClient.setProjectMember(grant);
    expect(shared.sharingMode).toBe("members");
    expect(shared.membershipRevision).toBe(1);
    expect(await h.writerClient.setProjectMember(grant)).toEqual(shared);
    expect((await h.readerClient.listProjects()).map((p) => p.id)).toEqual([
      "private",
    ]);
    expect((await h.readerClient.getProjectAccess("private")).role).toBe(
      "reader",
    );
    await expect(
      h.readerClient.changeResource({
        projectId: "private",
        kind: "composition",
        id: "main",
        action: "trash",
        baseRevision: 0,
        expectedHeadRevision: 1,
        operationId: "reader-delete",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.readerClient.setProjectMember({
        ...grant,
        targetActorId: "mallory@talkincode.net",
        baseRevision: 1,
        operationId: "reshare",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      h.writerClient.setProjectMember({
        ...grant,
        role: "writer",
        operationId: "stale",
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await h.writerClient.setProjectMember({
      ...grant,
      role: "writer",
      baseRevision: 1,
      operationId: "writer-grant",
    });
    await expect(
      h.readerClient.changeResource({
        projectId: "private",
        kind: "project",
        id: "private",
        action: "trash",
        baseRevision: 0,
        operationId: "shared-writer-delete-project",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await h.writerClient.setProjectMember({
      ...grant,
      role: null,
      baseRevision: 2,
      operationId: "revoke",
    });
    expect(await h.readerClient.listProjects()).toEqual([]);
    await expect(
      h.readerClient.getComposition("private", "main"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await h.writerClient.setProjectMember({
      projectId: "private",
      targetActorId: "agent-observer",
      role: "reader",
      baseRevision: 3,
      operationId: "agent-reader",
    });
    expect((await h.agentReaderClient.getProjectAccess("private")).role).toBe(
      "reader",
    );
    const spoofing = h.agentReaderClient.withHeaders({
      "x-agent-id": "alice@talkincode.net",
    });
    await expect(
      spoofing.changeResource({
        projectId: "private",
        kind: "project",
        id: "private",
        action: "trash",
        baseRevision: 0,
        operationId: "spoof-principal",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("soft-deletes and restores without changing content; project restore respects separately trashed children and protects retained media", async () => {
    const h = createTestHarness();
    const doc = await seed(h);
    const exported = await h.writerClient.exportCompositionBundle({
      projectId: "private",
      compositionId: "main",
      format: "json",
    });
    const remove = {
      projectId: "private",
      kind: "composition" as const,
      id: "main",
      action: "trash" as const,
      baseRevision: 0,
      expectedHeadRevision: 1,
      operationId: "delete-main",
    };
    h.domain.store.injectFaultOnce("lifecycleChange");
    await expect(h.writerClient.changeResource(remove)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    expect((await h.writerClient.listTrash()).items).toHaveLength(0);
    expect(
      (await h.writerClient.getComposition("private", "main")).revisionRecord
        .document,
    ).toEqual(doc);
    const deleted = await h.writerClient.changeResource(remove);
    expect(await h.writerClient.changeResource(remove)).toEqual(deleted);
    expect(await h.writerClient.listCompositions("private")).toEqual([]);
    for (const read of [
      () => h.writerClient.getComposition("private", "main"),
      () => h.writerClient.getCompositionHistory("private", "main"),
      () =>
        h.writerClient.exportCompositionBundle({
          projectId: "private",
          compositionId: "main",
          format: "json",
        }),
    ])
      await expect(read()).rejects.toMatchObject({ code: "RESOURCE_TRASHED" });
    await expect(
      h.writerClient.importCompositionBundle({
        projectId: "private",
        payload: exported.serialized,
        format: "json",
        baseRevision: 1,
        operationId: "cannot-import-over-trash",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_TRASHED" });
    await expect(
      h.writerClient.deleteAsset("private", "picture"),
    ).rejects.toMatchObject({ code: "DEPENDENCY_ERROR" });
    await h.writerClient.changeResource({
      projectId: "private",
      kind: "project",
      id: "private",
      action: "trash",
      baseRevision: 0,
      operationId: "delete-project",
    });
    expect(await h.writerClient.listProjects()).toEqual([]);
    expect((await h.writerClient.listTrash()).items).toHaveLength(2);
    expect((await h.readerClient.listTrash()).items).toHaveLength(0);
    await expect(h.writerClient.listAssets("private")).rejects.toMatchObject({
      code: "RESOURCE_TRASHED",
    });
    await expect(h.writerClient.listSubjects("private")).rejects.toMatchObject({
      code: "RESOURCE_TRASHED",
    });
    const restore = {
      projectId: "private",
      kind: "composition" as const,
      id: "main",
      action: "restore" as const,
      baseRevision: 1,
      expectedHeadRevision: 1,
      operationId: "restore-main",
    };
    await expect(h.writerClient.changeResource(restore)).rejects.toMatchObject({
      code: "PARENT_TRASHED",
    });
    const restoreProject = {
      projectId: "private",
      kind: "project" as const,
      id: "private",
      action: "restore" as const,
      baseRevision: 1,
      operationId: "restore-project",
    };
    h.domain.store.injectFaultOnce("lifecycleChange");
    await expect(
      h.writerClient.changeResource(restoreProject),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(await h.writerClient.listProjects()).toHaveLength(0);
    await h.writerClient.changeResource(restoreProject);
    expect(await h.writerClient.listCompositions("private")).toEqual([]);
    expect((await h.writerClient.listTrash()).items).toHaveLength(1);
    await h.writerClient.changeResource(restore);
    expect(await h.writerClient.changeResource(restore)).toMatchObject({
      revision: 2,
    });
    expect(
      (await h.writerClient.getComposition("private", "main")).revisionRecord
        .document,
    ).toEqual(doc);
    expect(
      (await h.writerClient.getComposition("private", "main")).headRevision,
    ).toBe(1);
    expect(await h.writerClient.listSubjects("private")).toHaveLength(1);
    expect(await h.writerClient.listAssets("private")).toHaveLength(1);
  });
  it("rejects stale deletion targets and uses unambiguous resource identity across account namespaces", async () => {
    const h = createTestHarness();
    await seed(h);
    await h.writerClient.patchComposition({
      projectId: "private",
      compositionId: "main",
      baseRevision: 1,
      operationId: "new-content",
      operations: [
        {
          op: "update_shot_fields",
          shotId: "shot-001",
          description: "New content",
        },
      ],
    });
    await expect(
      h.writerClient.callMcpTool("resource_trash", {
        projectId: "private",
        kind: "composition",
        id: "main",
        baseRevision: 0,
        expectedHeadRevision: 1,
        operationId: "stale-delete",
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect((await h.writerClient.listTrash()).items).toHaveLength(0);
    await h.writerClient.callMcpTool("resource_trash", {
      projectId: "private",
      kind: "composition",
      id: "main",
      baseRevision: 0,
      expectedHeadRevision: 2,
      operationId: "fresh-delete",
    });
    expect(await h.writerClient.callMcpTool("trash_list", {})).toEqual(
      (await h.writerClient.listTrash()).items,
    );
    await h.writerClient.callMcpTool("resource_restore", {
      projectId: "private",
      kind: "composition",
      id: "main",
      baseRevision: 1,
      expectedHeadRevision: 2,
      operationId: "fresh-restore",
    });
    expect(
      (await h.writerClient.getComposition("private", "main")).headRevision,
    ).toBe(2);
    await h.writerClient.createProject({
      id: "prefix",
      name: "Alice",
      authoringMode: "legacy",
    });
    await h.readerClient.createProject({
      id: "prefix::nested",
      name: "Bob",
      authoringMode: "legacy",
    });
    await h.readerClient.uploadAsset({
      projectId: "prefix::nested",
      assetId: "secret",
      mimeType: "application/octet-stream",
      bytes: new TextEncoder().encode("Bob private bytes"),
    });
    const { app } = createApiApp(h.domain, TEST_AUTH_CONFIG);
    const leaked = await app.request(
      "/v1/projects/prefix/assets/nested%3A%3Asecret/content",
      { headers: HUMAN_WRITER_HEADERS },
    );
    expect(leaked.status).toBe(404);
    await h.writerClient.uploadAsset({
      projectId: "prefix",
      assetId: "nested::secret",
      mimeType: "application/octet-stream",
      bytes: new TextEncoder().encode("Alice separate bytes"),
    });
    const own = await app.request(
      "/v1/projects/prefix/assets/nested%3A%3Asecret/content",
      { headers: HUMAN_WRITER_HEADERS },
    );
    expect(await own.text()).toBe("Alice separate bytes");
    const bob = await app.request(
      "/v1/projects/prefix%3A%3Anested/assets/secret/content",
      { headers: HUMAN_READER_HEADERS },
    );
    expect(await bob.text()).toBe("Bob private bytes");
  });
  it("exposes a verified session and real Access logout redirect with cache cleanup, without treating invalid bearer tokens as SSO", async () => {
    const { app } = createApiApp(undefined, TEST_AUTH_CONFIG);
    const response = await app.request("/v1/session", {
      headers: HUMAN_WRITER_HEADERS,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      actor: {
        actorId: "alice@talkincode.net",
        userId: "alice@talkincode.net",
      },
      logoutUrl: "/logout",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const invalidBearer = await app.request("/v1/session", {
      headers: { ...HUMAN_WRITER_HEADERS, authorization: "Bearer invalid" },
    });
    expect(invalidBearer.status).toBe(401);
    const logout = await app.request("/logout", {
      headers: HUMAN_WRITER_HEADERS,
    });
    expect(logout.status).toBe(302);
    expect(logout.headers.get("location")).toBe("/cdn-cgi/access/logout");
    expect(logout.headers.get("clear-site-data")).toContain("cache");
    expect(logout.headers.get("cache-control")).toBe("no-store");
  });
});
