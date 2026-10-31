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
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-host-baseline-'));
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
  return spawnSync(process.execPath, [CLI, '--check', '--cwd', root, '--baseline', BASE, '--json', ...args], { encoding: 'utf8', timeout: 10000 });
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
  const promoted = compareHostVersion('0.165.0-alpha.1', '0.165.0');
  assert.strictEqual(promoted.relation, 'newer');
  assert.deepStrictEqual(promoted.next_range, { after_exclusive: '0.165.0-alpha.1', through_inclusive: '0.165.0' });
  const rc = compareHostVersion('0.165.0', '0.165.0-rc.1');
  assert.strictEqual(rc.relation, 'older');
  assert.strictEqual(rc.next_range, null);
  assert.strictEqual(compareHostVersion('0.165.0-alpha.1', '0.165.0-alpha.2').relation, 'newer');
  assert.strictEqual(compareHostVersion('0.165.0-alpha.2', '0.165.0-alpha.10').relation, 'newer');
  assert.strictEqual(compareHostVersion('0.165.0-alpha', '0.165.0-alpha.1').relation, 'newer');
  assert.strictEqual(compareHostVersion('0.165.0-1', '0.165.0-alpha').relation, 'newer');
  assert.strictEqual(compareHostVersion('0.165.0+a', '0.165.0+b').relation, 'same');
  assert.strictEqual(compareHostVersion('0.165.0+a', '0.165.0').relation, 'same');
  assert.strictEqual(compareHostVersion('0.165.0-a..b', '0.165.0').relation, 'unknown');
  assert.strictEqual(compareHostVersion('0.165.0-a..b', '0.166.0').relation, 'unknown');
  assert.strictEqual(compareHostVersion('0.166.0', '0.165.0-a..b').relation, 'unknown');
  const large = compareHostVersion('0.165.0-alpha.9007199254740992', '0.165.0-alpha.9007199254740993');
  assert.strictEqual(large.relation, 'newer');
  assert.deepStrictEqual(large.next_range, { after_exclusive: '0.165.0-alpha.9007199254740992', through_inclusive: '0.165.0-alpha.9007199254740993' });
  assert.strictEqual(compareHostVersion('0.165.0-alpha.9007199254740993', '0.165.0-alpha.9007199254740992').relation, 'older');
});
test('C01 unknown versions and UI stay unknown without inferred build', (root) => {
  const report = validateBaseline({ cwd: root, baseline: BASE });
  for (const host of ['codex', 'claude']) {
    assert.strictEqual(report.hosts[host].relation, 'unknown');
    assert.strictEqual(report.hosts[host].observed_source, 'none');
  }
  const observed = validateBaseline({ cwd: root, baseline: BASE, observed: { codex: '0.166.0', claude: '2.1.313' } });
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
  const report = validateBaseline({ cwd: root, baseline: BASE });
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
  assert.deepStrictEqual(validateBaseline({ cwd: root, baseline: BASE }).carry_forward, data.open_findings.map((row) => row.id).sort());
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
  hasIssue(validateBaseline({ cwd: root, baseline: BASE }), 'artifact-hash-mismatch');
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
    hasIssue(validateBaseline({ cwd: root, baseline: BASE }), 'invalid-shape');
  }
  fs.writeFileSync(path.join(root, BASE), original);
  const data = readJson(root, BASE);
  write(root, data.evidence, {});
  hasIssue(validateBaseline({ cwd: root, baseline: BASE }), 'invalid-shape');
  write(root, IMPORT, []);
  hasIssue(validateBaseline({ cwd: root, baseline: BASE }), 'invalid-shape');
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
  const absent = validateBaseline({ cwd: root, baseline: BASE });
  assert.strictEqual(absent.import_record, 'absent');
  assert.strictEqual(absent.ok, true);
  assert.strictEqual(absent.artifacts.find((row) => row.file.endsWith('.evidence.json')).status, 'unknown');
});
test('C01 containment: absolute traversal ADS backslash and link escape refused before reads', (root) => {
  for (const file of ['/outside', 'C:/outside', '../outside', 'docs/../outside', 'docs\\outside', 'docs/x:stream']) {
    hasIssue(validateBaseline({ cwd: root, baseline: file }), 'invalid-path');
    hasIssue(validateBaseline({ cwd: root, baseline: BASE, previous: file }), 'invalid-path');
  }
  const baseline = readJson(root, BASE);
  const original = fs.readFileSync(path.join(root, baseline.evidence));
  for (const file of ['/outside', '../outside', 'docs/../outside', 'C:/outside']) {
    const evidence = JSON.parse(original);
    evidence.inspected_source_fingerprints[0].file = file;
    write(root, baseline.evidence, evidence);
    hasIssue(validateBaseline({ cwd: root, baseline: BASE }), 'invalid-shape');
  }
  fs.writeFileSync(path.join(root, baseline.evidence), original);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-host-outside-'));
  try {
    write(outside, 'private.json', 'PRIVATE_CONTENT');
    fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    hasIssue(validateBaseline({ cwd: root, baseline: 'escape/private.json' }), 'source-outside-roots');
    repack(root, undefined, (evidence) => { evidence.inspected_source_fingerprints[0].file = 'escape/private.json'; });
    const report = validateBaseline({ cwd: root, baseline: BASE });
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
  hasIssue(validateBaseline({ cwd: root, baseline: BASE }), 'source-too-large');
  fs.writeFileSync(path.join(root, data.report), reportBytes);
  write(root, source, Buffer.alloc(1024 * 1024 + 1));
  hasIssue(validateBaseline({ cwd: root, baseline: BASE }), 'source-too-large');
  let calls = 0;
  const io = { ...fs, fstatSync(fd) {
    const stat = fs.fstatSync(fd);
    if (++calls % 2 === 0) Object.defineProperty(stat, 'mtimeMs', { value: stat.mtimeMs + 1 });
    return stat;
  } };
  hasIssue(validateBaseline({ cwd: root, baseline: BASE, io }), 'source-changed-during-read');
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
  assert.notStrictEqual(validateBaseline({ cwd: root, baseline: BASE }).baseline, null);
});
test('C01 read-only default: no spawn network git or writes, canonical readers/hash/version used', (root) => {
  successor(root);
  pointer(root);
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
    assert.strictEqual(JSON.parse(stdout).selection.source, 'pointer');
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
// Each successor has its own report/evidence; no fixture edits the import
// record to make a new analysis look like the original imported analysis.
function successor(root, file = 'docs/current.json', previous = BASE, mutate = () => {}) {
  const prior = readJson(root, previous);
  const value = structuredClone(prior);
  value.analysis_date = '2026-10-31';
  value.report = file.replace('.json', '.md');
  value.evidence = file.replace('.json', '.evidence.json');
  value.lineage = { previous, previous_sha256: sha256(fs.readFileSync(path.join(root, previous))) };
  for (const key of ['codex_cli', 'claude_code']) {
    value[key].release_notes_range = null;
    value[key].release_notes_review = 'not-applicable-same-version';
    value[key].revalidation_required = true;
  }
  mutate(value);
  write(root, value.report, '# Current fixture analysis\n');
  write(root, file, value);
  write(root, value.evidence, { schema_version: 1, inspected_source_fingerprints: [], artifacts: [
    { file, sha256: sha256(fs.readFileSync(path.join(root, file))) },
    { file: value.report, sha256: sha256(fs.readFileSync(path.join(root, value.report))) },
  ] });
  return file;
}
function current(root, mutate) {
  return validateBaseline({ cwd: root, baseline: successor(root, 'docs/current.json', BASE, mutate) });
}
function pointer(root, baseline = 'docs/current.json', mutate = () => {}) {
  const value = { schema_version: 1, baseline, baseline_sha256: sha256(fs.readFileSync(path.join(root, baseline))) };
  mutate(value);
  write(root, 'docs/host-compatibility-current.json', value);
}
test('T05 lineage: two links reach unchanged import and expose artifact origins', (root) => {
  const first = successor(root);
  const second = successor(root, 'docs/current-two.json', first);
  const report = validateBaseline({ cwd: root, baseline: second });
  assert.strictEqual(report.ok, true, JSON.stringify(report.issues));
  assert.strictEqual(report.lineage.length, 2);
  assert.deepStrictEqual(report.selection, { source: 'explicit', file: second });
  assert(report.artifacts.some((row) => row.origin === 'lineage'));
  assert(report.artifacts.some((row) => row.origin === 'current-evidence'));
  assert(report.artifacts.some((row) => row.origin === 'import-record'));
});
test('T05 lineage: tampered missing foreign and unanchored predecessors refuse', (root) => {
  let file = successor(root);
  fs.appendFileSync(path.join(root, BASE), ' ');
  hasIssue(validateBaseline({ cwd: root, baseline: file }), 'lineage-hash-mismatch');
  repack(root);
  hasIssue(current(root, (row) => { row.lineage.previous = 'docs/missing.json'; }), 'lineage-missing');
  for (const previous of ['outside.json', '../docs/out.json', '/docs/out.json', 'docs/x:ads', 'docs\\out.json']) {
    hasIssue(current(root, (row) => { row.lineage.previous = previous; }), 'lineage-foreign');
  }
  hasIssue(current(root, (row) => { delete row.lineage; }), 'lineage-required');
  file = successor(root, 'docs/unanchored.json', BASE, (row) => { delete row.lineage; });
  const next = successor(root, 'docs/child.json', file);
  hasIssue(validateBaseline({ cwd: root, baseline: next }), 'lineage-foreign');
});
test('T05 lineage: date order cycle and ninth link refuse', (root) => {
  hasIssue(current(root, (row) => { row.analysis_date = '2026-10-27'; }), 'lineage-order-invalid');
  hasIssue(current(root, (row) => { row.lineage.previous = 'docs/current.json'; }), 'lineage-cycle');
  let previous = BASE;
  for (let index = 0; index < 8; index++) previous = successor(root, `docs/depth-${index}.json`, previous);
  assert.strictEqual(validateBaseline({ cwd: root, baseline: previous }).ok, true);
  const ninth = successor(root, 'docs/ninth.json', previous);
  hasIssue(validateBaseline({ cwd: root, baseline: ninth }), 'lineage-depth-exceeded');
});
test('T05 lineage: import terminal and all original core rows retain enforcing checks', (root) => {
  for (const target of [BASE, readJson(root, BASE).report, readJson(root, BASE).evidence]) {
    const record = readJson(root, IMPORT);
    const changed = structuredClone(record);
    changed.files.find((row) => row.file === target).edited_after_import = true;
    write(root, IMPORT, changed);
    hasIssue(current(root), 'import-record-inconsistent');
    write(root, IMPORT, record);
  }
  fs.unlinkSync(path.join(root, IMPORT));
  hasIssue(current(root), 'lineage-foreign');
});
test('T05 carry-forward: dropped IDs changed status and evidence are enforced', (root) => {
  hasIssue(current(root, (row) => { row.open_findings.shift(); }), 'open-finding-dropped');
  hasIssue(current(root, (row) => { row.open_findings[0].status_at_analysis = 'implemented-uat-pending'; }), 'finding-disposition-missing');
  hasIssue(current(root, (row) => {
    Object.assign(row.open_findings[0], { status_at_analysis: 'implemented-uat-pending', disposition: 'implemented', evidence: 'docs/missing.md' });
  }), 'finding-disposition-missing');
  const report = current(root, (row) => {
    Object.assign(row.open_findings[0], { status_at_analysis: 'implemented-uat-pending', disposition: 'implemented', evidence: row.report });
  });
  assert.strictEqual(report.ok, true, JSON.stringify(report.issues));
  assert.strictEqual(report.carry_forward.length, 6);
});
test('T05 closure: green checks commits and missing operator reference cannot close findings', (root) => {
  for (const closure of [undefined, { source: 'test', reference: BASE }, { source: 'operator', reference: '' },
    { source: 'guard', reference: BASE }, { source: 'commit', reference: BASE }]) {
    hasIssue(current(root, (row) => {
      Object.assign(row.open_findings[0], { status_at_analysis: 'closed', disposition: 'operator-accepted', evidence: row.report, closure });
    }), 'finding-closure-unverified');
  }
  const report = current(root, (row) => {
    Object.assign(row.open_findings[0], { status_at_analysis: 'resolved', disposition: 'operator-accepted', evidence: row.report,
      closure: { source: 'operator', reference: row.report } });
  });
  assert.strictEqual(report.ok, true, JSON.stringify(report.issues));
});
test('T05 ranges: normal pending range preserves reviewed anchor and requires open review finding', (root) => {
  const update = (row) => {
    Object.assign(row.codex_cli, { installed: '0.166.0', release_notes_range: { after_exclusive: '0.165.0', through_inclusive: '0.166.0' }, release_notes_review: 'pending' });
    row.open_findings.push({ id: 'release-review-codex', status_at_analysis: 'pending' });
  };
  assert.strictEqual(current(root, update).ok, true);
  hasIssue(current(root, (row) => { update(row); row.open_findings.pop(); }), 'release-range-invalid');
  hasIssue(current(root, (row) => { update(row); row.codex_cli.next_release_notes_after_exclusive = '0.166.0'; }), 'release-range-gap');
  hasIssue(current(root, (row) => { update(row); row.codex_cli.release_notes_range.after_exclusive = '0.164.0'; }), 'release-range-gap');
  hasIssue(current(root, (row) => { update(row); row.codex_cli.release_notes_range.after_exclusive = '0.165.1'; }), 'release-range-gap');
  hasIssue(current(root, (row) => { update(row); row.codex_cli.release_notes_range.through_inclusive = '0.167.0'; }), 'release-range-invalid');
});
test('T05 ranges: same older reviewed-without-sources and missing revalidation refuse', (root) => {
  assert.strictEqual(current(root).ok, true);
  hasIssue(current(root, (row) => { row.codex_cli.installed = '0.164.0'; }), 'release-range-invalid');
  hasIssue(current(root, (row) => { row.codex_cli.release_notes_range = { after_exclusive: '0.164.0', through_inclusive: '0.165.0' }; }), 'release-range-invalid');
  hasIssue(current(root, (row) => { row.codex_cli.revalidation_required = false; }), 'release-range-invalid');
  hasIssue(current(root, (row) => {
    Object.assign(row.codex_cli, { installed: '0.166.0', release_notes_range: { after_exclusive: '0.165.0', through_inclusive: '0.166.0' }, release_notes_review: 'reviewed', next_release_notes_after_exclusive: '0.166.0' });
  }), 'release-range-invalid');
});
test('T05 ranges: reviewed interval needs matching dated official source and moves only reviewed anchor', (root) => {
  const file = successor(root, 'docs/reviewed.json', BASE, (row) => {
    Object.assign(row.codex_cli, { installed: '0.166.0', release_notes_range: { after_exclusive: '0.165.0', through_inclusive: '0.166.0' },
      release_notes_review: 'reviewed', next_release_notes_after_exclusive: '0.166.0' });
  });
  const baseline = readJson(root, file);
  const evidence = readJson(root, baseline.evidence);
  evidence.official_releases = [{ host: 'codex', release_notes_review: 'reviewed', after_exclusive: '0.165.0',
    through_inclusive: '0.166.0', url: 'https://github.com/openai/codex/releases/tag/rust-v0.166.0',
    body_sha256: '1'.repeat(64), body_bytes: 12, observed_at: '2026-10-31T03:06:55Z' }];
  write(root, baseline.evidence, evidence);
  assert.strictEqual(validateBaseline({ cwd: root, baseline: file }).ok, true);
  evidence.official_releases[0].after_exclusive = '0.164.0';
  write(root, baseline.evidence, evidence);
  hasIssue(validateBaseline({ cwd: root, baseline: file }), 'release-range-invalid');
});
test('T05 pointer: absent default explicit override and valid selection never mutate inputs', (root) => {
  assert.deepStrictEqual(validateBaseline({ cwd: root }).selection, { source: 'default', file: BASE });
  const file = successor(root);
  pointer(root, file);
  const before = snapshot(root);
  const result = validateBaseline({ cwd: root });
  assert.strictEqual(result.ok, true, JSON.stringify(result.issues));
  assert.deepStrictEqual(result.selection, { source: 'pointer', file });
  assert.deepStrictEqual(validateBaseline({ cwd: root, baseline: BASE }).selection, { source: 'explicit', file: BASE });
  assert.deepStrictEqual(snapshot(root), before);
});
test('T05 pointer: malformed tampered foreign missing and invalid target fail without fallback', (root) => {
  successor(root);
  pointer(root, undefined, (row) => { row.baseline_sha256 = '0'.repeat(64); });
  hasIssue(validateBaseline({ cwd: root }), 'pointer-hash-mismatch');
  for (const baseline of ['outside.json', '../outside.json', '/docs/out.json', 'docs/missing.json']) {
    pointer(root, undefined, (row) => { row.baseline = baseline; });
    hasIssue(validateBaseline({ cwd: root }), 'pointer-invalid');
  }
  write(root, 'docs/host-compatibility-current.json', '{ invalid');
  hasIssue(validateBaseline({ cwd: root }), 'pointer-invalid');
  write(root, 'docs/current.json', {});
  pointer(root);
  hasIssue(validateBaseline({ cwd: root }), 'pointer-invalid');
});
test('T05 containment: internal foreign alias cannot bypass docs or default', (root) => {
  write(root, 'outside/previous.json', fs.readFileSync(path.join(root, BASE)));
  // Junction creation is supported without elevated symlink privileges on
  // Windows; it exercises a lexical docs path resolving physically elsewhere.
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'docs/alias'), process.platform === 'win32' ? 'junction' : 'dir');
  hasIssue(current(root, (row) => { row.lineage.previous = 'docs/alias/previous.json'; }), 'lineage-foreign');
  pointer(root, undefined, (row) => { row.baseline = 'docs/alias/previous.json'; });
  hasIssue(validateBaseline({ cwd: root }), 'pointer-invalid');
  fs.unlinkSync(path.join(root, 'docs/alias'));
});
test('T05 real documents: CP2 versions pending gates matrix and safe evidence have concrete hashes', () => {
  const file = 'docs/host-compatibility-baseline-2026-10-31.json';
  const data = readJson(REPO, file);
  const evidence = readJson(REPO, data.evidence);
  assert.strictEqual(data.forge.version, '4.47.0');
  assert.strictEqual(data.forge.commit, '30147f9a117b858d9de60cd13e8ed42a2c44a4f7');
  assert.strictEqual(data.codex_cli.installed, '0.166.0');
  assert.strictEqual(data.codex_cli.next_release_notes_after_exclusive, '0.165.0');
  assert.strictEqual(data.claude_code.installed, '2.1.312');
  assert.strictEqual(data.claude_code.latest_stable_found, '2.1.316');
  assert.strictEqual(data.claude_code.release_notes_range, null);
  assert.strictEqual(data.vscode_client.commit, '2c33b50b16c472efe58357d1d2a8a5414bc23fbf');
  assert.strictEqual(data.vscode_client.codex_extension.status, 'unknown');
  assert.strictEqual(data.desktop_ui.installed_build, null);
  for (const key of Object.keys(readJson(REPO, BASE).reanalysis_policy)) assert.strictEqual(data.reanalysis_policy[key], true);
  for (const row of readJson(REPO, BASE).open_findings) {
    const next = data.open_findings.find((finding) => finding.id === row.id);
    assert(next && next.disposition && fs.statSync(path.join(REPO, next.evidence)).isFile());
  }
  assert(data.open_findings.every((row) => !['closed', 'resolved'].includes(row.status_at_analysis)));
  for (const id of ['release-review-codex', 'release-review-claude', 'statusline-r6', 'issue-294', 'issue-306', 'g2-1', 'g2-2',
    'issue-288', 'issue-289', 'issue-290', 'windows-link-negatives', 'panel-operator-installation', 'native-navigation',
    'subagent-statusline-rendering', 'sidecar-real-input', 'final-human-uat']) assert(data.open_findings.some((row) => row.id === id));
  assert.strictEqual(evidence.schema_version, 1);
  assert.strictEqual(evidence.owner_observation.sha256, '6f90cbce6873b3bcfff62ca9c31e76b94a230bde17be9cbe22ce3e0721a29148');
  assert.strictEqual(evidence.commands.find((row) => row.command.includes('forge-schema-pin')).result.fields_total, 14);
  assert.strictEqual(evidence.current_panel_runtime.result, 'mounted');
  assert.strictEqual(evidence.current_panel_runtime.source_match, 'match');
  assert.strictEqual(evidence.current_panel_runtime.sources_unchanged, true);
  assert.strictEqual(evidence.current_panel_runtime.panel_generated_at, '2026-10-31T03:06:40.743Z');
  assert.strictEqual(evidence.current_panel_runtime.panel_stable_sha256, evidence.current_panel_runtime.canonical_stable_sha256);
  assert(evidence.official_releases.every((row) => row.status === 'revalidated' && row.release_notes_review === 'pending'
    && /^[a-f0-9]{64}$/.test(row.sha256) && row.body_bytes > 0));
  for (const row of [...evidence.inspected_source_fingerprints, ...evidence.artifacts]) {
    assert.strictEqual(sha256(fs.readFileSync(path.join(REPO, row.file))), row.sha256, row.file);
  }
  const report = fs.readFileSync(path.join(REPO, data.report), 'utf8');
  const runtime = fs.readFileSync(path.join(REPO, 'docs/runtime-compatibility.md'), 'utf8');
  assert.strictEqual((report.match(/^\| (Codex no VS Code|Claude Code terminal|Codex CLI|Desktop, informativo).*\| R[1-5] \|/gm) || []).length, 20);
  assert(report.includes('pending-final-round') && report.includes('security gate final: **pendente**'));
  assert(runtime.includes('(host-compatibility-baseline.json)') && runtime.includes('(host-compatibility-current.json)'));
  assert(runtime.includes('`conditional` for Codex in VS Code') && runtime.includes('`unavailable` for Claude'));
  for (const [name, minimum] of [[data.report, 90], [file, 50], [data.evidence, 40], ['docs/runtime-compatibility.md', 210]]) {
    const text = fs.readFileSync(path.join(REPO, name), 'utf8');
    assert(text.split('\n').length >= minimum, name);
    assert(!text.includes('\r') && !text.startsWith('\uFEFF'));
    assert(!/\b[A-Za-z]:[\\/]|\\\\|\/Users\/|\/home\//.test(text), name);
  }
});
test('T05 real repository: current pointer lineage immutable originals and final sources', () => {
  const originals = {
    'docs/host-compatibility-2026-10-28.md': '54ab27a29082b2315da0b7bb7d3691c411683208283511d589759cdde36db424',
    'docs/host-compatibility-2026-10-28.evidence.json': '95974b4ecf41c98d331978755d7523dab4491d969e145d7a9c86cd7cf67d125c',
    [BASE]: '31b5e62a1cb73a1856a134a5bc295667088254a63726d6222c65bf6cd6f6fea9',
    [IMPORT]: 'd4abd0d35cd299ace327c9c2d227eba1e7087feb3541d016acbbbff5dac3077b',
  };
  for (const [file, hash] of Object.entries(originals)) assert.strictEqual(sha256(fs.readFileSync(path.join(REPO, file))), hash);
  const result = validateBaseline({ cwd: REPO });
  assert.strictEqual(result.ok, true, JSON.stringify(result.issues));
  assert.strictEqual(result.selection.source, 'pointer');
  assert.strictEqual(result.lineage[0].previous, BASE);
  assert(result.sources.every((row) => !row.file.startsWith('scripts/forge-host-baseline') || row.status === 'unchanged'));
  assert.strictEqual(validateBaseline({ cwd: REPO, baseline: BASE }).ok, true);
});
bounded.readBoundedStableFile = originalRead;
capabilities.compareVersion = originalCompare;
console.log(`PASS host-baseline: ${passed} named behavioral checks`);
