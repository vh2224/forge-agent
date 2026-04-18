---
id: T03
slice: S02
milestone: M003
status: DONE
must_haves:
  truths:
    - "agents/forge-completer.md step 1 documents a new sub-step that reads .gsd/forge/evidence-{T##}.jsonl for each task in the slice, cross-refs verification_evidence: from T##-SUMMARY.md frontmatter, and writes a ## Evidence Flags section to S##-SUMMARY.md when mismatches are detected"
    - "The documented cross-ref logic flags three conditions: (a) verification_evidence entry with matched_line: 0 (command not in log); (b) matched_line points at a line whose cmd field does NOT substring-match the claimed command; (c) evidence log missing entirely while verification_evidence: is non-empty"
    - "Evidence Flags section is advisory only — completer does NOT return blocked/partial based on it, does NOT alter auto_commit logic, does NOT abort merge"
    - "When evidence.mode is `disabled` (read from merged prefs), the cross-ref sub-step is skipped entirely and no ## Evidence Flags section is written — not even an empty one"
    - "Existing step numbering (1, 2, 3, ...) preserved bit-for-bit; the new work slots in as sub-step 1.5 or is appended inside step 1 (the summary-write step) without renumbering any other step"
    - "agents/forge-completer.md total length grows by ≤ 60 lines"
  artifacts:
    - path: "agents/forge-completer.md"
      provides: "completer instructions for reading evidence logs, cross-referencing verification_evidence claims from T##-SUMMARY, and writing ## Evidence Flags section"
      min_lines: 200
  key_links:
    - from: "agents/forge-completer.md"
      to: ".gsd/forge/evidence-{T##}.jsonl"
      via: "completer reads the JSONL file with fs.readFileSync and parses each line as JSON (documented shell commands to read lines)"
    - from: "agents/forge-completer.md"
      to: ".gsd/milestones/M###/slices/S##/tasks/T##/T##-SUMMARY.md"
      via: "completer parses verification_evidence: YAML frontmatter via the same idiom used in scripts/forge-verify.js lines 420-466 (documented via direct shell grep/awk OR read + regex — completer uses Bash only)"
expected_output:
  - agents/forge-completer.md
---

# T03: Completer writes ## Evidence Flags section

**Slice:** S02  **Milestone:** M003

## Goal

Update `agents/forge-completer.md` so `complete-slice` — after writing `S##-SUMMARY.md` — cross-references each task's `verification_evidence:` claims against its `.gsd/forge/evidence-{T##}.jsonl` log and appends a `## Evidence Flags` section listing any mismatches. Advisory only. Skipped when `evidence.mode: disabled`.

## Must-Haves

### Truths
- Completer step 1 (summary writing) gains a documented cross-ref sub-step that produces the `## Evidence Flags` section.
- Three mismatch conditions are named: (a) `matched_line: 0`, (b) matched_line points at a non-matching command, (c) evidence log missing while `verification_evidence:` is non-empty.
- Evidence Flags section is ADVISORY — no `status: blocked`, no merge-abort.
- `evidence.mode: disabled` path skips the sub-step entirely — no section written.
- Existing step numbering preserved — new work is additive, either as sub-step 1.5 OR appended within step 1.
- `agents/forge-completer.md` total grows by ≤ 60 lines.

### Artifacts
- `agents/forge-completer.md` — completer agent definition with new Evidence Flags documentation. Current file ~155 lines; min total after edit is 200 lines.

### Key Links
- `agents/forge-completer.md` → `.gsd/forge/evidence-{T##}.jsonl` via documented `cat` / `wc -l` / `awk "NR==N"` read pattern (completer is a Markdown agent — executes Bash).
- `agents/forge-completer.md` → `T##-SUMMARY.md` via YAML frontmatter parse. Completer shells out:
  ```bash
  # Extract the verification_evidence block — use grep + sed OR a helper node snippet
  ```
  Completer may also re-use `scripts/forge-must-haves.js` indirectly — NO: `forge-must-haves` parses `must_haves:`/`expected_output:` only. For `verification_evidence:` the completer uses inline Bash (grep/awk) or a tiny node -e one-liner. Document the inline one-liner pattern.

## Steps

