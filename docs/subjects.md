# Subject Definition and Reference Packs — design draft

**Status: implemented locally and tested; typed reference workflow documented in [reference-authoring.md](reference-authoring.md).** Project-level first-class character and prop definition management, independent of specific generation providers. Read with [protocol.md](protocol.md) and [architecture.md](architecture.md).

## Core distinction

- **Asset**: immutable binary/media with stable content identity (`assetId`, SHA-256, storage pointer, MIME, dimensions, lineage). A reference picture is an Asset.
- **Subject**: stable semantic identity of a **character** or **prop** in a Project; optional future subject categories require explicit schema evolution.
- **SubjectRevision**: versioned snapshot of definitions, `status` (`candidate` | `approved`), `defaultVariant`, named `variants` and the ordered, curated `ReferencePack`. A `candidate` revision (or `candidate` reference entry) can be created and iterated on conveniently by any project `writer`; once promoted to `status: approved`, the revision and its canonical `referencePack` are frozen and immutable.
- **Variant**: explicit appearance or condition of the subject (e.g. character everyday/studio-costume or prop intact/broken). Variants do not mutate the subject identity.
- **ReferencePack**: multiple typed references to immutable assets; each entry has view/role, `status` (`candidate` | `approved`), notes, order and provenance.
- **ShotSubjectBinding**: `subjectId`, exact `subjectRevision`, optional `variant` (resolving to the bound revision's `defaultVariant` when omitted). A Shot may bind multiple Subjects; all referenced definitions are project-scoped and resolvable.

Subject and reference-pack data are logical, portable protocol constructs; D1/R2 is the hosting implementation, not part of the interchange format.

## Example subject (illustrative YAML)

```yaml
apiVersion: vflow/v1
subject:
  id: char-weila
  kind: character
  revision: 3
  status: approved
  name: 微辣
  defaultVariant: studio
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
          status: approved
        - asset: weila-profile-v3
          view: side
          purpose: identity
          status: approved
        - asset: weila-full-v3
          view: full-body
          purpose: wardrobe
          status: approved
```

A prop uses `kind: prop`, defining stable attributes such as material, shape, scale, surface markings and condition-specific variants. For example `prop-cup` can provide `intact` (`defaultVariant`), `damaged` and `repaired` variants with their own reference packs. New revisions or newly attached reference images start with `status: candidate` until explicitly promoted to `approved`.

A shot binds pinned identities (when `variant` is omitted, it resolves to `defaultVariant`):

```yaml
shots:
  shot-003:
    description: 微辣拿起破损的杯子
    subjects:
      - subjectId: char-weila
        subjectRevision: 3
      - subjectId: prop-cup
        subjectRevision: 2
        variant: damaged
```

## Governance and consistency

1. Subject ID is never reused for another identity. Once a `SubjectRevision` reaches `status: approved`, it is strictly immutable.
2. Multiple reference assets per Subject/Variant are supported. Entries label their role (front, side, back, full-body, detail, texture, scale, expression, etc.) and carry `status: candidate | approved`; role labels are extensible, not compulsory.
3. Any project `writer` (human or Agent) can register candidate images or create/update a `candidate` revision (`status: candidate`) without altering any previously `approved` canonical revision. Promoting a candidate revision or reference entry to `approved` is an explicit, auditable write operation subject to optimistic concurrency (`baseRevision`).
4. Modifying an already `approved` subject's definition text, assets, or variants produces a new `SubjectRevision` (with `status: candidate` during iteration, or promoted to `approved`). Previous revisions and existing Shot bindings remain untouched.
5. Historical shots are pinned; opening an old Composition Revision must resolve the exact `subjectRevision` and asset set used at that time, never `latest`.
6. If a bound `subjectRevision` or `variant` (or `defaultVariant` when `variant` is omitted) is missing, the API returns a machine-readable dependency error; never silently fall back to an unrelated look or prop state.
7. Deleting an Asset or SubjectRevision referenced by a historical shot must be prevented or handled by an explicit, auditable retention/migration policy, never cascade silently.
8. Composition portability: JSON/YAML export must include subject revision manifests and immutable asset references, or an explicit dependency manifest with sufficient data for a receiving agent to resolve them. Actual binary inclusion is a distinct export operation.

## Minimal UX and MCP

- Project library has **Characters** and **Props** filters, each Subject with name, canonical thumbnail, latest approved revision, candidate revisions, and variants.
- Subject detail: editable definition, reference grid showing multiple pictures with `candidate` / `approved` status badges, version history, and usage across compositions.
- Shot inspector: bind an existing Subject + precise revision + optional variant (defaulting to `defaultVariant`); preview the corresponding reference pack; inspect optional direct shot-level references.
- All UI operations map to the same domain API exposed through authenticated MCP (`reader` for queries, `writer` for mutations): `subject_list`, `subject_get`, `subject_create`, `subject_patch`, `subject_reference_attach`, `subject_approve_revision`, `shot_subject_bind`, `subject_usage`.
- Creating images, enforcing visual consistency via computer vision and model routing remain responsibilities of external agents; this platform provides reliable definitions, references and change history.

## Required E2E acceptance (covered by tests/e2e/04, 14 and 15)

1. Create character and prop subjects, upload multiple reference images, approve revisions, and bind them to two shots in separate compositions; both resolve the same version-pinned packs.
2. Produce a new character appearance revision and a damaged-prop variant; old shots retain the old packs, while explicitly rebound shots see the new version.
3. Simultaneous subject edits to the same semantic field report a machine-readable conflict rather than silently overwrite one agent.
4. Upload a corrupted/reference-missing asset or attempt unauthorized approval; the operation fails atomically, preserving the previous canonical pack.
5. Export and reimport a composition plus its dependency manifest; exact subject version identities and pack references remain stable.

## Typed reference packs and strict projects

SubjectKind remains character/prop. Scenes are separate immutable reference-workflow documents with geometry anchors and environment variants. Strict projects require per-view typed reference approval before subject promotion; face/body sheets and prop catalogs are distinct packs. Candidate subject definitions precede reference authoring, so approval has no circular prerequisite.

`authoring_document_put/review/approve` append immutable material revisions; Subject approval still freezes its existing candidate revision only after checking exact owner/revision/variant coverage. Direct `status: approved` cannot bypass this check. Old project behavior remains available through the explicit legacy boundary; old approved status is not an assertion that images passed the new visual checks. See [reference authoring](reference-authoring.md) for guidance, JSON contracts, scope checks and migration.

A white-model `motion_reference` is neither a Subject reference nor a canonical pack: it pins Subject revisions/variants only to say whose blocking it shows, and its images can never back a Subject reference pack (see [reference authoring](reference-authoring.md#动态白模参考motion_referencel0)).
