# 用户、明确共享与回收站

新项目默认私有。所有者由服务端已验证账号确定，客户端传入的 owner/user 字段不构成身份依据。编排、素材、角色、参考制作材料、历史、导入导出和媒体内容均继承项目访问权限；REST 与 MCP 使用同一领域权限检查。

## 身份与权限

浏览器 Access JWT 必须通过 RS256 签名、issuer、audience、有效期校验，不能仅信任 email 请求头或解码后的 JWT。Worker 需配置 `ACCESS_TEAM_DOMAIN` 和 `ACCESS_AUD`，本地测试可提供公开的 `ACCESS_JWKS_JSON`。无有效配置时拒绝浏览器身份，不降级为任意请求头。OAuth Agent 继承授权账号；服务令牌需在 `ALLOWED_SERVICE_TOKENS_JSON` 中显式绑定固定 `defaultActorId` 和 `ownerUserId`，`x-agent-id` 不改变身份。凭据不得写入代码或日志。

只有所有者能调整共享或删除/恢复整个项目。授权指定账号为 reader 或 writer 后，对方能访问项目内部资源。reader 不可写入或恢复；writer 可编辑并删除/恢复编排，但不能再次分享、调整成员或删除整个项目。撤销授权后，所有后续请求与幂等重放重新检查当前权限。共享设置有独立 `membershipRevision`，并发修改必须刷新后重试。

已有明确成员保留为共享关系；不会把已有授权静默删除。全库快照是受信任后端内部实现，不向用户暴露；D1 没有原生行级权限，隔离由每个领域入口和媒体读取路径负责。内部复合键使用 JSON 元组，避免用户构造分隔符 ID 跨项目碰撞。

## 退出与浏览器缓存

所有页面提供“退出登录”。`GET /logout` 清理本站 cache/storage 并跳转 `/cdn-cgi/access/logout`。这是 Cloudflare Access 的会话退出，可能影响同一 Access 团队的其他应用；若 IdP 登录仍有效，下次访问可能直接重新认证。它不自动撤销独立 OAuth Agent 连接。

`GET /v1/session` 返回已验证身份；API 与媒体响应设置 `Cache-Control: private, no-store` 及 Cookie/Authorization Vary，客户端请求也禁止缓存。恢复 bfcache 页面时先卸载私有内容并重新核验账号，账号变化重建页面状态。Access AJAX 失效响应按未登录处理。

## 删除与恢复

项目和编排的删除均为软删除，没有永久删除或自动清空。回收站只列出当前账号仍有权访问的记录。项目删除后，所有子资源的正常读写、媒体预览、历史、导出和 MCP 操作都不可用；不会删除 D1 历史或 R2 文件。恢复项目后，原先单独删除的编排仍在回收站，必须单独恢复。父项目未恢复时不能恢复子编排。被删除内容的历史引用仍保护素材，不能借删除绕过引用保护。

生命周期独立记录在 `resource_lifecycle`，不向不可变编排文档写入删除字段。每次删除/恢复提交 `baseRevision` 与 `operationId`；编排还需 `expectedHeadRevision`。冲突返回当前修订；失败原子回滚；同一内容重试返回原结果。恢复保留编排 head、分镜、选定输出与全部历史。

REST：

- `GET /v1/trash`
- `DELETE /v1/projects/:projectId`
- `POST /v1/projects/:projectId/restore`
- `DELETE /v1/projects/:projectId/compositions/:id`
- `POST /v1/projects/:projectId/compositions/:id/restore-from-trash`
- `PUT /v1/projects/:projectId/members/:actorId`，role 为 reader/writer/null（撤销）

MCP：`trash_list`、`resource_trash`、`resource_restore`、`project_member_set`。原有 composition_restore 仍指内容历史恢复，两种恢复不混用。

## 迁移与发布

增量迁移 `0004_ownership_recycle_bin.sql`：创建者为人类邮箱时归属该账号；Agent 创建且只有一个人类 writer 时归属该 writer；存在多个人类 writer 的歧义项目保持无归属，拒绝普通账号访问，需运营根据真实授权证据人工处理，不能让第一个访问者认领。已有明确成员授权继续保留。

发布前备份 D1 并确认真实 issuer/audience 与服务令牌账号映射，先迁移后发布 Worker；旧 Worker 不认识回收站，不能在发生软删除后直接回滚旧代码，否则可能重新暴露已删除内容。需要修复前进或部署保留生命周期检查的兼容版本。此文档不表示线上迁移已经执行。

## 验收证据

- `16-account-trash-isolation.test.ts`：私有/共享/撤销、reader/writer、假身份、MCP/HTTP、嵌套资源和媒体、跨项目 ID 碰撞、失败/冲突/重放、完整恢复、退出响应。
- `09-d1-r2-persistence-and-bootstrap.test.tsx`：所有权、共享、生命周期跨 Worker 实例持久化。
- `account-trash.spec.ts`：真实 Chromium 删除确认/失败重试、父子恢复、明确授权/撤销、只读界面和退出入口。测试不会退出真实用户的 Access 会话。