1. Read `agents/forge-completer.md` fully (155 lines). Focus on step 1 (`complete-slice` summary writing, lines 19–41 of current file) and its Forward Intelligence template. The Evidence Flags section sits naturally inside step 1 as the penultimate sub-step (after `## Forward Intelligence`, before `drill_down_paths`), OR as a new sub-step `1.5` inserted between step 1 and step 2 (UAT writing). Choose **sub-step 1.5** to keep step 1's internal structure clean.

2. Insert the new sub-step between current step 1 and step 2. Suggested text:
   ```markdown
   1.5. **Evidence cross-ref — write `## Evidence Flags` section to `S##-SUMMARY.md`** (advisory; skipped when `evidence.mode: disabled`).

       Read the merged `evidence.mode` pref (inline Bash):
       ```bash
       node -e "
       const fs=require('fs'),path=require('path'),os=require('os');
       const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
                    path.join('{WORKING_DIR}','.gsd','claude-agent-prefs.md'),
                    path.join('{WORKING_DIR}','.gsd','prefs.local.md')];
       let mode='lenient';
       for(const f of files){try{const r=fs.readFileSync(f,'utf8');const m=r.match(/^evidence:[ \t]*\n[ \t]+mode:[ \t]*(\w+)/m);if(m)mode=m[1].toLowerCase();}catch{}}
       process.stdout.write(mode);
       "
       ```
       If the result is `disabled` → SKIP this entire sub-step. Do NOT write `## Evidence Flags`, not even an empty one.

       For each `T##-SUMMARY.md` in the slice (under `.gsd/milestones/M###/slices/S##/tasks/T##/`):

       a. **Parse `verification_evidence:` from the SUMMARY frontmatter.** Use a tiny node one-liner (no new script):
          ```bash
          node -e "
          const fs=require('fs');
          const raw=fs.readFileSync('<T##-SUMMARY.md>','utf8');
          const fm=(raw.match(/^---\\n([\\s\\S]*?)\\n---/)||[])[1]||'';
          const block=fm.match(/^verification_evidence:[ \\t]*\\n([\\s\\S]*?)(?=\\n[a-zA-Z_][^\\n]*:|$)/m);
          if(!block){process.stdout.write('[]');process.exit(0)}
          const lines=block[1].split('\\n');
          const entries=[];let cur=null;
          for(const l of lines){
            const m=l.match(/^\\s+-\\s+command:\\s*\"?([^\"]*)\"?/);
            if(m){if(cur)entries.push(cur);cur={command:m[1],exit_code:null,matched_line:null};continue}
            const e=l.match(/^\\s+exit_code:\\s*(-?\\d+)/);if(e&&cur){cur.exit_code=+e[1];continue}
            const ml=l.match(/^\\s+matched_line:\\s*(-?\\d+)/);if(ml&&cur){cur.matched_line=+ml[1];continue}
          }
          if(cur)entries.push(cur);
          process.stdout.write(JSON.stringify(entries));
          "
          ```
          Output: `[{command, exit_code, matched_line}, ...]` or `[]`.

       b. **Read `.gsd/forge/evidence-{T##}.jsonl`.** If the file does not exist AND `verification_evidence:` is non-empty → that is **condition (c)** — record a flag with reason `evidence_log_missing` for each claimed entry.

       c. **For each entry, classify:**
          - `matched_line === 0` → **condition (a)** — flag reason `command_not_in_log`.
          - `matched_line > 0` → read line N of the JSONL (`sed -n "<N>p" <evidence-file>`), parse JSON, check whether the log line's `cmd` field contains the claimed `command` (substring match, case-sensitive, first 80 chars). If NO substring match → **condition (b)** — flag reason `command_mismatch_at_line`.
          - `matched_line > 0` and substring match → no flag.

       d. **Collect all flags from all tasks.** If flags is non-empty, append a `## Evidence Flags` section to `S##-SUMMARY.md`:
          ```markdown
          ## Evidence Flags

          _Advisory only — these claims in T##-SUMMARY.md `verification_evidence:` could not be corroborated by the PostToolUse evidence log. No action taken; recorded for auditing._

          | Task | Claim (command) | Reason |
          |------|-----------------|--------|
          | T01  | `npm run typecheck` | `command_not_in_log` (matched_line=0) |
          | T02  | `npm test` | `command_mismatch_at_line` (line 3 of evidence-T02.jsonl has cmd="echo hello") |
          | T03  | `npm run lint` | `evidence_log_missing` (file not found: .gsd/forge/evidence-T03.jsonl) |
          ```

          If flags is empty → do NOT write the section at all (absence is good news, no noise).

       This sub-step is **advisory**. Do NOT return `status: blocked` based on flags. Do NOT abort merge. The section is purely documentation.
   ```

3. Also update the step-1 description of `S##-SUMMARY.md` frontmatter keys (current step 1 lists `id, milestone, provides, key_files, key_decisions, patterns_established`) — add a NOTE line below (do not modify the bulleted list):
   ```markdown
   > Note: `## Evidence Flags` section (written by sub-step 1.5 below) may appear in the body if evidence cross-ref flagged any claims.
   ```

4. Verify:
   - `grep -n "^1\\.5\\." agents/forge-completer.md` returns exactly one match.
   - `grep -n "^## Evidence Flags" agents/forge-completer.md` returns ≥ 1 match (inside the documentation block).
   - `grep -c "verification_evidence:" agents/forge-completer.md` returns ≥ 2 (inline examples).
   - Existing steps 1, 2, 3, 4, 5, 6, 7, 8, 9 still present with original content (diff-clean outside the insertion point).
   - Frontmatter (`name, description, model, tools`) unchanged.
   - Balanced fences: `awk '/^```/{n++} END{print n}' agents/forge-completer.md` returns an even number.

## Standards

- **Target directory:** `agents/` (existing file; additive edit).
- **Naming:** preserve existing file name; sub-step number `1.5` (keeps step 1 conceptually intact).
- **Pattern:** agent-documentation insertion. Inline `node -e` one-liners are the sanctioned pattern (completer has `Bash` in tools frontmatter — confirmed at line 5 of existing file).
- **Reuse:** the inline `node -e` frontmatter-parse idiom mirrors `scripts/forge-verify.js` lines 420–466 (frontmatter extract regex). Do NOT add a new script — the completer's inline Bash with a `node -e` one-liner is the pattern established by other agents (e.g., executor step 1a uses `node scripts/forge-must-haves.js`). Keep the one-liner small and recognisable.
- **Lint:** no Markdown lint; verify balanced fences per step 4.
- **Language:** English (agent prompts).
- **No new deps:** the `node -e` one-liner uses only `fs` — no extra requires.

## Context

- **Prior decisions to respect:**
  - D1 — no new scripts; use existing infrastructure.
  - D2 — `verification_evidence:` shape is `[{command, exit_code, matched_line}]` (LOCKED in S01/T02 docs; T03 consumes this shape).
  - SCOPE C5 — `## Evidence Flags` is advisory. No blocker in M003. Strict-mode blocker reserved for M004+.
  - MEM008 — hooks silent-fail; completer is NOT a hook but its evidence-read should also be tolerant: if the log is corrupted or unreadable, flag the condition rather than crash.
