# T05: Add `verification:` block to `forge-agent-prefs.md`

status: DONE

**Slice:** S02  **Milestone:** M002

## Goal

Add a `## Verification Settings` block to `forge-agent-prefs.md` (template that
lands in `~/.claude/forge-agent-prefs.md` at install time) documenting: the
`preference_commands` default, the 3-step discovery chain, the frozen allow-list,
the 120 s per-command timeout, the docs-only graceful-skip, and the security
note on trusted-source commands. Cross-reference `scripts/forge-verify.js` and
`shared/forge-dispatch.md ## Verification Gate`.

## Must-Haves

### Truths

- `forge-agent-prefs.md` gains a new `## Verification Settings` section, positioned after `## Retry Settings` (S01's block) and before `## Update Settings`. Mirrors the `## Retry Settings` style from S01 for consistency.
- The new section contains:
  - **Intro paragraph** (2–3 sentences): the verification gate runs before a task is marked done and before a slice is squash-merged. Configurable via this block.
  - **Fenced YAML-style config block** (not actual YAML — it's a pref template):
    ```
    verification:
      preference_commands: []        # ordered list of shell commands to run as the gate
                                     # empty = fall through to T##-PLAN verify: or package.json auto-detect
      command_timeout_ms: 120000     # per-command timeout; synthetic exit 124 on timeout
    ```
  - **`Discovery chain` subsection** restating the 3 steps:
    1. `T##-PLAN.md` frontmatter `verify:` field (task-level only; slice-level skips this).
    2. `verification.preference_commands` from this file (or repo/local overrides).
    3. `package.json` scripts filtered to allow-list `[typecheck, lint, test]` (in that order, skipping absent).
    4. None of the above AND no `package.json`/`pyproject.toml`/`go.mod` → `{skipped: "no-stack"}`, exit 0 (docs-only repos don't block).
  - **`Allow-list` subsection**: hardcoded in `scripts/forge-verify.js` as `["typecheck", "lint", "test"]`. The gate NEVER runs `start`, `dev`, `build`, `prepare`, `postinstall`, or custom scripts. To add a script, use `preference_commands` or put it in `T##-PLAN.md` `verify:` explicitly.
  - **`Timeout` subsection**: default 120 000 ms (2 min). Timeouts produce exit code 124 and are logged to `events.jsonl` as `{event:"verify", ..., passed: false}` (the individual check's `skipped: "timeout"` flag is set; the gate is considered failed).
  - **`Skip semantics` subsection**: `skipped: "no-stack"` at top level means the entire gate was bypassed (docs-only repo). Treated as pass — does NOT block merge. Per-check `skipped: "timeout"` is NOT a pass — it's a failure that triggers the normal failure path.
  - **`Security note`** (bold or callout): `preference_commands` and `T##-PLAN verify:` values run in the repo's shell with the project's CWD. They come from trusted source files. DO NOT add unreviewed commands — anyone with write access to `.gsd/claude-agent-prefs.md` or a `T##-PLAN.md` can execute arbitrary shell commands on your machine.
  - **`Cross-references` bullet list**:
    - `scripts/forge-verify.js` — implementation.
    - `shared/forge-dispatch.md ## Verification Gate` — contract.
    - `agents/forge-executor.md` (step 10) — task-level invocation.
    - `agents/forge-completer.md` (step 3 of complete-slice) — slice-level invocation.
- The `## Notes` section at the bottom of `forge-agent-prefs.md` gets a new bullet:
  `Para mudar comandos de verify, edite o bloco "verification:" acima. Veja scripts/forge-verify.js para a implementação.`
- No other sections modified. Frontmatter (`version: 1`) unchanged.
- File remains valid Markdown with parseable inline YAML-ish examples (they're prose, not executed YAML).

### Artifacts

- `forge-agent-prefs.md` — modified. New `## Verification Settings` section (~40–60 lines). One bullet appended to `## Notes`.

### Key Links

- `forge-agent-prefs.md ## Verification Settings` → `scripts/forge-verify.js` (T01), `shared/forge-dispatch.md ## Verification Gate` (T02), `agents/forge-executor.md` (T03), `agents/forge-completer.md` (T04) via documentation links.

## Steps

1. Read `forge-agent-prefs.md` in full. Locate the `## Retry Settings` section (S01's block) and the `## Update Settings` section. The new block goes between them.
2. Read `## Retry Settings` carefully for style reference — match its heading depth, bullet style, code-block fencing, and tone (pt-BR mixed with code examples in English). The intro paragraph should be in pt-BR per `CODING-STANDARDS.md Language` (user-facing prefs template).
3. Use `Edit` tool with exact string match on the horizontal rule or heading between `## Retry Settings` and `## Update Settings` to insert the new section.
4. Append the one-line bullet to `## Notes`.
5. Verify parseability: `node -e "require('fs').readFileSync('forge-agent-prefs.md','utf8')"`. Confirm frontmatter `---\nversion: 1\n---` intact. Count `## ` headings: should be pre-count + 1.
6. Write `T05-SUMMARY.md` with:
   - Pre/post line count.
   - Confirmation section is positioned between `## Retry Settings` and `## Update Settings`.
   - Sample of the new YAML-ish block as rendered.
   - One-line verdict.

## Standards

- **Target file:** `forge-agent-prefs.md` (repo root — this is the TEMPLATE that install.sh/install.ps1 copies to `~/.claude/`). Do NOT edit `~/.claude/forge-agent-prefs.md` directly.
- **Reuse:** mirror S01's `## Retry Settings` block structure. Do NOT invent a new shape.
- **Naming:** section heading `## Verification Settings` (matching `## Retry Settings` capitalization). Config key `verification:` (lowercase, matching `retry:`).
- **Language:** intro paragraph + notes in pt-BR per `CODING-STANDARDS.md Language`. Code examples, field names, and cross-references in English.
- **Lint command:** `node -e "require('fs').readFileSync('forge-agent-prefs.md','utf8')"` — syntax/readability check. No Markdown linter configured.
- **Pattern:** no direct Pattern Catalog entry. Match the existing `forge-agent-prefs.md` style — YAML-ish fenced blocks + prose + bullet cross-references.

## Context

- **W5 mitigation (from S02-RISK):** this task documents that `verify:` in T##-PLAN frontmatter accepts both string (`verify: "npm run typecheck && npm test"`) and array forms. Mention in the `Discovery chain` subsection's step 1.
- **Security note is non-negotiable:** S02-RISK executor notes explicitly call out that commands come from trusted source files — the note must be included to prevent future contributors from treating `preference_commands` as safe defaults that can be populated from untrusted sources.
- **W4 reminder:** the intro paragraph should clarify that `preference_commands` is used at slice level (completer) whereas task-level reads `T##-PLAN verify:` first.
- **install.sh/install.ps1 contract:** both installers copy this file verbatim to `~/.claude/forge-agent-prefs.md`. Adding this section means every new install gets the verify docs. Existing installs will see the new section on next `/forge-update`.
- **No runtime behaviour change from this task** — this is pure documentation. The live behaviour is in T01's `forge-verify.js`.
- **Key files to read first:**
  - `forge-agent-prefs.md` (existing structure — especially `## Retry Settings` for style)
  - `scripts/forge-verify.js` (T01 — source of truth for field defaults)
  - `shared/forge-dispatch.md ## Verification Gate` (T02 — cross-reference)
  - `.gsd/CODING-STANDARDS.md ## Language` (pt-BR for user-facing messages)
