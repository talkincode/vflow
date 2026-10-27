# vflow 项目画像与路线图

## 项目概述
vflow 是面向人和多个 Agent 的开源视频作品编排协议与轻量协作工作台。不同 Agent 可读取同一项目、变更分镜并向项目交付媒体资产，而不需要共享模型或生成运行时。系统只定义作品结构、素材引用、修订及权限。

已实现数据流：Web / Agent -> REST / MCP -> 统一领域操作 -> D1（项目、修订、索引）和 R2（不可变资产）。

## 项目画像（目标状态）
一份可移植、机器可验证的视频作品定义，支持多分镜、时间线、图片/视频/音频引用、候选素材、稳定身份和可追溯修改。角色与道具不仅是图片文件，也有项目级可复用的身份、定义、版本、外观/状态变体及多张权威参考图；分镜固定引用确定的主体设定版本。人与 Agent 拥有相同的读写协议接口，提供轻量网格、清单、拓扑和上下文 Agent 侧栏。

冲突时价值优先级：数据正确性与可恢复性 > 协议兼容性与可移植性 > 权限隔离 > 协作体验 > UI 外观。

## 当前能力清单
- **开源仓库与文档**：GitHub Public 仓库已创建；README、AGENTS 和架构文档与代码实现保持同步。
- **本地核心实现与验收**：`packages/protocol`、`packages/domain`、`packages/client`、`apps/api`、`apps/web` 及 25 套 E2E/集成测试（`tests/e2e/01` 至 `25`）已实现；真实 Chromium 检查覆盖项目/多编排导航、新建与失败恢复、合成图片/视频/音频、100 镜头、只读/可写角色和 360–1920 像素布局。
- **Cloudflare 生产环境（M4 已部署核验）**：子域名 `https://video-compose.talkincode.net`（现 canonical 为 `https://vflow.talkincode.net`，旧域保留兼容）、Cloudflare Access 可复用策略（SSO + Service Token）、D1（`video-compose-db`）与 R2（`video-compose-media`）真实绑定及线上端到端读写均已部署并实测通过。

## 非目标（铁律）
- 不内置视频或图像生成模型，不提供模型节点工作流/ComfyUI 克隆。
- 不承担 FFmpeg 合成、渲染执行或模型任务调度。
- 不实现发布到 YouTube、社交平台或内容分发功能。
- 不把供应商密钥、临时媒体 URL、模型推理参数变成强制协议字段。
- 不把聊天日志当作项目编排权威数据，不允许静默最后写入覆盖。
- 不内置 3D/白模渲染或编辑，不在 vflow 内执行 Blender、Three.js 等外部引擎；动态白模只作为外部产出的参考登记、审阅、固定、交付与证据核对。

## 方向与意图
1. **项目与编排管理**：一个项目容纳多条独立编排，共享资产，采用极简的 `reader`（只读）与 `writer`（读写）两级项目权限模型。
2. **声明式编排协议**：稳定镜头 ID、播放序列（`sequence`）、镜头依赖拓扑（`dependsOn` DAG）、全局音轨（`audioTracks` 如全局 BGM/旁白）、参考图/参考视频、视频/音频候选集（`candidates`）与选定输出（`selected`）、Prompt 及可扩展元数据。
3. **不可变资产管理**：基于 SHA-256 摘要的媒体导入、两阶段上传校验、关联、复用和来源追踪。
4. **角色/道具设定与参考图管理**：对角色、道具建立项目级结构化设定、多视角参考图集、外观或状态变体（含 `defaultVariant`）及带状态（`status: candidate | approved`）的设定修订；`candidate` 状态便于修改迭代，批准为 `approved` 后冻结为权威版本；镜头绑定确定的设定版本，设定变更不静默影响旧编排。
5. **多 Agent 协作修订**：基于稳定 ID 的结构化 Patch、不相交路径自动合并、冲突检测、可回退历史、同构审阅提案（Proposal）。
6. **统一 HTTP/MCP 接入**：UI 与任何授权 Agent 观察并修改相同状态。
7. **轻量可视化工作台**：网格、清单、依赖拓扑、媒体预览、上下文 Agent 侧栏。
8. **开放交换与兼容性**：导入导出可验证的 JSON/YAML 编排定义并保持版本兼容，导入时强校验依赖完整性。

