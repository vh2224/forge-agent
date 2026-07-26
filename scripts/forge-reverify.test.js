#!/usr/bin/env node
'use strict';

// Standalone contract suite for deterministic sandbox-execution re-verification.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  needsReverification, resolveVerifyCommand, runVerification, applyVerdict, reverify, spawnPlan,
} = require('./forge-reverify.js');

const SCRIPT = path.join(__dirname, 'forge-reverify.js');
const KEEP = process.argv.includes('--keep');
const fixtures = [];
let passes = 0;
let fails = 0;

function assert(value, name, detail) {
  if (value) { passes += 1; process.stdout.write(`  ✓ ${name}\n`); }
  else { fails += 1; process.stdout.write(`  ✗ ${name}${detail ? `: ${detail}` : ''}\n`); }
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-reverify-'));
  fixtures.push(dir);
  return dir;
}

function entry(overrides) {
  return { item: 'blocked test', status: 'unmet', note: 'npm test: EPERM', scope: 'environment', reason: 'sandbox-exec-blocked', ...overrides };
}

function result(entries) {
  return { status: 'partial', summary: 'fixture', files_changed: [], must_haves_status: entries };
}

function write(dir, file, text) {
  fs.writeFileSync(path.join(dir, file), text, 'utf8');
}

function testTrigger() {
  assert(needsReverification(result([entry()])), 'trigger accepts unmet environment sandbox-exec-blocked');
  assert(needsReverification(result([entry({ status: 'unknown' })])), 'trigger accepts unknown environment sandbox-exec-blocked');
  for (const reason of ['git-commit-required', 'gsd-write-refused', 'out-of-scope-test-failure', 'network-required']) {
    assert(!needsReverification(result([entry({ reason })])), `trigger ignores legacy reason ${reason}`);
  }
  assert(!needsReverification(result([entry({ status: 'met' })])), 'trigger ignores met entry');
  assert(!needsReverification(result([entry({ scope: 'task' })])), 'trigger ignores task-scope entry');
}

function testResolution() {
  const cases = [
    ['node', dir => { write(dir, 'package.json', '{"scripts":{"test":"node -e \\\"0\\\""}}'); write(dir, 'package-lock.json', '{}'); }, ['npm', 'test']],
    ['go', dir => write(dir, 'go.mod', 'module example.com/test\n'), ['go', 'test', './...']],
    ['cargo', dir => write(dir, 'Cargo.toml', '[package]\nname="x"\n'), ['cargo', 'test']],
    ['pytest', dir => write(dir, 'pytest.ini', '[pytest]\n'), ['pytest', '-q']],
    ['make', dir => write(dir, 'Makefile', 'test:\n\t@true\n'), ['make', 'test']],
  ];
  for (const [name, setup, expected] of cases) {
    const dir = fixture();
    setup(dir);
    assert(JSON.stringify(resolveVerifyCommand(dir)) === JSON.stringify(expected), `resolves ${name} verification command`);
  }
  assert(resolveVerifyCommand(fixture()) === null, 'returns null when no project verification command exists');
}

function testRunAndApply() {
  const cwd = fixture();
  assert(runVerification({ argv: [process.execPath, '-e', 'process.exit(0)'], codeDir: cwd }).verdict === 'verified', 'runVerification reports verified');
  assert(runVerification({ argv: [process.execPath, '-e', 'process.exit(1)'], codeDir: cwd }).verdict === 'failed', 'runVerification reports failed');
  assert(runVerification({ argv: ['forge-no-such-binary-xyz'], codeDir: cwd }).verdict === 'no-command', 'missing runner reports no-command');

  const verified = result([entry()]);
  applyVerdict(verified, { verdict: 'verified', command: 'npm test', exit_code: 0 });
  assert(verified.must_haves_status[0].status === 'met' && verified.must_haves_status[0].scope === 'task'
    && verified.must_haves_status[0].reason === '' && /re-verified by orchestrator/.test(verified.must_haves_status[0].note),
  'verified verdict flips status, scope, reason and appends evidence');
  const failed = result([entry()]);
  applyVerdict(failed, { verdict: 'failed', command: 'npm test', exit_code: 1, tail: 'failed assertion' });
  assert(failed.must_haves_status[0].status === 'unmet' && failed.must_haves_status[0].scope === 'task'
    && failed.must_haves_status[0].reason === '' && /failed assertion/.test(failed.must_haves_status[0].note),
  'failed verdict preserves unmet but flips scope and reason');
  const untouched = result([entry()]);
  applyVerdict(untouched, { verdict: 'no-command', command: '', exit_code: null });
  assert(untouched.must_haves_status[0].scope === 'environment', 'no-command leaves payload untouched');
}

