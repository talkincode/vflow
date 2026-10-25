# Video Compose Protocol v1 — design draft

**Status: draft, not implemented or ratified.** The specification must remain vendor-neutral and testable independently of Cloudflare.

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
apiVersion: video-compose/v1
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

`COMPOSITION_JSON_SCHEMA` remains v1. `COMPOSITION_V2_JSON_SCHEMA` declares `video-compose/v2` and optional `authoring: {policyVersion, materials: [{id, revision}]}`. `set_authoring` upgrades explicitly, preserving sequence, shot definitions, durations, Subject bindings and selected outputs.

Reference documents use `video-compose/reference-workflow/v1`: discriminated policy, scene, reference_pack and storyboard_sequence schemas exported from `authoring.ts`. Scene identity, environment variant, per-view owner/purpose, crop provenance, text policy and visual review are typed fields, not provider metadata or asset tags. Prompts remain separate from clean image pixels.

V2 bundle dependencies include exact material revisions and compositionBaselines required by sequences, alongside subjects and assets. V1 readers reject v2; lossy conversion is refused with UNREPRESENTABLE_IN_V1. All necessary assets must already exist with matching hashes on import; missing/cyclic/conflicting dependencies fail atomically. Rules, complete workflow, schema resources, input/evidence contracts and rollback are specified in [reference-authoring.md](reference-authoring.md).
