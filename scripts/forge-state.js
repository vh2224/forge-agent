#!/usr/bin/env node
// forge-state — Per-milestone state file reader/writer
//
// Parses and writes .gsd/milestones/M###/M###-STATE.md per shared/forge-state.md §1.
// Also reads pre-M004 legacy .gsd/STATE.md format for migration.
//
// Library exports:
//   read(cwd, milestoneId) → State | null
//   write(cwd, state) → string (file path)
//   updateFields(cwd, milestoneId, patch) → State
//   pushRecentUnit(cwd, milestoneId, entry) → State
//   readLegacyStateFile(cwd) → LegacyState | null
//
// CLI usage:
//   node forge-state.js --read M065 [--cwd <path>]
//   node forge-state.js --create M065 --phase plan-milestone --next-action "..."
//   node forge-state.js --update M065 --json '{"phase":"execute-task","task":"T03"}'

'use strict';

const fs   = require('fs');
const path = require('path');

const VALID_PHASES = new Set([
  'idle',
  'plan-milestone', 'discuss-milestone', 'research-milestone',
  'plan-slice', 'research-slice', 'execute-task',
  'complete-slice', 'complete-milestone',
  'resume', 'blocked',
]);

function statePath(cwd, milestoneId) {
  return path.join(cwd, '.gsd', 'milestones', milestoneId, `${milestoneId}-STATE.md`);
}

