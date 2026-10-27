# Deployment and Authentication Contract — vflow

**Status: Live Cloudflare Workers deployment verified (2026-10-16).** Keep this document aligned with `AGENTS.md`, `docs/architecture.md`, and the Mira project's `Memories/environment.md` and `Memories/deploy.md`.

## Fixed target
- **Public source**: `https://github.com/talkincode/vflow`, canonical deployment branch `main`.
- **Application runtime**: **Cloudflare Workers**, TypeScript project `vflow` (deployed Worker name `video-compose`, retained until a coordinated resource rename). Frontend React/Vite output (`apps/web/dist`) is served by the same Worker using Workers Static Assets (`ASSETS`, with `run_worker_first: ["/v1/*", "/mcp"]`); API and MCP use the Worker route. `workers_dev` is disabled (`false`) to prevent bypassing custom domain Access controls.
- **Canonical hostname**: `https://vflow.talkincode.net`; retain `https://video-compose.talkincode.net` as a compatibility alias on the same Worker. The vflow route and Access destinations must be independently read back after promotion. Zone: `talkincode.net` / `e452c151cde1d9856336ffd76f80bf75`.
- **State**: Cloudflare D1 (`video-compose-db`, ID `028d0760-9c64-4f4d-876e-8e6b33236acc`, schema migration `0001_initial.sql` applied) for project and revision metadata; private R2 (`video-compose-media`) for immutable reference images/audio/video and other media; no per-file permanent signed URLs in composition definitions.

## Identity and authorization
- **Cloudflare Access (Zero Trust SSO)** is the authentication perimeter for the UI, HTTP API, and remote MCP endpoint. Identity provider and Access policies are configured and verified in production.
- Human users log in interactively through an Access-approved identity provider (`video-compose-human-allow`, reusable policy `432cb60d-1a6f-4734-87bb-f07d8e7e7ad8`).
- Non-interactive Agent/MCP clients use policy-approved authentication via **Cloudflare Access Service Tokens** (`video-compose-service-tokens`, reusable `non_identity` policy `f27f90e0-3f77-4452-8b51-3b37009fd8ae`). Service tokens are sensitive and are never stored in Git, composition JSON/YAML or project memory.
- Access authenticates entry, and **the Worker/domain layer still checks project membership and permission (`reader` for read/export, `writer` for mutations) on every call**. A globally authenticated Agent may not gain access to every project's assets by default.
- Upload/download tickets for R2 must be short lived, object-scoped and permission checked. Do not expose private R2 objects directly through an unauthenticated static route.
- Browser previews use the same-origin, project-authorized `GET`/`HEAD /v1/projects/:projectId/assets/:assetId/content` endpoint, streaming R2 with byte-range support. They do not require public objects or permanent signed URLs.
- Access protection, origin bypass paths and alternative `workers.dev` routes have been reviewed (`workers_dev: false`).

## GitHub -> Cloudflare Workers
1. Default deployment mechanism: **Cloudflare Workers Builds connected to the GitHub repository**. Configure the production environment to deploy from the canonical `main` branch; PR preview is optional and must also be covered by intended Access policies.
2. Alternative mechanism: **GitHub Actions + Wrangler** using tightly scoped Cloudflare API credentials stored as GitHub Actions Secrets. It is an alternative, not an additional independent production deployer.
3. CI/release acceptance: run executable TypeScript checks, protocol compatibility validation and relevant integration/E2E checks before production promotion. A configuration file without a successful run is not proof of a working deployment.
4. Keep Worker config, R2 bucket, D1 database bindings and compatibility version explicit in project infrastructure configuration (`apps/api/wrangler.jsonc`); never fabricate IDs or tokens.
5. Verify custom hostname reachability, SSO login, unauthorized browser rejection, unauthorized MCP rejection, role isolation and asset access after deployment.

## Recovery
- Record the deployed Worker version and Git commit before release; rollback through a verified Cloudflare Worker deployment rollback or a verified prior commit.
- D1 schema changes and asset migrations require separate forward/backward compatibility and recovery planning. Never assume Worker rollback undoes migrations.
- Publish a real deployment URL or success claim only after checking the actual Cloudflare resources and protected HTTP behavior.

## Naming: vflow and retained identifiers

The project, package scope, protocol identifiers and canonical hostname are `vflow`. These deployed or historical identifiers are intentionally **not** renamed here, because renaming them requires a coordinated Cloudflare/GitHub migration and would break existing sessions, OAuth clients or stored documents:

