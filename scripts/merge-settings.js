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
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
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
const FORGE_MATCHERS = {
  PreToolUse : ['Agent', 'Write'],
  PostToolUse: ['Agent'],
};

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

  // Remove forge-managed permission defaults
  if (settings.skipDangerousModePermissionPrompt === true) {
    delete settings.skipDangerousModePermissionPrompt;
  }
  if (settings.permissions?.defaultMode === 'bypassPermissions') {
    delete settings.permissions.defaultMode;
    if (Object.keys(settings.permissions).length === 0) delete settings.permissions;
  }

  // Remove forge hooks from tool-use events (matchers: Agent, Write)
  for (const { event } of TOOL_HOOKS) {
    const eventHooks = settings.hooks?.[event];
    if (!Array.isArray(eventHooks)) continue;

    const matchers = FORGE_MATCHERS[event] || ['Agent'];
    for (const entry of eventHooks) {
      if (matchers.includes(entry.matcher) && Array.isArray(entry.hooks)) {
        entry.hooks = entry.hooks.filter(h => !h.command?.includes(FORGE_HOOK_MARKER));
      }
    }

    // Clean up empty matcher entries
    settings.hooks[event] = eventHooks.filter(
      e => !(matchers.includes(e.matcher) && e.hooks?.length === 0)
    );
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  // Remove forge hooks from lifecycle events (no matcher)
  for (const { event } of LIFECYCLE_HOOKS) {
    const eventHooks = settings.hooks?.[event];
    if (!Array.isArray(eventHooks)) continue;

    settings.hooks[event] = eventHooks.filter(
      e => !e.hooks?.some(h => h.command?.includes(FORGE_HOOK_MARKER))
    );
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

settings.statusLine = {
  type           : 'command',
  command        : statuslineCommand(),
  refreshInterval: 1,
};

// Bypass permission prompts — required for forge-auto unattended execution
settings.skipDangerousModePermissionPrompt = true;
if (!settings.permissions) settings.permissions = {};
settings.permissions.defaultMode = 'bypassPermissions';

if (!settings.hooks) settings.hooks = {};

// Tool-use hooks: one matcher entry per tool name
function mergeToolHook(eventHooks, phase, matcher) {
  let matcherEntry = eventHooks.find(e => e.matcher === matcher);
  if (!matcherEntry) {
    matcherEntry = { matcher, hooks: [] };
    eventHooks.push(matcherEntry);
  }

  const existingIdx = matcherEntry.hooks.findIndex(
    h => h.command?.includes(FORGE_HOOK_MARKER)
  );
  const hookEntry = { type: 'command', command: `node ~/.claude/forge-hook.js ${phase}` };

  if (existingIdx >= 0) matcherEntry.hooks[existingIdx] = hookEntry;
  else                  matcherEntry.hooks.push(hookEntry);
}

// Lifecycle hooks: no matcher (fire for all agents)
function mergeLifecycleHook(eventHooks, phase) {
  const existingIdx = eventHooks.findIndex(
    e => e.hooks?.some(h => h.command?.includes(FORGE_HOOK_MARKER))
  );
  const hookEntry = { hooks: [{ type: 'command', command: `node ~/.claude/forge-hook.js ${phase}` }] };

  if (existingIdx >= 0) eventHooks[existingIdx] = hookEntry;
  else                  eventHooks.push(hookEntry);
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

fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
console.log('  forge status line ativada');
