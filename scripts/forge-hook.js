#!/usr/bin/env node
// Forge Hook — fires on PreToolUse / PostToolUse (Agent + Write matchers)
//              and on SubagentStart / SubagentStop / PreCompact / PostCompact lifecycle events
// Writes dispatch progress to a temp file that forge-statusline.js reads.
// Session-aware after M004: resolves run via data.session_id → .gsd/forge/runs/*.json
//
// Called by Claude Code hooks (configured in ~/.claude/settings.json):
//   PreToolUse      → node ~/.claude/forge-hook.js pre
//   PostToolUse     → node ~/.claude/forge-hook.js post
//   SubagentStart   → node ~/.claude/forge-hook.js subagent-start
//   SubagentStop    → node ~/.claude/forge-hook.js subagent-stop
//   PreCompact      → node ~/.claude/forge-hook.js pre-compact
//   PostCompact     → node ~/.claude/forge-hook.js post-compact

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const phase = process.argv[2] || 'post'; // 'pre', 'post', 'subagent-start', 'subagent-stop', 'pre-compact', 'post-compact'

// ── Resolve scripts dir — works both in dev (sibling) and installed (~/.claude/scripts/) ──
// Installed: this file lives at ~/.claude/forge-hook.js, scripts at ~/.claude/scripts/
// Dev: this file lives at scripts/forge-hook.js, runs.js at scripts/forge-runs.js (sibling)
let runs = null;
let filelock = null;
try {
  runs     = require(path.join(__dirname, 'scripts', 'forge-runs.js'));
  filelock = require(path.join(__dirname, 'scripts', 'forge-filelock.js'));
} catch {
  try {
    runs     = require(path.join(__dirname, 'forge-runs.js'));
    filelock = require(path.join(__dirname, 'forge-filelock.js'));
  } catch { runs = null; filelock = null; }
}

// Sanitize run_id for safe filesystem use (evidence-{runId}-{unitId}.jsonl)
function sanitizeRunId(id) {
  return String(id || 'adhoc').replace(/[^\w.\-]/g, '_');
}

// Bump last_heartbeat on the run owning this session.
// Multi-run path (M004): resolves run by session_id, updates runs/{id}.json via forge-runs.js
// (which auto-refreshes the legacy auto-mode.json alias).
// Legacy fallback: writes directly to auto-mode.json (pre-M004 workspaces without runs/).
const bumpHeartbeat = (cwd, sessionId) => {
  if (runs && sessionId) {
    try {
      const r = runs.resolveBySessionId(cwd, sessionId);
      if (r) {
        runs.bumpHeartbeat(cwd, r.id);
        return;
      }
    } catch { /* fall through */ }
  }
  // Legacy: pre-M004 single-run, no runs/ directory or no session match
  try {
    const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
    const auto = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
    if (auto && auto.active === true) {
      auto.last_heartbeat = Date.now();
      fs.writeFileSync(autoFile, JSON.stringify(auto), 'utf8');
    }
  } catch { /* no auto mode or unreadable — ignore */ }
};

// Resolve unit context for evidence file naming.
// Multi-run path: { runId, unitId, kind } from run.worker via session_id resolution.
// Legacy fallback: { runId: null, unitId, kind: null } from auto-mode.json worker.
const resolveUnitContext = (cwd, sessionId) => {
  if (runs && sessionId) {
    try {
      const r = runs.resolveBySessionId(cwd, sessionId);
      if (r) {
        const unit = (r.worker || '').split('/')[1] || 'adhoc';
        return { runId: r.id, unitId: unit, kind: r.kind };
      }
    } catch { /* fall through */ }
  }
  try {
    const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
    const auto = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
    if (auto && typeof auto.worker === 'string' && auto.worker.length > 0) {
      const parts = auto.worker.split('/');
      return { runId: null, unitId: parts.length === 2 ? parts[1] : 'adhoc', kind: null };
    }
  } catch { /* no auto-mode / unreadable → adhoc */ }
  return { runId: null, unitId: 'adhoc', kind: null };
};

// Read forge_isolation.file_locks pref (default true). Returns boolean.
// Skipped check when forge_isolation.mode is worktree (separate FS — no locks needed).
const readFileLocksEnabled = (cwd) => {
  const files = [
    path.join(os.homedir(), '.claude', 'forge-agent-prefs.md'),
    path.join(cwd, '.gsd', 'claude-agent-prefs.md'),
    path.join(cwd, '.gsd', 'prefs.local.md'),
  ];
  let enabled = true;
  let mode = 'shared';
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const block = raw.match(/^forge_isolation:[ \t]*\n([\s\S]*?)(?=^\w|\Z)/m);
      if (block) {
        const modeM = block[1].match(/^[ \t]+mode:[ \t]*(\w+)/m);
        if (modeM) mode = modeM[1].toLowerCase();
        const fileM = block[1].match(/^[ \t]+file_locks:[ \t]*(\w+)/m);
        if (fileM) enabled = fileM[1].toLowerCase() === 'true';
      }
    } catch { /* missing file — skip */ }
  }
  if (mode === 'worktree') return false;
  return enabled;
};