| Layer | Current value | Reason retained |
| --- | --- | --- |
| Cloudflare Worker | `video-compose` | Deployed identity; renaming creates a new Worker and requires re-attaching custom domains and Access apps. |
| D1 database | `video-compose-db` (`028d0760-9c64-4f4d-876e-8e6b33236acc`) | Live data; renaming means create/export/import/repoint, not a config edit. |
| R2 bucket | `video-compose-media` | Immutable media identity; bucket rename is a data migration. |
| Access policies | `video-compose-human-allow`, `video-compose-service-tokens` | Reusable policies referenced by Access apps and machine credentials. |
| Hostname alias | `video-compose.talkincode.net` | Keeps existing links, sessions and OAuth clients working. |
| Wire identifiers | `video-compose/v1`, `video-compose/v2`, `video-compose/reference-workflow/v1`, `video-compose://` resource URIs | Stored in D1 documents and used by existing MCP clients. Read paths accept them; new writes emit `vflow/*`. |

A future infrastructure rename must be executed as its own verified migration with rollback evidence, and this table updated only after read-back.

## Verified live infrastructure (2026-10-16, recorded on the legacy hostname)
- **Cloudflare Account ID**: `83b40c9065a6f4631f4ab6cda824a21a`
- **Cloudflare Zone**: `talkincode.net` (`e452c151cde1d9856336ffd76f80bf75`, status `active`)
- **Cloudflare Worker**: `video-compose` (initial deployed Version ID `5b45e8c5-2478-4e15-9117-899086d6ac8d`, custom domain `video-compose.talkincode.net` at the time, `workers_dev: false`)
- **Cloudflare D1 Database**: `video-compose-db` (`028d0760-9c64-4f4d-876e-8e6b33236acc`, region `APAC`, `0001_initial.sql` applied)
- **Cloudflare R2 Bucket**: `video-compose-media` (`Standard` storage class, bound as `MEDIA_BUCKET`)
- **Cloudflare Access Application**: `video-compose.talkincode.net` (App ID `72992495-1fba-419e-83e7-d825db14f557`, AUD `87564c49249682da499869e50295186b3488c730ec5bd236105a2db4598453ec`)
  - Reusable Policy 1 (`precedence: 1`): `video-compose-human-allow` (`432cb60d-1a6f-4734-87bb-f07d8e7e7ad8`, `decision: "allow"`)
  - Reusable Policy 2 (`precedence: 2`): `video-compose-service-tokens` (`f27f90e0-3f77-4452-8b51-3b37009fd8ae`, `decision: "non_identity"`)
- **Live HTTP/MCP Verification**:
  - Unauthenticated `GET https://video-compose.talkincode.net/v1/projects` -> `302` redirect to `https://toughstruct.cloudflareaccess.com/cdn-cgi/access/login/video-compose.talkincode.net`
  - Authenticated `GET https://video-compose.talkincode.net/` -> `200 OK` serving Vite Workbench SPA
  - Authenticated REST + D1 + R2 round-trip (`demo` project, `asset-lina-turnaround-v1` R2 upload + SHA-256 verification, `char-lina` Subject rev 1, `episode-001` Composition rev 1) -> `201 Created`
  - Authenticated MCP (`POST https://video-compose.talkincode.net/mcp` `tools/list` and `composition_get`) -> `200 OK` (24 MCP tools registered, `char-lina@1#raincoat` resolved)
- **Not yet configured**: Native Cloudflare Workers Builds GitHub auto-trigger (current deployment executed via authenticated Wrangler CLI).

Hostnames below are recorded exactly as checked on that date; re-run the same checks after any hostname or Worker rename.

## Workbench UI release procedure (2026-10-16)

