#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const api = require('./forge-release-version.js');
const { SURFACES, KINDS, KIND_BUMP } = require('./forge-release-impact.js');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const fixturePath = path.join(__dirname, 'fixtures/release-impact/milestone-contracts.json');
const MAX_BYTES = 262144;
assert(fs.statSync(fixturePath).size <= MAX_BYTES, 'fixture acima do limite antes da leitura');
const bytes = fs.readFileSync(fixturePath);
assert(bytes.length <= MAX_BYTES, 'fixture acima do limite antes do parse');
const fixture = JSON.parse(bytes.toString('utf8'));
let checks = 0;
function check(name, fn) {
  try { fn(); console.log(`ok ${++checks} - ${name}`); }
  catch (error) { console.error(`not ok ${++checks} - ${name}`); throw error; }
}
function closed(value, keys) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepStrictEqual(Object.keys(value).sort(), keys.split(' ').sort());
}
function text(value, max = 8192) {
  assert(typeof value === 'string' && value.length > 0 && value.length <= max);
  assert(!value.includes('\0'));
}
function relativeFile(value) {
  text(value, 240);
  assert(!value.includes('\\') && !value.includes(':') && !path.isAbsolute(value));
  assert(value.split('/').every(part => part && part !== '.' && part !== '..'));
  assert(fs.statSync(path.join(root, value)).isFile(), value);
}
function uniqueIds(rows) {
  assert(Array.isArray(rows) && rows.length > 0);
  const ids = rows.map(row => row.id);
  assert(ids.every(id => typeof id === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(id)));
  assert.strictEqual(new Set(ids).size, ids.length);
}

check('CHECK-EXAMPLES-INTERMEDIATE-SCHEMA', () => {
  const historicalPath = path.join(path.dirname(fixturePath), 'history/s08-intermediate/milestone-contracts.json');
  assert(fs.statSync(historicalPath).size <= MAX_BYTES);
  const bytes = fs.readFileSync(historicalPath);
  const fixture = JSON.parse(bytes.toString('utf8'));
  assert.strictEqual(bytes.toString('utf8'), `${JSON.stringify(fixture, null, 2)}\n`);
  assert(!bytes.includes(13));
  closed(fixture, 'schema_version provenance contracts examples');
  assert.strictEqual(fixture.schema_version, 1);
  closed(fixture.provenance, 'code_dir branch observed_revision last_tag last_tag_revision');
  for (const value of Object.values(fixture.provenance)) text(value, 240);
  assert(/^[0-9a-f]{40}$/.test(fixture.provenance.observed_revision));
  assert(/^[0-9a-f]{40}$/.test(fixture.provenance.last_tag_revision));
  assert(/^v\d+\.\d+\.\d+$/.test(fixture.provenance.last_tag));
  uniqueIds(fixture.contracts); uniqueIds(fixture.examples);
  assert(fixture.contracts.length <= 64 && fixture.examples.length <= 24);
  for (const row of fixture.contracts) {
    closed(row, 'id slice issue surface kind bump consumers baseline baseline_reference released evidence rationale origin status pending_refresh example_ids');
    assert(/^S0[2-8]$/.test(row.slice));
    assert(row.issue === null || (Number.isSafeInteger(row.issue) && row.issue > 0));
    assert(SURFACES.includes(row.surface)); assert(KINDS.includes(row.kind));
    assert.strictEqual(row.bump, KIND_BUMP[row.kind]);
    assert(['last-tag', 'slice-start'].includes(row.baseline)); text(row.baseline_reference);
    assert([true, false, 'unknown'].includes(row.released));
    assert(['real', 'illustrative'].includes(row.origin));
    assert.strictEqual(row.status, 'intermediate'); text(row.rationale);
    assert(Array.isArray(row.pending_refresh) && row.pending_refresh.length > 0);
    row.pending_refresh.forEach(value => text(value));
    for (const token of ['S03-REVIEW', 'S04-REVIEW', '#208', '#209', '#212', '#221', '#222', '#226', '#228', '#229', '#230', '#231', 'followups', 'S09']) {
      assert(row.pending_refresh.some(value => value.includes(token)), `${row.id}: ${token}`);
    }
    assert(Array.isArray(row.consumers) && row.consumers.includes('unknown'));
    row.consumers.filter(value => value !== 'unknown').forEach(relativeFile);
    assert(Array.isArray(row.evidence) && row.evidence.length > 0);
    for (const evidence of row.evidence) {
      closed(evidence, 'file symbol observed_sha observed_on_branch');
      relativeFile(evidence.file); text(evidence.symbol, 240);
      assert(evidence.observed_sha === null || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(evidence.observed_sha));
      assert.strictEqual(typeof evidence.observed_on_branch, 'boolean');
    }
    assert(Array.isArray(row.example_ids));
    for (const id of row.example_ids) assert(fixture.examples.some(example => example.id === id && example.contract_id === row.id));
  }
  for (const example of fixture.examples) {
    closed(example, 'id origin contract_id base_tag messages declared_version expect');
    assert(['real', 'illustrative'].includes(example.origin));
    assert(example.contract_id === null || fixture.contracts.some(row => row.id === example.contract_id));
    if (example.origin === 'real') assert(example.contract_id !== null);
    assert(/^v\d+\.\d+\.\d+$/.test(example.base_tag));
    assert(/^\d+\.\d+\.\d+$/.test(example.declared_version));
    assert(Array.isArray(example.messages) && example.messages.length > 0 && example.messages.length <= 16);
    example.messages.forEach(message => text(message));
    closed(example.expect, 'bump new_tag impact_status check changelog_sections');
    assert(['major', 'minor', 'patch', 'none'].includes(example.expect.bump));
    assert(/^v\d+\.\d+\.\d+$/.test(example.expect.new_tag));
    assert(['consistent', 'partial', 'conflict', 'invalid'].includes(example.expect.impact_status));
    assert(['ok', 'impact-label-conflict', 'impact-invalid', 'declared-version-mismatch'].includes(example.expect.check));
    assert(Array.isArray(example.expect.changelog_sections));
    assert.strictEqual(example.expect.changelog_sections.length, example.messages.length);
    for (const section of example.expect.changelog_sections) assert(['Breaking Changes', 'Features', 'Bug Fixes', 'Other Changes'].includes(section));
  }
});

