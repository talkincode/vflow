# ChatGPT MCP 动作发现兼容性

## 问题与证据边界

用户报告 ChatGPT 连接器“Authentication succeeded, action discovery failed”。公开线上 OAuth metadata 通过 curl 返回 200 JSON，匿名 MCP POST 正确返回 401；GET /mcp 返回 404，属于传输协议缺陷。线上认证后的失败请求及 ChatGPT 详细错误尚未获得；不能仅凭本地修复认定这次线上故障已解决。

修复前本地新增验收发现：初始化通知返回 200 与无 result/error 的 JSON-RPC；GET 返回 404；非法 JSON 导致 500。旧官方 SDK 宽容这些响应，常规 OAuth 与工具测试通过未能暴露协议缺陷。旧服务也没有实现 2026-07-28 的 server/discover，不能接收使用新生命周期的客户端。

## 实现

- 保留 2025 版本 initialize / tools/list，旧协议请求与返回形状不变。
- 新增 2026-07-28 逐请求版本、客户端信息/能力与 server/discover；广告只列出实际实现的现代版本。
- 新协议成功返回 resultType: complete，发现/列表和读取使用 ttlMs: 0、cacheScope: private，不跨用户缓存。
- 共用既有领域工具；协议版本不改变身份、项目权限或调用约束。
- 现代 HTTP 必检协议版本、Mcp-Method、Mcp-Name 与请求体一致；名称支持 UTF-8 Base64 sentinel 解码。
- 旧客户端通知/响应空 202；不接受无 id 的工具调用作为通知执行。非法 JSON/信封返回机读 400。
- 不提供 GET SSE，明确返回 405 与 Allow，避免误报接口不存在。没有增加伪造会话或无认证工具发现路径。
- 未授权 MCP 返回 401 与正确 origin 的 WWW-Authenticate resource_metadata；校验 Origin；响应禁止共享缓存。

## 本地验收

`tests/e2e/17-mcp-discovery-transport.test.ts` 使用两代官方客户端：`@modelcontextprotocol/sdk` 1.x 与 `@modelcontextprotocol/client` 2.x。现代客户端强制 pin 2026-07-28，禁止悄悄回退旧 initialize 造成假通过。分别核验工具、提示模板、资源发现和机读错误。SDK 均为开发依赖，不进入 Worker 生产运行时。

本地验收不代表 ChatGPT 托管连接器验收。发布后还需刷新原连接器的动作列表并核对真实发现结果；若仍失败，应取得时间、MCP URL、MCP_ACTION_DISCOVERY_FAILED 的完整详情或已脱敏服务日志。已有连接器不会因为本地代码修改自动更新。不要通过删除 OAuth 客户端、重建项目或撤销用户全部凭据尝试修复发现错误。

## 官方依据

- [OpenAI 连接器排错](https://developers.openai.com/plugins/deploy/troubleshooting)
- [OpenAI MCP Server](https://developers.openai.com/plugins/build/mcp-server)
- [MCP 2026-07-28 Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [MCP 2026-07-28 HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2025-11-25 HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

## 发布与回退

本改动不需要修改项目/编排文档或素材。当前工作分支同时包含账号隔离与回收站及其 0004 迁移，不能直接全量发布并声称只有发现修复。若单独发布兼容补丁，应从当前线上 SHA 分离仅 MCP 传输/发现与相关测试、文档，再执行独立构建与发布验收；若合并发布，则执行账号功能既定的迁移与归属核对方案。此记录不代表发布已执行。

## ChatGPT 导入校验回归（2026-10-26）

已安装的 vflow 插件在管理页刷新工具时返回 HTTP 400，具体错误为 `mcp_validation: Invalid MCP tool schema for tool 'authoring_document_put'`。不能以通用 JSON Schema 编译通过或官方 SDK 能列举工具替代 ChatGPT 导入验收。

资料 Schema 中 `bounds` 使用固定四元素数字元组，Draft-07 导出为数组形式的 `items`。MCP 适配层现将固定、同构元组等价投影为对象形式的 `items`，保留 `minItems: 4`、`maxItems: 4` 及每项 0–1 约束。只影响 `authoring_document_put` / `reference_plan_validate` 的工具描述；协议 Schema、资源中的完整 Schema、REST 和领域校验保持原状。不同类型或非固定元组拒绝自动投影，必须明确设计兼容描述。

E2E17 通过 HTTP tools/list 检查全部工具数组项格式，并用 Schema 验证器对比投影前后的合法值、错误长度、错误类型及越界数字。发布后必须再次通过 ChatGPT 管理页“刷新工具”，并在插件详情中确认可用工具实际出现。

`motion_reference` and the `motion` request/evidence additions introduce no tuple-typed arrays, so the projection above is unchanged. E2E22 validates a real document against the resource schema and the projected `authoring_document_put` / `reference_plan_validate` schemas, checks the `generation_inputs_prepare` request and `generation_evidence_record` tool schemas, and asserts no `items` array anywhere in the tool list. The hosted ChatGPT "refresh tools" check remains a post-release verification.
