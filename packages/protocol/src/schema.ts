import { PROTOCOL_VERSION, REFERENCE_PROTOCOL_VERSION } from "./types.ts";

export const COMPOSITION_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://video-compose.talkincode.net/schemas/v1/composition.json",
  title: "VideoComposeCompositionV1",
  type: "object",
  required: ["apiVersion", "id", "project", "format", "sequence", "shots"],
  properties: {
    apiVersion: { const: PROTOCOL_VERSION },
    id: { type: "string", minLength: 1 },
    project: { type: "string", minLength: 1 },
    title: { type: "string" },
    format: {
      type: "object",
      required: ["width", "height", "fps"],
      properties: {
        width: { type: "integer", minimum: 1 },
        height: { type: "integer", minimum: 1 },
        fps: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    audioTracks: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "role", "asset", "startFrame", "durationFrames"],
        properties: {
          id: { type: "string", minLength: 1 },
          role: { enum: ["bgm", "voiceover", "ambience", "sfx"] },
          asset: { type: "string", minLength: 1 },
          startFrame: { type: "integer", minimum: 0 },
          durationFrames: { type: "integer", minimum: 1 },
          trimStartFrame: { type: "integer", minimum: 0 },
          notes: { type: "string" },
          extensions: { type: "object" },
        },
        additionalProperties: false,
      },
    },
    sequence: {
      type: "array",
      items: { type: "string", minLength: 1 },
    },
    shots: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["description"],
        properties: {
          description: { type: "string" },
          durationFrames: { type: "integer", minimum: 1 },
          dependsOn: {
            type: "array",
            items: {
              type: "object",
              required: ["shotId", "kind"],
              properties: {
                shotId: { type: "string", minLength: 1 },
                kind: {
                  enum: ["continuity", "last_frame", "narrative", "reference"],
                },
                notes: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          subjects: {
            type: "array",
            items: {
              type: "object",
              required: ["subjectId", "subjectRevision"],
              properties: {
                subjectId: { type: "string", minLength: 1 },
                subjectRevision: { type: "integer", minimum: 1 },
                variant: { type: "string", minLength: 1 },
              },
              additionalProperties: false,
            },
          },
          references: {
            type: "object",
            required: ["images", "videos"],
            properties: {
              images: {
                type: "array",
                items: {
                  type: "object",
                  required: ["asset"],
                  properties: {
                    asset: { type: "string", minLength: 1 },
                    role: { type: "string" },
                    notes: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
              videos: {
                type: "array",
                items: {
                  type: "object",
                  required: ["asset"],
                  properties: {
                    asset: { type: "string", minLength: 1 },
                    role: { type: "string" },
                    notes: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
          prompts: {
            type: "object",
            properties: {
              image: { type: "string" },
              video: { type: "string" },
              audio: { type: "string" },
            },
            additionalProperties: false,
          },
          candidates: {
            type: "object",
            required: ["images", "videos", "audios"],
            properties: {
              images: { type: "array", maxItems: 5 },
              videos: { type: "array" },
              audios: { type: "array" },
            },
            additionalProperties: false,
          },
          selected: {
            type: "object",
            required: ["video", "audio"],
            properties: {
              video: { type: ["string", "null"] },
              audio: { type: ["string", "null"] },
            },
            additionalProperties: false,
          },
          extensions: { type: "object" },
        },
      },
    },
    extensions: { type: "object" },
  },
} as const;

export const COMPOSITION_V2_JSON_SCHEMA = {
  ...COMPOSITION_JSON_SCHEMA,
  $id: "https://video-compose.talkincode.net/schemas/v2/composition.json",
  title: "VideoComposeCompositionV2",
  properties: {
    ...COMPOSITION_JSON_SCHEMA.properties,
    apiVersion: { const: REFERENCE_PROTOCOL_VERSION },
    authoring: {
      type: "object",
      required: ["policyVersion", "materials"],
      properties: {
        policyVersion: { const: "reference-authoring/1" },
        materials: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "revision"],
            properties: {
              id: { type: "string", minLength: 1 },
              revision: { type: "integer", minimum: 1 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  },
} as const;

export const SUBJECT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://video-compose.talkincode.net/schemas/v1/subject.json",
  title: "VideoComposeSubjectV1",
  type: "object",
  required: ["apiVersion", "subject"],
  properties: {
    apiVersion: { const: PROTOCOL_VERSION },
    subject: {
      type: "object",
      required: [
        "id",
        "kind",
        "revision",
        "status",
        "name",
        "definition",
        "variants",
      ],
      properties: {
        id: { type: "string", minLength: 1 },
        kind: { enum: ["character", "prop"] },
        revision: { type: "integer", minimum: 1 },
        status: { enum: ["candidate", "approved"] },
        name: { type: "string", minLength: 1 },
        defaultVariant: { type: "string", minLength: 1 },
        definition: {
          type: "object",
          required: ["description", "invariants"],
          properties: {
            description: { type: "string" },
            invariants: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
        variants: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["description", "referencePack"],
            properties: {
              description: { type: "string" },
              referencePack: {
                type: "array",
                items: {
                  type: "object",
                  required: ["asset", "status"],
                  properties: {
                    asset: { type: "string", minLength: 1 },
                    view: { type: "string" },
                    purpose: { type: "string" },
                    status: { enum: ["candidate", "approved"] },
                    notes: { type: "string" },
                    provenance: { type: "object" },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
        extensions: { type: "object" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const;
