---
id: T04
slice: S02
milestone: M003
status: DONE
must_haves:
  truths:
    - "agents/forge-completer.md documents a new sub-step that runs git diff --name-only --diff-filter=AM to compute the set of added/modified files in the slice and cross-refs them against the union of expected_output from every T##-PLAN.md"
    - "Mismatches are written as a ## File Audit section in S##-SUMMARY.md with two sub-lists: `unexpected` (actual AM files not in expected_output union) and `missing` (expected paths with no AM diff entry)"
    - "The documented diff command excludes deletions (--diff-filter=AM only — D4 LOCKED — no expected_deletions: field, no deletion tracking)"
    - "Files matching file_audit.ignore_list glob patterns (read from merged prefs with fallback to hardcoded defaults) are filtered out of both sides before diff"
    - "expected_output is parsed for each T##-PLAN.md via `node scripts/forge-must-haves.js --check <plan>` (reuse existing CLI from S01 T01); legacy plans (check returns `legacy:true`) contribute an empty set — no expected_output to audit against"
    - "File Audit section is advisory only — does NOT alter merge logic, status, or exit code"
    - "Existing completer step numbering preserved — new work added as sub-step 1.6 (after 1.5 evidence flags, before step 2 UAT)"
  artifacts:
    - path: "agents/forge-completer.md"
      provides: "completer instructions for git diff --diff-filter=AM, union-of-expected_output parse, ignore_list filtering, and ## File Audit section emission"
      min_lines: 250
  key_links:
    - from: "agents/forge-completer.md"
      to: "scripts/forge-must-haves.js"
      via: "completer shells out `node scripts/forge-must-haves.js --check <plan>` per T##-PLAN; parses JSON stdout for expected_output"
    - from: "agents/forge-completer.md"
      to: "forge-agent-prefs.md"
      via: "completer reads file_audit.ignore_list from merged prefs (same cascade order as evidence.mode)"
expected_output:
  - agents/forge-completer.md
---

# T04: Completer writes ## File Audit section

**Slice:** S02  **Milestone:** M003

## Goal

Update `agents/forge-completer.md` so `complete-slice` — after writing `S##-SUMMARY.md` and (optionally) `## Evidence Flags` — runs `git diff --name-only --diff-filter=AM` and compares the result against the union of `expected_output` from all tasks' PLANs. Unexpected/missing files are listed under a `## File Audit` section. Advisory only (C6). Deletions are NOT audited (D4).

## Must-Haves

### Truths
- Completer runs `git diff --name-only --diff-filter=AM` to enumerate added/modified files in the slice.
- Union of `expected_output` is built via `node scripts/forge-must-haves.js --check <plan>` per T##-PLAN.md; legacy plans contribute empty set.
- `file_audit.ignore_list` glob patterns filter BOTH sides before diff.
- Mismatches written as `## File Audit` section with `unexpected` + `missing` sub-lists.
- Deletions are NOT audited (D4 LOCKED).
- Section is advisory — no status change, no merge abort.
- Existing step numbering preserved; new sub-step is `1.6` (between 1.5 and 2).
- `agents/forge-completer.md` grows by ≤ 90 lines total (1.5 + 1.6 = ≤ 150 lines combined).

### Artifacts
- `agents/forge-completer.md` — now documenting BOTH Evidence Flags (T03) AND File Audit (T04). Min total after edit: 250 lines.

### Key Links
- `agents/forge-completer.md` → `scripts/forge-must-haves.js --check` via shell-out per T##-PLAN to parse `expected_output`.
- `agents/forge-completer.md` → `forge-agent-prefs.md` via inline `node -e` reading `file_audit.ignore_list` from merged prefs.

## Steps

1. Read `agents/forge-completer.md` as it stands AFTER T03's edit (T04 runs after T03 in execution order per S02-PLAN). Confirm sub-step 1.5 is in place; 1.6 insertion point is immediately after 1.5 and before step 2 (`Write S##-UAT.md`).

