import type { AssetRecord } from "@vflow/domain";
import React, { useState } from "react";

export function MediaPreview({
  asset,
  url,
  compact = false,
}: {
  asset: AssetRecord;
  url: string;
  compact?: boolean;
}): React.ReactElement {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const image = /^image\/(png|jpeg|gif|webp|avif)$/.test(asset.mimeType);
  const video = asset.mimeType.startsWith("video/");
  const audio = asset.mimeType.startsWith("audio/");
  const source = attempt ? `${url}?retry=${attempt}` : url;
  const retry = (): void => {
    setFailed(false);
    setLoaded(false);
    setAttempt((n) => n + 1);
  };
  if (failed)
    return compact ? (
      <span className="media-fallback">预览暂不可用</span>
    ) : (
      <div className="media-fallback" role="status">
        <span>素材加载失败或格式不受支持</span>
        <button type="button" onClick={retry}>
          重试预览
        </button>
        <a href={url} target="_blank" rel="noreferrer">
          打开原文件
        </a>
      </div>
    );
  return (
    <div
      className={`media-preview ${compact ? "compact" : ""}`}
      data-testid={`media-${asset.id}`}
    >
      {image ? (
        <>
          <img
            src={source}
            alt={asset.id}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
            <a
              className="media-expand"
              href={url}
              target="_blank"
              rel="noreferrer"
              aria-label={`查看原图 ${asset.id}`}
            >
              查看原图 ↗
            </a>
        </>
      ) : video ? (
        compact ? (
          <div className="media-type-mark">
            ▶ 视频<span>点击镜头查看与播放</span>
          </div>
        ) : (
          <video
            src={source}
            controls
            playsInline
            preload="metadata"
            aria-label={`播放 ${asset.id}`}
            onLoadedMetadata={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        )
      ) : audio ? (
        compact ? (
          <div className="media-type-mark">♫ 音频</div>
        ) : (
          <audio
            src={source}
            controls
            preload="metadata"
            aria-label={`试听 ${asset.id}`}
            onLoadedMetadata={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        )
      ) : compact ? (
        <span className="media-type-mark">文件</span>
      ) : (
        <a href={url} target="_blank" rel="noreferrer">
          下载原文件 · {asset.mimeType}
        </a>
      )}
      {!compact && (image || video || audio) && !loaded && (
        <span className="media-loading" role="status">
          正在载入素材…
        </span>
      )}
    </div>
  );
}
