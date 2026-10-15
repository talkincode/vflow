# AGENTS.md — Video Compose

## Mission
Build a portable, versioned declarative video composition protocol and a lightweight human/multi-Agent collaboration workspace. TypeScript is the primary language.

## Scope guardrails
- Protocol and domain semantics are the source of truth; UI and MCP are adapters.
- No image/video generation runtime, no ComfyUI-like execution graph, no built-in media rendering, no publishing integrations.
- Deployment MUST target Cloudflare Workers; do not introduce PM2/systemd/VPS runtime, fabricated hostnames, example.com domains or hardcoded ports as deployed facts.
- Production hostname MUST be a `talkincode.net` subdomain managed by Cloudflare; planned default `video-compose.talkincode.net` until actual DNS/Worker routing is verified.
- Browser UI, REST API and MCP MUST be protected with Cloudflare Access (Zero Trust SSO / service authentication as appropriate); Worker MUST still enforce per-project authorization.
- GitHub-to-Workers deployment MUST be supported, preferring native Workers Builds GitHub integration; GitHub Actions + Wrangler is an alternative, never a simultaneous competing production deployer.
- Distinguish design decisions from verified live infrastructure. Do not report CI, DNS, Access, R2 or D1 as configured without inspecting actual resources.
- Do not embed external model/API/vendor dependencies in the portable composition schema.
- Never use mutable URLs or signed R2 URLs as permanent asset identifiers.
- No last-write-wins on conflicting composition edits. Every write has a base revision and idempotency key.
- Immutable revision history and immutable media identity. Never overwrite referenced media in place.
- Characters/props are first-class project Subjects, not filename conventions or plain asset tags. Model stable IDs, semantic descriptions, immutable subject revisions, curated reference packs and explicit variants.
- Shots MUST pin subject revision and optional variant; updating the canonical reference set must NEVER silently alter existing shots. Candidate reference assets are not automatically approved.
- Project/portable composition export MUST preserve or explicitly resolve pinned subject dependencies; avoid hardcoding provider-specific generation metadata.
- Keep secrets and personal/private assets out of commits, logs and public responses.
- Do not add infrastructure or background services without an observable requirement.

## Architecture
- TypeScript strict mode, ESM. Planned npm workspaces: `apps/api` (Cloudflare Worker/Hono/MCP), `apps/web` (React/Vite), `packages/protocol`, `packages/domain`, `packages/client`.
- Cloudflare D1 is authoritative for project metadata and revisions; R2 for immutable media; Durable Objects only if evidence shows need for real-time fan-out.
- Shared domain operations serve UI/REST/MCP. Version JSON Schema and document any breaking change and migration.
- The roadmap defines WHAT/NOT: [docs/roadmap.md](docs/roadmap.md). Technical decisions: [docs/architecture.md](docs/architecture.md). Deployment/authentication: [docs/deployment.md](docs/deployment.md).

## Subject and reference continuity requirements
- Any change to a character or prop definition requires an auditable revision and scoped authorization; do not alter old character/prop appearance by mutating a referenced asset.
- A new reference image can be added as a candidate; promotion to an approved pack requires a deliberate operation subject to permissions and concurrency checks.
- Cross-shot consistency is expressed through pinned subject versions and variants, not duplicate per-shot free-text descriptions.
- Reference model draft: [docs/subjects.md](docs/subjects.md). Acceptance: see the dedicated Subject row in [roadmap](docs/roadmap.md).

## Agent workflow
1. Read README, roadmap, architecture and relevant source before modifying code.
2. Define observable behavior and affected acceptance-matrix rows.
3. Implement behavior through shared domain contracts, not channel-specific shortcuts.
4. Run relevant local schema, integration and E2E checks; report actual command results.
5. Keep diffs limited and avoid modifying unrelated project data.
6. If schema compatibility or destructive data migration is involved, explicitly document the rollback plan.

## 验收矩阵（硬性规定）
验收矩阵单一事实来源：[项目画像与验收矩阵](docs/roadmap.md#验收矩阵业务能力覆盖矩阵)。

1. **MUST**：每个一级功能至少有一条 Happy Path E2E 验证。
2. **MUST**：每个高风险功能至少覆盖一条失败路径。
3. **MUST**：每个涉及权限的功能至少验证两种角色（有权/无权或等价区分）。
4. **MUST**：每个会修改系统状态的操作至少验证一次失败后的恢复或回滚。
5. **MUST**：新增一级业务功能时必须同步新增对应 E2E 并更新 `docs/roadmap.md` 的验收矩阵，否则变更不完整。

测试策略：验收以 E2E/集成测试为主；单元测试只用于核心逻辑（密集纯逻辑、安全/数据完整性判定、回归钉、组合边界）；不设覆盖率指标，不为覆盖率补写单元测试。
