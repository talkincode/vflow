# vflow

**让人和多个 AI Agent 一起做视频分镜的协作空间。**

你负责创意和审阅，Agent 负责生成素材和改分镜。vflow 管的是"这支视频该长什么样"：分镜、时间线、Prompt、角色设定、参考图和各版本素材，全部放在一个地方，谁改了什么都有记录。

vflow 不生成图片或视频，不渲染成片，也不负责发布。生成用你喜欢的工具，vflow 负责把结果有序地管起来。

## 特色

**分镜与时间线**
- 项目里可以有多个编排，共享同一批素材
- 每个镜头有稳定 ID、时长、Prompt、参考图、候选素材和最终选定的输出
- 镜头之间可以声明依赖，支持全局 BGM / 旁白轨

**角色与道具设定库**
- 角色、道具是独立对象，有定义、多视角参考图和外观变体
- 镜头会锁定某个设定版本，之后改设定不会悄悄改变已有镜头
- 新参考图先作为候选，批准后才成为正式版本

**多人和多 Agent 协作**
- 每次修改都基于一个版本，冲突会提示，不会互相覆盖
- 完整修订历史，可随时回看；Agent 的改动可以先作为提案，由你审阅后采纳
- 素材一旦入库就不可变，不会被悄悄替换

**统一接入**
- Web 工作台：看分镜、传素材、管设定、审提案
- MCP 和 REST 接口：Agent 用同一套能力读写项目
- 编排可导出为 JSON / YAML，格式有公开的 Schema

## 快速开始

```sh
npm ci
npm run typecheck && npm run lint && npm test
```

浏览器端到端测试：

```sh
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install --with-deps chromium
npm run test:browser
```

## 技术栈

TypeScript，运行在 Cloudflare Workers 上：Hono + MCP 提供接口，D1 存项目数据与修订，R2 存媒体，React + Vite 做前端，Cloudflare Access 负责登录保护。

## 文档

- [路线图与验收矩阵](docs/roadmap.md)
- [架构](docs/architecture.md)
- [部署](docs/deployment.md)
- [协议](docs/protocol.md)
- [角色与道具设定](docs/subjects.md)
- [参考制作规范](docs/reference-authoring.md)
- [账号与回收站](docs/accounts-and-trash.md)
- [MCP 兼容性](docs/mcp-discovery.md)
- [贡献与 Agent 规则](AGENTS.md)

## License

MIT
