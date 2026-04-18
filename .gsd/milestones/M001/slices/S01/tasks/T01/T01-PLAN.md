# T01: forge-hook.js — PostCompact handler

**Slice:** S01  **Milestone:** M001

## Goal

Add a `post-compact` handler to `forge-hook.js` that writes `.gsd/forge/compact-signal.json` when forge-auto is active.

## Must-Haves

### Truths
- Running `echo '{"cwd":"/tmp/test"}' | node scripts/forge-hook.js post-compact` with an `auto-mode.json` containing `{"active":true,"milestone":"M001","worker":"execute-task/T01"}` at `/tmp/test/.gsd/forge/auto-mode.json` produces a `compact-signal.json` at `/tmp/test/.gsd/forge/compact-signal.json` with keys `recovered_at`, `milestone`, `worker`
- Running the same command when `auto-mode.json` has `{"active":false}` does NOT create `compact-signal.json`
- Running when `auto-mode.json` does not exist does NOT create `compact-signal.json`
- I/O errors (missing `.gsd/forge/` directory, permission denied) are silently caught — the hook exits cleanly with code 0

### Artifacts
- `scripts/forge-hook.js` — modified (adds ~15 lines: comment header update + post-compact handler block)
  - New phase value `post-compact` in the comment header and phase variable documentation
  - New `if (phase === 'post-compact')` block after the existing `pre-compact` block

### Key Links
- `scripts/forge-hook.js` reads `.gsd/forge/auto-mode.json` (same file the orchestrator writes in `commands/forge-auto.md`)
- `scripts/forge-hook.js` writes `.gsd/forge/compact-signal.json` (consumed by T03's detection logic in `forge-auto.md`)

## Steps

1. Read `scripts/forge-hook.js` to confirm current structure (already read during planning — verify no changes since)
2. Update the comment header at line 5 to add `PostCompact` to the event list:
   ```
   //   PostCompact     → node ~/.claude/forge-hook.js post-compact
   ```
3. Update the `phase` variable comment at line 17 to include `'post-compact'` in the list of valid values
4. Add the `post-compact` handler block AFTER the `pre-compact` block (after line 78) and BEFORE the `PreToolUse / PostToolUse` section (line 80):
   ```javascript
   // ── PostCompact: write recovery signal if forge-auto was active ────────────
   if (phase === 'post-compact') {
     const cwd      = data.cwd || process.cwd();
     const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
     let autoMode   = {};
     try { autoMode = JSON.parse(fs.readFileSync(autoFile, 'utf8')); } catch {}

     if (autoMode.active === true) {
       const signalFile = path.join(cwd, '.gsd', 'forge', 'compact-signal.json');
       fs.writeFileSync(signalFile, JSON.stringify({
         recovered_at : Date.now(),
         milestone    : autoMode.milestone || null,
         worker       : autoMode.worker    || null,
       }), 'utf8');
     }
     return;
   }
   ```
5. Verify the file parses correctly: `node -c scripts/forge-hook.js`

## Standards
- **Target directory:** `scripts/` (existing file modification)
- **Reuse:** Follow exact pattern of the `pre-compact` handler above it (read cwd from data, try/catch fs operations)
- **Naming:** Phase value `post-compact` matches Claude Code lifecycle event naming convention (kebab-case)
- **Lint command:** `node -c scripts/forge-hook.js` (syntax check)
- **Pattern:** follows existing handler pattern in forge-hook.js (read stdin JSON, branch on phase, try/catch I/O, early return)

## Context
- Decision: PostCompact (not PreCompact) writes the signal because state is lost during compaction; PostCompact runs after with disk state intact
- The `data.cwd` field is provided by Claude Code in the hook's stdin JSON payload — same as PreCompact
- `auto-mode.json` structure: `{"active":true,"started_at":N,"worker":"unit_type/unit_id","milestone":"M###"}`
- The handler must be placed AFTER pre-compact and BEFORE the PreToolUse/PostToolUse section to maintain logical grouping of lifecycle handlers vs tool-use handlers
