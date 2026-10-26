# Technical Architecture

## Decisions
- TypeScript end-to-end. npm workspaces monorepo, strict TypeScript, ESM, Vitest and Zod/JSON Schema for protocol boundaries.
- Cloudflare Workers (Hono HTTP API + remote MCP via Streamable HTTP, with Workers Static Assets for the lightweight Web UI when feasible); Cloudflare D1 for authoritative metadata and revision transactions; R2 for immutable media objects, private by default.
- React + Vite + TypeScript SPA with persistent shot navigation and central tabs for shots, assets, subjects, collaboration/history and protocol. Preview and editing share a work page, with a focus mode. Grid/list/dependency views share the composition model. Graph is a visualization, never a model execution graph.
- Shared `packages/protocol` defines JSON Schema, canonical JSON, parsing, compatibility policy and semantic invariants. YAML is an interchange form only.
- MCP and HTTP/GUI call the same domain service. Do not build separate write paths.
- No media generation, transcoding, FFmpeg runtime, publication or execution orchestrator in this service.
- **Hosting decision:** only Cloudflare Workers. Custom Domain under Cloudflare-managed `talkincode.net`, canonical hostname `vflow.talkincode.net` with `video-compose.talkincode.net` retained as a compatibility alias; verify actual routing before claiming either is live.
- **SSO decision:** Cloudflare Access (Zero Trust) gates browser UI, REST and MCP. Human users authenticate through configured IdP; headless Agents must use an explicitly permitted non-interactive Access identity mechanism. Worker domain authorization remains mandatory.
- **Delivery decision:** GitHub repository `talkincode/vflow` main -> Cloudflare Workers Builds GitHub integration by default; GitHub Actions + Wrangler is an alternative, never a simultaneous second production deployer. Deployment requirements are documented separately in [deployment.md](deployment.md).

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

`GET`/`HEAD /v1/projects/:projectId/assets/:assetId/content` resolves a stable asset ID after domain-level project read authorization. R2 bodies stream to the response, with single byte-range requests (`206` / `416`) for native audio/video playback and seeking. Responses are private and non-cacheable; unsupported or active document formats download as attachments. No public R2 URL is introduced into composition definitions.

`GET /v1/projects/:projectId/access` returns the caller's project role through the same domain permission check. The UI disables mutations for readers; the API remains authoritative when controls are bypassed.

## Public APIs
REST `/v1/projects`, `/compositions`, `/revisions`, `/changes`, `/assets`, `/subjects`, `/proposals`.
Remote MCP over authenticated Streamable HTTP: `project_list`/`get`/`overview`/`create`, `composition_list`/`get`/`create`/`patch`/`history`/`export`/`import`, `asset_search`/`upload`/`link`, `subject_list`/`get`/`create`/`patch`, `subject_reference_attach`, `subject_approve_revision`, `shot_subject_bind`, `review_submit`/`approve`.
Use Cloudflare Access SSO for human browser sessions and Cloudflare Access-compatible machine authentication for external Agents (e.g., scoped Service Auth tokens). Access authenticates the caller; Worker MUST enforce project authorization using a simple two-level capability model (**`reader`** for read/export operations, **`writer`** for all state-modifying operations; non-members are rejected). Do not rely on Access alone for project authorization. Human sessions and agent identities (`actorId`) must be audited on every change.

## Lightweight UI for subjects
A project-level Character / Prop library presents definition cards, approved reference views and variants. The shot inspector shows resolved subject revision and its reference pack alongside direct image/video references. The UI is a client of the same subject-domain operations exposed through MCP; it never acts as an independent authority.

Project export must contain all referenced subject-revision manifests and stable asset metadata; a composition exported standalone must include a transitive subject manifest or report unresolved dependencies. Binary media packaging is optional and explicit.

Detailed draft: [subject/reference model](subjects.md).

## Workbench edit state

The visual adapter uses a light studio workspace: warm neutral canvas, white editing surfaces, dark media previews and a teal primary action. Each workspace tab has a local SVG icon, an explicit accessible name and a visible purpose description; color is never the sole identifier. Shot selection, permissions and unsaved/saved state remain explicit. Small screens retain wrapping navigation, keyboard tab controls and per-shot drafts. This presentation changes no domain contract; acceptance covers `tests/browser/workbench.spec.ts` (studio navigation, save-state visibility, draft retention, roles and responsive layouts).

The browser entry point is the project library at `/`. `/projects/:projectId` presents the authorized project overview and composition list; `/projects/:projectId/compositions/:compositionId` opens that composition directly. IDs are URL-encoded. Navigation uses ordinary links and native browser history, so each workbench opens in a fresh document and cannot retain another project's shot drafts, subject library or assets. Existing before-unload protection warns before leaving an edited workbench. Invalid or unauthorized links offer a return to the project library; they never initialize a guessed project or composition.

