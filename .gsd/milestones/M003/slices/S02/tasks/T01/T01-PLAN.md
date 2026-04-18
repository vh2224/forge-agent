---
id: T01
slice: S02
milestone: M003
status: DONE
must_haves:
  truths:
    - "scripts/forge-hook.js PostToolUse branch writes one JSON line per Bash/Write/Edit call to .gsd/forge/evidence-{unitId}.jsonl"
    - "Each evidence line is ≤ 512 bytes (measurable with wc -c after splitting on newline)"
    - "Evidence write is wrapped in try/catch; a thrown error inside the evidence block does NOT abort the tool call (MEM008 — hook exit 0 always)"
    - "unitId is resolved from .gsd/forge/auto-mode.json `worker` field (shape `unit_type/UNIT_ID`); when absent or null, unitId defaults to 'adhoc' and the line is written to evidence-adhoc.jsonl"
    - "evidence.mode prefs key is read from merged prefs (~/.claude/forge-agent-prefs.md → .gsd/claude-agent-prefs.md → .gsd/prefs.local.md, last wins); `disabled` short-circuits the evidence branch; `lenient` and `strict` both write the same log line"
    - "Existing PostToolUse Agent-dispatch tracking behavior is preserved bit-for-bit — the evidence branch runs BEFORE or alongside, not in place of, the existing tool_name === 'Agent' block"
    - "Node --check scripts/forge-hook.js passes after edit"
  artifacts:
    - path: "scripts/forge-hook.js"
      provides: "extended PostToolUse branch: evidence line append for Bash/Write/Edit + unitId resolution from auto-mode.json + evidence.mode pref read + size-capped JSON line"
      min_lines: 280
      stub_patterns: ["return null", "function.*\\{\\s*\\}", "=> \\{\\s*\\}", "TODO", "FIXME"]
  key_links:
    - from: "scripts/forge-hook.js"
      to: ".gsd/forge/auto-mode.json"
      via: "fs.readFileSync on PostToolUse to parse `worker` → unitId"
    - from: "scripts/forge-hook.js"
      to: ".gsd/forge/evidence-{unitId}.jsonl"
      via: "fs.appendFileSync of JSON.stringify(evidenceLine) + '\\n'"
    - from: "scripts/forge-hook.js"
      to: "forge-agent-prefs.md"
      via: "regex read of `evidence:\\s*\\n\\s*mode:\\s*(\\w+)` from merged prefs files — defaults to 'lenient' when absent"
expected_output:
  - scripts/forge-hook.js
---

# T01: PostToolUse evidence capture in forge-hook.js

**Slice:** S02  **Milestone:** M003

## Goal

Extend the existing PostToolUse branch of `scripts/forge-hook.js` to write one JSON line per Bash/Write/Edit tool call into `.gsd/forge/evidence-{unitId}.jsonl` — sized ≤ 512 bytes each, silent-fail on any error, gated by the `evidence.mode` pref. No new script, no new hook registration (D1).

## Must-Haves

### Truths
- PostToolUse branch writes one JSON line per Bash/Write/Edit call to `.gsd/forge/evidence-{unitId}.jsonl`.
- Each evidence line is ≤ 512 bytes.
- Evidence-block errors are swallowed — a thrown error inside the evidence write does NOT abort the tool call (MEM008).
- `unitId` is resolved from `.gsd/forge/auto-mode.json` `worker` field (format `unit_type/UNIT_ID`). When absent → `adhoc`.
- `evidence.mode` is read from merged prefs (user → repo → local, last wins). `disabled` skips the evidence write. `lenient`/`strict` both write identically in M003.
- Existing Agent-dispatch tracking (lines 186–223 of the current file) is preserved bit-for-bit.
- `node --check scripts/forge-hook.js` passes after edit.

### Artifacts
- `scripts/forge-hook.js` — extended PostToolUse branch. Existing file grows by ≤ 80 lines; min total file length 280 lines after edit (file is currently 227 lines — budget fits).