check('CHECK-EXAMPLES-HISTORY-PRESERVED', () => {
  // Fixed physical hashes survive squash; tests never resolve historical Git objects.
  const pins = {
    'milestone-contracts.json': 'a18fbbd860b8e7ee0cb21ed2b608670ac5bc55d3657903f5a72b4a68516fb437',
    'README.md': '3be8a96d6b4088198482af8244c5cf085d278f00aba9396a8c24d1098b3b0041',
  };
  for (const [name, expected] of Object.entries(pins)) {
    const relative = `scripts/fixtures/release-impact/history/s08-intermediate/${name}`;
    assert(fs.statSync(path.join(root, relative)).size <= MAX_BYTES);
    const content = fs.readFileSync(path.join(root, relative));
    assert.strictEqual(crypto.createHash('sha256').update(content).digest('hex'), expected);
    const row = fixture.provenance.history.find(entry => entry.path === relative);
    assert(row);
    assert.strictEqual(row.sha256, expected);
    assert.strictEqual(crypto.createHash('sha1').update(Buffer.from(`blob ${content.length}\0`)).update(content).digest('hex'), row.blob_oid);
    assert.strictEqual(row.source_revision, 'fd19ffd765252ce33fe66a7b8fc5a0c31c29e3e8');
  }
});

