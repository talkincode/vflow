import React, { useCallback, useEffect, useRef, useState } from "react";
import type { VFlowClient } from "@vflow/client";
import type {
  AssetRecord,
  SubjectRecord,
  TypedOperation,
} from "@vflow/domain";
import {
  AUTHORING_POLICY_VERSION,
  AUTHORING_PROMPTS,
  AUTHORING_VERSION,
  REQUIRED_REVIEW_CHECKS,
  MaterialDocumentSchema,
  renderAuthoringPrompt,
  type CompositionDocument,
  type MaterialDocument,
  type MaterialRecord,
  type MaterialRevision,
  type ReferencePack,
  type ReferenceOwner,
  type ReferencePurpose,
  type GenerationInputPacket,
  type GenerationEvidence,
} from "@vflow/protocol";
import { MediaPreview } from "./MediaPreview.tsx";

const categories: Record<ReferencePack["category"], string> = {
  moodboard: "原始 / 混合板（仅归档）",
  character_face: "人物 · 面部",
  character_body: "人物 · 身体与服装",
  prop_views: "单道具 · 多角度",
  prop_catalog: "多道具 · 逐格目录",
  scene_views: "场景 · 多机位",
  layout: "空间布局",
  single_frame: "单帧候选",
};
const json = (value: unknown) => JSON.stringify(value, null, 2);
const newId = () => crypto.randomUUID();
function template(kind: string, owner?: ReferenceOwner): MaterialDocument {
  const common = {
    schemaVersion: AUTHORING_VERSION,
    id: `reference-${newId()}`,
    title: "新参考素材",
  };
  if (kind === "scene")
    return {
      ...common,
      kind,
      geometry: "填写固定地形结构与动作轴线",
      anchors: {
        support_main: {
          description: "填写角色所处的实际承托面",
          supportSurface: true,
        },
      },
      environmentVariants: {
        base: { time: "待确认", weather: "待确认", state: "待确认环境状态" },
      },
    };
  if (kind === "storyboard_sequence")
    return {
      ...common,
      kind,
      compositionId: "",
      compositionRevision: 1,
      captionPolicy: "forbidden",
      panels: [],
    };
  return {
    ...common,
    kind: "reference_pack",
    category: kind as ReferencePack["category"],
    ...(owner && !["prop_catalog", "moodboard"].includes(kind)
      ? { owner }
      : {}),
    views: [],
    sources: [],
    conflicts: [],
  };
}
interface Props {
  client: VFlowClient;
  projectId: string;
  composition: CompositionDocument;
  compositionRevision: number;
  assets: AssetRecord[];
  subjects: SubjectRecord[];
  activeShotId: string | null;
  disabled: boolean;
  active: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  patch: (operations: TypedOperation[], message: string) => Promise<void>;
}
export function AuthoringPanel({
  client,
  projectId,
  composition,
  compositionRevision,
  assets,
  subjects,
  activeShotId,
  disabled,
  active,
  onDirtyChange,
  patch,
}: Props): React.ReactElement {
  const [workflow, setWorkflow] =
    useState<Awaited<ReturnType<VFlowClient["getAuthoringWorkflow"]>>>();
  const [records, setRecords] = useState<MaterialRecord[]>([]);
  const [current, setCurrent] = useState<MaterialRevision>();
  const [draft, setDraft] = useState("");
  const [category, setCategory] = useState("character_face");
  const [ownerKey, setOwnerKey] = useState("");
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<
    Record<string, "pass" | "fail" | "unknown">
  >({});
  const [evidence, setEvidence] = useState("");
  const [decision, setDecision] = useState<"accepted" | "rejected" | "unknown">(
    "unknown",
  );
  const [promptName, setPromptName] = useState(AUTHORING_PROMPTS[0].name);
  const [brief, setBrief] = useState("");
  const [prompt, setPrompt] = useState("");
  const [request, setRequest] = useState("");
  const [packet, setPacket] = useState<GenerationInputPacket>();
  const [reports, setReports] = useState<GenerationEvidence[]>([]);
  const [actual, setActual] = useState("[]");
  const [outputs, setOutputs] = useState("");
  const [executionNote, setExecutionNote] = useState("");
  const [method, setMethod] =
    useState<GenerationEvidence["method"]>("manual_unknown");
  const operation = useRef(newId());
  const lock = useRef(false);
  const reload = useCallback(async () => {
    const [w, r, e] = await Promise.all([
      client.getAuthoringWorkflow(projectId),
      client.listAuthoringDocuments(projectId),
      client.listGenerationEvidence(projectId),
    ]);
    setWorkflow(w);
    setRecords(r);
    setReports(e);
  }, [client, projectId]);
  useEffect(() => {
    if (active) void reload().catch((e) => setError(String(e.message ?? e)));
  }, [active, reload]);
  const run = async (fn: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      operation.current = newId();
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)}（草稿已保留）`);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const parsed = MaterialDocumentSchema.safeParse(
    draft
      ? (() => {
          try {
            return JSON.parse(draft);
          } catch {
            return null;
          }
        })()
      : null,
  );
  const doc = parsed.success ? parsed.data : undefined;
  const items =
    doc?.kind === "reference_pack"
      ? doc.views
      : doc?.kind === "storyboard_sequence"
        ? doc.panels
        : [];
  const item = items.find((i) => i.id === selected);
  const required =
    doc && doc.kind !== "policy"
      ? REQUIRED_REVIEW_CHECKS[
          doc.kind === "reference_pack" ? doc.category : doc.kind
        ]
      : [];
  const owners: ReferenceOwner[] = subjects.flatMap((s) =>
    Object.values(s.revisions).flatMap((r) =>
      Object.keys(r.variants).map((variant) => ({
        kind: r.kind,
        id: r.id,
        revision: r.revision,
        variant,
      })),
    ),
  );
  records.forEach((r) =>
    Object.values(r.revisions).forEach((rev) => {
      if (rev.document.kind === "scene")
        Object.keys(rev.document.environmentVariants).forEach((variant) =>
          owners.push({
            kind: "scene",
            id: r.id,
            revision: rev.revision,
            variant,
          }),
        );
    }),
  );
  const ownerValue = (o: ReferenceOwner) =>
    `${o.kind}:${o.id}@${o.revision}/${o.variant}`;
  const chosenOwner = owners.find((o) => ownerValue(o) === ownerKey);
  const update = (next: MaterialDocument) => {
    setDraft(json(next));
    setPacket(undefined);
  };
  const choose = (id: string) => {
    setSelected(id);
    setChecks({});
    setEvidence("");
    setDecision("unknown");
  };
  const load = (rev: MaterialRevision) => {
    setCurrent(rev);
    update(rev.document);
    choose("");
  };
  const showAsset = (id?: string) => {
    const a = assets.find((a) => a.id === id);
    return a ? (
      <MediaPreview
        key={a.id}
        asset={a}
        url={client.assetContentUrl(projectId, a.id)}
      />
    ) : (
      <p className="muted">尚未选择独立图片</p>
    );
  };
  const mutateItem = (change: Record<string, unknown>) => {
    if (
      !doc ||
      (doc.kind !== "reference_pack" && doc.kind !== "storyboard_sequence")
    )
      return;
    const next = structuredClone(doc);
    const entries = next.kind === "reference_pack" ? next.views : next.panels;
    const entry = entries.find((i) => i.id === selected);
    if (entry) {
      Object.assign(entry, change);
      delete entry.review;
      update(next);
    }
  };
  const saved = current && draft === json(current.document);
  useEffect(() => {
    onDirtyChange?.(
      !disabled &&
        ((!!draft && draft !== json(current?.document)) ||
          !!evidence ||
          Object.keys(checks).length > 0),
    );
  }, [draft, current, evidence, checks, disabled, onDirtyChange]);
  return (
    <div className="authoring-workspace">
      <header className="authoring-intro">
        <div>
          <p className="eyebrow">
            REFERENCE WORKFLOW ·{" "}
            {workflow?.mode === "strict" ? "严格制作" : "旧项目兼容"}
          </p>
          <h2>先把参考说清楚，再进入镜头</h2>
          <p>
            身份、服装、道具和场景分别固定。描述与审阅放在图外，视频只接收明确选中的独立图片。
          </p>
        </div>
        <button onClick={() => void run(reload)} disabled={busy}>
          刷新制作规则
        </button>
      </header>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <details className="authoring-rules">
        <summary>制作规则与 Agent 提示模板</summary>
        <pre>{workflow?.rules}</pre>
        <label>
          制作模板
          <select
            value={promptName}
            onChange={(e) => setPromptName(e.target.value)}
          >
            {AUTHORING_PROMPTS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          本次要求
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} />
        </label>
        <button
          onClick={() =>
            void run(async () =>
              setPrompt(
                renderAuthoringPrompt(promptName, {
                  projectId,
                  brief,
                  language: "zh",
                }),
              ),
            )
          }
        >
          展开制作提示
        </button>
        {prompt && <pre>{prompt}</pre>}
      </details>
      <div className="authoring-columns">
        <aside className="authoring-catalog">
          <h3>参考与场景</h3>
          {records.map((r) => (
            <button
              key={r.id}
              className={current?.document.id === r.id ? "selected" : ""}
              onClick={() => load(r.revisions[r.headRevision])}
            >
              <strong>{r.revisions[r.headRevision].document.title}</strong>
              <span>
                {r.revisions[r.headRevision].document.kind} · r{r.headRevision}{" "}
                · {r.revisions[r.headRevision].status}
              </span>
            </button>
          ))}
          <fieldset disabled={disabled || busy}>
            <legend>新建制作资料</legend>
            <label>
              素材类型
              <select
                aria-label="新建参考类型"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {Object.entries(categories).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
                <option value="scene">场景定义与环境状态</option>
                <option value="storyboard_sequence">无字分镜序列</option>
              </select>
            </label>
            <label>
              归属与固定版本
              <select
                aria-label="参考归属"
                value={ownerKey}
                onChange={(e) => setOwnerKey(e.target.value)}
              >
                <option value="">先选择角色 / 道具 / 场景</option>
                {owners.map((o) => (
                  <option key={ownerValue(o)} value={ownerValue(o)}>
                    {ownerValue(o)}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => {
                const t = template(category, chosenOwner);
                if (t.kind === "storyboard_sequence") {
                  t.compositionId = composition.id;
                  t.compositionRevision = compositionRevision;
                }
                setCurrent(undefined);
                update(t);
                choose("");
              }}
            >
              创建候选草稿
            </button>
          </fieldset>
        </aside>
        <main className="authoring-editor">
          {draft ? (
            <>
              {current && (
                <label>
                  查看不可变历史
                  <select
                    aria-label="参考历史版本"
                    value={current.revision}
                    onChange={(e) => {
                      const record = records.find(
                        (r) => r.id === current.document.id,
                      );
                      if (record)
                        load(record.revisions[Number(e.target.value)]);
                    }}
                  >
                    {Object.values(
                      records.find((r) => r.id === current.document.id)
                        ?.revisions ?? {},
                    ).map((r) => (
                      <option key={r.revision} value={r.revision}>
                        r{r.revision} · {r.status}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {doc && (
                <>
                  <div className="authoring-fields">
                    <label>
                      资料 ID
                      <input
                        aria-label="参考资料 ID"
                        value={doc.id}
                        disabled={!!current || disabled}
                        onChange={(e) => update({ ...doc, id: e.target.value })}
                      />
                    </label>
                    <label>
                      名称
                      <input
                        aria-label="参考名称"
                        value={doc.title}
                        disabled={disabled}
                        onChange={(e) =>
                          update({ ...doc, title: e.target.value })
                        }
                      />
                    </label>
                  </div>
                  {doc.kind === "scene" && (
                    <>
                      <label>
                        固定几何与动作轴线
                        <textarea
                          aria-label="场景几何"
                          disabled={disabled}
                          value={doc.geometry}
                          onChange={(e) =>
                            update({ ...doc, geometry: e.target.value })
                          }
                        />
                      </label>
                      <h4>支撑面与环境变体</h4>
                      <pre>
                        {json({
                          anchors: doc.anchors,
                          environmentVariants: doc.environmentVariants,
                        })}
                      </pre>
                    </>
                  )}
                  {doc.kind === "reference_pack" && (
                    <>
                      <p>
                        {categories[doc.category]} ·{" "}
                        {doc.owner ? ownerValue(doc.owner) : "逐格指定归属"}
                      </p>
                      <button
                        disabled={disabled || !chosenOwner}
                        onClick={() => {
                          const owner = doc.owner ?? chosenOwner!;
                          const purpose: ReferencePurpose =
                            doc.category === "character_face"
                              ? "face_identity"
                              : doc.category === "character_body"
                                ? "wardrobe"
                                : doc.category.startsWith("prop_")
                                  ? "prop"
                                  : doc.category === "layout"
                                    ? "layout"
                                    : doc.category === "scene_views"
                                      ? "environment"
                                      : "style";
                          const id = `view-${doc.views.length + 1}`;
                          update({
                            ...doc,
                            views: [
                              ...doc.views,
                              {
                                id,
                                asset:
                                  assets.find((a) =>
                                    a.mimeType.startsWith("image/"),
                                  )?.id ?? "选择图片",
                                owner,
                                purpose,
                                view: doc.views.length ? "side" : "front",
                                ...(owner.kind === "scene"
                                  ? {
                                      environmentVariant: owner.variant,
                                      cameraView: "wide",
                                    }
                                  : {}),
                              },
                            ],
                          });
                          choose(id);
                        }}
                      >
                        添加独立视图
                      </button>
                    </>
                  )}
                  {doc.kind === "storyboard_sequence" && (
                    <>
                      <p>
                        无字序列 · 编排 {doc.compositionId}@
                        {doc.compositionRevision} · 文字规则：禁止图内说明
                      </p>
                      <button
                        disabled={disabled}
                        onClick={() => {
                          const scene =
                            chosenOwner?.kind === "scene"
                              ? records.find((r) => r.id === chosenOwner.id)
                                  ?.revisions[chosenOwner.revision]
                              : undefined;
                          const id = `panel-${doc.panels.length + 1}`;
                          const bindings =
                            composition.shots[
                              activeShotId ?? composition.sequence[0]
                            ]?.subjects ?? [];
                          const viewSources = (
                            composition.authoring?.materials ?? []
                          ).flatMap((pin) => {
                            const rev = records.find((r) => r.id === pin.id)
                              ?.revisions[pin.revision];
                            if (
                              rev?.status !== "approved" ||
                              rev.document.kind !== "reference_pack"
                            )
                              return [];
                            const view = rev.document.views.find((v) =>
                              v.owner.kind === "scene"
                                ? !!chosenOwner &&
                                  v.owner.id === chosenOwner.id &&
                                  v.owner.revision === chosenOwner.revision &&
                                  v.owner.variant === chosenOwner.variant
                                : bindings.some(
                                    (b) =>
                                      b.subjectId === v.owner.id &&
                                      b.subjectRevision === v.owner.revision &&
                                      (b.variant ??
                                        subjects.find(
                                          (s) => s.id === b.subjectId,
                                        )?.revisions[b.subjectRevision]
                                          ?.defaultVariant) === v.owner.variant,
                                  ),
                            );
                            return view ? [{ pack: pin, viewId: view.id }] : [];
                          });
                          update({
                            ...doc,
                            panels: [
                              ...doc.panels,
                              {
                                id,
                                order: doc.panels.length,
                                momentFrame: doc.panels.length,
                                shotId: activeShotId ?? composition.sequence[0],
                                asset:
                                  assets.find((a) =>
                                    a.mimeType.startsWith("image/"),
                                  )?.id ?? "选择图片",
                                scene: {
                                  id: scene?.document.id ?? "先创建场景",
                                  revision: scene?.revision ?? 1,
                                },
                                environmentVariant:
                                  chosenOwner?.kind === "scene"
                                    ? chosenOwner.variant
                                    : "选择环境变体",
                                cameraView: "特写 / 中景 / 远景及轴线侧",
                                sources: viewSources,
                                entities: (
                                  composition.shots[
                                    activeShotId ?? composition.sequence[0]
                                  ]?.subjects ?? []
                                ).map((binding) => {
                                  const subject = subjects.find(
                                    (s) => s.id === binding.subjectId,
                                  )?.revisions[binding.subjectRevision];
                                  return {
                                    subject: {
                                      kind: subject?.kind ?? "character",
                                      id: binding.subjectId,
                                      revision: binding.subjectRevision,
                                      variant:
                                        binding.variant ??
                                        subject?.defaultVariant ??
                                        "default",
                                    },
                                    visibility: "hidden" as const,
                                    bounds: [0, 0, 0, 0] as [
                                      number,
                                      number,
                                      number,
                                      number,
                                    ],
                                    facing: "待核对朝向",
                                    state: "待根据单帧核对可见性与状态",
                                    occlusion: "待核对遮挡与画外位置",
                                  };
                                }),
                                transition: "填写出现、退出、朝向和状态变化",
                                textPolicy: "forbidden",
                              },
                            ],
                          });
                          choose(id);
                        }}
                      >
                        添加序列单帧
                      </button>
                    </>
                  )}
                  {doc &&
                    "board" in doc &&
                    doc.board &&
                    (() => {
                      const board = assets.find(
                        (a) => a.id === doc.board!.asset,
                      );
                      return board?.width && board.height ? (
                        <div className="reference-board-map">
                          <img
                            src={client.assetContentUrl(projectId, board.id)}
                            alt={`原板 ${board.id}`}
                          />
                          <svg
                            viewBox={`0 0 ${board.width} ${board.height}`}
                            aria-label="宫格单元选择"
                          >
                            {items
                              .filter((i) => i.source)
                              .map((i) => (
                                <rect
                                  key={i.id}
                                  x={i.source!.regionPx.x}
                                  y={i.source!.regionPx.y}
                                  width={i.source!.regionPx.width}
                                  height={i.source!.regionPx.height}
                                  className={
                                    selected === i.id ? "selected" : ""
                                  }
                                  role="button"
                                  tabIndex={0}
                                  aria-label={`选择单格 ${i.id}`}
                                  onClick={() => choose(i.id)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      choose(i.id);
                                    }
                                  }}
                                />
                              ))}
                          </svg>
                        </div>
                      ) : null;
                    })()}
                  <div className="reference-tile-strip">
                    {items.map((i) => (
                      <button
                        key={i.id}
                        aria-pressed={selected === i.id}
                        onClick={() => choose(i.id)}
                      >
                        <span>{i.id}</span>
                        <small>
                          {i.asset} · {i.review?.decision ?? "未检查"}
                        </small>
                      </button>
                    ))}
                  </div>
                  {item && (
                    <div className="reference-inspector">
                      <div>
                        {showAsset(item.asset)}
                        {item.source && (
                          <details>
                            <summary>来源原板与裁切区域</summary>
                            {showAsset(item.source.asset)}
                            <pre>{json(item.source)}</pre>
                          </details>
                        )}
                      </div>
                      <div>
                        <label>
                          当前独立图片
                          <select
                            aria-label="当前参考图片"
                            disabled={disabled}
                            value={item.asset}
                            onChange={(e) =>
                              mutateItem({ asset: e.target.value })
                            }
                          >
                            <option value="">请选择</option>
                            {assets
                              .filter((a) => a.mimeType.startsWith("image/"))
                              .map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.id}
                                </option>
                              ))}
                          </select>
                        </label>
                        {"owner" in item ? (
                          <>
                            <p>
                              归属：{ownerValue(item.owner)}
                              <br />
                              用途：{item.purpose}
                            </p>
                            <label>
                              视角
                              <input
                                aria-label="参考视角"
                                disabled={disabled}
                                value={item.view}
                                onChange={(e) =>
                                  mutateItem({ view: e.target.value })
                                }
                              />
                            </label>
                          </>
                        ) : (
                          <>
                            <p>
                              第 {item.order + 1} 格 · {item.shotId} +
                              {item.momentFrame}f<br />
                              {item.environmentVariant} · {item.cameraView}
                            </p>
                            <p>{item.transition}</p>
                            <pre>{json(item.entities)}</pre>
                          </>
                        )}
                        <p className="muted">
                          预览加载成功只表示图片可见；下方审阅项决定能否成为制作参考。
                        </p>
                      </div>
                    </div>
                  )}
                </>
              )}
              <details open={!doc}>
                <summary>完整结构与来源清单（图外 sidecar）</summary>
                <textarea
                  className="manifest-editor"
                  aria-label="参考结构 JSON"
                  value={draft}
                  disabled={disabled}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setPacket(undefined);
                  }}
                />
                <p>
                  配置宫格尺寸、独立
                  tile、source.regionPx、来源版本；序列的角色位置、支撑面、持物与变化写在这里。
                </p>
              </details>
              <div className="authoring-actions">
                <button
                  disabled={busy || !current}
                  onClick={() =>
                    void run(async () => {
                      const impact = await client.getAuthoringImpact(
                        projectId,
                        current!.document.id,
                        current!.revision,
                      );
                      setNotice(`来源影响（历史不变）：${json(impact)}`);
                    })
                  }
                >
                  查看来源影响
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await client.validateAuthoringDocument(
                        projectId,
                        JSON.parse(draft),
                      );
                      setNotice(
                        result.ready
                          ? "结构与已记录审阅均通过。"
                          : result.diagnostics
                              .map(
                                (d) =>
                                  `${d.code}: ${d.path} · ${d.message} ${d.action}`,
                              )
                              .join("\n"),
                      );
                    })
                  }
                >
                  校验参考
                </button>
                <button
                  disabled={disabled || busy}
                  onClick={() =>
                    void run(async () => {
                      const result = await client.putAuthoringDocument({
                        projectId,
                        baseRevision: current?.revision ?? 0,
                        operationId: operation.current,
                        document: JSON.parse(draft),
                      });
                      await reload();
                      load(result);
                      setNotice("候选修订已保存，尚未批准。");
                    })
                  }
                >
                  保存候选修订
                </button>
                <button
                  disabled={disabled || busy || !saved}
                  onClick={() =>
                    void run(async () => {
                      const result = await client.approveAuthoringDocument({
                        projectId,
                        id: current!.document.id,
                        baseRevision: current!.revision,
                        operationId: operation.current,
                      });
                      await reload();
                      load(result);
                      setNotice("参考已批准；旧修订与镜头绑定保持原样。");
                    })
                  }
                >
                  批准为参考
                </button>
                <button
                  disabled={
                    disabled || busy || current?.status !== "approved" || !saved
                  }
                  onClick={() =>
                    void run(async () => {
                      await patch(
                        [
                          {
                            op: "set_authoring",
                            authoring: {
                              policyVersion: AUTHORING_POLICY_VERSION,
                              materials: [
                                ...(
                                  composition.authoring?.materials ?? []
                                ).filter((p) => p.id !== current!.document.id),
                                {
                                  id: current!.document.id,
                                  revision: current!.revision,
                                },
                              ],
                            },
                          },
                        ],
                        "固定已批准参考版本",
                      );
                      setNotice(
                        "已在新编排修订中固定此参考，镜头顺序与时长保持原样。",
                      );
                    })
                  }
                >
                  固定到此编排
                </button>
              </div>
              {doc && doc.kind !== "policy" && (
                <fieldset disabled={disabled || busy || !saved}>
                  <legend>
                    逐项视觉审阅 ·{" "}
                    {doc.kind === "scene"
                      ? "场景定义"
                      : selected || "先选择一格"}
                  </legend>
                  {required.map((c) => (
                    <label key={c}>
                      {c}
                      <select
                        aria-label={`检查 ${c}`}
                        value={checks[c] ?? "unknown"}
                        onChange={(e) =>
                          setChecks({
                            ...checks,
                            [c]: e.target.value as "pass" | "fail" | "unknown",
                          })
                        }
                      >
                        <option value="unknown">未检查 / 无法确认</option>
                        <option value="pass">通过</option>
                        <option value="fail">失败</option>
                      </select>
                    </label>
                  ))}
                  <label>
                    结论
                    <select
                      aria-label="视觉审阅结论"
                      value={decision}
                      onChange={(e) =>
                        setDecision(e.target.value as typeof decision)
                      }
                    >
                      <option value="unknown">待确认</option>
                      <option value="accepted">接受</option>
                      <option value="rejected">否决</option>
                    </select>
                  </label>
                  <label>
                    审阅证据与理由
                    <textarea
                      aria-label="审阅证据"
                      value={evidence}
                      onChange={(e) => setEvidence(e.target.value)}
                    />
                  </label>
                  <button
                    disabled={!current || (doc.kind !== "scene" && !selected)}
                    onClick={() =>
                      void run(async () => {
                        const result = await client.reviewAuthoringDocument({
                          projectId,
                          id: current!.document.id,
                          baseRevision: current!.revision,
                          operationId: operation.current,
                          targets: [
                            doc.kind === "scene" ? "$document" : selected,
                          ],
                          review: {
                            decision,
                            method: "human",
                            reviewer: "current-user",
                            evidence,
                            checks,
                          },
                        });
                        await reload();
                        load(result);
                        choose(selected);
                        setNotice("审阅已形成新修订；仍须明确批准。");
                      })
                    }
                  >
                    记录当前项审阅
                  </button>
                </fieldset>
              )}
            </>
          ) : (
            <div className="authoring-empty">
              <h3>从一份清晰的参考开始</h3>
              <p>
                先在左侧选择类型和归属。人物面部与服装分开，道具和场景各自建档；上传原图可在“素材”页完成。
              </p>
            </div>
          )}
        </main>
      </div>
      <section className="generation-inspector">
        <h3>本次生成输入</h3>
        <p>
          先取得目标工具本次的图片数量和用途能力，再准备输入包。这里不会调用模型或消耗点数。
        </p>
        <button
          disabled={busy}
          onClick={() => {
            const bindings =
              composition.shots[activeShotId ?? composition.sequence[0]]
                ?.subjects ?? [];
            const inputs = (composition.authoring?.materials ?? []).flatMap(
              (pin) => {
                const rev = records.find((r) => r.id === pin.id)?.revisions[
                  pin.revision
                ];
                if (
                  rev?.status !== "approved" ||
                  rev.document.kind !== "reference_pack"
                )
                  return [];
                const view = rev.document.views.find((v) =>
                  v.owner.kind === "scene"
                    ? chosenOwner?.kind === "scene" &&
                      v.owner.id === chosenOwner.id &&
                      v.owner.revision === chosenOwner.revision &&
                      v.owner.variant === chosenOwner.variant
                    : bindings.some(
                        (b) =>
                          b.subjectId === v.owner.id &&
                          b.subjectRevision === v.owner.revision &&
                          (b.variant ??
                            subjects.find((s) => s.id === b.subjectId)
                              ?.revisions[b.subjectRevision]
                              ?.defaultVariant) === v.owner.variant,
                      ),
                );
                return view
                  ? [
                      {
                        source: { pack: pin, viewId: view.id },
                        role: view.purpose,
                        wholeBoard: false,
                      },
                    ]
                  : [];
              },
            );
            setRequest(
              json({
                compositionId: composition.id,
                compositionRevision,
                shotId: activeShotId ?? composition.sequence[0],
                inputs,
                capabilities: {
                  verifiedAt: "",
                  evidence: "",
                  maxImages: 0,
                  roles: [...new Set(inputs.map((i) => i.role))],
                  supportsGridSequence: false,
                },
                prompt: "",
                templateVersion: AUTHORING_POLICY_VERSION,
              }),
            );
            setPacket(undefined);
          }}
        >
          新建输入计划
        </button>
        <label>
          输入计划 JSON
          <textarea
            className="manifest-editor"
            aria-label="生成输入计划"
            value={request}
            onChange={(e) => {
              setRequest(e.target.value);
              setPacket(undefined);
            }}
          />
        </label>
        <button
          disabled={busy || !request}
          onClick={() =>
            void run(async () => {
              const result = await client.prepareGenerationInputs(
                projectId,
                JSON.parse(request),
              );
              setPacket(result.packet);
              setNotice(
                result.ready
                  ? "输入包准备完毕，尚未执行生成。"
                  : result.diagnostics
                      .map((d) => `${d.code}: ${d.message} ${d.action}`)
                      .join("\n"),
              );
              if (result.packet)
                setActual(
                  json(
                    result.packet.inputs.map(({ asset, sha256, role }) => ({
                      asset,
                      sha256,
                      role,
                    })),
                  ),
                );
            })
          }
        >
          准备并检查输入包
        </button>
        {packet && (
          <div data-testid="generation-packet">
            <p>固定输入 · {packet.hash}</p>
            <div className="packet-images">
              {packet.inputs.map((i, n) => (
                <article key={`${n}-${i.asset}`}>
                  {showAsset(i.asset)}
                  <p>
                    {n + 1}. {i.role} · {i.asset}
                  </p>
                  <small>{i.sha256}</small>
                </article>
              ))}
            </div>
            <details>
              <summary>输入包完整清单</summary>
              <pre>{json(packet)}</pre>
            </details>
            <fieldset disabled={disabled || busy}>
              <legend>回填外部实际输入</legend>
              <label>
                实际输入（保留真实顺序）
                <textarea
                  aria-label="实际输入记录"
                  value={actual}
                  onChange={(e) => setActual(e.target.value)}
                />
              </label>
              <label>
                输出素材 ID（逗号分隔）
                <input
                  value={outputs}
                  onChange={(e) => setOutputs(e.target.value)}
                />
              </label>
              <label>
                证据等级
                <select
                  value={method}
                  onChange={(e) => setMethod(e.target.value as typeof method)}
                >
                  <option value="manual_unknown">尚无法确认实际使用</option>
                  <option value="agent_reported">外部 Agent 回报</option>
                  <option value="request_capture">有外部请求捕获证据</option>
                </select>
              </label>
              <label>
                实际执行证据
                <textarea
                  value={executionNote}
                  onChange={(e) => setExecutionNote(e.target.value)}
                />
              </label>
              <button
                onClick={() =>
                  void run(async () => {
                    await client.recordGenerationEvidence({
                      projectId,
                      id: `execution-${operation.current}`,
                      operationId: operation.current,
                      packet,
                      actualInputs: JSON.parse(actual),
                      outputs: outputs
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                      method,
                      evidence: executionNote,
                    });
                    await reload();
                    setNotice(
                      "实际输入证据已保存；请根据差异决定是否采用输出。",
                    );
                  })
                }
              >
                保存执行证据
              </button>
            </fieldset>
          </div>
        )}
        <h4>实际使用与计划差异</h4>
        {reports.map((r) => (
          <details key={r.id}>
            <summary>
              {r.id} ·{" "}
              {r.matchesPlan ? "回报输入与计划一致" : "不同或尚无法确认"} ·{" "}
              {r.method}
            </summary>
            <p>{r.evidence}</p>
            <div className="packet-images">
              {r.actualInputs.map((i, n) => (
                <article key={`${n}-${i.asset}`}>
                  {showAsset(i.asset)}
                  <p>
                    {n + 1}. {i.role} · {i.asset}
                  </p>
                </article>
              ))}
            </div>
            <pre>
              {json({
                planned: r.packet.inputs.map(({ asset, role }) => ({
                  asset,
                  role,
                })),
                actual: r.actualInputs,
                outputs: r.outputs,
              })}
            </pre>
          </details>
        ))}
      </section>
    </div>
  );
}
