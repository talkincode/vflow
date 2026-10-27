# 从 vflow 交接到 filmkit

vflow 管设计、素材及审阅；filmkit 在本地调用工具并合成。两者通过版本化编排导出和受权素材读取连接，不共享运行时，filmkit 不回写 vflow。

## 从工作台开始

打开编排的「协议」页，在「交给 filmkit 继续制作」选择：

- **接着制作**（`--mode production`，默认）：沿用原有导入行为，读取分镜、参考和已选视频；时长是下限，缺片段留为待办。全局音轨和选定音频不导入，会报告未取用项。
- **按设计合成**（`--mode assemble`）：每镜必须有明确时长和选定视频。使用 `exact` 时长、原播放顺序、硬切；选定音频替代片段原声，未选音频时保留片段原声。全局音轨按编排帧率换算时间范围。

页面检查镜头时长、选定媒体类型和音轨越界；可跳回缺少输出的镜头。未保存草稿或素材清单加载失败时不提供交接命令。命令固定当前已保存修订，目标为独立的 `vflow-r<revision>/filmkit.yaml`，同名文件已存在时拒绝覆盖。

这只是**合成基础前提检查**，不是媒体解码、视觉审阅或工具兼容认证。无字分镜、身份/环境参考和白模仍遵循各自审批与生成输入准备规则；下载参考不等于可以直接投喂模型。

## 本地操作

安装 filmkit 仓库中的 `tools/vflow/` 辅助 CLI（需要支持 `--mode` 的版本），完成 Cloudflare Access 登录或配置已获项目权限的服务身份。凭据不写进命令或项目。复制页面命令到本地运行，再进入输出目录：

```sh
filmkit doctor
filmkit plan
filmkit storyboard
```

按 `plan` 执行待办并核对分镜后运行 `filmkit build`。拉取本身不会执行任何生产工具。

全局音轨的 `trimStartFrame` 是**源文件内偏移**，不是时间线起点。assemble 为每条音轨生成普通的 `filmkit/ffmpeg` 音频节点，显式裁切源偏移和长度；短音频补静音，不自动循环。通过 `filmkit run <plan 中的节点 ID>` 执行，失败可以再次显式运行，不会调用生成模型。视频过长按 `exact` 裁切，过短定格末帧，CLI 明确提示这些行为。最终时间精度受 filmkit/ffmpeg 的时间换算及编码影响，不能把导入成功当成逐帧视觉验收。

使用离线导出时，`convert` 和 `fetch` 必须指定相同模式：

```sh
vflow-pull convert bundle.json --mode assemble --out filmkit.yaml
vflow-pull fetch bundle.json --mode assemble --dir .
```

## 兼容与安全

- 不修改 vflow/v1、vflow/v2 或 Film Schema，不增加数据库迁移、云端服务或模型依赖。
- `reader` 可导出、取素材；写入仍由 vflow 原有项目权限约束。
- 原 production 默认行为保留；assemble 是显式新增模式，不重新解释旧工程。
- 原始导出包保留固定依赖；assemble 仅下载合成所需媒体，候选与参考不自动选用，设计依赖不变成执行依赖。
- 不支持自动增量同步。`--force` 是覆盖授权，不是合并；有本地修改时导入新目录进行对照。
- 回滚只需恢复旧界面/桥接程序；原数据无迁移。不要用旧导入器覆盖新工程，旧版本不理解 `--mode` 时应明确拒绝。
- 精确生成输入包的本地适配、上游增量比较、结果交付清单仍是后续工作。

## 验收

vflow：`tests/e2e/25-filmkit-handoff.test.tsx`、`tests/browser/filmkit-handoff.spec.ts`。基础检查位于 `packages/protocol/src/delivery.ts`，纯读取，不修改输入。

filmkit：`tools/vflow/test/assemble.test.ts` 覆盖真实下载、源裁切 PCM 比对、时间线、ffmpeg 失败恢复及损坏下载回滚。`tools/vflow/test/motion-reference.test.ts` 覆盖同一帧位不同用途的关键帧，与 vflow 的 `momentFrame + purpose` 唯一性规则一致。

从 filmkit 仓库运行跨项目验收：

```sh
VFLOW_DIR=../vflow bun scripts/e2e-vflow-handoff.ts
```

脚本使用真实 vflow REST/领域层、默认 strict 项目、临时环回端口和合成媒体，测试两镜头带音轨的合成、reader/撤权、上游批准参考的兼容性。它不访问线上数据、不消费模型额度。浏览器验收可设置 `VFLOW_TEST_PORT`，避免占用或重置另一个本地测试实例。
