#!/usr/bin/env node
// forge-doctor — schema-version + projection-versioned checks for Forge Agent
//
// Library exports:
//   CURRENT_SCHEMA              // string — 'fragment-store@1.0.0' (write-default)
//   VALID_SCHEMAS               // string[] — accepted read stamps: 1.0.0 and 2.0.0
//   isValidSchema(v)            // (v) → boolean — membership check, never ===
//   checkSchema(cwd)            // (cwd?) → { ok, expected, actual, message }
//   checkProjectionVersioned(cwd) // (cwd?) → { ok, tracked: string[], skipped?: string, message }
//
// CLI:
//   node forge-doctor.js --check schema [--cwd <dir>]
//   node forge-doctor.js --check projection-versioned [--cwd <dir>]
//   node forge-doctor.js --check all [--cwd <dir>]
//   node forge-doctor.js --fix [--cwd <dir>]
//   node forge-doctor.js --regen-projection [--cwd <dir>]
//   node forge-doctor.js --help
//
// Exit codes: 0 all checks pass, 1 check failed, 2 bad arguments.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── Imports from forge-ignore ─────────────────────────────────────────────────
const { PROJECTION_IGNORE_PATHS, detectVcs } = require('./forge-ignore');

// ── Constants ─────────────────────────────────────────────────────────────────
// Write-default stays 1.0.0: the 2.0.0 bump is opt-in per repo and happens
// only when the first maintenance baseline runs (R6 — S06). Reading accepts both.
const VALID_SCHEMAS = ['fragment-store@1.0.0', 'fragment-store@2.0.0'];
const CURRENT_SCHEMA = VALID_SCHEMAS[0];
const isValidSchema = (v) => VALID_SCHEMAS.includes(String(v || '').trim());
const SCHEMA_FILE = '.gsd/SCHEMA-VERSION';

// ── checkSchema ───────────────────────────────────────────────────────────────
/**
 * Reads .gsd/SCHEMA-VERSION and compares to CURRENT_SCHEMA.
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: boolean, expected: string, actual: string|null, message: string }}
 */
function checkSchema(cwd) {
  const dir = cwd || process.cwd();
  const schemaPath = path.join(dir, SCHEMA_FILE);

  if (!fs.existsSync(schemaPath)) {
    return {
      ok: false,
      expected: CURRENT_SCHEMA,
      actual: null,
      message: `SCHEMA-VERSION not found at ${schemaPath}. Run --fix to create it.`,
    };
  }

  const actual = fs.readFileSync(schemaPath, 'utf8').trim();

  if (isValidSchema(actual)) {
    return {
      ok: true,
      expected: CURRENT_SCHEMA,
      actual,
      message: `Schema version valid: ${actual}`,
    };
  }

  return {
    ok: false,
    expected: CURRENT_SCHEMA,
    actual,
    message: `Schema version mismatch — expected one of "${VALID_SCHEMAS.join('", "')}", got "${actual}". Run --fix to update.`,
  };
}

// ── checkProjectionVersioned ──────────────────────────────────────────────────
/**
 * Checks if any projection monolith is tracked by VCS (should be ignored).
 * Uses PROJECTION_IGNORE_PATHS from forge-ignore.js — single source of truth.
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: boolean, tracked: string[], skipped?: string, message: string }}
 */
