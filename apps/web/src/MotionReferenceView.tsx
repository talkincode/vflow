import React from "react";
import type { VFlowClient } from "@vflow/client";
import type { AssetRecord } from "@vflow/domain";
import type {
  GenerationEvidence,
  GenerationInputPacket,
  MotionReference,
} from "@vflow/protocol";
import { MediaPreview } from "./MediaPreview.tsx";

const purposeLabel: Record<string, string> = {
  camera_motion: "机位运动",
  blocking: "走位",
  action_timing: "动作时序",
  framing: "构图",
};
const seconds = (frames: number, fps: number): string =>
  (frames / fps).toFixed(2);

interface Common {
  client: VFlowClient;
  projectId: string;
  assets: AssetRecord[];
}

function Media({
  client,
  projectId,
  assets,
  id,
}: Common & { id: string }): React.ReactElement {
  const asset = assets.find((a) => a.id === id);
  return asset ? (
    <MediaPreview
      key={asset.id}
      asset={asset}
      url={client.assetContentUrl(projectId, asset.id)}
    />
  ) : (
    <p className="muted">素材 {id || "（未选择）"} 尚未登记在本项目</p>
  );
}

/**
 * Read-only viewer for an externally produced white-model motion reference.
 * It plays the uploaded video and lays out the pinned facts; it is not an editor
 * and never renders or interprets the archived source project.
 */
export function MotionReferenceView({
  doc,
  client,
  projectId,
  assets,
}: Common & { doc: MotionReference }): React.ReactElement {
  const source = assets.find((a) => a.id === doc.source.asset);
  const keyframes = [...doc.keyframes].sort(
    (a, b) => a.momentFrame - b.momentFrame,
  );
  return (
    <section
      className="motion-reference"
      data-testid="motion-reference"
      aria-label="白模动态参考预览"
    >
      <p>
        白模动态参考 · 镜头 {doc.shotId} · 编排 {doc.compositionId}@
        {doc.compositionRevision} · 场景 {doc.scene.id}@{doc.scene.revision}/
        {doc.environmentVariant}
      </p>
      <p>
        {doc.fps} fps · {doc.durationFrames} 帧（
        {seconds(doc.durationFrames, doc.fps)} 秒，第 0 帧对齐镜头起点）· 用途：
        {doc.usage.map((u) => purposeLabel[u] ?? u).join("、")}
      </p>
      <p className="muted">
        只提供机位运动、走位和动作时序证据。它不是身份、服装或环境参考图，也不会自动成为首帧或尾帧。
        审阅：
        {doc.review
          ? `${doc.review.decision} · ${doc.review.reviewer}`
          : "尚未审阅（请完整播放后逐项检查）"}
      </p>
      <div className="motion-reference-stage">
        <figure data-testid="motion-video">
          <Media
            client={client}
            projectId={projectId}
            assets={assets}
            id={doc.video.asset}
          />
          <figcaption>白模视频 · {doc.video.asset}</figcaption>
        </figure>
        <figure data-testid="motion-overview">
          <Media
            client={client}
            projectId={projectId}
            assets={assets}
            id={doc.overview.asset}
          />
          <figcaption>总览静帧 · {doc.overview.asset}</figcaption>
        </figure>
      </div>
      <h4>关键帧</h4>
      <ol className="motion-keyframes" data-testid="motion-keyframes">
        {keyframes.map((k) => (
          <li key={k.id}>
            <Media
              client={client}
              projectId={projectId}
              assets={assets}
              id={k.asset}
            />
            <strong>{k.id}</strong>
            <span>
              第 {k.momentFrame} 帧（{seconds(k.momentFrame, doc.fps)} 秒）·{" "}
              {purposeLabel[k.purpose] ?? k.purpose}
            </span>
            {k.note && <small>{k.note}</small>}
          </li>
        ))}
      </ol>
      <p>
        主体：
        {doc.subjects.length
          ? doc.subjects
              .map((s) => `${s.id}@${s.revision}/${s.variant}`)
              .join("、")
          : "无"}
      </p>
      <p>
        归档工程：
        {source ? (
          <a
            href={client.assetContentUrl(projectId, source.id)}
            target="_blank"
            rel="noreferrer"
          >
            下载 {source.id}
          </a>
        ) : (
          doc.source.asset
        )}
        （仅存档，永不作为生成输入；vflow 不打开或渲染它）
      </p>
      <details>
        <summary>来源与制作说明（自由文本）</summary>
        <p>{doc.provenance}</p>
      </details>
    </section>
  );
}

/** Exact motion input a prepared packet will deliver, or an evidence report's planned/actual motion. */
export function MotionPacketView({
  motion,
  client,
  projectId,
  assets,
}: Common & {
  motion: NonNullable<GenerationInputPacket["motion"]>;
}): React.ReactElement {
  return (
    <div className="motion-packet" data-testid="generation-motion">
      <p>
        白模动态输入 · {motion.reference.id}@{motion.reference.revision} ·{" "}
        {motion.delivery === "video"
          ? "整段视频"
          : "显式降级：仅发送所选关键帧（整段视频不会发送）"}{" "}
        · {motion.fps} fps · {motion.durationFrames} 帧
      </p>
      <p className="muted">
        用途：{motion.usage.map((u) => purposeLabel[u] ?? u).join("、")} ·
        场景 {motion.scene.id}@{motion.scene.revision}/
        {motion.environmentVariant} · 内容 {motion.contentHash}
      </p>
      {motion.video && (
        <article>
          <Media
            client={client}
            projectId={projectId}
            assets={assets}
            id={motion.video.asset}
          />
          <p>视频 · {motion.video.asset}</p>
          <small>{motion.video.sha256}</small>
        </article>
      )}
      {motion.keyframes && (
        <div className="packet-images">
          {motion.keyframes.map((k) => (
            <article key={k.id}>
              <Media
                client={client}
                projectId={projectId}
                assets={assets}
                id={k.asset}
              />
              <p>
                {k.id} · 第 {k.momentFrame} 帧 · {purposeLabel[k.purpose]}
              </p>
              <small>{k.sha256}</small>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/** What an external run reported actually using, next to what was planned. */
export function ActualMotionView({
  actual,
  report,
}: {
  actual: GenerationEvidence["actualMotion"];
  report: GenerationEvidence;
}): React.ReactElement {
  const planned = report.packet.motion;
  return (
    <p data-testid="evidence-motion">
      白模输入：计划{" "}
      {planned
        ? planned.delivery === "video"
          ? "整段视频"
          : `${planned.keyframes?.length ?? 0} 个关键帧`
        : "未使用"}{" "}
      · 回报{" "}
      {actual
        ? actual.delivery === "video"
          ? "整段视频"
          : `${actual.keyframes?.length ?? 0} 个关键帧`
        : "未回报"}
    </p>
  );
}
