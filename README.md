# Video Compose

**Agent-native declarative video composition protocol and collaborative asset workspace.**

[中文](#项目定位) · [Roadmap](docs/roadmap.md) · [Architecture](docs/architecture.md) · [Deployment](docs/deployment.md) · [Protocol draft](docs/protocol.md) · [Agent rules](AGENTS.md)

## 项目定位
Video Compose 面向人与多个 Agent 共创视频作品。项目记录可移植的分镜结构、时间线、Prompt、参考图片/视频、音频/视频资产、候选输出及版本变更；外部 Agent 自选生成工具，并通过标准 MCP/HTTP 接口修改编排和上传资产。

**只做定义、协作与资产管理，不做模型生成、渲染执行或视频发布。** 不是 ComfyUI，也不是视频剪辑器。

## 核心能力（目标，尚未实现）
- Project 下多个 Composition，共享可检索的 Asset，并采用简洁的项目级 `reader` / `writer` 读写权限隔离。
- **角色/道具设定库**：项目级主体（Subject）有独立定义、稳定 ID、带状态（`status: candidate | approved`）的修订版本、外观/状态变体（含 `defaultVariant`）和多视角参考图集；`candidate` 状态便于修改迭代，批准为 `approved` 后冻结；分镜绑定确定版本，禁止参考设定悄然漂移。详见 [主体与参考图规范草案](docs/subjects.md)。
- v1 JSON/YAML 声明式编排协议和可机读 Schema。
- 稳定 Shot ID、播放序列与分镜依赖拓扑（`dependsOn` DAG）、全局音轨（`audioTracks` 如全局 BGM/旁白）、分镜多参考图、可选参考视频、Prompt、音视频候选集（`candidates`）与选定输出（`selected`）、整数帧时长与扩展元数据。
- 不可变 R2 媒体（两阶段上传与 SHA-256 校验）与 D1 资产索引、修订历史、基于稳定 ID 的结构化 Patch、冲突检测和审阅提案（Proposal）。
- 统一 REST/MCP 接口；轻量 React 网格、清单、拓扑及 Agent 侧栏。

## 技术架构（规划）
TypeScript（strict/ESM）贯穿协议、服务与 Web；npm workspaces。
- API: Cloudflare Workers + Hono + remote MCP.
- Storage: Cloudflare D1（authoritative revisions / ACL / metadata）+ R2（immutable media）。
- Web: React + Vite，三种同源视图。
- Optional: Durable Objects 用于必要时的在线协作通知。
- **Deploy target**: Cloudflare Workers，规划域名 `video-compose.talkincode.net`（`talkincode.net` Cloudflare 子域名），UI/API/MCP 统一受 Cloudflare Access Zero Trust SSO 保护；Agent 经受控非交互身份访问，Worker 做项目级授权。
- **GitHub-to-Workers**: 首选 Cloudflare Workers Builds 与 GitHub `main` 集成部署；GitHub Actions + Wrangler 仅作为替代部署路径，两者不并行部署生产。详见 [deployment](docs/deployment.md)。
详见 [architecture](docs/architecture.md)。

## 项目状态
- **本地核心实现与 E2E 验收（M1–M3 已完成）**：`packages/protocol`、`packages/domain`、`packages/client`、`apps/api`、`apps/web` 及 8 套 E2E 验收测试（`tests/e2e/`）已实现并通过本地 `typecheck`、`test`、`lint` 与 `build` 验证。
- **线上部署状态（M4 待核验）**：规划子域名 `video-compose.talkincode.net`、Cloudflare Access、D1/R2 生产绑定与 GitHub 部署集成仍属于待配置与待核验的目标状态。

## Quality & contributions
请先阅读 [AGENTS.md](AGENTS.md) 及 [roadmap acceptance matrix](docs/roadmap.md#验收矩阵业务能力覆盖矩阵)。新增一级能力必须补充 Happy Path E2E；高风险、权限及状态修改必须验证失败和恢复路径。禁止为功能开发而扩大非目标范围。

## License
MIT
