# S02: Evidence log + file-audit — UAT Script

**Slice:** S02  **Milestone:** M003  **Written:** 2026-04-16

## Prerequisites

- Forge agent installed (`install.sh` or `install.ps1` run with S02 changes included)
- Working directory: any forge-managed project with `.gsd/` initialized
- `node` available on PATH
- A recent `forge-auto` or `forge-next` run that produced an `auto-mode.json` with a `worker` field (or manually seed one — see Test Case 1)

---

## Test Cases

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 1 | Seed `.gsd/forge/auto-mode.json` with `{"active":true,"worker":"execute-task/T99"}`. Run any Bash command via Claude Code (e.g., `ls .`). Inspect `.gsd/forge/evidence-T99.jsonl`. | File exists. Contains exactly one line. Line is valid JSON with keys `ts`, `tool`, `cmd`, `file`, `ok`, `interrupted`. `tool` = `"Bash"`. Line length ≤ 512 bytes (`wc -c`). | |
| 2 | Continue from TC1. Run two more Bash commands via Claude Code. Re-inspect `evidence-T99.jsonl`. | File now has 3 lines (one per call, appended). Each line ≤ 512 bytes. | |
| 3 | Run a Write tool call (e.g., create a temp file via Claude Code). Inspect the evidence file. | A line with `"tool":"Write"` and non-null `file` field appears. `cmd` may be null or the file path. | |
| 4 | Add `evidence.mode: disabled` to `.gsd/prefs.local.md`. Run another Bash command. Inspect `.gsd/forge/`. | No new `evidence-*.jsonl` file is created for this call. Existing files from TC1–3 are unaffected (append-only). | |
| 5 | Remove `evidence.mode: disabled` from `.gsd/prefs.local.md`. Deliberately break the hook by temporarily inserting `throw new Error("test")` inside the evidence try block in `scripts/forge-hook.js`. Run a Bash call. | The tool call succeeds normally. No crash, no error surfaced to user. (Silent-fail per MEM008.) Restore the hook after verifying. | |
| 6 | Create a T##-SUMMARY.md with frontmatter `verification_evidence: [{command: "npm test", exit_code: 0, matched_line: 999}]` where line 999 does not exist in the corresponding evidence JSONL. Run `complete-slice` for the slice containing this T##. | `S##-SUMMARY.md` contains a `## Evidence Flags` section. The table lists the bogus claim with reason `command_not_in_log` or `command_mismatch_at_line`. | |
| 7 | Create a T##-SUMMARY.md with `verification_evidence: []` (empty array). Run `complete-slice`. | No `## Evidence Flags` section appears (empty array is valid — nothing to cross-ref). | |
| 8 | Add `evidence.mode: disabled` to `.gsd/prefs.local.md`. Run `complete-slice` on any slice. | No `## Evidence Flags` section appears in `S##-SUMMARY.md` (disabled mode skips the entire sub-step). Remove the override afterwards. | |
| 9 | Create a stray file (e.g. `scripts/forge-stray-test.js`) that is NOT referenced by any `expected_output:` in the slice's T##-PLANs. Stage it with `git add`. Run `complete-slice`. | `S##-SUMMARY.md` contains a `## File Audit` section. `scripts/forge-stray-test.js` appears under `unexpected`. Remove stray file after test. | |
| 10 | Add `dist/bundle.js` to the AM set (create + stage it). Run `complete-slice`. | `dist/bundle.js` does NOT appear in `## File Audit` (filtered by `file_audit.ignore_list` default which includes `dist/**`). | |
| 11 | Delete a source file during the slice (e.g., `git rm scripts/old-util.js`). Run `complete-slice`. | Deleted file does NOT appear anywhere in `## File Audit` (D4 LOCKED — AM filter excludes deletions). | |
| 12 | In a slice where all actual AM files exactly match all `expected_output` entries across T##-PLANs, and no unexpected files exist, run `complete-slice`. | `## File Audit` section is ABSENT from `S##-SUMMARY.md` (section omitted when both unexpected and missing lists are empty). | |
| 13 | Inspect `forge-agent-prefs.md`. Verify the `## File Audit Settings` section exists between `## Evidence Settings` and `## Token Budget Settings`. | Section present with `file_audit.ignore_list:` YAML array containing at minimum `package-lock.json`, `dist/**`, `.gsd/**`. | |

---

## Notes

- TC5 (hook silent-fail) requires temporarily editing `scripts/forge-hook.js`. Always restore before continuing.
- TC9 and TC10 require files staged in git (`git add`) so they appear in `git diff --name-only --diff-filter=AM`.
- TC6 can be done with a synthetic slice directory — no real task execution needed; just seed the T##-SUMMARY.md and T##-PLAN.md files and invoke `complete-slice` directly.
- The `evidence.mode` pref uses a 3-file cascade: `~/.claude/forge-agent-prefs.md` → `.gsd/claude-agent-prefs.md` → `.gsd/prefs.local.md`. Last file wins. Use `prefs.local.md` for test overrides to avoid polluting shared prefs.
- Evidence JSONL files are cleaned up with `milestone_cleanup: archive|delete` — they live under `.gsd/forge/` which is within the `.gsd/` tree managed by that setting.