check('CHECK-EXAMPLES-SCHEMA', () => {
  assert.strictEqual(bytes.toString('utf8'), `${JSON.stringify(fixture, null, 2)}\n`);
  assert(!bytes.includes(13));
  closed(fixture, 'schema_version status provenance contracts examples summary');
  assert.strictEqual(fixture.schema_version, 2);
  assert.strictEqual(fixture.status, 'final-candidate');
  closed(fixture.provenance, 'code_dir branch observed_revision last_tag last_tag_revision historical_tag historical_tag_revision history');
  for (const key of ['observed_revision', 'last_tag_revision', 'historical_tag_revision']) assert(/^[a-f0-9]{40}$/.test(fixture.provenance[key]));
  for (const key of ['code_dir', 'branch', 'last_tag', 'historical_tag']) text(fixture.provenance[key], 240);
  assert(Array.isArray(fixture.provenance.history) && fixture.provenance.history.length === 2);
  for (const row of fixture.provenance.history) {
    closed(row, 'path sha256 blob_oid source_revision');
    relativeFile(row.path);
    assert(/^[a-f0-9]{64}$/.test(row.sha256));
    assert(/^[a-f0-9]{40}$/.test(row.blob_oid));
  }
  uniqueIds(fixture.contracts); uniqueIds(fixture.examples);
  assert(fixture.contracts.length <= 64 && fixture.examples.length <= 24);
  for (const row of fixture.contracts) {
    closed(row, 'id slice issue surface kind bump consumers external_consumers baseline baseline_reference released evidence rationale origin status history findings example_ids');
    assert(/^S0[2-8]$/.test(row.slice) || row.slice === 'maintenance');
    assert(row.issue === null || Number.isSafeInteger(row.issue) && row.issue > 0);
    assert(SURFACES.includes(row.surface)); assert(KINDS.includes(row.kind));
    assert.strictEqual(row.bump, KIND_BUMP[row.kind]);
    assert(['last-tag', 'slice-start'].includes(row.baseline)); text(row.baseline_reference);
    assert([true, false, 'unknown'].includes(row.released));
    assert(['real', 'illustrative'].includes(row.origin));
    assert.strictEqual(row.status, 'final-candidate'); text(row.rationale);
    assert.strictEqual(row.external_consumers, 'unknown');
    assert(Array.isArray(row.consumers) && row.consumers.length > 0);
    row.consumers.forEach(relativeFile);
    assert(Array.isArray(row.evidence) && row.evidence.length > 0);
    for (const evidence of row.evidence) {
      closed(evidence, 'file symbol observed_sha observed_on_branch');
      relativeFile(evidence.file); text(evidence.symbol, 240);
      assert(evidence.observed_sha === null || /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.observed_sha));
      assert.strictEqual(typeof evidence.observed_on_branch, 'boolean');
    }
    assert(Array.isArray(row.history) && row.history.length > 0);
    assert(Array.isArray(row.findings) && row.findings.length === 11);
    for (const finding of row.findings) { closed(finding, 'ref state'); text(finding.ref); text(finding.state); }
    assert(Array.isArray(row.example_ids));
    for (const id of row.example_ids) assert(fixture.examples.some(example => example.id === id && example.contract_id === row.id));
  }
  for (const example of fixture.examples) {
    closed(example, 'id origin contract_id base_tag messages declared_version expect');
    assert(['real', 'illustrative'].includes(example.origin));
    assert(example.contract_id === null || fixture.contracts.some(row => row.id === example.contract_id));
    if (example.origin === 'real') assert(example.contract_id !== null);
    assert(/^v\d+\.\d+\.\d+$/.test(example.base_tag));
    assert(/^\d+\.\d+\.\d+$/.test(example.declared_version));
    assert(Array.isArray(example.messages) && example.messages.length > 0 && example.messages.length <= 16);
    example.messages.forEach(message => text(message));
    closed(example.expect, 'bump new_tag impact_status check changelog_sections');
    assert(['major', 'minor', 'patch', 'none'].includes(example.expect.bump));
    assert(/^v\d+\.\d+\.\d+$/.test(example.expect.new_tag));
    assert(['consistent', 'partial', 'conflict', 'invalid'].includes(example.expect.impact_status));
    assert(['ok', 'impact-label-conflict', 'impact-invalid', 'declared-version-mismatch'].includes(example.expect.check));
    assert(Array.isArray(example.expect.changelog_sections));
    assert.strictEqual(example.expect.changelog_sections.length, example.messages.length);
    for (const section of example.expect.changelog_sections) assert(['Breaking Changes', 'Features', 'Bug Fixes', 'Other Changes'].includes(section));
  }
  closed(fixture.summary, 'required_bump_last_tag rationale'); text(fixture.summary.rationale);
});

check('CHECK-EXAMPLES-FINAL-COVERAGE', () => {
  for (const slice of ['S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08']) assert(fixture.contracts.some(row => row.slice === slice));
  for (const issue of [208, 209, 210, 211, 212, 214, 215, 221, 222, 223, 226, 228, 229, 230, 231, 234, 235]) {
    assert(fixture.contracts.some(row => row.issue === issue && row.slice === 'maintenance'), String(issue));
  }
  const native = fixture.contracts.find(row => row.id === 'maintenance-221');
  assert(native.consumers.includes('scripts/forge-task-preparation.js'));
  assert(native.consumers.includes('scripts/forge-unit-sidecar.js'));
  assert(native.evidence.some(row => row.file === 'scripts/forge-native-invocation.js' && row.symbol === 'terminal: options.terminalResult'));
  assert.strictEqual(new Set(native.evidence.map(row => row.file)).size, 11);
  assert(fixture.contracts.find(row => row.id === 'maintenance-231-shape').evidence.some(row => row.file === 'scripts/forge-native-recovery-delivery.js'));
  assert(fixture.contracts.find(row => row.id === 'maintenance-235').evidence.some(row => row.file === 'scripts/forge-review-fix.js'));
  const repair = fixture.contracts.find(row => row.issue === 234);
  for (const prefix of ['c912c8d8', 'd98f9384']) assert(repair.evidence.some(row => row.observed_sha.startsWith(prefix)));
  assert(repair.history.some(row => row.ref.includes('S08-REVIEW') && row.ref.includes('S08-SUMMARY.md:75')));
});