// Read evidence.mode from merged prefs (user → repo → local, last wins).
// Valid values: lenient | strict | disabled. Defaults to lenient.
// Regex-only — no YAML parser required (MEM017 / zero-new-deps rule).
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
      const m = raw.match(/^evidence:[ \t]*\n[ \t]+mode:[ \t]*(\w+)/m);
      if (m) mode = m[1].toLowerCase();
    } catch { /* missing file — skip */ }
  }
  if (mode !== 'lenient' && mode !== 'strict' && mode !== 'disabled') {
    mode = 'lenient';
  }
  return mode;
};

const truncate = (s, max) => {
  if (typeof s !== 'string') return '';
  return s.length <= max ? s : s.slice(0, max) + '…';
};

process.stdin.setEncoding('utf8');
let raw = '';
process.stdin.on('data', chunk => (raw += chunk));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);
    const sessionId = data.session_id || '';
    const cwd       = data.cwd || process.cwd();

    // ── SubagentStart: log start timestamp for timing ───────────────────────
    if (phase === 'subagent-start') {
      const agentType  = data.agent_type  || 'unknown';
      const agentId    = data.agent_id    || '';
      const liveFile   = path.join(os.tmpdir(), `forge-live-${sessionId || 'unknown'}.json`);

      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(liveFile, 'utf8')); } catch {}

      fs.writeFileSync(liveFile, JSON.stringify({
        ...existing,
        status          : 'dispatching',
        subagent_type   : agentType,
        agent_id        : agentId,
        subagent_started: Date.now(),
      }), 'utf8');

      bumpHeartbeat(cwd, sessionId);
      return;
    }

    // ── SubagentStop: compute real worker duration ───────────────────────────
    if (phase === 'subagent-stop') {
      const liveFile  = path.join(os.tmpdir(), `forge-live-${sessionId || 'unknown'}.json`);

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

      bumpHeartbeat(cwd, sessionId);
      return;
    }

    // ── PreCompact: backup STATE.md before context compression ──────────────
    if (phase === 'pre-compact') {
      const stateFile  = path.join(cwd, '.gsd', 'STATE.md');
      const backupFile = path.join(cwd, '.gsd', 'STATE.pre-compact.md');
      try {
        if (fs.existsSync(stateFile)) {
          fs.copyFileSync(stateFile, backupFile);
        }
      } catch { /* not a forge project — skip */ }
      return;
    }

    // ── PostCompact: write recovery signal if forge-auto was active ────────────
    // M004: scoped per-session — compact-signal-{sessionId}.json
    // Legacy fallback: also writes unscoped compact-signal.json (helps pre-M004 boot)
    if (phase === 'post-compact') {
      let recoverySignal = false;
      let runId = null;
      let worker = null;

      if (runs && sessionId) {
        try {
          const r = runs.resolveBySessionId(cwd, sessionId);
          if (r && r.active === true) {
            recoverySignal = true;
            runId = r.id;
            worker = r.worker;
          }
        } catch { /* fall through */ }
      }

      if (!recoverySignal) {
        try {
          const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
          const autoMode = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
          if (autoMode && autoMode.active === true) {
            recoverySignal = true;
            worker = autoMode.worker || null;
          }
        } catch {}
      }

      if (recoverySignal) {
        const payload = JSON.stringify({
          recovered_at: Date.now(),
          milestone: runId,
          worker,
          session_id: sessionId || null,
        });
        const dir = path.join(cwd, '.gsd', 'forge');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        if (sessionId) {
          try { fs.writeFileSync(path.join(dir, `compact-signal-${sanitizeRunId(sessionId)}.json`), payload, 'utf8'); } catch {}
        }
        try { fs.writeFileSync(path.join(dir, 'compact-signal.json'), payload, 'utf8'); } catch {}
      }
      return;
    }

    // ── PreToolUse / PostToolUse: track Agent dispatches ────────────────────
    const toolName  = data.tool_name  || '';
    const toolInput = data.tool_input || {};

    // ── Safety guards (PreToolUse only) ─────────────────────────────────────
    if (phase === 'pre') {
      let blockMessage = null;

      // ── Bash guards ────────────────────────────────────────────────────────
      if (toolName === 'Bash') {
        const cmd = toolInput.command || '';

        if (/git\s+commit\b/.test(cmd) && /--no-verify\b/.test(cmd)) {
          blockMessage = '[forge-hook] Bloqueado: git commit --no-verify contorna hooks de pre-commit. Corrija a falha do hook.';
        }

        if (!blockMessage && /git\s+push\b/.test(cmd)) {
          const cmdWithoutSafe = cmd.replace(/--force-with-lease\S*/g, '');
          if (/--force\b/.test(cmdWithoutSafe) || /(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*(?:\s|$)/.test(cmdWithoutSafe)) {
            blockMessage = '[forge-hook] Bloqueado: git push --force pode sobrescrever commits remotos. Use --force-with-lease se necessário.';
          }
        }

        if (!blockMessage && /\brm\b/.test(cmd) && /\.gsd/.test(cmd)) {
          const flagsMatch = cmd.match(/\B-([a-zA-Z]+)/g) || [];
          const allFlags   = flagsMatch.join('');
          if (allFlags.includes('r') && allFlags.includes('f')) {
            blockMessage = '[forge-hook] Bloqueado: remoção destrutiva de .gsd/ protege o estado do Forge.';
          }
        }
      }

      // ── Write guard — protect append-only files (DECISIONS.md, LEDGER.md) ─
      if (!blockMessage && toolName === 'Write') {
        const filePath = toolInput.file_path || '';
        const isAppendOnly = /[/\\]\.gsd[/\\](DECISIONS|LEDGER)\.md$/.test(filePath);
        if (isAppendOnly) {
          try {
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
              const name = path.basename(filePath);
              blockMessage = `[forge-hook] Bloqueado: Write em ${name} (append-only). Use Edit: Read o arquivo completo primeiro (sem limit, paginando se grande), depois Edit com old_string = última linha existente (exata) e new_string = essa linha + newline + nova(s) linha(s). Ou Bash: cat >> ${filePath.replace(/.*\.gsd/, '.gsd')} << 'EOF' (nunca >).`;
            }
          } catch { /* can't stat — allow */ }
        }
      }

      // ── Write / Edit guards — block hardcoded secrets ────────────────────
      if (!blockMessage && (toolName === 'Write' || toolName === 'Edit')) {
        const filePath  = toolInput.file_path || '';
        const content   = toolName === 'Write' ? (toolInput.content || '') : (toolInput.new_string || '');

        const isSafeEnvFile = /\.env\.(example|sample)$/i.test(filePath);

        if (!isSafeEnvFile) {
          const secretPattern = /(API_KEY|SECRET_KEY|PRIVATE_KEY|PASSWORD)\s*=\s*["'][^${\s]{8,}/;
          const lines = content.split('\n');
          const hasBareSecret = lines.some(line => {
            const trimmed = line.trimStart();
            if (trimmed.startsWith('#') || trimmed.startsWith('//')) return false;
            return secretPattern.test(line);
          });
          if (hasBareSecret) {
            blockMessage = '[forge-hook] Bloqueado: possível secret hardcoded detectado. Use variável de ambiente.';
          }
        }
      }

      // ── File-lock cross-run check (M004+, shared/branch modes only) ────────
      if (!blockMessage && (toolName === 'Write' || toolName === 'Edit') && filelock && runs && sessionId) {
        const filePath = toolInput.file_path || '';
        if (filePath && readFileLocksEnabled(cwd)) {
          try {
            const r = runs.resolveBySessionId(cwd, sessionId);
            if (r && r.active) {
              // Compute relative path for the lock key
              const rel = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
              const result = filelock.acquireFileLock(cwd, rel, r.id, sessionId, { intent: toolName.toLowerCase() });
              if (!result.acquired) {
                const h = result.holder;
                const ageS = Math.round((h.age_ms || 0) / 1000);
                blockMessage = `[forge-hook] Bloqueado: arquivo "${rel}" em uso por run ${h.run_id} há ${ageS}s. Aguarde ou execute /forge-pause ${h.run_id}.`;
              }
            }
          } catch { /* silent — filelock is defensive, never crash hook */ }
        }
      }

      if (blockMessage) {
        process.stdout.write(blockMessage + '\n');
        process.exit(2);
      }
    }

    // ── PostToolUse: evidence capture (Bash/Write/Edit only) ─────────────────
    // M004: file is evidence-{runId}-{unitId}.jsonl when session resolves to a run.
    // Legacy: evidence-{unitId}.jsonl when no run resolution possible.
    if (phase === 'post' && (toolName === 'Bash' || toolName === 'Write' || toolName === 'Edit')) {
      try {
        const mode = readEvidenceMode(cwd);
        if (mode !== 'disabled') {
          const ctx = resolveUnitContext(cwd, sessionId);
          const evidenceDir  = path.join(cwd, '.gsd', 'forge');
          const fileSlug = ctx.runId
            ? `evidence-${sanitizeRunId(ctx.runId)}-${ctx.unitId}.jsonl`
            : `evidence-${ctx.unitId}.jsonl`;
          const evidenceFile = path.join(evidenceDir, fileSlug);

          const toolResponse = data.tool_response || {};
          const line = {
            ts          : Date.now(),
            tool        : toolName,
            cmd         : truncate(toolInput.command || '', 200),
            file        : toolInput.file_path || null,
            ok          : toolResponse.success !== false && toolResponse.interrupted !== true,
            interrupted : toolResponse.interrupted === true,
          };

          let serialized = JSON.stringify(line);
          if (Buffer.byteLength(serialized, 'utf8') > 512) {
            line.cmd = truncate(line.cmd, 80);
            line.file = truncate(line.file || '', 200) || null;
            serialized = JSON.stringify(line);
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

    // Only track Agent tool dispatches (from here on)
    if (toolName !== 'Agent') return;

    const description  = toolInput.description  || '(sem descrição)';
    const subagentType = toolInput.subagent_type || 'general-purpose';
    const now          = Date.now();

    const liveFile = path.join(os.tmpdir(), `forge-live-${sessionId || 'unknown'}.json`);

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
