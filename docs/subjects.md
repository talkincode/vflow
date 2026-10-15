# Subject Definition and Reference Packs — design draft

**Status: planned, not implemented.** Project-level first-class character and prop definition management, independent of specific generation providers. Read with [protocol.md](protocol.md) and [architecture.md](architecture.md).

## Core distinction

- **Asset**: immutable binary/media with stable content identity (`assetId`, SHA-256, storage pointer, MIME, dimensions, lineage). A reference picture is an Asset.
- **Subject**: stable semantic identity of a **character** or **prop** in a Project; optional future subject categories require explicit schema evolution.
- **SubjectRevision**: immutable snapshot of definitions, named variants and the ordered, curated `ReferencePack`. Its revision ID never changes meaning.
- **Variant**: explicit appearance or condition of the subject (e.g. character everyday/studio-costume or prop intact/broken). Variants do not mutate the subject identity.
- **ReferencePack**: multiple typed references to immutable assets; each entry has view/role, notes, order and provenance. Candidate images and approved canonical references have distinct statuses.
- **ShotSubjectBinding**: `subjectId`, exact `revision`, optional `variant`. A Shot may bind multiple Subjects; all referenced definitions are project-scoped and resolvable.

Subject and reference-pack data are logical, portable protocol constructs; D1/R2 is the planned hosting implementation, not part of the interchange format.

## Example subject (illustrative YAML)

```yaml
apiVersion: video-compose/v1
subject:
  id: char-weila
  kind: character
  revision: 3
  name: 微辣
  definition:
    description: 主播，略有个性的写实面部特征
    invariants:
      - 面部识别特征保持一致
      - 保持自然肤质和真实比例
  variants:
    studio:
      description: 演播室日常造型
      referencePack:
        - asset: weila-front-v3
          view: front
          purpose: identity
        - asset: weila-profile-v3
          view: side
          purpose: identity
        - asset: weila-full-v3
          view: full-body
          purpose: wardrobe
  approval:
    status: approved
```

A prop uses `kind: prop`, defining stable attributes such as material, shape, scale, surface markings and condition-specific variants. For example `prop-001` can provide `intact`, `damaged` and `repaired` variants with their own approved reference packs. Candidate packs are not implicitly promoted to approved.

A shot binds pinned identities:

```yaml
shots:
  shot-003:
    description: 微辣拿起破损的杯子
    subjects:
      - subjectId: char-weila
        subjectRevision: 3
        variant: studio
      - subjectId: prop-cup
        subjectRevision: 2
        variant: damaged
```

## Governance and consistency

1. Subject ID is never reused for another identity. A SubjectRevision is immutable.
2. Multiple reference assets per Subject/Variant are supported. Entries label their role (front, side, back, full-body, detail, texture, scale, expression, etc.) but those labels are extensible, not compulsory.
3. Agent can register and suggest candidate images without silently altering the approved canonical reference pack. Subject revision approval is auditable and subject to scoped access control.
4. Modifying definition text, assets, variants, or approval status generates a new subject revision or review event. Previous revisions and existing Shot bindings remain valid.
5. Historical shots are pinned; opening an old Composition Revision must resolve the exact subject revision and asset set used at that time, never `latest`.
6. If a bound variant/revision is missing, the API returns a machine-readable dependency error; never silently fall back to a different look or prop state.
7. Deleting an Asset or SubjectRevision referenced by a historical shot must be prevented or handled by an explicit, auditable retention/migration policy, never cascade silently.
8. Composition portability: JSON/YAML export must include subject revision manifests and immutable asset references, or an explicit dependency manifest with sufficient data for a receiving agent to resolve them. Actual binary inclusion is a distinct export operation.

## Minimal UX and MCP

- Project library has **Characters** and **Props** filters, each Subject with name, canonical thumbnail, latest approved revision and variants.
- Subject detail: editable definition, reference grid showing multiple pictures, candidate/approved labels, version history, and usage across compositions.
- Shot inspector: bind an existing Subject + precise revision + variant; preview the corresponding reference pack; inspect optional direct shot-level references.
- All UI operations map to the same domain API exposed through authenticated MCP: `subject_list`, `subject_get`, `subject_create`, `subject_patch`, `subject_reference_attach`, `subject_approve_revision`, `shot_subject_bind`, `subject_usage`.
- Creating images, enforcing visual consistency via computer vision and model routing remain responsibilities of external agents; this platform provides reliable definitions, references and change history.

## Required E2E acceptance (planned, no tests exist yet)

1. Create character and prop subjects, upload multiple reference images, approve revisions, and bind them to two shots in separate compositions; both resolve the same version-pinned packs.
2. Produce a new character appearance revision and a damaged-prop variant; old shots retain the old packs, while explicitly rebound shots see the new version.
3. Simultaneous subject edits to the same semantic field report a machine-readable conflict rather than silently overwrite one agent.
4. Upload a corrupted/reference-missing asset or attempt unauthorized approval; the operation fails atomically, preserving the previous canonical pack.
5. Export and reimport a composition plus its dependency manifest; exact subject version identities and pack references remain stable.
