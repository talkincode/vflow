# vflow

**Agent-native declarative video composition protocol and collaborative asset workspace.**

[中文](#项目定位) · [Roadmap](docs/roadmap.md) · [Architecture](docs/architecture.md) · [Deployment](docs/deployment.md) · [Protocol draft](docs/protocol.md) · [Agent rules](AGENTS.md)

## 项目定位
vflow 面向人与多个 Agent 共创视频作品。项目原名 Video Compose；包名、协议标识和 canonical 域名已统一为 `vflow`，历史 `video-compose/*` 文档与 MCP URI 仍可读取，新写入只使用 `vflow/*`。项目记录可移植的分镜结构、时间线、Prompt、参考图片/视频、音频/视频资产、候选输出及版本变更；外部 Agent 自选生成工具，并通过标准 MCP/HTTP 接口修改编排和上传资产。

**只做定义、协作与资产管理，不做模型生成、渲染执行或视频发布。** 不是 ComfyUI，也不是视频剪辑器。

## 核心能力
- Project 下多个 Composition，共享可检索的 Asset，并采用简洁的项目级 `reader` / `writer` 读写权限隔离。
- 首页提供项目列表、搜索与新建；项目页显示编排及共享资源概览，可创建编排并选择画面规格/帧率。工作台支持返回项目、切换编排和独立直达地址。
- **角色/道具设定库**：项目级主体（Subject）有独立定义、稳定 ID、带状态（`status: candidate | approved`）的修订版本、外观/状态变体（含 `defaultVariant`）和多视角参考图集；`candidate` 状态便于修改迭代，批准为 `approved` 后冻结；分镜绑定确定版本，禁止参考设定悄然漂移。详见 [主体与参考图规范草案](docs/subjects.md)。
- v1/v2 JSON/YAML 声明式编排协议和独立可机读 Schema；v2 固定参考资料来源并拒绝有损 v1 导出。
- **参考制作工作流**：单角色面部/身体分包、道具逐格归属、独立场景与环境变体、无字序列、逐图审阅、准确的生成输入包和外部实际输入证据。MCP 提供 instructions、prompts、resources 与纯工具兜底，领域层防止旧写入口绕过。[制作规范与迁移指南](docs/reference-authoring.md)。
- 稳定 Shot ID、播放序列与分镜依赖拓扑（`dependsOn` DAG）、全局音轨（`audioTracks` 如全局 BGM/旁白）、分镜多参考图、可选参考视频、Prompt、音视频候选集（`candidates`）与选定输出（`selected`）、整数帧时长与扩展元数据。
- 不可变 R2 媒体（两阶段上传与 SHA-256 校验）与 D1 资产索引、修订历史、基于稳定 ID 的结构化 Patch、冲突检测和审阅提案（Proposal）。
- 统一 REST/MCP 接口；React 工作台提供分镜、素材、角色与道具、参考制作、协作与历史、协议标签页，保留网格、清单和依赖视图。
- 同源受权图片/视频/音频预览；按镜头保留当前页面草稿，明确保存范围与冲突处理；镜头搜索、前后跳转、排序与原子批量时长修改。

## 技术架构
TypeScript（strict/ESM）贯穿协议、服务与 Web；npm workspaces。
- API: Cloudflare Workers + Hono + remote MCP.
- Storage: Cloudflare D1（authoritative revisions / ACL / metadata）+ R2（immutable media）。
- Web: React + Vite，预览/编辑并排，可收起导航或进入专注编辑。
- Optional: Durable Objects 用于必要时的在线协作通知。
- **Deploy target**: Cloudflare Workers，正式入口 `vflow.talkincode.net`，旧域名 `video-compose.talkincode.net` 保留兼容（`talkincode.net` Cloudflare 子域名），UI/API/MCP 统一受 Cloudflare Access Zero Trust SSO 保护；Agent 经受控非交互身份访问，Worker 做项目级授权。
- **GitHub-to-Workers**: 首选 Cloudflare Workers Builds 与 GitHub `main` 集成部署；GitHub Actions + Wrangler 仅作为替代部署路径，两者不并行部署生产。详见 [deployment](docs/deployment.md)。
详见 [architecture](docs/architecture.md)。

## 项目状态
- **本地核心实现与验收**：协议、领域、HTTP/MCP、D1/R2 持久化、Web 工作台已有 11 套 E2E/集成测试；真实 Chromium 验收覆盖项目/多编排导航与创建、失败恢复、媒体解码、100 镜头操作、两种角色及 360–1920 像素布局。执行方式见下方。
- **线上环境**：Cloudflare Workers 自定义域名、Access、D1/R2 绑定已核验。当前通过 Wrangler 手动发布；GitHub Actions 只做质量检查，Workers Builds 自动触发尚未配置。最近发布证据与回滚说明见 [deployment](docs/deployment.md)。

## 本地验证与发布

浏览器入口为项目列表 `/`；项目为 `/projects/:projectId`；编排工作台为 `/projects/:projectId/compositions/:compositionId`。使用页面中的链接即可复制或收藏对应地址。新项目为空，创建编排后开始编辑第一镜；不会自动初始化固定的演示项目。离开有未保存草稿的工作台时会触发浏览器提醒。

使用 Node.js 26 和仓库锁定的 npm 依赖：

```sh
npm ci
npm run typecheck
npm run lint
npm test
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install --with-deps chromium
npm run test:browser
```

浏览器验收会启动仅监听回环地址的本地测试服务，使用合成媒体和 100 个分镜，不连接生产数据。`scripts/ui-test-server.ts` 不属于生产 Worker。

通过目标提交的 CI 后，已登录正确 Cloudflare 账户的维护者运行 `npm run deploy`。部署前后核对 Worker 版本、D1/R2 绑定、Access 保护和登录后的真实界面，不能把本地构建成功当成线上发布成功。

## MCP 接入

正式网站：`https://vflow.talkincode.net`；Remote MCP：`https://vflow.talkincode.net/mcp`。OAuth discovery 根据请求域名生成 issuer 和端点；UI/API 使用 Cloudflare Access，MCP 使用 OAuth Bearer 与项目 ACL。已有旧域名连接保持兼容，新配置使用 vflow。

## Quality & contributions
请先阅读 [AGENTS.md](AGENTS.md) 及 [roadmap acceptance matrix](docs/roadmap.md#验收矩阵业务能力覆盖矩阵)。新增一级能力必须补充 Happy Path E2E；高风险、权限及状态修改必须验证失败和恢复路径。禁止为功能开发而扩大非目标范围。

## License
MIT

账号默认私有、明确授权共享、退出登录及项目/编排回收站的权限、接口和迁移说明见 [用户与回收站](docs/accounts-and-trash.md)。
