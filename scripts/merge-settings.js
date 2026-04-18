#!/usr/bin/env node
// Merge (or remove) forge statusLine + hooks from ~/.claude/settings.json
// Idempotent: safe to run multiple times. Preserves all existing user settings.
//
// Usage:
//   node merge-settings.js /path/to/settings.json          → enable
//   node merge-settings.js /path/to/settings.json --remove → disable

const fs   = require('fs');
const path = require('path');

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

// Lifecycle events: no matcher (fire for all agents)
const LIFECYCLE_HOOKS = [
  { event: 'SubagentStart', phase: 'subagent-start' },
  { event: 'SubagentStop',  phase: 'subagent-stop'  },
  { event: 'PreCompact',    phase: 'pre-compact'     },
  { event: 'PostCompact',   phase: 'post-compact'    },
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
settings.statusLine = {
  type           : 'command',
  command        : 'node ~/.claude/forge-statusline.js',
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
