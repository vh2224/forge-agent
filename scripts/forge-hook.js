#!/usr/bin/env node
// Forge Hook — fires on PreToolUse / PostToolUse (Agent + Write matchers)
//              and on SubagentStart / SubagentStop / PreCompact / PostCompact lifecycle events
// Writes dispatch progress to a temp file that forge-statusline.js reads
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

// Bump last_heartbeat in auto-mode.json without clobbering other fields.
// Called from SubagentStart/Stop so workers longer than the statusline stale
// threshold don't get marked dead. No-op if auto-mode isn't active.
const bumpAutoHeartbeat = (cwd) => {
  try {
    const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
    const auto = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
    if (auto && auto.active === true) {
      auto.last_heartbeat = Date.now();
      fs.writeFileSync(autoFile, JSON.stringify(auto), 'utf8');
    }
  } catch { /* no auto mode or unreadable — ignore */ }
};

// Resolve the current unit ID from .gsd/forge/auto-mode.json `worker` field.
// worker shape: "unit_type/UNIT_ID" — returns the right half (e.g. "T03").
// Falls back to "adhoc" when the file is absent, unreadable, or worker is null.
const resolveUnitId = (cwd) => {
  try {
    const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
    const auto = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
    if (auto && typeof auto.worker === 'string' && auto.worker.length > 0) {
      const parts = auto.worker.split('/');
      return parts.length === 2 ? parts[1] : 'adhoc';
    }
  } catch { /* no auto-mode / unreadable → adhoc */ }
  return 'adhoc';
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

// Truncate a string to at most `max` characters, appending ellipsis if cut.
const truncate = (s, max) => {
  if (typeof s !== 'string') return '';
  return s.length <= max ? s : s.slice(0, max) + '\u2026';
};

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
      const cwd        = data.cwd || process.cwd();
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

      bumpAutoHeartbeat(cwd);
      return;
    }

    // ── SubagentStop: compute real worker duration ───────────────────────────
    if (phase === 'subagent-stop') {
      const sessionId = data.session_id || 'unknown';
      const cwd       = data.cwd || process.cwd();
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

      bumpAutoHeartbeat(cwd);
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

    // ── PreToolUse / PostToolUse: track Agent dispatches ────────────────────
    const toolName  = data.tool_name  || '';
    const toolInput = data.tool_input || {};

    // ── Safety guards (PreToolUse only) ─────────────────────────────────────
    if (phase === 'pre') {
      let blockMessage = null;

      // ── Bash guards ────────────────────────────────────────────────────────
      if (toolName === 'Bash') {
        const cmd = toolInput.command || '';

        // Block: git commit --no-verify (bypass pre-commit hooks)
        if (/git\s+commit\b/.test(cmd) && /--no-verify\b/.test(cmd)) {
          blockMessage = '[forge-hook] Bloqueado: git commit --no-verify contorna hooks de pre-commit. Corrija a falha do hook.';
        }

        // Block: git push --force / -f  (but allow --force-with-lease)
        if (!blockMessage && /git\s+push\b/.test(cmd)) {
          // Remove --force-with-lease from consideration, then check for --force or -f flag
          const cmdWithoutSafe = cmd.replace(/--force-with-lease\S*/g, '');
          if (/--force\b/.test(cmdWithoutSafe) || /(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*(?:\s|$)/.test(cmdWithoutSafe)) {
            blockMessage = '[forge-hook] Bloqueado: git push --force pode sobrescrever commits remotos. Use --force-with-lease se necessário.';
          }
        }

        // Block: rm -rf .gsd/ (destructive removal of forge state)
        if (!blockMessage && /\brm\b/.test(cmd) && /\.gsd/.test(cmd)) {
          // Flags must contain both r and f (in any combined form or separately)
          const flagsMatch = cmd.match(/\B-([a-zA-Z]+)/g) || [];
          const allFlags   = flagsMatch.join('');
          if (allFlags.includes('r') && allFlags.includes('f')) {
            blockMessage = '[forge-hook] Bloqueado: remoção destrutiva de .gsd/ protege o estado do Forge.';
          }
        }
      }

      // ── Write guard — protect append-only files (DECISIONS.md, LEDGER.md) ─
      // Root cause: agents reflexively pick `Write` to "append" after reading
      // a partial file, clobbering all prior rows. Append-only files must go
      // through `Edit` or `cat >>`. Initial creation (file absent) is allowed.
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

        // Skip .env.example and .env.sample files
        const isSafeEnvFile = /\.env\.(example|sample)$/i.test(filePath);

        if (!isSafeEnvFile) {
          const secretPattern = /(API_KEY|SECRET_KEY|PRIVATE_KEY|PASSWORD)\s*=\s*["'][^${\s]{8,}/;
          // Check line by line — skip comment lines (# or //)
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

      if (blockMessage) {
        process.stdout.write(blockMessage + '\n');
        process.exit(2);
      }
    }

    // ── PostToolUse: evidence capture (Bash/Write/Edit only) ─────────────────
    if (phase === 'post' && (toolName === 'Bash' || toolName === 'Write' || toolName === 'Edit')) {
      try {
        const cwd = data.cwd || process.cwd();
        const mode = readEvidenceMode(cwd);
        if (mode !== 'disabled') {
          const unitId = resolveUnitId(cwd);
          const evidenceDir  = path.join(cwd, '.gsd', 'forge');
          const evidenceFile = path.join(evidenceDir, `evidence-${unitId}.jsonl`);

          // Build evidence line — keep ≤ 512 bytes total
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
          // Safety: if still oversize (huge file path), truncate cmd then file
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

    // Only track Agent tool dispatches (from here on)
    if (toolName !== 'Agent') return;

    const sessionId    = data.session_id || 'unknown';
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
