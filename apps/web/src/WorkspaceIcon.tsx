import type { ReactElement } from "react";

export type WorkspaceIconName = "shots" | "assets" | "subjects" | "authoring" | "history" | "source";

/** Local, decorative icons; navigation always retains an explicit text label. */
export function WorkspaceIcon({ name }: { name: WorkspaceIconName }): ReactElement {
  const paths: Record<WorkspaceIconName, ReactElement> = {
    shots: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v5M16 4v5m-6 4 5 3-5 3z" /></>,
    assets: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>,
    subjects: <><circle cx="9" cy="7" r="3" /><path d="M3 20v-3a6 6 0 0 1 12 0v3M17 4l4 4-4 4-4-4zM18 15v6m-3-3h6" /></>,
    authoring: <><path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9M8 8h3M8 13h4M8 17h8m-2-9 5-5 2 2-5 5-3 1z" /></>,
    history: <><path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l4 2" /></>,
    source: <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18" /></>,
  };
  return <svg className="workspace-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
