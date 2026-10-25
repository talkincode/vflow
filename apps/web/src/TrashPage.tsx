import React, { useCallback, useEffect, useRef, useState } from "react";
import type { VideoComposeClient } from "@video-compose/client";
import type { TrashItem } from "@video-compose/domain";
import { AccountMenu } from "./AccountMenu.tsx";
export function TrashPage({
  client,
}: {
  client: VideoComposeClient;
}): React.ReactElement {
  const [items, setItems] = useState<TrashItem[] | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const ops = useRef(new Map<string, string>());
  const lock = useRef(false);
  const reload = useCallback(async () => {
    const result = await client.listTrash();
    setItems(result.items);
  }, [client]);
  useEffect(() => {
    void reload().catch((e) => setError(String(e.message ?? e)));
  }, [reload]);
  return (
    <div className="project-shell">
      <header className="app-header project-header">
        <a className="brand" href="/">
          Video Compose
        </a>
        <nav aria-label="项目导航">
          <a href="/">全部项目</a>
          <span>/ 回收站</span>
        </nav>
        <AccountMenu client={client} />
      </header>
      <main className="project-content">
        <div className="project-hero">
          <div>
            <span className="eyebrow">RECYCLE BIN / 内容仍然保留</span>
            <h1>回收站</h1>
            <p>
              恢复项目会重新开放其中的正常内容；单独删除的编排需要分别恢复。恢复父项目之前，不能恢复子编排。
            </p>
          </div>
          <button
            onClick={() => void reload().catch((e) => setError(e.message))}
            disabled={!!busy}
          >
            刷新回收站
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {!items ? (
          <p role="status">正在加载回收站…</p>
        ) : items.length === 0 ? (
          <div className="project-empty">
            <h2>回收站是空的</h2>
            <p>删除的项目和编排会显示在这里。</p>
          </div>
        ) : (
          <div className="trash-list">
            {items.map((item) => {
              const key = JSON.stringify([
                item.projectId,
                item.kind,
                item.id,
                item.lifecycleRevision,
              ]);
              return (
                <article
                  className="trash-card"
                  key={key}
                  data-testid={`trash-${item.kind}-${item.id}`}
                >
                  <div>
                    <span className="badge">
                      {item.kind === "project" ? "项目" : "编排"}
                    </span>
                    <h2>{item.title}</h2>
                    <p>
                      {new Date(item.deletedAt).toLocaleString("zh-CN")} ·{" "}
                      {item.deletedBy}
                    </p>
                    <code>
                      {item.projectId}
                      {item.kind === "composition" ? ` / ${item.id}` : ""}
                    </code>
                    {item.parentTrashed && <p>请先恢复所属项目。</p>}
                  </div>
                  <button
                    disabled={
                      !!busy || item.parentTrashed || item.canRestore === false
                    }
                    onClick={() => {
                      if (lock.current) return;
                      lock.current = true;
                      setBusy(key);
                      setError("");
                      const operationId =
                        ops.current.get(key) ?? crypto.randomUUID();
                      ops.current.set(key, operationId);
                      void client
                        .changeResource({
                          projectId: item.projectId,
                          kind: item.kind,
                          id: item.id,
                          action: "restore",
                          baseRevision: item.lifecycleRevision,
                          expectedHeadRevision: item.compositionHeadRevision,
                          operationId,
                        })
                        .then(reload)
                        .then(() => ops.current.delete(key))
                        .catch((e) =>
                          setError(`${e.message} 原恢复请求可安全重试。`),
                        )
                        .finally(() => {
                          lock.current = false;
                          setBusy("");
                        });
                    }}
                  >
                    {busy === key ? "正在恢复…" : "恢复"}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