2. Insert sub-step **1.6** after 1.5:
   ```markdown
   1.6. **File audit — write `## File Audit` section to `S##-SUMMARY.md`** (advisory; always runs regardless of `evidence.mode`).

       a. **Determine the slice diff set.** Use `git diff --name-only --diff-filter=AM` from the merge-base of the slice branch to HEAD. For a slice branch `gsd/M###/S##`:
          ```bash
          git diff --name-only --diff-filter=AM "$(git merge-base HEAD master)...HEAD"
          ```
          If `auto_commit: false` (no branch), use working-tree diff against HEAD:
          ```bash
          git diff --name-only --diff-filter=AM HEAD
          # Plus untracked files (git diff doesn't show these):
          git ls-files --others --exclude-standard
          ```
          Collect all paths into a Set → `ACTUAL_AM`.

       b. **Build expected_output union.** For each `T##-PLAN.md` under `.gsd/milestones/M###/slices/S##/tasks/T##/`:
          ```bash
          node scripts/forge-must-haves.js --check .gsd/milestones/M###/slices/S##/tasks/T##/T##-PLAN.md
          ```
          Parse the JSON stdout:
          - `{legacy: true}` → contributes nothing (empty set).
          - `{legacy: false, valid: true}` → parse the plan frontmatter again to extract `expected_output:` array (the CLI does not emit it in JSON — fall back to direct parse via the same inline node one-liner pattern used in T03, OR extend the CLI output if minor change fits; T04 uses the inline parse to avoid scope creep in forge-must-haves.js).
          - `{legacy: false, valid: false}` → skip this plan with a warn note (malformed plan shouldn't block the audit).

          Inline parse for `expected_output` (no new script):
          ```bash
          node -e "
          const fs=require('fs');
          const raw=fs.readFileSync('<T##-PLAN.md>','utf8');
          const fm=(raw.match(/^---\\n([\\s\\S]*?)\\n---/)||[])[1]||'';
          // expected_output may be inline [a, b] OR multi-line dash array
          const inline=fm.match(/^expected_output:[ \\t]*\\[([^\\]]*)\\]/m);
          if(inline){
            const items=inline[1].split(',').map(s=>s.trim().replace(/^[\"']|[\"']$/g,'')).filter(Boolean);
            process.stdout.write(JSON.stringify(items));process.exit(0);
          }
          const block=fm.match(/^expected_output:[ \\t]*\\n((?:[ \\t]+-[^\\n]*\\n?)+)/m);
          if(block){
            const items=block[1].split('\\n').filter(l=>/^\\s+-\\s+/.test(l))
              .map(l=>l.replace(/^\\s+-\\s+/,'').trim().replace(/^[\"']|[\"']$/g,''));
            process.stdout.write(JSON.stringify(items));process.exit(0);
          }
          process.stdout.write('[]');
          "
          ```
          Union all results → `EXPECTED`.

       c. **Read `file_audit.ignore_list` from merged prefs.** Inline one-liner (mirrors T03):
          ```bash
          node -e "
          const fs=require('fs'),path=require('path'),os=require('os');
          const files=[path.join(os.homedir(),'.claude','forge-agent-prefs.md'),
                       path.join('{WORKING_DIR}','.gsd','claude-agent-prefs.md'),
                       path.join('{WORKING_DIR}','.gsd','prefs.local.md')];
          const DEFAULT=['package-lock.json','yarn.lock','pnpm-lock.yaml','dist/**','build/**','.next/**','.gsd/**'];
          let list=DEFAULT;
          for(const f of files){
            try{
              const r=fs.readFileSync(f,'utf8');
              const block=r.match(/^file_audit:[ \\t]*\\n[ \\t]+ignore_list:[ \\t]*\\[([^\\]]*)\\]/m);
              if(block){
                const items=block[1].split(',').map(s=>s.trim().replace(/^[\"']|[\"']$/g,'')).filter(Boolean);
                if(items.length)list=items;
              }
            }catch{}
          }
          process.stdout.write(JSON.stringify(list));
          "
          ```

       d. **Filter both sides with ignore_list.** A path matches a glob when:
          - Pattern has no `*` / `?` → exact prefix match (`.gsd/` matches `.gsd/anything/here`).
          - Pattern ends with `/**` → prefix match of everything before `/**`.
          - Pattern has a single `**` in the middle → split on `**`, match start + end substrings.
          - Otherwise → escape regex metachars, convert `*` to `[^/]*`, anchor at both ends.

          Filter both `ACTUAL_AM` and `EXPECTED` through the ignore matcher. Any path matching any ignore pattern is dropped from that side.

       e. **Diff the sets.**
          - `unexpected` = ACTUAL_AM \\ EXPECTED (files changed but not promised by any plan).
          - `missing` = EXPECTED \\ ACTUAL_AM (files promised but no AM diff entry — possibly means plan was wrong, or file was created then reverted).

       f. **Write `## File Audit` section** to `S##-SUMMARY.md`. Always write the section if BOTH `unexpected` and `missing` are non-empty; if both are empty, OMIT the section (no noise).
          ```markdown
          ## File Audit

          _Advisory — git diff `--diff-filter=AM` vs union of `expected_output:` across all T##-PLAN.md. Deletions not audited per M003 decision D4. Ignore list applied from `file_audit.ignore_list` prefs._

          **Unexpected (changed but not promised):**
          - `scripts/forge-stray.js` (added by T02 — not in any expected_output)
          - `agents/forge-x.md` (modified by T03 — not in any expected_output)

          **Missing (promised but no diff entry):**
          - `scripts/forge-other.js` (declared in T01 `expected_output` — no AM diff)

          Advisory only — no action taken; recorded for auditing.
          ```

          If only one list has entries, include only that sub-heading. If both empty, omit section.

       This sub-step is advisory. Do NOT return `status: blocked`. Do NOT abort merge. Even malformed plans or git failures surface as flags, not errors (use try/catch silent-fail around each shell-out).
   ```

3. Verify:
   - `grep -n "^1\\.6\\." agents/forge-completer.md` returns exactly one match.
   - `grep -c "^## File Audit" agents/forge-completer.md` returns ≥ 1 (inside the documentation).
   - `grep -c "diff-filter=AM" agents/forge-completer.md` returns ≥ 2 (at least in the command example and the intro paragraph).
   - Existing steps 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9 remain in the same order.
   - Frontmatter unchanged.
   - Balanced fences: `awk '/^```/{n++} END{print n}' agents/forge-completer.md` returns even number.

## Standards

- **Target directory:** `agents/` (existing file, additive).
- **Naming:** sub-step `1.6` (after 1.5 from T03).
- **Pattern:** documentation edit; inline Bash + `node -e` one-liners per T03 precedent. No new scripts.
- **Reuse:**
  - `scripts/forge-must-haves.js --check` — CLI shell-out to classify plans (shipped in S01/T01).
  - YAML frontmatter extract regex from `scripts/forge-verify.js` lines 420–466 — adapted inline for `expected_output:` parse.
  - Prefs cascade read pattern from T01/T03 — same three-file order, same `node -e` idiom.
- **Lint:** no Markdown lint; verify balanced fences.
- **Language:** English (agent prompts).
- **No new deps:** Node built-ins + git CLI (git is assumed present per CODING-STANDARDS § Path Handling and the git-diff plumbing in completer's current step 6).

## Context

- **Prior decisions to respect:**
  - D4 (LOCKED) — `--diff-filter=AM` only. No `expected_deletions:` field. If a task deletes a file, the planner adds a `## Notes` line in the plan — NOT a new schema field.
  - SCOPE C6 — File-change validator. Advisory only.
  - SCOPE C11 — `file_audit.ignore_list` prefs key (defaults lands in T05; T04 consumes with hardcoded fallback).
  - MEM017 / zero-deps — no `minimatch`, no `glob`. Hand-rolled prefix/substring matching covers the documented default patterns (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `dist/**`, `build/**`, `.next/**`, `.gsd/**`).
- **Key files to read first:**
  - `agents/forge-completer.md` lines 70–85 (current step 6 — git squash-merge, which already uses git). Confirms git is available from the completer's Bash tool.
  - `scripts/forge-must-haves.js` CLI output (lines 323–370 of that file) — JSON shape `{legacy, valid, errors}`. LOCKED.
  - `forge-agent-prefs.md § Evidence Settings` — style reference for the new `## File Audit Settings` block (shipped in T05; T04 reads the key).
- **Why inline parse for `expected_output` in step b:** the `forge-must-haves.js` CLI's current JSON output does NOT include the parsed `expected_output` array — it only returns `{legacy, valid, errors}`. Extending the CLI to emit the parsed object would reopen the S01 schema contract (and T01 is DONE). The inline parse is the pragmatic choice; it reuses the regex shape but is local to the completer. If future slices need this parse broadly, extract into `scripts/forge-expected.js` — NOT in T04.
- **Relationship to T05:** T05 ships the `file_audit.ignore_list` pref default. T04's inline `node -e` has a hardcoded fallback that matches T05's default exactly, so T04 works even without T05. Execution order per S02-PLAN: T05 before T04 — so the live prefs key is available when T04's completer runs.
- **Not in scope:**
  - Deletion tracking (deferred per D4).
  - `expected_deletions:` frontmatter field (rejected per D4).
  - Auto-fixing unexpected files (not advisory — M003 is advisory-only).
- **Forward intelligence for S03:** the verifier's Exists/Substantive/Wired checks may consume the same `ACTUAL_AM` set — but that's the verifier's concern, not T04's. Keep the diff logic inline here; if S03 benefits from extraction, do it there.