function checkProjectionVersioned(cwd) {
  const dir = cwd || process.cwd();
  const vcs = detectVcs(dir);

  if (vcs === 'none') {
    return {
      ok: true,
      tracked: [],
      skipped: 'not-git',
      message: 'No VCS detected — projection-versioned check skipped.',
    };
  }

  if (vcs === 'svn') {
    // SVN support: check svn status for each path
    const tracked = [];
    for (const projPath of PROJECTION_IGNORE_PATHS) {
      const absPath = path.join(dir, projPath);
      if (!fs.existsSync(absPath)) continue;
      try {
        const out = execFileSync('svn', ['status', absPath], { encoding: 'utf8' }).trim();
        // If svn status shows no '?' prefix, the file is tracked
        if (out && !out.startsWith('?')) {
          tracked.push(projPath);
        }
      } catch (_) {
        // not versioned or svn error — treat as not tracked
      }
    }
    if (tracked.length === 0) {
      return { ok: true, tracked: [], message: 'No projection monoliths are tracked by SVN.' };
    }
    return {
      ok: false,
      tracked,
      message: `${tracked.length} projection monolith(s) tracked by SVN (should be ignored): ${tracked.join(', ')}`,
    };
  }

  // git
  const tracked = [];
  for (const projPath of PROJECTION_IGNORE_PATHS) {
    try {
      const out = execFileSync(
        'git',
        ['ls-files', '--error-unmatch', projPath],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
      if (out) tracked.push(projPath);
    } catch (_) {
      // exit 1 = file not tracked — expected, continue
    }
  }

  if (tracked.length === 0) {
    return { ok: true, tracked: [], message: 'No projection monoliths are tracked by git.' };
  }

  return {
    ok: false,
    tracked,
    message: `${tracked.length} projection monolith(s) accidentally tracked by git (should be in .gitignore): ${tracked.join(', ')}`,
  };
}

// ── module.exports ────────────────────────────────────────────────────────────
module.exports = {
  CURRENT_SCHEMA,
  VALID_SCHEMAS,
  isValidSchema,
  checkSchema,
  checkProjectionVersioned,
};

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

function runCheck(name, cwd) {
  const checks = name === 'all'
    ? ['schema', 'projection-versioned']
    : [name];

  let allOk = true;
  const results = [];

  for (const c of checks) {
    if (c === 'schema') {
      const r = checkSchema(cwd);
      results.push({ check: 'schema', ...r });
      if (!r.ok) allOk = false;
    } else if (c === 'projection-versioned') {
      const r = checkProjectionVersioned(cwd);
      results.push({ check: 'projection-versioned', ...r });
      if (!r.ok) allOk = false;
    } else {
      process.stderr.write(`forge-doctor: unknown check "${c}". Valid: schema, projection-versioned, all\n`);
      process.exit(2);
    }
  }

  return { allOk, results };
}

function formatResults(results) {
  const lines = [];
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    const label = r.check === 'schema' ? 'Layer 2 — Schema version' : 'Layer 3 — Projection versioned';
    lines.push(`  ${icon} ${label}`);
    lines.push(`    ${r.message}`);
    if (!r.ok && r.tracked && r.tracked.length > 0) {
      for (const t of r.tracked) lines.push(`      - ${t}`);
    }
  }
  return lines.join('\n');
}

