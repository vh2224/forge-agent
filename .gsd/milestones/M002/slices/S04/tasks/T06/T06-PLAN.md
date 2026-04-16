---
id: T06
slice: S04
milestone: M002
status: DONE
---

# T06: Write S04-SUMMARY.md + CLAUDE.md decision entry

**Slice:** S04  **Milestone:** M002

## Goal
Close the slice by producing a publication-quality S04-SUMMARY.md (consolidating artifacts + demos + lessons) and append a new "Tier-only model routing" decision entry to the root `CLAUDE.md` Decisions section so future agents learn about the routing behavior without re-reading the milestone.

## Must-Haves

### Truths
- `.gsd/milestones/M002/slices/S04/S04-SUMMARY.md` exists with frontmatter `id: S04`, `milestone: M002`, `status: ready-for-completer`, `completed_at: <ISO timestamp>` (draft allowed).
- SUMMARY includes these sections in order: **Goal** (restatement, 2–4 lines) → **Outcome** (bullet list of all 6 tasks + what each produced) → **Artifacts produced** (table with Path / Status / Task columns, matching the ROADMAP boundary map verbatim) → **Demo transcripts** (the 5 `events.jsonl` dispatch lines from T05, each with a label stating which acceptance criterion it proves) → **Lessons Learned** (2–5 bullets — things discovered during execution that should become memory candidates) → **Follow-ups / out-of-scope** (optional; note any deferred ideas surfaced during S04).
- `CLAUDE.md` contains a new decision entry in the `## Decisões de arquitetura recentes` section (inserted at the END of that section's last entry, before the `## Convenções de código` heading). The entry has a bold heading `### Tier-only model routing (M002 S04)` and a 3–5 line paragraph summarizing: tier mapping source (`shared/forge-tiers.md`), override precedence, prefs knob (`tier_models:`), event schema extension.
- The CLAUDE.md edit does NOT touch any other section — no reformatting, no reordering of prior decisions, no Auto-Rules updates.

### Artifacts
- `.gsd/milestones/M002/slices/S04/S04-SUMMARY.md` — new.
- `CLAUDE.md` — modified (+~8–12 lines, new decision entry only).

### Key Links
- `S04-SUMMARY.md § Artifacts produced` → lists every file touched by T01–T05.
- `S04-SUMMARY.md § Demo transcripts` → consumes evidence from T05's `T05-DEMOS.md` (or equivalent).
- `CLAUDE.md § Tier-only model routing` → cross-references `shared/forge-tiers.md`, `shared/forge-dispatch.md § Tier Resolution`, `forge-agent-prefs.md § Tier Settings`.

## Steps
1. Read `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md` and `S03/S03-SUMMARY.md` in full as structural templates.
2. Read T01–T05 summary outputs (`T##-SUMMARY.md` files produced by each executor) to gather the actual artifact list and line counts.
3. Read T05's demo evidence file (produced in T05 — `T05-DEMOS.md` or similar) for the 5 events.jsonl lines.
4. Draft `S04-SUMMARY.md` following the S01/S03 template exactly (frontmatter → Goal → Outcome → Artifacts produced → additional sections).
5. Read `CLAUDE.md` `## Decisões de arquitetura recentes` section — note the heading style of the most recent entries (H3 bold or paragraph-style? Follow existing style).
6. Append the new "Tier-only model routing" entry at the end of that section. Do not touch other sections.
7. Verify nothing outside the Decisions section was modified: `git diff CLAUDE.md | grep -c '^+' | head` should show a small number of added lines and no deletions outside the insertion range.
8. Run a final grep-check that SUMMARY references match actual file state: `ls -la shared/forge-tiers.md` should exist; `grep -n "### Tier Resolution" shared/forge-dispatch.md` must return 1 line; `grep -n "tier_models:" forge-agent-prefs.md` must return 1 line.

## Standards
- **Target directory:** Summary goes under `.gsd/milestones/M002/slices/S04/`. CLAUDE.md is at project root.
- **Reuse:** Follow `.gsd/milestones/M002/slices/S01/S01-SUMMARY.md` shape exactly — it's the canonical slice-summary template in this milestone.
- **Naming:** File is `S04-SUMMARY.md` (uppercase). Timestamp in frontmatter uses ISO 8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`).
- **Lint command:** Manual YAML frontmatter check — open with a YAML parser or eyeball: `---` delimiters intact, no tabs, no trailing spaces in keys.
- **Pattern:** `follows: Skill frontmatter + body` loosely (summary has frontmatter + body). Closer match is simply "slice-summary template" as established by S01/S03.

## Context
- **CS_RULES:** "STATE.md is single source of truth — only orchestrator and forge-completer write to it." This task does NOT touch STATE.md. The completer (invoked after T06 returns done) will promote S04 to done in STATE.md and append the entry to LEDGER.md.
- **CS_RULES:** "DECISIONS.md is append-only — never edit existing lines." The CLAUDE.md edit is also append-only (new entry at end of the Decisions section). No reflow, no reordering.
- **MEM004 & MEM005:** Not directly relevant (no skill or command files modified).
- **S01/S03 precedent for summaries:** Both include a Goal, Outcome, and Artifacts-produced table. S03 has a "Demo transcripts" section — we follow that. S01's `## Artefacts produced` table with Path/Status/Task columns is the canonical shape.
- **LEDGER.md & AUTO-MEMORY.md:** Not written by this task — the completer handles those at slice close. But T06's "Lessons Learned" bullets are the RAW MATERIAL that `forge-memory` (Haiku) will later distill into memory entries.
- **Milestone completion:** M002 is a 4-slice milestone; S04 is the final slice. After T06 returns done, the completer runs `complete-slice` and then `complete-milestone`, which in turn writes the LEDGER entry and (if configured) archives the milestone directory.
- **AUTONOMY:** The executor of this task does NOT invoke `/forge-next` or `/forge-auto` — summary writing is a worker action, not an orchestrator action.
