# Deployment and Authentication Contract — Video Compose

**Status: Live Cloudflare Workers deployment verified (2026-10-16).** Keep this document aligned with `AGENTS.md`, `docs/architecture.md`, and the Mira project's `Memories/environment.md` and `Memories/deploy.md`.

## Fixed target
- **Public source**: `https://github.com/talkincode/video-compose`, canonical deployment branch `main`.
- **Application runtime**: **Cloudflare Workers**, TypeScript (`video-compose`). Frontend React/Vite output (`apps/web/dist`) is served by the same Worker using Workers Static Assets (`ASSETS`, with `run_worker_first: ["/v1/*", "/mcp"]`); API and MCP use the Worker route. `workers_dev` is disabled (`false`) to prevent bypassing custom domain Access controls.
- **Hostname**: `https://video-compose.talkincode.net` (verified Custom Domain route on zone `talkincode.net` / `e452c151cde1d9856336ffd76f80bf75`).
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

## Verified live infrastructure (2026-10-16)
- **Cloudflare Account ID**: `83b40c9065a6f4631f4ab6cda824a21a`
- **Cloudflare Zone**: `talkincode.net` (`e452c151cde1d9856336ffd76f80bf75`, status `active`)
- **Cloudflare Worker**: `video-compose` (initial deployed Version ID `5b45e8c5-2478-4e15-9117-899086d6ac8d`, custom domain `video-compose.talkincode.net`, `workers_dev: false`)
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

## Workbench UI release procedure (2026-10-16)

- Rechecked the Worker bindings, compatibility date and current deployment through the Cloudflare API. Native Workers Builds triggers are empty. `.github/workflows/ci.yml` runs acceptance checks only and holds no deployment credentials; Wrangler remains the single production deployer.
- Run `npm run typecheck`, `npm run lint`, `npm test` and `npm run test:browser`, then push and verify the CI run for that exact Git commit. The Chromium checks seed isolated synthetic media and 100 shots rather than writing production data.
- Before upload, run `npx wrangler whoami` and `npx wrangler deploy --config apps/api/wrangler.jsonc --dry-run`. Build output and bindings must match the intended Worker. Publish with the Git commit in `--message`; preserve dashboard variables with `--keep-vars`.
- Previous production Worker version recorded before this release: `0f5954cf-dc58-4974-959b-d770cdc82e5e` (deployment `3b144f27-ad08-43d3-9e66-26560199c3c3`, 100%). If this release fails, use `npx wrangler rollback 0f5954cf-dc58-4974-959b-d770cdc82e5e --config apps/api/wrangler.jsonc` after checking that it is still the intended prior version, and verify the protected UI again. No D1 migration or R2 object mutation is part of this release; Worker rollback still does not roll back stored composition edits.
- After promotion, independently read back the Cloudflare deployment, verify anonymous rejection for UI/API/MCP, and inspect the logged-in workbench at the production hostname. Record the actual version and results in the release evidence; a dry run is not production verification.

## Official references
- [Cloudflare Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Workers Builds / GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
- [GitHub Actions + Wrangler](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