check('CHECK-EXAMPLES-BASELINES', () => {
  assert.strictEqual(fixture.provenance.last_tag, 'v4.45.1');
  assert.strictEqual(fixture.provenance.historical_tag, 'v4.45.0');
  assert.notStrictEqual(fixture.provenance.last_tag_revision, fixture.provenance.historical_tag_revision);
  for (const row of fixture.contracts.filter(row => row.baseline === 'last-tag')) assert.strictEqual(row.baseline_reference, fixture.provenance.last_tag);
  for (const row of fixture.contracts.filter(row => row.baseline === 'slice-start')) assert.notStrictEqual(row.baseline_reference, fixture.provenance.last_tag);
});

check('CHECK-EXAMPLES-REQUIRED-BUMP', () => {
  const ranks = ['none', 'patch', 'minor', 'major'];
  const maximum = fixture.contracts.filter(row => row.baseline === 'last-tag').reduce((rank, row) => Math.max(rank, ranks.indexOf(KIND_BUMP[row.kind])), 0);
  assert.strictEqual(fixture.summary.required_bump_last_tag, ranks[maximum]);
});

check('CHECK-EXAMPLES-NO-FABRICATED-MAJOR', () => {
  for (const row of fixture.contracts.filter(row => row.origin === 'real' && row.bump === 'major')) {
    assert(['removal', 'new-requirement', 'meaning-change'].includes(row.kind));
    assert(row.consumers.length > 0 && row.evidence.length > 0 && row.rationale.length > 100);
    text(row.baseline_reference);
    if (row.baseline === 'last-tag') {
      assert.strictEqual(row.id, 'maintenance-221');
      assert(row.rationale.includes('v4.45.1') && row.rationale.includes('invokeNative') && row.rationale.includes('terminalResult'));
      assert(row.consumers.includes('scripts/forge-task-preparation.js'));
    } else {
      assert(['issue-232-intermediate', 'issue-233-intermediate'].includes(row.id));
      assert(row.rationale.includes('S07'));
    }
  }
  // Documentary review independently checks the actual semantic claim and baseline.
});

check('CHECK-EXAMPLES-EVIDENCE-ANCHORS', () => {
  for (const row of fixture.contracts) for (const evidence of row.evidence) {
    assert(fs.readFileSync(path.join(root, evidence.file), 'utf8').includes(evidence.symbol), `${row.id}: ${evidence.symbol}`);
  }
  const readmePath = path.join(path.dirname(fixturePath), 'README.md');
  const links = [...fs.readFileSync(readmePath, 'utf8').matchAll(/\[o contrato de impacto\]\(([^)\r\n]+)\)/g)];
  assert.strictEqual(links.length, 1, 'README deve conter um link para o contrato');
  assert.strictEqual(links[0][1], '../../../shared/forge-release-impact.md');
  const target = path.resolve(path.dirname(readmePath), links[0][1]);
  assert.strictEqual(target, path.join(root, 'shared/forge-release-impact.md'));
  assert(fs.statSync(target).isFile(), 'destino do contrato deve ser arquivo');
  const realTarget = fs.realpathSync(target);
  const relativeTarget = path.relative(fs.realpathSync(root), realTarget);
  assert(!path.isAbsolute(relativeTarget) && relativeTarget !== '..' && !relativeTarget.startsWith(`..${path.sep}`),
    'destino real do contrato deve permanecer no CODE_DIR');
  assert.strictEqual(realTarget, path.join(fs.realpathSync(root), 'shared/forge-release-impact.md'));
  // Nenhum SHA historico e resolvido via Git: presenca lexical nao prova semantica.
});

