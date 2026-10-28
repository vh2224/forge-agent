#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha256, canonical } = require('./forge-delivery');
const bounded = require('./forge-autonomy-sources');
const capabilities = require('./forge-capabilities');
// Count real calls, rather than treating import text as proof of wiring.
const originalRead = bounded.readBoundedStableFile;
const originalCompare = capabilities.compareVersion;
let reads = 0; let comparisons = 0;
bounded.readBoundedStableFile = (...args) => { reads++; return originalRead(...args); };
capabilities.compareVersion = (...args) => { comparisons++; return originalCompare(...args); };
const { validateBaseline, compareHostVersion, main } = require('./forge-host-baseline');
const REPO = path.resolve(__dirname, '..');
const BASE = 'docs/host-compatibility-baseline.json';
const IMPORT = 'docs/host-compatibility-import.json';
const CLI = path.join(__dirname, 'forge-host-baseline.js');
const readJson = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
function write(root, file, value) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2));
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-host-baseline-'));
  const baseline = readJson(REPO, BASE);
  const evidence = readJson(REPO, baseline.evidence);
  const imported = readJson(REPO, IMPORT);
  const files = new Set([BASE, baseline.report, baseline.evidence, IMPORT,
    ...imported.files.map((row) => row.file), ...evidence.inspected_source_fingerprints.map((row) => row.file)]);
  for (const file of files) write(root, file, fs.readFileSync(path.join(REPO, file)));
  return root;
}
// Mutations of test *inputs* deliberately update their provenance, avoiding an
// unrelated hash mismatch when a test targets version/source/finding semantics.
function repack(root, mutateBaseline = () => {}, mutateEvidence = () => {}) {
  const baseline = readJson(root, BASE);
  mutateBaseline(baseline);
  write(root, BASE, baseline);
  const evidence = readJson(root, baseline.evidence);
  mutateEvidence(evidence);
  for (const row of evidence.artifacts) row.sha256 = sha256(fs.readFileSync(path.join(root, row.file)));
  write(root, baseline.evidence, evidence);
  const imported = readJson(root, IMPORT);
  for (const row of imported.files) {
    if (row.edited_after_import) continue;
    row.source_sha256 = row.imported_sha256 = sha256(fs.readFileSync(path.join(root, row.file)));
  }
  write(root, IMPORT, imported);
}
function cli(root, args = []) {
  return spawnSync(process.execPath, [CLI, '--check', '--cwd', root, '--json', ...args], { encoding: 'utf8', timeout: 10000 });
}
function snapshot(root) {
  const result = {};
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(target);
      else result[path.relative(root, target)] = sha256(fs.readFileSync(target));
    }
  }
  visit(root);
  return result;
}
let passed = 0;
function test(name, run) {
  const root = fixture();
  try { run(root); passed++; console.log(`PASS ${name}`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function hasIssue(report, code) {
  assert(report.issues.some((issue) => issue.startsWith(`${code}:`)), JSON.stringify(report.issues));
  assert.strictEqual(report.ok, false);
}

test('C01 real import: three artifacts match, runtime changed-after-import, all source hashes exposed', (root) => {
  const result = cli(root);
  assert.strictEqual(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const baseline = readJson(root, BASE);
  assert.strictEqual(report.ok, true);
  assert.strictEqual(report.import_record, 'present');
  for (const file of [BASE, baseline.report, baseline.evidence]) {
    const row = report.artifacts.find((entry) => entry.file === file);
    assert.strictEqual(row.status, 'match');
    assert.strictEqual(row.current_sha256, sha256(fs.readFileSync(path.join(root, file))));
  }
  assert.strictEqual(report.artifacts.find((row) => row.file === 'docs/runtime-compatibility.md').status, 'changed-after-import');
  assert.strictEqual(report.sources.length, readJson(root, baseline.evidence).inspected_source_fingerprints.length);
  for (const row of report.sources) {
    assert.match(row.recorded_sha256, /^[a-f0-9]{64}$/);
    assert.match(row.current_sha256, /^[a-f0-9]{64}$/);
    assert(['changed', 'unchanged'].includes(row.status));
  }
});
test('C01 versions: newer exact interval and same require revalidation for both hosts', (root) => {
  for (const [host, flag, same, newer] of [['codex', '--codex-version', '0.165.0', '0.166.0'], ['claude', '--claude-version', '2.1.312', '2.1.313']]) {
    const result = cli(root, [flag, newer]);
    assert.strictEqual(result.status, 0);
    const row = JSON.parse(result.stdout).hosts[host];
    assert.strictEqual(row.relation, 'newer');
    assert.strictEqual(row.observed_source, 'flag');
    assert.deepStrictEqual(row.next_range, { after_exclusive: same, through_inclusive: newer });
    const equal = JSON.parse(cli(root, [flag, same]).stdout).hosts[host];
    assert.strictEqual(equal.relation, 'same');
    assert.strictEqual(equal.revalidation_required, true);
    assert.strictEqual(equal.next_range, null);
  }
  assert.strictEqual(compareHostVersion('0.165.0', '0.164.0').relation, 'older');
  assert.strictEqual(compareHostVersion('invalid', '0.166.0').relation, 'unknown');
});
test('C01 unknown versions and UI stay unknown without inferred build', (root) => {
  const report = validateBaseline({ cwd: root });
  for (const host of ['codex', 'claude']) {
    assert.strictEqual(report.hosts[host].relation, 'unknown');
    assert.strictEqual(report.hosts[host].observed_source, 'none');
  }
  const observed = validateBaseline({ cwd: root, observed: { codex: '0.166.0', claude: '2.1.313' } });
  assert.deepStrictEqual(observed.ui, { installed_build: null, range_closed: false, state: 'unknown' });
});
test('C01 sources: changed and missing named, unchanged retained, revalidation without errors', (root) => {
  const baseline = readJson(root, BASE);
  const rows = readJson(root, baseline.evidence).inspected_source_fingerprints;
  repack(root, undefined, (evidence) => {
    for (const row of evidence.inspected_source_fingerprints) row.sha256 = sha256(fs.readFileSync(path.join(root, row.file)));
  });
  fs.appendFileSync(path.join(root, rows[0].file), '\nchanged');
  fs.unlinkSync(path.join(root, rows[1].file));
  const report = validateBaseline({ cwd: root });
  assert.strictEqual(report.ok, true);
  for (const [index, status] of [[0, 'changed'], [1, 'missing'], [2, 'unchanged']]) {
    const row = report.sources.find((entry) => entry.file === rows[index].file);
    assert.strictEqual(row.status, status);
    assert.strictEqual(row.revalidation_required, status !== 'unchanged');
    if (status === 'missing') assert.strictEqual(row.current_sha256, null);
  }
});
test('C01 findings: all carry forward and dropped open ID is error exit 1', (root) => {
  const data = readJson(root, BASE);
  write(root, 'previous.json', data);
  assert.deepStrictEqual(validateBaseline({ cwd: root }).carry_forward, data.open_findings.map((row) => row.id).sort());
  const removed = data.open_findings[0].id;
  repack(root, (baseline) => { baseline.open_findings.shift(); });
  const result = cli(root, ['--previous', 'previous.json']);
  assert.strictEqual(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.deepStrictEqual(report.dropped_findings, [removed]);
  assert(report.issues.includes(`open-finding-dropped:${removed}`));
});
test('C01 tampered report baseline evidence and unmarked edit fail hash verification', (root) => {
  const data = readJson(root, BASE);
  for (const file of [data.report, BASE, data.evidence]) {
    const before = fs.readFileSync(path.join(root, file));
    fs.appendFileSync(path.join(root, file), ' ');
    const result = cli(root);
    assert.strictEqual(result.status, 1);
    hasIssue(JSON.parse(result.stdout), 'artifact-hash-mismatch');
    fs.writeFileSync(path.join(root, file), before);
  }
  const record = readJson(root, IMPORT);
  record.files.find((row) => row.file === 'docs/runtime-compatibility.md').edited_after_import = false;
  write(root, IMPORT, record);
  hasIssue(validateBaseline({ cwd: root }), 'artifact-hash-mismatch');
});
test('C01 invalid JSON and shapes are named and never echo content', (root) => {
  const original = fs.readFileSync(path.join(root, BASE));
  write(root, BASE, '{ PRIVATE_CONTENT');
  const result = cli(root);
  assert.strictEqual(result.status, 1);
  assert(!result.stdout.includes('PRIVATE_CONTENT'));
  hasIssue(JSON.parse(result.stdout), 'invalid-json');
  for (const value of [null, [], {}, { schema_version: 99 }]) {
    write(root, BASE, JSON.stringify(value));
    hasIssue(validateBaseline({ cwd: root }), 'invalid-shape');
  }
  fs.writeFileSync(path.join(root, BASE), original);
  const data = readJson(root, BASE);
  write(root, data.evidence, {});
  hasIssue(validateBaseline({ cwd: root }), 'invalid-shape');
  write(root, IMPORT, []);
  hasIssue(validateBaseline({ cwd: root }), 'invalid-shape');
});
test('C01 import consistency: hashes, missing rows, duplicate rows and core edit flags rejected', (root) => {
  const record = readJson(root, IMPORT);
  for (const mutate of [
    (value) => { value.files[0].source_sha256 = '0'.repeat(64); },
    (value) => { value.files.shift(); },
    (value) => { value.files.push(value.files[0]); },
    (value) => { value.files[0].edited_after_import = true; },
  ]) {
    const copy = structuredClone(record); mutate(copy); write(root, IMPORT, copy);
    assert.strictEqual(cli(root).status, 1);
  }
  fs.unlinkSync(path.join(root, IMPORT));
  const absent = validateBaseline({ cwd: root });
  assert.strictEqual(absent.import_record, 'absent');
  assert.strictEqual(absent.ok, true);
  assert.strictEqual(absent.artifacts.find((row) => row.file.endsWith('.evidence.json')).status, 'unknown');
});
test('C01 containment: absolute traversal ADS backslash and link escape refused before reads', (root) => {
  for (const file of ['/outside', 'C:/outside', '../outside', 'docs/../outside', 'docs\\outside', 'docs/x:stream']) {
    hasIssue(validateBaseline({ cwd: root, baseline: file }), 'invalid-path');
    hasIssue(validateBaseline({ cwd: root, previous: file }), 'invalid-path');
  }
  const baseline = readJson(root, BASE);
  const original = fs.readFileSync(path.join(root, baseline.evidence));
  for (const file of ['/outside', '../outside', 'docs/../outside', 'C:/outside']) {
    const evidence = JSON.parse(original);
    evidence.inspected_source_fingerprints[0].file = file;
    write(root, baseline.evidence, evidence);
    hasIssue(validateBaseline({ cwd: root }), 'invalid-shape');
  }
  fs.writeFileSync(path.join(root, baseline.evidence), original);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-host-outside-'));
  try {
    write(outside, 'private.json', 'PRIVATE_CONTENT');
    fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    hasIssue(validateBaseline({ cwd: root, baseline: 'escape/private.json' }), 'source-outside-roots');
    repack(root, undefined, (evidence) => { evidence.inspected_source_fingerprints[0].file = 'escape/private.json'; });
    const report = validateBaseline({ cwd: root });
    hasIssue(report, 'source-outside-roots');
    assert(!JSON.stringify(report).includes('PRIVATE_CONTENT'));
    fs.unlinkSync(path.join(root, 'escape'));
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});
test('C01 bounded IO: oversize baseline artifact and source rejected, unstable file named', (root) => {
  write(root, 'large.json', Buffer.alloc(1024 * 1024 + 1, 32));
  hasIssue(validateBaseline({ cwd: root, baseline: 'large.json' }), 'source-too-large');
  const data = readJson(root, BASE);
  const evidence = readJson(root, data.evidence);
  const source = evidence.inspected_source_fingerprints[0].file;
  const reportBytes = fs.readFileSync(path.join(root, data.report));
  write(root, data.report, Buffer.alloc(1024 * 1024 + 1));
  hasIssue(validateBaseline({ cwd: root }), 'source-too-large');
  fs.writeFileSync(path.join(root, data.report), reportBytes);
  write(root, source, Buffer.alloc(1024 * 1024 + 1));
  hasIssue(validateBaseline({ cwd: root }), 'source-too-large');
  let calls = 0;
  const io = { ...fs, fstatSync(fd) {
    const stat = fs.fstatSync(fd);
    if (++calls % 2 === 0) Object.defineProperty(stat, 'mtimeMs', { value: stat.mtimeMs + 1 });
    return stat;
  } };
  hasIssue(validateBaseline({ cwd: root, io }), 'source-changed-during-read');
});
test('C01 CLI strict arguments: exit 2, help, deterministic JSON and BOM input', (root) => {
  for (const args of [['--bogus'], ['--cwd'], ['--codex-version', 'garbage'], ['--json', '--json'], ['--previous']]) {
    const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
    assert.strictEqual(result.status, 2, args.join(' '));
  }
  let help = '';
  assert.strictEqual(main(['--help'], (text) => { help += text; }), 0);
  assert(help.includes('Uso:'));
  const first = cli(root); const second = cli(root);
  assert.strictEqual(first.stdout, second.stdout);
  assert.strictEqual(first.stdout, JSON.stringify(canonical(JSON.parse(first.stdout))) + '\n');
  fs.writeFileSync(path.join(root, BASE), '\uFEFF' + fs.readFileSync(path.join(root, BASE), 'utf8'));
  assert.notStrictEqual(validateBaseline({ cwd: root }).baseline, null);
});
test('C01 read-only default: no spawn network git or writes, canonical readers/hash/version used', (root) => {
  const before = snapshot(root);
  const child = require('child_process'); const http = require('http'); const https = require('https'); const net = require('net');
  const saved = [];
  const forbid = (target, key) => { saved.push([target, key, target[key]]); target[key] = () => { throw new Error(`forbidden ${key}`); }; };
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) forbid(child, key);
  for (const key of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync']) forbid(fs, key);
  forbid(http, 'request'); forbid(https, 'request'); forbid(net, 'connect');
  const beforeReads = reads; const beforeComparisons = comparisons;
  try {
    let stdout = '';
    assert.strictEqual(main(['--check', '--cwd', root, '--codex-version', '0.166.0', '--json'], (text) => { stdout += text; }), 0);
    assert.strictEqual(JSON.parse(stdout).hosts.codex.relation, 'newer');
    assert(reads > beforeReads);
    assert(comparisons > beforeComparisons);
  } finally { for (const [target, key, value] of saved) target[key] = value; }
  assert.deepStrictEqual(snapshot(root), before);
});
test('C01 observe opt-in uses only canonical detect both, flags win, no UI inference', (root) => {
  const original = capabilities.detect; let calls = 0;
  capabilities.detect = (options) => {
    calls++; assert.strictEqual(options.runtime, 'both'); assert.strictEqual(options.cwd, root);
    return { probes: { codex: { version: '0.166.0' }, claude: { version: '2.1.313' } } };
  };
  try {
    let text = '';
    assert.strictEqual(main(['--check', '--cwd', root, '--json'], () => {}), 0);
    assert.strictEqual(calls, 0);
    assert.strictEqual(main(['--check', '--cwd', root, '--json', '--observe', '--codex-version', '0.165.0'], (out) => { text += out; }), 0);
    assert.strictEqual(calls, 1);
    const report = JSON.parse(text);
    assert.strictEqual(report.hosts.codex.observed_source, 'flag');
    assert.strictEqual(report.hosts.codex.relation, 'same');
    assert.strictEqual(report.hosts.claude.observed_source, 'observe');
    assert.deepStrictEqual(report.ui, { installed_build: null, range_closed: false, state: 'unknown' });
  } finally { capabilities.detect = original; }
});
test('C01 artifacts and key links: exported API, substantive files and CLI process.execPath', () => {
  const api = require('./forge-host-baseline');
  for (const name of ['validateBaseline', 'compareHostVersion', 'main']) assert.strictEqual(typeof api[name], 'function');
  for (const [file, minimum] of [['forge-host-baseline.js', 150], ['forge-host-baseline.test.js', 170]]) {
    const text = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert(text.split('\n').length >= minimum);
    if (file.endsWith('baseline.js')) assert(!/TODO|TBD|FIXME/.test(text));
  }
  assert(reads > 0 && comparisons > 0);
});
bounded.readBoundedStableFile = originalRead;
capabilities.compareVersion = originalCompare;
console.log(`PASS host-baseline: ${passed} named behavioral checks`);
