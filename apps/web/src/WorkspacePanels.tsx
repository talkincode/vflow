import type { VideoComposeClient } from "@video-compose/client";
import type {
  AssetRecord,
  SubjectRecord,
  TypedOperation,
} from "@video-compose/domain";
import type {
  CompositionDocument,
  ShotDefinition,
  SubjectKind,
} from "@video-compose/protocol";
import React, { useState } from "react";
import { MediaPreview } from "./MediaPreview.tsx";
import type { WorkbenchViewMode } from "./Workbench.tsx";

type Runner = (operation: () => Promise<void>) => Promise<void>;
type Patcher = (operations: TypedOperation[], message: string) => Promise<void>;
interface LibraryProps {
  client: VideoComposeClient;
  projectId: string;
  activeShotId: string | null;
  activeShot?: ShotDefinition;
  assets: AssetRecord[];
  disabled: boolean;
  onRefresh: () => Promise<void>;
  run: Runner;
  patch: Patcher;
}
export function shotPreview(
  shot: ShotDefinition,
  assets: AssetRecord[],
): { asset?: AssetRecord; label: string } {
  const selected = shot.selected.video ?? shot.selected.audio;
  const candidate =
    shot.candidates.images[0]?.asset ??
    shot.candidates.videos[0]?.asset ??
    shot.candidates.audios[0]?.asset;
  const reference =
    shot.references.images[0]?.asset ?? shot.references.videos[0]?.asset;
  return {
    asset: assets.find(
      (asset) => asset.id === (selected ?? candidate ?? reference),
    ),
    label: selected
      ? "已选用输出"
      : candidate
        ? "候选素材 · 尚未选用"
        : reference
          ? "参考素材"
          : "尚未添加素材",
  };
}

