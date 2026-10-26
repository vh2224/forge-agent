'use strict';
const assert = require('assert');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { test, after } = require('node:test');
const isolation = require('./forge-isolation');
const original = isolation.validateWorktreeIdentity;
let calls = 0, verdict = () => true;
isolation.validateWorktreeIdentity = (...args) => { calls++; return { ok: verdict(...args) }; };
const personal = require('./forge-personal-context');
isolation.validateWorktreeIdentity = original;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-personal-alias-')));
const home = path.join(root, 'home'), owner = path.join(root, 'owner');
fs.mkdirSync(path.join(home, '.forge-personal'), { recursive: true });
fs.mkdirSync(owner);
const canonical = file => { const p = fs.realpathSync(file); return process.platform === 'win32' ? p.toLowerCase() : p; };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const aliases = [0, 1, 2].map(i => {
  const dir = path.join(root, `alias-${i}`); fs.mkdirSync(dir);
  return { path: canonical(dir), repo: canonical(owner), branch: `fixture-${i}` };
});
const source = path.join(owner, 'evidence.md'); fs.writeFileSync(source, 'fixture\n');
const aliasSource = path.join(aliases[1].path, 'evidence.md'); fs.writeFileSync(aliasSource, 'fixture\n');
const storeFile = path.join(home, '.forge-personal/context.json');
function store(sourceFile = source, count = 10) {
  const project = { path: canonical(owner), aliases, bindings: { 'TASK-001': {
    id: 'TASK-001', kind: 'task', origin: 'create', boundAt: '2026-01-01T00:00:00.000Z',
    checkpoint: { acceptances: Array.from({ length: count }, (_, i) => ({ text: `Observation ${i}`,
      source: sourceFile, hash: hash('fixture\n'), capturedAt: '2026-01-01T00:00:00.000Z', resolved: true })) },
  } } };
  fs.writeFileSync(storeFile, JSON.stringify({ schemaVersion: 1, projects: { [hash(project.path)]: project } }));
}
const snapshot = () => personal.readPersonalSnapshot({ userHome: home, cwd: owner });
test('owner sources skip all unrelated identity validators (baseline: 36)', () => {
  store(); calls = 0; verdict = () => { throw Error('alias unavailable'); };
  const value = snapshot();
  assert.equal(value.status, 'ok');
  assert(value.works[0].checkpoint.acceptances.every(c => c.validity === 'current'));
  assert.equal(calls, 0);
});
test('only containing alias is validated, freshly on every access and snapshot', () => {
  store(aliasSource); calls = 0;
  verdict = (repo, alias, branch) => { assert.equal(alias, aliases[1].path); assert.equal(branch, 'fixture-1'); return true; };
  assert(snapshot().works[0].checkpoint.acceptances.every(c => c.validity === 'current'));
  assert.equal(calls, 10);
  verdict = () => false;
  assert(snapshot().works[0].checkpoint.acceptances.every(c => c.validity === 'unreadable' && c.diagnostic === 'source-outside-project'));
  assert.equal(calls, 20);
  calls = 0; verdict = () => calls === 1;
  const rows = snapshot().works[0].checkpoint.acceptances;
  assert.equal(rows[0].validity, 'current');
  assert(rows.slice(1).every(c => c.validity === 'unreadable'), 'no cached authorization inside snapshot');
});
test('fresh hashes, missing files and corrupt store retain their diagnostics', () => {
  store(aliasSource, 1); verdict = () => true;
  fs.writeFileSync(aliasSource, 'changed');
  assert.equal(snapshot().works[0].checkpoint.acceptances[0].validity, 'stale');
  fs.unlinkSync(aliasSource);
  assert.equal(snapshot().works[0].checkpoint.acceptances[0].validity, 'missing');
  fs.writeFileSync(aliasSource, 'fixture\n');
  fs.writeFileSync(storeFile, '{');
  assert.equal(snapshot().reason, 'corrupt');
});
test('physical ancestor containment refuses symlink/junction escape even for missing file', () => {
  const foreign = path.join(root, 'foreign'), link = path.join(owner, 'escape');
  fs.mkdirSync(foreign); fs.symlinkSync(foreign, link, process.platform === 'win32' ? 'junction' : 'dir');
  store(path.join(link, 'missing.md'), 1); calls = 0; verdict = () => true;
  const row = snapshot().works[0].checkpoint.acceptances[0];
  assert.equal(row.validity, 'unreadable'); assert.equal(row.diagnostic, 'source-outside-project');
  assert.equal(calls, 0);
  fs.unlinkSync(link);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));
