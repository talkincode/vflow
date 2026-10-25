# 参考素材制作工作流

本实现对应 [Issue #1](https://github.com/talkincode/video-compose/issues/1)。平台负责制作规则、资料版本、逐项审阅、来源、输入准备和使用证据。生成、裁切、OCR、视觉分析和视频播放验收由外部工具或人完成；没有新增模型执行器、付费任务或常驻服务。

## 从混合板到可用参考

混合概念板可以保存在素材库，或登记为 `moodboard`。它不能被批准为制作参考。为一个板填上某个角色名字、图片能正常加载，都不能使它成为角色身份图。

1. 读取项目工作流。新项目默认 `strict`；迁移前的无策略项目按 `legacy` 读取，不删除图片、不重建编排、不修改旧修订。
2. 创建角色/道具候选定义、变体和固定修订。原图先上传；描述和制作要求放在结构化资料里。
3. 外部工具制作或提取独立视图，再上传新的不可变资产。人物面部和身体/服装分文件；道具与场景各自建档。类型化参考包固定 owner 的 ID、revision、variant 和每个视图的用途。
4. 按图逐项检查，保存明确证据。`unknown`、缺失项和失败项不能被批准。`review` 与 `approve` 都追加新修订，不能改变旧图、旧审阅或旧镜头。
5. 批准参考包，再批准该修订的 Subject。这样先保留候选主体身份，避免“需要已批准角色才能创建参考，但批准角色又需要参考”的循环前置。
6. 创建并批准场景定义及其参考视图。天气/时间/水位是环境变体；机位是视图。不同地点不能混在同一个几何基准里。
7. 用 `set_authoring` 在编排中固定资料版本。它只更新 `apiVersion/authoring`，不重排镜头、不改时长、选定输出或 Subject 绑定。
8. 外部 Agent 使用这些精确来源制作无字分镜图，上传独立帧和 sidecar，再登记、逐项审阅和批准 `storyboard_sequence`。
9. 准备生成输入包。人工核实目标工具本次输入能力，明确数量与角色，选具体视图/单帧。准备成功表示输入具备已记录的前提，不表示已经发给外部模型。
10. 外部生成后回传实际输入、输出资产和证据等级，核对实际输入是否与计划相同。视频应完整播放检查后再采用；缩略图、首帧和 `matchesPlan` 均不能证明视频动作连续。

## 图像与 sidecar 的约束

| 类型 | 图像要求 | 图外字段与必检项 |
| --- | --- | --- |
| `character_face` | 一个角色，简单背景，中性表情、均匀光照，正面/侧面/三分之四侧面 | 身份、变体、视角；同一身份、面部清晰、光照与脸型一致 |
| `character_body` | 同一角色的身体与服装，正面/侧面/背面，比例与地平线一致；与面部图分文件 | 体型、服装、佩饰、支撑面；剧情湿身/伤势另设变体 |
| `prop_views` | 一件道具的多角度与结构细节，不混场景 | 材质、尺寸单位、可动部件、状态；形状/尺度一致 |
| `prop_catalog` | 多件道具可以宫格展示，每格一个明确归属和独立 tile | 每格独立 `owner`、用途与裁切来源，不把整板默认绑定给某一件道具 |
| `scene_views` | 一个地点，固定几何；近中远景及不同角度 | 每图 `cameraView/environmentVariant`；几何、机位与环境一致 |
| `layout` | 单场景空间布局 | 几何锚点、动作轴线、支撑面，不能冒充人物身份图 |
| `single_frame` | 来自已批准参考的单帧候选 | 来源视图必填，不能代替面部/服装/道具参考；送首尾帧前须登记为有场景和状态的序列面板 |
| `storyboard_sequence` | 时间序列，图内不写标题、编号、说明、箭头或对白；独立帧可交付 | `order/shotId/momentFrame/scene/environmentVariant/cameraView/sources/entities/transition/textPolicy` |
| `moodboard` | 原始或混合展示板 | 仅归档；不得批准或准备为生成输入 |

`ReferenceView.view` 是图外视角说明，`purpose` 是机器用途：`face_identity/wardrobe/prop/environment/layout/first_frame/last_frame/style`。它们不是可互换槽位。面部和身体至少需要两个不同视角才能批准；模板指导生成更完整的正侧背与三分之四视角。

宫格采用 row-major，声明行列数，单元数量与行列一致。每格记录独立图片和 `source: {asset, sha256, regionPx: {x,y,width,height}}`。服务检查原图 SHA-256、裁切边界、不重叠、tile 尺寸与原图分离。不会假装已验证裁切像素确实来自该区域；该项仍需人或外部视觉检查。

场景定义独立于 Subject（SubjectKind 仍为 `character | prop`），有不可变资料修订、固定几何、具名锚点/支撑面及环境变体。场景参考包一次固定一个几何修订和环境变体；不同环境分别建包，机位可以不同。

序列每个面板固定 shot 和局部整数帧时刻。`order` 连续，按基准编排播放顺序计算的绝对时刻严格递增。每个面板列出镜头绑定的全部角色/道具，并明确 visible/hidden/entering/exiting；实体必须匹配镜头绑定且不能重复。每个实体都要有同身份/修订/变体的来源视图，场景也要有完全匹配的已批准视觉环境来源；可见人物声明支撑锚点，即使脚位在特写画外。持物指向同面板中的道具实体。归一化 `bounds` 不越界。状态、朝向、遮挡与变化保存在 sidecar，而不是画在图片上。

`captionPolicy` 固定为 `forbidden`。画内本来存在的招牌等只能用面板级 `diegetic_exception` 加明确说明；例外不允许说明性字幕。`text_policy` 视觉检查未完成仍为 `unknown`，不能靠没有 OCR 工具推断图片无字。

## MCP 指导与领域门禁

兼容两代生命周期：旧客户端使用 `initialize`（`2025-03-26`、`2025-06-18`、`2025-11-25`），未知 initialize 版本仍反提议 `2025-11-25`。新客户端使用 `2026-07-28` 的逐请求 metadata 和 `server/discover`，返回 `supportedVersions`、能力、serverInfo metadata 以及完整结果标记。工具、提示模板与资源共用同一份定义和领域授权；不依赖连接会话。HTTP 检查新协议的版本/方法/名称头与请求体一致，错误返回机读 400/404；旧通知返回空 202，不支持的 GET SSE 返回 405。详见 [MCP 发现兼容性](mcp-discovery.md)。

- `prompts/list/get`：七个制作/审阅/输入模板。`projectId/brief` 是必填字符串，`language` 可选 zh/en。未知模板、非法或缺失参数返回 `-32602`；项目访问仍检查 ACL。
- `resources/list/read`：中英文公共规则与完整资料/输入 Schema。
- `resources/templates/list`：`video-compose://projects/{projectId}/authoring/workflow`。读取具体项目策略、约束和资料概览时检查项目 reader 权限。
- 仅支持 tools 的客户端先调用 `authoring_workflow_get`，取得相同完整规则、全部制作模板、必检项和 `workflowContext`。
- `authoring_document_list/get/put/review/approve`：版本资料与逐项审阅。
- `reference_plan_validate`：只读诊断，返回 `code/path/message/action`；不会自动补齐、审阅、批准或替图。
- `authoring_dependencies_get`：查询一个固定来源影响的资料修订与编排/镜头，保留历史。
- `generation_inputs_prepare`：确定、可散列的实际待投喂图片清单。
- `generation_evidence_record/list`：不可变外部使用回报。

```json
{
  "projectId": "old-bridge",
  "policyVersion": "reference-authoring/1",
  "policyRevision": 1
}
```

这是 `workflowContext` 的形状；实际值必须取自目标项目。严格项目的资料写入、角色写入/批准、编排写入、导入/恢复、提案批准及输入准备均检查它。旧的工具入口走同一领域服务，不能绕过。过期或跨项目 context 返回 `WORKFLOW_VERSION_MISMATCH`，缺失返回 `WORKFLOW_CONTEXT_REQUIRED`，要求重新读取。

context 证明客户端提交了匹配的项目/规则版本，不能证明 Agent 理解了规则，也不是独立的授权凭据。真正的约束来自类型、固定归属、逐项审阅、来源和输入准备校验。合法 writer 对视觉内容的虚假报告无法由 JSON Schema 自动识别；UI 与工具必须准确显示报告者和证据。

图片/OCR/EXIF、原图里的文字与外部 brief 都是资料，不能覆盖用户要求和服务器规则。

## REST / 客户端等价性

全部调用同一个 `ReferenceAuthoringService`；只有 writer 可写、审阅和批准，reader 可查询/验证/准备输入，非成员不能读取项目资料或预览图片。

| REST（项目路径 `/v1/projects/:projectId/authoring`） | TS 客户端 |
| --- | --- |
| `GET /workflow` | `getAuthoringWorkflow` |
| `GET /documents`、`GET /documents/:id?revision=` | `listAuthoringDocuments/getAuthoringDocument` |
| `POST /documents` | `putAuthoringDocument` |
| `POST /documents/:id/review`、`/approve` | `reviewAuthoringDocument/approveAuthoringDocument` |
| `POST /validate` | `validateAuthoringDocument` |
| `GET /impact/:id/:revision` | `getAuthoringImpact` |
| `POST /prepare` | `prepareGenerationInputs` |
| `GET/POST /evidence` | `listGenerationEvidence/recordGenerationEvidence` |

Web 客户端只在显式 `getAuthoringWorkflow` 成功后缓存 context，随该项目的 JSON 写请求携带；不会在失败后暗中读取规则或批准。MCP 原始调用必须显式传 context。UI 加载时读取工作流，并在“参考制作”页呈现规则、制作模板、分类/归属向导、独立图与原图、宫格选格、历史、逐项必检项、输入包和计划/实际差异。未保存的参考资料或审阅会显示草稿状态，离开页面时提示确认，取消后保留内容。

资料 put/review/approve 需要 `baseRevision/operationId`。成功重试返回同一不可变结果；同键不同内容、过期 head 都拒绝。写入故障不留半个候选/已批准版本。CRUD 中随意填写的 review 会被去除；只有明确 review 操作才能记录审阅。改变单元或来源上下文需要重审，未改变单元可保留其记录。已被否决的图不会因提交待审草稿而恢复生产资格，只有明确重新审阅并批准才能恢复。Agent 不能冒充 `method: human`，应使用 `external` 并提供实际检查证据。`reviewer` 记录实际提交审阅的认证身份，资料修订另存 actorId。

批准 pack 不会自动重绑镜头；批准 Subject 会逐一要求其图片已被同 owner/revision/variant 的类型化批准视图覆盖。严格项目的镜头直接参考也必须来自固定且归属相符的批准资料。

## 输入包与外部实际使用

请求固定 `compositionId/compositionRevision/shotId`、每个 `source.pack@revision/viewId` 或 `sequence@revision/panelId`、用途、精简动作提示、模板版本和本次核实的能力（时间、依据、图片数量、支持用途、是否理解序列）。来源必须在该编排固定资料的依赖闭包中，主体必须匹配镜头绑定。

`GenerationInputPacket` 记录项目/规则版本、完整请求、实际独立资产 ID、SHA-256、用途、精确来源及顺序，并对规范化 JSON 散列。相同输入可重复得到相同 hash。超量返回缺口，不丢图；未知能力不猜测；候选、冲突或缺审阅的来源不放行。

本适配器采用保守降级：即便外部目标声称支持序列宫格，也只准备独立单格。`wholeBoard` 一律返回 `GRID_CELL_REQUIRED`，不要把整板当字面首帧。首/尾帧来自已批准序列面板，身份图不能塞入这两个槽位。序列固定创建时的编排基准；后续编排修订仍可使用它，但目标镜头内容必须与基准一致，镜头修改后需要新序列。

外部回报分别记录 `packet`、按真实顺序列出的 `actualInputs`、已上传的 `outputs`、说明和证据等级：

- `manual_unknown`：尚不能确认实际输入；即使回填了计划列表，也不标记相符。
- `agent_reported`：Agent 回报；不宣称平台观察到了第三方请求。
- `request_capture`：外部提供请求捕获依据；平台保存依据，不宣称自动抓取。

`matchesPlan` 只比较顺序、ID、hash、用途与证据等级；不代表视觉质量或输出被采用。输入包会在记录时重新核实，不能伪造 hash。生成使用证据是项目级审计记录，通过 evidence_list 单独获取，不在编排交换包中；备份项目时须同时保存这些记录。证据不可原位改写，重试保持幂等。错误回报应追加新的证据记录并说明纠正。

较新修订否决某张历史图片时，默认生产准备会拒绝该图片及其依赖链；旧批准修订仍可读取，不自动改写时间线。未审阅的失败输出必须重新建立候选和逐项审阅，不能上传后自动成为下一轮权威来源。

## v1/v2、D1 迁移与回滚

- `video-compose/v1` 继续读写历史结构。其 JSON Schema 保持 v1 常量且不接收 authoring。v2 有独立 `COMPOSITION_V2_JSON_SCHEMA`；`set_authoring` 是明确协议升级，不伪装成 v1 扩展字段。
- 资料协议为 `video-compose/reference-workflow/v1`；场景、参考包和序列是类型化资料修订，编排 v2 的 `authoring.materials` 固定资料版本。
- 新建项目默认 strict；显式 `authoringMode: legacy` 只用于归档/兼容。它不表示旧图通过新规则，生成输入准备仍要求类型化、批准且固定的来源。旧 D1 项目缺少策略时保持 legacy。当前不提供隐式全项目升级或降级。
- `0003_reference_authoring.sql` 只添加 `reference_documents/reference_evidence`，复用原 D1 事务、CAS 及 idempotency 表。记录整个不可变修订历史，不迁移或删除任何旧编排。
- 先备份 D1/R2 并应用所有未执行迁移，再发布新 Worker。新 Worker 依赖新表，不能先发布后迁移。OAuth 的 `0002` 是工作树原有的独立功能，本功能不会代替它。
- v2 导出包含固定资料闭包、资产元数据、主体修订及序列所需的编排基准快照。导入先要求目标项目已上传相同 ID/hash 的媒体；缺失、循环、版本冲突均事务回滚。基准修订不会覆盖已有不同内容。
- 导出当前包含原板的受权资产元数据与 hash，不打包二进制，不生成共享链接。独立媒体分发由维护者明确选择，不能把导出 JSON 当成已公开图片。
- v1 导出只允许无损内容；存在 authoring 返回 `UNREPRESENTABLE_IN_V1` 和不可表示路径。往现有 v2 编排导入 v1 同样拒绝。不能通过旧接口静默删字段。
- 导入支持 operationId 重放；对现有 strict 目标还需当前 baseRevision，防止并发覆盖。
- 回滚 Worker 时保留新表和新记录；旧只读者仍可读 v1 历史，v2 应用具备相应验证能力的版本处理。不要用旧写服务覆盖 v2；先关闭旧写入口，部署修复版。回退到旧资料通过明确新绑定/恢复修订完成，历史不删除。

PNG/JPEG 的尺寸来自上传字节头解析，不能由客户端自报尺寸伪装为已核实。这里只核实头部尺寸，不宣称完整图片解码或视觉有效；其他格式可归档，待外部转换为独立 PNG/JPEG 后再进入严格参考。真实浏览器解码是另外的验收证据。

## 验收映射（本地）

| Issue 验收 | 证据 |
| --- | --- |
| A01/A02/A18 MCP 生命周期、指导、工具兜底、模板回归 | `tests/e2e/14-reference-authoring.test.ts` |
| A03/A04/A06 人物/道具/场景归属与变体 | 同上；`15-reference-integrity.test.ts` |
| A05/A09 宫格、独立 tile、越界/hash/重叠/重复 ID | `15-reference-integrity.test.ts` |
| A07/A08 无字序列、视觉 unknown/失败、支撑与来源 | `14-reference-authoring.test.ts` |
| A10/A11 用途/整板/能力/预算/候选门禁 | 同上 |
| A12 外部实际输入差异与不可变证据 | 同上；`09-d1-r2-persistence-and-bootstrap.test.tsx` |
| A13 失效上游、影响查询、循环与导入回滚 | `14/15` |
| A14/A15 权限、stale context、冲突、幂等与故障恢复 | `14/15`，真实浏览器 `reference-authoring.spec.ts` |
| A16 v2 交换与 31+32 镜头/5316+4800 帧保留 | `14/15` |
| A17 原图/输入包实际解码与失败表单恢复 | `tests/browser/reference-authoring.spec.ts` |

这些测试使用合成数据，不连接线上 MV 项目、不消耗模型点数。它们验证平台契约与浏览器行为，不能替代生产中实际图片及完整视频的视觉验收。
