import {
  type CompositionDocument,
  PROTOCOL_VERSION,
  type SubjectManifest,
} from "./types.ts";

export const SAMPLE_CHARACTER_SUBJECT: SubjectManifest = {
  apiVersion: PROTOCOL_VERSION,
  subject: {
    id: "char-weila",
    kind: "character",
    revision: 3,
    status: "approved",
    name: "微辣",
    defaultVariant: "studio",
    definition: {
      description: "主播，略有个性的写实面部特征",
      invariants: ["面部识别特征保持一致", "保持自然肤质和真实比例"],
    },
    variants: {
      studio: {
        description: "演播室日常造型",
        referencePack: [
          {
            asset: "weila-front-v3",
            view: "front",
            purpose: "identity",
            status: "approved",
          },
          {
            asset: "weila-profile-v3",
            view: "side",
            purpose: "identity",
            status: "approved",
          },
          {
            asset: "weila-full-v3",
            view: "full-body",
            purpose: "wardrobe",
            status: "approved",
          },
        ],
      },
    },
  },
};

export const SAMPLE_PROP_SUBJECT: SubjectManifest = {
  apiVersion: PROTOCOL_VERSION,
  subject: {
    id: "prop-cup",
    kind: "prop",
    revision: 2,
    status: "approved",
    name: "陶瓷马克杯",
    defaultVariant: "intact",
    definition: {
      description: "哑光深灰陶瓷杯，杯身带细微拉坯纹理",
      invariants: ["哑光深灰釉面", "标准 350ml 圆柱比例"],
    },
    variants: {
      intact: {
        description: "完好无损状态",
        referencePack: [
          {
            asset: "cup-intact-front",
            view: "front",
            purpose: "shape",
            status: "approved",
          },
        ],
      },
      damaged: {
        description: "杯口有一道明显裂纹",
        referencePack: [
          {
            asset: "cup-damaged-front",
            view: "front",
            purpose: "condition",
            status: "approved",
          },
        ],
      },
    },
  },
};

export const SAMPLE_COMPOSITION: CompositionDocument = {
  apiVersion: PROTOCOL_VERSION,
  id: "episode-001",
  project: "demo",
  title: "第一集：演播室开场",
  format: {
    width: 1920,
    height: 1080,
    fps: 30,
  },
  audioTracks: [
    {
      id: "track-bgm-main",
      role: "bgm",
      asset: "asset-bgm-theme-v1",
      startFrame: 0,
      durationFrames: 300,
    },
  ],
  sequence: ["shot-001", "shot-002"],
  shots: {
    "shot-001": {
      description: "Opening in studio",
      durationFrames: 150,
      dependsOn: [],
      subjects: [
        {
          subjectId: "char-weila",
          subjectRevision: 3,
          variant: "studio",
        },
      ],
      references: {
        images: [{ asset: "asset-studio-layout", role: "framing" }],
        videos: [],
      },
      prompts: {
        image: "Portrait in a studio",
        video: "Slow camera push",
      },
      candidates: {
        images: [{ asset: "asset-shot001-img-cand1", actor: "agent-storyboard" }],
        videos: [{ asset: "asset-shot001-vid-cand1", actor: "agent-video" }],
        audios: [
          {
            asset: "asset-shot001-tts-cand1",
            role: "dialogue",
            actor: "agent-voice",
          },
        ],
      },
      selected: {
        video: "asset-shot001-vid-cand1",
        audio: "asset-shot001-tts-cand1",
      },
    },
    "shot-002": {
      description: "Close-up holding the cup",
      durationFrames: 150,
      dependsOn: [{ shotId: "shot-001", kind: "continuity" }],
      subjects: [
        { subjectId: "char-weila", subjectRevision: 3 },
        { subjectId: "prop-cup", subjectRevision: 2, variant: "damaged" },
      ],
      references: {
        images: [],
        videos: [],
      },
      prompts: {
        image: "Close-up of hand picking up cracked ceramic cup",
        video: "Subtle rack focus to the crack",
      },
      candidates: {
        images: [],
        videos: [],
        audios: [],
      },
      selected: {
        video: null,
        audio: null,
      },
    },
  },
};
