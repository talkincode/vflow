export type WorkspaceRoute =
  | { kind: "projects" }
  | { kind: "project"; projectId: string }
  | { kind: "composition"; projectId: string; compositionId: string }
  | { kind: "missing" };

export const projectUrl = (projectId: string): string =>
  `/projects/${encodeURIComponent(projectId)}`;

export const compositionUrl = (
  projectId: string,
  compositionId: string,
): string =>
  `${projectUrl(projectId)}/compositions/${encodeURIComponent(compositionId)}`;

export function readRoute(pathname: string): WorkspaceRoute {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { kind: "projects" };
  const match = /^\/projects\/([^/]+)(?:\/compositions\/([^/]+))?$/.exec(path);
  if (!match) return { kind: "missing" };
  try {
    const projectId = decodeURIComponent(match[1]);
    return match[2]
      ? {
          kind: "composition",
          projectId,
          compositionId: decodeURIComponent(match[2]),
        }
      : { kind: "project", projectId };
  } catch {
    return { kind: "missing" };
  }
}
