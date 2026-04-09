#!/usr/bin/env node
// Forge Hook — fires on PreToolUse / PostToolUse for the Agent tool
//              and on SubagentStart / SubagentStop / PreCompact lifecycle events
// Writes dispatch progress to a temp file that forge-statusline.js reads
//
// Called by Claude Code hooks (configured in ~/.claude/settings.json):
//   PreToolUse      → node ~/.claude/forge-hook.js pre
//   PostToolUse     → node ~/.claude/forge-hook.js post
//   SubagentStart   → node ~/.claude/forge-hook.js subagent-start
//   SubagentStop    → node ~/.claude/forge-hook.js subagent-stop
//   PreCompact      → node ~/.claude/forge-hook.js pre-compact

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const phase = process.argv[2] || 'post'; // 'pre', 'post', 'subagent-start', 'subagent-stop', 'pre-compact'

process.stdin.setEncoding('utf8');
let raw = '';
process.stdin.on('data', chunk => (raw += chunk));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);

    // ── SubagentStart: log start timestamp for timing ───────────────────────
    if (phase === 'subagent-start') {
      const sessionId  = data.session_id || 'unknown';
      const agentType  = data.agent_type  || 'unknown';
      const agentId    = data.agent_id    || '';
      const liveFile   = path.join(os.tmpdir(), `forge-live-${sessionId}.json`);

      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(liveFile, 'utf8')); } catch {}

      // Only update timing — preserve description and count from pre/post
      fs.writeFileSync(liveFile, JSON.stringify({
        ...existing,
        status          : 'dispatching',
        subagent_type   : agentType,
        agent_id        : agentId,
        subagent_started: Date.now(),
      }), 'utf8');
      return;
    }

    // ── SubagentStop: compute real worker duration ───────────────────────────
    if (phase === 'subagent-stop') {
      const sessionId = data.session_id || 'unknown';
      const liveFile  = path.join(os.tmpdir(), `forge-live-${sessionId}.json`);

      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(liveFile, 'utf8')); } catch {}

      const started   = existing.subagent_started || Date.now();
      const durationMs = Date.now() - started;

      fs.writeFileSync(liveFile, JSON.stringify({
        ...existing,
        status           : 'done',
        subagent_duration: durationMs,
        completed_at     : Date.now(),
      }), 'utf8');
      return;
    }

    // ── PreCompact: backup STATE.md before context compression ──────────────
    if (phase === 'pre-compact') {
      const cwd = data.cwd || process.cwd();
      const stateFile  = path.join(cwd, '.gsd', 'STATE.md');
      const backupFile = path.join(cwd, '.gsd', 'STATE.pre-compact.md');
      try {
        if (fs.existsSync(stateFile)) {
          fs.copyFileSync(stateFile, backupFile);
        }
      } catch { /* not a forge project — skip */ }
      return;
    }

    // ── PreToolUse / PostToolUse: track Agent dispatches ────────────────────
    const toolName = data.tool_name || '';

    // Only track Agent tool dispatches
    if (toolName !== 'Agent') return;

    const sessionId    = data.session_id || 'unknown';
    const toolInput    = data.tool_input || {};
    const description  = toolInput.description  || '(sem descrição)';
    const subagentType = toolInput.subagent_type || 'general-purpose';
    const now          = Date.now();

    const liveFile = path.join(os.tmpdir(), `forge-live-${sessionId}.json`);

    // Read existing state to preserve count and start time
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(liveFile, 'utf8')); } catch {}

    let state;
    if (phase === 'pre') {
      state = {
        status       : 'dispatching',
        description,
        subagent_type: subagentType,
        started_at   : now,
        completed_at : null,
        duration_ms  : null,
        count        : existing.count || 0,
      };
    } else {
      const startedAt = existing.started_at || now;
      state = {
        status       : 'done',
        description,
        subagent_type: subagentType,
        started_at   : startedAt,
        completed_at : now,
        duration_ms  : now - startedAt,
        count        : (existing.count || 0) + 1,
      };
    }

    fs.writeFileSync(liveFile, JSON.stringify(state), 'utf8');
  } catch {
    // Never crash — hooks must exit cleanly
  }
});
