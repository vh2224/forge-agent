#!/usr/bin/env node
// forge-maintenance-gate — detection/announce layer + RED-warning render for
// the maintenance handshake (T01 of S05, M-20260706152250-maintenance-fragment).
//
// This module owns NO apply logic and NO schema read/write — it only
// announces whether a "sweep" is normal or needs maintenance, and renders a
// genuinely prominent warning for the operator. Consolidation itself is
// S04's `runBaseline` (imported here, not re-implemented).
//
// Library exports:
//   detectMode(cwd, opts?)      → { mode, triggers, firedAxes, baseline }
//   renderRedWarning(detection) → string (prominent RED/⚠ banner)
//
// CLI:
//   node forge-maintenance-gate.js --detect [--cwd <dir>]
//   node forge-maintenance-gate.js --help
//
// Determinism invariants (hard, per S04/S05 CONTEXT):
//   - NO Math.random, NO mtime, NO localeCompare, NO Date anywhere in this
//     module. Detection reads counts/existence only — never time.
//   - "Baseline available" is an existsSync check on the LOCKED rollup
//     targets — never a schema read (that is S06's opt-in territory).

'use strict';

const fs = require('fs');
const path = require('path');

const {
  detectTriggers,
  runBaseline,
  MILESTONE_THRESHOLD,
  TASK_THRESHOLD,
  DECISIONS_THRESHOLD,
} = require('./forge-maintenance-baseline.js');

const { readPref } = require('./forge-cli-helpers.js');

// ── rollup bucket presence (no schema read) ──────────────────────────────────
function _milestonesRollupPath(cwd) {
  return path.join(cwd, '.gsd', 'archive', 'milestones-rollup.md');
}
function _tasksRollupPath(cwd) {
  return path.join(cwd, '.gsd', 'archive', 'tasks-rollup.md');
}
function _decisionsRollupDirExists(cwd) {
  const dir = path.join(cwd, '.gsd', 'decisions');
  if (!fs.existsSync(dir)) return false;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return entries.some(name => /^_rollup-\d{4}-Q[1-4]\.md$/.test(name));
}

// ── axis metadata (name, count field, fired, target) ─────────────────────────
function _axisTargetLabel(axis, cwd) {
  if (axis === 'milestones') return _milestonesRollupPath(cwd);
  if (axis === 'tasks') return _tasksRollupPath(cwd);
  return path.join(cwd, '.gsd', 'decisions', '_rollup-<YYYY-QN>.md');
}

// ── detectMode ────────────────────────────────────────────────────────────────
// Announces SWEEP NORMAL vs SWEEP PRECISA DE MAINTENANCE. Reads counts via
// detectTriggers (S04) and a dry-run plan via runBaseline (S04, dryRun:true —
// no writes). Baseline availability is an existsSync check only.
function detectMode(cwd, opts) {
  opts = opts || {};

  // ── opt-in gate (S06/T02) ───────────────────────────────────────────────
  // The feature is inert by default: installing the tooling must never
  // change behavior. Only when the repo explicitly sets
  // `maintenance.enabled: true` does the trigger/baseline logic below run.
  // Injectable via opts.enabled for tests (bypasses the prefs cascade).
  const enabled =
    typeof opts.enabled === 'boolean'
      ? opts.enabled
      : String(readPref(cwd, 'maintenance.enabled', 'false')).trim() === 'true';

  if (!enabled) {
    return {
      mode: 'normal',
      enabled: false,
      triggers: detectTriggers(cwd, opts),
      firedAxes: [],
      baseline: { available: false, plan: null },
    };
  }

  const triggers = detectTriggers(cwd, opts);
  const plan = runBaseline(cwd, Object.assign({}, opts, { dryRun: true }));

  const anyLoose =
    plan.milestones.count + plan.tasks.count + plan.ledgerDecisions.closedQuarterCount > 0;
  const anyBucket =
    fs.existsSync(_milestonesRollupPath(cwd)) ||
    fs.existsSync(_tasksRollupPath(cwd)) ||
    _decisionsRollupDirExists(cwd);
  const baselineAvailable = anyLoose && !anyBucket;

  const firedAxes = [];
  if (triggers.milestones.fired) {
    firedAxes.push({
      axis: 'milestones',
      count: triggers.milestones.count,
      fired: true,
      target: _axisTargetLabel('milestones', cwd),
      threshold: MILESTONE_THRESHOLD,
    });
  }
  if (triggers.tasks.fired) {
    firedAxes.push({
      axis: 'tasks',
      count: triggers.tasks.count,
      fired: true,
      target: _axisTargetLabel('tasks', cwd),
      threshold: TASK_THRESHOLD,
    });
  }
  if (triggers.ledgerDecisions.fired) {
    firedAxes.push({
      axis: 'ledgerDecisions',
      count: triggers.ledgerDecisions.closedQuarterCount,
      fired: true,
      target: _axisTargetLabel('decisions', cwd),
      threshold: DECISIONS_THRESHOLD,
    });
  }

  const mode = firedAxes.length > 0 || baselineAvailable ? 'maintenance' : 'normal';

  return {
    mode,
    enabled: true,
    triggers,
    firedAxes,
    baseline: { available: baselineAvailable, plan },
  };
}

// ── renderRedWarning ──────────────────────────────────────────────────────────
// Pure string builder — no I/O, no Date, no random. Two layers of prominence
// so the warning survives both color and no-color terminals: an ANSI
// bold-red wrap AND a boxed ⚠ header inside it.
const RED_ON = '\x1b[1;31m';
const RED_OFF = '\x1b[0m';

function renderRedWarning(detection) {
  detection = detection || { firedAxes: [], baseline: { available: false } };
  const lines = [];

  lines.push('┌' + '─'.repeat(58) + '┐');
  lines.push('│  ⚠ MAINTENANCE NECESSÁRIA — SWEEP PRECISA DE MAINTENANCE  │');
  lines.push('└' + '─'.repeat(58) + '┘');
  lines.push('');

  const firedAxes = detection.firedAxes || [];
  for (const f of firedAxes) {
    lines.push(`  ⚠ eixo "${f.axis}": ${f.count} unidades finalizadas soltas (limiar ${f.threshold}) — funde → ${f.target}`);
  }

  if (detection.baseline && detection.baseline.available) {
    lines.push('  ⚠ BASELINE (1ª maintenance) — nenhum bucket rollup existe ainda; unidades finalizadas soltas serão consolidadas.');
  }

  if (firedAxes.length === 0 && !(detection.baseline && detection.baseline.available)) {
    lines.push('  (nenhum eixo disparado — chamado fora de contexto de maintenance)');
  }

  return RED_ON + lines.join('\n') + RED_OFF;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--detect') out.detect = true;
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function printHelp() {
  console.log([
    'forge-maintenance-gate — detection/announce + RED-warning render',
    '',
    'Usage:',
    '  node forge-maintenance-gate.js --detect [--cwd <dir>]',
    '  node forge-maintenance-gate.js --help',
  ].join('\n'));
}

function cliMain(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return 0;
  }

  const cwd = args.cwd || process.cwd();

  if (args.detect) {
    console.log(JSON.stringify(detectMode(cwd)));
    return 0;
  }

  process.stderr.write('Error: no command given. Use --detect or --help\n');
  return 2;
}

module.exports = {
  detectMode,
  renderRedWarning,
};

if (require.main === module) {
  process.exit(cliMain(process.argv.slice(2)));
}
