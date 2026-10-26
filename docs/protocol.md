# vflow Protocol v1 — design draft

**Status: draft, not implemented or ratified.** The specification must remain vendor-neutral and testable independently of Cloudflare.

## Wire identifiers and rename compatibility
- Canonical identifiers are `vflow/v1`, `vflow/v2` and `vflow/reference-workflow/v1`; MCP resource URIs use the `vflow://` scheme.
- The project was previously named Video Compose. Stored documents and exported bundles written before the rename carry `video-compose/v1`, `video-compose/v2` or `video-compose/reference-workflow/v1`, and existing MCP clients may still request `video-compose://` URIs. Read paths accept those legacy values and normalize them to the canonical identifiers; new writes never emit them.
- This is a compatibility window, not a second dialect: field semantics, validation and error codes are identical. Existing revisions are not rewritten in place, so legacy identifiers can remain visible in historical revisions and exports.
- Removing the acceptance is a breaking change and requires a D1 export/rewrite plus a documented migration.

## Canonical entities
- Project: tenant ownership, simple member role (`reader` | `writer`), and a namespace for compositions, subjects and assets.
- Composition: stable ID, metadata, format (`width`, `height`, `fps`), ordered playback `sequence`, composition-level `audioTracks` (e.g. global BGM / narration with integer frame timing), and `shots` map.
- Shot: immutable ID across edits, description, optional duration in integer frames (`durationFrames`), explicit dependency edges (`dependsOn`), prompts, typed asset references (`references`), candidate outputs (`candidates`), chosen output references (`selected`), **pinned subject bindings** (`subjects`), and extensible namespaced metadata.
- Subject: project-scoped character or prop definition with stable ID, immutable revisions (`SubjectRevision`), revision `status` (`candidate` | `approved`), optional `defaultVariant`, named appearance/condition `variants`, and curated `referencePack` lists of one or more asset IDs.
- Subject binding: shot-scoped `subjectId`, explicit `subjectRevision`, optional `variant` (resolving to the revision's `defaultVariant` when omitted); never a mutable `latest` pointer.
- Asset reference: stable `assetId` (content-addressed SHA-256 identity) plus semantic role/notes; never a presigned or mutable URL.
- Revision: immutable canonical snapshot with parent revision, timestamp and actor (`actorId`, `actorKind`).
- Change / Proposal: typed domain operations with `baseRevision`, `operationId` (idempotency key), actor, and stable-ID path targets. A Proposal wraps a pending Change for review before commit.

## Hard invariants
1. **Playback vs. dependency separation**: Shot IDs are unique; `sequence` defines playback order and must reference existing shots. Shot `dependsOn` edges (`shotId` + `kind` such as `continuity`, `last_frame`, `narrative`) must reference existing shots and form a strict directed acyclic graph (DAG).
2. **Candidate vs. selected outputs**: Reference images (`references.images`) and candidate outputs (`candidates.images`, `candidates.videos`, `candidates.audios`) are ordered lists of asset references; reference video (`references.videos`) is optional; `selected.video` and `selected.audio` may be `null` or must reference a valid asset (typically chosen from `candidates`).
3. **Global audio tracks**: Composition-level `audioTracks` (e.g. `bgm`, `voiceover`, `ambience`) reference immutable audio assets with integer frame timing (`startFrame`, `durationFrames`, optional `trimStartFrame`) so multi-shot audio aligns deterministically without floating-point drift.
4. **Portable interchange**: File format is portable JSON with JSON Schema; YAML is an interoperable human syntax. Round-trip conversion (`JSON <-> YAML`) must preserve exact semantics.
5. **Forward/unknown metadata**: Unknown namespaced extension fields (`x-*` or `extensions`) are preserved across parse/serialize; unsupported required `apiVersion` values fail clearly.
6. **Integer frame timing**: All durations and timeline offsets (`durationFrames`, `startFrame`) use non-negative integer frames based on `format.fps` to prevent floating-point drift.
7. **Immutability**: Never silently replace historical revisions or asset content in place.
8. **Stable identity**: Editing an existing shot or audio track preserves its ID; deleting a shot referenced by `sequence` or another shot's `dependsOn` requires explicit reference cleanup or fails validation.
9. **Subject pinning & status**: A shot subject binding must resolve to an existing project `SubjectRevision` and valid `variant` (or the revision's `defaultVariant`). `SubjectRevision` carries `status: candidate | approved`; promoting a revision to `approved` freezes it as canonical, and an approved reference pack never changes in place.
10. **Export & import integrity**: Project export preserves all referenced `SubjectRevision` manifests and asset metadata; standalone composition export includes a transitive dependency manifest or fails with an unresolved-reference error. Importing a composition requires all referenced `assetId` and `subjectId@subjectRevision` dependencies to exist (or be supplied in the import bundle), failing atomically with a machine-readable missing-dependency list otherwise.
11. **Explicit variant/revision evolution**: Changing a character look or prop condition creates a new `SubjectRevision` (starting as `candidate` or directly `approved` by a writer) and never silently rebinds existing shots.
12. **ID-addressed patch operations**: Concurrent patches address entities by stable IDs (`shotId`, `trackId`, `subjectId`) and relative sequence anchors (`afterShotId` / `beforeShotId`) rather than positional array indices.

## Example (illustrative)
```yaml
apiVersion: vflow/v1
id: episode-001
project: demo
format: { width: 1920, height: 1080, fps: 30 }
audioTracks:
  - id: track-bgm-main
    role: bgm
    asset: asset-bgm-theme-v1
    startFrame: 0
    durationFrames: 300
sequence: [shot-001, shot-002]
shots:
  shot-001:
    description: Opening in studio
    durationFrames: 150
    dependsOn: []
    subjects:
      - { subjectId: char-weila, subjectRevision: 3, variant: studio }
    references:
      images: [{ asset: asset-studio-layout, role: framing }]
      videos: []
    prompts:
      image: Portrait in a studio
      video: Slow camera push
    candidates:
      images: [{ asset: asset-shot001-img-cand1, actor: agent-storyboard }]
      videos: [{ asset: asset-shot001-vid-cand1, actor: agent-video }]
      audios: [{ asset: asset-shot001-tts-cand1, role: dialogue, actor: agent-voice }]
    selected:
      video: asset-shot001-vid-cand1
      audio: asset-shot001-tts-cand1
  shot-002:
    description: Close-up holding the cup
    durationFrames: 150
    dependsOn:
      - { shotId: shot-001, kind: continuity }
    subjects:
      - { subjectId: char-weila, subjectRevision: 3 }
      - { subjectId: prop-cup, subjectRevision: 2, variant: damaged }
    references:
      images: []
      videos: []
    prompts:
      image: Close-up of hand picking up cracked ceramic cup
      video: Subtle rack focus to the crack
    candidates:
      images: []
      videos: []
      audios: []
    selected:
      video: null
      audio: null
```

## Subject definitions and reference packs
A subject is semantic identity rather than a media file. For details on revision `status` (`candidate` | `approved`), `defaultVariant`, reference viewpoints, appearance variants, state version pinning and portable export, see [Subject Definition and Reference Packs](subjects.md). This remains a draft until validation fixtures exist.

## Compatibility policy
No silent reinterpretation of existing fields. Additive optional fields under v1 are allowed when old clients can safely ignore them; breaking semantic changes require a new `apiVersion` and explicit migration. Schema fixtures and golden tests are mandatory before declaring v1 stable.

## v2 reference dependency contract

`COMPOSITION_JSON_SCHEMA` remains v1. `COMPOSITION_V2_JSON_SCHEMA` declares `vflow/v2` and optional `authoring: {policyVersion, materials: [{id, revision}]}`. `set_authoring` upgrades explicitly, preserving sequence, shot definitions, durations, Subject bindings and selected outputs.

Reference documents use `vflow/reference-workflow/v1`: discriminated policy, scene, reference_pack and storyboard_sequence schemas exported from `authoring.ts`. Scene identity, environment variant, per-view owner/purpose, crop provenance, text policy and visual review are typed fields, not provider metadata or asset tags. Prompts remain separate from clean image pixels.

V2 bundle dependencies include exact material revisions and compositionBaselines required by sequences, alongside subjects and assets. V1 readers reject v2; lossy conversion is refused with UNREPRESENTABLE_IN_V1. All necessary assets must already exist with matching hashes on import; missing/cyclic/conflicting dependencies fail atomically. Rules, complete workflow, schema resources, input/evidence contracts and rollback are specified in [reference-authoring.md](reference-authoring.md).

## Motion reference (additive, L0)

`motion_reference` is a further `kind` of the `vflow/reference-workflow/v1` material union; `COMPOSITION_JSON_SCHEMA` (v1) and the v2 composition schema are unchanged. It records an externally produced white-model video, overview still, keyframes and archived source project, and pins composition revision/shot, exact scene revision with environment variant, subject revisions with resolved variants, `fps` and `durationFrames`, plus declared usages (`camera_motion`, `blocking`, `action_timing`, `framing`). L0 covers the whole shot only: the video lasts exactly the shot's seconds (no offset/range fields), and drift is judged on design intent (duration, description, prompts, dependsOn, subjects, format, scene) but never on candidates/selected outputs. It carries motion evidence only and is never an identity, wardrobe, environment, first-frame or last-frame source. The schema is strict and has no engine or vendor fields.

Generation input requests gain an optional `motion` block and `capabilities.motion`; packets gain an optional `motion` block (absent requests produce byte-identical packets); evidence gains optional `actualMotion`. A v2 export carries the document, its scene, subjects, asset manifest (video, overview, keyframes, source) and the fixed composition baseline; v1 export is refused with `UNREPRESENTABLE_IN_V1`. Fields, rules, drift definition and limitations: [reference-authoring.md](reference-authoring.md#动态白模参考motion_referencel0).
