#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const api = require('./forge-release-version.js');
const { SURFACES, KINDS, KIND_BUMP } = require('./forge-release-impact.js');

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

check('CHECK-EXAMPLES-SCHEMA', () => {
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
  assert(!real.some(row => row.expect.bump === 'major'), 'nao fabricar major publico real');
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