- Rechecked the Worker bindings, compatibility date and current deployment through the Cloudflare API. Native Workers Builds triggers are empty. `.github/workflows/ci.yml` runs acceptance checks only and holds no deployment credentials; Wrangler remains the single production deployer.
- Run `npm run typecheck`, `npm run lint`, `npm test` and `npm run test:browser`, then push and verify the CI run for that exact Git commit. The Chromium checks seed isolated synthetic media and 100 shots rather than writing production data.
- Before upload, run `npx wrangler whoami` and `npx wrangler deploy --config apps/api/wrangler.jsonc --dry-run`. Build output and bindings must match the intended Worker. Publish with the Git commit in `--message`; preserve dashboard variables with `--keep-vars`.
- Previous production Worker version recorded before this release: `0f5954cf-dc58-4974-959b-d770cdc82e5e` (deployment `3b144f27-ad08-43d3-9e66-26560199c3c3`, 100%). If this release fails, use `npx wrangler rollback 0f5954cf-dc58-4974-959b-d770cdc82e5e --config apps/api/wrangler.jsonc` after checking that it is still the intended prior version, and verify the protected UI again. No D1 migration or R2 object mutation is part of this release; Worker rollback still does not roll back stored composition edits.
- After promotion, independently read back the Cloudflare deployment, verify anonymous rejection for UI/API/MCP, and inspect the logged-in workbench at the production hostname. Record the actual version and results in the release evidence; a dry run is not production verification.

## Project navigation release (2026-10-16)

- Replaces the fixed `demo / episode-001` browser entry with the project library and explicit project/composition URLs. Workers Static Assets retain SPA fallback so direct URLs must serve the application under the existing Access perimeter.
- Adds authorized project-overview reads and creation receipts in the existing idempotency table. No D1 schema migration or media rewrite is required; existing callers without creation keys remain compatible.
- Acceptance: 32 integration checks across 11 files and 14 Chromium checks, including two projects with two compositions each, direct URLs/history navigation, reader/writer separation, transaction failure and lost-response recovery, and leaving an unsaved workbench. The previous media/workbench acceptance remains in the same CI run.
- Pre-release Worker version: `d63ba2e3-3c60-4ea1-8299-e77af9a026e9` (source commit `6d3ebe8569e4e534bce1223a98502d8fae386dbc`). If rollback is needed, verify that this is the intended baseline and run `npx wrangler rollback d63ba2e3-3c60-4ea1-8299-e77af9a026e9 --config apps/api/wrangler.jsonc`. Stored projects/compositions remain in D1; rollback only removes the new browser entry and creation-retry behavior.
- Before reporting success, verify the exact commit's CI, the actual Worker version, anonymous Access redirects for the new paths, the logged-in project library, project overview, and a composition opened by its direct URL. Save production screenshots outside the public repository.

## MCP OAuth 2.1 release (2026-10-24)

- **Worker Version ID**: `c33a40cd-9d62-4cdb-9dd2-58fbefa5679d` (prior OAuth base `2a05f4ac-65c0-4514-9c8b-b55a7ed794e2`)
- **D1 Migration**: Applied `0002_mcp_oauth.sql` to `video-compose-db` (`028d0760-9c64-4f4d-876e-8e6b33236acc`), creating `mcp_clients`, `mcp_grants`, `mcp_tokens`.
- **Tool Schema Compliance**: Added standard JSON Schema `inputSchema` for all 26 tools in `MCP_TOOLS_MANIFEST` and handled `notifications/initialized`, `ping`, and dynamic `protocolVersion` negotiation for full OpenAI/ChatGPT MCP compatibility.
- **Cloudflare Access Application**: Added machine bypass application `Video Compose MCP machine` (App ID `23185069-e6c1-4de2-a816-fcea36215257`, AUD `22b0af63bc95085c9f3acccf5cbb5122f410e837e2d702f6947a0892b3b5cd50`). The display name is retained because the resource predates the vflow rename.
  - Destinations bypassed for automated MCP clients: `/mcp`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-authorization-server`.
  - Human consent endpoint (`/oauth/authorize`) remains strictly protected by root Access SSO application (`72992495-1fba-419e-83e7-d825db14f557`).
- **Live Verification** (recorded on the legacy hostname):
  - `GET https://video-compose.talkincode.net/.well-known/oauth-protected-resource` -> `200 OK`
  - `GET https://video-compose.talkincode.net/.well-known/oauth-authorization-server` -> `200 OK`
  - `POST https://video-compose.talkincode.net/mcp` unauthenticated -> `401 Unauthorized` with `WWW-Authenticate: Bearer realm="video-compose", resource_metadata="https://video-compose.talkincode.net/.well-known/oauth-protected-resource/mcp"` (the realm now reads `vflow`; the rename did not change OAuth behaviour)
  - `POST https://video-compose.talkincode.net/oauth/register` -> `201 Created`
  - `POST https://video-compose.talkincode.net/mcp` `tools/list` -> `200 OK` (26 tools returned, each having compliant `inputSchema`)
  - `GET https://video-compose.talkincode.net/oauth/authorize` -> `302 Found` to Zero Trust SSO login

