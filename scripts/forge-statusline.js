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
    let autoElapsed = '0s';
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
        const elapsed = auto.started_at
          ? Math.round((Date.now() - auto.started_at) / 1000)
          : 0;

        // Stale check: if auto-mode has been "active" for over 15 minutes
        // with no recent dispatch, assume the session was killed (Ctrl+C, terminal closed).
        // Auto-clean: deactivate the marker so it doesn't persist forever.
        const STALE_THRESHOLD = 15 * 60; // 15 minutes
        if (elapsed > STALE_THRESHOLD) {
          try { fs.writeFileSync(autoFile, '{"active":false}', 'utf8'); } catch {}
        } else {
          autoMode = true;
          autoElapsed = elapsed >= 60
            ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
            : `${elapsed}s`;
        }
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

    // --- Forge version + update check ---
    let forgeVersion = '';
    let forgeUpdate = '';
    try {
      const prefsFile = path.join(os.homedir(), '.claude', 'forge-agent-prefs.md');
      const prefs = fs.readFileSync(prefsFile, 'utf8');
      const repoMatch = prefs.match(/repo_path:\s*(.+)/);
      if (repoMatch) {
        const repo = repoMatch[1].trim();
        const { execSync } = require('child_process');
        forgeVersion = execSync('git describe --tags --always 2>/dev/null', { cwd: repo, encoding: 'utf8', timeout: 2000 }).trim();

        // Check for update (cached, max once per 10 min)
        const cacheFile = path.join(os.tmpdir(), 'forge-update-check.json');
        let shouldCheck = true;
        try {
          const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
          if (Date.now() - cache.ts < 600_000) {
            shouldCheck = false;
            if (cache.latest && cache.latest !== forgeVersion.split('-')[0]) forgeUpdate = cache.latest;
          }
        } catch {}
        if (shouldCheck) {
          try {
            const tags = execSync('git ls-remote --tags origin 2>/dev/null', { cwd: repo, encoding: 'utf8', timeout: 5000 });
            const latest = tags.match(/v\d+\.\d+\.\d+/g)?.sort((a, b) => {
              const pa = a.slice(1).split('.').map(Number), pb = b.slice(1).split('.').map(Number);
              return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
            }).pop() || '';
            const localTag = forgeVersion.split('-')[0];
            if (latest && latest !== localTag) forgeUpdate = latest;
            fs.writeFileSync(cacheFile, JSON.stringify({ ts: Date.now(), latest }), 'utf8');
          } catch {}
        }
      }
    } catch {}

    // --- ANSI colors (used sparingly, only for critical info) ---
    const c = {
      reset:   '\x1b[0m',
      bold:    '\x1b[1m',
      dim:     '\x1b[2m',
      red:     '\x1b[31m',
      green:   '\x1b[32m',
      yellow:  '\x1b[33m',
    };

    // --- Build status line ---
    // --- Build auto-mode prefix ---
    let autoPrefix = '';
    if (autoMode) {
      const dot = Math.floor(Date.now() / 1000) % 2 === 0 ? '●' : '○';
      autoPrefix = `${c.red}${dot} AUTO ${autoElapsed}${c.reset} │ `;
    }

    // Forge label: version normally plain, update highlighted
    let forgeLabel = 'Forge';
    if (forgeVersion) {
      forgeLabel = forgeUpdate
        ? `Forge ${forgeVersion} ${c.bold}${c.yellow}⬆${forgeUpdate}${c.reset}`
        : `Forge ${forgeVersion}`;
    }

    // Context bar: color based on usage threshold
    let barColor = '';
    if (pct >= 85)      barColor = c.red;
    else if (pct >= 70) barColor = c.yellow;
    else if (pct >= 1)  barColor = c.green;
    const ctxStr = barColor ? `${barColor}${bar} ${pct}%${c.reset}` : `${bar} ${pct}%`;

    // Cost: highlight when expensive
    let costDisplay = costStr;
    if (cost >= 5)      costDisplay = `${c.red}${costStr}${c.reset}`;
    else if (cost >= 1) costDisplay = `${c.yellow}${costStr}${c.reset}`;

    const line1 = autoPrefix + [
      forgeLabel,
      model,
      forgeTag ? `${project} │ ${forgeTag}` : project,
      ctxStr,
      costDisplay,
      `↑${fmt(totalIn)} ↓${fmt(totalOut)} 💾${fmt(cacheTotal)}`,
    ].join(' │ ');

    process.stdout.write(line1 + dispatchLine + '\n');
  } catch {
    process.stdout.write('Forge │ ?\n');
  }
});