export function AssetLibrary({
  client,
  projectId,
  activeShotId,
  activeShot,
  assets,
  failed,
  active,
  disabled,
  onRefresh,
  run,
  patch,
}: LibraryProps & { failed: boolean; active: boolean }): React.ReactElement {
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const upload = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    await client.uploadAsset({
      projectId,
      assetId: `asset-${crypto.randomUUID()}`,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mimeType: file.type || "application/octet-stream",
    });
    await onRefresh();
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">项目共享素材</span>
          <h2>
            素材库 <span>{assets.length}</span>
          </h2>
        </div>
        <label className={`upload-button ${disabled ? "disabled" : ""}`}>
          ＋ 上传素材
          <input
            type="file"
            accept="image/*,video/*,audio/*"
            aria-label="上传素材"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              void run(() => upload(file));
            }}
          />
        </label>
      </div>
      <div className="filter-toolbar">
        <input
          type="search"
          aria-label="搜索素材"
          placeholder="搜索素材编号"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          aria-label="素材类型"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">全部类型</option>
          <option value="image/">图片</option>
          <option value="video/">视频</option>
          <option value="audio/">音频</option>
        </select>
      </div>
      {failed ? (
        <div role="alert">
          素材加载失败。
          <button onClick={() => void onRefresh()}>重新加载素材</button>
        </div>
      ) : !assets.length ? (
        <p className="empty-state">上传参考素材，或由 Agent 向项目交付素材。</p>
      ) : (
        <div className="asset-grid">
          {assets
            .filter(
              (asset) =>
                (filter === "all" || asset.mimeType.startsWith(filter)) &&
                asset.id.toLowerCase().includes(query.toLowerCase()),
            )
            .map((asset) => {
              const isImage = asset.mimeType.startsWith("image/");
              const isVideo = asset.mimeType.startsWith("video/");
              const isAudio = asset.mimeType.startsWith("audio/");
              const isMedia = isImage || isVideo || isAudio;
              const isAttachedImage = Boolean(
                activeShot?.candidates.images.some((c) => c.asset === asset.id),
              );
              const isAttachedVideo = Boolean(
                activeShot?.candidates.videos.some((c) => c.asset === asset.id),
              );
              const isAttachedAudio = Boolean(
                activeShot?.candidates.audios.some((c) => c.asset === asset.id),
              );
              const isAttached =
                isAttachedImage || isAttachedVideo || isAttachedAudio;
              const candidateImageCount =
                activeShot?.candidates.images.length ?? 0;

              return (
                <article
                  className="asset-card"
                  key={asset.id}
                  data-testid={`asset-card-${asset.id}`}
                >
                  {active && (
                    <MediaPreview
                      key={asset.id}
                      asset={asset}
                      url={client.assetContentUrl(projectId, asset.id)}
                    />
                  )}
                  <div className="asset-card-content">
                    <strong>{asset.id}</strong>
                    <span>
                      {asset.mimeType} · {(asset.sizeBytes / 1024).toFixed(1)} KB
                    </span>
                    {activeShotId && isMedia && (
                      isAttached ? (
                        <button
                          className="secondary"
                          disabled={disabled}
                          data-testid={`detach-candidate-${asset.id}`}
                          onClick={() =>
                            void run(() =>
                              patch(
                                [
                                  {
                                    op: "detach_shot_candidate",
                                    shotId: activeShotId,
                                    mediaKind: isAttachedImage
                                      ? "images"
                                      : isAttachedVideo
                                        ? "videos"
                                        : "audios",
                                    assetId: asset.id,
                                  },
                                ],
                                `从 ${activeShotId} 移除素材 ${asset.id}`,
                              ),
                            )
                          }
                        >
                          从当前镜头移除
                        </button>
                      ) : isImage && candidateImageCount >= 5 ? (
                        <button
                          disabled={true}
                          data-testid={`attach-candidate-${asset.id}`}
                          title="当前镜头已达最多 5 个素材图上限"
                        >
                          关联至当前镜头 (已达 5 张上限)
                        </button>
                      ) : (
                        <button
                          disabled={disabled}
                          data-testid={`attach-candidate-${asset.id}`}
                          onClick={() =>
                            void run(() =>
                              patch(
                                [
                                  {
                                    op: "attach_shot_candidate",
                                    shotId: activeShotId,
                                    mediaKind: isImage
                                      ? "images"
                                      : isVideo
                                        ? "videos"
                                        : "audios",
                                    candidate: { asset: asset.id },
                                  },
                                ],
                                `添加 ${asset.id} 为 ${activeShotId} 候选素材`,
                              ),
                            )
                          }
                        >
                          {isImage
                            ? `关联至当前镜头 (${candidateImageCount}/5)`
                            : "关联至当前镜头的候选集"}
                        </button>
                      )
                    )}
                    {activeShotId && /^(video|audio)\//.test(asset.mimeType) && (
                      <button
                        disabled={disabled}
                        onClick={() =>
                          void run(() =>
                            patch(
                              [
                                {
                                  op: "select_shot_output",
                                  shotId: activeShotId,
                                  mediaKind: asset.mimeType.startsWith("video/")
                                    ? "video"
                                    : "audio",
                                  assetId: asset.id,
                                },
                              ],
                              `为 ${activeShotId} 选用 ${asset.id}`,
                            ),
                          )
                        }
                      >
                        选用为当前镜头输出
                      </button>
                    )}
                    <button
                      className="danger"
                      disabled={disabled}
                      data-testid={`delete-asset-${asset.id}`}
                      onClick={() =>
                        void run(async () => {
                          let confirmDelete = true;
                          try {
                            if (
                              typeof window !== "undefined" &&
                              typeof window.confirm === "function"
                            ) {
                              confirmDelete = window.confirm(
                                `确定要从项目中删除素材 ${asset.id} 吗？`,
                              );
                            }
                          } catch {
                            confirmDelete = true;
                          }
                          if (!confirmDelete) return;
                          await client.deleteAsset(projectId, asset.id);
                          await onRefresh();
                        })
                      }
                    >
                      删除素材
                    </button>
                    <details>
                      <summary>文件详情</summary>
                      <code>SHA-256 {asset.sha256}</code>
                    </details>
                  </div>
                </article>
              );
            })}
        </div>
      )}
    </>
  );
}

