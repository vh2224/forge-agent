#!/usr/bin/env node
'use strict';

/**
 * Cross-platform, zero-dependency runner for the repository's standalone
 * scripts/*.test.js suites.
 *
 * Tests run sequentially because a few legacy suites exercise process-global
 * configuration and filesystem fixtures. Each child receives an isolated home
 * directory by default so developer preferences cannot change test outcomes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptsDir = __dirname;
const repoRoot = path.resolve(scriptsDir, '..');

function usage() {
  return [
    'Usage: node scripts/run-tests.js [options]',
    '',
    'Options:',
    '  --list             List discovered suites without running them',
    '  --changed          Run only suites related to files git currently sees as',
    '                     modified (staged + unstaged + untracked). Built for the',
    '                     verification gate: static, shell-safe invocation whose',
    '                     cost scales with the task footprint, not the repo.',
    '                     Zero related suites is a legitimate pass (docs-only',
    '                     change); a missing git is a loud error, never a pass.',
    '  --match <text>     Run suites whose filename contains text (repeatable)',
    '  --fail-fast        Stop after the first failing suite',
    '  --verbose          Print output from successful suites too',
    '  --inherit-home     Do not isolate HOME/USERPROFILE for child suites',
    '  --baseline <file>  Compare the set of failing suites against a versioned',
    '                     per-platform known-failures baseline. Exit 0 only when',
    '                     the sets match exactly in BOTH directions: a failure',
    '                     missing from the baseline is a new red, and a baseline',
    '                     entry whose suite now passes must be removed. All',
    '                     suites still run and log; only the exit code changes.',
    '  --help             Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    list: false,
    changed: false,
    matches: [],
    failFast: false,
    verbose: false,
    inheritHome: false,
    baseline: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--list') options.list = true;
    else if (arg === '--changed') options.changed = true;
    else if (arg === '--fail-fast') options.failFast = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--inherit-home') options.inheritHome = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--match') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--match requires a filename substring');
      options.matches.push(value.toLowerCase());
      index += 1;
    } else if (arg === '--baseline') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--baseline requires a file path');
      options.baseline = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function discoverTests(matches) {
  return fs.readdirSync(scriptsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.js'))
    .map(entry => entry.name)
    .filter(name => matches.length === 0 || matches.some(match => name.toLowerCase().includes(match)))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

// ---------------------------------------------------------------------------
// --changed: task-scoped suite selection
//
// Diffs against HEAD (plus untracked), so it measures exactly what the current
// unit of work touched — earlier commits on the branch are not re-run here;
// the full suite remains the merge-boundary check. Selection is name-based:
// `foo.js` selects `foo.test.js` and every `foo-*.test.js` (the repo's
// convention for satellite suites, e.g. forge-xllm.js → forge-xllm-evidence).
// Changes outside scripts/*.js select nothing — those surfaces are covered by
// forge-smoke.js, which does not fit a verification-gate timeout.
// ---------------------------------------------------------------------------

function collectChangedFiles() {
  const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot, encoding: 'utf8' });
  if (!probe || probe.status !== 0) return null;
  const files = [];
  for (const args of [
    ['diff', '--name-only', 'HEAD'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
    if (!result || result.status !== 0) return null;
    files.push(...result.stdout.split(/\r?\n/).filter(Boolean));
  }
  return files;
}

function suitesForChangedFiles(files, allSuites) {
  const selected = new Set();
  for (const rel of files) {
    const normalized = String(rel).replace(/\\/g, '/');
    if (!normalized.startsWith('scripts/')) continue;
    const base = path.posix.basename(normalized);
    if (base.endsWith('.test.js')) {
      if (allSuites.includes(base)) selected.add(base);
      continue;
    }
    if (!base.endsWith('.js')) continue;
    const stem = base.slice(0, -'.js'.length);
    for (const suite of allSuites) {
      if (suite === `${stem}.test.js` || suite.startsWith(`${stem}-`)) selected.add(suite);
    }
  }
  return [...selected].sort((a, b) => a.localeCompare(b, 'en'));
}

// The suite may never reach the real macOS `security` binary. HOME is isolated
// below, and `security` resolves the login keychain THROUGH HOME — with a temp
// HOME there is no login.keychain-db to write into, so instead of failing it
// raises a modal dialog and blocks until a human answers it. The call's timeout
// then kills it and leaves the window orphaned on the operator's screen: 249 of
// them in 3 hours, one per assertion that touched the vault. Every Keychain
// branch in forge-secrets.js / forge-accounts.js consults this variable and
// takes the 0600-file fallback instead. See scripts/forge-keychain-switch.js.
//
// Set for EVERY child, including --inherit-home: inheriting the real HOME would
// make the calls succeed rather than hang, but a test suite still has no
// business writing into the operator's real keychain.
const KEYCHAIN_DISABLED_ENV = { FORGE_KEYCHAIN_DISABLED: '1' };

function childEnv(root, filename) {
  const base = root ? isolatedEnv(root, filename) : { ...process.env };
  return { ...base, ...KEYCHAIN_DISABLED_ENV };
}

function isolatedEnv(root, filename) {
  const stem = filename.replace(/\.test\.js$/, '').replace(/[^A-Za-z0-9._-]/g, '_');
  const home = path.join(root, stem);
  const config = path.join(home, '.config');
  const roaming = path.join(home, 'AppData', 'Roaming');
  const local = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(roaming, { recursive: true });
  fs.mkdirSync(local, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    FORGE_TEST: '1',
  };
}

// ---------------------------------------------------------------------------
// Known-failures baseline (--baseline <file>)
//
// The baseline is a HUMAN, versioned list — adding an entry is a decision made
// by whoever opens the PR, never automatic. This runner only compares sets.
// The comparison is deliberately two-directional: a failing suite missing from
// the baseline is a new red and blocks, AND a baseline entry whose suite now
// passes also blocks ("remova da baseline") — a cured suite left listed is an
// inert gate, the exact pathology this repo already paid for (doctor Layer 3,
// TASK-021).
//
// resolveBaseline and compareFailures are pure (no fs, no process state) so
// forge-ci-baseline.test.js can bite them with synthetic sets without ever
// spawning the real 196-suite run. The CLI wrapper below (main +
// reportBaselineRun) owns all I/O.
// ---------------------------------------------------------------------------

const BASELINE_PLATFORMS = ['win32', 'darwin', 'linux'];

/**
 * Parse and validate a baseline document. Pure: the file's text, the current
 * platform, and the list of suite files that actually exist on disk are all
 * passed in. Returns { ok: true, entries } or { ok: false, errors } where
 * every error is a named sentence — nothing is skipped silently.
 */
