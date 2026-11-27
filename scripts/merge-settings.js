#!/usr/bin/env node
// Merge (or remove) forge statusLine + hooks from ~/.claude/settings.json
// Idempotent: safe to run multiple times. Preserves all existing user settings.
//
// Usage:
//   node merge-settings.js /path/to/settings.json          → enable
//   node merge-settings.js /path/to/settings.json --remove → disable

const fs   = require('fs');
const path = require('path');

// Resolved from the SAME source the installer uses, never reimplemented here:
// a third copy of the home-resolution rule is exactly what this repo forbids.
// Loaded defensively because this script's whole job is to write settings.json:
// if the sibling is somehow absent, emitting the conventional path (what this
// file did before) beats crashing and leaving the operator with no statusline
// and no hooks at all. The catch is narrowed to THIS module not being found —
// a syntax error inside forge-home.js must still be loud.
let forgeHome = null;
try {
  forgeHome = require('./forge-home');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes('forge-home')) throw error;
}

const settingsFile = process.argv[2];
const remove       = process.argv.includes('--remove');
const mcpAdd       = process.argv.includes('--mcp-add');
const mcpRemove    = process.argv.includes('--mcp-remove');
const mcpList      = process.argv.includes('--mcp-list');
const migrateStatuslineOnly = process.argv.includes('--migrate-statusline-command-only');
if (migrateStatuslineOnly && (remove || mcpAdd || mcpRemove || mcpList)) {
  fs.writeSync(1, JSON.stringify({ ok: false, changed: false, reason: 'statusline-migration-invalid-arguments' }) + '\n');
  process.exit(1);
}

if (!settingsFile) {
  console.error('Usage: node merge-settings.js <settings.json path> [--remove]');
  console.error('       node merge-settings.js <settings.json path> --mcp-add <name> <json-config>');
  console.error('       node merge-settings.js <settings.json path> --mcp-remove <name>');
  console.error('       node merge-settings.js <settings.json path> --mcp-list');
  process.exit(1);
}

// Read existing settings (or start fresh)
let settings = {};
try {
  if (!migrateStatuslineOnly) settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
} catch { /* file doesn't exist or invalid — start empty */ }

const FORGE_HOOK_MARKER = 'forge-hook.js';

// Lifecycle / session events: no matcher (fire session-wide, not per-tool)
const LIFECYCLE_HOOKS = [
  { event: 'SessionStart',  phase: 'session-start'  },
  { event: 'SubagentStart', phase: 'subagent-start' },
  { event: 'SubagentStop',  phase: 'subagent-stop'  },
  { event: 'PreCompact',    phase: 'pre-compact'     },
  { event: 'PostCompact',   phase: 'post-compact'    },
  { event: 'Stop',          phase: 'stop'            },
];

// Tool-use events: scoped to Agent tool via matcher
const TOOL_HOOKS = [
  { event: 'PreToolUse',  phase: 'pre'  },
  { event: 'PostToolUse', phase: 'post' },
];

// Matchers installed for each tool-use event. `Agent` tracks dispatches;
// `Write` fires the append-only guard for DECISIONS.md / LEDGER.md (pre only).
// PostToolUse also needs Bash/Write/Edit: the evidence log branch
// (forge-hook.js phase==='post', toolName Bash|Write|Edit) was shipped in M003
// S02 but its matchers were NEVER registered — measured consequence: zero
// evidence-*.jsonl files across the entire dogfood history, and the completer's
// Evidence Flags cross-check ran against a log that could not exist. The hook
// itself gates on evidence.mode (disabled = no write), so registration is what
// was missing, not another switch.
const FORGE_MATCHERS = {
  PreToolUse : ['Agent', 'Write'],
  PostToolUse: ['Agent', 'Bash', 'Write', 'Edit'],
};


