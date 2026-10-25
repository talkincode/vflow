import type { VideoComposeClient } from "@video-compose/client";
import {
  type AssetRecord,
  type CompositionRevisionRecord,
  DomainError,
  type SubjectRecord,
  type TypedOperation,
} from "@video-compose/domain";
import {
  PROTOCOL_VERSION,
  type ShotDefinition,
  serializeCompositionYaml,
} from "@video-compose/protocol";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { AccountMenu } from "./AccountMenu.tsx";
import { MediaPreview } from "./MediaPreview.tsx";
import {
  AssetLibrary,
  SubjectLibrary,
  ShotOverview,
  shotPreview,
} from "./WorkspacePanels.tsx";

const AuthoringPanel = React.lazy(() =>
  import("./AuthoringPanel.tsx").then((module) => ({
    default: module.AuthoringPanel,
  })),
);

export type WorkbenchViewMode = "grid" | "list" | "topology";
export interface WorkbenchProps {
  client: VideoComposeClient;
  projectId: string;
  compositionId: string;
  initialView?: WorkbenchViewMode;
  navigation?: React.ReactNode;
  allowBootstrap?: boolean;
}
type CompositionData = Awaited<
  ReturnType<VideoComposeClient["getComposition"]>
>;
type WorkspaceTab =
  "shots" | "assets" | "subjects" | "authoring" | "history" | "source";