function resolveBaseline({ text, platform, availableSuites }) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`baseline is not valid JSON: ${error.message}`] };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, errors: [`baseline must be a JSON object keyed by platform (${BASELINE_PLATFORMS.join('/')})`] };
  }

  const errors = [];
  for (const key of Object.keys(doc)) {
    if (key.startsWith('_')) continue; // annotation keys ("_comment", ...) are allowed
    if (!BASELINE_PLATFORMS.includes(key)) {
      errors.push(`baseline has unknown top-level key "${key}" (expected one of: ${BASELINE_PLATFORMS.join(', ')})`);
    }
  }
  if (!Object.prototype.hasOwnProperty.call(doc, platform)) {
    errors.push(`baseline has no entry set for platform "${platform}" — add "${platform}": [] explicitly`);
    return { ok: false, errors };
  }
  const rawEntries = doc[platform];
  if (!Array.isArray(rawEntries)) {
    errors.push(`baseline entry set for "${platform}" must be an array of {suite, item, reason} objects`);
    return { ok: false, errors };
  }

  const available = new Set(availableSuites);
  const seen = new Set();
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = rawEntries[index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`baseline ${platform}[${index}] must be an object with suite/item/reason`);
      continue;
    }
    const { suite, item, reason } = entry;
    if (typeof suite !== 'string' || !suite.endsWith('.test.js')) {
      errors.push(`baseline ${platform}[${index}] has an invalid "suite" (must be a *.test.js filename)`);
      continue;
    }
    if (typeof item !== 'string' || item.trim() === '') {
      errors.push(`baseline entry ${suite} is missing "item" (the backlog id tracking it)`);
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      errors.push(`baseline entry ${suite} is missing "reason"`);
    }
    if (seen.has(suite)) errors.push(`baseline lists ${suite} twice for ${platform}`);
    seen.add(suite);
    if (!available.has(suite)) {
      errors.push(`baseline entry ${suite} points at a suite file that does not exist (ghost entry — remove it or fix the name)`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    entries: rawEntries.map(entry => ({ suite: entry.suite, item: entry.item, reason: entry.reason })),
  };
}

