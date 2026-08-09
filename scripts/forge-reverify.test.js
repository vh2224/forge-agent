#!/usr/bin/env node
'use strict';

// Standalone contract suite for deterministic sandbox-execution re-verification.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  needsReverification, resolveVerifyCommand, runVerification, applyVerdict, reverify, spawnPlan, resolveExecutable,
  hasDivergentCommandNotes,
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
  for (const reason of ['git-commit-required', 'out-of-scope-test-failure', 'network-required']) {
    assert(needsReverification(result([entry({ reason })])), `trigger accepts environment reason ${reason}`);
  }
  assert(!needsReverification(result([entry({ reason: 'gsd-write-refused' })])),
    'trigger excludes gsd-write-refused (not provable by command exit code)');
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

  const fallbackDir = fixture();
  const gsdDir = path.join(fallbackDir, 'external-gsd');
  fs.mkdirSync(gsdDir, { recursive: true });
  fs.writeFileSync(path.join(gsdDir, 'CODING-STANDARDS.md'), '## Lint & Format Commands\n\n- **Test:** `node scripts/forge-smoke.js` + `node scripts/*.test.js`\n', 'utf8');
  assert(JSON.stringify(resolveVerifyCommand(fallbackDir, gsdDir)) === JSON.stringify(['node', 'scripts/forge-smoke.js']),
    'CODING-STANDARDS fallback selects the first shell-safe test command');
  fs.writeFileSync(path.join(gsdDir, 'CODING-STANDARDS.md'), '## Lint & Format Commands\n\n- **Test:** (none detected)\n', 'utf8');
  assert(resolveVerifyCommand(fallbackDir, gsdDir) === null, 'none-detected CODING-STANDARDS fallback returns null');
  assert(resolveVerifyCommand(fallbackDir, path.join(fallbackDir, 'missing-gsd')) === null,
    'missing CODING-STANDARDS fallback returns null');

  const quotedDir = fixture();
  const quotedGsd = path.join(quotedDir, 'external-gsd');
  fs.mkdirSync(quotedGsd, { recursive: true });
  fs.writeFileSync(path.join(quotedGsd, 'CODING-STANDARDS.md'), '## Lint & Format Commands\n\n- **Test:** `pytest -k "test one"`\n', 'utf8');
  assert(resolveVerifyCommand(quotedDir, quotedGsd) === null,
    'quoted command that would lose meaning under space-split resolves to null instead of a broken argv');

  const priorityDir = fixture();
  write(priorityDir, 'package.json', '{"scripts":{"test":"node -e \\"0\\""}}');
  const priorityGsd = path.join(priorityDir, 'external-gsd');
  fs.mkdirSync(priorityGsd, { recursive: true });
  fs.writeFileSync(path.join(priorityGsd, 'CODING-STANDARDS.md'), '## Lint & Format Commands\n- **Test:** `make test`\n', 'utf8');
  assert(JSON.stringify(resolveVerifyCommand(priorityDir, priorityGsd)) === JSON.stringify(['npm', 'test']),
    'stack detection precedes the CODING-STANDARDS fallback');
}