interface ShotDraft {
  description: string;
  duration: string;
  image: string;
  video: string;
  baseRevision: number;
  original: ShotDefinition;
  operationId: string;
}
interface UndoEntry {
  shotId: string;
  before: ShotDefinition;
  after: ShotDefinition;
  fields: Extract<TypedOperation, { op: "update_shot_fields" }>;
}
export const newOperationId = (): string => crypto.randomUUID();
const messageOf = (error: unknown): string =>
  error instanceof DomainError && error.code === "REVISION_CONFLICT"
    ? `分镜修改发生冲突，草稿已保留。请对照最新版本后处理。${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
const emptyShot = (): ShotDefinition => ({
  description: "未命名分镜",
  durationFrames: 90,
  subjects: [],
  dependsOn: [],
  references: { images: [], videos: [] },
  prompts: {},
  candidates: { images: [], videos: [], audios: [] },
  selected: { video: null, audio: null },
});
const draftFor = (shot: ShotDefinition, revision: number): ShotDraft => ({
  description: shot.description,
  duration: String(shot.durationFrames ?? 90),
  image: shot.prompts.image ?? "",
  video: shot.prompts.video ?? "",
  original: shot,
  baseRevision: revision,
  operationId: newOperationId(),
});
function changedFields(
  draft: ShotDraft,
): Extract<TypedOperation, { op: "update_shot_fields" }> {
  return {
    op: "update_shot_fields",
    shotId: "",
    ...(draft.description !== draft.original.description
      ? { description: draft.description }
      : {}),
    ...(Number(draft.duration) !== (draft.original.durationFrames ?? 90)
      ? { durationFrames: Number(draft.duration) }
      : {}),
    ...(draft.image !== (draft.original.prompts.image ?? "") ||
    draft.video !== (draft.original.prompts.video ?? "")
      ? {
          prompts: {
            ...(draft.image !== (draft.original.prompts.image ?? "")
              ? { image: draft.image }
              : {}),
            ...(draft.video !== (draft.original.prompts.video ?? "")
              ? { video: draft.video }
              : {}),
          },
        }
      : {}),
  };
}
const isDirty = (draft: ShotDraft): boolean =>
  Object.keys(changedFields(draft)).length > 2;

export function Workbench({
  client,
  projectId,
  compositionId,
  initialView = "grid",
  navigation,
  allowBootstrap = true,
}: WorkbenchProps): React.ReactElement {
  const [data, setData] = useState<CompositionData | null>(null);
  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [history, setHistory] = useState<CompositionRevisionRecord[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [bootstrap, setBootstrap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetsError, setAssetsError] = useState(false);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const mutationRetries = useRef(
    new Map<string, { baseRevision: number; operationId: string }>(),
  );
  const [tab, setTab] = useState<WorkspaceTab>("shots");
  const [authoringVisited, setAuthoringVisited] = useState(false);
  const [referenceDirty, setReferenceDirty] = useState(false);
  useEffect(() => {
    if (tab === "authoring") setAuthoringVisited(true);
  }, [tab]);
  const [viewMode, setViewMode] = useState(initialView);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [shotFilter, setShotFilter] = useState("all");
  const [drafts, setDrafts] = useState<Record<string, ShotDraft>>({});
  const [undo, setUndo] = useState<UndoEntry[]>([]);
  const [focus, setFocus] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchSeconds, setBatchSeconds] = useState("3");
  const [sourceFormat, setSourceFormat] = useState<"yaml" | "json">("yaml");
  const [editingCandidate, setEditingCandidate] = useState<{
    assetId: string;
    role: string;
    notes: string;
  } | null>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const doc = data?.revisionRecord.document;
  const head = data?.headRevision ?? 0;
  const activeShotId =
    selectedShotId && doc?.shots[selectedShotId]
      ? selectedShotId
      : (doc?.sequence[0] ?? null);
  const activeShot = activeShotId ? doc?.shots[activeShotId] : undefined;
  const draft =
    activeShot && activeShotId
      ? (drafts[activeShotId] ?? draftFor(activeShot, head))
      : undefined;
  const dirtyCount = Object.values(drafts).filter(isDirty).length;
  const fps = doc?.format.fps ?? 30;
  const activeIndex =
    doc && activeShotId ? doc.sequence.indexOf(activeShotId) : -1;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [composition, library, access] = await Promise.all([
        client.getComposition(projectId, compositionId),
        client.listSubjects(projectId),
        client.getProjectAccess(projectId),
        client.getAuthoringWorkflow(projectId),
      ]);
      setData(composition);
      setSubjects(library);
      setCanWrite(access.role === "writer");
      setBootstrap(false);
      const [assetResult, historyResult] = await Promise.allSettled([
        client.listAssets(projectId),
        client.getCompositionHistory(projectId, compositionId),
      ]);
      if (assetResult.status === "fulfilled") {
        setAssets(assetResult.value);
        setAssetsError(false);
      } else setAssetsError(true);
      if (historyResult.status === "fulfilled")
        setHistory(historyResult.value.revisions);
      else setNotice("修订历史暂时无法加载，请重试刷新。");
    } catch (err) {
      if (
        err instanceof DomainError &&
        ["UNAUTHORIZED", "FORBIDDEN", "RESOURCE_TRASHED"].includes(err.code)
      ) {
        setData(null);
        setSubjects([]);
        setAssets([]);
      }
      if (err instanceof DomainError && err.code === "NOT_FOUND") {
        if (allowBootstrap) setBootstrap(true);
        else setError("未找到此编排。请返回项目，选择已有编排或新建编排。");
      } else setError(messageOf(err));
    }
  }, [client, projectId, compositionId, allowBootstrap]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    setEditingCandidate(null);
  }, [activeShotId]);
  useEffect(() => {
    if (!dirtyCount && !referenceDirty) return;
    const onLeave = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirtyCount, referenceDirty]);
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setNotice("");
    try {
      await operation();
    } catch (err) {
      if (
        err instanceof DomainError &&
        ["UNAUTHORIZED", "FORBIDDEN", "RESOURCE_TRASHED"].includes(err.code)
      ) {
        setData(null);
        setAssets([]);
        setSubjects([]);
        setHistory([]);
        setDrafts({});
      }
      setError(messageOf(err));
      if (err instanceof DomainError && err.code === "REVISION_CONFLICT")
        await refresh();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const chooseShot = (id: string): void => {
    setSelectedShotId(id);
    setTab("shots");
    inspectorRef.current?.scrollIntoView?.({ block: "start" });
  };
  const edit = (
    changes: Partial<
      Pick<ShotDraft, "description" | "duration" | "image" | "video">
    >,
  ): void => {
    if (!activeShotId || !activeShot || !canWrite) return;
    const id = activeShotId;
    setDrafts((previous) => ({
      ...previous,
      [id]: {
        ...(previous[id] ?? draftFor(activeShot, head)),
        ...changes,
        operationId: newOperationId(),
      },
    }));
    setNotice("");
  };
  const save = async (): Promise<void> => {
    if (!activeShotId || !draft || !isDirty(draft)) return;
    const id = activeShotId;
    if (
      !draft.duration.trim() ||
      !Number.isSafeInteger(Number(draft.duration)) ||
      Number(draft.duration) <= 0
    )
      throw new Error("时长需要填写大于 0 的整数帧数。");
    const result = await client.patchComposition({
      projectId,
      compositionId,
      baseRevision: draft.baseRevision,
      operationId: draft.operationId,
      operations: [{ ...changedFields(draft), shotId: id }],
      message: `编辑分镜 ${id}`,
    });
    setUndo((previous) => [
      ...previous,
      {
        shotId: id,
        before: draft.original,
        after: result.revisionRecord.document.shots[id],
        fields: changedFields(draft),
      },
    ]);
    setData((previous) =>
      previous
        ? {
            ...previous,
            headRevision: result.revisionRecord.revision,
            revisionRecord: result.revisionRecord,
          }
        : previous,
    );
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    setNotice(`已保存 ${id} · 修订 #${result.revisionRecord.revision}`);
    await refresh();
  };
  const rebaseDraft = (): void => {
    if (!draft || !activeShot || !activeShotId) return;
    const fields = changedFields(draft);
    const fresh = draftFor(activeShot, head);
    const reconciled: ShotDraft = {
      ...fresh,
      ...(fields.description !== undefined
        ? { description: draft.description }
        : {}),
      ...(fields.durationFrames !== undefined
        ? { duration: draft.duration }
        : {}),
      ...(fields.prompts?.image !== undefined ? { image: draft.image } : {}),
      ...(fields.prompts?.video !== undefined ? { video: draft.video } : {}),
    };
    setDrafts((previous) => ({ ...previous, [activeShotId]: reconciled }));
    setNotice("已保留你编辑过的字段。请核对差异后再次保存。");
    setError(null);
  };
  const undoEdit = async (): Promise<void> => {
    const entry = undo.at(-1);
    if (!entry) return;
    const current = await client.getComposition(projectId, compositionId);
    const shot = current.revisionRecord.document.shots[entry.shotId];
    const fields = (value: ShotDefinition): string =>
      JSON.stringify([
        entry.fields.description !== undefined ? value.description : null,
        entry.fields.durationFrames !== undefined ? value.durationFrames : null,
        entry.fields.prompts?.image !== undefined
          ? (value.prompts.image ?? "")
          : null,
        entry.fields.prompts?.video !== undefined
          ? (value.prompts.video ?? "")
          : null,
      ]);
    if (!shot || fields(shot) !== fields(entry.after))
      throw new Error(
        "该镜头已有新的修改，未执行撤销。请在协作与历史中对照版本。",
      );
    const delta: Extract<TypedOperation, { op: "update_shot_fields" }> = {
      op: "update_shot_fields",
      shotId: entry.shotId,
    };
    if (entry.fields.description !== undefined)
      delta.description = entry.before.description;
    if (entry.fields.durationFrames !== undefined)
      delta.durationFrames = entry.before.durationFrames;
    const prompts: { image?: string; video?: string } = {};
    if (entry.fields.prompts?.image !== undefined)
      prompts.image = entry.before.prompts.image ?? "";
    if (entry.fields.prompts?.video !== undefined)
      prompts.video = entry.before.prompts.video ?? "";
    if (Object.keys(prompts).length) delta.prompts = prompts;
    await client.patchComposition({
      projectId,
      compositionId,
      baseRevision: current.headRevision,
      operationId: newOperationId(),
      operations: [{ ...delta, shotId: entry.shotId }],
      message: `撤销本次会话对 ${entry.shotId} 的编辑`,
    });
    setUndo((previous) => previous.slice(0, -1));
    setNotice("已撤销上次编辑，历史修订保留。");
    await refresh();
  };
  const patch = async (
    operations: TypedOperation[],
    message: string,
  ): Promise<void> => {
    const signature = JSON.stringify(operations);
    const retry = mutationRetries.current.get(signature) ?? {
      baseRevision: head,
      operationId: newOperationId(),
    };
    mutationRetries.current.set(signature, retry);
    await client.patchComposition({
      projectId,
      compositionId,
      ...retry,
      operations,
      message,
    });
    mutationRetries.current.delete(signature);
    setNotice(message);
    await refresh();
  };
  const addShot = async (): Promise<void> => {
    if (!doc) return;
    let number = doc.sequence.length + 1;
    while (doc.shots[`shot-${String(number).padStart(3, "0")}`]) number++;
    const id = `shot-${String(number).padStart(3, "0")}`;
    await patch(
      [
        {
          op: "upsert_shot",
          shotId: id,
          afterShotId: activeShotId,
          shot: emptyShot(),
        },
      ],
      `新增分镜 ${id}`,
    );
    setSelectedShotId(id);
    setTab("shots");
  };
  const moveShot = async (direction: -1 | 1): Promise<void> => {
    if (!doc || !activeShotId) return;
    await patch(
      [
        {
          op: "reorder_sequence",
          shotId: activeShotId,
          afterShotId:
            direction === -1
              ? (doc.sequence[activeIndex - 2] ?? null)
              : doc.sequence[activeIndex + 1],
        },
      ],
      `调整 ${activeShotId} 的播放顺序`,
    );
  };
  const batchDuration = async (): Promise<void> => {
    const frames = Math.round(Number(batchSeconds) * fps);
    if (!selectedIds.length || !Number.isSafeInteger(frames) || frames <= 0)
      throw new Error("请选择镜头并填写有效秒数。");
    if (selectedIds.some((id) => drafts[id] && isDirty(drafts[id])))
      throw new Error("选中的镜头还有草稿，请先保存或放弃草稿。");
    await patch(
      selectedIds.map((shotId) => ({
        op: "update_shot_fields",
        shotId,
        durationFrames: frames,
      })),
      `批量修改 ${selectedIds.length} 个镜头时长`,
    );
    setSelectedIds([]);
  };
  const download = async (): Promise<void> => {
    const exported = await client.exportCompositionBundle({
      projectId,
      compositionId,
      format: sourceFormat,
    });
    const url = URL.createObjectURL(
      new Blob([exported.serialized], {
        type: sourceFormat === "json" ? "application/json" : "application/yaml",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${compositionId}.${sourceFormat}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const bootstrapWorkspace = async (): Promise<void> => {
    try {
      await client.createProject({ id: projectId, name: `项目 ${projectId}` });
    } catch (err) {
      if (!(err instanceof DomainError && err.code === "ALREADY_EXISTS"))
        throw err;
    }
    await client.getAuthoringWorkflow(projectId);
    await client.createComposition({
      projectId,
      document: {
        apiVersion: PROTOCOL_VERSION,
        id: compositionId,
        project: projectId,
        title: "初始编排工作台",
        format: { width: 1920, height: 1080, fps: 30 },
        audioTracks: [],
        sequence: ["shot-001"],
        shots: { "shot-001": emptyShot() },
      },
    });
    await refresh();
  };
  if (!doc || !data)
    return (
      <div className="welcome">
        <img src="/logo.svg" alt="Video Compose" width="48" height="48" />
        <h1>Video Compose</h1>
        {navigation}
        {bootstrap ? (
          <div data-testid="empty-workspace-bootstrap">
            <p>创建项目与第一条分镜编排，开始整理你的作品。</p>
            <button
              className="primary"
              data-testid="btn-bootstrap-project"
              disabled={pending}
              onClick={() => void run(bootstrapWorkspace)}
            >
              初始化项目与首条编排
            </button>
          </div>
        ) : (
          <p role="status">{error ? "暂时无法打开编排" : "正在加载工作台…"}</p>
        )}
        {error && (
          <p role="alert" data-testid="workbench-error">
            {error}
          </p>
        )}
        <button onClick={() => void refresh()}>重新加载</button>
      </div>
    );

  const orderedShots = doc.sequence.map((id, index) => ({
    id,
    shot: doc.shots[id],
    index,
  }));
  const visibleShots = orderedShots.filter(
    ({ id, shot }) =>
      `${id} ${shot.description} ${shot.prompts.image ?? ""} ${shot.prompts.video ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (shotFilter === "all" ||
        (shotFilter === "draft"
          ? !!drafts[id] && isDirty(drafts[id])
          : !shot.selected.video && !shot.selected.audio)),
  );
  const totalFrames = orderedShots.reduce(
    (sum, { shot }) => sum + (shot.durationFrames ?? 0),
    0,
  );
  const preview = activeShot ? shotPreview(activeShot, assets) : undefined;
  const activeBindings =
    activeShot?.subjects
      .map((binding) =>
        Object.values(data.resolvedSubjects).find(
          (subject) =>
            subject.subjectId === binding.subjectId &&
            subject.subjectRevision === binding.subjectRevision &&
            subject.resolvedVariant ===
              (binding.variant ??
                subject.snapshot.defaultVariant ??
                Object.keys(subject.snapshot.variants)[0]),
        ),
      )
      .filter((value) => value !== undefined) ?? [];
  const contentUrl = (asset: AssetRecord): string =>
    client.assetContentUrl(projectId, asset.id);
  const toggleSelection = (id: string): void =>
    setSelectedIds((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id],
    );
  const tabs = [
    ["shots", "分镜"],
    ["assets", "素材"],
    ["subjects", "角色与道具"],
    ["authoring", "参考制作"],
    ["history", "协作与历史"],
    ["source", "协议"],
  ] as const;
  return (
    <div
      className={`workbench ${focus ? "focus-mode" : ""} ${!navigationOpen ? "navigation-hidden" : ""}`}
      aria-busy={pending}
      data-testid="video-compose-workbench"
    >
      <header className="app-header">
        <a className="brand" href="/" aria-label="Video Compose 首页">
          <img src="/logo.svg" alt="" width="34" height="34" />
          <span>
            Video Compose<small>作品编排与协作</small>
          </span>
        </a>
        <div className="composition-heading">
          {navigation ?? (
            <span className="breadcrumb">
              {projectId} / {compositionId}
            </span>
          )}
          <h1 data-testid="composition-title">{doc.title ?? doc.id}</h1>
        </div>
        <div className="header-meta">
          <span className="badge" data-testid="composition-revision">
            修订 #{head}
          </span>
          <span>{canWrite ? "可编辑" : "只读"}</span>
          <span>
            {doc.sequence.length} 镜头 · {(totalFrames / fps).toFixed(1)} 秒
          </span>
        </div>
        <button
          onClick={() => {
            setError(null);
            void refresh();
          }}
          disabled={pending}
        >
          刷新
        </button>
        <AccountMenu client={client} />
      </header>
      {error && (
        <div role="alert" className="alert" data-testid="workbench-error">
          <span>
            {error}
            <small>草稿已保留。可重试原操作，或刷新后对照最新版本。</small>
          </span>
          <button onClick={() => setError(null)}>关闭</button>
        </div>
      )}
      <div className="workspace">
        <aside className="shot-sidebar" aria-label="镜头导航">
          <div className="sidebar-title">
            <strong>镜头导航</strong>
            <button
              data-testid="btn-add-shot"
              onClick={() => void run(addShot)}
              disabled={!canWrite || pending}
              aria-label="在当前镜头后新增分镜"
            >
              ＋ 新增
            </button>
          </div>
          <label className="search-field">
            <span>查找镜头</span>
            <input
              type="search"
              aria-label="搜索镜头"
              placeholder="名称、编号或提示词"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <select
            aria-label="镜头筛选"
            value={shotFilter}
            onChange={(event) => setShotFilter(event.target.value)}
          >
            <option value="all">全部镜头（{doc.sequence.length}）</option>
            <option value="draft">有未保存草稿</option>
            <option value="missing">尚未选用输出</option>
          </select>
          <div className="shot-navigation-list">
            {visibleShots.map(({ id, shot, index }) => (
              <div
                className={`shot-navigation-row ${id === activeShotId ? "selected" : ""}`}
                key={id}
              >
                <input
                  type="checkbox"
                  aria-label={`批量选择 ${id}`}
                  checked={selectedIds.includes(id)}
                  disabled={!canWrite || pending}
                  onChange={() => toggleSelection(id)}
                />
                <button
                  className="shot-nav-button"
                  onClick={() => chooseShot(id)}
                  aria-current={id === activeShotId ? "true" : undefined}
                  data-testid={`navigate-${id}`}
                >
                  <span className="shot-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span>
                    <strong>{shot.description || "未命名分镜"}</strong>
                    <small>
                      {id} · {((shot.durationFrames ?? 0) / fps).toFixed(1)} 秒
                      {drafts[id] && isDirty(drafts[id]) ? " · 未保存" : ""}
                    </small>
                  </span>
                </button>
              </div>
            ))}
            {!visibleShots.length && (
              <p className="empty-state">没有匹配的镜头</p>
            )}
          </div>
          <div className="sidebar-footer">
            {dirtyCount ? `${dirtyCount} 个镜头有未保存草稿` : "所有镜头已保存"}
            <small>草稿保留在当前页面，离开前请保存。</small>
          </div>
        </aside>
        <main className="main-workspace">
          <div
            className="workspace-tabs"
            role="tablist"
            aria-label="工作内容"
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              const buttons = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                ),
              );
              const index = buttons.indexOf(event.target as HTMLButtonElement);
              if (index < 0) return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (index +
                        (event.key === "ArrowRight" ? 1 : buttons.length - 1)) %
                      buttons.length;
              buttons[next].click();
              buttons[next].focus();
            }}
          >
            {tabs.map(([value, label]) => (
              <button
                key={value}
                role="tab"
                id={`workspace-${value}`}
                aria-controls={`workspace-panel-${value}`}
                aria-selected={tab === value}
                tabIndex={tab === value ? 0 : -1}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
            <button
              className="navigation-toggle"
              onClick={() => setNavigationOpen(!navigationOpen)}
              aria-expanded={navigationOpen}
            >
              {navigationOpen ? "收起导航" : "展开导航"}
            </button>
          </div>
          <div className="workspace-content">
            <section
              role="tabpanel"
              id="workspace-panel-shots"
              aria-labelledby="workspace-shots"
              hidden={tab !== "shots"}
            >
              {activeShotId && activeShot && draft && (
                <section
                  className="shot-editor"
                  ref={inspectorRef}
                  data-testid="shot-inspector"
                >
                  <div className="editor-heading">
                    <div>
                      <span className="eyebrow">
                        镜头 {String(activeIndex + 1).padStart(2, "0")} /{" "}
                        {doc.sequence.length} · {activeShotId}
                      </span>
                      <h2>分镜工作页</h2>
                    </div>
                    <div className="toolbar">
                      <button
                        aria-label="上一镜头"
                        disabled={activeIndex <= 0}
                        onClick={() =>
                          chooseShot(doc.sequence[activeIndex - 1])
                        }
                      >
                        ← 上一镜
                      </button>
                      <button
                        aria-label="下一镜头"
                        disabled={activeIndex >= doc.sequence.length - 1}
                        onClick={() =>
                          chooseShot(doc.sequence[activeIndex + 1])
                        }
                      >
                        下一镜 →
                      </button>
                      <button
                        aria-pressed={focus}
                        onClick={() => setFocus(!focus)}
                      >
                        {focus ? "退出专注" : "专注编辑"}
                      </button>
                    </div>
                  </div>
                  <div className="editor-columns">
                    <div className="preview-column">
                      <div className="preview-caption">
                        <strong>素材预览</strong>
                        <span>{preview?.label}</span>
                      </div>
                      <div className="hero-preview">
                        {preview?.asset ? (
                          tab === "shots" && (
                            <MediaPreview
                              key={preview.asset.id}
                              asset={preview.asset}
                              url={contentUrl(preview.asset)}
                            />
                          )
                        ) : (
                          <div className="preview-empty">
                            <span aria-hidden="true">▧</span>
                            <strong>给这个镜头添加画面</strong>
                            <p>关联参考图，或预览 Agent 交付的候选素材。</p>
                            <button onClick={() => setTab("assets")}>
                              打开素材库
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="reference-heading">
                        <h3>角色与参考</h3>
                        <span>固定版本</span>
                      </div>
                      <div data-testid="inspector-resolved-subjects">
                        {activeBindings.length ? (
                          activeBindings.map((subject) => (
                            <div
                              className="bound-subject"
                              key={`${subject.subjectId}@${subject.subjectRevision}#${subject.resolvedVariant}`}
                              data-testid={`resolved-subj-${subject.subjectId}`}
                            >
                              <strong>
                                {subject.snapshot.name}
                                <span className="badge">
                                  v{subject.subjectRevision} ·{" "}
                                  {subject.resolvedVariant}
                                </span>
                              </strong>
                              <div className="reference-thumbnails">
                                {subject.referencePack.map((reference) => {
                                  const asset = assets.find(
                                    (item) => item.id === reference.asset,
                                  );
                                  return asset ? (
                                    <MediaPreview
                                      key={asset.id}
                                      compact
                                      asset={asset}
                                      url={contentUrl(asset)}
                                    />
                                  ) : (
                                    <span key={reference.asset}>
                                      参考素材暂不可用
                                    </span>
                                  );
                                })}
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="empty-state">
                            此镜头尚未绑定角色或道具。
                            <button onClick={() => setTab("subjects")}>
                              选择设定
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="reference-heading">
                        <h3>分镜素材图</h3>
                        <span data-testid="candidate-images-count">
                          {activeShot.candidates.images.length}/5
                        </span>
                      </div>
                      <div
                        className="candidate-materials-section"
                        data-testid="inspector-candidate-images"
                      >
                        {activeShot.candidates.images.length ? (
                          <div className="candidate-grid">
                            {activeShot.candidates.images.map((cand) => {
                              const asset = assets.find(
                                (item) => item.id === cand.asset,
                              );
                              return (
                                <div
                                  key={cand.asset}
                                  className="candidate-card"
                                  data-testid={`candidate-card-${cand.asset}`}
                                >
                                  {asset ? (
                                    <MediaPreview
                                      key={asset.id}
                                      compact
                                      asset={asset}
                                      url={contentUrl(asset)}
                                    />
                                  ) : (
                                    <span className="empty-state">
                                      {cand.asset}
                                    </span>
                                  )}
                                  <div className="candidate-card-meta">
                                    <span
                                      className="candidate-asset-name"
                                      title={cand.asset}
                                    >
                                      {cand.asset}
                                    </span>
                                    {cand.role && (
                                      <span className="badge">{cand.role}</span>
                                    )}
                                    {cand.notes && (
                                      <p className="candidate-note-text">
                                        {cand.notes}
                                      </p>
                                    )}
                                  </div>
                                  <div className="candidate-card-buttons">
                                    <button
                                      type="button"
                                      className="small-btn"
                                      disabled={!canWrite || pending}
                                      data-testid={`edit-candidate-${cand.asset}`}
                                      onClick={() =>
                                        setEditingCandidate({
                                          assetId: cand.asset,
                                          role: cand.role ?? "",
                                          notes: cand.notes ?? "",
                                        })
                                      }
                                    >
                                      修改
                                    </button>
                                    <button
                                      type="button"
                                      className="small-btn danger"
                                      disabled={!canWrite || pending}
                                      data-testid={`detach-candidate-btn-${cand.asset}`}
                                      onClick={() =>
                                        void patch(
                                          [
                                            {
                                              op: "detach_shot_candidate",
                                              shotId: activeShotId,
                                              mediaKind: "images",
                                              assetId: cand.asset,
                                            },
                                          ],
                                          `从 ${activeShotId} 移除素材图 ${cand.asset}`,
                                        )
                                      }
                                    >
                                      移除
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="empty-state">
                            此镜头暂无素材图（最多可关联 5 张）。
                          </div>
                        )}
                        {editingCandidate && (
                          <div
                            className="candidate-edit-box"
                            data-testid="candidate-edit-form"
                          >
                            <h4>修改素材信息 ({editingCandidate.assetId})</h4>
                            <label>
                              角色/用途标签
                              <input
                                type="text"
                                data-testid="edit-candidate-role-input"
                                value={editingCandidate.role}
                                onChange={(e) =>
                                  setEditingCandidate({
                                    ...editingCandidate,
                                    role: e.target.value,
                                  })
                                }
                                placeholder="例如: 首帧构图 / 主角特写"
                              />
                            </label>
                            <label>
                              备注说明
                              <input
                                type="text"
                                data-testid="edit-candidate-notes-input"
                                value={editingCandidate.notes}
                                onChange={(e) =>
                                  setEditingCandidate({
                                    ...editingCandidate,
                                    notes: e.target.value,
                                  })
                                }
                                placeholder="添加素材说明或生成提示"
                              />
                            </label>
                            <div className="candidate-edit-actions">
                              <button
                                type="button"
                                disabled={pending}
                                data-testid="save-candidate-edit-btn"
                                onClick={async () => {
                                  await patch(
                                    [
                                      {
                                        op: "update_shot_candidate",
                                        shotId: activeShotId,
                                        mediaKind: "images",
                                        assetId: editingCandidate.assetId,
                                        candidate: {
                                          role:
                                            editingCandidate.role || undefined,
                                          notes:
                                            editingCandidate.notes || undefined,
                                        },
                                      },
                                    ],
                                    `更新素材 ${editingCandidate.assetId} 属性`,
                                  );
                                  setEditingCandidate(null);
                                }}
                              >
                                保存修改
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => setEditingCandidate(null)}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                        )}
                        <div className="candidate-limit-bar">
                          {activeShot.candidates.images.length < 5 ? (
                            <button
                              type="button"
                              className="secondary small-btn"
                              onClick={() => setTab("assets")}
                            >
                              ＋ 从素材库添加素材图 (还可添加{" "}
                              {5 - activeShot.candidates.images.length} 张)
                            </button>
                          ) : (
                            <span className="badge warning">
                              已达素材图上限 (5/5)
                            </span>
                          )}
                        </div>
                      </div>
                      {Boolean(
                        activeShot.references.images.length ||
                        activeShot.references.videos.length,
                      ) && (
                        <div className="reference-thumbnails">
                          {[
                            ...activeShot.references.images,
                            ...activeShot.references.videos,
                          ].map((reference) => {
                            const asset = assets.find(
                              (item) => item.id === reference.asset,
                            );
                            return asset ? (
                              <MediaPreview
                                key={asset.id}
                                compact
                                asset={asset}
                                url={contentUrl(asset)}
                              />
                            ) : null;
                          })}
                        </div>
                      )}
                    </div>
                    <div className="editor-form">
                      <fieldset disabled={!canWrite || pending}>
                        <label htmlFor="shot-description">分镜描述</label>
                        <textarea
                          id="shot-description"
                          rows={2}
                          data-testid="inspector-desc-input"
                          value={draft.description}
                          onChange={(event) =>
                            edit({ description: event.target.value })
                          }
                        />
                        <div className="duration-row">
                          <label htmlFor="shot-duration">
                            时长{" "}
                            <span>
                              {Number.isFinite(Number(draft.duration))
                                ? (Number(draft.duration) / fps).toFixed(2)
                                : "—"}{" "}
                              秒 · {fps} fps
                            </span>
                          </label>
                          <input
                            id="shot-duration"
                            aria-label="持续帧数"
                            type="number"
                            min="1"
                            step="1"
                            value={draft.duration}
                            onChange={(event) =>
                              edit({ duration: event.target.value })
                            }
                          />
                          <span>帧</span>
                        </div>
                        <label htmlFor="image-prompt">画面提示词</label>
                        <textarea
                          id="image-prompt"
                          rows={8}
                          placeholder="描述首帧或参考画面构图..."
                          value={draft.image}
                          onChange={(event) =>
                            edit({ image: event.target.value })
                          }
                        />
                        <label htmlFor="video-prompt">运镜提示词</label>
                        <textarea
                          id="video-prompt"
                          rows={5}
                          placeholder="描述镜头运动与人物动作..."
                          value={draft.video}
                          onChange={(event) =>
                            edit({ video: event.target.value })
                          }
                        />
                      </fieldset>
                      {isDirty(draft) && draft.baseRevision < head && (
                        <details className="draft-conflict">
                          <summary>
                            对照最新修订 #{head}（草稿基于 #{draft.baseRevision}
                            ）
                          </summary>
                          <p>服务器当前描述：{activeShot.description}</p>
                          <pre>
                            {activeShot.prompts.image || "无画面提示词"}
                          </pre>
                          <pre>
                            {activeShot.prompts.video || "无运镜提示词"}
                          </pre>
                          <button
                            data-testid="rebase-draft"
                            onClick={rebaseDraft}
                            disabled={pending}
                          >
                            保留已编辑字段，基于最新修订重新核对
                          </button>
                        </details>
                      )}
                      <div className="save-bar">
                        <span aria-live="polite" data-testid="save-status">
                          {!canWrite
                            ? "只读访问"
                            : pending
                              ? "正在提交…"
                              : isDirty(draft)
                                ? `未保存 · 基于修订 #${draft.baseRevision}`
                                : "当前镜头已保存"}
                        </span>
                        <div>
                          <button
                            disabled={!isDirty(draft) || pending}
                            onClick={() =>
                              setDrafts((previous) => {
                                const next = { ...previous };
                                delete next[activeShotId];
                                return next;
                              })
                            }
                          >
                            放弃草稿
                          </button>
                          <button
                            className="primary"
                            data-testid="inspector-save-btn"
                            disabled={!canWrite || pending || !isDirty(draft)}
                            onClick={() => void run(save)}
                          >
                            保存当前分镜
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              )}
              {selectedIds.length > 0 && (
                <div className="batch-toolbar">
                  <strong>已选择 {selectedIds.length} 个镜头</strong>
                  <label>
                    统一时长（秒）
                    <input
                      aria-label="批量时长秒数"
                      type="number"
                      min="0.1"
                      step="0.1"
                      value={batchSeconds}
                      onChange={(event) => setBatchSeconds(event.target.value)}
                    />
                  </label>
                  <button
                    onClick={() => void run(batchDuration)}
                    disabled={!canWrite || pending}
                  >
                    应用时长
                  </button>
                  <button onClick={() => setSelectedIds([])}>取消选择</button>
                </div>
              )}
              {tab === "shots" && (
                <ShotOverview
                  document={doc}
                  visibleShots={visibleShots}
                  activeShotId={activeShotId}
                  viewMode={viewMode}
                  onView={setViewMode}
                  onChoose={chooseShot}
                  assets={assets}
                  contentUrl={contentUrl}
                  onMove={(direction) => void run(() => moveShot(direction))}
                  canMove={!pending && canWrite}
                />
              )}
            </section>
            <section
              role="tabpanel"
              id="workspace-panel-assets"
              aria-labelledby="workspace-assets"
              hidden={tab !== "assets"}
            >
              <AssetLibrary
                client={client}
                projectId={projectId}
                activeShotId={activeShotId}
                activeShot={activeShot}
                assets={assets}
                failed={assetsError}
                active={tab === "assets"}
                onRefresh={refresh}
                disabled={!canWrite || pending}
                run={run}
                patch={patch}
              />
            </section>
            <section
              role="tabpanel"
              id="workspace-panel-subjects"
              aria-labelledby="workspace-subjects"
              hidden={tab !== "subjects"}
            >
              <SubjectLibrary
                client={client}
                projectId={projectId}
                activeShotId={activeShotId}
                assets={assets}
                subjects={subjects}
                onRefresh={refresh}
                disabled={!canWrite || pending}
                run={run}
                patch={patch}
              />
            </section>
            <section
              role="tabpanel"
              id="workspace-panel-authoring"
              aria-labelledby="workspace-authoring"
              hidden={tab !== "authoring"}
            >
              {(tab === "authoring" || authoringVisited) && (
                <React.Suspense
                  fallback={<p role="status">正在载入参考工作台…</p>}
                >
                  <AuthoringPanel
                    client={client}
                    projectId={projectId}
                    composition={doc}
                    compositionRevision={data.revisionRecord.revision}
                    assets={assets}
                    subjects={subjects}
                    activeShotId={activeShotId}
                    disabled={!canWrite || pending}
                    active={tab === "authoring"}
                    onDirtyChange={setReferenceDirty}
                    patch={patch}
                  />
                </React.Suspense>
              )}
            </section>
            <section
              role="tabpanel"
              id="workspace-panel-history"
              aria-labelledby="workspace-history"
              hidden={tab !== "history"}
              data-testid="contextual-agent-panel"
            >
              <div className="page-heading">
                <div>
                  <span className="eyebrow">可追溯的修改记录</span>
                  <h2>协作与历史</h2>
                </div>
                <button
                  data-testid="btn-undo"
                  disabled={
                    !canWrite || pending || !undo.length || dirtyCount > 0
                  }
                  onClick={() => void run(undoEdit)}
                >
                  撤销本次会话的上次编辑
                </button>
              </div>
              <p data-testid="agent-context-summary">
                项目 {projectId} · 编排 {compositionId}@r{head} · 当前镜头{" "}
                {activeShotId ?? "无"}
              </p>
              <div className="revision-list">
                {history
                  .slice()
                  .reverse()
                  .map((revision) => (
                    <article key={revision.revision}>
                      <div>
                        <strong>修订 #{revision.revision}</strong>
                        <span>
                          {revision.actorKind === "human" ? "人类" : "Agent"} ·{" "}
                          {new Date(revision.createdAt).toLocaleString("zh-CN")}
                        </span>
                      </div>
                      <p>{revision.message ?? "创建编排"}</p>
                      <details>
                        <summary>查看此版本的镜头与提示词</summary>
                        {revision.document.sequence.map((id) => (
                          <div className="revision-shot" key={id}>
                            <strong>
                              {id} · {revision.document.shots[id].description}
                            </strong>
                            <p>
                              {revision.document.shots[id].prompts.image ||
                                "无画面提示词"}
                            </p>
                            <p>
                              {revision.document.shots[id].prompts.video ||
                                "无运镜提示词"}
                            </p>
                          </div>
                        ))}
                      </details>
                    </article>
                  ))}
              </div>
              <details className="connection-details">
                <summary>Agent 接入信息</summary>
                <p>
                  通过经过授权的远程 MCP
                  接入此项目。所有写入需要基准修订与幂等键。
                </p>
                <code>{window.location.origin}/mcp</code>
              </details>
            </section>
            <section
              role="tabpanel"
              id="workspace-panel-source"
              aria-labelledby="workspace-source"
              hidden={tab !== "source"}
            >
              <div className="page-heading">
                <div>
                  <span className="eyebrow">可移植的作品定义</span>
                  <h2>编排协议</h2>
                </div>
                <div className="toolbar">
                  <select
                    aria-label="协议格式"
                    value={sourceFormat}
                    onChange={(event) =>
                      setSourceFormat(event.target.value as "json" | "yaml")
                    }
                  >
                    <option value="yaml">YAML</option>
                    <option value="json">JSON</option>
                  </select>
                  <button onClick={() => void run(download)}>
                    导出（含设定依赖）
                  </button>
                </div>
              </div>
              <pre className="source-code">
                {sourceFormat === "yaml"
                  ? serializeCompositionYaml(doc)
                  : JSON.stringify(doc, null, 2)}
              </pre>
            </section>
          </div>
          <footer className="workspace-status" aria-live="polite">
            <span>
              {referenceDirty
                ? "参考资料或审阅有未保存草稿"
                : notice ||
                  (dirtyCount
                    ? `${dirtyCount} 个镜头有未保存草稿`
                    : "所有修改已保存")}
            </span>
            <span>
              {doc.format.width} × {doc.format.height} · {fps} fps
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
