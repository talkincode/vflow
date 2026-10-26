import React, { useEffect, useState } from "react";
import type { VFlowClient } from "@vflow/client";
export function AccountMenu({
  client,
}: {
  client?: VFlowClient;
}): React.ReactElement {
  const [account, setAccount] = useState("");
  useEffect(() => {
    let live = true;
    if (client)
      void client
        .getSession()
        .then((s) => {
          if (live) setAccount(s.actor.userId ?? s.actor.actorId);
        })
        .catch(() => {
          if (live) setAccount("登录已失效");
        });
    return () => {
      live = false;
    };
  }, [client]);
  return (
    <nav className="account-menu" aria-label="账号">
      <span title={account}>{account}</span>
      <a href="/trash">回收站</a>
      <a href="/logout" title="结束 Cloudflare Access 登录会话并清理本站缓存">
        退出登录
      </a>
    </nav>
  );
}
export function SessionBoundary({
  client,
  children,
}: {
  client: VFlowClient;
  children: React.ReactNode;
}): React.ReactElement {
  const [account, setAccount] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let generation = 0;
    const check = () => {
      const current = ++generation;
      setAccount(null);
      setFailed(false);
      void client
        .getSession()
        .then((s) => {
          if (live && current === generation)
            setAccount(s.actor.userId ?? s.actor.actorId);
        })
        .catch(() => {
          if (live && current === generation) setFailed(true);
        });
    };
    const show = (e: PageTransitionEvent) => {
      if (e.persisted) check();
    };
    check();
    window.addEventListener("pageshow", show);
    return () => {
      live = false;
      window.removeEventListener("pageshow", show);
    };
  }, [client]);
  if (failed)
    return (
      <main className="project-content">
        <h1>登录已失效</h1>
        <p>请重新登录后访问你的项目。</p>
        <a className="button-link" href="/">
          重新登录
        </a>
      </main>
    );
  if (!account)
    return (
      <main className="project-content">
        <p role="status">正在核验账号…</p>
      </main>
    );
  return <React.Fragment key={account}>{children}</React.Fragment>;
}
