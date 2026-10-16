import {
  COMPOSITION_JSON_SCHEMA,
  PROTOCOL_VERSION,
  SAMPLE_CHARACTER_SUBJECT,
  SAMPLE_COMPOSITION,
  SAMPLE_PROP_SUBJECT,
  SUBJECT_JSON_SCHEMA,
  subjectRevisionKey,
  validateCompositionDocument,
  validateSubjectManifest,
} from "@video-compose/protocol";
import { describe, expect, it } from "vitest";

describe("E2E 02 — 声明式协议与验证 (Declarative Protocol & Validation)", () => {
  it("Happy Path: validates canonical sample composition with global audioTracks, dependsOn DAG, candidates, and pinned subjects", () => {
    expect(COMPOSITION_JSON_SCHEMA.properties.apiVersion.const).toBe(
      PROTOCOL_VERSION,
    );
    expect(SUBJECT_JSON_SCHEMA.properties.apiVersion.const).toBe(
      PROTOCOL_VERSION,
    );

    const charResult = validateSubjectManifest(SAMPLE_CHARACTER_SUBJECT);
    expect(charResult.ok).toBe(true);

    const propResult = validateSubjectManifest(SAMPLE_PROP_SUBJECT);
    expect(propResult.ok).toBe(true);

    const availableAssets = new Set([
      "asset-bgm-theme-v1",
      "asset-studio-layout",
      "asset-shot001-img-cand1",
      "asset-shot001-vid-cand1",
      "asset-shot001-tts-cand1",
      "weila-front-v3",
      "weila-profile-v3",
      "weila-full-v3",
      "cup-intact-front",
      "cup-damaged-front",
    ]);

    const availableSubjects = new Map([
      [
        subjectRevisionKey(
          SAMPLE_CHARACTER_SUBJECT.subject.id,
          SAMPLE_CHARACTER_SUBJECT.subject.revision,
        ),
        SAMPLE_CHARACTER_SUBJECT.subject,
      ],
      [
        subjectRevisionKey(
          SAMPLE_PROP_SUBJECT.subject.id,
          SAMPLE_PROP_SUBJECT.subject.revision,
        ),
        SAMPLE_PROP_SUBJECT.subject,
      ],
    ]);

    const inputWithExt = {
      ...structuredClone(SAMPLE_COMPOSITION),
      "x-custom-tool": { note: "preserved" },
    };
    const snapshotBefore = JSON.stringify(inputWithExt);

    const result = validateCompositionDocument(inputWithExt, {
      availableAssets,
      availableSubjects,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value["x-custom-tool"]).toEqual({ note: "preserved" });
      expect(result.value.audioTracks).toHaveLength(1);
      expect(result.value.shots["shot-002"].dependsOn[0].shotId).toBe("shot-001");
    }
    // Non-mutation guarantee
    expect(JSON.stringify(inputWithExt)).toBe(snapshotBefore);
  });

  it("Failure Path: rejects missing IDs, dependency cycles, invalid references, mutable URLs, and non-integer frames without mutating input", () => {
    const cyclicInput = {
      apiVersion: PROTOCOL_VERSION,
      id: "cyclic-comp",
      project: "demo",
      format: { width: 1920, height: 1080, fps: 30 },
      audioTracks: [
        {
          id: "bgm-1",
          role: "bgm",
          asset: "https://example.com/mutable-presigned-url.mp3?token=abc",
          startFrame: 0,
          durationFrames: 100,
        },
      ],
      sequence: ["shot-a", "shot-b", "shot-missing"],
      shots: {
        "shot-a": {
          description: "Shot A",
          durationFrames: 12.5,
          dependsOn: [{ shotId: "shot-b", kind: "continuity" }],
          subjects: [],
          references: { images: [], videos: [] },
          prompts: {},
          candidates: { images: [], videos: [], audios: [] },
          selected: { video: null, audio: null },
        },
        "shot-b": {
          description: "Shot B",
          durationFrames: 60,
          dependsOn: [{ shotId: "shot-a", kind: "last_frame" }],
          subjects: [],
          references: { images: [], videos: [] },
          prompts: {},
          candidates: { images: [], videos: [], audios: [] },
          selected: { video: null, audio: null },
        },
      },
    };

    const frozenCopy = JSON.stringify(cyclicInput);
    const res = validateCompositionDocument(cyclicInput);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      const codes = res.errors.map((e) => e.code);
      expect(codes).toContain("DEPENDENCY_CYCLE");
      expect(codes).toContain("UNKNOWN_SEQUENCE_SHOT");
      expect(codes).toContain("INVALID_DURATION_FRAMES");
      expect(codes).toContain("MISSING_ASSET_REFERENCE");
    }

    // Validator never mutates input
    expect(JSON.stringify(cyclicInput)).toBe(frozenCopy);
  });
});