### Key Links
- `scripts/forge-hook.js` → `.gsd/forge/auto-mode.json` via `fs.readFileSync` + JSON.parse of `worker` field at the top of the PostToolUse evidence branch.
- `scripts/forge-hook.js` → `.gsd/forge/evidence-{unitId}.jsonl` via `fs.appendFileSync(file, JSON.stringify(line) + '\n', 'utf8')`.
- `scripts/forge-hook.js` → `forge-agent-prefs.md` via regex read of the `evidence:` block across the 3 prefs files.

## Steps

1. Read `scripts/forge-hook.js` fully (227 lines). Confirm the PostToolUse path: lines 119–186 handle Bash/Write/Edit guards (PreToolUse only — guarded by `if (phase === 'pre')`); lines 186–223 handle Agent tool dispatch tracking for BOTH pre and post. The evidence write must slot in for PostToolUse BEFORE the `if (toolName !== 'Agent') return` early-return.

2. Add a private helper `resolveUnitId(cwd)` (after `bumpAutoHeartbeat`):
   ```js
   const resolveUnitId = (cwd) => {
     try {
       const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
       const auto = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
       if (auto && typeof auto.worker === 'string' && auto.worker.length > 0) {
         // worker shape: "unit_type/UNIT_ID" — take right half
         const parts = auto.worker.split('/');
         return parts.length === 2 ? parts[1] : 'adhoc';
       }
     } catch { /* no auto-mode / unreadable → adhoc */ }
     return 'adhoc';
   };
   ```

3. Add a private helper `readEvidenceMode(cwd)` (after `resolveUnitId`). Reads the 3 prefs files in cascade order and greps for the `evidence.mode` value. Regex-only — do NOT require a YAML parser (MEM017, no new deps):
   ```js
   const readEvidenceMode = (cwd) => {
     const files = [
       path.join(os.homedir(), '.claude', 'forge-agent-prefs.md'),
       path.join(cwd, '.gsd', 'claude-agent-prefs.md'),
       path.join(cwd, '.gsd', 'prefs.local.md'),
     ];
     let mode = 'lenient'; // default
     for (const f of files) {
       try {
         const raw = fs.readFileSync(f, 'utf8');
         // Look for `evidence:` followed on next non-blank line by `mode: <word>`
         const m = raw.match(/^evidence:[ \t]*\n[ \t]+mode:[ \t]*(\w+)/m);
         if (m) mode = m[1].toLowerCase();
       } catch { /* missing file — skip */ }
     }
     if (mode !== 'lenient' && mode !== 'strict' && mode !== 'disabled') {
       mode = 'lenient';
     }
     return mode;
   };
   ```

4. Add a private helper `truncate(str, max)` (small, inline just above the PostToolUse evidence write):
   ```js
   const truncate = (s, max) => {
     if (typeof s !== 'string') return '';
     return s.length <= max ? s : s.slice(0, max) + '…';
   };
   ```

5. Insert the evidence-write block into the PostToolUse branch. Location: after the PreToolUse guards close (line 183 of the current file) and BEFORE the `if (toolName !== 'Agent') return;` on line 186. It must run ONLY when `phase === 'post'` AND `toolName` is `Bash`, `Write`, or `Edit`. Structure:
   ```js
   // ── PostToolUse: evidence capture (Bash/Write/Edit only) ─────────────────
   if (phase === 'post' && (toolName === 'Bash' || toolName === 'Write' || toolName === 'Edit')) {
     try {
       const cwd = data.cwd || process.cwd();
       const mode = readEvidenceMode(cwd);
       if (mode !== 'disabled') {
         const unitId = resolveUnitId(cwd);
         const evidenceDir = path.join(cwd, '.gsd', 'forge');
         const evidenceFile = path.join(evidenceDir, `evidence-${unitId}.jsonl`);

         // Build evidence line — keep ≤ 512 bytes total
         const toolResponse = data.tool_response || {};
         const line = {
           ts:  Date.now(),
           tool: toolName,
           cmd:  truncate(toolInput.command || '', 200),
           file: toolInput.file_path || null,
           ok:   toolResponse.success !== false && toolResponse.interrupted !== true,
           interrupted: toolResponse.interrupted === true,
         };

         let serialized = JSON.stringify(line);
         // Safety: if still oversize (huge file path), truncate cmd further
         if (Buffer.byteLength(serialized, 'utf8') > 512) {
           line.cmd = truncate(line.cmd, 80);
           line.file = truncate(line.file || '', 200) || null;
           serialized = JSON.stringify(line);
           // Last resort — drop cmd entirely
           if (Buffer.byteLength(serialized, 'utf8') > 512) {
             line.cmd = '[truncated]';
             serialized = JSON.stringify(line);
           }
         }

         fs.mkdirSync(evidenceDir, { recursive: true });
         fs.appendFileSync(evidenceFile, serialized + '\n', 'utf8');
       }
     } catch { /* silent-fail — hook must never crash Claude Code (MEM008) */ }
   }
   ```