## MCP list compatibility and reference preview hotfix (2026-10-25)

- Worker version `118ca0e9-b626-42f8-accf-cb99958b510e` replaces `5f68d123-2909-4cda-8d6c-0eaedaa4abef`. Deployed with `--keep-vars`, without migrations or asset rewrites. Existing OAuth and five-image candidate changes were already present in the production baseline; existing uncommitted work was preserved. This hotfix was deployed from the working tree; no commit, push, or GitHub CI run was performed in this operation.
- Array results remain serialized in MCP text content and no longer populate object-only `structuredContent`; the local client reads text when structured content is absent. Production connector calls to `project_list`, `subject_list` and `asset_search` now pass strict response validation.
- Compact image previews, including character/prop reference cards, expose an authorized same-origin original-image link. Local acceptance: typecheck, lint, 41 integration tests and 15 Chromium tests passed, including opening a subject reference in a new tab and checking image decoding.
- Authenticated production verification: all three uploaded realistic reference boards decoded at their original dimensions in the asset library, all eight subjects displayed their new reference packs, and the Su Wei full-size original opened successfully. Anonymous project API access still redirects to Cloudflare Access (`302`).
- The existing MV compositions were compared before/after: `old-bridge-main-177s` revision 6 still has 31 shots and 5316 frames; `old-bridge-broll-library` revision 3 still has 32 shots. Both composition documents were unchanged. New subject reference revisions remain candidates; historical approved revisions are preserved.
## Official references

