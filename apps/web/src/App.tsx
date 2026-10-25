import type { VideoComposeClient } from "@video-compose/client";
import React from "react";
import {
  ProjectsPage,
  ProjectPage,
  CompositionWorkspace,
  PageError,
} from "./Projects.tsx";
import { SessionBoundary } from "./AccountMenu.tsx";
import { TrashPage } from "./TrashPage.tsx";
import { readRoute } from "./routes.ts";

function AppRoutes({
  client,
  pathname = window.location.pathname,
}: {
  client: VideoComposeClient;
  pathname?: string;
}): React.ReactElement {
  const route = readRoute(pathname);
  if (route.kind === "trash") return <TrashPage client={client} />;
  if (route.kind === "projects") return <ProjectsPage client={client} />;
  if (route.kind === "project")
    return (
      <ProjectPage
        key={route.projectId}
        client={client}
        projectId={route.projectId}
      />
    );
  if (route.kind === "composition")
    return (
      <CompositionWorkspace
        key={`${route.projectId}/${route.compositionId}`}
        client={client}
        projectId={route.projectId}
        compositionId={route.compositionId}
      />
    );
  return <PageError message="没有找到这个页面，请检查地址或返回项目列表。" />;
}

export function App(props: {
  client: VideoComposeClient;
  pathname?: string;
}): React.ReactElement {
  return (
    <SessionBoundary client={props.client}>
      <AppRoutes {...props} />
    </SessionBoundary>
  );
}