6. Verify that the evidence block is strictly additive — the existing `if (toolName !== 'Agent') return;` on (current) line 186 stays put, the Agent dispatch-tracking block stays put. The evidence block runs before that return and does NOT return early itself (evidence capture for Bash/Write/Edit is a side-effect; the outer handler continues).

7. Verify syntax: `node --check scripts/forge-hook.js`.

8. Inline smoke test — run from the repo root:
   ```bash
   # Simulate a PostToolUse event for a Bash call
   echo '{"session_id":"test","cwd":"'$(pwd | sed 's/\\\\/\\//g')'","tool_name":"Bash","tool_input":{"command":"echo hello"},"tool_response":{"stdout":"hello\\n","stderr":"","interrupted":false}}' \
     | node scripts/forge-hook.js post

   # Verify the evidence file
   cat .gsd/forge/evidence-adhoc.jsonl
   # Expected: one JSON line with {ts, tool:"Bash", cmd:"echo hello", file:null, ok:true, interrupted:false}

   # Verify line length
   awk '{ print length }' .gsd/forge/evidence-adhoc.jsonl
   # Expected: each line ≤ 512

   # Cleanup
   rm -f .gsd/forge/evidence-adhoc.jsonl
   ```

9. Failure-mode smoke — confirm silent-fail:
   ```bash
   # Point CWD at a path where .gsd/forge/ cannot be created (read-only dir)
   # Or temporarily chmod the dir; the hook should exit 0 even so.
   echo '{"session_id":"test","cwd":"/nonexistent/xyz","tool_name":"Bash","tool_input":{"command":"x"},"tool_response":{"success":true}}' \
     | node scripts/forge-hook.js post
   echo $?
   # Expected: 0 (no crash)
   ```

10. Perf smoke (≤ 15 ms p50 / ≤ 50 ms p95 target — C4):
    ```bash
    # Run 100 iterations; record wall-clock
    for i in $(seq 1 100); do
      { time echo '{"session_id":"t","cwd":"'$(pwd)'","tool_name":"Bash","tool_input":{"command":"echo x"},"tool_response":{"success":true}}' | node scripts/forge-hook.js post ; } 2>&1 | grep real
    done | awk '{ print $2 }'
    ```
    Record the median + p95 in T01-SUMMARY.md `## What Happened`. If p95 > 50 ms, investigate — likely cold-start of node.exe on Windows (the hook itself should be < 5 ms). Note: the cold-start overhead is an environment fact, not a hook regression.

11. Confirm `evidence.mode: disabled` path:
    ```bash
    # Create a local prefs file with disabled mode
    mkdir -p .gsd
    cat > .gsd/prefs.local.md <<'EOF'
    ---
    version: 1
    ---
    ## Evidence Settings
    ```
    evidence:
      mode: disabled
    ```
    EOF

    # Run the hook — no evidence file should be written
    rm -f .gsd/forge/evidence-adhoc.jsonl
    echo '{"session_id":"t","cwd":"'$(pwd)'","tool_name":"Bash","tool_input":{"command":"echo x"},"tool_response":{"success":true}}' \
      | node scripts/forge-hook.js post
    ls .gsd/forge/evidence-adhoc.jsonl 2>/dev/null && echo "BUG: file was created" || echo "OK: no file"

    # Cleanup
    rm -f .gsd/prefs.local.md
    ```