// Native host observations use direct exec-form hooks: no shell may sit between
// Claude and the fixed Node hook producer. The reference they relay is passive;
// the Bridge validates live process/source custody and authenticates each body.
const LIVE_HOOKS = [
  { event: 'PreToolUse', phase: 'pre', matcher: '*' },
  { event: 'PostToolUse', phase: 'post', matcher: '*' },
  { event: 'PostToolUseFailure', phase: 'post-failure', matcher: '*' },
  { event: 'PermissionDenied', phase: 'permission-denied', matcher: '*' },
  { event: 'SubagentStart', phase: 'subagent-start' },
  { event: 'SubagentStop', phase: 'subagent-stop' },
  { event: 'Stop', phase: 'stop' },
  { event: 'SessionEnd', phase: 'session-end' },
  { event: 'ConfigChange', phase: 'config-change' },
  { event: 'PreModelSwitch', phase: 'pre-model-switch' },
  { event: 'PostModelSwitch', phase: 'post-model-switch' },
];
const OWN_PHASES = new Set([...LIFECYCLE_HOOKS, ...TOOL_HOOKS].map(row => row.phase));
const LIVE_PHASES = new Set(LIVE_HOOKS.map(row => row.phase));

function isNodeCommand(command) {
  return typeof command === 'string' && /^(?:node(?:\.exe)?|.*[\\/]node(?:\.exe)?)$/i.test(command);
}
function hookPhase(hook) {
  if (!hook || hook.type !== 'command' || typeof hook.command !== 'string') return null;
  if (Array.isArray(hook.args)) {
    if (!isNodeCommand(hook.command) || typeof hook.args[0] !== 'string'
        || path.basename(hook.args[0].replace(/\\/g, '/')) !== FORGE_HOOK_MARKER) return null;
    if (hook.args.length === 2 && OWN_PHASES.has(hook.args[1])) return hook.args[1];
    if (hook.args.length === 3 && hook.args[1] === 'native-live' && LIVE_PHASES.has(hook.args[2])) return 'native-live:' + hook.args[2];
    return null;
  }
  // Recognize the historical command we emitted, not arbitrary commands that
  // merely mention this filename. Unknown operator commands remain untouched.
  const match = /^node (?:~\/\.claude\/forge-hook\.js|"[^"\r\n]+[\\/]forge-hook\.js") ([a-z-]+)$/.exec(hook.command);
  return match && OWN_PHASES.has(match[1]) ? match[1] : null;
}
function hookExec(args) {
  const runtimeHome = forgeHome
    ? forgeHome.resolveRuntimeHome('claude', process.env.CLAUDE_CONFIG_DIR ? { claudeHome: process.env.CLAUDE_CONFIG_DIR } : {})
    : (process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude'));
  return { type: 'command', command: fs.realpathSync.native(process.execPath),
    args: [path.join(runtimeHome, FORGE_HOOK_MARKER), ...args], onFailure: 'block' };
}
function ownedAt(event, entry, phase) {
  return LIFECYCLE_HOOKS.some(row => row.event === event && row.phase === phase && entry.matcher === undefined)
    || TOOL_HOOKS.some(row => row.event === event && row.phase === phase && (FORGE_MATCHERS[event] || ['Agent']).includes(entry.matcher))
    || LIVE_HOOKS.some(row => row.event === event && 'native-live:' + row.phase === phase && entry.matcher === row.matcher);
}
function removeManaged(eventHooks, accepts) {
  return eventHooks.filter(entry => {
    if (!Array.isArray(entry.hooks)) return true;
    const hadManaged = entry.hooks.some(hook => accepts(hookPhase(hook), entry));
    entry.hooks = entry.hooks.filter(hook => !accepts(hookPhase(hook), entry));
    return !hadManaged || entry.hooks.length > 0;
  });
}
function mergeManaged(eventHooks, phase, matcher, hookEntry) {
  const matcherMatches = entry => matcher === undefined ? entry.matcher === undefined : entry.matcher === matcher;
  let installed = false;
  const retained = eventHooks.filter(entry => {
    // Scope the update to this exact matcher; Write never removes Agent.
    if (!matcherMatches(entry) || !Array.isArray(entry.hooks)) return true;
    let removed = false;
    entry.hooks = entry.hooks.flatMap(hook => {
      if (hookPhase(hook) !== phase) return [hook];
      removed = true;
      if (installed) return [];
      installed = true;
      return [hookEntry];
    });
    return !removed || entry.hooks.length > 0;
  });
  if (!installed) {
    let target = retained.find(entry => matcherMatches(entry) && Array.isArray(entry.hooks));
    if (!target) { target = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] }; retained.push(target); }
    target.hooks.push(hookEntry);
  }
  eventHooks.splice(0, eventHooks.length, ...retained);
}

