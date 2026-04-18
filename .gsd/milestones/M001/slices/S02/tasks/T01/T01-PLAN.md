# T01: Lean dispatch templates

**Slice:** S02  **Milestone:** M001

## Goal

Rewrite every worker prompt template in `shared/forge-dispatch.md` so that artifact content is referenced by path (worker reads it) instead of inlined by the orchestrator.

## Must-Haves

### Truths
- Every `{content of ...}` placeholder is replaced with a `Read and follow:` or `Read if exists:` path directive
- Small preprocessed placeholders remain inlined: `{TOP_MEMORIES}`, `{CS_LINT}`, `{CS_STRUCTURE}`, `{CS_RULES}`, `{WORKING_DIR}`, `{M###}`, `{S##}`, `{T##}`, `{PREFS.*}`, `{unit_effort}`, `{THINKING_OPUS}`, `{auto_commit}`
- All 7 template blocks are transformed: execute-task, plan-slice, plan-milestone, complete-slice, complete-milestone, discuss-milestone/discuss-slice, research-milestone/research-slice
- Template section headings (## names) are preserved exactly -- only the content under each heading changes
- Paths use the pattern `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/...` so they resolve to absolute paths after WORKING_DIR substitution

### Artifacts
- `shared/forge-dispatch.md` -- rewritten file (~250 lines, same 7 template blocks)

### Key Links
- `shared/forge-dispatch.md` is consumed by `commands/forge-auto.md` (Step 3 + "Worker Prompt Templates" section)
- `shared/forge-dispatch.md` is consumed by `commands/forge-next.md` (Step 3 + "Worker Prompt Templates" section)

## Steps

1. Read `shared/forge-dispatch.md` (already known, ~247 lines)
2. For each template block, apply the transformation pattern:
   - `{content of T##-PLAN.md}` becomes `Read and follow: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md`
   - `{content of X if exists, else "fallback"}` becomes `Read if exists: {WORKING_DIR}/path/to/X` (worker uses fallback text if Read fails)
   - `{relevant section of M###-ROADMAP.md for this slice}` becomes `Read and follow: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-ROADMAP.md` with note "Focus on the S## entry and Boundary Map"
   - `{## Decisions section of S##-CONTEXT.md ...}` becomes `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md` with note "Extract ## Decisions section"
   - `{first 35 lines of each T##-SUMMARY.md}` becomes `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/T*/T*-SUMMARY.md` with note "Read first 35 lines of each"
   - For discuss template's `{Prior Decisions}` complex logic, convert to two path directives with conditional note
3. Keep the header paragraph and structure markers (`### template-name` + triple-backtick fences) unchanged
4. Verify: no remaining `{content of` patterns in the file
5. Write the updated file

### Transformation reference per template

**execute-task:**
| Before | After |
|--------|-------|
| `{content of T##-PLAN.md}` | `Read and follow: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-PLAN.md` |
| `{content of S##-PLAN.md}` | `Read: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md` |
| `{content of M###-SUMMARY.md if exists...}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SUMMARY.md` |
| `{content of T##-SECURITY.md if exists...}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}/{T##}-SECURITY.md` |
| `{## Decisions section of S##-CONTEXT.md...}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md — extract ## Decisions section only` |

**plan-slice:**
| Before | After |
|--------|-------|
| `{content of S##-RISK.md if exists...}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-RISK.md` |
| `{relevant section of M###-ROADMAP.md...}` | `Read: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-ROADMAP.md — focus on {S##} entry and Boundary Map` |
| `{content of M###-CONTEXT.md if exists...}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md` |
| `{content of S##-CONTEXT.md if exists...}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-CONTEXT.md` |
| `{content of M###-RESEARCH.md if exists...}` (implicit) | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-RESEARCH.md` |
| `{first 35 lines of S##-SUMMARY.md for depends}` | `Read if exists (first 35 lines each): {WORKING_DIR}/.gsd/milestones/{M###}/slices/{dep}/{ dep}-SUMMARY.md — for each slice in depends:[]` |

**plan-milestone:**
| Before | After |
|--------|-------|
| `{content of .gsd/PROJECT.md}` | `Read: {WORKING_DIR}/.gsd/PROJECT.md` |
| `{content of .gsd/REQUIREMENTS.md}` | `Read: {WORKING_DIR}/.gsd/REQUIREMENTS.md` |
| `{content of M###-CONTEXT.md if exists...}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md` |
| `{content of M###-BRAINSTORM.md if exists...}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-BRAINSTORM.md` |
| `{content of M###-SCOPE.md if exists...}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SCOPE.md` |

**complete-slice:**
| Before | After |
|--------|-------|
| `{first 35 lines of each T##-SUMMARY.md...}` | `Read (first 35 lines each): {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/T*/T*-SUMMARY.md` |
| `{content of S##-PLAN.md}` | `Read: {WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md` |
| `{content of M###-SUMMARY.md if exists...}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SUMMARY.md` |

**complete-milestone:**
| Before | After |
|--------|-------|
| `{first 35 lines of each S##-SUMMARY.md...}` | `Read (first 35 lines each): {WORKING_DIR}/.gsd/milestones/{M###}/slices/S*/S*-SUMMARY.md` |
| `{content of M###-ROADMAP.md}` | `Read: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-ROADMAP.md` |
| `{content of M###-SUMMARY.md}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-SUMMARY.md` |

**discuss-milestone/discuss-slice:**
| Before | After |
|--------|-------|
| `{content of .gsd/PROJECT.md}` | `Read: {WORKING_DIR}/.gsd/PROJECT.md` |
| `{content of .gsd/REQUIREMENTS.md if exists}` | `Read if exists: {WORKING_DIR}/.gsd/REQUIREMENTS.md` |
| `{content of M###-BRAINSTORM.md if exists...}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-BRAINSTORM.md` |
| `{Prior Decisions...}` | For discuss-slice: `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md — extract ## Decisions section (locked)` / For discuss-milestone: `Read last 30 lines: {WORKING_DIR}/.gsd/DECISIONS.md` |

**research-milestone/research-slice:**
| Before | After |
|--------|-------|
| `{context from M###-CONTEXT.md or S##-CONTEXT.md}` | `Read if exists: {WORKING_DIR}/.gsd/milestones/{M###}/{M###}-CONTEXT.md` (or S## variant) |
| `{content of .gsd/PROJECT.md}` | `Read: {WORKING_DIR}/.gsd/PROJECT.md` |
| `{CODING_STANDARDS or "(none)"}` | `Read if exists: {WORKING_DIR}/.gsd/CODING-STANDARDS.md` |

## Standards
- **Target directory:** `shared/` (existing file, in-place edit)
- **Reuse:** N/A
- **Naming:** Keep existing `forge-dispatch.md` name
- **Lint command:** N/A (markdown file)
- **Pattern:** N/A

## Context
- Decision: "Lean orchestrator: workers read own artifacts via Read tool, not inlined content" (DECISIONS.md)
- Decision: "Paths passed to workers must be absolute or relative to WORKING_DIR; optional files use 'Read if exists'" (M001-CONTEXT.md)
- Workers already have `Read` in their tool list (validated in research phase)
- Key file to read first: `shared/forge-dispatch.md`
