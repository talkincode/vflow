import fs from "node:fs/promises";
import path from "node:path";
import type { VFlowClient } from "@vflow/client";
import { PROTOCOL_VERSION, type ShotDefinition } from "@vflow/protocol";
export async function seedWorkbench(
  client: VFlowClient,
  count = 3,
): Promise<void> {
  await client.createProject({ authoringMode: "legacy",
    id: "demo",
    name: "工作台验收",
    members: { "bob-reader@talkincode.net": "reader" },
  });
  for (const [name, mimeType] of [
    ["png", "image/png"],
    ["mp4", "video/mp4"],
    ["wav", "audio/wav"],
  ]) {
    await client.uploadAsset({
      projectId: "demo",
      assetId: `preview-${name}`,
      mimeType,
      bytes: new Uint8Array(
        await fs.readFile(
          path.resolve(import.meta.dirname, "../fixtures", `preview.${name}`),
        ),
      ),
    });
  }
  await client.createSubject({
    projectId: "demo",
    id: "character-main",
    name: "信使",
    kind: "character",
    status: "approved",
    defaultVariant: "raincoat",
    definition: { description: "雨巷中的信使", invariants: ["黄色雨衣"] },
    variants: {
      raincoat: {
        description: "雨衣造型",
        referencePack: [{ asset: "preview-png", status: "approved" }],
      },
    },
  });
  const shots: Record<string, ShotDefinition> = {};
  const sequence: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `shot-${String(i).padStart(3, "0")}`;
    sequence.push(id);
    shots[id] = {
      description: `镜头 ${i} 雨巷`,
      durationFrames: 90,
      dependsOn: [],
      subjects:
        i === 1 ? [{ subjectId: "character-main", subjectRevision: 1 }] : [],
      references: {
        images: i === 1 ? [{ asset: "preview-png" }] : [],
        videos: [],
      },
      prompts: { image: `画面提示词 ${i}`, video: `运镜提示词 ${i}` },
      candidates: {
        images: i === 1 ? [{ asset: "preview-png" }] : [],
        videos: [],
        audios: [],
      },
      selected: { video: null, audio: null },
    };
  }
  await client.createComposition({
    projectId: "demo",
    document: {
      apiVersion: PROTOCOL_VERSION,
      id: "episode-001",
      project: "demo",
      title: "雨巷 · 第一集",
      format: { width: 1920, height: 1080, fps: 30 },
      audioTracks: [
        {
          id: "bgm-main",
          role: "bgm",
          asset: "preview-wav",
          startFrame: 0,
          durationFrames: 30,
        },
      ],
      sequence,
      shots,
    },
  });
}