// I-20260729180247-forge-init-template-nao. The CODING-STANDARDS fallback above
// only fires if the file being read actually carries the line — and `/forge-init`,
// which writes that file for every new project, emitted Lint/Format/Type check and
// no Test. Zero-dep projects (no package.json, no go.mod) are exactly the ones the
// fallback exists for, and they were initialised without it.
//
// Asserting only "the string appears in the template" would pass on a line the
// consumer cannot read, so the second half renders the template's own section
// through resolveVerifyCommand: the guard fails both when the line is deleted and
// when it is present in a shape the parser does not accept.
function testForgeInitEmitsTestLine() {
  const template = fs.readFileSync(path.join(__dirname, '..', 'commands', 'forge-init.md'), 'utf8');
  const header = template.match(/^## Lint & Format Commands[ \t]*$/m);
  assert(Boolean(header), 'forge-init.md still has a `## Lint & Format Commands` section to render');
  const section = header ? template.slice(header.index + header[0].length).split(/^## /m)[0] : '';
  assert(/^- \*\*Test:\*\*/m.test(section), 'forge-init CODING-STANDARDS template emits a `- **Test:**` line');

  const dir = fixture();
  const gsd = path.join(dir, 'external-gsd');
  fs.mkdirSync(gsd, { recursive: true });
  const rendered = `## Lint & Format Commands\n${section.replace(/\{detected test command or "\(none detected\)"\}/, 'node scripts/run-tests.js')}`;
  fs.writeFileSync(path.join(gsd, 'CODING-STANDARDS.md'), rendered, 'utf8');
  assert(JSON.stringify(resolveVerifyCommand(dir, gsd)) === JSON.stringify(['node', 'scripts/run-tests.js']),
    'a CODING-STANDARDS rendered from the forge-init template is readable by resolveVerifyCommand',
    JSON.stringify(resolveVerifyCommand(dir, gsd)));
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

  const gitRequired = result([entry({ reason: 'git-commit-required', note: 'requires `git commit` to prove' })]);
  const green = reverify({ result: gitRequired, codeDir: dir, apply: true });
  assert(green.verdict === 'verified' && gitRequired.must_haves_status[0].status === 'met'
    && gitRequired.must_haves_status[0].scope === 'task' && gitRequired.must_haves_status[0].reason === ''
    && /re-verified by orchestrator: npm test exit 0/.test(gitRequired.must_haves_status[0].note),
  'git-commit-required re-verifies green end-to-end');

  write(dir, 'package.json', '{"scripts":{"test":"node -e \\"process.exit(1)\\""}}');
  const redPayload = result([entry({ reason: 'git-commit-required', note: 'requires `git commit` to prove' })]);
  const red = reverify({ result: redPayload, codeDir: dir, apply: true });
  const { checkEnvPromotion } = require('./forge-env-promote.js');
  assert(red.verdict === 'failed' && checkEnvPromotion(redPayload, '').promote === false,
    'git-commit-required re-verifies red end-to-end and cannot promote');
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

// I-20260729180247-hasdivergentcommandnotes (TASK-020 review R1, 2026-08-06):
// a note that names no runner token at all used to be filtered out of the
// comparison instead of gating it. It must now gate a multi-entry payload
// unconditionally, while a single-entry payload with the same note is
// unaffected and still applies its normal verdict.
function testTokenlessNoteGates() {
  const dir = fixture();
  write(dir, 'package.json', '{"scripts":{"test":"node -e \\\"process.exit(0)\\\""}}');
  write(dir, 'package-lock.json', '{}');

  const mixed = result([
    entry({ note: 'ran `npm test`: EPERM: operation not permitted' }),
    entry({ note: 'blocked by the environment' }),
  ]);
  const mixedOutcome = reverify({ result: mixed, codeDir: dir, apply: true });
  assert(mixedOutcome.verdict === 'ambiguous-multi-command' && mixedOutcome.entries === 2,
    'a token-less note gates a multi-entry payload', JSON.stringify(mixedOutcome));
  assert(mixed.must_haves_status.every(e => e.scope === 'environment'),
    'ambiguous-multi-command from a token-less note leaves every entry untouched');

  const single = result([entry({ note: 'blocked by the environment' })]);
  const singleOutcome = reverify({ result: single, codeDir: dir, apply: true });
  assert(singleOutcome.verdict === 'verified',
    'a single-entry payload with a token-less note still applies the normal verdict', JSON.stringify(singleOutcome));

  assert(hasDivergentCommandNotes([entry({ note: 'blocked by the environment' })]) === false,
    'hasDivergentCommandNotes([oneEntry]) stays false — cardinality guard preserved');

  assert(typeof hasDivergentCommandNotes === 'function',
    'hasDivergentCommandNotes is exported from forge-reverify.js');
}

// TASK-020 review R1: gsd-write-refused alleges a .gsd/** write was refused —
// only fs.existsSync + content can prove that, never a project suite's exit
// code. These guards prove the trigger/promotion gate is seletive: it must
// still fire for the other environment reasons, must never fire or promote
// for gsd-write-refused alone, and must not let one reversible entry drag an
// unrelated gsd-write-refused entry along with it.
function testGsdWriteRefusedSeparation() {
  const dir = fixture();
  write(dir, 'package.json', '{"scripts":{"test":"node -e \\\"process.exit(0)\\\""}}');
  write(dir, 'package-lock.json', '{}');

  const fires = result([entry({ reason: 'sandbox-exec-blocked' })]);
  const firesOutcome = reverify({ result: fires, codeDir: dir, apply: true });
  assert(firesOutcome.verdict === 'verified' && fires.must_haves_status[0].status === 'met',
    'sandbox-exec-blocked still fires and promotes on a green suite', JSON.stringify(firesOutcome));

  const doesNotFire = result([entry({ reason: 'gsd-write-refused' })]);
  assert(!needsReverification(doesNotFire), 'gsd-write-refused alone does not trigger needsReverification');
  const notApplicable = reverify({ result: doesNotFire, codeDir: dir, apply: true });
  assert(notApplicable.verdict === 'not-applicable'
    && doesNotFire.must_haves_status[0].status !== 'met' && doesNotFire.must_haves_status[0].scope === 'environment',
  'gsd-write-refused alone is not promoted and stays environment-scoped', JSON.stringify(notApplicable));

  const mixed = result([
    entry({ reason: 'gsd-write-refused' }),
    entry({ reason: 'sandbox-exec-blocked' }),
  ]);
  const mixedOutcome = reverify({ result: mixed, codeDir: dir, apply: true });
  assert(mixedOutcome.verdict === 'verified' && mixed.must_haves_status[1].status === 'met',
    'mixed payload still fires for the reverifiable entry', JSON.stringify(mixedOutcome));
  assert(mixed.must_haves_status[0].status !== 'met' && mixed.must_haves_status[0].scope === 'environment'
    && mixed.must_haves_status[0].reason === 'gsd-write-refused',
  'mixed payload leaves the gsd-write-refused entry untouched — selective, not a blanket disable');
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
    // Asserted on the resolver itself, not on the assembled command line: the
    // line only quotes the path when it contains a space, so matching quotes
    // there would pass on a host with "Program Files" in PATH and fail on a
    // runner without it.
    const resolvedShim = resolveExecutable('npm');
    assert(/npm\.(cmd|bat)$/i.test(resolvedShim || ''),
      'PATHEXT resolution picks npm.cmd, not the extensionless POSIX sibling', String(resolvedShim));
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
  testForgeInitEmitsTestLine();
  testRunAndApply();
  testModeAndCli();
  testAmbiguousMultiCommand();
  testTokenlessNoteGates();
  testGsdWriteRefusedSeparation();
  testPlatformRouting();
} finally {
  for (const dir of fixtures) {
    if (KEEP) process.stdout.write(`  (kept ${dir})\n`);
    else fs.rmSync(dir, { recursive: true, force: true });
  }
}

process.stdout.write(`Results: ${passes} passed, ${fails} failed\n`);
process.exitCode = fails ? 1 : 0;