// ── YAML frontmatter helpers (tiny — handle only key:value lines) ───────────
function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { frontmatter: {}, body: text };
  const lines = m[1].split('\n');
  const fm = {};
  for (const line of lines) {
    const kv = line.match(/^([\w_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

function serializeFrontmatter(fm) {
  const lines = Object.entries(fm)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

// ── Body field extractors ───────────────────────────────────────────────────
function extractBoldField(body, label) {
  const re = new RegExp(`^\\*\\*${label}:\\*\\*\\s*(.+)$`, 'mi');
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

function extractSection(body, heading) {
  // Match "## heading" followed by content until next ## or end
  const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'mi');
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

// ── Public API ──────────────────────────────────────────────────────────────
function read(cwd, milestoneId) {
  const file = statePath(cwd, milestoneId);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);

  return {
    file,
    milestone: frontmatter.milestone || milestoneId,
    kind: frontmatter.kind || 'milestone',
    created: frontmatter.created,
    last_updated: frontmatter.last_updated,
    isolation_mode: frontmatter.isolation_mode || 'shared',

    active_slice: extractBoldField(body, 'Active Slice') || '—',
    active_task:  extractBoldField(body, 'Active Task')  || '—',
    phase:        extractBoldField(body, 'Phase')        || 'idle',
    auto_mode:    extractBoldField(body, 'Auto-mode')    || 'off',
    next_action:  extractBoldField(body, 'Next Action')  || '',

    recent_units: extractSection(body, 'Recent units \\(last 10\\)'),
    notes:        extractSection(body, 'Notes'),

    _raw: raw,
  };
}

function write(cwd, state) {
  if (!state.milestone) throw new Error('forge-state.write: state.milestone required');
  const milestoneId = state.milestone;
  const dir = path.dirname(statePath(cwd, milestoneId));
  if (!fs.existsSync(dir)) throw new Error(`forge-state.write: milestone dir missing: ${dir}`);

  if (state.phase && !VALID_PHASES.has(state.phase)) {
    throw new Error(`forge-state.write: invalid phase "${state.phase}"`);
  }

  const nowIso = new Date().toISOString();
  const fm = {
    milestone: milestoneId,
    kind: state.kind || 'milestone',
    created: state.created || nowIso,
    last_updated: nowIso,
    isolation_mode: state.isolation_mode || 'shared',
  };

  const lines = [];
  lines.push(`# ${milestoneId} State`);
  lines.push('');
  lines.push(`**Active Slice:** ${state.active_slice || '—'}`);
  lines.push(`**Active Task:** ${state.active_task || '—'}`);
  lines.push(`**Phase:** ${state.phase || 'idle'}`);
  lines.push(`**Auto-mode:** ${state.auto_mode || 'off'}`);
  lines.push(`**Next Action:** ${state.next_action || ''}`);
  lines.push('');

  if (state.recent_units && state.recent_units.trim()) {
    lines.push('## Recent units (last 10)');
    lines.push('');
    lines.push(state.recent_units.trim());
    lines.push('');
  }

  if (state.notes && state.notes.trim()) {
    lines.push('## Notes');
    lines.push('');
    lines.push(state.notes.trim());
    lines.push('');
  }

  const file = statePath(cwd, milestoneId);
  const content = serializeFrontmatter(fm) + '\n' + lines.join('\n');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function updateFields(cwd, milestoneId, patch) {
  const current = read(cwd, milestoneId);
  if (!current) throw new Error(`forge-state.updateFields: ${milestoneId} not found`);
  const next = Object.assign({}, current, patch);
  write(cwd, next);
  return next;
}

// Push a one-line entry to "Recent units" section, keep last 10
function pushRecentUnit(cwd, milestoneId, entry) {
  const current = read(cwd, milestoneId);
  if (!current) throw new Error(`forge-state.pushRecentUnit: ${milestoneId} not found`);
  const existing = (current.recent_units || '').split('\n').map(l => l.trim()).filter(Boolean);
  existing.push(entry);
  const trimmed = existing.slice(-10).join('\n');
  return updateFields(cwd, milestoneId, { recent_units: trimmed });
}

// Read legacy .gsd/STATE.md (pre-M004 single-run format) — for migration support
function readLegacyStateFile(cwd) {
  const file = path.join(cwd, '.gsd', 'STATE.md');
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.startsWith('<!-- AUTO-GENERATED')) return null;  // already dashboard

  const milestoneText = (raw.match(/\*\*Active Milestone:\*\*\s*([^\n]+)/i) || [])[1];
  if (!milestoneText) return null;

  return {
    file,
    raw,
    active_milestone: milestoneText.trim(),
    active_slice:     (raw.match(/\*\*Active Slice:\*\*\s*([^\n]+)/i) || [, '—'])[1].trim(),
    active_task:      (raw.match(/\*\*Active Task:\*\*\s*([^\n]+)/i)  || [, '—'])[1].trim(),
    phase:            (raw.match(/\*\*Phase:\*\*\s*([^\n]+)/i)        || [, 'idle'])[1].trim(),
    auto_mode:        (raw.match(/\*\*Auto-mode:\*\*\s*([^\n]+)/i)    || [, 'off'])[1].trim(),
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

function cliMain() {
  const args = parseArgs(process.argv.slice(2));
  const cwd  = args.cwd || process.cwd();

  if (args.help) {
    process.stdout.write(`forge-state — per-milestone STATE reader/writer

Flags:
  --read <M###>             print parsed state (null if missing)
  --create <M###>           initialize new state file
    --phase <phase>           required
    --next-action <text>      required
    --auto-mode <on|off>      default off
    --isolation-mode <m>      default shared
  --update <M###>           update fields
    --json '{"phase":"...","task":"T03"}'
  --push-recent <M###>      push to Recent units
    --entry '<text>'
  --read-legacy             print parsed legacy .gsd/STATE.md
  --cwd <path>              override working directory
`);
    return;
  }

  try {
    if (args.read) {
      const r = read(cwd, args.read);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      if (!r) process.exit(1);
    } else if (args.create) {
      const state = {
        milestone: args.create,
        phase: args.phase || 'idle',
        next_action: args['next-action'] || '',
        auto_mode: args['auto-mode'] || 'off',
        isolation_mode: args['isolation-mode'] || 'shared',
      };
      const file = write(cwd, state);
      process.stdout.write(file + '\n');
    } else if (args.update) {
      const patch = args.json ? JSON.parse(args.json) : {};
      const r = updateFields(cwd, args.update, patch);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args['push-recent']) {
      const r = pushRecentUnit(cwd, args['push-recent'], args.entry || '');
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else if (args['read-legacy']) {
      const r = readLegacyStateFile(cwd);
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      if (!r) process.exit(1);
    } else {
      process.stderr.write('forge-state: unknown command. Use --help.\n');
      process.exit(2);
    }
  } catch (e) {
    process.stderr.write(`forge-state error: ${e.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) cliMain();

module.exports = {
  read, write, updateFields, pushRecentUnit, readLegacyStateFile,
  statePath, VALID_PHASES,
};