// ── MCP operations ──────────────────────────────────────────────────────────
if (mcpAdd || mcpRemove || mcpList) {
  if (!settings.mcpServers) settings.mcpServers = {};

  if (mcpList) {
    const servers = Object.entries(settings.mcpServers);
    if (servers.length === 0) {
      console.log('  (nenhum MCP configurado)');
    } else {
      for (const [name, config] of servers) {
        const cmd = [config.command, ...(config.args || [])].join(' ');
        const envKeys = config.env ? Object.keys(config.env) : [];
        const envStr = envKeys.length ? ` (env: ${envKeys.join(', ')})` : '';
        console.log(`  ${name}: ${cmd}${envStr}`);
      }
    }
    process.exit(0);
  }

  if (mcpAdd) {
    const idx = process.argv.indexOf('--mcp-add');
    const name = process.argv[idx + 1];
    const jsonStr = process.argv[idx + 2];
    if (!name || !jsonStr) {
      console.error('Usage: --mcp-add <name> \'<json-config>\'');
      process.exit(1);
    }
    try {
      settings.mcpServers[name] = JSON.parse(jsonStr);
    } catch (e) {
      console.error(`Invalid JSON config: ${e.message}`);
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    console.log(`  MCP "${name}" adicionado`);
    process.exit(0);
  }

  if (mcpRemove) {
    const idx = process.argv.indexOf('--mcp-remove');
    const name = process.argv[idx + 1];
    if (!name) {
      console.error('Usage: --mcp-remove <name>');
      process.exit(1);
    }
    if (!settings.mcpServers[name]) {
      console.error(`  MCP "${name}" não encontrado`);
      process.exit(1);
    }
    delete settings.mcpServers[name];
    if (Object.keys(settings.mcpServers).length === 0) delete settings.mcpServers;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    console.log(`  MCP "${name}" removido`);
    process.exit(0);
  }
}

// ── REMOVE mode ─────────────────────────────────────────────────────────────
if (remove) {
  // Remove statusLine if it's ours
  if (settings.statusLine?.command?.includes('forge-statusline.js')) {
    delete settings.statusLine;
  }
  if (require('./forge-subagent-statusline').isManagedCommand(settings.subagentStatusLine?.command)) {
    delete settings.subagentStatusLine;
  }

  // Remove forge-managed permission defaults
  if (settings.skipDangerousModePermissionPrompt === true) {
    delete settings.skipDangerousModePermissionPrompt;
  }
  if (settings.permissions?.defaultMode === 'bypassPermissions') {
    delete settings.permissions.defaultMode;
    if (Object.keys(settings.permissions).length === 0) delete settings.permissions;
  }

  // Remove only managed hook elements, preserving foreign siblings and group metadata.
  const managedEvents = new Set([...TOOL_HOOKS, ...LIFECYCLE_HOOKS, ...LIVE_HOOKS].map(row => row.event));
  for (const event of managedEvents) {
    const entries = settings.hooks?.[event];
    if (!Array.isArray(entries)) continue;
    settings.hooks[event] = removeManaged(entries, (phase, entry) => ownedAt(event, entry, phase));
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  // Clean up empty hooks object
  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log('  forge status line desativada');
  process.exit(0);
}

// ── ENABLE mode ─────────────────────────────────────────────────────────────
// The statusline runs from the Forge home core (`~/.forge-agent/scripts/`),
// the one copy the installer recopies wholesale on every install/update
// (forge-installer.js MANAGED_CORE). Its companion modules (forge-runs.js,
// forge-accounts.js, forge-prefs.js, forge-usage-poll.js) resolve as
// `__dirname` siblings there. The previous flat `~/.claude/forge-statusline.js`
// was a render target of no source in forge-source-manifest.json — it froze
// across releases, and lost every companion once retireLegacyScripts removed
// `~/.claude/scripts/`. REMOVE mode matches by basename
// (`.includes('forge-statusline.js')`), so both the old and the new path stay
// removable; and because this assignment is unconditional, existing installs
// migrate to the maintained path on their next merge.
//
// The `~/` form is DELIBERATE for the conventional home and is not laziness: a
// settings.json carrying a tilde survives being synced to another machine or
// another user, and an absolute path does not. It is also the literal Section
// 106 of forge-smoke.js mines out of THIS source to prove the path is a managed
// projection — a template expression here would blind that guard, which has
// already been blind twice.
//
// So the tilde stays the default, and only a RELOCATED Forge home (#105) gets
// an absolute path: `FORGE_HOME` is an operator-set variable that `~/` cannot
// express, and emitting the default for that operator points the statusline at
// a directory that may not exist.
const STATUSLINE_CONVENTIONAL = 'node ~/.forge-agent/scripts/forge-statusline.js';

// Forward slashes, always: Node accepts them on Windows too, while a backslash
// inside a shell-quoted string is an escape on sh and a separator on cmd. The
// quotes cover a home directory containing spaces.
function statuslineCommand() {
  if (!forgeHome) {
    if (process.env.FORGE_HOME) {
      console.error('  aviso: FORGE_HOME definido mas forge-home.js não foi encontrado ao lado deste script;'
        + ' a statusline aponta para o caminho convencional e pode não existir');
    }
    return STATUSLINE_CONVENTIONAL;
  }
  const resolved = path.resolve(forgeHome.resolveForgeHome({}));
  const conventional = path.resolve(path.join(forgeHome.resolveUserHome({}), '.forge-agent'));
  if (resolved === conventional) return STATUSLINE_CONVENTIONAL;
  const script = path.join(resolved, 'scripts', 'forge-statusline.js').split(path.sep).join('/');
  return `node "${script}"`;
}

function migrateLegacyStatuslineCommand() {
  const crypto = require('crypto'), equal = require('util').isDeepStrictEqual;
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const legacy = 'node ~/.claude/forge-statusline.js';
  const args = process.argv.slice(3), opts = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--migrate-statusline-command-only') continue;
    if (args[i] === '--dry-run' && !opts.dryRun) { opts.dryRun = true; continue; }
    const key = args[i] === '--backup' ? 'backup' : args[i] === '--expected-sha256' ? 'expected' : null;
    if (!key || opts[key] !== undefined || !args[i + 1]) fail('statusline-migration-invalid-arguments');
    opts[key] = args[++i];
  }
  const signature = st => [st.dev, st.ino, st.mode, st.nlink, st.size, st.mtimeNs, st.ctimeNs].map(String).join(':');
  // Match the delivered update-check rule: only Windows pathname device zero
  // may differ at the path-to-descriptor boundary. Open descriptor checks stay exact.
  const pathMatches = (left, right) => (String(left.dev) === String(right.dev)
    || process.platform === 'win32' && left.dev === 0n && right.dev > 0n)
    && [left.ino, left.mode, left.nlink, left.size, left.mtimeNs, left.ctimeNs].map(String).join(':')
      === [right.ino, right.mode, right.nlink, right.size, right.mtimeNs, right.ctimeNs].map(String).join(':');
  function checkedRead(file) {
    const st = fs.lstatSync(file, { bigint: true });
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || st.size > 1024n * 1024n) fail('statusline-migration-untrusted-file');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!pathMatches(st, opened)) fail('statusline-migration-file-changed');
      const bytes = fs.readFileSync(fd);
      if (signature(fs.fstatSync(fd, { bigint: true })) !== signature(opened)) fail('statusline-migration-file-changed');
      return { bytes, stat: st, signature: signature(st), real: fs.realpathSync.native(file) };
    } finally { fs.closeSync(fd); }
  }
  if (!forgeHome) fail('statusline-migration-helper-unavailable');
  let before;
  try { before = checkedRead(settingsFile); } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, changed: false, reason: 'settings-missing' };
    throw error;
  }
  if (require('./forge-projection-self').isSelfProjection({ repo: path.resolve(__dirname, '..'), source: 'shared/templates/claude/settings.jsonc', destination: settingsFile })) fail('statusline-migration-self-target');
  const text = before.bytes.toString('utf8');
  if (!Buffer.from(text).equals(before.bytes)) return { ok: true, changed: false, reason: 'unsupported-encoding' };
  let data;
  try { data = JSON.parse(text); } catch (_) { return { ok: true, changed: false, reason: 'settings-invalid-json' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.statusLine || typeof data.statusLine !== 'object' || Array.isArray(data.statusLine)
      || data.statusLine.type !== 'command' || data.statusLine.command !== legacy) return { ok: true, changed: false, reason: 'not-exact-legacy-command' };
  const token = JSON.stringify(legacy), offset = text.indexOf(token);
  if (offset < 0 || text.indexOf(token, offset + token.length) !== -1 || (text.match(/"statusLine"\s*:/g) || []).length !== 1) return { ok: true, changed: false, reason: 'ambiguous-legacy-command' };
  // JSON is already valid. This local span check only rejects duplicate/escaped
  // target keys; it is not a replacement JSON parser or a config editor.
  const strings = [];
  const masked = text.replace(/"(?:\\.|[^"\\])*"/g, (raw, start) => {
    strings.push({ raw, start, end: start + raw.length, value: JSON.parse(raw) });
    return ' '.repeat(raw.length);
  });
  let depth = 0, cursor = 0;
  for (let i = 0; i < masked.length; i++) {
    if (cursor < strings.length && strings[cursor].start === i) strings[cursor++].depth = depth;
    if (masked[i] === '{' || masked[i] === '[') depth++;
    else if (masked[i] === '}' || masked[i] === ']') depth--;
  }
  const nonspace = (start, source = masked) => { while (start < source.length && /[ \t\r\n]/.test(source[start])) start++; return start; };
  const key = token => masked[nonspace(token.end)] === ':';
  const roots = strings.filter(t => t.depth === 1 && t.value === 'statusLine' && key(t));
  if (roots.length !== 1 || roots[0].raw !== '"statusLine"') return { ok: true, changed: false, reason: 'ambiguous-legacy-command' };
  const open = nonspace(nonspace(roots[0].end) + 1);
  let close = open, level = 0;
  for (; close < masked.length; close++) {
    if (masked[close] === '{' || masked[close] === '[') level++;
    else if (masked[close] === '}' || masked[close] === ']') level--;
    if (level === 0) break;
  }
  const commands = strings.filter(t => t.start > open && t.end < close && t.depth === 2 && t.value === 'command' && key(t));
  if (masked[open] !== '{' || commands.length !== 1 || commands[0].raw !== '"command"'
      || nonspace(nonspace(commands[0].end) + 1, text) !== offset) return { ok: true, changed: false, reason: 'ambiguous-legacy-command' };

  const command = statuslineCommand(), candidate = text.slice(0, offset) + JSON.stringify(command) + text.slice(offset + token.length);
  const expected = JSON.parse(text); expected.statusLine.command = command;
  if (!equal(JSON.parse(candidate), expected)) return { ok: true, changed: false, reason: 'ambiguous-legacy-command' };
  const bytes = Buffer.from(candidate), sourceScript = path.join(__dirname, 'forge-statusline.js'), script = path.join(path.resolve(forgeHome.resolveForgeHome({})), 'scripts', 'forge-statusline.js');
  const sourceHash = hash(fs.readFileSync(sourceScript)), result = { ok: true, changed: true, reason: 'legacy-statusline-command', before_sha256: hash(before.bytes), after_sha256: hash(bytes), command, entrypoint: script, expected_entrypoint_sha256: sourceHash, dry_run: opts.dryRun };
  if (opts.dryRun) return result;
  if (!opts.expected || !/^[a-f0-9]{64}$/.test(opts.expected) || opts.expected !== result.before_sha256) fail('statusline-migration-file-changed');
  if (!opts.backup || !path.isAbsolute(opts.backup)) fail('statusline-migration-backup-required');
  const backupRoot = path.resolve(forgeHome.resolveForgeHome({}), 'backups'), relative = path.relative(backupRoot, path.resolve(opts.backup));
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('statusline-migration-backup-untrusted');
  const target = checkedRead(script);
  if (hash(target.bytes) !== sourceHash) fail('statusline-migration-entrypoint-mismatch');
  function unchanged() {
    const current = checkedRead(settingsFile);
    if (current.real !== before.real || current.signature !== before.signature || hash(current.bytes) !== result.before_sha256) fail('statusline-migration-file-changed');
  }
  unchanged();
  let directory = path.resolve(forgeHome.resolveForgeHome({}));
  for (const part of ['backups', ...path.dirname(relative).split(path.sep).filter(p => p !== '.')]) {
    directory = path.join(directory, part);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
    const st = fs.lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink()) fail('statusline-migration-backup-untrusted');
  }
  try { fs.writeFileSync(opts.backup, before.bytes, { flag: 'wx', mode: 0o600 }); }
  catch (_) { fail('statusline-migration-backup-failed'); }
  if (hash(checkedRead(opts.backup).bytes) !== result.before_sha256) fail('statusline-migration-backup-failed');
  unchanged();
  const temp = path.join(path.dirname(settingsFile), '.forge-statusline-' + crypto.randomUUID() + '.tmp');
  fs.writeFileSync(temp, bytes, { flag: 'wx', mode: Number(before.stat.mode & 0o777n) });
  try { unchanged(); fs.renameSync(temp, settingsFile); }
  finally { if (fs.existsSync(temp)) { try { if (hash(checkedRead(temp).bytes) === result.after_sha256) fs.unlinkSync(temp); } catch (_) { /* preserve an unrecognized temporary */ } } }
  if (hash(checkedRead(settingsFile).bytes) !== result.after_sha256) fail('statusline-migration-write-verification-failed');
  return { ...result, backup: opts.backup, active_entrypoint_sha256: sourceHash };
}

