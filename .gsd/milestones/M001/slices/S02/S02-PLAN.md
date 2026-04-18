# S02: Lean Orchestrator

**Milestone:** M001  
**Risk:** low  
**Depends:** (none)

## Objective

Reduce orchestrator context accumulation from ~10-50K tokens/unit to ~500 tokens/unit by making workers read their own artifact files instead of receiving inlined content. Three files change: `shared/forge-dispatch.md` (templates), `commands/forge-auto.md` (remove artifact reads), `commands/forge-next.md` (same removal).

## Acceptance Criteria

- After 11 units, orchestrator context < 50K tokens (vs ~128K currently)
- Workers function identically -- they read artifacts via Read tool in their isolated context
- `shared/forge-dispatch.md` is the single source of truth for all template changes
- forge-auto.md and forge-next.md no longer read artifact files in their "Build worker prompt" step

## Tasks

- [x] **T01: Lean dispatch templates** -- Rewrite all templates in `shared/forge-dispatch.md` replacing `{content of X}` with `Read and follow:` path directives
- [x] **T02: Strip artifact reads from forge-auto.md** -- Remove artifact file reads from Step 3, keep only placeholder substitutions
- [x] **T03: Strip artifact reads from forge-next.md** -- Apply the same Step 3 simplification as T02

## Slice-level notes

- `{TOP_MEMORIES}`, `{CS_LINT}`, `{CS_STRUCTURE}`, `{CS_RULES}` remain inlined (small, preprocessed)
- `{WORKING_DIR}`, `{M###}`, `{S##}`, `{T##}` remain as simple substitutions
- Optional files use "Read if exists:" directive -- worker skips gracefully if file not found
- Paths use `{WORKING_DIR}/.gsd/...` pattern (absolute via WORKING_DIR substitution)
