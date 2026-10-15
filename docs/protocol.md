# Video Compose Protocol v1 — design draft

**Status: draft, not implemented or ratified.** The specification must remain vendor-neutral and testable independently of Cloudflare.

## Canonical entities
- Project: tenant ownership and a namespace for compositions/assets.
- Composition: stable ID, metadata, format (width, height, fps), ordered timeline and shot map.
- Shot: immutable ID across edits, description, optional duration in integer frames, prompts, typed asset references, selected output references, extensible namespaced metadata.
- Asset reference: stable asset ID plus role; never a presigned URL.
- Revision: immutable canonical snapshot with parent revision and actor.
- Change: typed operations with `baseRevision`, `operationId`, declared paths and preconditions.

## Hard invariants
1. Shot IDs are unique; timeline references must exist, with explicit ordering independent from production dependencies.
2. Dependency edges form an acyclic graph; do not confuse dependencies with playback sequence.
3. Reference image is a list; reference video optional; candidate output video/audio may be absent.
4. File format is portable JSON with JSON Schema; YAML is interoperable human syntax. Round-trip must preserve semantics.
5. Unknown namespace metadata is preserved; unsupported required protocol versions fail clearly.
6. Frame-based durations prevent floating-point drift.
7. Never silently replace historical revisions or asset content.
8. Editing an existing shot preserves its ID; deleting a shot requires clear references/validation policy.

## Example (illustrative)
```yaml
apiVersion: video-compose/v1
id: episode-001
project: demo
format: { width: 1920, height: 1080, fps: 30 }
sequence: [shot-001]
shots:
  shot-001:
    description: Opening
    durationFrames: 150
    references:
      images: [{ asset: character-front, role: character }]
      videos: []
    prompts:
      image: Portrait in a studio
      video: Slow camera push
    selected:
      video: null
      audio: null
```

## Compatibility policy
No silent reinterpretation of existing fields. Additive optional fields under v1 are allowed when old clients can safely ignore them; breaking semantic changes require a new `apiVersion` and explicit migration. Schema fixtures and golden tests are mandatory before declaring v1 stable.
