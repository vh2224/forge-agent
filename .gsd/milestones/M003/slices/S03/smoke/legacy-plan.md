---
id: TSMK-LEGACY
slice: S03-SMOKE
milestone: M003
---

# Legacy fixture — no must_haves block.

This plan represents the M001/M002 pre-schema format and must be
gracefully skipped by the verifier.

## Must-Haves

The legacy format uses a markdown section instead of YAML frontmatter.
The verifier should recognize this as a legacy plan and skip it with
`skipped: legacy_schema` rather than crashing.

- Artifact 1: something.js (free text, not structured)
- Artifact 2: helper-lib.js (free text, not structured)
