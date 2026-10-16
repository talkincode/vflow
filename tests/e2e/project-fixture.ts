import type { VideoComposeClient } from "@video-compose/client";
import {
  PROTOCOL_VERSION,
  type CompositionDocument,
} from "@video-compose/protocol";

export function projectComposition(
  project: string,
  id: string,
  title: string,
  description: string,
): CompositionDocument {
  return {
    apiVersion: PROTOCOL_VERSION,
    project,
    id,
    title,
    format: { width: 1920, height: 1080, fps: 30 },
    audioTracks: [],
    sequence: ["shot-001"],
    shots: {
      "shot-001": {
        description,
        durationFrames: 90,
        subjects: [],
        dependsOn: [],
        references: { images: [], videos: [] },
        prompts: {},
        candidates: { images: [], videos: [], audios: [] },
        selected: { video: null, audio: null },
      },
    },
  };
}

// Add multiple compositions and distinct project scopes to the media workbench fixture.
export async function seedProjectLibrary(
  client: VideoComposeClient,
): Promise<void> {
  await client.createComposition({
    projectId: "demo",
    document: projectComposition(
      "demo",
      "episode-002",
      "雨巷 · 第二集",
      "雨巷第二集开场",
    ),
  });
  await client.createProject({
    id: "city",
    name: "城市观察",
    description: "城市与街道的影像记录",
    members: { "bob-reader@talkincode.net": "reader" },
  });
  for (const [id, title, description] of [
    ["episode-001", "城市 · 第一集", "城市天际线"],
    ["episode-002", "城市 · 第二集", "街道夜景"],
  ]) {
    await client.createComposition({
      projectId: "city",
      document: projectComposition("city", id, title, description),
    });
  }
  await client.createProject({
    id: "private",
    name: "私人草稿",
    description: "仅创建者可访问",
  });
}
