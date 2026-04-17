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
    let forgeMilestone = '';   // e.g. "M002"
    let forgeProgress  = '';   // e.g. "2/4" (done slices / total) — empty if can't parse ROADMAP
    let autoMode = false;
    let autoElapsed = '0s';
    try {
      const stateFile = path.join(cwd, '.gsd', 'STATE.md');
      const state     = fs.readFileSync(stateFile, 'utf8');

      // New STATE format uses "## Active Milestone" heading. Fall back to legacy bold form.
      let milestoneText = '';
      const headMatch = state.match(/^## Active Milestone\s*\n([^\n]+)/mi);
      if (headMatch) milestoneText = headMatch[1].trim();
      else {
        const legacy = state.match(/\*\*Active Milestone:\*\*\s*([^\n]+)/i);
        if (legacy) milestoneText = legacy[1].trim();
      }

      const mId = milestoneText && !/^—|^\(none\)/i.test(milestoneText)
        ? (milestoneText.match(/^(M\d+)/i)?.[1] || '')
        : '';

      if (mId) {
        forgeMilestone = mId;
        // Parse ROADMAP to count done slices
        try {
          const roadmap = fs.readFileSync(
            path.join(cwd, '.gsd', 'milestones', mId, `${mId}-ROADMAP.md`),
            'utf8'
          );
          const sliceRe = /^- \[( |x)\]\s+\*\*S\d+/gm;
          let done = 0, total = 0, m2;
          while ((m2 = sliceRe.exec(roadmap)) !== null) {
            total++;
            if (m2[1] === 'x') done++;
          }
          if (total > 0) forgeProgress = `${done}/${total}`;
        } catch { /* ROADMAP missing — just show milestone id */ }
      }
    } catch { /* not a forge project */ }

    // --- Auto mode indicator (reads .gsd/forge/auto-mode.json) ---
    let autoElapsedSecs = 0; // kept for dot sync below
    let autoWorker      = '';  // active worker unit (from heartbeat)
    let autoWorkerSecs  = 0;   // how long the current worker has been running
    try {
      const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
      const auto     = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
      if (auto.active) {
        const elapsed = auto.started_at
          ? Math.round((Date.now() - auto.started_at) / 1000)
          : 0;

        // Stale check — only HIDE the indicator; never mutate the file.
        // The orchestrator and forge-hook (SubagentStart/Stop) own the marker;
        // if the statusline wrote {"active":false} on a transient gap it would
        // destroy recovery state and the indicator would never come back.
        // A session is considered alive if EITHER a heartbeat or an active
        // worker was touched within the threshold. Threshold is generous
        // because Opus workers with extended thinking + web search can take
        // 10+ minutes between SubagentStart/Stop hook fires.
        const STALE_THRESHOLD_SECS = 15 * 60;
        const lastHeartbeat = auto.last_heartbeat || auto.started_at || 0;
        const workerStart   = auto.worker_started || 0;
        const lastActivity  = Math.max(lastHeartbeat, workerStart);
        const sinceLastActivity = Math.round((Date.now() - lastActivity) / 1000);
        const isStale = sinceLastActivity > STALE_THRESHOLD_SECS;

        if (!isStale) {
          autoMode        = true;
          autoElapsedSecs = elapsed;
          autoElapsed     = elapsed >= 60
            ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s`
            : `${elapsed}s`;

          // Heartbeat: show which worker is running and for how long
          if (auto.worker && auto.worker_started) {
            autoWorker     = auto.worker;
            autoWorkerSecs = Math.round((Date.now() - auto.worker_started) / 1000);
          }
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
    // All git operations are cached (max once per 10 min) so no git process
    // runs on every render — eliminates the flickering caused by variable latency.
    let forgeVersion = '';
    let forgeUpdate = '';
    try {
      const prefsFile = path.join(os.homedir(), '.claude', 'forge-agent-prefs.md');
      const prefs = fs.readFileSync(prefsFile, 'utf8');
      const repoMatch = prefs.match(/repo_path:\s*(.+)/);
      if (repoMatch) {
        const repo = repoMatch[1].trim();
        const cacheFile = path.join(os.tmpdir(), 'forge-update-check.json');

        let cache = null;
        try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}

        const CACHE_TTL = 600_000; // 10 minutes
        const cacheValid = cache && (Date.now() - (cache.ts || 0) < CACHE_TTL);

        if (cacheValid) {
          // Fast path: serve from cache — zero git processes, no flicker
          forgeVersion = cache.version || '';
          if (cache.has_update) {
            forgeUpdate = cache.remote_version ? `↑ ${cache.remote_version}` : '↑ novos commits';
          }
        } else {
          // Slow path: refresh cache (runs at most once per 10 min)
          try {
            const { execSync } = require('child_process');
            const rawVersion = execSync(
              'git describe --tags --always 2>/dev/null || git log --oneline -1 2>/dev/null',
              { cwd: repo, encoding: 'utf8', timeout: 2000, shell: true }
            ).trim();
            // Reformat git describe output: v0.19.0-3-gabcdef → v0.19.0.3
            const version = rawVersion.replace(/^(v[\d.]+)-(\d+)-g[0-9a-f]+$/, '$1.$2');
            const localCommit = execSync(
              'git rev-parse HEAD 2>/dev/null',
              { cwd: repo, encoding: 'utf8', timeout: 2000, shell: true }
            ).trim();

            forgeVersion = version;

            // Update check: compare local HEAD vs remote HEAD, then find latest tag
            // Two separate calls avoids shell quoting issues on Windows (cmd.exe)
            let hasUpdate = false;
            let remoteVersion = '';
            try {
              const headOut = execSync(
                'git ls-remote origin HEAD 2>/dev/null',
                { cwd: repo, encoding: 'utf8', timeout: 5000, shell: true }
              );
              const remoteCommit = headOut.trim().split(/\s/)[0];
              hasUpdate = !!remoteCommit && remoteCommit !== localCommit;
            } catch {}

            if (hasUpdate) {
              try {
                // git ls-remote --tags needs no shell quoting — safe on Windows + Linux
                const tagsOut = execSync(
                  'git ls-remote --tags origin 2>/dev/null',
                  { cwd: repo, encoding: 'utf8', timeout: 5000, shell: true }
                );
                const tags = tagsOut.split('\n')
                  .filter(l => /refs\/tags\/v[\d.]+$/.test(l))
                  .map(l => l.split(/\s+/)[1].replace('refs/tags/', ''))
                  .sort((a, b) => {
                    const av = a.replace('v', '').split('.').map(Number);
                    const bv = b.replace('v', '').split('.').map(Number);
                    for (let i = 0; i < Math.max(av.length, bv.length); i++) {
                      if ((av[i] || 0) !== (bv[i] || 0)) return (bv[i] || 0) - (av[i] || 0);
                    }
                    return 0;
                  });
                remoteVersion = tags[0] || '';
              } catch {}
            }

            if (hasUpdate) forgeUpdate = remoteVersion ? `↑ ${remoteVersion}` : '↑ novos commits';

            fs.writeFileSync(cacheFile, JSON.stringify({
              ts: Date.now(),
              version,
              localCommit,
              has_update: hasUpdate,
              remote_version: remoteVersion,
            }), 'utf8');
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
    // --- Tier icon map (mirrors shared/forge-tiers.md unit_type defaults) ---
    const TIER_ICON = {
      'memory-extract':    '🪶',
      'complete-slice':    '🪶',
      'complete-milestone':'🪶',
      'execute-task':      '⚡',
      'plan-milestone':    '🔥',
      'plan-slice':        '🔥',
      'discuss-milestone': '🔥',
      'discuss-slice':     '🔥',
      'research-milestone':'🔥',
      'research-slice':    '🔥',
    };
    const tierIconFor = (unit_type) => TIER_ICON[unit_type] || '•';

    // --- Read tail of events.jsonl (cheap — stays under ~50KB typically) ---
    const readTailEvents = () => {
      try {
        const f = path.join(cwd, '.gsd', 'forge', 'events.jsonl');
        const content = fs.readFileSync(f, 'utf8').trimEnd();
        if (!content) return [];
        const lines = content.split('\n').slice(-20);
        return lines
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
      } catch { return []; }
    };

    // Find an active retry (most recent "event:retry" in last 90s, newer than any done)
    const findActiveRetry = (events) => {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        const ts = e.ts ? new Date(e.ts).getTime() : 0;
        if (e.event === 'retry' && Date.now() - ts < 90_000) return e;
        if (e.status === 'done' || e.status === 'blocked') return null;
      }
      return null;
    };

    // Find last terminal outcome (done/blocked/partial) for idle display
    const findLastOutcome = (events) => {
      for (let i = events.length - 1; i >= 0; i--) {
        const e = events[i];
        if (e.status === 'done' || e.status === 'blocked' || e.status === 'partial') return e;
      }
      return null;
    };

    const fmtSecsShort = (s) => s >= 60 ? `${Math.floor(s/60)}m${s%60 ? s%60+'s' : ''}` : `${s}s`;

    // --- Check for pause request ---
    const pauseFile = path.join(cwd, '.gsd', 'forge', 'pause');
    const pausePending = (() => { try { return fs.existsSync(pauseFile); } catch { return false; } })();

    // --- Build auto-mode prefix (dot + AUTO + elapsed) — worker moves to middle segment now ---
    let autoPrefix = '';
    if (pausePending) {
      autoPrefix = `${c.yellow}⏸ PAUSE SOLICITADO${c.reset} │ `;
    } else if (autoMode) {
      const dot = autoElapsedSecs % 2 === 0 ? '●' : '○';
      autoPrefix = `${c.red}${dot} AUTO ${autoElapsed}${c.reset} │ `;
    }

    // --- Middle segment: milestone progress + worker/retry/outcome ---
    let middleSegment = project;
    if (forgeMilestone) {
      const mLabel = forgeProgress
        ? `${c.bold}${forgeMilestone}${c.reset} ${forgeProgress}`
        : forgeMilestone;

      let rightPart = '';
      if (autoMode && autoWorker) {
        const [ut, uid] = autoWorker.split('/');
        const icon = tierIconFor(ut);
        const wt = fmtSecsShort(autoWorkerSecs);
        const events = readTailEvents();
        const retry = findActiveRetry(events);
        if (retry) {
          const cls = retry.class || 'transient';
          const attempt = retry.attempt || '?';
          rightPart = ` · ${c.yellow}↻${c.reset} ${icon}${uid || ut} retry ${attempt}/3 (${cls})`;
        } else {
          rightPart = ` · ${c.green}${icon}${uid || ut} +${wt}${c.reset}`;
        }
      } else {
        // No active worker — show last outcome if recent (< 10 min)
        const events = readTailEvents();
        const last = findLastOutcome(events);
        if (last && last.ts) {
          const ago = Math.round((Date.now() - new Date(last.ts).getTime()) / 1000);
          if (ago < 600) {
            const uid = last.unit?.split('/')?.[1] || last.unit || '';
            const statusIcon =
              last.status === 'done'    ? `${c.green}✓${c.reset}` :
              last.status === 'partial' ? `${c.yellow}○${c.reset}` :
                                          `${c.red}✗${c.reset}`;
            rightPart = ` · ${statusIcon} ${uid} há ${fmtSecsShort(ago)}`;
          }
        }
      }

      middleSegment = `${project} │ ${mLabel}${rightPart}`;
    }

    // --- Context bar: color based on usage threshold ---
    let barColor = '';
    if (pct >= 85)      barColor = c.red;
    else if (pct >= 70) barColor = c.yellow;
    else if (pct >= 1)  barColor = c.green;
    const ctxStr = barColor ? `${barColor}${bar} ${pct}%${c.reset}` : `${bar} ${pct}%`;

    // --- Cost: highlight when expensive ---
    let costDisplay = costStr;
    if (cost >= 5)      costDisplay = `${c.red}${costStr}${c.reset}`;
    else if (cost >= 1) costDisplay = `${c.yellow}${costStr}${c.reset}`;

    // --- Forge version tail: only shown when update available (otherwise noise) ---
    let forgeVersionTail = '';
    if (forgeUpdate) {
      forgeVersionTail = ` │ ${c.bold}${c.yellow}Forge ${forgeUpdate}${c.reset}`;
    }

    // --- Model segment: only when NOT auto (tier icon covers "what's running" in auto mode) ---
    const segments = [];
    if (!autoMode) segments.push(model);
    segments.push(middleSegment, ctxStr, costDisplay);

    const line1 = autoPrefix + segments.join(' │ ') + forgeVersionTail;

    // --- Line 2 (dispatchLine): only useful when NOT in auto mode (auto shows worker in line 1) ---
    const line2 = autoMode ? '' : dispatchLine;

    process.stdout.write(line1 + line2 + '\n');
  } catch {
    process.stdout.write('Forge │ ?\n');
  }
});