export function SubjectLibrary({
  client,
  projectId,
  activeShotId,
  assets,
  subjects,
  disabled,
  onRefresh,
  run,
  patch,
}: LibraryProps & { subjects: SubjectRecord[] }): React.ReactElement {
  const [filter, setFilter] = useState("all");
  const [newForm, setNewForm] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SubjectKind>("character");
  const [description, setDescription] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const create = async (): Promise<void> => {
    if (!name.trim() || !references.length)
      throw new Error("填写设定名称，并选择至少一张参考图。");
    await client.createSubject({
      projectId,
      id: `${kind}-${crypto.randomUUID().slice(0, 8)}`,
      name: name.trim(),
      kind,
      status: "candidate",
      defaultVariant: "default",
      definition: {
        description: description.trim() || name.trim(),
        invariants: [],
      },
      variants: {
        default: {
          description: "默认造型",
          referencePack: references.map((asset) => ({
            asset,
            status: "candidate",
          })),
        },
      },
    });
    setNewForm(false);
    setName("");
    setDescription("");
    setReferences([]);
    await onRefresh();
  };
  return (
    <div data-testid="subject-library">
      <div className="page-heading">
        <div>
          <span className="eyebrow">跨镜头的一致性依据</span>
          <h2>角色与道具</h2>
        </div>
        <button disabled={disabled} onClick={() => setNewForm(!newForm)}>
          {newForm ? "取消新建" : "+ 新建设定"}
        </button>
      </div>
      <div className="filter-toolbar">
        {(
          [
            ["all", "全部"],
            ["character", "角色"],
            ["prop", "道具"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            data-testid={`filter-${value}`}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {newForm && (
        <form
          className="subject-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(create);
          }}
        >
          <h3>创建候选设定</h3>
          <fieldset disabled={disabled}>
            <label htmlFor="new-subject-name">设定名称</label>
            <input
              id="new-subject-name"
              required
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <label htmlFor="new-subject-kind">类型</label>
            <select
              id="new-subject-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value as SubjectKind)}
            >
              <option value="character">角色</option>
              <option value="prop">道具</option>
            </select>
            <label htmlFor="new-subject-description">视觉设定描述</label>
            <textarea
              id="new-subject-description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
            <span>选择参考图（至少一张）</span>
            <div className="reference-picker">
              {assets
                .filter((asset) => asset.mimeType.startsWith("image/"))
                .map((asset) => (
                  <label key={asset.id}>
                    <input
                      type="checkbox"
                      checked={references.includes(asset.id)}
                      onChange={() =>
                        setReferences((previous) =>
                          previous.includes(asset.id)
                            ? previous.filter((id) => id !== asset.id)
                            : [...previous, asset.id],
                        )
                      }
                    />
                    {asset.id}
                  </label>
                ))}
            </div>
            {!assets.some((asset) => asset.mimeType.startsWith("image/")) && (
              <p>请先在素材库上传参考图。</p>
            )}
            <button
              className="primary"
              type="submit"
              disabled={!name.trim() || !references.length}
            >
              创建候选设定
            </button>
          </fieldset>
        </form>
      )}
      <div className="subject-grid">
        {subjects
          .filter((subject) => filter === "all" || subject.kind === filter)
          .map((subject) => (
            <SubjectCard
              key={subject.id}
              subject={subject}
              assets={assets}
              contentUrl={(asset) =>
                client.assetContentUrl(projectId, asset.id)
              }
              activeShotId={activeShotId}
              disabled={disabled}
              onApprove={(revision) =>
                void run(async () => {
                  await client.approveSubjectRevision({
                    projectId,
                    subjectId: subject.id,
                    revision,
                    operationId: crypto.randomUUID(),
                  });
                  await onRefresh();
                })
              }
              onBind={(revision, variant) =>
                void run(async () => {
                  if (!activeShotId) return;
                  await patch(
                    [
                      {
                        op: "bind_shot_subject",
                        shotId: activeShotId,
                        binding: {
                          subjectId: subject.id,
                          subjectRevision: revision,
                          variant,
                        },
                      },
                    ],
                    `绑定 ${subject.id}@v${revision} 至 ${activeShotId}`,
                  );
                })
              }
            />
          ))}
      </div>
    </div>
  );
}
function SubjectCard({
  subject,
  assets,
  contentUrl,
  activeShotId,
  disabled,
  onApprove,
  onBind,
}: {
  subject: SubjectRecord;
  assets: AssetRecord[];
  contentUrl: (asset: AssetRecord) => string;
  activeShotId: string | null;
  disabled: boolean;
  onApprove: (revision: number) => void;
  onBind: (revision: number, variant: string) => void;
}): React.ReactElement {
  const [revision, setRevision] = useState(subject.latestRevision);
  const snapshot =
    subject.revisions[revision] ?? subject.revisions[subject.latestRevision];
  const [variant, setVariant] = useState(
    snapshot.defaultVariant ?? Object.keys(snapshot.variants)[0],
  );
  const currentVariant = snapshot.variants[variant]
    ? variant
    : (snapshot.defaultVariant ?? Object.keys(snapshot.variants)[0]);
  return (
    <article
      className="subject-card"
      data-testid={`library-subject-${subject.id}`}
    >
      <div className="subject-card-heading">
        <h3>{subject.name}</h3>
        <span className="badge">
          {subject.kind === "character" ? "角色" : "道具"} ·{" "}
          {snapshot.status === "approved" ? "已批准" : "候选中"}
        </span>
      </div>
      <p>{snapshot.definition.description}</p>
      <div className="filter-toolbar">
        <label>
          版本
          <select
            aria-label={`${subject.name}设定版本`}
            value={snapshot.revision}
            onChange={(event) => setRevision(Number(event.target.value))}
          >
            {Object.values(subject.revisions).map((value) => (
              <option key={value.revision} value={value.revision}>
                v{value.revision} ·{" "}
                {value.status === "approved" ? "已批准" : "候选中"}
              </option>
            ))}
          </select>
        </label>
        <label>
          造型
          <select
            aria-label={`${subject.name}造型`}
            value={currentVariant}
            onChange={(event) => setVariant(event.target.value)}
          >
            {Object.keys(snapshot.variants).map((key) => (
              <option key={key}>{key}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="reference-thumbnails">
        {snapshot.variants[currentVariant]?.referencePack.map((reference) => {
          const asset = assets.find((item) => item.id === reference.asset);
          return asset ? (
            <MediaPreview
              compact
              key={asset.id}
              asset={asset}
              url={contentUrl(asset)}
            />
          ) : (
            <span key={reference.asset}>参考素材暂不可用</span>
          );
        })}
      </div>
      <p className="subject-invariants">
        {snapshot.definition.invariants.join(" · ")}
      </p>
      {snapshot.status === "candidate" ? (
        <button
          disabled={disabled}
          onClick={() => onApprove(snapshot.revision)}
        >
          批准此版本与参考图
        </button>
      ) : (
        <button
          disabled={disabled || !activeShotId}
          onClick={() => onBind(snapshot.revision, currentVariant)}
        >
          绑定至 {activeShotId ?? "当前镜头"}
        </button>
      )}
    </article>
  );
}

export function ShotOverview({
  document,
  visibleShots,
  activeShotId,
  viewMode,
  onView,
  onChoose,
  assets,
  contentUrl,
  onMove,
  canMove,
}: {
  document: CompositionDocument;
  visibleShots: { id: string; shot: ShotDefinition; index: number }[];
  activeShotId: string | null;
  viewMode: WorkbenchViewMode;
  onView: (view: WorkbenchViewMode) => void;
  onChoose: (id: string) => void;
  assets: AssetRecord[];
  contentUrl: (asset: AssetRecord) => string;
  onMove: (direction: -1 | 1) => void;
  canMove: boolean;
}): React.ReactElement {
  const fps = document.format.fps;
  const activeIndex = activeShotId
    ? document.sequence.indexOf(activeShotId)
    : -1;
  return (
    <section className="overview">
      <div className="overview-heading">
        <h2>
          分镜总览 <span>{document.sequence.length}</span>
        </h2>
        <div className="view-switcher" aria-label="分镜视图">
          {(
            [
              ["grid", "分镜网格"],
              ["list", "编排清单"],
              ["topology", "依赖关系"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              aria-pressed={viewMode === value}
              data-testid={`tab-${value}`}
              onClick={() => onView(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar">
          <button
            disabled={!canMove || activeIndex <= 0}
            onClick={() => onMove(-1)}
          >
            当前镜头前移
          </button>
          <button
            disabled={!canMove || activeIndex >= document.sequence.length - 1}
            onClick={() => onMove(1)}
          >
            后移
          </button>
        </div>
      </div>
      <div data-testid={`view-${viewMode}`}>
        {viewMode === "grid" && (
          <div className="shot-grid" aria-label="分镜网格">
            {visibleShots.map(({ id, shot, index }) => {
              const preview = shotPreview(shot, assets);
              return (
                <article
                  className={`shot-card ${id === activeShotId ? "selected" : ""}`}
                  key={id}
                >
                  <button
                    className="shot-card-button"
                    data-testid={`grid-shot-${id}`}
                    onClick={() => onChoose(id)}
                    aria-label={`编辑 ${id}`}
                  >
                    <div className="card-preview">
                      {preview.asset ? (
                        <MediaPreview
                          compact
                          key={preview.asset.id}
                          asset={preview.asset}
                          url={contentUrl(preview.asset)}
                        />
                      ) : (
                        <span className="no-media">尚无画面</span>
                      )}
                      <span className="card-index">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                    </div>
                    <div className="card-body">
                      <strong data-testid={`shot-desc-${id}`}>
                        {shot.description}
                      </strong>
                      <span>
                        {id} · {((shot.durationFrames ?? 0) / fps).toFixed(1)}{" "}
                        秒
                      </span>
                      <span className="card-media-label">{preview.label}</span>
                    </div>
                  </button>
                  <ul
                    className="subject-tags"
                    data-testid={`shot-subjects-${id}`}
                  >
                    {shot.subjects.map((binding) => (
                      <li
                        key={`${binding.subjectId}@${binding.subjectRevision}`}
                      >
                        {binding.subjectId}@v{binding.subjectRevision}
                      </li>
                    ))}
                  </ul>
                </article>
              );
            })}
          </div>
        )}
        {viewMode === "list" && (
          <>
            <div data-testid="manifest-audio-tracks">
              <h3>全局音轨</h3>
              {document.audioTracks.length ? (
                document.audioTracks.map((track) => {
                  const asset = assets.find((item) => item.id === track.asset);
                  return (
                    <div
                      className="audio-track"
                      key={track.id}
                      data-testid={`audio-track-${track.id}`}
                    >
                      <strong>
                        {track.id} · {track.role}
                      </strong>
                      <span>
                        {track.asset} · {(track.startFrame / fps).toFixed(1)}–
                        {(
                          (track.startFrame + track.durationFrames) /
                          fps
                        ).toFixed(1)}{" "}
                        秒
                      </span>
                      {asset && (
                        <MediaPreview
                          key={asset.id}
                          asset={asset}
                          url={contentUrl(asset)}
                        />
                      )}
                    </div>
                  );
                })
              ) : (
                <p className="empty-state">尚未添加背景音乐或旁白</p>
              )}
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>序号</th>
                    <th>镜头</th>
                    <th>时长</th>
                    <th>角色与道具</th>
                    <th>前序依赖</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleShots.map(({ id, shot, index }) => (
                    <tr
                      className={id === activeShotId ? "selected" : ""}
                      key={id}
                      data-testid={`list-shot-${id}`}
                    >
                      <td>{index + 1}</td>
                      <td>
                        <button
                          className="text-button"
                          onClick={() => onChoose(id)}
                        >
                          <strong data-testid={`shot-desc-${id}`}>
                            {shot.description}
                          </strong>
                          <small>{id}</small>
                        </button>
                      </td>
                      <td>
                        {((shot.durationFrames ?? 0) / fps).toFixed(1)} 秒
                      </td>
                      <td>
                        {shot.subjects
                          .map(
                            (binding) =>
                              `${binding.subjectId}@v${binding.subjectRevision}`,
                          )
                          .join("、") || "—"}
                      </td>
                      <td>
                        {shot.dependsOn
                          .map((dependency) => dependency.shotId)
                          .join("、") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {viewMode === "topology" && (
          <div className="relationship-list" aria-label="镜头依赖关系">
            <ul data-testid="topology-nodes">
              {visibleShots.map(({ id, shot }) => (
                <li key={id} data-testid={`topology-shot-${id}`}>
                  <button onClick={() => onChoose(id)}>
                    <strong>{id}</strong>
                    <span data-testid={`shot-desc-${id}`}>
                      {shot.description}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <ul data-testid="topology-edges">
              {visibleShots.flatMap(({ id, shot }) =>
                shot.dependsOn.map((dependency) => (
                  <li
                    key={`${dependency.shotId}-${id}`}
                    data-testid={`edge-${dependency.shotId}-${id}`}
                  >
                    <button onClick={() => onChoose(dependency.shotId)}>
                      {dependency.shotId}
                    </button>
                    <span>
                      →{" "}
                      {dependency.kind === "continuity"
                        ? "画面连贯"
                        : dependency.kind === "last_frame"
                          ? "末帧参考"
                          : dependency.kind === "narrative"
                            ? "叙事依赖"
                            : "素材参考"}{" "}
                      →
                    </span>
                    <button onClick={() => onChoose(id)}>{id}</button>
                    <span className="sr-only">{dependency.kind}</span>
                  </li>
                )),
              )}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
