# T01: Smoke test — verify Agent() exception is classifier-legible

status: DONE

**Slice:** S01  **Milestone:** M002

## Goal
Before writing any classifier code, force a transient `Agent()` failure inside the forge-auto loop and confirm that the exception text reaching the orchestrator's catch block is textually rich enough for regex classification (rate-limit, network, server, stream, connection). This is a HARD GATE for the rest of S01 — if the text is opaque, abort the slice and escalate.

## Must-Haves

### Truths
- A smoke harness exists (one-off script or inline worker prompt) that causes `Agent()` to throw with at least three distinct simulated error shapes: a 503 server error, a 429 rate-limit, and an ECONNRESET network error.
- The raw exception text observed by the orchestrator is captured verbatim for each of the three cases.
- For each captured text, at least one of the GSD-2 regex groups matches (`PERMANENT_RE`, `RATE_LIMIT_RE`, `NETWORK_RE`, `SERVER_RE`, `CONNECTION_RE`, `STREAM_RE`). Documented match per case.
- `S01-SMOKE.md` summarises findings with a `## Verdict` section clearly marking `PROCEED` or `ABORT` for the remainder of the slice.

### Artifacts
- `.gsd/milestones/M002/slices/S01/S01-SMOKE.md` — evidence document, ~40-80 lines, sections: `## Method`, `## Case 1 (503)`, `## Case 2 (429)`, `## Case 3 (ECONNRESET)`, `## Regex match analysis`, `## Verdict`.

### Key Links
- Reference regex source: `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js` lines 21–29 (the six REs).
- Catch site to probe in: `skills/forge-auto/SKILL.md` Step 4 "CRITICAL — Agent() dispatch failure" block (lines ~250–258).

## Steps
1. Read `skills/forge-auto/SKILL.md` Step 4 Dispatch section and `commands/forge-next.md` (if it exists) to locate the exact place where `Agent()` is invoked and where an exception would surface.
2. Identify the most reliable simulation mechanism that does NOT modify production files. Options in preference order:
   a. Dispatch an intentionally malformed `Agent()` call (invalid `subagent_type`) and observe the resulting exception text.
   b. Dispatch a valid agent but with a prompt that requests an unavailable tool or missing file to force an internal failure.
   c. Use `Bash` to query Claude Code logs (`~/.claude/logs/*` or platform equivalent) looking for prior real 429/503/ECONNRESET incidents.
3. Execute at least three probes covering: (a) server-class failure, (b) rate-limit-class, (c) network-class. Capture the verbatim text that would reach a `try/catch` around the `Agent()` call.
4. Run each captured string through the six GSD-2 regexes (either mentally, via Node REPL, or via a quick one-off `node -e` inline check) and record which group matches.
5. Write `S01-SMOKE.md` with Method, the three cases (verbatim error text + regex match), and a clear `## Verdict` section.
6. Decision logic:
   - If 3/3 cases match a regex → Verdict: `PROCEED`. Slice continues with T02.
   - If 2/3 match → Verdict: `PROCEED WITH CAVEAT`. Document the opaque case; T02 must add a `UNKNOWN_BUT_TRANSIENT_RE` fallback.
   - If ≤1 match → Verdict: `ABORT`. Do not write T02. Surface via T01-SUMMARY.md and return `blocked` so the user can decide whether to escalate.

## Standards
- **Target directory:** artefacts go under `.gsd/milestones/M002/slices/S01/` — no source code changes in this task.
- **Reuse:** the six regexes in the GSD-2 reference file. Do not invent new patterns in T01 (that is T02's job).
- **Naming:** evidence file is `S01-SMOKE.md` (uppercase, matches existing `S##-RISK.md` / `S##-SUMMARY.md` convention).
- **Lint command:** (none — documentation-only task, no code emitted).
- **Pattern:** no matching entry in Pattern Catalog (project lacks `.gsd/CODING-STANDARDS.md`).

## Context
- M002 ROADMAP Risk Notes explicitly flags this as non-negotiable: *"if `Agent()` exception text is opaque to the orchestrator catch block, the entire milestone architecture collapses"*.
- Brainstorm Lens 3 risk #4: "Error classifier não tem acesso à exceção real" — this task validates against that risk.
- M002-CONTEXT decision: `max_transient_retries: 3`; retryable classes are `rate_limit`, `network`, `server`, `stream`; non-retryable are `permanent`, `model_refusal`, `context_overflow`, `tooling_failure`.
- MEM022 reminder: when adding any allowed-tools to skills, declare in SKILL.md YAML header — applies if T04 needs to extend the skill frontmatter later.
- Key files to read first:
  - `C:/Users/VINICIUS/.gsd/agent/extensions/gsd/error-classifier.js`
  - `skills/forge-auto/SKILL.md` Step 4
  - `.gsd/milestones/M002/M002-ROADMAP.md` S01 entry + Risk Notes
