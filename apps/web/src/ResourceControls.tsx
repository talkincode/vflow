import React, { useEffect, useRef, useState } from "react";
import type { VideoComposeClient } from "@video-compose/client";
import type { ProjectRecord } from "@video-compose/domain";

function useDialog(close: () => void, busy: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      close();
    }
    if (event.key === "Tab") {
      const elements = Array.from(
        ref.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]",
        ) ?? [],
      );
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };
  return { ref, onKeyDown };
}

export interface DeleteTarget {
  projectId: string;
  kind: "project" | "composition";
  id: string;
  title: string;
  baseRevision: number;
  expectedHeadRevision?: number;
}
const failure = (e: unknown) => (e instanceof Error ? e.message : String(e));
export function DeleteDialog({
  client,
  target,
  onCancel,
  onComplete,
}: {
  client: VideoComposeClient;
  target: DeleteTarget;
  onCancel: () => void;
  onComplete: () => void;
}): React.ReactElement {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const operation = useRef(crypto.randomUUID());
  const lock = useRef(false);
  const dialog = useDialog(onCancel, pending);
  return (
    <div className="modal-backdrop">
      <section
        {...dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        className="create-dialog"
      >
        <h2 id="delete-title">移入回收站</h2>
        <p>
          确认删除{target.kind === "project" ? "项目" : "编排"}「{target.title}
          」？
        </p>
        <p>
          {target.kind === "project"
            ? "该项目的编排、素材和角色会暂时不可访问。恢复项目后内容仍在；之前单独删除的编排仍保留在回收站。"
            : "分镜、历史和选定输出均保留，可以从回收站恢复。"}{" "}
          此操作会影响有权访问它的共享成员。
        </p>
        {error && (
          <p role="alert">{error} 确认信息已保留，请核对最新状态后重试。</p>
        )}
        <footer className="dialog-actions">
          <button disabled={pending} onClick={onCancel}>
            取消
          </button>
          <button
            className="danger"
            disabled={pending}
            onClick={() => {
              if (lock.current) return;
              lock.current = true;
              setPending(true);
              setError("");
              void client
                .changeResource({
                  ...target,
                  action: "trash",
                  operationId: operation.current,
                })
                .then(onComplete)
                .catch((e) => setError(failure(e)))
                .finally(() => {
                  lock.current = false;
                  setPending(false);
                });
            }}
          >
            {pending ? "正在移入…" : "确认移入回收站"}
          </button>
        </footer>
      </section>
    </div>
  );
}
export function SharingDialog({
  client,
  project,
  onClose,
  onChanged,
}: {
  client: VideoComposeClient;
  project: ProjectRecord;
  onClose: () => void;
  onChanged: () => void;
}): React.ReactElement {
  const [email, setEmail] = useState(""),
    [role, setRole] = useState<"reader" | "writer">("reader"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const retries = useRef(new Map<string, string>());
  const update = (
    targetActorId: string,
    nextRole: "reader" | "writer" | null,
  ) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    const key = JSON.stringify([
      project.membershipRevision ?? 0,
      targetActorId,
      nextRole,
    ]);
    const operationId = retries.current.get(key) ?? crypto.randomUUID();
    retries.current.set(key, operationId);
    void client
      .setProjectMember({
        projectId: project.id,
        targetActorId,
        role: nextRole,
        baseRevision: project.membershipRevision ?? 0,
        operationId,
      })
      .then(() => {
        retries.current.delete(key);
        setEmail("");
        onChanged();
      })
      .catch((e) => setError(failure(e)))
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
  };
  const dialog = useDialog(onClose, busy);
  return (
    <div className="modal-backdrop">
      <section
        {...dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        className="create-dialog"
      >
        <h2 id="share-title">共享设置</h2>
        <p>
          默认仅所有者可见。明确授权后，成员可访问本项目及其中的编排、素材和角色。只有所有者可以调整共享权限。
        </p>
        <p>所有者：{project.ownerUserId ?? project.createdBy}</p>
        {error && (
          <p role="alert">
            {error} 输入已保留；如权限版本变化，请关闭并刷新后核对。
          </p>
        )}
        <ul className="sharing-members">
          {Object.entries(project.members)
            .filter(([id]) => id !== (project.ownerUserId ?? project.createdBy))
            .map(([id, current]) => (
              <li key={id}>
                <span>{id}</span>
                <select
                  aria-label={`权限 ${id}`}
                  disabled={busy}
                  value={current}
                  onChange={(e) =>
                    update(id, e.target.value as "reader" | "writer")
                  }
                >
                  <option value="reader">只读</option>
                  <option value="writer">可编辑</option>
                </select>
                <button disabled={busy} onClick={() => update(id, null)}>
                  撤销 {id}
                </button>
              </li>
            ))}
        </ul>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            update(email.trim().toLowerCase(), role);
          }}
        >
          <label>
            共享给账号
            <input
              aria-label="共享给账号"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            访问权限
            <select
              aria-label="新成员权限"
              value={role}
              onChange={(e) => setRole(e.target.value as typeof role)}
              disabled={busy}
            >
              <option value="reader">只读</option>
              <option value="writer">可编辑</option>
            </select>
          </label>
          <button disabled={busy || !email.trim()} type="submit">
            授权共享
          </button>
        </form>
        <footer className="dialog-actions">
          <button disabled={busy} onClick={onClose}>
            关闭
          </button>
        </footer>
      </section>
    </div>
  );
}