function git(cwd, args, input) {
  const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', shell: false, input });
  assert.strictEqual(out.status, 0, out.stderr);
  assert(!out.error, out.error && out.error.message);
  return out.stdout.trim();
}
const observed = [];
check('CHECK-EXAMPLES-HELPER-AGREES', () => {
  for (const example of fixture.examples) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-impact-example-'));
    try {
      git(cwd, ['init', '-q']);
      for (const [key, value] of [['commit.gpgsign', 'false'], ['tag.gpgSign', 'false'], ['core.autocrlf', 'false'],
        ['user.email', 'forge@example.invalid'], ['user.name', 'Forge Test']]) git(cwd, ['config', key, value]);
      git(cwd, ['commit', '-q', '--allow-empty', '-m', 'chore: base']);
      git(cwd, ['tag', example.base_tag]);
      for (const message of example.messages) git(cwd, ['-c', 'commit.cleanup=verbatim', 'commit', '-q', '--allow-empty', '-F', '-'], message);
      const resolution = api.resolveVersion(cwd);
      assert.strictEqual(resolution.bump, example.expect.bump, example.id);
      assert.strictEqual(resolution.new_tag, example.expect.new_tag, example.id);
      assert.strictEqual(resolution.impact.status, example.expect.impact_status, example.id);
      let code = 'ok';
      try { assert.strictEqual(api.checkDeclaredVersion(resolution, example.declared_version).ok, true); }
      catch (error) { code = error.code; }
      assert.strictEqual(code, example.expect.check, example.id);
      fs.mkdirSync(path.join(cwd, 'scripts'));
      for (const file of ['forge-release-version.js', 'forge-release-impact.js', 'forge-version.js']) {
        fs.copyFileSync(path.join(__dirname, file), path.join(cwd, 'scripts', file));
      }
      fs.writeFileSync(path.join(cwd, 'VERSION'), example.declared_version);
      const notes = path.join(cwd, 'notes.md');
      // --notes sem --check permite inspecionar notas inclusive dos negativos.
      const cli = spawnSync(process.execPath, [path.join(cwd, 'scripts/forge-release-version.js'), '--notes', notes],
        { cwd, encoding: 'utf8', shell: false });
      assert.strictEqual(cli.status, 0, `${example.id}: ${cli.stderr}`);
      assert.deepStrictEqual(JSON.parse(cli.stdout), resolution);
      observed.push({ id: example.id, resolution, code, notes: fs.readFileSync(notes, 'utf8') });
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  }
  assert.strictEqual(observed.length, fixture.examples.length);
});

check('CHECK-EXAMPLES-CHANGELOG', () => {
  for (const example of fixture.examples) {
    const actual = observed.find(row => row.id === example.id);
    const sections = new Map();
    let section;
    for (const line of actual.notes.split('\n')) {
      if (line.startsWith('### ')) { section = line.slice(4); sections.set(section, []); }
      else if (line.startsWith('- ')) { assert(section); sections.get(section).push(line); }
    }
    const order = ['Breaking Changes', 'Features', 'Bug Fixes', 'Other Changes'];
    assert.deepStrictEqual([...sections.keys()], order.filter(name => example.expect.changelog_sections.includes(name)));
    assert.strictEqual([...sections.values()].flat().length, example.messages.length);
    example.messages.forEach((message, index) => {
      const subject = message.split(/\r?\n\r?\n/)[0].replace(/\s+/g, ' ').trim();
      assert(sections.get(example.expect.changelog_sections[index]).some(line => line.startsWith(`- ${subject} (`)), example.id);
    });
  }
});

check('CHECK-EXAMPLES-CLASS-COVERAGE', () => {
  for (const bump of ['major', 'minor', 'patch']) assert(observed.some(row => row.resolution.bump === bump && row.code === 'ok'));
  for (const id of ['conflict-removal', 'resolved-removal', 'invalid-declaration', 'mismatched-version', 'D2-docs-conflict']) {
    assert(observed.some(row => row.id === id));
  }
  assert.strictEqual(observed.find(row => row.id === 'D2-docs-conflict').code, 'impact-label-conflict');
  const real = fixture.examples.filter(row => row.origin === 'real');
  const illustrative = fixture.examples.filter(row => row.origin === 'illustrative');
  assert(real.length > 0 && illustrative.length > 0);
  // Examples reproduce messages; contract classification is not inferred from labels.
  console.log(`info - examples real=${real.length} illustrative=${illustrative.length}`);
});

check('CHECK-EXAMPLES-S08-JUSTIFIED', () => {
  const entry = fixture.contracts.find(row => row.id === 'S08-impact');
  assert(entry && entry.slice === 'S08' && entry.baseline === 'last-tag' && entry.evidence.length >= 5);
  assert.strictEqual(entry.bump, 'minor');
  assert(entry.example_ids.length >= 2);
  for (const id of entry.example_ids) {
    const row = observed.find(item => item.id === id);
    assert.strictEqual(row.resolution.bump, entry.bump); assert.strictEqual(row.code, 'ok');
  }
  // Concordancia executavel nao substitui revisao documental independente.
});