/**
 * Compare the set F of suites that failed against the set B from the baseline.
 * Pure set arithmetic plus the anti-silence floor: a run that executed zero
 * suites is a named failure, never a clean pass — even when both sets are
 * empty. Codes: match | new-failures | stale-entries | new-and-stale |
 * no-suites-executed.
 */
function compareFailures({ executedCount, failedSuites, baselineSuites }) {
  if (!Number.isInteger(executedCount) || executedCount <= 0) {
    return { ok: false, code: 'no-suites-executed', newFailures: [], staleEntries: [], knownFailures: [] };
  }
  const failed = new Set(failedSuites);
  const baseline = new Set(baselineSuites);
  const newFailures = [...failed].filter(suite => !baseline.has(suite)).sort();
  const staleEntries = [...baseline].filter(suite => !failed.has(suite)).sort();
  const knownFailures = [...failed].filter(suite => baseline.has(suite)).sort();
  const ok = newFailures.length === 0 && staleEntries.length === 0;
  let code = 'match';
  if (newFailures.length > 0 && staleEntries.length > 0) code = 'new-and-stale';
  else if (newFailures.length > 0) code = 'new-failures';
  else if (staleEntries.length > 0) code = 'stale-entries';
  return { ok, code, newFailures, staleEntries, knownFailures };
}

/**
 * CLI half of the baseline check: prints the run summary (same shape as the
 * legacy path) plus the verdict, and returns the process exit code.
 * Exit 0 only on an exact two-way set match; 1 on mismatch; 2 on the floor.
 */
function reportBaselineRun({ executed, failures, elapsed, baselineEntries, platform }) {
  if (failures.length === 0) {
    process.stdout.write(`\nAll ${executed} suites passed in ${elapsed}s.\n`);
  } else {
    process.stderr.write(`\n${failures.length} of ${executed} executed suite${executed === 1 ? '' : 's'} failed in ${elapsed}s:\n`);
    for (const failure of failures) {
      const detail = failure.signal ? `signal ${failure.signal}` : `exit ${failure.status == null ? 'unknown' : failure.status}`;
      process.stderr.write(`  - ${failure.filename} (${detail})\n`);
    }
  }

  const verdict = compareFailures({
    executedCount: executed,
    failedSuites: failures.map(failure => failure.filename),
    baselineSuites: baselineEntries.map(entry => entry.suite),
  });
  const byName = new Map(baselineEntries.map(entry => [entry.suite, entry]));

  if (verdict.code === 'no-suites-executed') {
    process.stderr.write('\nBaseline check FAILED: 0 suites executed — an empty run is never a clean pass.\n');
    return 2;
  }
  if (verdict.ok) {
    process.stdout.write(`\nBaseline match on ${platform}: ${verdict.knownFailures.length} known failure(s), 0 new, 0 stale.\n`);
    for (const suite of verdict.knownFailures) {
      const entry = byName.get(suite);
      process.stdout.write(`  - ${suite} (${entry.item}) — ${entry.reason}\n`);
    }
    return 0;
  }
  if (verdict.newFailures.length > 0) {
    process.stderr.write(`\nBaseline check FAILED on ${platform}: ${verdict.newFailures.length} NEW failing suite${verdict.newFailures.length === 1 ? '' : 's'} not in the baseline:\n`);
    for (const suite of verdict.newFailures) process.stderr.write(`  - ${suite}\n`);
  }
  if (verdict.staleEntries.length > 0) {
    process.stderr.write(`\nBaseline check FAILED on ${platform}: ${verdict.staleEntries.length} baseline entr${verdict.staleEntries.length === 1 ? 'y' : 'ies'} whose suite now passes — remova da baseline (a cured suite left listed is an inert gate):\n`);
    for (const suite of verdict.staleEntries) {
      const entry = byName.get(suite);
      process.stderr.write(`  - ${suite} (${entry.item})\n`);
    }
  }
  return 1;
}

