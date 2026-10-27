#!/usr/bin/env node
// forge-verify.test.js — standalone test suite for forge-verify.js
//
// Focus: parsePlanVerify() — the plan-frontmatter `verify:` extractor.
//
// Regression (the bug this suite was born from): a multi-line YAML list
//   verify:
//     - npm test
//     - npm run lint
// was mis-parsed by /^verify:\s*(.+)$/m because \s matches \n — the single-line
// regex spanned the newline and captured "- npm test" as a plain string. The
// multi-line branch was never reached, producing a literal "- npm test" command
// and spurious passed:false. Fixed by anchoring the trailing whitespace to
// [ \t]* so the single-line pattern can't cross into the list.
//
// Run: node scripts/forge-verify.test.js   (exit 0 = all pass)

'use strict';

const { parsePlanVerify } = require('./forge-verify.js');

// ── Test runner boilerplate (mirrors forge-verifier.test.js) ──────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'not equal'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function fm(body) {
  return `---\n${body}\n---\nbody text\n`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('parsePlanVerify — multi-line YAML list (regression)');

test('multi-line list joins items with " && " (does not capture "- item")', () => {
  const content = fm('id: T01\nverify:\n  - npm test\n  - npm run lint');
  assertEqual(parsePlanVerify(content), 'npm test && npm run lint', 'multi-line list');
});

test('multi-line list with a single item', () => {
  const content = fm('verify:\n  - npm test');
  assertEqual(parsePlanVerify(content), 'npm test', 'single-item list');
});

test('multi-line quoted commands remove YAML delimiters before execution', () => {
  for (const quote of ['"', "'"]) {
    const content = fm(`verify:\n  - ${quote}node check.cjs${quote}\n  - ${quote}npm test${quote}`);
    assertEqual(parsePlanVerify(content), 'node check.cjs && npm test', 'quoted list');
  }
});

test('multi-line YAML delimiters preserve shell argument quoting', () => {
  const command = 'node -e "process.exit(0)"';
  assertEqual(parsePlanVerify(fm(`verify:\n  - '${command}'`)), command, 'inner shell quotes');
  assertEqual(parsePlanVerify(fm(`verify:\n  - ${command}`)), command, 'unquoted YAML with shell argument quotes');
  const executable = '"node" check.cjs';
  assertEqual(parsePlanVerify(fm(`verify:\n  - ${executable}`)), executable, 'quoted executable is not a quoted YAML scalar');
});

test('multi-line list does not leak the leading dash', () => {
  const content = fm('verify:\n  - npm test');
  assert(!parsePlanVerify(content).includes('- '), 'result must not contain a literal "- "');
});

test('multi-line list with trailing spaces after "verify:"', () => {
  const content = fm('verify:  \n  - npm test\n  - tsc --noEmit');
  assertEqual(parsePlanVerify(content), 'npm test && tsc --noEmit', 'trailing-space verify:');
});

test('verify: list with another key following it', () => {
  const content = fm('verify:\n  - npm test\n  - npm run lint\ntag: docs');
  assertEqual(parsePlanVerify(content), 'npm test && npm run lint', 'list bounded by next key');
});

console.log('parsePlanVerify — plain string');

test('plain string value', () => {
  assertEqual(parsePlanVerify(fm('verify: npm test')), 'npm test', 'plain string');
});

test('quoted string value is unquoted', () => {
  assertEqual(parsePlanVerify(fm('verify: "npm test"')), 'npm test', 'double-quoted');
  assertEqual(parsePlanVerify(fm("verify: 'npm test'")), 'npm test', 'single-quoted');
});

console.log('parsePlanVerify — inline array');

test('inline array joins with " && "', () => {
  assertEqual(parsePlanVerify(fm('verify: [npm test, npm run lint]')), 'npm test && npm run lint', 'inline array');
});

test('inline array strips quotes from items', () => {
  assertEqual(parsePlanVerify(fm('verify: ["npm test", "npm run lint"]')), 'npm test && npm run lint', 'quoted inline array');
});

console.log('parsePlanVerify — absent / edge cases');

test('no frontmatter → null', () => {
  assertEqual(parsePlanVerify('just a body, no frontmatter\n'), null, 'no frontmatter');
});

test('frontmatter without verify: → null', () => {
  assertEqual(parsePlanVerify(fm('id: T01\ntag: docs')), null, 'no verify field');
});

