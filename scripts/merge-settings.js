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

if (!settingsFile) {
  console.error('Usage: node merge-settings.js <settings.json path> [--remove]');
  process.exit(1);
}

// Read existing settings (or start fresh)
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
} catch { /* file doesn't exist or invalid — start empty */ }

const FORGE_HOOK_MARKER = 'forge-hook.js';

// ── REMOVE mode ─────────────────────────────────────────────────────────────
if (remove) {
  // Remove statusLine if it's ours
  if (settings.statusLine?.command?.includes('forge-statusline.js')) {
    delete settings.statusLine;
  }

  // Remove forge hooks from PreToolUse / PostToolUse
  for (const event of ['PreToolUse', 'PostToolUse']) {
    const eventHooks = settings.hooks?.[event];
    if (!Array.isArray(eventHooks)) continue;

    for (const entry of eventHooks) {
      if (entry.matcher === 'Agent' && Array.isArray(entry.hooks)) {
        entry.hooks = entry.hooks.filter(h => !h.command?.includes(FORGE_HOOK_MARKER));
      }
    }

    // Clean up empty matcher entries
    settings.hooks[event] = eventHooks.filter(
      e => !(e.matcher === 'Agent' && e.hooks?.length === 0)
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
  type   : 'command',
  command: 'node ~/.claude/forge-statusline.js',
};

if (!settings.hooks) settings.hooks = {};

function mergeForgeHook(eventHooks, phase) {
  let matcherEntry = eventHooks.find(e => e.matcher === 'Agent');
  if (!matcherEntry) {
    matcherEntry = { matcher: 'Agent', hooks: [] };
    eventHooks.push(matcherEntry);
  }

  const existingIdx = matcherEntry.hooks.findIndex(
    h => h.command?.includes(FORGE_HOOK_MARKER)
  );
  const hookEntry = { type: 'command', command: `node ~/.claude/forge-hook.js ${phase}` };

  if (existingIdx >= 0) matcherEntry.hooks[existingIdx] = hookEntry;
  else                  matcherEntry.hooks.push(hookEntry);
}

if (!Array.isArray(settings.hooks.PreToolUse))  settings.hooks.PreToolUse  = [];
if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];

mergeForgeHook(settings.hooks.PreToolUse,  'pre');
mergeForgeHook(settings.hooks.PostToolUse, 'post');

fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
console.log('  forge status line ativada');
