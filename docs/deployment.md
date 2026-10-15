# Deployment and Authentication Contract — Video Compose

**Status: architecture decision, not a live deployment report (2026-10-15).** Keep this document aligned with `AGENTS.md`, `docs/architecture.md`, and the Mira project's `Memories/environment.md` and `Memories/deploy.md`.

## Fixed target
- **Public source**: `https://github.com/talkincode/video-compose`, canonical deployment branch `main`.
- **Application runtime**: **Cloudflare Workers**, TypeScript. Frontend React/Vite output may be served by the same Worker using Workers Static Assets; API and MCP use the Worker route. No self-managed server/PM2/systemd deployment.
- **Hostname**: a Cloudflare-managed subdomain of `talkincode.net`. **Default planned hostname**: `video-compose.talkincode.net` (not yet verified as bound/reachable).
- **State**: Cloudflare D1 for project and revision metadata; private R2 for immutable reference images/audio/video and other media; no per-file permanent signed URLs in composition definitions.

## Identity and authorization
- **Cloudflare Access (Zero Trust SSO)** is the authentication perimeter for the UI, HTTP API, and remote MCP endpoint. Identity provider and Access policies must be configured at deployment and are not assumed to already exist.
- Human users log in interactively through an Access-approved identity provider.
- Non-interactive Agent/MCP clients use policy-approved authentication, such as restricted **Cloudflare Access Service Tokens**. Service tokens are sensitive and are never stored in Git, composition JSON/YAML or project memory.
- Access authenticates entry, but **the Worker/domain layer still checks project membership, role and capability on every read/write call**. A globally authenticated Agent may not gain access to every project's assets by default.
- Upload/download tickets for R2 must be short lived, object-scoped and permission checked. Do not expose private R2 objects directly through an unauthenticated static route.
- Access protection, origin bypass paths and alternative `workers.dev` routes must be reviewed before production exposure.

## GitHub -> Cloudflare Workers
1. Default deployment mechanism: **Cloudflare Workers Builds connected to the GitHub repository**. Configure the production environment to deploy from the canonical `main` branch; PR preview is optional and must also be covered by intended Access policies.
2. Alternative mechanism: **GitHub Actions + Wrangler** using tightly scoped Cloudflare API credentials stored as GitHub Actions Secrets. It is an alternative, not an additional independent production deployer.
3. CI/release acceptance: run executable TypeScript checks, protocol compatibility validation and relevant integration/E2E checks before production promotion. A configuration file without a successful run is not proof of a working deployment.
4. Keep Worker config, R2 bucket, D1 database bindings and compatibility version explicit in project infrastructure configuration; never fabricate IDs or tokens.
5. Verify custom hostname reachability, SSO login, unauthorized browser rejection, unauthorized MCP rejection, role isolation and asset access after deployment.

## Recovery
- Record the deployed Worker version and Git commit before release; rollback through a verified Cloudflare Worker deployment rollback or a verified prior commit.
- D1 schema changes and asset migrations require separate forward/backward compatibility and recovery planning. Never assume Worker rollback undoes migrations.
- Publish a real deployment URL or success claim only after checking the actual Cloudflare resources and protected HTTP behavior.

## Current evidence / missing configuration
- **Known**: the open-source GitHub repository exists; Mira recognizes it as project `video-compose`. The architecture target in this document is explicitly chosen.
- **Unverified**: Worker name/deployment, custom domain and DNS, Cloudflare Access IdP and policy, GitHub integration, D1/R2 bindings and assets, end-to-end production availability.
- These items must be read from the actual Cloudflare/GitHub configuration when deployment is carried out, not filled from sample templates.

## Official references
- [Cloudflare Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Workers Builds / GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
- [GitHub Actions + Wrangler](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
