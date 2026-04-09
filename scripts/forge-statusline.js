#!/usr/bin/env node
// Forge Status Line — shown in Claude Code prompt during sessions
// Shows: agent label, model, project, forge state, context %, cost, tokens, last dispatch

const fs   = require('fs');
const path = require('path');
const os   = require('os');

process.stdin.setEncoding('utf8');
let raw = '';
process.stdin.on('data', chunk => (raw += chunk));
process.stdin.on('end', () => {
  try {
    const d = JSON.parse(raw);

    // --- Model ---
    const model = d.model?.display_name || d.model?.id || '?';

    // --- Project name from cwd ---
    const cwd     = d.cwd || '';
    const cwdNorm = cwd.replace(/\\/g, '/');
    const project = cwdNorm.split('/').filter(Boolean).pop() || cwd;

    // --- Context window % ---
    const pct    = Math.round(d.context_window?.used_percentage || 0);
    const filled = Math.floor(pct * 10 / 100);
    const bar    = '█'.repeat(filled) + '░'.repeat(10 - filled);

    // --- Cost (session total) ---
    const cost    = d.cost?.total_cost_usd || 0;
    const costStr = '$' + cost.toFixed(4);

    // --- Tokens ---
    const totalIn    = d.context_window?.total_input_tokens  || 0;
    const totalOut   = d.context_window?.total_output_tokens || 0;
    const usage      = d.context_window?.current_usage || {};
    const cacheTotal = (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);

    const fmt = n => {
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
      if (n >= 1000)      return (n / 1000).toFixed(1) + 'k';
      return String(n);
    };

    // --- Forge STATE (reads .gsd/STATE.md) ---
    let forgeTag = '';
    let autoMode = false;
    try {
      const stateFile = path.join(cwd, '.gsd', 'STATE.md');
      const state     = fs.readFileSync(stateFile, 'utf8');

      const mMatch = state.match(/\*\*Active Milestone:\*\*\s*([^\n]+)/i);
      const sMatch = state.match(/\*\*Active Slice:\*\*\s*([^\n]+)/i);

      const m = mMatch?.[1]?.trim();
      const s = sMatch?.[1]?.trim();

      if (m && m.toLowerCase() !== 'none') {
        const mId = m.match(/^(M\d+)/i)?.[1] || m.split(' ')[0];
        const sId = s && s.toLowerCase() !== 'none'
          ? s.match(/^(S\d+)/i)?.[1] || s.split(' ')[0]
          : null;
        forgeTag = sId ? `${mId}/${sId}` : `${mId}`;
      }
    } catch { /* not a forge project */ }

    // --- Auto mode indicator (reads .gsd/forge/auto-mode.json) ---
    try {
      const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
      const auto     = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
      if (auto.active) {
        autoMode = true;
        const elapsed = auto.started_at
          ? Math.round((Date.now() - auto.started_at) / 1000)
          : 0;
        const elStr = elapsed >= 60
          ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
          : `${elapsed}s`;
        forgeTag = forgeTag
          ? `▶ AUTO ${elStr} │ ${forgeTag}`
          : `▶ AUTO ${elStr}`;
      }
    } catch { /* no auto mode active */ }

    // --- Live dispatch info (written by forge-hook.js) ---
    let dispatchLine = '';
    try {
      const sessionId = d.session_id || '';
      const liveFile  = path.join(os.tmpdir(), `forge-live-${sessionId}.json`);
      const live      = JSON.parse(fs.readFileSync(liveFile, 'utf8'));

      const icon  = live.status === 'dispatching' ? '⟳' : '✓';
      const agent = live.subagent_type || 'agent';
      const desc  = live.description?.slice(0, 40) || '';
      const units = live.count ? ` (${live.count} units)` : '';

      let timeStr = '';
      if (live.status === 'done' && live.completed_at) {
        const secs = Math.round((Date.now() - live.completed_at) / 1000);
        if      (secs < 60)   timeStr = ` ${secs}s ago`;
        else if (secs < 3600) timeStr = ` ${Math.round(secs / 60)}m ago`;
      } else if (live.status === 'dispatching' && live.started_at) {
        const secs = Math.round((Date.now() - live.started_at) / 1000);
        timeStr = ` +${secs}s`;
      }

      dispatchLine = `\n${icon} ${agent}: ${desc}${timeStr}${units}`;
    } catch { /* no dispatch info yet */ }

    // --- Build status line ---
    const line1 = [
      'Forge',
      model,
      forgeTag ? `${project} │ ${forgeTag}` : project,
      `${bar} ${pct}%`,
      costStr,
      `↑${fmt(totalIn)} ↓${fmt(totalOut)} 💾${fmt(cacheTotal)}`,
    ].join(' │ ');

    process.stdout.write(line1 + dispatchLine + '\n');
  } catch {
    process.stdout.write('Forge │ ?\n');
  }
});
