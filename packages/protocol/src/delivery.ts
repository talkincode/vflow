import type { AssetManifestEntry, CompositionDocument } from "./types.ts";

export interface DeliveryIssue {
  path: string;
  message: string;
  shotId?: string;
}

/** Structural prerequisites only: not media decoding, visual approval, or a target-tool capability check. */
export function inspectCompositionDelivery(
  document: CompositionDocument,
  assets: readonly Pick<AssetManifestEntry, "id" | "mimeType">[],
): { ready: boolean; totalFrames: number; issues: DeliveryIssue[] } {
  const issues: DeliveryIssue[] = [];
  const library = new Map(assets.map((asset) => [asset.id, asset]));
  let totalFrames = 0;
  const media = (id: string | null, kind: "video" | "audio", path: string, shotId?: string): void => {
    if (!id || !library.get(id)?.mimeType.startsWith(`${kind}/`))
      issues.push({ path, message: kind === "video" ? "请选择可用的最终视频。" : "选定音频不存在或类型不正确。", ...(shotId ? { shotId } : {}) });
  };
  if (!document.sequence.length) issues.push({ path: "sequence", message: "请先添加镜头。" });
  for (const shotId of document.sequence) {
    const shot = document.shots[shotId];
    if (!shot) {
      issues.push({ path: `shots.${shotId}`, shotId, message: "镜头不存在。" });
      continue;
    }
    if (!Number.isSafeInteger(shot.durationFrames) || (shot.durationFrames ?? 0) <= 0)
      issues.push({ path: `shots.${shotId}.durationFrames`, shotId, message: "请确定镜头时长。" });
    else totalFrames += shot.durationFrames!;
    media(shot.selected.video, "video", `shots.${shotId}.selected.video`, shotId);
    if (shot.selected.audio) media(shot.selected.audio, "audio", `shots.${shotId}.selected.audio`, shotId);
  }
  for (const [index, track] of document.audioTracks.entries()) {
    media(track.asset, "audio", `audioTracks[${index}].asset`);
    if (track.startFrame + track.durationFrames > totalFrames)
      issues.push({ path: `audioTracks[${index}]`, message: `音轨 ${track.id} 超出编排总时长。` });
  }
  return { ready: issues.length === 0, totalFrames, issues };
}
