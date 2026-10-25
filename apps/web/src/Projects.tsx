import type { VideoComposeClient } from "@video-compose/client";
import { DomainError } from "@video-compose/domain";
import { PROTOCOL_VERSION } from "@video-compose/protocol";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Workbench } from "./Workbench.tsx";
import { compositionUrl, projectUrl } from "./routes.ts";

type Navigate = (url: string) => void;
const navigateTo: Navigate = (url) => window.location.assign(url);
const nextId = (kind: string): string =>
  `${kind}-${crypto.randomUUID().slice(0, 8)}`;

function errorMessage(error: unknown): string {
  if (error instanceof DomainError) {
    if (error.code === "FORBIDDEN")
      return "你没有这个项目的访问权限，或当前权限不允许此操作。";
    if (error.code === "NOT_FOUND")
      return "没有找到这个项目或编排，请检查链接。";
    if (error.code === "UNAUTHORIZED")
      return "登录已失效，请刷新页面重新登录。";
    if (error.code === "ALREADY_EXISTS")
      return "这个链接标识已被使用，请在下方换一个标识后重试。";
    if (error.code === "VALIDATION_FAILED")
      return "填写的内容不符合要求，请核对名称、链接标识和画面规格后重试。";
  }
  return "暂时无法完成操作，请重试。已填写的内容仍然保留。";
}