- **Key files to read first:**
  - `agents/forge-completer.md` lines 15–41 (current step 1 — summary writing, Forward Intelligence template).
  - `agents/forge-completer.md` line 5 (tools: Read, Write, Edit, Bash — confirms Bash is available for the `node -e` one-liner).
  - `agents/forge-executor.md` step 1a (S01 precedent — uses `node scripts/forge-must-haves.js` as external shell-out; here we use `node -e` inline because the parse is narrow and we're not sharing logic with another agent).
  - `scripts/forge-verify.js` lines 420–466 (YAML frontmatter extract regex — the exact regex shape we're inlining in the one-liner).
- **Relationship to T01 + T02:** T03 is the CONSUMER of both producers. T01 writes the log. T02 writes the SUMMARY field. T03 reads both and cross-refs. If either producer fails (T01 silent-fails, T02 emits `[]`), T03's flags surface the gap as advisory.
- **Not in scope:** file-audit (handled in T04, same completer agent, different section). T04's `## File Audit` section will be written by a DIFFERENT sub-step; the two are independent reads.
- **Forward intelligence for S03:** the verifier (S03) may re-use the inline `node -e` parse idiom OR the `scripts/forge-verify.js` frontmatter extract — both are canonical. If this one-liner proves noisy, consider extracting it into a small `scripts/forge-evidence.js` reader in S03 — do NOT do that in T03 (avoid scope creep within S02).