## 完成的样子
- 两个独立 Agent 和一名人类能在同一项目无数据丢失地协作，冲突可解释、可修复。
- 任意历史修订可重建；每个媒体引用要么解析为受权访问的不可变资产，要么明确报错。
- 角色与道具可先以 `candidate` 修订修改迭代，批准为 `approved` 后替换最新权威参考图集，历史镜头仍绑定原设定版本；可明确比较、选择是否更新引用。
- 编排 JSON/YAML 往返不改变作品语义（含全局音轨、镜头依赖与候选集）；UI 三视图使用同一领域模型。
- 产品可脱离具体生成供应商运行。

## 分阶段实施里程碑
1. **M1 — 协议与纯领域核心（`packages/protocol` + `packages/domain`）**：✅ 本地已实现并验证（v1 JSON Schema、JSON/YAML 无损往返、DAG 依赖环检测、Subject 绑定与状态校验、基于稳定 ID 的 Typed Patch 与三方 Disjoint Merge）。
2. **M2 — 存储、读写权限与 REST/MCP 接口（`apps/api` + `packages/client`）**：✅ 本地已实现并验证（事务存储、R2 两阶段上传与 SHA-256 校验、`reader`/`writer` 权限隔离、Hono REST API 与远程 Streamable HTTP MCP）。
3. **M3 — 轻量协作工作台（`apps/web`）**：✅ 本地已实现并验证（中文深色工作台，中央分镜/素材/设定/协作与历史/协议标签；预览编辑并排与专注模式；网格/清单/依赖三视图；受权媒体预览；逐镜头草稿、显式冲突核对、连续局部撤销、搜索/跳转/排序/原子批量时长；真实浏览器与多角色验收）。
4. **M4 — Cloudflare 生产部署与 Zero Trust 验收**：✅ 已部署并实测通过（D1 `028d0760-9c64-4f4d-876e-8e6b33236acc`、R2 `video-compose-media`、`https://video-compose.talkincode.net` 路由（canonical `vflow.talkincode.net`）、Cloudflare Access App `72992495-1fba-419e-83e7-d825db14f557` 可复用策略与线上 REST/MCP/UI 全链路验证）。

## 验收矩阵（业务能力覆盖矩阵）

### 覆盖底线（MUST，硬性规定）
1. 每个一级功能至少有一条 Happy Path 的 E2E 验证。
2. 每个高风险功能至少覆盖一条失败路径。
3. 每个涉及权限的功能至少验证两种角色（如 `writer` 有写权 vs `reader`/非成员无写权，或项目成员可读 vs 非成员不可读）。
4. 每个会修改系统状态的操作至少验证一次失败后的恢复或回滚。
5. 每次新增一级业务功能，必须同步新增对应的 E2E 并登记进本矩阵。