function cliMain() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`forge-doctor — Forge schema-version and projection-versioned checks

Flags:
  --check <name> [--cwd <dir>]   run check: schema | projection-versioned | all
  --fix [--cwd <dir>] [--migrate]  write SCHEMA-VERSION if missing; suggest ignore
                                 fixes. Refuses to stamp an unmigrated store unless
                                 --migrate is given (then runs forge-migrate first).
  --regen-projection [--cwd <dir>] [--force]  regenerate monolith projections from
                                 fragment store (refuses to overwrite a populated
                                 monolith from an empty store unless --force)
  --cwd <dir>                    working directory (default: process.cwd())
  --help                         show this help

Exit codes:
  0  all requested checks passed
  1  one or more checks failed
  2  bad arguments
`);
    return;
  }

  const cwdArg = typeof args.cwd === 'string' ? path.resolve(args.cwd) : process.cwd();

  if (args.fix) {
    const schemaPath = path.join(cwdArg, SCHEMA_FILE);
    const gsdDir = path.join(cwdArg, '.gsd');
    let fixed = [];

    // Ensure .gsd/ exists
    if (!fs.existsSync(gsdDir)) {
      fs.mkdirSync(gsdDir, { recursive: true });
    }

    // Migration gate: never stamp SCHEMA-VERSION on an unmigrated working copy.
    // A stamped-but-empty store makes --regen-projection destructive (it would
    // overwrite populated monoliths with empty skeletons). Require an explicit
    // --migrate to decompose the monoliths into fragments before stamping.
    const { isUnmigrated, storeState } = require('./forge-store-state');
    if (isUnmigrated(cwdArg)) {
      const st = storeState(cwdArg);
      const unmig = Object.entries(st)
        .filter(([, s]) => s.state === 'unmigrated')
        .map(([name, s]) => `${name} (${s.monolithPath}: ${s.monolithEntries} entries, 0 fragments)`);

      if (!args.migrate) {
        process.stdout.write('forge-doctor --fix:\n');
        process.stdout.write('  Refusing to stamp SCHEMA-VERSION — fragment store is not migrated.\n');
        process.stdout.write('  The following monoliths still hold the source of truth:\n');
        for (const u of unmig) process.stdout.write(`    - ${u}\n`);
        process.stdout.write('\n  Run the migration first (decomposes monoliths → fragments, then stamps):\n');
        process.stdout.write('    node scripts/forge-migrate.js\n');
        process.stdout.write('  Or let --fix run it for you:\n');
        process.stdout.write('    node scripts/forge-doctor.js --fix --migrate\n');
        process.exit(1);
        return;
      }

      // --migrate: delegate to the umbrella migrator. migrateAll() backs up each
      // monolith to .bak, decomposes into fragments, verifies, and stamps
      // SCHEMA-VERSION itself. Lazy-required to avoid the forge-migrate ↔
      // forge-doctor require cycle.
      const { migrateAll } = require('./forge-migrate');
      let results;
      try {
        results = migrateAll(cwdArg, {});
      } catch (e) {
        process.stderr.write(`forge-doctor --fix --migrate: migration failed: ${e.message}\n`);
        process.exit(1);
        return;
      }
      const migErr = ['ledger', 'decisions', 'memory'].find(n => results[n] && results[n].error);
      if (migErr) {
        process.stderr.write(`forge-doctor --fix --migrate: ${migErr} migration errored: ${results[migErr].error}\n`);
        process.stderr.write('  Partial state preserved; .bak files kept. See above.\n');
        process.exit(1);
        return;
      }
      process.stdout.write('forge-doctor --fix --migrate:\n');
      for (const n of ['ledger', 'decisions', 'memory']) {
        const r = results[n];
        if (r) process.stdout.write(`  ${n}: ${r.written} fragment(s) written, verification: ${r.verification}\n`);
      }
      process.stdout.write(`  SCHEMA-VERSION stamped: ${results.schema_version_written}\n`);
      process.exit(0);
      return;
    }

    if (!fs.existsSync(schemaPath)) {
      fs.writeFileSync(schemaPath, CURRENT_SCHEMA + '\n', 'utf8');
      fixed.push(`Created ${SCHEMA_FILE} with "${CURRENT_SCHEMA}"`);
    } else {
      const current = fs.readFileSync(schemaPath, 'utf8').trim();
      if (isValidSchema(current)) {
        // Anti-downgrade: never overwrite an already-valid stamp (e.g. a 2.0.0
        // opt-in bump must never be rewritten back to the 1.0.0 write-default).
        fixed.push(`${SCHEMA_FILE} already valid ("${current}") — no change`);
      } else {
        fs.writeFileSync(schemaPath, CURRENT_SCHEMA + '\n', 'utf8');
        fixed.push(`Updated ${SCHEMA_FILE}: "${current}" → "${CURRENT_SCHEMA}"`);
      }
    }

    // Suggest ignore fixes for tracked projections
    const projResult = checkProjectionVersioned(cwdArg);
    if (!projResult.ok && projResult.tracked.length > 0) {
      process.stdout.write(`forge-doctor --fix:\n`);
      for (const f of fixed) process.stdout.write(`  ${f}\n`);
      process.stdout.write(`\nProjection monoliths tracked by VCS:\n`);
      for (const t of projResult.tracked) process.stdout.write(`  - ${t}\n`);
      process.stdout.write(`\nTo fix, run:\n  node scripts/forge-ignore.js --apply\n`);
    } else {
      process.stdout.write(`forge-doctor --fix:\n`);
      for (const f of fixed) process.stdout.write(`  ${f}\n`);
    }
    process.exit(0);
    return;
  }

  if (args['regen-projection']) {
    const projectionScript = path.resolve(__dirname, 'forge-projection.js');
    const projArgs = ['--write-all'];
    if (cwdArg !== process.cwd()) projArgs.push('--cwd', cwdArg);
    if (args.force) projArgs.push('--force');
    try {
      execFileSync(process.execPath, [projectionScript].concat(projArgs), { stdio: 'inherit' });
      process.stdout.write('Monoliths regenerated. (.gsd/{AUTO-MEMORY,DECISIONS,LEDGER,CHECKER-MEMORY}.md refreshed from fragments.)\n');
      process.exit(0);
    } catch (err) {
      // forge-projection exits 1 when a target was blocked (empty store would
      // overwrite a populated monolith). The block reasons were printed to
      // stderr via stdio:inherit — add the operator-facing next step.
      process.stderr.write('forge-doctor --regen-projection: regeneration incomplete.\n');
      process.stderr.write('  An unmigrated store would overwrite a populated monolith.\n');
      process.stderr.write('  Run the migration first:  node scripts/forge-migrate.js\n');
      process.stderr.write('  Or force-overwrite (data loss):  node scripts/forge-doctor.js --regen-projection --force\n');
      process.exit(1);
    }
    return;
  }

  if (args.check) {
    const { allOk, results } = runCheck(args.check, cwdArg);
    process.stdout.write('Forge Doctor\n============\n\n');
    process.stdout.write(formatResults(results) + '\n');
    const passed = results.filter(r => r.ok).length;
    process.stdout.write(`\n  Summary: ${passed}/${results.length} checks passed\n`);
    process.exit(allOk ? 0 : 1);
    return;
  }

  process.stderr.write('forge-doctor: no command specified. Use --help.\n');
  process.exit(2);
}

if (require.main === module) cliMain();