function writeCaptured(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) process.stderr.write(`${result.error.stack || result.error.message}\n`);
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 2;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let tests = discoverTests(options.matches);
  if (options.changed) {
    if (options.baseline) {
      process.stderr.write('--baseline requires the full suite set: it is incompatible with --changed.\n');
      return 2;
    }
    const changed = collectChangedFiles();
    if (changed === null) {
      // Loud, never a silent pass: a gate consumer must be able to tell
      // "nothing related changed" apart from "the selector could not look".
      process.stderr.write('--changed FAILED: git is unavailable or this is not a work tree — refusing to guess.\n');
      return 2;
    }
    tests = suitesForChangedFiles(changed, tests);
    if (tests.length === 0) {
      process.stdout.write(`No suites related to the ${changed.length} changed file${changed.length === 1 ? '' : 's'} — nothing to run (legitimate for docs-only changes).\n`);
      return 0;
    }
  }
  if (options.list) {
    process.stdout.write(tests.length ? `${tests.join('\n')}\n` : '');
    return 0;
  }
  if (tests.length === 0) {
    process.stderr.write('No test suites matched.\n');
    return 2;
  }

  // Baseline mode needs the full, uninterrupted set: --match shrinks F and
  // --fail-fast truncates it, which would make both comparison directions
  // unsound (a filtered-out baseline suite would read as "cured").
  let baselineEntries = null;
  if (options.baseline) {
    if (options.matches.length > 0 || options.failFast) {
      process.stderr.write('--baseline requires a full, uninterrupted run: it is incompatible with --match and --fail-fast.\n');
      return 2;
    }
    let baselineText;
    try {
      baselineText = fs.readFileSync(options.baseline, 'utf8');
    } catch (error) {
      process.stderr.write(`Baseline check FAILED: baseline file ${options.baseline} could not be read (${error.code || error.message}) — refusing to run as if no baseline existed.\n`);
      return 2;
    }
    const resolved = resolveBaseline({
      text: baselineText,
      platform: process.platform,
      availableSuites: tests,
    });
    if (!resolved.ok) {
      process.stderr.write('Baseline check FAILED: baseline is invalid — refusing to run against it:\n');
      for (const message of resolved.errors) process.stderr.write(`  - ${message}\n`);
      return 2;
    }
    baselineEntries = resolved.entries;
  }

  const isolatedRoot = options.inheritHome
    ? null
    : fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tests-'));
  const failures = [];
  let executed = 0;
  const started = Date.now();

  process.stdout.write(`Running ${tests.length} test suite${tests.length === 1 ? '' : 's'} sequentially...\n`);
  try {
    for (const filename of tests) {
      executed += 1;
      const suiteStarted = Date.now();
      const result = spawnSync(process.execPath, [path.join(scriptsDir, filename)], {
        cwd: repoRoot,
        env: childEnv(isolatedRoot, filename),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      const elapsed = ((Date.now() - suiteStarted) / 1000).toFixed(2);
      const passed = result.status === 0 && !result.error;

      process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${filename} (${elapsed}s)\n`);
      if (options.verbose || !passed) writeCaptured(result);

      if (!passed) {
        failures.push({ filename, status: result.status, signal: result.signal });
        if (options.failFast) break;
      }
    }
  } finally {
    if (isolatedRoot) fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(2);
  if (baselineEntries) {
    // All suites ran and logged exactly as in the legacy path above — the
    // baseline only decides the exit code.
    return reportBaselineRun({ executed, failures, elapsed, baselineEntries, platform: process.platform });
  }
  if (failures.length === 0) {
    process.stdout.write(`\nAll ${executed} suites passed in ${elapsed}s.\n`);
    return 0;
  }

  process.stderr.write(`\n${failures.length} of ${executed} executed suite${executed === 1 ? '' : 's'} failed in ${elapsed}s:\n`);
  for (const failure of failures) {
    const detail = failure.signal ? `signal ${failure.signal}` : `exit ${failure.status == null ? 'unknown' : failure.status}`;
    process.stderr.write(`  - ${failure.filename} (${detail})\n`);
  }
  return 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

// childEnv is exported so forge-keychain-switch.test.js can assert the Keychain
// kill-switch behaviourally — by calling it — rather than by grepping for a
// string that a refactor could move without meaning to change anything.
// resolveBaseline and compareFailures are exported as pure functions so
// forge-ci-baseline.test.js can exercise both comparison directions and the
// anti-silence floor with synthetic sets, without spawning the real runner.
module.exports = {
  childEnv,
  compareFailures,
  discoverTests,
  isolatedEnv,
  main,
  parseArgs,
  resolveBaseline,
  suitesForChangedFiles,
  BASELINE_PLATFORMS,
};
