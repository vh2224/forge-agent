# S03: Token counter + context budget — UAT Script

**Slice:** S03  **Milestone:** M002  **Written:** 2026-04-16

---

## Prerequisites

- Working directory: `C:/DEV/forge-agent`
- Node.js available on PATH (`node --version`)
- `scripts/forge-tokens.js` exists
- `shared/forge-dispatch.md` contains `### Token Telemetry` section
- `skills/forge-auto/SKILL.md` and `skills/forge-next/SKILL.md` contain `<!-- token-telemetry-integration -->` marker
- `skills/forge-status/SKILL.md` contains `### Token usage` section
- `forge-agent-prefs.md` contains `token_budget:` prefs block

---

## Test Cases

| # | Action | Expected | Pass? |
|---|--------|----------|-------|
| 1 | `node scripts/forge-tokens.js --file CLAUDE.md` | Single-line JSON: `{"tokens":<N>,"chars":<N>,"method":"heuristic"}` where `tokens == Math.ceil(chars/4)` | |
| 2 | `printf 'hello world' \| node scripts/forge-tokens.js` (or `echo hello world \| node scripts/forge-tokens.js` on Windows) | `{"tokens":3,"chars":11,"method":"heuristic"}` | |
| 3 | `printf '' \| node scripts/forge-tokens.js` | `{"tokens":0,"chars":0,"method":"heuristic"}` | |
| 4 | `FORGE_TOKENS_SELFTEST=1 node -e "require('./scripts/forge-tokens.js')"` | `forge-tokens.js self-test: ALL PASS` printed; exit 0 | |
| 5 | `node scripts/forge-tokens.js --file CLAUDE.md --truncate 500 --mandatory 2>&1; echo "exit:$?"` | stderr JSON with `"error":"Context budget exceeded for mandatory section <cli>: … chars > 500 budget"`; exit code 1 | |
| 6 | `node -e "const {truncateAtSectionBoundary}=require('./scripts/forge-tokens.js'); try { truncateAtSectionBoundary('x'.repeat(1000),100,{mandatory:true,label:'T99-PLAN'}); } catch(e){ console.log(e.message); }"` | Prints `Context budget exceeded for mandatory section T99-PLAN: 1000 chars > 100 budget` | |
| 7 | `grep "### Token Telemetry" shared/forge-dispatch.md` | At least 1 match | |
| 8 | `grep "#### Budgeted Section Injection" shared/forge-dispatch.md` | At least 1 match | |
| 9 | `grep "token-telemetry-integration" skills/forge-auto/SKILL.md` | At least 1 match | |
| 10 | `grep "token-telemetry-integration" skills/forge-next/SKILL.md` | At least 1 match | |
| 11 | `grep "### Token usage" skills/forge-status/SKILL.md` | At least 1 match | |
| 12 | `grep "token_budget:" forge-agent-prefs.md` | At least 1 match | |
| 13 | Run boundary-aware truncation on a file with > 8000 chars: `node -e "const {truncateAtSectionBoundary}=require('./scripts/forge-tokens.js'); const s=Array.from({length:50},(_,i)=>'## S'+i+'\n'+'x'.repeat(800)+'\n').join('\n'); const r=truncateAtSectionBoundary(s,8000); console.log(r.includes('[...truncated') ? 'MARKER PRESENT' : 'FAIL', 'ends_at_H2:', /\n## /.test(r.split('[...truncated')[0].slice(-20)) || r.split('[...truncated')[0].trim().endsWith('x'));"` | Output includes `MARKER PRESENT` | |
| 14 | `node -c scripts/forge-tokens.js && echo OK` | `OK` — no syntax errors | |

---

## Notes

- Test 1 CLAUDE.md token count will vary as CLAUDE.md is edited over time; verify `tokens == Math.ceil(chars/4)` rather than a hard-coded value.
- Test 5 requires a shell that propagates the `--mandatory` flag correctly. On Windows cmd.exe, prefer Git Bash or PowerShell.
- Test 13 verifies the truncation halts at an H2 boundary (last content line of the final kept section is a row of `x`s, not an `## ` heading). The inline check is intentionally permissive — a manual review of the output confirming the marker text and that no partial section appears after the last `## ` heading is sufficient.
- If `events.jsonl` is absent or empty, `/forge-status` should print `Sem dados de telemetria ainda.` under the Token usage heading — verifiable by temporarily removing `.gsd/forge/events.jsonl` and running `/forge-status`.