if (migrateStatuslineOnly) {
  try { fs.writeSync(1, JSON.stringify(migrateLegacyStatuslineCommand()) + '\n'); process.exit(0); }
  catch (error) {
    const reason = typeof error.code === 'string' && /^statusline-migration-[a-z-]+$/.test(error.code) ? error.code : 'statusline-migration-io-failed';
    fs.writeSync(1, JSON.stringify({ ok: false, changed: false, reason }) + '\n'); process.exit(1);
  }
}

const explicitRefreshInterval = settings.statusLine
  && Object.prototype.hasOwnProperty.call(settings.statusLine, 'refreshInterval')
  ? { refreshInterval: settings.statusLine.refreshInterval } : {};
settings.statusLine = {
  type           : 'command',
  command        : statuslineCommand(),
  ...explicitRefreshInterval,
};

// Bypass permission prompts — required for forge-auto unattended execution
settings.skipDangerousModePermissionPrompt = true;
if (!settings.permissions) settings.permissions = {};
settings.permissions.defaultMode = 'bypassPermissions';

if (!settings.hooks) settings.hooks = {};

// Replace managed elements in place, without replacing their mixed group.
function mergeToolHook(eventHooks, phase, matcher) {
  mergeManaged(eventHooks, phase, matcher, { type: 'command', command: 'node ~/.claude/forge-hook.js ' + phase });
}
function mergeLifecycleHook(eventHooks, phase) {
  const hook = phase === 'session-start' ? hookExec([phase])
    : { type: 'command', command: 'node ~/.claude/forge-hook.js ' + phase };
  mergeManaged(eventHooks, phase, undefined, hook);
}

for (const { event, phase } of TOOL_HOOKS) {
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const matchers = FORGE_MATCHERS[event] || ['Agent'];
  for (const matcher of matchers) {
    mergeToolHook(settings.hooks[event], phase, matcher);
  }
}

for (const { event, phase } of LIFECYCLE_HOOKS) {
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  mergeLifecycleHook(settings.hooks[event], phase);
}

for (const { event, phase, matcher } of LIVE_HOOKS) {
  if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  mergeManaged(settings.hooks[event], 'native-live:' + phase, matcher, hookExec(['native-live', phase]));
}

fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
console.log('  forge status line ativada');
