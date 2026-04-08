#!/usr/bin/env node
// Forge Hook — fires on PreToolUse / PostToolUse for the Agent tool
// Writes dispatch progress to a temp file that forge-statusline.js reads
//
// Called by Claude Code hooks (configured in ~/.claude/settings.json):
//   PreToolUse  → node ~/.claude/forge-hook.js pre
//   PostToolUse → node ~/.claude/forge-hook.js post

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const phase = process.argv[2] || 'post'; // 'pre' or 'post'

process.stdin.setEncoding('utf8');
let raw = '';
process.stdin.on('data', chunk => (raw += chunk));
process.stdin.on('end', () => {
  try {
    const data      = JSON.parse(raw);
    const toolName  = data.tool_name || '';

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