- [Cloudflare Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Workers Builds / GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
- [GitHub Actions + Wrangler](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)

## Reference authoring migration (local implementation, not a deployment record)

Apply `0003_reference_authoring.sql` along with any earlier unapplied migrations before releasing code that reads reference_documents/reference_evidence. The migration is additive and does not rewrite existing projects; absent policy means legacy. Back up D1 before migration and retain new tables on rollback. Never let an old writer drop v2 authoring dependencies; close old write ingress before rolling back, and use a compatible repair build for v2 data. See [reference authoring compatibility/rollback](reference-authoring.md#v1v2d1-迁移与回滚). Local passing tests do not establish a production rollout or authenticated live acceptance.

## VFlow canonical hostname release

Canonical browser/API origin is `https://vflow.talkincode.net`; Remote MCP is `https://vflow.talkincode.net/mcp`. Keep the old hostname as a compatibility alias to preserve existing OAuth clients, project links and sessions. Both hostnames route to the existing `video-compose` Worker and share the same D1/R2; no project copy or media rewrite is needed.

Before exposing the new route, extend the existing Access application destinations to cover both root hostnames, preserving the existing human/service policies. Extend only the existing machine application paths for MCP, token/register/revoke and well-known metadata. `/oauth/authorize` and `/v1/*` remain behind the root SSO gate. The Worker independently requires Bearer authentication for anonymous machine requests. Verify the new hostname's metadata uses its own issuer, authorization, token and resource URLs; do not redirect POST /mcp to another host.

The deployment uses Wrangler as the sole deployer; the live Workers Builds trigger list was empty at release preparation. Record exact-SHA CI, a pre-migration D1 export/bookmark, previous Worker version `118ca0e9-b626-42f8-accf-cb99958b510e`, migration status, active deployment and authenticated browser/API/MCP readback in the private release evidence.

## vflow naming and light studio UI release (2026-10-26 UTC)

- **Released source commit**: `d20bda8026e6822c6be54fed53b961f409531af5`. [Exact-commit CI](https://github.com/talkincode/vflow/actions/runs/40355840258) passed typecheck, lint, 65 integration checks, build and 21 Chromium checks.
- **Publisher**: installed `cf` CLI `0.15.0`, authenticated to the existing account. Workers Builds trigger list was read back as empty; there is no competing production auto-deployer. Wrangler was used only for an earlier local packaging check, not for this production upload.
- **Build path**: archive the exact commit into an isolated temporary directory, run locked `npm ci` and the workspace build, bundle the existing Worker entrypoint with installed esbuild, then write/validate the CLI's v0 Build Output Specification using its installed `@cloudflare/config` and `@cloudflare/build-output-utils`. The output carries the existing Worker name, both verified custom domains, the D1/R2 IDs, the existing plain-text variables, SPA fallback and Worker-first paths. `cf deploy --prebuilt --dry-run` passed before `cf deploy --prebuilt --message "vflow studio UI and naming; commit d20bda8026e6822c6be54fed53b961f409531af5; CI 40355840258"`. This bypasses the preview CLI's unsupported Hono-workspace autoconfiguration; no new Worker or deployment-framework migration was created.
- **Production version**: `400f1d38-c980-42cd-bc55-7d52c7f0b28e`; deployment `0618beba-1584-4060-aaea-c3346b38ae8e`, source `cf_cli`, 100% traffic. Previous production version: `a4631b68-9617-45c2-bb75-dd438b732b8e`.
- **Infrastructure read-back**: both `vflow.talkincode.net` and `video-compose.talkincode.net` point to the retained `video-compose` Worker; Workers.dev and preview URLs remain disabled. D1 migrations `0001`–`0004` were already applied. The existing D1 database and R2 bucket were verified; this release ran no migrations and changed no Access policies or resource names. Corrected a duplicated canonical route in local configuration to retain the legacy alias.
- **Protected production HTTP**: anonymous UI, `/v1/projects` and `/oauth/authorize` return Access `302` on both hosts; anonymous `/mcp` returns `401` with realm `vflow`. Public resource metadata returns `200` with host-specific issuer/resource origins.
- **Authenticated production read-only acceptance**: project home and a 31-shot workbench return `200`, light canvas `#f5f4f0` and teal accent `#147566` are loaded, all six navigation icons and purpose descriptions are present, the clean save button is disabled, and authorized media decodes. No browser JavaScript errors were observed. Authenticated MCP initialization returns `vflow-mcp`; 43 tools are discoverable and advertised resources use `vflow://`.
- **Data integrity**: compared ordered D1 snapshots before/after: composition heads, 53 immutable composition revisions and 27 asset-index records (including SHA-256 and R2 keys) were identical; store revision remained unchanged. Verification made no project, composition, subject or media writes. Private production screenshots and raw read-back evidence are outside the repository.
- **Rollback**: recheck the intended prior version and binding/secret compatibility, then run `cf workers deployments create --worker video-compose --strategy percentage --versions '[{"version_id":"a4631b68-9617-45c2-bb75-dd438b732b8e","percentage":100}]'`. Do not use `--force` to bypass a compatibility warning. Repeat protected HTTP and authenticated UI/MCP checks after rollback. Worker rollback does not restore D1/R2 data; this release requires no data rollback.

## L0 dynamic motion reference release (2026-10-26 UTC)

- Source: `312ddeb990633ad9a22da9ff322321f730312fe5`; [exact-commit CI](https://github.com/talkincode/vflow/actions/runs/40371738652) passed. Local acceptance additionally covered 100 Vitest tests and 26 Chromium checks, including motion lifecycle, roles, input/evidence and video playback/seek.
- Published the retained `video-compose` Worker with project-local Wrangler 4.151.0 after restoring OAuth management authorization. Credentials are stored encrypted with the key in macOS Keychain, outside the project. The installed `cf` CLI 0.15.0 independently read back Worker metadata and confirmed Workers Builds triggers remain empty (no competing automatic production deployer).
- Isolated the exact clean checkout under `/tmp` for build/deploy to avoid the user's ancestor `~/.pnp.cjs` interfering with esbuild. Workspace build and Wrangler dry-run passed; bundle 832.57 KiB (gzip 168.96 KiB). Published with `--keep-vars`, preserving existing dashboard variables/secrets; D1, R2, both custom domains and Worker-first paths are unchanged. D1 reports migrations 0001–0004 already applied; this feature needs no migration.
- Production version: `23c19c2f-0b6e-469a-9fa9-49812e82f24c`, 100% traffic. Previous production version: `400f1d38-c980-42cd-bc55-7d52c7f0b28e`.
- Read-back: authenticated MCP `tools/list` returns 43 tools, and `authoring_document_put` exposes `motion_reference`; anonymous UI and project API return Access 302, anonymous MCP returns 401 on both hostnames. Deployment made no project, media, review or evidence writes. After deployment D1 still contains 2 projects, 3 compositions, 53 immutable composition revisions and 27 assets; no motion material was created in production by this release.
- Rollback: first verify binding/secret compatibility and the intended previous version, then `wrangler rollback 400f1d38-c980-42cd-bc55-7d52c7f0b28e --config apps/api/wrangler.jsonc`. Worker rollback does not restore D1/R2. Once motion materials are created, do not expose old asset-deletion/input-preparation paths that do not understand motion retention and validation; keep these writes closed or use a compatible repair build. Repeat protected HTTP and authenticated schema checks after rollback.

## filmkit fixed-revision handoff release (2026-10-27 UTC)

- Source: `d7ac0115379463f37c9e085f2c1884f9068eaaed`, merged through [PR #5](https://github.com/talkincode/vflow/pull/5). [Exact-merge CI](https://github.com/talkincode/vflow/actions/runs/40461132563) passed; local acceptance covered 103 integration tests and 27 Chromium tests. README simplification is included.
- Companion: filmkit [PR #21](https://github.com/talkincode/filmkit/pull/21), commit `c38b54371e796a4196e01f572a48225daf00abed`, released as [v0.8.0](https://github.com/talkincode/filmkit/releases/tag/v0.8.0). [Release workflow](https://github.com/talkincode/filmkit/actions/runs/40461002102) passed check/test, packaging, attestation and Homebrew update. The downloaded archive verified against checksums.txt (`db6241eaa365d41a27d838db1c3d922812a89f7d2c25a516c567c064ee2e3304`); extracted `filmkit --version`, `vflow-pull help`, and builtin init/validate/run/build smoke passed. The tap formula contains version 0.8.0 and both CLI links. Unrelated filmkit PR #20 was not merged.
- Publisher: project-pinned Wrangler 4.151.0 from an isolated clean archive of the source commit. Locked install, workspace build and `deploy --dry-run --keep-vars` passed. Workers Builds triggers were read back as empty before and after release; no automatic competing deployer was added. An initial assets-upload-session request returned Cloudflare 10013 before promotion; the old deployment was verified unchanged, then a retry succeeded.
- Production Worker version: `ad9014c6-de40-4c7f-9799-ab7090d09ca2`; deployment `3630e1c6-3529-4255-80d1-d0ac037e4b00`, 100% traffic. Prior version: `23c19c2f-0b6e-469a-9fa9-49812e82f24c`.
- Read-back: both custom domains remain attached to `video-compose`; workers.dev and previews remain disabled. Anonymous UI, project API and OAuth authorization redirect to Access (302), anonymous MCP returns 401, discovery metadata returns 200. Authenticated homepage/new JS bundle returns 200 and contains the filmkit handoff controls; authenticated MCP tools/list returns 43 tools.
- Acceptance limitation: the available Access login lists zero accessible projects. No production composition was opened to exercise the new handoff panel; no permission was changed and no test project was created. The workbench workflow is covered by local Chromium and real cross-repository strict-project tests, not claimed as a production UI walkthrough.
- Data and configuration: no D1 migration, asset rewrite, permission or secret change. Pre/post binding arrays match; D1 store version remains 151, with 2 projects, 3 compositions, 53 composition revisions and 27 assets. These read-only checks made no domain writes.
- Dependency audit: locked installation reports 7 pre-existing advisories (3 moderate, 2 high, 2 critical), including a Zod oversized-collection memory-exhaustion advisory and development-tool advisories. No dependencies were upgraded in this release. Resolve through separately tested dependency updates; do not use an unreviewed `npm audit fix --force` during deployment.
- Rollback: verify the intended baseline and binding compatibility, then `npx wrangler rollback 23c19c2f-0b6e-469a-9fa9-49812e82f24c --config apps/api/wrangler.jsonc`. This restores code/assets only, not D1/R2 state. Existing exported filmkit projects must not be overwritten with an older importer. Repeat protected HTTP and authenticated checks after rollback. Private raw evidence is kept outside the repository.

## Pending account isolation / recycle-bin upgrade

Apply `0004_ownership_recycle_bin.sql` before deploying the corresponding Worker. Configure verified Access `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`; retain secrets in Worker secrets and map each service credential to fixed `defaultActorId` plus `ownerUserId`. Unmapped service credentials fail closed. Ambiguous legacy ownership requires evidence-based manual resolution, not automatic first-user claiming. `/logout` must run Worker first and then redirect to the existing Access logout endpoint. After soft deletion starts, do not roll back to a Worker that ignores lifecycle records. See [accounts and trash](accounts-and-trash.md); these instructions are not a statement that this upgrade is already deployed.