## Standards

- **Target directory:** `scripts/` (existing file, extend in place per D1).
- **Reuse:** existing `bumpAutoHeartbeat` helper as style reference (try/catch swallow pattern); existing PostToolUse branch structure (phase check, `data` object shape).
- **Naming:** helpers in `camelCase` (`resolveUnitId`, `readEvidenceMode`, `truncate`). Local-only — no export needed (hook is CLI entry, not a module).
- **Pattern:** follows `Hook script lifecycle` from the Pattern Catalog.
- **Lint:** `node --check scripts/forge-hook.js` (only verification configured; see `.gsd/CODING-STANDARDS.md § Lint & Format`).
- **Error handling:** ALL evidence-related code wrapped in try/catch silent-fail. This is the opposite convention from telemetry writes (`forge-verify.js` events.jsonl propagates errors) — hook convention wins here because hook crashes block tool calls (MEM008).
- **No new deps:** Node built-ins only. No `js-yaml`, no `yaml`, no `dotenv`. The `evidence.mode` read is regex-only.
- **Windows paths:** all file paths via `path.join`; no hardcoded `/` or `\`.
- **Byte budget:** evidence line ≤ 512 bytes — enforce by measuring `Buffer.byteLength(serialized, 'utf8')` and progressively truncating `cmd` then `file` then replacing `cmd` with `"[truncated]"`. Never drop `ts` or `tool` (required for cross-ref in T03).

## Context

- **Prior decisions to respect:**
  - D1 — extend the existing hook file; no new script, no new `merge-settings.js` entry.
  - MEM008 — hooks MUST NOT crash Claude Code. Every new code path wrapped in try/catch silent-fail.
  - MEM017 / M002 zero-deps — Node built-ins only.
  - SCOPE C4 — performance budget ≤ 15 ms p50 / ≤ 50 ms p95. Record measurement in T01-SUMMARY.
- **Key files to read first:**
  - `scripts/forge-hook.js` lines 14–33 (imports + `bumpAutoHeartbeat` pattern — matches the style for `resolveUnitId`).
  - `scripts/forge-hook.js` lines 100–117 (PostCompact branch — good example of `try { fs.readFileSync(autoFile) } catch {}` convention).
  - `scripts/forge-hook.js` lines 119–223 (PreToolUse guards + Agent dispatch tracking — the evidence block inserts between line 183 and 186).
  - `forge-agent-prefs.md` § "Evidence Settings" (the pref block T01 consumes, already shipped in S01/T04).
- **auto-mode.json shape** (canonical, from `skills/forge-auto/SKILL.md`): `{active: bool, started_at: number, last_heartbeat: number, worker: "unit_type/UNIT_ID" | null, worker_started: number}`. The `worker` field is `null` between units — hence the `adhoc` fallback.
- **Bash tool_response shape** (from Claude Code hooks docs, verified 2026-04): `{stdout, stderr, interrupted}` — no explicit `exit_code` field. We derive `ok` from `success !== false && interrupted !== true`. Write/Edit `tool_response` is `{filePath, success}`. The executor's self-reported `verification_evidence.exit_code` in T02 fills the gap for actual exit codes (the executor has the conversation record).
- **Not yet implemented (out of scope for T01):** strict-mode blocker behavior. In M003, strict === lenient at the hook layer. The distinction is read by the completer in T03 but the "block" side is deferred to M004+ per SCOPE.
- **Forward intelligence for T03:** the JSONL shape is the contract. Do NOT change `tool`, `cmd`, `file` field names in T01 — T03 greps for exactly these.
