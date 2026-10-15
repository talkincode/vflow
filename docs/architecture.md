# Technical Architecture

## Decisions
- TypeScript end-to-end. npm workspaces monorepo, strict TypeScript, ESM, Vitest and Zod/JSON Schema for protocol boundaries.
- Cloudflare Workers (Hono HTTP API + remote MCP via Streamable HTTP); Cloudflare D1 for authoritative metadata and revision transactions; R2 for immutable media objects, private by default.
- React + Vite + TypeScript SPA for lightweight grid/list/dependency graph and collapsible contextual Agent panel. Graph is a visualization, never a model execution graph.
- Shared `packages/protocol` defines JSON Schema, canonical JSON, parsing, compatibility policy and semantic invariants. YAML is an interchange form only.
- MCP and HTTP/GUI call the same domain service. Do not build separate write paths.
- No media generation, transcoding, FFmpeg runtime, publication or execution orchestrator in this service.

## Data Model
Project -> many Compositions; Project -> many Assets.
Composition -> immutable Revisions -> ordered Timeline + stable Shot IDs.
Shot -> many immutable Asset references (reference image/video/audio; selected candidate output).
Change -> actor, base revision, idempotency key, typed patch, resulting revision.
Asset -> immutable content digest, MIME, dimensions/duration if applicable, lineage, storage object key, project-level ACL.
Agent suggestions may create review proposals; applying a proposal creates a revision.

## Concurrent edits
- Every mutation supplies `baseRevision` and an idempotency key.
- Validate typed operations against schema, permissions, reference existence and semantic rules before transaction.
- If base is stale: automatically merge only provably disjoint paths; otherwise return a structured conflict and preserve all versions.
- Atomic D1 revision + head update with compare-and-swap semantics; never mutate a prior revision.
- Media registration only after R2 object verification. Failed registration does not expose an asset.
- Stable asset IDs do not change content. Deletion checks live references and ACL.

## Asset Transfer
Worker issues short-lived scoped upload instructions; client/Agent uploads directly to R2 (multipart for large objects). Finalize verifies digest, content type and size; store object key separately from public model. Never embed signed URLs, credentials or provider secrets in compositions.

## Public APIs
REST /v1/projects, /compositions, /revisions, /changes, /assets, /proposals.
Remote MCP over authenticated Streamable HTTP: project_list/get, composition_get/patch/history, asset_search/upload/link, review_submit.
Use OAuth or short-lived scoped credentials for external Agents; human sessions and agent identities must be audited.

## Source layout (planned; not implemented)
```
apps/web/                # React Vite workspace
apps/api/                # Hono Cloudflare Worker and MCP endpoint
packages/protocol/       # versioned schemas, parser, validation, fixtures
packages/domain/         # pure domain logic and merge rules
packages/client/         # typed HTTP client
docs/                    # roadmap, architecture, protocol decisions
tests/e2e/               # black-box acceptance scenarios
```

## Quality
Protocol canonicalization, stable IDs, no destructive patching, authorization, deterministic change semantics and historical asset dereference are correctness boundaries. Validate these before treating the UI as complete.