function testModeAndCli() {
  const dir = fixture();
  write(dir, 'package.json', '{"scripts":{"test":"node -e \\\"process.exit(0)\\\""}}');
  write(dir, 'package-lock.json', '{}');
  const disabled = result([entry()]);
  assert(reverify({ result: disabled, codeDir: dir, mode: 'off', apply: true }).verdict === 'disabled'
    && disabled.must_haves_status[0].scope === 'environment', 'mode off is disabled and leaves payload untouched');

  const resultPath = path.join(dir, 'result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result([entry()])), 'utf8');
  const run = spawnSync(process.execPath, [SCRIPT, '--result', resultPath, '--code-dir', dir, '--apply', '--json'], { encoding: 'utf8' });
  let output = null;
  try { output = JSON.parse(run.stdout); } catch {}
  const rewritten = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert(run.status === 0 && output && output.verdict === 'verified' && rewritten.must_haves_status[0].status === 'met'
    && rewritten.must_haves_status[0].scope === 'task' && rewritten.must_haves_status[0].reason === '',
  'CLI --apply writes a parseable verified result deterministically', run.stderr);
}

function testAmbiguousMultiCommand() {
  const dir = fixture();
  write(dir, 'package.json', '{"scripts":{"test":"node -e \\\"process.exit(0)\\\""}}');
  write(dir, 'package-lock.json', '{}');

  const divergent = result([
    entry({ note: 'ran `npm test`: EPERM: operation not permitted' }),
    entry({ note: 'ran `make lint`: EACCES: permission denied' }),
  ]);
  const divergentOutcome = reverify({ result: divergent, codeDir: dir, apply: true });
  assert(divergentOutcome.verdict === 'ambiguous-multi-command' && divergentOutcome.entries === 2,
    'entries naming different commands refuse blanket apply', JSON.stringify(divergentOutcome));
  assert(divergent.must_haves_status.every(e => e.scope === 'environment'),
    'ambiguous-multi-command leaves every entry untouched');

  const single = result([entry({ note: 'ran `npm test`: EPERM: operation not permitted' })]);
  const singleOutcome = reverify({ result: single, codeDir: dir, apply: true });
  assert(singleOutcome.verdict === 'verified', 'a single entry still applies normally', JSON.stringify(singleOutcome));

  const sameCommand = result([
    entry({ note: 'ran `npm test`: EPERM: operation not permitted' }),
    entry({ note: 'ran `npm test` again: EACCES: permission denied' }),
  ]);
  const sameCommandOutcome = reverify({ result: sameCommand, codeDir: dir, apply: true });
  assert(sameCommandOutcome.verdict === 'verified',
    'entries naming the same command still promote in bulk', JSON.stringify(sameCommandOutcome));
}

// Regression guard: npm/pnpm/yarn are `.cmd` shims on Windows, which
// spawnSync cannot execute directly (EINVAL since the CVE-2024-27980
// mitigation). The whole re-verification gate was inert on that platform —
// every project command came back no-command with exit_code null. These
// assertions are platform-aware where the routing differs and behavioural
// where it must not.
function testPlatformRouting() {
  const windows = process.platform === 'win32';

  const direct = spawnPlan([process.execPath, '-e', 'process.exit(0)']);
  assert(direct && direct.file === process.execPath && !direct.options.windowsVerbatimArguments,
    'a real executable is spawned directly, never through an interpreter', JSON.stringify(direct));

  const missing = spawnPlan(['forge-no-such-binary-xyz']);
  assert(windows ? missing === null : missing.file === 'forge-no-such-binary-xyz',
    'an unresolvable command is refused before spawning on Windows', JSON.stringify(missing));

  if (windows) {
    const shim = spawnPlan(['npm', 'test']);
    assert(shim && /cmd\.exe$/i.test(shim.file) && shim.args[0] === '/d'
      && shim.options.windowsVerbatimArguments === true,
    'a .cmd shim is routed through ComSpec with verbatim arguments', JSON.stringify(shim));
    // The line is `"<quoted shim path> <args>"` — cmd /s strips that outer pair
    // and runs the rest verbatim, which is why the path may itself be quoted.
    assert(shim && /npm\.(cmd|bat)"/i.test(shim.args[3]),
      'PATHEXT resolution picks npm.cmd, not the extensionless POSIX sibling', JSON.stringify(shim && shim.args));
  }

  // Behavioural, every platform: the project's exit code must survive the
  // routing. A mangled command line makes cmd report 0 for a failing suite —
  // that would promote a red test run to `verified`.
  const passing = fixture();
  write(passing, 'package.json', '{"scripts":{"test":"node -e \\\"process.exit(0)\\\""}}');
  write(passing, 'package-lock.json', '{}');
  const green = runVerification({ argv: resolveVerifyCommand(passing), codeDir: passing });
  assert(green.verdict === 'verified' && green.exit_code === 0,
    'the project command runs and a green suite verifies', JSON.stringify(green));

  const failing = fixture();
  write(failing, 'package.json', '{"scripts":{"test":"node -e \\\"process.exit(1)\\\""}}');
  write(failing, 'package-lock.json', '{}');
  const red = runVerification({ argv: resolveVerifyCommand(failing), codeDir: failing });
  assert(red.verdict === 'failed' && red.exit_code === 1,
    'a red suite reports failed with its real exit code, never verified', JSON.stringify(red));
}

try {
  testTrigger();
  testResolution();
  testRunAndApply();
  testModeAndCli();
  testAmbiguousMultiCommand();
  testPlatformRouting();
} finally {
  for (const dir of fixtures) {
    if (KEEP) process.stdout.write(`  (kept ${dir})\n`);
    else fs.rmSync(dir, { recursive: true, force: true });
  }
}

process.stdout.write(`Results: ${passes} passed, ${fails} failed\n`);
process.exitCode = fails ? 1 : 0;
