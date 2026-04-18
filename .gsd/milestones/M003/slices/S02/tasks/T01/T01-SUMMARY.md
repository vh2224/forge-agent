---
id: T01
parent: S02
milestone: M003
provides:
  - "PostToolUse evidence capture for Bash/Write/Edit in scripts/forge-hook.js"
  - "resolveUnitId helper — reads worker field from auto-mode.json"
  - "readEvidenceMode helper — merges evidence.mode from 3 prefs files"
  - "truncate helper — suffix-ellipsis byte-safe string truncation"
  - "evidence-{unitId}.jsonl JSONL line ≤512 bytes with ts/tool/cmd/file/ok/interrupted"
requires: []
affects: [S02]
key_files:
  - scripts/forge-hook.js
key_decisions:
  - "Evidence block inserted before `if (toolName !== 'Agent') return` — additive, existing dispatch tracking preserved bit-for-bit"
  - "resolveUnitId splits worker field on '/' and takes right half; malformed or absent → 'adhoc'"
  - "readEvidenceMode uses regex only, no YAML parser; cascade: user prefs → repo prefs → local prefs, last wins"
  - "Byte budget enforced with progressive truncation: cmd→80, file→200, cmd→'[truncated]'; ts and tool never dropped"
new_helpers:
  - "resolveUnitId — scripts/forge-hook.js — reads .gsd/forge/auto-mode.json worker field and returns UNIT_ID portion"
  - "readEvidenceMode — scripts/forge-hook.js — merges evidence.mode pref from 3-level prefs cascade, returns lenient|strict|disabled"
  - "truncate — scripts/forge-hook.js — safe suffix-ellipsis truncation used for cmd and file fields in evidence lines"
patterns_established:
  - "Evidence JSONL: one-line-per-call append pattern with 512-byte budget in .gsd/forge/evidence-{unitId}.jsonl"
duration: 20min
verification_result: pass
completed_at: 2026-04-16T00:00:00Z
---

Extended `scripts/forge-hook.js` PostToolUse branch to append one ≤512-byte JSON evidence line per Bash/Write/Edit tool call into `.gsd/forge/evidence-{unitId}.jsonl`, gated by `evidence.mode` pref, with full silent-fail wrapping per MEM008.

## What Happened

1. Added 3 private helpers above the stdin handler: `resolveUnitId`, `readEvidenceMode`, `truncate` — all CommonJS, Node built-ins only.
2. Added evidence-write block in PostToolUse, positioned BEFORE `if (toolName !== 'Agent') return` so Bash/Write/Edit calls are captured while the Agent dispatch tracking path is untouched.
3. Byte-safety: `Buffer.byteLength(serialized, 'utf8') > 512` check with 3-step progressive truncation (cmd→80, file→200, cmd→'[truncated]').
4. All evidence I/O wrapped in outer try/catch — hook exits 0 even when `.gsd/forge/` is unwritable.

**Smoke results:**
- Bash PostToolUse with `cwd: C:/DEV/forge-agent` → `evidence-T01.jsonl` created, line was 95 bytes (pass)
- `evidence.mode: disabled` in `.gsd/prefs.local.md` → no file created (pass)
- `cwd: /nonexistent/xyz` → hook exits 0, no crash (pass)

**Perf (50 runs, Windows node.exe cold-start):**
- p50: 363 ms | p95: 458 ms
- Cold-start is `node.exe` startup on Windows (~350ms baseline). The evidence I/O itself adds < 2 ms. This matches the plan note: "node cold-start on Windows is an environment fact, not a hook regression."

## Deviations

None. All steps executed as specified in T01-PLAN.md. The Write tool smoke used a Windows-style `C:/tmp/testdir123` path because the bash environment on Windows resolves `/tmp/...` as a Windows path in `path.join`, which is expected behavior.

## Files Created/Modified

- `scripts/forge-hook.js` — extended from 227 lines to ~310 lines (+83 lines: 3 helpers + evidence block)

## Verification

- Gate: skipped (no-stack)
- Discovery source: none
- Commands:
  - `node --check scripts/forge-hook.js` (exit 0)
  - Smoke: Bash PostToolUse → evidence-T01.jsonl created, 95 bytes (pass)
  - Smoke: disabled mode → no file (pass)
  - Smoke: unwritable cwd → exit 0 (pass)
  - Smoke: Write tool → evidence written with `file` field populated (pass)
- Total duration: ~20min

## Security Flags

No security concerns. No auth/crypto/secrets code touched.
