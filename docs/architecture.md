# Technical Architecture

## Decisions
- TypeScript end-to-end. npm workspaces monorepo, strict TypeScript, ESM, Vitest and Zod/JSON Schema for protocol boundaries.
- Cloudflare Workers (Hono HTTP API + remote MCP via Streamable HTTP, with Workers Static Assets for the lightweight Web UI when feasible); Cloudflare D1 for authoritative metadata and revision transactions; R2 for immutable media objects, private by default.
- React + Vite + TypeScript SPA for lightweight grid/list/dependency graph and collapsible contextual Agent panel. Graph is a visualization, never a model execution graph.
- Shared `packages/protocol` defines JSON Schema, canonical JSON, parsing, compatibility policy and semantic invariants. YAML is an interchange form only.
- MCP and HTTP/GUI call the same domain service. Do not build separate write paths.
- No media generation, transcoding, FFmpeg runtime, publication or execution orchestrator in this service.
- **Hosting decision:** only Cloudflare Workers. Custom Domain under Cloudflare-managed `talkincode.net`, planned hostname `video-compose.talkincode.net`; do not claim it is live before verification.
- **SSO decision:** Cloudflare Access (Zero Trust) gates browser UI, REST and MCP. Human users authenticate through configured IdP; headless Agents must use an explicitly permitted non-interactive Access identity mechanism. Worker domain authorization remains mandatory.
- **Delivery decision:** GitHub repository `talkincode/video-compose` main -> Cloudflare Workers Builds GitHub integration by default; GitHub Actions + Wrangler is an alternative, never a simultaneous second production deployer. Deployment requirements are documented separately in [deployment.md](deployment.md).

## Data Model
Project -> many Compositions; Project -> many Assets; Project -> many Subjects (character/prop); Project -> Member permissions (`reader` | `writer`).
Composition -> immutable Revisions -> ordered playback `sequence`, composition-level `audioTracks` (e.g. global BGM / voiceover with integer frame timing), and stable `shots` map.
Subject -> versioned `SubjectRevisions` with `status` (`candidate` | `approved`), `defaultVariant`, semantic definition, appearance/state `variants`, and curated multi-view `referencePack` entries (`status: candidate | approved`, Asset IDs).
Shot -> pinned `SubjectRevision` bindings (with optional `variant` defaulting to `defaultVariant`), explicit `dependsOn` DAG edges to other shots, direct `references` (image/video), `candidates` (image/video/audio list), and `selected` outputs (video/audio).
Subject versions are separate from raw media objects; editing a shared subject never implicitly changes already pinned shot bindings.
Change -> actor (`actorId`, `actorKind`), `baseRevision`, `operationId` (idempotency key), ID-addressed `typedPatch`, resulting revision.
Asset -> immutable SHA-256 content digest, MIME, dimensions/duration if applicable, lineage, storage object key, project-level ownership.
Proposal -> wraps a pending `Change` (`baseRevision` + `typedPatch`); applying/approving a proposal executes the same validation and merge rules to produce a new revision.

## Concurrent edits
- Every mutation supplies `baseRevision` and an idempotency key (`operationId`).
- Typed operations address entities by stable IDs (`shotId`, `trackId`, `subjectId`) and relative sequence anchors (`afterShotId` / `beforeShotId`) rather than mutable positional indices.
- Validate typed operations against schema, `writer` permission, reference existence, DAG acyclicity (`dependsOn`), and semantic rules before transaction.
- If `baseRevision` is stale: automatically merge only provably disjoint entity/field paths; otherwise return a machine-readable conflict and preserve all versions. Applying a review Proposal uses the exact same disjoint-merge and conflict-detection pipeline.
- Atomic D1 revision + head update with compare-and-swap semantics; never mutate a prior revision.
- Media registration only after R2 object verification. Failed registration does not expose an asset.
- Stable asset IDs do not change content. Deletion checks live references and `writer` permission.
- Approved subject revisions (`status: approved`) are strictly immutable; adding/modifying a character/prop definition or reference pack creates or updates a `candidate` revision (`status: candidate`) and promoting it to `approved` freezes the snapshot without rewriting historical shot bindings.

## Asset Transfer
Worker issues short-lived scoped upload instructions (`upload_sessions` recorded in D1 with expiration, expected size, MIME, and SHA-256 digest); client/Agent uploads to R2. Finalize verifies SHA-256 digest, content type and byte size before registering the `Asset` record in D1; incomplete or failed uploads never expose a visible asset, and expired `upload_sessions` allow orphaned R2 objects to be cleaned up. Store storage object keys separately from the public protocol model. Never embed signed URLs, credentials or provider secrets in compositions.

## Public APIs
REST `/v1/projects`, `/compositions`, `/revisions`, `/changes`, `/assets`, `/subjects`, `/proposals`.
Remote MCP over authenticated Streamable HTTP: `project_list`/`get`, `composition_get`/`patch`/`history`/`export`/`import`, `asset_search`/`upload`/`link`, `subject_list`/`get`/`create`/`patch`, `subject_reference_attach`, `subject_approve_revision`, `shot_subject_bind`, `review_submit`/`approve`.
Use Cloudflare Access SSO for human browser sessions and Cloudflare Access-compatible machine authentication for external Agents (e.g., scoped Service Auth tokens). Access authenticates the caller; Worker MUST enforce project authorization using a simple two-level capability model (**`reader`** for read/export operations, **`writer`** for all state-modifying operations; non-members are rejected). Do not rely on Access alone for project authorization. Human sessions and agent identities (`actorId`) must be audited on every change.

## Lightweight UI for subjects
A project-level Character / Prop library presents definition cards, approved reference views and variants. The shot inspector shows resolved subject revision and its reference pack alongside direct image/video references. The UI is a client of the same subject-domain operations exposed through MCP; it never acts as an independent authority.

Project export must contain all referenced subject-revision manifests and stable asset metadata; a composition exported standalone must include a transitive subject manifest or report unresolved dependencies. Binary media packaging is optional and explicit.

Detailed draft: [subject/reference model](subjects.md).

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