function useRemote<T>(read: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const onShow = (event: PageTransitionEvent): void => {
      if (event.persisted) setAttempt((n) => n + 1);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);
  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    void read()
      .then((value) => {
        if (active) setData(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [read, attempt]);
  return { data, error, reload: () => setAttempt((n) => n + 1) };
}

function PageHeader({
  children,
}: {
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <header className="app-header project-header">
      <a className="brand" href="/" aria-label="Video Compose 首页">
        <img src="/logo.svg" alt="" width="34" height="34" />
        <span>
          Video Compose<small>作品编排与协作</small>
        </span>
      </a>
      <nav aria-label="项目导航">{children ?? <span>项目管理</span>}</nav>
    </header>
  );
}

export function PageError({
  message,
  onRetry,
  projectId,
}: {
  message: string;
  onRetry?: () => void;
  projectId?: string;
}): React.ReactElement {
  return (
    <div className="project-shell">
      <PageHeader>
        <a href="/">全部项目</a>
      </PageHeader>
      <main className="project-error">
        <span className="eyebrow">无法打开此空间</span>
        <h1>暂时无法继续</h1>
        <p role="alert">{message}</p>
        <div className="toolbar">
          {onRetry && <button onClick={onRetry}>重新加载</button>}
          {projectId && (
            <a className="button-link" href={projectUrl(projectId)}>
              返回项目
            </a>
          )}
          <a className="button-link primary" href="/">
            返回项目列表
          </a>
        </div>
      </main>
    </div>
  );
}

function LoadingPage(): React.ReactElement {
  return (
    <div className="project-shell">
      <PageHeader />
      <main className="project-content">
        <p role="status">正在加载项目…</p>
      </main>
    </div>
  );
}

export function ProjectsPage({
  client,
  navigate = navigateTo,
}: {
  client: VideoComposeClient;
  navigate?: Navigate;
}): React.ReactElement {
  const read = useCallback(() => client.listProjects(), [client]);
  const { data: projects, error, reload } = useRemote(read);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const visible = projects
    ?.filter((project) =>
      `${project.name} ${project.id} ${project.description ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .slice()
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name, "zh-CN")
        : b.createdAt.localeCompare(a.createdAt),
    );
  return (
    <div className="project-shell">
      <PageHeader />
      <main className="project-content">
        <div className="project-hero">
          <div>
            <span className="eyebrow">PROJECT LIBRARY / 创作空间</span>
            <h1>从一个项目开始</h1>
            <p>把编排、素材与角色设定放在一起，让每部作品都有自己的空间。</p>
          </div>
          <button className="primary" onClick={() => setCreating(true)}>
            ＋ 新建项目
          </button>
        </div>
        <div className="project-list-toolbar">
          <h2>
            全部项目 <span>{projects?.length ?? "—"}</span>
          </h2>
          <div className="toolbar">
            <input
              type="search"
              aria-label="搜索项目"
              placeholder="搜索名称、标识或简介"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="项目排序"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="recent">最近创建</option>
              <option value="name">按名称</option>
            </select>
            <button onClick={reload}>刷新项目</button>
          </div>
        </div>
        {error ? (
          <div className="project-inline-error" role="alert">
            {error}
            <button onClick={reload}>重试加载项目</button>
          </div>
        ) : !projects ? (
          <p role="status">正在加载项目…</p>
        ) : !projects.length ? (
          <div className="project-empty">
            <span aria-hidden="true">＋</span>
            <h2>这里还没有项目</h2>
            <p>新建一个项目，再创建第一条编排。</p>
          </div>
        ) : !visible?.length ? (
          <div className="project-empty">
            <h2>没有匹配的项目</h2>
            <p>试试名称、项目标识或简介中的其他关键词。</p>
            <button onClick={() => setQuery("")}>清除搜索</button>
          </div>
        ) : (
          <div className="project-grid">
            {visible.map((project, index) => (
              <a
                className="project-card"
                key={project.id}
                href={projectUrl(project.id)}
                aria-label={`打开项目 ${project.name}`}
                data-testid={`project-${project.id}`}
              >
                <div className="project-card-top">
                  <span className="project-monogram" aria-hidden="true">
                    {project.name.slice(0, 1)}
                  </span>
                  <span className="project-card-index">
                    {String(index + 1).padStart(2, "0")} ↗
                  </span>
                </div>
                <h2>{project.name}</h2>
                <p>{project.description || "尚未添加项目简介"}</p>
                <div className="project-card-footer">
                  <code>{project.id}</code>
                  <span>
                    {new Date(project.createdAt).toLocaleDateString("zh-CN")}
                  </span>
                </div>
              </a>
            ))}
          </div>
        )}
      </main>
      <CreateDialog
        client={client}
        kind="project"
        open={creating}
        onClose={() => setCreating(false)}
        navigate={navigate}
      />
    </div>
  );
}

export function ProjectPage({
  client,
  projectId,
  navigate = navigateTo,
}: {
  client: VideoComposeClient;
  projectId: string;
  navigate?: Navigate;
}): React.ReactElement {
  const read = useCallback(
    () => client.getProjectOverview(projectId),
    [client, projectId],
  );
  const { data, error, reload } = useRemote(read);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  if (error) return <PageError message={error} onRetry={reload} />;
  if (!data) return <LoadingPage />;
  const visible = data.compositions.filter((composition) =>
    `${composition.title ?? ""} ${composition.id}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const writer = data.role === "writer";
  return (
    <div className="project-shell">
      <PageHeader>
        <a href="/">全部项目</a>
        <span aria-hidden="true">/</span>
        <span>{data.project.name}</span>
      </PageHeader>
      <main className="project-content">
        <div className="project-hero">
          <div>
            <span className="eyebrow">PROJECT / {data.project.id}</span>
            <h1 data-testid="project-title">{data.project.name}</h1>
            <p>
              {data.project.description ||
                "在这里管理这个项目的编排，共享素材和角色设定。"}
            </p>
          </div>
          <span className="project-role" data-testid="project-role">
            {writer ? "可编辑项目" : "只读项目"}
          </span>
        </div>
        <dl className="project-stats">
          <div>
            <dt>编排</dt>
            <dd>{data.compositions.length}</dd>
          </div>
          <div>
            <dt>共享素材</dt>
            <dd>{data.assetCount}</dd>
          </div>
          <div>
            <dt>角色与道具</dt>
            <dd>{data.subjectCount}</dd>
          </div>
          <div>
            <dt>协作成员</dt>
            <dd>{Object.keys(data.project.members).length}</dd>
          </div>
        </dl>
        <div className="project-list-toolbar">
          <h2>项目编排</h2>
          <div className="toolbar">
            <input
              type="search"
              aria-label="搜索编排"
              placeholder="搜索标题或标识"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <button onClick={reload}>刷新编排</button>
            <button
              className="primary"
              disabled={!writer}
              onClick={() => setCreating(true)}
            >
              ＋ 新建编排
            </button>
          </div>
        </div>
        {!writer && (
          <p className="project-help">
            你可以查看编排和素材；在此项目中创建与编辑需要可编辑权限。
          </p>
        )}
        {!data.compositions.length ? (
          <div className="project-empty">
            <span aria-hidden="true">▤</span>
            <h2>还没有编排</h2>
            <p>
              {writer
                ? "新建第一条编排，设置画面规格并开始整理分镜。"
                : "有编辑权限的成员创建编排后，会显示在这里。"}
            </p>
          </div>
        ) : !visible.length ? (
          <div className="project-empty">
            <h2>没有匹配的编排</h2>
            <button onClick={() => setQuery("")}>清除搜索</button>
          </div>
        ) : (
          <div className="composition-grid">
            {visible.map((composition, index) => (
              <a
                className="composition-card"
                key={composition.id}
                href={compositionUrl(projectId, composition.id)}
                aria-label={`打开编排 ${composition.title || composition.id}`}
                data-testid={`composition-${composition.id}`}
              >
                <div className="composition-card-visual">
                  <span aria-hidden="true">▤</span>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <span className="badge">
                    修订 #{composition.headRevision}
                  </span>
                </div>
                <div className="composition-card-body">
                  <h3>{composition.title || composition.id}</h3>
                  <code>{composition.id}</code>
                  <span className="composition-open">进入工作台 →</span>
                </div>
              </a>
            ))}
          </div>
        )}
        <p className="project-help">
          素材和角色设定由此项目的编排共享，每条编排分别保留自己的分镜与修订。
        </p>
      </main>
      <CreateDialog
        client={client}
        kind="composition"
        projectId={projectId}
        open={creating && writer}
        onClose={() => setCreating(false)}
        navigate={navigate}
      />
    </div>
  );
}

export function CompositionWorkspace({
  client,
  projectId,
  compositionId,
}: {
  client: VideoComposeClient;
  projectId: string;
  compositionId: string;
}): React.ReactElement {
  const read = useCallback(
    () => client.getProjectOverview(projectId),
    [client, projectId],
  );
  const { data, error, reload } = useRemote(read);
  if (error) return <PageError message={error} onRetry={reload} />;
  if (!data) return <LoadingPage />;
  const navigation = (
    <nav className="project-breadcrumb" aria-label="项目与编排">
      <a href="/">全部项目</a>
      <span aria-hidden="true">/</span>
      <a href={projectUrl(projectId)} title={data.project.name}>
        {data.project.name}
      </a>
      <span aria-hidden="true">/</span>
      <label className="sr-only" htmlFor="composition-switcher">
        切换编排
      </label>
      <select
        id="composition-switcher"
        value={compositionId}
        onChange={(event) =>
          navigateTo(compositionUrl(projectId, event.target.value))
        }
      >
        {!data.compositions.some((item) => item.id === compositionId) && (
          <option value={compositionId}>{compositionId}</option>
        )}
        {data.compositions.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title || item.id}
          </option>
        ))}
      </select>
    </nav>
  );
  return (
    <Workbench
      client={client}
      projectId={projectId}
      compositionId={compositionId}
      navigation={navigation}
      allowBootstrap={false}
    />
  );
}

