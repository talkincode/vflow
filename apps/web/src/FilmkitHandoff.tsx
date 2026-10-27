import React, { useState } from "react";
import { inspectCompositionDelivery, type AssetManifestEntry, type CompositionDocument } from "@vflow/protocol";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function FilmkitHandoff({ document, revision, assets, assetsFailed, dirty, onChooseShot }: {
  document: CompositionDocument;
  revision: number;
  assets: readonly Pick<AssetManifestEntry, "id" | "mimeType">[];
  assetsFailed: boolean;
  dirty: boolean;
  onChooseShot: (id: string) => void;
}): React.ReactElement {
  const [mode, setMode] = useState("production");
  const [copyNotice, setCopyNotice] = useState("");
  const inspection = inspectCompositionDelivery(document, assets);
  const blocked = dirty || assetsFailed || (mode === "assemble" && !inspection.ready);
  const command = `vflow-pull pull --base ${quote(window.location.origin)} --project ${quote(document.project)} --composition ${quote(document.id)} --revision ${revision} --mode ${mode} --out ${quote(`./vflow-r${revision}/filmkit.yaml`)}`;
  return (
    <section className="subject-form" aria-label="filmkit 交接">
      <h3>交给 filmkit 继续制作</h3>
      <p>固定已保存的修订 #{revision}，下载并校验素材。不会执行生成、合成或回写项目。</p>
      <label>
        交接方式
        <select aria-label="filmkit 交接方式" value={mode} onChange={(event) => { setMode(event.target.value); setCopyNotice(""); }}>
          <option value="production">接着制作 · 保留参考，待补齐片段</option>
          <option value="assemble">按设计合成 · 固定时长，使用选定音视频</option>
        </select>
      </label>
      <p>{mode === "production"
        ? "沿用制作模式：时长为下限；全局音轨与选定音频不导入。参考下载不代表生成输入已审核，工具和参数仍需确认。"
        : "每镜须有确定时长及选定视频；选定音频替代片段原声。全局音轨保留时间范围，源裁切由本地 ffmpeg 节点完成，不循环补音乐。"}</p>
      <p>{document.sequence.length} 个镜头 · {document.audioTracks.length} 条全局音轨</p>
      {dirty && <p role="alert">请先保存或放弃草稿，交接只读取已保存版本。</p>}
      {assetsFailed ? <p role="alert">素材清单加载失败，请刷新后再检查交接。</p> : (
        <>
          <p>{inspection.ready ? "合成基础前提已齐备。" : `合成尚有 ${inspection.issues.length} 项待处理。`} 下游仍须校验文件、格式和内容，不表示视觉审阅通过。</p>
          {mode === "assemble" && <ul>{inspection.issues.map((issue) => <li key={issue.path}>
            {issue.shotId ? <button className="text-button" onClick={() => onChooseShot(issue.shotId!)}>{issue.shotId}</button> : <code>{issue.path}</code>}：{issue.message}
          </li>)}</ul>}
        </>
      )}
      {!blocked && <>
        <label>固定版本的拉取命令<textarea aria-label="filmkit 拉取命令" readOnly rows={4} value={command} /></label>
        <button onClick={() => {
          void (async () => {
            try { await navigator.clipboard.writeText(command); setCopyNotice("已复制拉取命令。"); }
            catch { setCopyNotice("无法访问剪贴板，请选择上方命令手动复制。"); }
          })();
        }}>复制拉取命令</button>
      </>}
      {copyNotice && <p role="status">{copyNotice}</p>}
      <p>需安装支持 --mode 的 vflow-pull。首次使用先通过 Cloudflare Access 登录，或使用已获项目授权的服务身份。目标文件存在时会拒绝覆盖，不要用 --force 当作增量更新。</p>
      <p>拉取后在输出目录运行 filmkit doctor、filmkit plan、filmkit storyboard；确认后执行待办，再运行 filmkit build。vflow 不执行这些命令。</p>
    </section>
  );
}
