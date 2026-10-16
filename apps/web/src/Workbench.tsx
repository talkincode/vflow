import type { VideoComposeClient } from "@video-compose/client";
import {
  type AssetRecord,
  type CompositionRevisionRecord,
  DomainError,
  type SubjectRecord,
} from "@video-compose/domain";
import {
  PROTOCOL_VERSION,
  type ReferencePackEntry,
  serializeCompositionYaml,
  type SubjectKind,
  type SubjectSnapshot,
} from "@video-compose/protocol";
import React, { useCallback, useEffect, useState } from "react";

export type WorkbenchViewMode = "grid" | "list" | "topology";

export interface WorkbenchProps {
  client: VideoComposeClient;
  projectId: string;
  compositionId: string;
  initialView?: WorkbenchViewMode;
}

const KIND_LABELS: Record<SubjectKind, string> = {
  character: "角色",
  prop: "道具",
};

const STATUS_LABELS: Record<string, string> = {
  approved: "已批准",
  candidate: "候选中",
};

const DEP_KIND_LABELS: Record<string, string> = {
  continuity: "画面连贯 (continuity)",
  motion: "动作衔接 (motion)",
  timing: "节奏同步 (timing)",
};

export function Workbench({
  client,
  projectId,
  compositionId,
  initialView = "grid",
}: WorkbenchProps): React.ReactElement {
  const [viewMode, setViewMode] = useState<WorkbenchViewMode>(initialView);
  const [subjectFilter, setSubjectFilter] = useState<"all" | SubjectKind>("all");
  const [agentPanelOpen, setAgentPanelOpen] = useState<boolean>(true);
  const [exportDrawerOpen, setExportDrawerOpen] = useState<boolean>(false);
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);

  const [headRevision, setHeadRevision] = useState<number>(0);
  const [revisionRecord, setRevisionRecord] =
    useState<CompositionRevisionRecord | null>(null);
  const [revisionHistory, setRevisionHistory] = useState<
    CompositionRevisionRecord[]
  >([]);
  const [resolvedSubjects, setResolvedSubjects] = useState<
    Record<
      string,
      {
        subjectId: string;
        subjectRevision: number;
        resolvedVariant: string;
        referencePack: ReferencePackEntry[];
        snapshot: SubjectSnapshot;
      }
    >
  >({});
  const [subjects, setSubjects] = useState<SubjectRecord[]>([]);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [needsBootstrap, setNeedsBootstrap] = useState<boolean>(false);

  // Inspector edit states
  const [editDraftDescription, setEditDraftDescription] = useState<string>("");
  const [editDraftDuration, setEditDraftDuration] = useState<number>(90);
  const [editDraftImagePrompt, setEditDraftImagePrompt] = useState<string>("");
  const [editDraftVideoPrompt, setEditDraftVideoPrompt] = useState<string>("");

  // Quick creation toggles
  const [showNewSubjectForm, setShowNewSubjectForm] = useState<boolean>(false);
  const [newSubjectId, setNewSubjectId] = useState<string>("");
  const [newSubjectName, setNewSubjectName] = useState<string>("");
  const [newSubjectKind, setNewSubjectKind] =
    useState<SubjectKind>("character");
  const [newSubjectDesc, setNewSubjectDesc] = useState<string>("");
  const [newSubjectInvariants, setNewSubjectInvariants] = useState<string>("");

  const refreshState = useCallback(async () => {
    try {
      const [compData, subjList] = await Promise.all([
        client.getComposition(projectId, compositionId),
        client.listSubjects(projectId),
      ]);
      setNeedsBootstrap(false);
      setHeadRevision(compData.headRevision);
      setRevisionRecord(compData.revisionRecord);
      setResolvedSubjects(compData.resolvedSubjects);
      setSubjects(subjList);

      const firstShot = compData.revisionRecord.document.sequence[0] ?? null;
      setSelectedShotId((prev) => prev ?? firstShot);

      void client
        .getCompositionHistory(projectId, compositionId)
        .then((hist) => setRevisionHistory(hist.revisions))
        .catch(() => {});
      void client
        .listAssets(projectId)
        .then((assetList) => setAssets(assetList))
        .catch(() => {});
    } catch (err) {
      if (err instanceof DomainError && err.code === "NOT_FOUND") {
        setNeedsBootstrap(true);
        setErrorBanner(null);
      } else {
        setErrorBanner(err instanceof Error ? err.message : String(err));
      }
    }
  }, [client, projectId, compositionId]);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  const doc = revisionRecord?.document;
  const activeShotId = selectedShotId ?? doc?.sequence[0] ?? null;
  const activeShot = activeShotId && doc ? doc.shots[activeShotId] : null;

  useEffect(() => {
    if (activeShot) {
      setEditDraftDescription(activeShot.description);
      setEditDraftDuration(activeShot.durationFrames ?? 90);
      setEditDraftImagePrompt(activeShot.prompts?.image ?? "");
      setEditDraftVideoPrompt(activeShot.prompts?.video ?? "");
    }
  }, [
    activeShotId,
    activeShot?.description,
    activeShot?.durationFrames,
    activeShot?.prompts?.image,
    activeShot?.prompts?.video,
  ]);

  const handleBootstrapWorkspace = async (): Promise<void> => {
    setErrorBanner(null);
    try {
      try {
        await client.createProject({
          id: projectId,
          name: `项目 ${projectId}`,
        });
      } catch (err) {
        if (!(err instanceof DomainError && err.code === "ALREADY_EXISTS")) {
          throw err;
        }
      }

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
          shots: {
            "shot-001": {
              description: "开场镜头",
              durationFrames: 150,
              dependsOn: [],
              subjects: [],
              references: { images: [], videos: [] },
              prompts: { image: "霓虹雨巷全景开场画面" },
              candidates: { images: [], videos: [], audios: [] },
              selected: { video: null, audio: null },
            },
          },
        },
      });
      await refreshState();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveShotDescription = async (
    shotId: string,
    newDescription: string,
  ): Promise<void> => {
    if (!revisionRecord) return;
    setErrorBanner(null);
    try {
      await client.patchComposition({
        projectId,
        compositionId,
        baseRevision: headRevision,
        operationId: `ui-edit-${shotId}-r${headRevision}-${Date.now()}`,
        operations: [
          {
            op: "update_shot_fields",
            shotId,
            description: newDescription,
          },
        ],
        message: `修改镜头 ${shotId} 描述`,
      });
      await refreshState();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
      await refreshState();
    }
  };

  const handleSaveShotExtended = async (shotId: string): Promise<void> => {
    if (!revisionRecord || !activeShot) return;
    setErrorBanner(null);
    try {
      await client.patchComposition({
        projectId,
        compositionId,
        baseRevision: headRevision,
        operationId: `ui-edit-ext-${shotId}-r${headRevision}-${Date.now()}`,
        operations: [
          {
            op: "update_shot_fields",
            shotId,
            description: editDraftDescription,
            durationFrames: Number(editDraftDuration) || 90,
            prompts: {
              ...activeShot.prompts,
              ...(editDraftImagePrompt.trim()
                ? { image: editDraftImagePrompt.trim() }
                : {}),
              ...(editDraftVideoPrompt.trim()
                ? { video: editDraftVideoPrompt.trim() }
                : {}),
            },
          },
        ],
        message: `更新镜头 ${shotId} 时长与生成提示词`,
      });
      await refreshState();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
      await refreshState();
    }
  };

  const handleAddShot = async (): Promise<void> => {
    if (!doc) return;
    setErrorBanner(null);
    const nextNum = doc.sequence.length + 1;
    const newShotId = `shot-${String(nextNum).padStart(3, "0")}`;
    const lastShotId = doc.sequence[doc.sequence.length - 1];
    try {
      await client.patchComposition({
        projectId,
        compositionId,
        baseRevision: headRevision,
        operationId: `ui-add-${newShotId}-r${headRevision}-${Date.now()}`,
        operations: [
          {
            op: "upsert_shot",
            shotId: newShotId,
            afterShotId: lastShotId,
            shot: {
              description: `新增分镜 #${nextNum}`,
              durationFrames: 90,
              dependsOn: lastShotId
                ? [{ shotId: lastShotId, kind: "continuity" }]
                : [],
              subjects: [],
              references: { images: [], videos: [] },
              prompts: { image: `分镜 #${nextNum} 画面构图提示词` },
              candidates: { images: [], videos: [], audios: [] },
              selected: { video: null, audio: null },
            },
          },
        ],
        message: `新增分镜 ${newShotId}`,
      });
      setSelectedShotId(newShotId);
      await refreshState();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleUndoRevision = async (): Promise<void> => {
    if (!revisionRecord || headRevision <= 1) return;
    setErrorBanner(null);
    try {
      await client.restoreCompositionRevision({
        projectId,
        compositionId,
        targetRevision: headRevision - 1,
        operationId: `ui-undo-to-${headRevision - 1}-${Date.now()}`,
      });
      await refreshState();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateSubject = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!newSubjectId.trim() || !newSubjectName.trim()) return;
    setErrorBanner(null);
    try {
      await client.createSubject({
        projectId,
        id: newSubjectId.trim(),
        kind: newSubjectKind,
        name: newSubjectName.trim(),
        status: "approved",
        defaultVariant: "default",
        definition: {
          description: newSubjectDesc.trim() || `${newSubjectName.trim()} 设定`,
          invariants: newSubjectInvariants
            .split(/[,，]/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
        variants: {
          default: {
            description: "默认外观造型",
            referencePack: [],
          },
        },
      });
      setShowNewSubjectForm(false);
      setNewSubjectId("");
      setNewSubjectName("");
      setNewSubjectDesc("");
      setNewSubjectInvariants("");
      await refreshState();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  const handleBindSubjectToActiveShot = async (
    subj: SubjectRecord,
  ): Promise<void> => {
    if (!activeShotId) return;
    setErrorBanner(null);
    try {
      await client.patchComposition({
        projectId,
        compositionId,
        baseRevision: headRevision,
        operationId: `ui-bind-${activeShotId}-${subj.id}-${Date.now()}`,
        operations: [
          {
            op: "bind_shot_subject",
            shotId: activeShotId,
            binding: {
              subjectId: subj.id,
              subjectRevision: subj.latestRevision,
            },
          },
        ],
        message: `绑定设定 ${subj.id}@v${subj.latestRevision} 至镜头 ${activeShotId}`,
      });
      await refreshState();
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : String(err));
    }
  };

  if (needsBootstrap && (!doc || !revisionRecord)) {
    return (
      <div
        className="vc-bootstrap-screen"
        data-testid="empty-workspace-bootstrap"
      >
        <div className="vc-bootstrap-card">
          <div className="vc-brand" style={{ marginBottom: 16 }}>
            视频编排工作台
          </div>
          <h2 style={{ marginTop: 0, marginBottom: 8 }}>
            项目「{projectId}」尚未初始化
          </h2>
          <p style={{ color: "var(--text-secondary)", marginBottom: 20 }}>
            当前 Cloudflare D1 工作区尚未创建默认项目与首条分镜编排，点击下方按钮一键初始化。
          </p>
          {errorBanner && (
            <div
              role="alert"
              className="vc-alert-error"
              data-testid="workbench-error"
              style={{ marginBottom: 16 }}
            >
              {errorBanner}
            </div>
          )}
          <button
            type="button"
            className="vc-btn vc-btn-primary"
            data-testid="btn-bootstrap-project"
            onClick={() => void handleBootstrapWorkspace()}
          >
            初始化项目与首条编排
          </button>
        </div>
      </div>
    );
  }

  if (!doc || !revisionRecord) {
    return (
      <div className="vc-bootstrap-screen" data-testid="workbench-loading">
        <div className="vc-bootstrap-card">
          {errorBanner ? (
            <div
              role="alert"
              className="vc-alert-error"
              data-testid="workbench-error"
            >
              {errorBanner}
            </div>
          ) : (
            <div>正在加载视频编排工作台...</div>
          )}
        </div>
      </div>
    );
  }

  const orderedShots = doc.sequence.map((id, idx) => ({
    id,
    index: idx + 1,
    shot: doc.shots[id],
  }));

  const totalFrames = orderedShots.reduce(
    (sum, item) => sum + (item.shot?.durationFrames ?? 0),
    0,
  );
  const fps = doc.format?.fps ?? 30;
  const totalSeconds = (totalFrames / fps).toFixed(1);

  const dependencyEdges = orderedShots.flatMap(({ id, shot }) =>
    shot.dependsOn.map((dep) => ({
      fromShotId: dep.shotId,
      toShotId: id,
      kind: dep.kind,
    })),
  );

  const filteredSubjects = subjects.filter((s) =>
    subjectFilter === "all" ? true : s.kind === subjectFilter,
  );

  return (
    <div className="vc-workbench" data-testid="video-compose-workbench">
      {/* 顶部工作台导航栏 */}
      <header className="vc-header">
        <div className="vc-header-left">
          <span className="vc-brand">视频编排工作台</span>
          <div className="vc-title-group">
            <h1 className="vc-title" data-testid="composition-title">
              {doc.title ?? doc.id}
            </h1>
            <span
              className="vc-badge vc-badge-revision"
              data-testid="composition-revision"
            >
              修订 #{headRevision}
            </span>
            <span className="vc-badge">
              {doc.format.width}×{doc.format.height} · {fps}帧/秒
            </span>
            <span className="vc-badge vc-badge-indigo">
              {orderedShots.length} 个镜头 · {totalFrames}帧（{totalSeconds}秒）
            </span>
          </div>
        </div>

        <nav className="vc-view-switcher" aria-label="视图切换">
          <button
            type="button"
            className={`vc-tab-btn ${viewMode === "grid" ? "active" : ""}`}
            data-testid="tab-grid"
            onClick={() => setViewMode("grid")}
          >
            分镜网格
          </button>
          <button
            type="button"
            className={`vc-tab-btn ${viewMode === "list" ? "active" : ""}`}
            data-testid="tab-list"
            onClick={() => setViewMode("list")}
          >
            编排清单
          </button>
          <button
            type="button"
            className={`vc-tab-btn ${viewMode === "topology" ? "active" : ""}`}
            data-testid="tab-topology"
            onClick={() => setViewMode("topology")}
          >
            依赖拓扑
          </button>
        </nav>

        <div className="vc-header-actions">
          <button
            type="button"
            className="vc-btn vc-btn-primary"
            data-testid="btn-add-shot"
            onClick={() => void handleAddShot()}
          >
            + 新增分镜
          </button>
          <button
            type="button"
            className="vc-btn"
            data-testid="btn-toggle-export"
            onClick={() => setExportDrawerOpen((prev) => !prev)}
          >
            {exportDrawerOpen ? "收起 YAML 协议" : "YAML / JSON 协议"}
          </button>
          <button
            type="button"
            className="vc-btn"
            data-testid="btn-undo"
            disabled={headRevision <= 1}
            onClick={() => void handleUndoRevision()}
          >
            撤销上一修订
          </button>
          <button
            type="button"
            className="vc-btn"
            data-testid="btn-toggle-agent"
            onClick={() => setAgentPanelOpen((prev) => !prev)}
          >
            {agentPanelOpen ? "隐藏协作侧栏" : "显示协作侧栏"}
          </button>
        </div>
      </header>

      {errorBanner && (
        <div
          role="alert"
          className="vc-alert-error"
          data-testid="workbench-error"
        >
          <span>{errorBanner}</span>
          <button
            type="button"
            className="vc-btn vc-btn-sm"
            onClick={() => setErrorBanner(null)}
          >
            关闭
          </button>
        </div>
      )}

      {/* 三栏主工作区 */}
      <div className="vc-studio-body">
        {/* 左侧栏：角色/道具设定库与不可变资产库 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <section className="vc-panel" data-testid="subject-library">
            <div className="vc-panel-header">
              <h2 className="vc-panel-title">
                <span>角色与道具设定库</span>
                <span className="vc-badge">{subjects.length}</span>
              </h2>
              <button
                type="button"
                className="vc-btn vc-btn-sm"
                onClick={() => setShowNewSubjectForm((prev) => !prev)}
              >
                {showNewSubjectForm ? "取消" : "+ 新建设定"}
              </button>
            </div>
            <div className="vc-panel-body">
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  marginBottom: 12,
                }}
              >
                <button
                  type="button"
                  className={`vc-btn vc-btn-sm ${subjectFilter === "all" ? "vc-btn-primary" : ""}`}
                  data-testid="filter-all"
                  onClick={() => setSubjectFilter("all")}
                >
                  全部
                </button>
                <button
                  type="button"
                  className={`vc-btn vc-btn-sm ${subjectFilter === "character" ? "vc-btn-primary" : ""}`}
                  data-testid="filter-character"
                  onClick={() => setSubjectFilter("character")}
                >
                  角色
                </button>
                <button
                  type="button"
                  className={`vc-btn vc-btn-sm ${subjectFilter === "prop" ? "vc-btn-primary" : ""}`}
                  data-testid="filter-prop"
                  onClick={() => setSubjectFilter("prop")}
                >
                  道具
                </button>
              </div>

              {showNewSubjectForm && (
                <form
                  onSubmit={(e) => void handleCreateSubject(e)}
                  style={{
                    padding: 12,
                    background: "var(--bg-input)",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border-subtle)",
                    marginBottom: 12,
                  }}
                >
                  <div className="vc-field">
                    <label className="vc-label">设定标识 ID</label>
                    <input
                      className="vc-input"
                      placeholder="例如: prop-drone"
                      value={newSubjectId}
                      onChange={(e) => setNewSubjectId(e.target.value)}
                    />
                  </div>
                  <div className="vc-field">
                    <label className="vc-label">名称与类型</label>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input
                        className="vc-input"
                        placeholder="设定名称（如：侦察无人机）"
                        value={newSubjectName}
                        onChange={(e) => setNewSubjectName(e.target.value)}
                      />
                      <select
                        className="vc-select"
                        style={{ width: 100 }}
                        value={newSubjectKind}
                        onChange={(e) =>
                          setNewSubjectKind(e.target.value as SubjectKind)
                        }
                      >
                        <option value="character">角色</option>
                        <option value="prop">道具</option>
                      </select>
                    </div>
                  </div>
                  <div className="vc-field">
                    <label className="vc-label">视觉设定描述</label>
                    <input
                      className="vc-input"
                      placeholder="核心外观、材质与时代风格..."
                      value={newSubjectDesc}
                      onChange={(e) => setNewSubjectDesc(e.target.value)}
                    />
                  </div>
                  <div className="vc-field">
                    <label className="vc-label">不变量特征（逗号分隔）</label>
                    <input
                      className="vc-input"
                      placeholder="例如：黄色防水雨衣，赛博邮差斜挎包"
                      value={newSubjectInvariants}
                      onChange={(e) => setNewSubjectInvariants(e.target.value)}
                    />
                  </div>
                  <button
                    type="submit"
                    className="vc-btn vc-btn-primary vc-btn-sm"
                    style={{ width: "100%" }}
                  >
                    创建并冻结为权威版本
                  </button>
                </form>
              )}

              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                }}
              >
                {filteredSubjects.map((subj) => {
                  const latestSnap = subj.revisions[subj.latestRevision];
                  const variantNames = Object.keys(latestSnap?.variants ?? {});
                  const kindText = KIND_LABELS[subj.kind] ?? subj.kind;
                  const statusText =
                    STATUS_LABELS[latestSnap?.status ?? ""] ??
                    latestSnap?.status;
                  return (
                    <li
                      key={subj.id}
                      className="vc-subject-card"
                      data-testid={`library-subject-${subj.id}`}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <strong style={{ fontSize: 13.5 }}>
                          {subj.name}（{kindText}）— 第 {subj.latestRevision} 版 [
                          {statusText}]
                        </strong>
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexWrap: "wrap",
                          gap: 5,
                        }}
                      >
                        <span className="vc-badge">{subj.id}</span>
                        <span
                          className={`vc-badge ${
                            latestSnap?.status === "approved"
                              ? "vc-badge-approved"
                              : "vc-badge-candidate"
                          }`}
                        >
                          {statusText}
                        </span>
                        {latestSnap?.defaultVariant && (
                          <span className="vc-badge vc-badge-indigo">
                            默认变体：{latestSnap.defaultVariant}
                          </span>
                        )}
                      </div>
                      {latestSnap?.definition?.description && (
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--text-secondary)",
                          }}
                        >
                          {latestSnap.definition.description}
                        </div>
                      )}
                      {latestSnap?.definition?.invariants &&
                        latestSnap.definition.invariants.length > 0 && (
                          <div
                            style={{
                              display: "flex",
                              flexWrap: "wrap",
                              gap: 4,
                            }}
                          >
                            {latestSnap.definition.invariants.map((inv) => (
                              <span
                                key={inv}
                                className="vc-badge"
                                style={{ fontSize: 10.5 }}
                              >
                                🔒 {inv}
                              </span>
                            ))}
                          </div>
                        )}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginTop: 4,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--text-muted)",
                          }}
                        >
                          可选变体：
                          {variantNames.length > 0
                            ? variantNames.join("、")
                            : "默认"}
                        </span>
                        {activeShotId && latestSnap?.status === "approved" && (
                          <button
                            type="button"
                            className="vc-btn vc-btn-sm"
                            onClick={() =>
                              void handleBindSubjectToActiveShot(subj)
                            }
                          >
                            绑定至 {activeShotId}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          {/* 不可变资产库 */}
          <section className="vc-panel">
            <div className="vc-panel-header">
              <h2 className="vc-panel-title">
                <span>不可变资产库（R2 SHA-256）</span>
                <span className="vc-badge">{assets.length}</span>
              </h2>
            </div>
            <div className="vc-panel-body">
              {assets.length === 0 ? (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  暂无已登记媒体资产
                </div>
              ) : (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  {assets.map((asset) => (
                    <div
                      key={asset.id}
                      style={{
                        padding: "8px 10px",
                        background: "var(--bg-card)",
                        border: "1px solid var(--border-subtle)",
                        borderRadius: "var(--radius-sm)",
                        fontSize: 12,
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          fontWeight: 600,
                        }}
                      >
                        <span>{asset.id}</span>
                        <span className="vc-badge vc-badge-cyan">
                          {asset.mimeType}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          color: "var(--text-muted)",
                          fontFamily: "monospace",
                          marginTop: 4,
                        }}
                      >
                        SHA-256：{asset.sha256.slice(0, 16)}…
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>

        {/* 中间主舞台：时间线轨道 + 协议源码抽屉 + 三视图画布 */}
        <div>
          <div className="vc-timeline-strip">
            <div className="vc-timeline-header">
              <span>
                <strong>时间线播放序列</strong> · 共 {orderedShots.length} 个镜头 ·{" "}
                {totalFrames} 帧（{totalSeconds} 秒）
              </span>
              <span>点击时间块切换当前选中镜头</span>
            </div>
            <div className="vc-timeline-track">
              {orderedShots.map(({ id, index, shot }) => {
                const dur = shot?.durationFrames ?? 60;
                const flexGrow = Math.max(1, Math.round(dur / 15));
                const isSelected = id === activeShotId;
                return (
                  <div
                    key={id}
                    className={`vc-timeline-segment ${isSelected ? "selected" : ""}`}
                    style={{ flexGrow }}
                    onClick={() => setSelectedShotId(id)}
                  >
                    <span className="vc-timeline-seg-id">
                      #{String(index).padStart(2, "0")} {id}
                    </span>
                    <span className="vc-timeline-seg-meta">
                      {dur}帧（{(dur / fps).toFixed(1)}秒）
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {exportDrawerOpen && (
            <div className="vc-panel" style={{ marginBottom: 16 }}>
              <div className="vc-panel-header">
                <h2 className="vc-panel-title">
                  可移植声明式编排协议源码（YAML — {PROTOCOL_VERSION}）
                </h2>
              </div>
              <div className="vc-panel-body">
                <pre className="vc-code-box">
                  {serializeCompositionYaml(doc)}
                </pre>
              </div>
            </div>
          )}

          <main data-testid={`view-${viewMode}`}>
            {viewMode === "grid" && (
              <section className="vc-shot-grid" aria-label="分镜网格">
                {orderedShots.map(({ id, index, shot }) => {
                  const isSelected = id === activeShotId;
                  const dur = shot.durationFrames ?? 0;
                  return (
                    <article
                      key={id}
                      className={`vc-shot-card ${isSelected ? "selected" : ""}`}
                      data-testid={`grid-shot-${id}`}
                      onClick={() => {
                        setSelectedShotId(id);
                        setEditDraftDescription(shot.description);
                      }}
                    >
                      <div className="vc-shot-preview">
                        <div className="vc-shot-preview-top">
                          <span className="vc-shot-index">
                            镜头 #{String(index).padStart(2, "0")}
                          </span>
                          <span className="vc-badge">
                            时长：{dur}帧（{(dur / fps).toFixed(1)}秒）
                          </span>
                        </div>
                        <div className="vc-shot-prompt-overlay">
                          {shot.prompts?.image ||
                            shot.prompts?.video ||
                            shot.description}
                        </div>
                      </div>

                      <div className="vc-shot-body">
                        <div className="vc-shot-title-row">
                          <h3 className="vc-shot-id">{id}</h3>
                          {shot.dependsOn.length > 0 && (
                            <span className="vc-badge vc-badge-indigo">
                              依赖：
                              {shot.dependsOn.map((d) => d.shotId).join("、")}
                            </span>
                          )}
                        </div>

                        <p
                          className="vc-shot-desc"
                          data-testid={`shot-desc-${id}`}
                        >
                          {shot.description}
                        </p>

                        <ul
                          className="vc-tag-list"
                          data-testid={`shot-subjects-${id}`}
                        >
                          {shot.subjects.map((b) => (
                            <li
                              key={`${b.subjectId}@${b.subjectRevision}`}
                              className="vc-badge vc-badge-approved"
                            >
                              {b.subjectId}@v{b.subjectRevision}（
                              {b.variant ?? "默认"}）
                            </li>
                          ))}
                        </ul>
                      </div>
                    </article>
                  );
                })}
              </section>
            )}

            {viewMode === "list" && (
              <section className="vc-panel" aria-label="分镜与音轨总表">
                <div className="vc-panel-header">
                  <h2 className="vc-panel-title">分镜与全局音轨总表</h2>
                </div>
                <div className="vc-panel-body">
                  <div
                    style={{ marginBottom: 16 }}
                    data-testid="manifest-audio-tracks"
                  >
                    <div className="vc-label" style={{ marginBottom: 8 }}>
                      全局音轨（Global Audio Tracks）
                    </div>
                    {doc.audioTracks.length === 0 ? (
                      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                        当前未挂载全局背景音乐或旁白音轨
                      </div>
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                        }}
                      >
                        {doc.audioTracks.map((track) => (
                          <div
                            key={track.id}
                            className="vc-badge vc-badge-cyan"
                            style={{
                              justifyContent: "space-between",
                              padding: "8px 12px",
                              borderRadius: "var(--radius-sm)",
                            }}
                            data-testid={`audio-track-${track.id}`}
                          >
                            <span>
                              🎵 {track.id} [{track.role}] 资产={track.asset}{" "}
                              帧区间={track.startFrame}..
                              {track.startFrame + track.durationFrames}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="vc-table-wrap">
                    <table className="vc-table">
                      <thead>
                        <tr>
                          <th>序号</th>
                          <th>镜头 ID</th>
                          <th>分镜描述</th>
                          <th>时长帧数</th>
                          <th>锁定主体设定</th>
                          <th>前序依赖</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orderedShots.map(({ id, index, shot }) => (
                          <tr
                            key={id}
                            className={id === activeShotId ? "selected" : ""}
                            data-testid={`list-shot-${id}`}
                            onClick={() => setSelectedShotId(id)}
                          >
                            <td>#{String(index).padStart(2, "0")}</td>
                            <td>
                              <strong>{id}</strong>
                            </td>
                            <td data-testid={`shot-desc-${id}`}>
                              {shot.description}
                            </td>
                            <td>{shot.durationFrames ?? 0}帧</td>
                            <td>
                              {shot.subjects
                                .map(
                                  (b) => `${b.subjectId}@v${b.subjectRevision}`,
                                )
                                .join("、") || "—"}
                            </td>
                            <td>
                              {shot.dependsOn
                                .map(
                                  (d) =>
                                    `${d.shotId}（${DEP_KIND_LABELS[d.kind] ?? d.kind}）`,
                                )
                                .join("、") || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            )}

            {viewMode === "topology" && (
              <section className="vc-panel" aria-label="依赖拓扑图">
                <div className="vc-panel-header">
                  <h2 className="vc-panel-title">
                    镜头依赖有向无环图（DAG 拓扑）
                  </h2>
                </div>
                <div className="vc-panel-body">
                  <div className="vc-topology-grid">
                    <div>
                      <div className="vc-label" style={{ marginBottom: 8 }}>
                        拓扑镜头节点
                      </div>
                      <ul
                        style={{ listStyle: "none", padding: 0, margin: 0 }}
                        data-testid="topology-nodes"
                      >
                        {orderedShots.map(({ id, shot }) => (
                          <li
                            key={id}
                            className="vc-dag-node"
                            data-testid={`topology-shot-${id}`}
                            onClick={() => setSelectedShotId(id)}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                              }}
                            >
                              <strong>{id}</strong>
                              <span className="vc-badge">
                                {shot.durationFrames ?? 0}帧
                              </span>
                            </div>
                            <span
                              style={{
                                fontSize: 12.5,
                                color: "var(--text-secondary)",
                              }}
                              data-testid={`shot-desc-${id}`}
                            >
                              {shot.description}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div>
                      <div className="vc-label" style={{ marginBottom: 8 }}>
                        依赖有向边
                      </div>
                      <ul
                        style={{ listStyle: "none", padding: 0, margin: 0 }}
                        data-testid="topology-edges"
                      >
                        {dependencyEdges.map((edge) => (
                          <li
                            key={`${edge.fromShotId}->${edge.toShotId}`}
                            className="vc-dag-edge"
                            data-testid={`edge-${edge.fromShotId}-${edge.toShotId}`}
                          >
                            {edge.fromShotId} → {edge.toShotId}（
                            {DEP_KIND_LABELS[edge.kind] ?? edge.kind}）
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              </section>
            )}
          </main>
        </div>

        {/* 右侧栏：分镜检查器与多 Agent 协作侧栏 */}
        <div className="vc-right-dock">
          {activeShotId && activeShot && (
            <section className="vc-panel" data-testid="shot-inspector">
              <div className="vc-panel-header">
                <h2 className="vc-panel-title">分镜检查器：{activeShotId}</h2>
                <span className="vc-badge">
                  {activeShot.durationFrames ?? 0} 帧
                </span>
              </div>
              <div className="vc-panel-body">
                <div className="vc-field">
                  <label className="vc-label">分镜描述</label>
                  <input
                    className="vc-input"
                    aria-label="分镜描述输入"
                    data-testid="inspector-desc-input"
                    value={editDraftDescription}
                    onChange={(e) => setEditDraftDescription(e.target.value)}
                  />
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                  <button
                    type="button"
                    className="vc-btn vc-btn-primary"
                    style={{ flex: 1 }}
                    data-testid="inspector-save-btn"
                    onClick={() =>
                      void handleSaveShotDescription(
                        activeShotId,
                        editDraftDescription,
                      )
                    }
                  >
                    保存分镜描述
                  </button>
                </div>

                <div className="vc-field">
                  <label className="vc-label">持续帧数</label>
                  <input
                    type="number"
                    className="vc-input"
                    value={editDraftDuration}
                    onChange={(e) =>
                      setEditDraftDuration(Number(e.target.value))
                    }
                  />
                </div>

                <div className="vc-field">
                  <label className="vc-label">画面提示词</label>
                  <input
                    className="vc-input"
                    placeholder="描述首帧或参考画面构图..."
                    value={editDraftImagePrompt}
                    onChange={(e) => setEditDraftImagePrompt(e.target.value)}
                  />
                </div>

                <div className="vc-field">
                  <label className="vc-label">运镜提示词</label>
                  <input
                    className="vc-input"
                    placeholder="描述镜头运动与人物动作..."
                    value={editDraftVideoPrompt}
                    onChange={(e) => setEditDraftVideoPrompt(e.target.value)}
                  />
                </div>

                <button
                  type="button"
                  className="vc-btn"
                  style={{ width: "100%", marginBottom: 16 }}
                  onClick={() => void handleSaveShotExtended(activeShotId)}
                >
                  保存时长与生成提示词
                </button>

                <div className="vc-label" style={{ marginBottom: 8 }}>
                  已解析锁定设定
                </div>
                <div data-testid="inspector-resolved-subjects">
                  {Object.values(resolvedSubjects).map((rs) => (
                    <div
                      key={`${rs.subjectId}@${rs.subjectRevision}#${rs.resolvedVariant}`}
                      className="vc-subject-card"
                      data-testid={`resolved-subj-${rs.subjectId}`}
                    >
                      <div style={{ fontWeight: 600, fontSize: 12.5 }}>
                        {rs.snapshot.name} 第 {rs.subjectRevision} 版 [
                        {rs.resolvedVariant}]（{rs.referencePack.length} 张参考图）
                      </div>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "var(--text-secondary)",
                        }}
                      >
                        参考资产：
                        {rs.referencePack.map((r) => r.asset).join("、") ||
                          "无"}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {agentPanelOpen && (
            <aside className="vc-panel" data-testid="contextual-agent-panel">
              <div className="vc-panel-header">
                <h2 className="vc-panel-title">多 Agent 协作侧栏</h2>
                <span className="vc-badge vc-badge-approved">MCP 已就绪</span>
              </div>
              <div className="vc-panel-body">
                <p
                  style={{
                    margin: "0 0 12px",
                    padding: "8px 10px",
                    background: "var(--bg-input)",
                    borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--border-subtle)",
                    fontFamily: "monospace",
                    fontSize: 11.5,
                  }}
                  data-testid="agent-context-summary"
                >
                  项目: {projectId} | 编排: {compositionId}@r{headRevision} |
                  当前镜头: {activeShotId ?? "无"}
                </p>

                <div className="vc-label" style={{ marginBottom: 6 }}>
                  远程 MCP 接入端点（Streamable HTTP）
                </div>
                <div
                  className="vc-code-box"
                  style={{ marginBottom: 14, padding: "7px 10px" }}
                >
                  POST /mcp（24 个领域工具 · 乐观锁并发校验）
                </div>

                {revisionHistory.length > 0 && (
                  <>
                    <div className="vc-label" style={{ marginBottom: 6 }}>
                      不可变修订历史
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      {revisionHistory
                        .slice()
                        .reverse()
                        .slice(0, 6)
                        .map((rev) => (
                          <div
                            key={rev.revision}
                            style={{
                              padding: "8px 10px",
                              background: "var(--bg-card)",
                              border: "1px solid var(--border-subtle)",
                              borderRadius: "var(--radius-sm)",
                              fontSize: 12,
                            }}
                          >
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                              }}
                            >
                              <strong>修订 #{rev.revision}</strong>
                              <span className="vc-badge">
                                {rev.actorKind === "human" ? "人类" : "Agent"}:{" "}
                                {rev.actorId}
                              </span>
                            </div>
                            {rev.message && (
                              <div
                                style={{
                                  color: "var(--text-secondary)",
                                  marginTop: 4,
                                }}
                              >
                                {rev.message}
                              </div>
                            )}
                          </div>
                        ))}
                    </div>
                  </>
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