Project creation and composition creation are separate explicit operations. A new project starts empty; creating a composition selects its title, frame format and frame rate and adds one empty shot. Project overview and composition selection use shared authorized domain reads. Readers can browse and open compositions but cannot create one in that project. Project membership remains a project-level capability; a reader in one project can still create their own separate project.

`GET /v1/projects/:projectId/overview` and MCP `project_overview` return the project, caller role, composition summaries and shared asset/subject counts from one authorized snapshot. REST composition listing is also available through client `listCompositions` and MCP `composition_list`. This does not grant broader access or add a second project-state store.

Creation requests may carry `operationId`. The domain stores a receipt bound to the actor, target project/entity and canonical request in the existing idempotency table. A failed transaction stores neither entity nor receipt; a lost response can be retried without duplicates. Reusing a key with different content is rejected and replay still enforces current authorization. Existing callers without creation keys remain compatible. This adds no portable schema field or database migration.

Unsaved descriptions, durations and prompts live per shot in the current page, retaining the original revision and operation ID. Switching shots, tabs or layout preserves them. Leaving the page warns about unsaved work; drafts are not durable storage. A save submits only edited fields, including explicit empty strings. Failed retries preserve their payload and idempotency key. Conflicting edits retain the draft and require deliberate comparison and reconciliation with the latest revision.

Session undo applies an inverse patch only to fields edited by that session, checks that those fields have not changed since the saved operation, and preserves concurrent unrelated changes. It does not restore entire historical snapshots or toggle between two revisions. Batch duration changes use a single typed patch and sequence ordering uses stable shot IDs with relative anchors. These adapters use existing domain contracts; this UI release changes no portable schema or database migration.

## Source layout
```
apps/web/                # React Vite workspace
apps/api/                # Hono Cloudflare Worker and MCP endpoint
packages/protocol/       # versioned schemas, parser, validation, fixtures
packages/domain/         # pure domain logic and merge rules
packages/client/         # typed HTTP client
docs/                    # roadmap, architecture, protocol decisions
tests/e2e/               # black-box acceptance scenarios
tests/browser/           # real Chromium interaction, media and layout acceptance
scripts/ui-test-server.ts # isolated, loopback-only acceptance fixture; not deployed
```

## Quality
Protocol canonicalization, stable IDs, no destructive patching, authorization, deterministic change semantics and historical asset dereference are correctness boundaries. Validate these before treating the UI as complete.

## Versioned reference authoring

`ReferenceAuthoringService` is shared by REST, MCP and the web client. `packages/protocol/src/authoring.ts` owns the typed policy/scene/reference-pack/storyboard/input contracts; `authoring-guidance.ts` owns versioned bilingual rules and seven reusable prompts. Scenes do not extend the v1 SubjectKind enum. Composition v2 pins exact material revisions through a typed `set_authoring` operation.

D1 migration 0003 adds whole-record immutable material histories and external input evidence, persisted in the existing CAS transaction. No media processing runtime or separate authorization system is added. New projects get an approved strict policy atomically with creation; old projects without one remain legacy. Context checks prove version agreement; structural scope, explicit visual reviews and exact input preparation enforce production prerequisites.

A portable v2 bundle includes transitive material/subject/asset metadata and fixed composition baselines required by storyboard sequences. Import validates hashes, immutable conflicts, chronology and lineage atomically, preserves existing history, and refuses v1 overwrites of v2 semantics. Existing strict imports require baseRevision, and operationId receipts prevent duplicate imports after lost responses.

The web reference workspace displays clean independent tiles and source boards with selectable crop overlays. Metadata and review controls are outside image pixels. It records unknown versus passed checks, previews prepared/actual inputs, and preserves editing content after failure. Read-only viewers can inspect and prepare but cannot promote or write. Full workflow, limitations, compatibility and rollback: [reference-authoring.md](reference-authoring.md).

A dynamic white-model (`motion_reference`) is one more kind in the same material union, so it inherits revision history, review/approve, CAS, ACL, input preparation, evidence, export/import and asset retention without new endpoints or migrations. White models are rendered by external tools and uploaded as video, still and archive assets; the domain only pins, validates and audits them. The web reference workspace plays the uploaded video next to its keyframes and review controls; it is a viewer, not a 3D editor. Input preparation requires an explicit target video capability and an explicit keyframe degrade; drift from the fixed composition/subject/scene baseline rejects preparation. See [reference-authoring.md](reference-authoring.md#动态白模参考motion_referencel0).

## Private ownership and resource lifecycle

New projects bind to the verified account and default private. Explicit project sharing retains reader/writer capabilities, while membership management and project trash/restore are owner-only. Service identities require a configured owner mapping; request headers cannot choose a principal. Soft deletion uses independent immutable lifecycle events and gates all descendants without changing portable documents or deleting media/history. See [accounts and trash](accounts-and-trash.md) for endpoint, migration, logout and rollback contracts.