test('block scalar (verify: |) is skipped → null', () => {
  assertEqual(parsePlanVerify(fm('verify: |\n  npm test')), null, 'block scalar skipped');
});

console.log('parsePlanVerify — CRLF / CR-only normalization (T-20260811190103)');

function toCRLF(s) { return s.replace(/\n/g, '\r\n'); }
function toCROnly(s) { return s.replace(/\n/g, '\r'); }

const SHAPES = {
  'single-line': fm('verify: npm test'),
  'inline array': fm('verify: [npm test, npm run lint]'),
  'multi-line list': fm('verify:\n  - npm test\n  - npm run lint'),
};

for (const [label, lfContent] of Object.entries(SHAPES)) {
  const expected = parsePlanVerify(lfContent);

  test(`CRLF: ${label} returns the same value as LF`, () => {
    assertEqual(parsePlanVerify(toCRLF(lfContent)), expected, `${label} under CRLF`);
  });

  test(`CR-only: ${label} returns the same value as LF`, () => {
    assertEqual(parsePlanVerify(toCROnly(lfContent)), expected, `${label} under CR-only`);
  });

  test(`BOM+LF: ${label} returns the same value as LF`, () => {
    assertEqual(parsePlanVerify('\uFEFF' + lfContent), expected, `${label} under BOM+LF`);
  });

  test(`BOM+CRLF: ${label} returns the same value as LF`, () => {
    assertEqual(parsePlanVerify('\uFEFF' + toCRLF(lfContent)), expected, `${label} under BOM+CRLF`);
  });
}

test('CRLF: multi-line list join has no residual \\r in any item', () => {
  const result = parsePlanVerify(toCRLF(SHAPES['multi-line list']));
  assert(!result.includes('\r'), `residual \\r left in: ${JSON.stringify(result)}`);
  assertEqual(result, 'npm test && npm run lint', 'CRLF multi-line list value');
});

// ── discoverCommands: stack-probe fallback (step 4) ──────────────────────────
//
// Regression: the gate ran 133/133 times with commands:[] + skipped:"no-stack"
// in a repo carrying 200+ test suites, because discovery stopped at the
// package.json allow-list. Step 4 reuses forge-reverify's resolveVerifyCommand
// (Makefile test target, go/cargo/pytest, CODING-STANDARDS.md § Test).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { discoverCommands } = require('./forge-verify.js');

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-verify-discover-'));
}