function CreateDialog({
  client,
  kind,
  projectId,
  open,
  onClose,
  navigate,
}: {
  client: VideoComposeClient;
  kind: "project" | "composition";
  projectId?: string;
  open: boolean;
  onClose: () => void;
  navigate: Navigate;
}): React.ReactElement | null {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [id, setId] = useState(() => nextId(kind));
  const [format, setFormat] = useState("landscape");
  const [fps, setFps] = useState("30");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const completed = useRef(false);
  const operationId = useRef(crypto.randomUUID());
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    completed.current = false;
    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    titleRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!open || (!name && !description && !pending)) return;
    const onLeave = (event: BeforeUnloadEvent): void => {
      if (completed.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [open, name, description, pending]);
  const create = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (pendingRef.current || !name.trim() || !id.trim()) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      if (kind === "project") {
        const project = await client.createProject({
          id: id.trim(),
          name: name.trim(),
          description: description.trim(),
          operationId: operationId.current,
        });
        finish(projectUrl(project.id));
      } else {
        if (!projectId) throw new Error("Project is required.");
        const [width, height] =
          format === "portrait"
            ? [1080, 1920]
            : format === "square"
              ? [1080, 1080]
              : [1920, 1080];
        await client.getAuthoringWorkflow(projectId);
        await client.createComposition({
          projectId,
          operationId: operationId.current,
          document: {
            apiVersion: PROTOCOL_VERSION,
            id: id.trim(),
            project: projectId,
            title: name.trim(),
            format: { width, height, fps: Number(fps) },
            audioTracks: [],
            sequence: ["shot-001"],
            shots: {
              "shot-001": {
                description: "第一镜",
                durationFrames: Number(fps) * 3,
                subjects: [],
                dependsOn: [],
                references: { images: [], videos: [] },
                prompts: {},
                candidates: { images: [], videos: [], audios: [] },
                selected: { video: null, audio: null },
              },
            },
          },
        });
        finish(compositionUrl(projectId, id.trim()));
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const finish = (url: string): void => {
    completed.current = true;
    setName("");
    setDescription("");
    setId(nextId(kind));
    setFormat("landscape");
    setFps("30");
    operationId.current = crypto.randomUUID();
    onClose();
    navigate(url);
  };
  if (!open) return null;
  const noun = kind === "project" ? "项目" : "编排";
  return (
    <div
      className="creation-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <div
        className="creation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="creation-title"
        ref={dialogRef}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pending) {
            event.preventDefault();
            onClose();
          }
          if (event.key === "Tab") {
            const controls = Array.from(
              dialogRef.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary",
              ) ?? [],
            ).filter((element) => element.getClientRects().length > 0);
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="creation-heading">
          <div>
            <span className="eyebrow">
              {kind === "project" ? "NEW PROJECT" : "NEW COMPOSITION"}
            </span>
            <h2 id="creation-title">新建{noun}</h2>
          </div>
          <button
            aria-label={`关闭新建${noun}`}
            onClick={onClose}
            disabled={pending}
          >
            ×
          </button>
        </div>
        <p>
          {kind === "project"
            ? "一个项目容纳多条编排，并共享素材和角色设定。"
            : "为这条编排设置画面规格，从第一条分镜开始。"}
        </p>
        <form
          onSubmit={(event) => void create(event)}
          onChange={() => {
            operationId.current = crypto.randomUUID();
          }}
        >
          <fieldset disabled={pending}>
            <label htmlFor="creation-name">{noun}名称</label>
            <input
              ref={titleRef}
              id="creation-name"
              required
              maxLength={160}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={
                kind === "project"
                  ? "例如：雨巷来信"
                  : "例如：第一集 · 雨夜来客"
              }
            />
            {kind === "project" ? (
              <>
                <label htmlFor="creation-description">项目简介</label>
                <textarea
                  id="creation-description"
                  rows={3}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="这部作品的主题、风格或协作目标（选填）"
                />
              </>
            ) : (
              <div className="creation-format">
                <label>
                  画面规格
                  <select
                    aria-label="画面规格"
                    value={format}
                    onChange={(event) => setFormat(event.target.value)}
                  >
                    <option value="landscape">横屏 16:9 · 1920 × 1080</option>
                    <option value="portrait">竖屏 9:16 · 1080 × 1920</option>
                    <option value="square">方形 1:1 · 1080 × 1080</option>
                  </select>
                </label>
                <label>
                  帧率
                  <select
                    aria-label="编排帧率"
                    value={fps}
                    onChange={(event) => setFps(event.target.value)}
                  >
                    {[24, 25, 30, 60].map((value) => (
                      <option key={value} value={value}>
                        {value} fps
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <details className="creation-identity">
              <summary>链接标识</summary>
              <label htmlFor="creation-id">{noun}标识</label>
              <input
                id="creation-id"
                required
                pattern="[A-Za-z0-9][A-Za-z0-9._-]*"
                maxLength={128}
                value={id}
                onChange={(event) => setId(event.target.value)}
              />
              <small>
                已自动生成。可使用英文字母、数字、点、横线或下划线，创建后用于固定链接。
              </small>
            </details>
          </fieldset>
          {error && (
            <p className="creation-error" role="alert">
              {error}
            </p>
          )}
          <div className="creation-actions">
            <button type="button" disabled={pending} onClick={onClose}>
              取消
            </button>
            <button
              className="primary"
              type="submit"
              disabled={pending || !name.trim()}
            >
              {pending ? "正在创建…" : `创建${noun}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
