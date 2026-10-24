#!/usr/bin/env node
'use strict';

// Tests for forge-claude-session.js. Every filesystem case runs inside a
// throwaway profile from fs.mkdtempSync(os.tmpdir()); the real ~/.claude is
// never read or written.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const session = require('./forge-claude-session');

let passed = 0;
let failed = 0;
const tempDirs = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}: ${error && error.stack ? error.stack : error}`);
  }
}

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claude-session-'));
  tempDirs.push(home);
  return home;
}

function profile() {
  const home = tempHome();
  const env = { HOME: home, USERPROFILE: home };
  const base = session.configDir(env, process.platform);
  fs.mkdirSync(base, { recursive: true });
  return { home, env, base };
}

function seed(base, cwd, id, key) {
  const project = path.join(base, 'projects', key || session.projectKey(cwd));
  fs.mkdirSync(path.join(project, id, 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(project, `${id}.jsonl`), '{"type":"user"}\n');
  fs.writeFileSync(path.join(project, id, 'tool-results', 'x.txt'), 'x');
  fs.mkdirSync(path.join(base, 'session-env', id), { recursive: true });
  fs.mkdirSync(path.join(base, 'file-history', id), { recursive: true });
  fs.writeFileSync(path.join(base, 'file-history', id, 'v1'), 'h');
  return project;
}

function linkType() {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

// Creates a directory link or returns null (named skip) when the OS refuses.
function tryLink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, linkType());
    return linkPath;
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      console.log(`SKIP symlink case (${linkType()}): ${error.code}`);
      return null;
    }
    throw error;
  }
}

const VALID = '3f2b8c1e-9a4d-4b7e-8c21-0d5e6f7a8b9c';

test('SESSION_ID_PATTERN accepts lowercase v4 and newSessionId matches', () => {
  assert.ok(session.SESSION_ID_PATTERN.test(VALID));
  for (let i = 0; i < 20; i += 1) assert.ok(session.SESSION_ID_PATTERN.test(session.newSessionId()));
  assert.strictEqual(session.assertSessionId(VALID), VALID);
});

test('assertSessionId refuses malformed ids with claude-session-invalid', () => {
  const bad = [
    VALID.toUpperCase(), ` ${VALID}`, `${VALID} `, `--${VALID.slice(2)}`, `${VALID}\n`, `${VALID.slice(0, 35)}`,
    `${VALID}0`, '3f2b8c1e-9a4d-1b7e-8c21-0d5e6f7a8b9c', '3f2b8c1e-9a4d-4b7e-7c21-0d5e6f7a8b9c',
    '--resume', '', null, undefined, 42, {}, ['x'], `${VALID.slice(0, 8)} ${VALID.slice(9)}`,
  ];
  for (const value of bad) {
    assert.throws(() => session.assertSessionId(value), (error) => error.code === 'claude-session-invalid'
      && error.message === 'claude-session-invalid', `accepted ${JSON.stringify(value)}`);
  }
});

test('isEligible is true only for plan and execute', () => {
  assert.deepStrictEqual([...session.SESSION_PHASES], ['plan', 'execute']);
  assert.ok(Object.isFrozen(session.SESSION_PHASES));
  assert.strictEqual(session.isEligible({ phase: 'plan' }), true);
  assert.strictEqual(session.isEligible({ phase: 'execute' }), true);
  for (const phase of ['memory', 'review', 'fix', 'artifacts', 'research', 'complete', undefined, 'PLAN']) {
    assert.strictEqual(session.isEligible({ phase }), false, String(phase));
  }
  assert.strictEqual(session.isEligible(), false);
  assert.strictEqual(session.isEligible(null), false);
});

test('projectKey replaces every non-alphanumeric character with -', () => {
  if (process.platform === 'win32') {
    assert.strictEqual(session.projectKey('C:\\Users\\a.b\\x_y'), 'C--Users-a-b-x-y');
    assert.strictEqual(
      session.projectKey('C:\\Users\\luis.ferreira\\AppData\\Local\\Temp\\forge.s05-t01.5maL'),
      'C--Users-luis-ferreira-AppData-Local-Temp-forge-s05-t01-5maL');
  } else {
    assert.strictEqual(session.projectKey('/home/a.b/x_y'), '-home-a-b-x-y');
  }
  assert.throws(() => session.projectKey(''), /cwd/);
});

test('configDir uses the child env home and ignores CLAUDE_CONFIG_DIR', () => {
  const home = tempHome();
  const other = tempHome();
  assert.strictEqual(session.configDir({ USERPROFILE: home, HOME: other, CLAUDE_CONFIG_DIR: other }, 'win32'),
    path.join(home, '.claude'));
  assert.strictEqual(session.configDir({ HOME: home, USERPROFILE: other, CLAUDE_CONFIG_DIR: other }, 'linux'),
    path.join(home, '.claude'));
});

test('sessionTargets returns exactly the closed set', () => {
  const { base } = profile();
  const cwd = path.join(base, '..', 'work.dir');
  const key = session.projectKey(cwd);
  const targets = session.sessionTargets({ configDir: base, cwd, id: VALID });
  assert.deepStrictEqual(targets, [
    { kind: 'file', path: path.join(base, 'projects', key, `${VALID}.jsonl`) },
    { kind: 'dir', path: path.join(base, 'projects', key, VALID) },
    { kind: 'dir', path: path.join(base, 'session-env', VALID) },
    { kind: 'dir', path: path.join(base, 'file-history', VALID) },
  ]);
  assert.throws(() => session.sessionTargets({ configDir: base, cwd, id: 'x' }), { code: 'claude-session-invalid' });
});

test('createSessionRef / validateSessionRef / sessionDigest', () => {
  const { base, home } = profile();
  const ref = session.createSessionRef({ id: VALID, accountName: 'acct-a', configDir: base, cwd: home, now: 0 });
  assert.ok(Object.isFrozen(ref));
  assert.deepStrictEqual(Object.keys(ref).sort(), [...session.SESSION_REF_KEYS].sort());
  assert.deepStrictEqual(ref, {
    version: 1, id: VALID, account_name: 'acct-a', config_dir: base, cwd: home, created_at: '1970-01-01T00:00:00.000Z',
  });
  assert.deepStrictEqual(session.validateSessionRef(ref), { ok: true });
  assert.strictEqual(session.validateSessionRef({ ...ref, token: 'fake-token-value' }).ok, false);
  assert.strictEqual(session.validateSessionRef({ ...ref, extra: 1 }).ok, false);
  assert.strictEqual(session.validateSessionRef({ ...ref, id: VALID.toUpperCase() }).ok, false);
  assert.strictEqual(session.validateSessionRef({ ...ref, config_dir: 'relative' }).ok, false);
  assert.strictEqual(session.validateSessionRef({ ...ref, cwd: 'rel/dir' }).ok, false);
  assert.strictEqual(session.validateSessionRef({ ...ref, version: 2 }).ok, false);
  const { created_at: _omit, ...missing } = ref;
  assert.strictEqual(session.validateSessionRef(missing).ok, false);
  assert.strictEqual(session.validateSessionRef(null).ok, false);
  assert.throws(() => session.createSessionRef({ id: 'nope', configDir: base, cwd: home }), { code: 'claude-session-ref-invalid' });
  assert.match(session.sessionDigest(VALID), /^[0-9a-f]{64}$/);
  assert.notStrictEqual(session.sessionDigest(VALID), VALID);
});

test('removeSession removes the four targets and reports relative paths', () => {
  const { base, home } = profile();
  const cwd = path.join(home, 'proj');
  const project = seed(base, cwd, VALID);
  const sibling = path.join(project, 'other.jsonl');
  fs.writeFileSync(sibling, 'keep');
  const ref = session.createSessionRef({ id: VALID, configDir: base, cwd });
  const result = session.removeSession(ref);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.refused, []);
  assert.deepStrictEqual(result.errors, []);
  assert.deepStrictEqual(result.removed.sort(), session.sessionTargets({ configDir: base, cwd, id: VALID })
    .map((t) => path.relative(base, t.path)).sort());
  for (const t of session.sessionTargets({ configDir: base, cwd, id: VALID })) assert.ok(!fs.existsSync(t.path));
  assert.ok(fs.existsSync(sibling), 'sibling kept');
  assert.ok(!JSON.stringify(result).includes('{"type"'), 'no content reported');
});

test('removeSession with absent config dir or absent targets is ok', () => {
  const home = tempHome();
  const ref = session.createSessionRef({ id: VALID, configDir: path.join(home, '.claude'), cwd: home });
  assert.deepStrictEqual(session.removeSession(ref), { ok: true, removed: [], refused: [], errors: [] });
  fs.mkdirSync(path.join(home, '.claude'));
  assert.deepStrictEqual(session.removeSession(ref), { ok: true, removed: [], refused: [], errors: [] });
  assert.throws(() => session.removeSession({ ...ref, extra: 1 }), { code: 'claude-session-ref-invalid' });
});

test('removeSession falls back one level when the computed key diverges', () => {
  const { base, home } = profile();
  const cwd = path.join(home, 'proj');
  const project = seed(base, cwd, VALID, 'C--LONG-real-key');
  const deep = path.join(base, 'projects', 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  const deepFile = path.join(deep, `${VALID}.jsonl`);
  fs.writeFileSync(deepFile, 'deep');
  const ref = session.createSessionRef({ id: VALID, configDir: base, cwd });
  const result = session.removeSession(ref);
  assert.strictEqual(result.ok, true, JSON.stringify(result));
  assert.ok(!fs.existsSync(path.join(project, `${VALID}.jsonl`)));
  assert.ok(!fs.existsSync(path.join(project, VALID)));
  assert.ok(result.removed.includes(path.join('projects', 'C--LONG-real-key', `${VALID}.jsonl`)));
  assert.ok(fs.existsSync(deepFile), 'scan is limited to one level');
});

test('removeSession refuses a symlink/junction target and keeps its destination', () => {
  const { base, home } = profile();
  const cwd = path.join(home, 'proj');
  const outside = path.join(home, 'outside-target');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious'), 'p');
  fs.mkdirSync(path.join(base, 'session-env'), { recursive: true });
  if (!tryLink(outside, path.join(base, 'session-env', VALID))) return;
  const ref = session.createSessionRef({ id: VALID, configDir: base, cwd });
  const result = session.removeSession(ref);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.refused, [{ path: path.join('session-env', VALID), reason: 'symlink' }]);
  assert.ok(fs.existsSync(path.join(outside, 'precious')), 'destination intact');
});

test('removeSession refuses a target whose parent links outside the config dir', () => {
  const { base, home } = profile();
  const cwd = path.join(home, 'proj');
  const outside = path.join(home, 'outside-history');
  fs.mkdirSync(path.join(outside, VALID), { recursive: true });
  fs.writeFileSync(path.join(outside, VALID, 'precious'), 'p');
  if (!tryLink(outside, path.join(base, 'file-history'))) return;
  const ref = session.createSessionRef({ id: VALID, configDir: base, cwd });
  const result = session.removeSession(ref);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.refused, [{ path: path.join('file-history', VALID), reason: 'outside-config-dir' }]);
  assert.ok(fs.existsSync(path.join(outside, VALID, 'precious')), 'destination intact');
});

test('removeSession refuses type mismatches and collects I/O errors without stopping', () => {
  const { base, home } = profile();
  const cwd = path.join(home, 'proj');
  fs.mkdirSync(path.join(base, 'session-env'), { recursive: true });
  fs.writeFileSync(path.join(base, 'session-env', VALID), 'file where dir expected');
  fs.mkdirSync(path.join(base, 'file-history', VALID), { recursive: true });
  const ref = session.createSessionRef({ id: VALID, configDir: base, cwd });
  const failingFs = {
    ...fs,
    rmSync(target, options) {
      if (target.includes('file-history')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.rmSync(target, options);
    },
  };
  const result = session.removeSession(ref, { fs: failingFs });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.refused, [{ path: path.join('session-env', VALID), reason: 'type-mismatch' }]);
  assert.deepStrictEqual(result.errors, [{ path: path.join('file-history', VALID), code: 'EBUSY' }]);
  assert.ok(fs.existsSync(path.join(base, 'session-env', VALID)));
});

for (const dir of tempDirs) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