| 一级业务功能 | 阶段 | 风险 | 权限 | 状态修改 | Happy Path E2E | 失败路径 | 角色验证 | 失败恢复/回滚 | 真实证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 项目与编排管理 | 本地已实现 | 高 | 是 | 是 | ✅ (项目入口/概览、新建、跨项目多编排、直达 URL/历史导航) | ✅ (创建失败、响应丢失、非法/未授权链接、同键不同内容拒绝) | ✅ (`writer`/`reader`/非成员/匿名；只读 UI 与 API 拒绝) | ✅ (事务回滚、保留表单、创建幂等重试、D1 跨 isolate 重放、草稿离开提醒与取消) | `tests/e2e/01-project-and-composition.test.ts`, `tests/e2e/09-d1-r2-persistence-and-bootstrap.test.tsx`, `tests/e2e/11-project-navigation.test.tsx`, `tests/browser/projects.spec.ts` |
| 声明式协议与验证 | 本地已实现 | 高 | 否 | 否 | ✅（含更名前 `video-compose/*` 标识的读取兼容与 `vflow/*` 归一化） | ✅ (循环依赖/非法帧/URL 引用/未知 apiVersion) | 不适用：离线验证无用户角色 | 不适用：纯验证只读（含输入零修改断言） | `tests/e2e/02-protocol-validation.test.ts` |
| 不可变资产管理与受权预览 | 本地已实现 | 高 | 是 | 是 | ✅ (上传、图片解码、音视频播放/seek、Range/HEAD) | ✅ (完整性/覆盖/引用删除/416/缺文件) | ✅ (`writer`/`reader` 可预览；非成员/匿名拒绝) | ✅ (失败上传不登记资产；缺对象恢复后可重新读取) | `tests/e2e/03-immutable-assets.test.ts`, `tests/e2e/09-d1-r2-persistence-and-bootstrap.test.tsx`, `tests/e2e/10-media-and-editor-recovery.test.tsx`, `tests/browser/workbench.spec.ts` |
| 角色/道具设定与参考图管理 | 本地已实现 | 高 | 是 | 是 | ✅ (候选表单、真实参考、批准、固定版本/变体绑定) | ✅ (并发冲突/未批准绑定拒绝/无参考表单拦截) | ✅ (`writer`/`reader`) | ✅ (冲突或越权保持原权威修订不变) | `tests/e2e/04-subjects-and-references.test.ts`, `tests/e2e/10-media-and-editor-recovery.test.tsx` |
| 多 Agent 修订与审阅 | 本地已实现 | 高 | 是 | 是 | ✅ | ✅ (同字段并发修改返回结构化冲突) | ✅ (`writer`/`reader` Agent) | ✅ (冲突不污染 head，支持历史版本恢复) | `tests/e2e/05-multi-agent-revisions.test.ts` |
| HTTP/MCP 与 OAuth 接入 | 本地已实现 | 高 | 是 | 是 | ✅ (REST/MCP 等价调用；OAuth 2.1 动态注册、PKCE S256 协商、一键授权与 Bearer 调用) | ✅ (未授权/非法调用结构化错误；无效 PKCE/拒绝授权/过期码/已撤销令牌拒绝) | ✅ (匿名/`reader`/`writer`；授权主体权限继承与越权写入拦截) | ✅ (幂等键重试与事务故障恢复；RefreshToken 轮换与新令牌恢复) | `tests/e2e/06-http-and-mcp-parity.test.ts`, `tests/e2e/12-mcp-oauth.test.ts` |
| 轻量工作台 | 本地已实现 | 中 | 是 | 是 | ✅ (三视图/功能图标与用途提示/保存状态/媒体/100 镜头/响应布局) | ✅ (只读禁写、保存失败、并发冲突、批量与排序失败) | ✅ (`writer`/`reader`，API 绕过拒绝) | ✅ (逐镜头草稿/原键重试/清空保存/局部撤销/批量原子回滚/排序重试/空库初始化) | `tests/e2e/07-lightweight-workbench.test.tsx`, `tests/e2e/09-d1-r2-persistence-and-bootstrap.test.tsx`, `tests/e2e/10-media-and-editor-recovery.test.tsx`, `tests/browser/workbench.spec.ts` |
| 分镜素材图管理与上限限制 | 本地已实现 | 中 | 是 | 是 | ✅ (单镜头最多5张素材图、候选属性编辑、素材解除关联、未引用素材删除、工作台UI与MCP工具) | ✅ (单镜头超过5张素材图拒绝、协议校验拒绝、删除已引用资产拒绝) | ✅ (`writer` 可增改删，`reader` 拒绝写入和删除) | ✅ (超额添加保持原修订与候选不变，回滚保护) | `tests/e2e/13-shot-material-candidates.test.tsx` |
| 类型化参考制作与无字序列 | 本地已实现，待发布 | 高 | 是 | 是 | ✅ (指导→分包→场景→序列→精确输入→实际记录) | ✅ (混合板、错归属/用途、未知审阅、非法宫格、超预算、循环、有损导出) | ✅ (`reader/writer/agent/非成员`；REST/MCP/资源/UI) | ✅ (put/review/approve/evidence 故障重试、并发/版本冲突、导入原子回滚、31+32 镜头保留) | `tests/e2e/14-reference-authoring.test.ts`, `tests/e2e/15-reference-integrity.test.ts`, `tests/e2e/09-d1-r2-persistence-and-bootstrap.test.tsx`, `tests/browser/reference-authoring.spec.ts`；[A01–A18 映射](reference-authoring.md#验收映射本地) |
| 动态白模参考（`motion_reference`，L0 外部生成） | 本地已实现，待发布 | 高 | 是 | 是 | ✅ (提交→整体审阅→批准→固定到编排→准备输入包（整段视频）→回报实际使用→导出→导入→再次准备出同一输入；工作台播放白模视频与关键帧；纯 MCP 全生命周期) | ✅ (未审阅/缺检查/驳回、错媒体角色/未验证图/时长与关键帧越界、主体/场景/变体不符、身份图互斥复用、视频能力未明示不自动降级、关键帧降级须显式且计入预算、编排/主体/环境漂移、伪造 packet、缺依赖导入、v1 有损导出) | ✅ (`owner`/`writer` Agent、`reader`、非成员、匿名；工作台只读禁写；MCP 同权) | ✅ (put/review/approve/evidence/import 故障无半成品、幂等重试、CAS 冲突、D1 跨 isolate、UI 失败保留草稿) | `tests/e2e/18` 至 `24`、`tests/e2e/09`、`tests/browser/motion-reference.spec.ts`；[验收映射](reference-authoring.md#验收映射本地) |
| filmkit 固定版本交接 | 已部署（线上入口/资源核验；作品内交接待有权身份回读） | 中 | 是 | 只读交接 | ✅（双模式提示、固定修订命令、缺项定位；真实跨仓库合成） | ✅（未选视频、无时长、音轨越界、草稿/素材失败阻止交接） | ✅（writer/reader；非成员导出拒绝、撤权后拒绝拉取） | ✅（失败保存保留草稿、剪贴板失败可手动复制；下游下载/音频裁切失败不破坏原文件） | `tests/e2e/25-filmkit-handoff.test.tsx`、`tests/browser/filmkit-handoff.spec.ts`；filmkit `scripts/e2e-vflow-handoff.ts`；[使用与边界](filmkit.md) |
| JSON/YAML 交换 | 本地已实现 | 高 | 是 | 是 | ✅ | ✅ (损坏语法/缺失资产依赖原子拒绝) | ✅ (`reader` 可导出不可导入 / `writer` 可导入) | ✅ (导入失败保持目标项目原编排不变) | `tests/e2e/08-interchange-json-yaml.test.ts` |

### 已识别缺口和最低期望
- **分镜素材与上限**：单个分镜最多允许关联 5 张素材图（图片候选），超过 5 张时领域操作与协议校验原子拒绝；支持修改候选素材的角色标签和备注说明，支持从镜头解除关联，支持从素材库删除未引用素材；工作台分镜检查器与素材库均提供交互，远程 MCP 工具 `asset_link`、`asset_update_candidate`、`asset_unlink` 与 `asset_delete` 等价支持。已由 `tests/e2e/13-shot-material-candidates.test.tsx` 验收。
- **项目与编排**：浏览器首页列出当前身份有权访问的项目，可新建项目，从项目概览新建/进入/切换编排；工作台有返回项目的入口，复制地址和前进/后退正确。`writer` 能创建项目和编排；`reader` 可读但不能向该项目写入，非成员被拒；失败保留表单，创建重试不重复，跨项目不残留前一个项目的草稿或素材。已有 `11` 集成场景与真实 Chromium `projects.spec.ts` 验收。
- **协议**：合法样例（含全局音轨 `audioTracks`、分镜依赖 `dependsOn`、候选集 `candidates`）通过；缺失 ID、`dependsOn` 循环依赖、引用无效均给出稳定机器错误；校验不修改输入。项目更名前的 `video-compose/v1`、`video-compose/v2`、`video-compose/reference-workflow/v1` 文档与 `video-compose://` MCP URI 仍可读取并归一化为 `vflow/*`，新写入不产出旧标识。
- **资产**：两阶段上传校验 SHA-256 后可跨镜头与全局音轨复用；哈希不匹配或无 `writer` 权限拒绝；失败上传不登记可见资产。
- **设定与参考图**：`writer` 创建角色/道具设定、在 `status: candidate` 下修改并登记多张参考图、批准为 `status: approved` 后绑定两个分镜至同一设定修订（含省略 `variant` 时回退 `defaultVariant`）；生成新的角色/道具版本不改变旧镜头所引用版本；不存在、越权、冲突或资源损坏时操作失败且原状态不变。
- **协作**：两个 Agent 基于稳定 ID 的不相交 Patch 可安全合并，同一字段冲突可机读，Proposal 审批走相同合并校验，任何历史修订可恢复。
- **HTTP/MCP**：同一操作经 REST 与 MCP 得到一致结果；匿名/非成员/`reader` 越权写入拒绝；幂等键重复请求与失败重试安全。
- **工作台**：分镜在网格/清单/依赖拓扑三视图显示一致；明亮工作区通过图标、文字与当前功能用途区分分镜/素材/设定/参考制作/历史/协议，保存状态明确且不依赖颜色；标签、镜头与布局切换保留当前页面草稿；清空可保存、失败可重试、并发冲突须核对，局部撤销保留他人无关字段；100 镜头可搜索/排序/批量，`reader` 不可通过 UI 绕过 API。项目/多编排切换与直达地址已补齐，离开草稿可取消；当前草稿不跨页面关闭持久化。时间线缩放和提案差异审阅仍是后续交互能力。
- **交换**：JSON/YAML 导出重新导入语义不变；损坏格式或缺失引用依赖（未登记的 Asset / SubjectRevision）原子拒绝，原数据不变。

真实 E2E/集成证据出现前，所有缺口均不得标记完成。

## 参考制作工作流交付边界

Issue #1 的协议、共享领域服务、MCP 指导/工具兜底、REST/client、工作台、D1 增量迁移及本地验收已实现。新项目默认 strict，旧项目保留 legacy 读取/整理路径。未对线上《旧桥分水》项目执行迁移、重建或生成。图片的同一身份、实际站位、无字与视频完整动作仍需有证据的人/外部视觉验收，不以结构校验或缩略图代替。详见 [参考制作](reference-authoring.md)。

## 动态白模参考（L0）交付边界

白模由外部工具生成并上传，vflow 只做登记、整体审阅、批准冻结、编排固定、输入包准备（目标工具视频能力必须明示，不支持时只能显式选择关键帧降级且不丢弃）、实际使用证据与导出/导入。协议为 `vflow/reference-workflow/v1` 资料联合体的 additive `kind`，`vflow/v1` 读写不变，无 D1 迁移，核心无厂商字段。范围：L0 只支持完整镜头参考，白模秒数必须与镜头相同；动作文字（description/prompts）、dependsOn、时长、主体、format、场景修订变化视为漂移，候选与选定输出不算。限制：平台不解码视频，fps/时长/画面语义是声明加人工完整播放审阅，只有上传登记的 `durationFrames` 被机械核对；真实 Chromium 只证明能解码、播放和拖动。尚未发布，未接触线上项目数据。详见 [参考制作](reference-authoring.md#动态白模参考motion_referencel0)。

## 用户私有工作区与回收站

| 能力 | 状态 | 正常路径 | 失败/冲突 | 权限 | 恢复与证据 |
| --- | --- | --- | --- | --- | --- |
| 默认私有及明确授权共享 | 本地实现，待发布 | 账号归属、owner 授权 reader/writer | 签名失败、版本冲突、事务失败拒绝 | 跨账号读取、嵌套资源、媒体与 MCP 同一检查；只有 owner 管理成员 | 撤销即时生效；E2E16、浏览器 account-trash |
| 项目/编排回收站 | 本地实现，待发布 | 删除后隐藏，按权限列出回收站 | 内容/生命周期修订冲突，失败原子回滚 | owner 管理项目，writer 管理编排 | 恢复保留文档历史；父恢复保留子删除状态；E2E09/16、浏览器 account-trash |
| 用户退出 | 本地实现，待发布 | Access 退出入口与缓存清理 | 无效身份拒绝，恢复页面重新核验 | 身份由服务端验证，不信任身份头 | E2E16 与浏览器入口检查；详见 accounts-and-trash.md |

| 能力 | 状态 | 正常路径 | 失败与权限 | 验收 |
| --- | --- | --- | --- | --- |
| MCP 两代动作发现 | 本地实现，待发布与 ChatGPT 回读 | 2025 initialize 与 2026 server/discover；工具/模板/资源发现共用定义 | 空 202、405、非法信封 400；版本/名称头校验；匿名拒绝 | E2E17 两代官方 SDK；详见 mcp-discovery.md |

MCP 动作发现验收补充：ChatGPT 工具导入拒绝的固定同构元组须在适配层等价转换为对象式 `items`；E2E17 比较投影前后约束，最终验收为已安装插件的“刷新工具”成功与详情列表可见，不能只以 SDK 列表通过标记完成。