test('stack-probe: Makefile test target is discovered when package.json is absent', () => {
  const cwd = tmpRepo();
  fs.writeFileSync(path.join(cwd, 'Makefile'), 'test:\n\ttrue\n');
  const r = discoverCommands({ cwd });
  assertEqual(r.source, 'stack-probe', 'source is stack-probe');
  assertEqual(r.commands.join(' && '), 'make test', 'Makefile test target becomes the command');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('stack-probe: CODING-STANDARDS § Test line is discovered through gsdDir', () => {
  const cwd = tmpRepo();
  const gsdDir = path.join(cwd, 'elsewhere', '.gsd');
  fs.mkdirSync(gsdDir, { recursive: true });
  fs.writeFileSync(path.join(gsdDir, 'CODING-STANDARDS.md'),
    '## Lint & Format Commands\n\n- **Test:** `node scripts/run-tests.js`\n');
  const r = discoverCommands({ cwd, gsdDir });
  assertEqual(r.source, 'stack-probe', 'source is stack-probe via gsdDir');
  assertEqual(r.commands.join(' && '), 'node scripts/run-tests.js', 'standards Test line becomes the command');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('stack-probe never outranks the package.json allow-list', () => {
  const cwd = tmpRepo();
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node t.js' } }));
  fs.writeFileSync(path.join(cwd, 'Makefile'), 'test:\n\ttrue\n');
  const r = discoverCommands({ cwd });
  assertEqual(r.source, 'package-json', 'package.json still wins over the probe');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('genuinely empty repo still degrades to source none', () => {
  const cwd = tmpRepo();
  const r = discoverCommands({ cwd });
  assertEqual(r.source, 'none', 'no signals anywhere stays none');
  assertEqual(r.commands.length, 0, 'no commands fabricated');
  fs.rmSync(cwd, { recursive: true, force: true });
});

// ── buildVerificationEvidence / formatEvidenceYaml ───────────────────────────
//
// The verification_evidence block used to be hand-derived by the worker
// (exit codes recalled from conversation, matched_line from a manual grep).
// The gate now emits the finished block; these cases prove the derivation is
// mechanical and mirrors the completer's classifier semantics.

const { buildVerificationEvidence, formatEvidenceYaml } = require('./forge-verify.js');
const { buildEvidenceFileName } = require('./forge-evidence-path.js');

test('evidence entries copy checks[] and locate the command in the resolved log set', () => {
  const ownerRoot = tmpRepo();
  const forgeDir = path.join(ownerRoot, '.gsd', 'forge');
  fs.mkdirSync(forgeDir, { recursive: true });
  const name = buildEvidenceFileName({ milestone: 'M001', slice: 'S01', unit: 'T01' });
  fs.writeFileSync(path.join(forgeDir, name),
    JSON.stringify({ tool: 'Bash', cmd: 'echo warmup' }) + '\n'
    + JSON.stringify({ tool: 'Bash', cmd: 'npm test -- --run' }) + '\n');
  const out = buildVerificationEvidence({
    checks: [
      { command: 'npm test', exitCode: 0 },
      { command: 'cargo build', exitCode: 1 },
    ],
    ownerRoot, milestone: 'M001', slice: 'S01', unit: 'T01',
  });
  assertEqual(out.entries.length, 2, 'one entry per check');
  assertEqual(out.entries[0].exit_code, 0, 'exit_code copied from checks[]');
  assertEqual(out.entries[0].matched_line, 2, 'first cmd-field hit, 1-indexed');
  assertEqual(out.entries[0].evidence_file, name, 'hit names its file');
  assertEqual(out.entries[1].matched_line, 0, 'command absent from the log is the 0 sentinel');
  assertEqual(out.entries[1].evidence_file, name, 'the 0 sentinel still names the last file checked');
  fs.rmSync(ownerRoot, { recursive: true, force: true });
});

test('empty resolved set yields verification_evidence: [] (evidence_log_missing trigger intact)', () => {
  const ownerRoot = tmpRepo();
  fs.mkdirSync(path.join(ownerRoot, '.gsd', 'forge'), { recursive: true });
  const out = buildVerificationEvidence({
    checks: [{ command: 'npm test', exitCode: 0 }],
    ownerRoot, milestone: 'M001', slice: 'S01', unit: 'T01',
  });
  assertEqual(out.entries.length, 0, 'no fabricated entries without a resolved set');
  assertEqual(formatEvidenceYaml(out.entries), 'verification_evidence: []', 'empty set renders the [] form');
  fs.rmSync(ownerRoot, { recursive: true, force: true });
});

test('formatEvidenceYaml applies the command string rules (single line, ≤180, double-quoted)', () => {
  const yaml = formatEvidenceYaml([{
    command: 'npm test \n  -- --grep ' + 'x'.repeat(300),
    exit_code: 0, matched_line: 3, evidence_file: 'evidence~M001~S01~T01.jsonl',
  }]);
  const commandLine = yaml.split('\n')[1];
  assert(!commandLine.includes('\\n') || !/\n/.test(JSON.parse(commandLine.replace(/^\s*- command: /, ''))),
    'no raw newlines survive in the command value');
  assert(JSON.parse(commandLine.replace(/^\s*- command: /, '')).length <= 180, 'command capped at 180 chars');
  assert(/^\s{2}- command: "/.test(commandLine), 'command is double-quoted YAML');
  assert(yaml.includes('    exit_code: 0') && yaml.includes('    matched_line: 3'), 'fields present');
});

// ── resolveVerifyPolicy / --mode off ─────────────────────────────────────────
//
// verify.mode exists because per-task tests can blow memory on a tight machine
// and the operator may choose not to pay them — but "off" must be an explicit,
// visible choice (skipped:"disabled-by-pref"), never a silent pass and never a
// fallthrough default.

const { resolveVerifyPolicy } = require('./forge-verify.js');
const { spawnSync: spawnVerify } = require('child_process');

test('policy precedence: CLI flag beats the run-scoped decision file', () => {
  const cwd = tmpRepo();
  const gsdDir = path.join(cwd, '.gsd');
  fs.mkdirSync(path.join(gsdDir, 'forge'), { recursive: true });
  fs.writeFileSync(path.join(gsdDir, 'forge', 'verify-mode.json'), JSON.stringify({ mode: 'off' }));
  const p = resolveVerifyPolicy({ cliMode: 'auto', gsdDir, cwd });
  assertEqual(p.mode, 'auto', 'CLI wins over run-file');
  assertEqual(p.source, 'cli', 'source names the CLI');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('policy: run-scoped file (activation ask) decides when no flag is passed', () => {
  const cwd = tmpRepo();
  const gsdDir = path.join(cwd, '.gsd');
  fs.mkdirSync(path.join(gsdDir, 'forge'), { recursive: true });
  fs.writeFileSync(path.join(gsdDir, 'forge', 'verify-mode.json'), JSON.stringify({ mode: 'off', run: 'M-test' }));
  const p = resolveVerifyPolicy({ gsdDir, cwd });
  assertEqual(p.mode, 'off', 'run-file decision applies');
  assertEqual(p.source, 'run-file', 'source names the run file');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('policy: nothing configured defaults to auto, never to off', () => {
  const cwd = tmpRepo();
  const p = resolveVerifyPolicy({ cwd });
  assertEqual(p.mode, 'auto', 'default is auto');
  assert(p.timeoutMs >= 1, 'a timeout is always resolved');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CLI --mode off executes nothing and reports disabled-by-pref, even with a runnable stack', () => {
  const cwd = tmpRepo();
  fs.mkdirSync(path.join(cwd, '.gsd', 'forge'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'Makefile'), 'test:\n\tfalse\n'); // would FAIL if it ran
  const r = spawnVerify(process.execPath, [path.join(__dirname, 'forge-verify.js'),
    '--cwd', cwd, '--unit', 'execute-task/T01', '--gsd-dir', path.join(cwd, '.gsd'), '--mode', 'off'],
  { encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  assertEqual(r.status, 0, 'off exits 0');
  assertEqual(j.skipped, 'disabled-by-pref', 'skip reason names the operator choice');
  assertEqual(j.discoverySource, 'policy-off', 'discovery source is policy-off');
  assertEqual(j.checks.length, 0, 'zero commands ran — the failing Makefile proves nothing executed');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CLI rejects an invalid --mode loudly', () => {
  const r = spawnVerify(process.execPath, [path.join(__dirname, 'forge-verify.js'), '--mode', 'maybe'], { encoding: 'utf8' });
  assertEqual(r.status, 2, 'invalid mode is exit 2, never a silent default');
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log('');
test('v2 root verification executes every cwd and refuses one failing root or missing output', () => {
  const strict = require('assert'), fixture = require('./forge-code-roots.test'), f = fixture.fixture();
  const api = require('./forge-verify');
  const base = { unit: { type: 'task', id: 'T-roots' }, commandsByRoot: { alpha: ['node -e "process.exit(0)"'], beta: ['node -e "process.exit(7)"'] } };
  const failed = api.captureRootDelivery(f.contract, fixture.plan(f.contract), base);
  strict.strictEqual(failed.passed, false); strict.strictEqual(failed.gate.roots[1].result.checks[0].exitCode, 7);
  strict.deepStrictEqual(failed.gate.roots.map(row => row.code_dir), f.contract.code_roots.map(row => row.path));
  base.commandsByRoot.beta = base.commandsByRoot.alpha;
  strict.strictEqual(api.captureRootDelivery(f.contract, fixture.plan(f.contract), base).passed, true);
  fs.unlinkSync(require('path').join(f.b, 'same.txt'));
  const missing = api.captureRootDelivery(f.contract, fixture.plan(f.contract), base);
  strict.strictEqual(missing.passed, false); strict.strictEqual(missing.artifacts[1].result.missing[0].path, 'beta::same.txt');
  strict.strictEqual(fs.existsSync(require('path').join(f.b, '.gsd')), false); f.cleanup();
});

test('quoted multiline plan command and declared supplement seal as one command per root', () => {
  const strict = require('assert'), lab = require('./forge-code-roots.test'), f = lab.fixture();
  try {
    const plan = lab.plan(f.contract).replace('must_haves:', 'verify:\n  - "node check.cjs"\nmust_haves:');
    const seal = require('./forge-verify').normalizeExecutionVerification(f.contract, plan,
      { commandsByRoot: { alpha: ['node check.cjs'], beta: ['node check.cjs'] } });
    strict.deepStrictEqual(seal.roots.map(row => row.commands), [['node check.cjs'], ['node check.cjs']]);
  } finally { f.cleanup(); }
});

test('single-root legacy capture normalizes artifacts and still detects missing outputs', () => {
  const strict = require('assert'), lab = require('./forge-code-roots.test'), f = lab.fixture();
  const contract = { ...f.contract, code_roots: [f.contract.code_roots[0]] };
  const planText = lab.plan(f.contract).replace(/^roots_schema:.*\n/m, '').replace(/beta::same.txt/g, 'same.txt').replace(/alpha::same.txt/g, 'same.txt');
  const options = { unit: { type: 'task', id: 'T-legacy' }, commandsByRoot: { alpha: ['node -e "process.exit(0)"'] } };
  try {
    const captured = require('./forge-verify').captureRootDelivery(contract, planText, options);
    strict.strictEqual(captured.passed, true);
    strict(captured.artifacts[0].result.rows.every(row => row.path === 'alpha::same.txt'));
    fs.unlinkSync(path.join(f.a, 'same.txt'));
    strict.strictEqual(require('./forge-verify').captureRootDelivery(contract, planText, options).passed, false);
  } finally { f.cleanup(); }
});

test('resource telemetry uses the caller sink without unsigned owner writes', () => {
  const strict = require('assert'), api = require('./forge-verify');
  const cwd = tmpRepo(), gsdDir = path.join(cwd, '.gsd'), events = path.join(gsdDir, 'forge/events.jsonl');
  const lines = [];
  const options = { cwd, gsdDir, preferenceCommands: ['node -e "process.exit(0)"'],
    resourceEventSink: line => lines.push(line) };
  try {
    strict.strictEqual(api.runVerificationGate(options).passed, true);
    strict.strictEqual(lines.length, 1);
    strict.strictEqual(JSON.parse(lines[0]).kind, 'resource-clamp-skipped');
    strict(lines[0].endsWith('\n'));
    strict.strictEqual(fs.existsSync(events), false, 'caller alone owns publication of event bytes');
    strict.strictEqual(api.runVerificationGate({ ...options, resourceEventSink() { throw new Error('sink-unavailable'); } }).passed, true);
    strict.strictEqual(fs.existsSync(events), false, 'sink failure never falls back to an unsigned write');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('verification validates mandatory modules before commands and no-stack skips', () => {
  const strict = require('assert'), api = require('./forge-verify');
  const cwd = tmpRepo(); fs.mkdirSync(path.join(cwd, 'shared'));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../shared/forge-procedures.json'), 'utf8'));
  const module = manifest.modules.find(row => row.id === 'verification');
  for (const row of manifest.modules.filter(row => row.status === 'ready')) fs.copyFileSync(path.join(__dirname, '..', row.path), path.join(cwd, row.path));
  const file = path.join(cwd, 'shared/forge-procedures.json');
  const options = { cwd, gsdDir: path.join(cwd, '.gsd'), preferenceCommands: ['node -e "process.exit(0)"'], resourceEventSink() {} };
  try {
    fs.writeFileSync(file, JSON.stringify(manifest));
    const result = api.runVerificationGate(options);
    strict.strictEqual(result.passed, true);
    strict.deepStrictEqual(result.procedure_context.modules.map(row => row.id), ['core', 'verification']);
    strict.strictEqual(result.procedure_context.modules[1].sha256, module.sha256);
    strict.strictEqual(api.runVerificationGate({ ...options, preferenceCommands: [] }).skipped, 'no-stack');
    for (const attack of ['pending', 'missing', 'hash']) {
      const target = path.join(cwd, module.path), bytes = fs.readFileSync(target);
      if (attack === 'pending') { const changed = structuredClone(manifest); changed.modules.find(row => row.id === 'verification').status = 'pending'; fs.writeFileSync(file, JSON.stringify(changed)); }
      else if (attack === 'missing') fs.unlinkSync(target);
      else fs.appendFileSync(target, '\ntampered');
      strict.throws(() => api.runVerificationGate(options), /procedure/i);
      strict.throws(() => api.runVerificationGate({ ...options, preferenceCommands: [] }), /procedure/i);
      fs.writeFileSync(target, bytes); fs.writeFileSync(file, JSON.stringify(manifest));
    }
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
