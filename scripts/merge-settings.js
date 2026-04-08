#!/usr/bin/env node
// Merge forge statusLine + hooks into ~/.claude/settings.json
// Idempotent: safe to run multiple times. Preserves all existing user settings.
//
// Usage: node merge-settings.js /path/to/settings.json

const fs   = require('fs');
const path = require('path');

const settingsFile = process.argv[2];
if (!settingsFile) {
  console.error('Usage: node merge-settings.js <settings.json path>');
  process.exit(1);
}

// Read existing settings (or start fresh)
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
} catch {
  // File doesn't exist or is invalid — start with empty object
}

// ── statusLine ──────────────────────────────────────────────────────────────
settings.statusLine = {
  type   : 'command',
  command: 'node ~/.claude/forge-statusline.js',
};

// ── hooks ───────────────────────────────────────────────────────────────────
if (!settings.hooks) settings.hooks = {};

const FORGE_HOOK_MARKER = 'forge-hook.js';

function mergeForgeHook(eventHooks, phase) {
  // Find or create the Agent matcher entry
  let matcherEntry = eventHooks.find(e => e.matcher === 'Agent');
  if (!matcherEntry) {
    matcherEntry = { matcher: 'Agent', hooks: [] };
    eventHooks.push(matcherEntry);
  }

  // Find existing forge hook entry (by marker in command string)
  const existingIdx = matcherEntry.hooks.findIndex(
    h => h.command && h.command.includes(FORGE_HOOK_MARKER)
  );

  const hookEntry = {
    type   : 'command',
    command: `node ~/.claude/forge-hook.js ${phase}`,
  };

  if (existingIdx >= 0) {
    matcherEntry.hooks[existingIdx] = hookEntry; // update
  } else {
    matcherEntry.hooks.push(hookEntry);           // add
  }
}

if (!Array.isArray(settings.hooks.PreToolUse))  settings.hooks.PreToolUse  = [];
if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];

mergeForgeHook(settings.hooks.PreToolUse,  'pre');
mergeForgeHook(settings.hooks.PostToolUse, 'post');

// ── Write back ──────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');

console.log('  settings.json atualizado com statusLine + hooks');
