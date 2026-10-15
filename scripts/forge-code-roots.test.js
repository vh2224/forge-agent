'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const roots = require('./forge-code-roots');
function command(bin, args, cwd) {
  const result = spawnSync(bin, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.strictEqual(result.status, 0, `${bin} ${args.join(' ')}: ${result.stderr || result.error}`); return result.stdout.trim();
}
function laboratory(label) {
  const base = path.join(os.tmpdir(), 'codex', 'T-20261015172849-corrigir-contrato-multi', 'labs');
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, label + '-'));
  fs.writeFileSync(path.join(dir, '.owner'), label);
  return { dir, cleanup() {
    const physical = fs.realpathSync(dir), parent = fs.realpathSync(base);
    assert(roots.within(parent, physical) && roots.key(physical) !== roots.key(parent));
    assert.strictEqual(fs.readFileSync(path.join(physical, '.owner'), 'utf8'), label);
    fs.rmSync(physical, { recursive: true });
  } };
}
function checkout(dir, vcs = 'git', remote) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  if (vcs === 'svn') {
    if (!remote) { remote = dir + '-repository'; command('svnadmin', ['create', remote]); }
    command('svn', ['checkout', require('url').pathToFileURL(remote).href, dir]);
  } else {
    fs.mkdirSync(dir); command('git', ['init', '-q'], dir);
    command('git', ['config', 'core.autocrlf', 'false'], dir);
    command('git', ['config', 'user.email', 'fixture@example.invalid'], dir);
    command('git', ['config', 'user.name', 'Fixture'], dir);
  }
  if (vcs === 'svn' && fs.existsSync(path.join(dir, 'same.txt'))) return dir;
  fs.writeFileSync(path.join(dir, 'same.txt'), 'before\n');
  if (vcs === 'svn') { command('svn', ['add', 'same.txt'], dir); command('svn', ['commit', '-m', 'fixture'], dir); command('svn', ['update'], dir); }
  else { command('git', ['add', 'same.txt'], dir); command('git', ['commit', '-qm', 'fixture'], dir); }
  return dir;
}
function fixture(vcs = 'git') {
  const lab = laboratory(vcs), owner = path.join(lab.dir, 'owner'); fs.mkdirSync(owner);
  const a = checkout(path.join(lab.dir, 'a', 'same'), vcs), b = checkout(path.join(lab.dir, 'b', 'same'), vcs);
  return { ...lab, owner, a, b, contract: roots.validateContract({ schema_version: 2, owner, primary_root_id: 'alpha', code_roots: [{ id: 'alpha', path: a }, { id: 'beta', path: b }] }) };
}
function plan(contract, absolute = false) {
  const values = contract.code_roots.map(r => absolute ? path.join(r.path, 'same.txt').replace(/\\/g, '/') : `${r.id}::same.txt`);
  return `---\nid: T-roots\ntier: standard\neffort: medium\ndepends: []\n`
    + (absolute ? '' : `roots_schema: 2\nprimary_root_id: ${contract.primary_root_id}\ncode_roots:\n${contract.code_roots.map(r => `  - id: ${r.id}\n    path: '${r.path.replace(/\\/g, '/')}'\n    vcs: ${r.vcs}\n`).join('')}`)
    + `writes:\n${values.map(v => `  - '${v}'`).join('\n')}\nexpected_output:\n${values.map(v => `  - '${v}'`).join('\n')}\nmust_haves:\n  truths:\n    - 'Both roots contain the result.'\n  artifacts:\n${values.map(v => `    - path: '${v}'\n      provides: 'Result'\n      min_lines: 1`).join('\n')}\n  key_links: []\n---\n## Description\nChange both files.\n## Steps\n1. Apply.\n## Must-Haves\nBoth outputs.\n## Standards\nUse the existing text format.\n## Files to Change\nBoth files.\n`;
}
function main() {
  const f = fixture();
  const checked = roots.validatePlan(plan(f.contract), f.contract);
  assert.deepStrictEqual(checked.writes.map(r => r.root_id), ['alpha', 'beta']);
  const legacy = plan(f.contract, true), migrated = roots.normalizeAbsolutePaths(legacy, f.contract);
  assert.strictEqual(migrated.schema_version, 2); assert.strictEqual(migrated.mapping.length, 2);
  assert(migrated.content.includes("- 'Both roots contain the result.'"));
  assert.strictEqual(roots.validatePlan(migrated.content, f.contract).outputs.length, 2);
  for (const value of ['alpha::../secret', 'unknown::same.txt', 'alpha::C:relative', 'alpha::file:stream', 'alpha:://server/share', 'alpha::.gsd/events']) assert.throws(() => roots.resolvePath(f.contract, value));
  assert.throws(() => roots.validateContract({ ...f.contract, code_roots: [{ id: 'alpha', path: f.a }, { id: 'beta', path: f.a }] }), /roots-overlap/);
  assert.throws(() => roots.normalizeAbsolutePaths(legacy.replaceAll(f.contract.code_roots[1].path.replace(/\\/g, '/'), f.owner.replace(/\\/g, '/')), f.contract), /absolute-path-ambiguous/);
  assert.throws(() => roots.validatePlan(plan(f.contract).replace('beta::same.txt', 'beta::other.txt'), f.contract), /outside-writes/);
  assert.throws(() => roots.validatePlan(plan(f.contract).replace('depends: []\n', ''), f.contract), /depends-required/);
  assert.throws(() => roots.claimGroups({ schema_version: 3, paths: [] }), /schema-unsupported/);
  for (const replacement of ['expected_output: []', 'expected_output: [beta::outside.txt]']) {
    assert.throws(() => roots.validatePlan(plan(f.contract).replace(/expected_output:\n(?:  -[^\n]+\n)+/, replacement + '\n'), f.contract));
  }
  const alias = path.join(f.dir, 'alias'); fs.symlinkSync(f.a, alias, 'junction');
  assert.throws(() => roots.validateContract({ ...f.contract, code_roots: [{ id: 'alpha', path: f.a }, { id: 'beta', path: alias }] }), /link|overlap/);
  const inner = checkout(path.join(f.a, 'inner'));
  assert.throws(() => roots.validateContract({ ...f.contract, code_roots: [{ id: 'alpha', path: f.a }, { id: 'beta', path: inner }] }), /overlap/);
  assert(roots.within(fs.realpathSync.native(f.dir), fs.realpathSync.native(f.b)));
  fs.renameSync(f.b, f.b + '-old'); checkout(f.b);
  assert.throws(() => roots.validateContract(f.contract, { revalidate: true }), /identity/);
  f.cleanup(); console.log('PASS roots identities, positive migration, criteria, paths and unknown schemas');
  const svn = laboratory('svn-same-url'), owner = path.join(svn.dir, 'owner'); fs.mkdirSync(owner);
  const remote = path.join(svn.dir, 'remote'); command('svnadmin', ['create', remote]);
  const a = checkout(path.join(svn.dir, 'one'), 'svn', remote), b = checkout(path.join(svn.dir, 'two'), 'svn', remote);
  const separate = roots.validateContract({ schema_version: 2, owner, primary_root_id: 'a', code_roots: [{ id: 'a', path: a }, { id: 'b', path: b }] });
  assert.notStrictEqual(separate.code_roots[0].identity_sha256, separate.code_roots[1].identity_sha256);
  svn.cleanup(); console.log('PASS SVN checkouts with the same repository URL retain distinct physical identities');
}
module.exports = { laboratory, checkout, fixture, plan, command };
if (require.main === module) main();
