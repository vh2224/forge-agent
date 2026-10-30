#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const guard = require('./forge-native-readonly-guard');
const lease = require('./forge-unit-lease');
const runs = require('./forge-runs');
const execution = require('./forge-task-execution');
const vcs = require('./forge-vcs');
const dispatchEvent = require('./forge-dispatch-event');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-readonly-'));
const script = path.join(__dirname, 'forge-native-readonly-guard.js');
let serial = 0;
function git(root, ...args) {
  assert.ok(root.startsWith(temporary + path.sep), 'Git writes stay in own temporary repositories');
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', shell: false, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function fixture() {
  const root = path.join(temporary, `repo-${++serial}`);
  fs.mkdirSync(root); git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, '.gitignore'), '.gsd/\nignored/\n');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'fixture');
  fs.mkdirSync(path.join(root, '.gsd', 'forge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gsd', 'control.json'), '{"original":true}\n');
  fs.writeFileSync(path.join(root, '.gsd', 'forge', 'events.jsonl'), '{"event":"before"}\n');
  return root;
}
function capture(root, options = {}) {
  const result = guard.captureBaseline({ owner: root, codeRoots: [{ id: 'forge', path: root }], ...options });
  assert.equal(result.exit_code, 0, JSON.stringify(result));
  return result.baseline;
}
function verify(baseline) { return guard.verifyBaseline(baseline, { writerStopped: true }); }
function mutation(root, change, expected, options = {}) {
  const before = capture(root, options); change(root);
  const result = verify(before);
  assert.equal(result.reason, guard.REASONS.MUTATION, JSON.stringify(result));
  assert.equal(result.exit_code, 3);
  assert.ok(result.changes.some(row => row.kind === expected), JSON.stringify(result));
  assert.ok(result.changes.every(row => !path.isAbsolute(row.path) && row.root && !('content' in row)));
  return result;
}
function check(label, action) { action(); console.log(`PASS S03/T06 ${label}`); }
function cli(args) { return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 1024 * 1024 }); }

try {
  check('preexisting assume-unchanged skip-worktree refuse hidden tracked changes before spawn', () => {
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      const root = fixture(); git(root, 'update-index', flag, 'tracked.txt');
      const before = guard.captureBaseline({ owner: root, codeRoots: [{ id: 'forge', path: root }] });
      fs.writeFileSync(path.join(root, 'tracked.txt'), 'hidden mutation\n');
      if (before.ok) {
        const observed = verify(before.baseline);
        console.log(`REPRO S03/T06 preexisting ${flag}: capture=${before.exit_code}; verify=${observed.exit_code}`);
      }
      assert.equal(before.exit_code, 4, 'preexisting index visibility flags must refuse capture');
      assert.equal(before.reason, guard.REASONS.UNAVAILABLE);
      assert.equal(fs.readFileSync(path.join(root, 'tracked.txt'), 'utf8'), 'hidden mutation\n');
    }
  });
  check('exports CLI permissions exact paths and immutable capture options', () => {
    for (const name of ['captureBaseline', 'verifyBaseline']) assert.equal(typeof guard[name], 'function');
    assert.equal(typeof guard.REASONS, 'object');
    const root = fixture();
    for (const value of ['/absolute', 'C:/absolute', '.gsd/../file', '.gsd/*', '.gsd/[x]', 'outside', '.gsd/', '.gsd/./file']) {
      for (const flag of ['--allow-append', '--allow-publication']) {
        const output = cli(['--capture', '--owner', root, '--code-root', root, flag, value, '--out', path.join(temporary, 'invalid.json')]);
        assert.equal(output.status, 2, output.stdout + output.stderr);
      }
    }
    const values = ['.gsd/forge/events.jsonl'];
    const baseline = capture(root, { allowAppend: values }); values.push('.gsd/control.json');
    assert.deepEqual(baseline.permissions.allow_append, ['.gsd/forge/events.jsonl']);
    assert.equal(cli(['--capture', '--owner', root, '--out', path.join(temporary, 'missing-root.json')]).status, 2);
    assert.equal(cli(['--capture', '--owner', root, '--code-root', root, '--mode', 'other', '--out', path.join(temporary, 'bad-mode.json')]).status, 2);
  });
  check('external output physical containment case aliases exclusive wx and CLI exit0', () => {
    const root = fixture(), outside = path.join(temporary, 'baseline.json');
    const args = ['--capture', '--owner', root, '--code-root', root, '--out'];
    for (const target of [path.join(root, 'bad.json'), path.join(root, '.gsd', 'bad.json')]) assert.equal(cli([...args, target]).status, 2);
    if (process.platform === 'win32') assert.equal(cli([...args, path.join(root.toUpperCase(), 'bad.json')]).status, 2);
    const alias = path.join(temporary, 'alias'); fs.symlinkSync(root, alias, 'junction');
    assert.equal(cli([...args, path.join(alias, 'bad.json')]).status, 2);
    let output = cli([...args, outside]); assert.equal(output.status, 0, output.stdout + output.stderr);
    const bytes = fs.readFileSync(outside); output = cli([...args, outside]); assert.equal(output.status, 2);
    assert.deepEqual(fs.readFileSync(outside), bytes);
    output = cli(['--verify', outside, '--writer-stopped']); assert.equal(output.status, 0, output.stdout + output.stderr);
    assert.equal(JSON.parse(output.stdout).ok, true);
    output = cli(['--verify', outside]); assert.equal(output.status, 4); assert.equal(JSON.parse(output.stdout).reason, guard.REASONS.UNRECONCILED);
    console.log('EXAMPLE S03/T06 unchanged: exit0; writer-stopped é atestado do chamador, não prova de processo');
  });
  check('baseline VCS porcelain index dirty hashes protectedSnapshot digests and no file content', () => {
    const root = fixture(); fs.writeFileSync(path.join(root, 'tracked.txt'), 'PRIVATE_FILE_CONTENT\n');
    fs.writeFileSync(path.join(root, 'new.txt'), 'PRIVATE_NEW_CONTENT\n');
    const before = capture(root, { allowAppend: ['.gsd/forge/events.jsonl'] });
    assert.equal(before.code_roots[0].head, vcs.baselineId(root).id);
    assert.deepEqual(before.owner_snapshot, execution.protectedSnapshot(root));
    assert.ok(before.code_roots[0].status.some(row => row.code === ' M'));
    assert.ok(before.code_roots[0].status.some(row => row.code === '??'));
    assert.equal(before.code_roots[0].dirty.length, 2);
    for (const field of ['refs', 'stash', 'config', 'hooks', 'index']) assert.match(before.code_roots[0][field], /^[a-f0-9]{64}$/);
    assert.ok(before.appends[0].size > 0); assert.match(before.appends[0].sha256, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(before).includes('PRIVATE_'));
    assert.equal(verify(before).exit_code, 0);
  });
  check('tracked modified deleted new file HEAD branch tag stash config hooks and index mutations', () => {
    const cases = [
      ['modified', r => fs.writeFileSync(path.join(r, 'tracked.txt'), 'changed\n')],
      ['deleted', r => fs.unlinkSync(path.join(r, 'tracked.txt'))],
      ['added', r => fs.writeFileSync(path.join(r, 'new.txt'), 'new\n')],
      ['head', r => { fs.writeFileSync(path.join(r, 'tracked.txt'), 'committed\n'); git(r, 'add', '.'); git(r, 'commit', '-qm', 'next'); }],
      ['ref', r => git(r, 'branch', 'new-branch')], ['ref', r => git(r, 'tag', 'new-tag')],
      ['stash', r => { fs.writeFileSync(path.join(r, 'tracked.txt'), 'stashed\n'); git(r, 'stash', 'push', '-qm', 'new-stash'); }],
      ['config', r => git(r, 'config', 'fixture.changed', 'yes')],
      ['hooks', r => fs.writeFileSync(path.join(r, '.git', 'hooks', 'pre-commit'), '# fixture\n')],
    ];
    for (const [kind, action] of cases) mutation(fixture(), action, kind);
    const root = fixture(); fs.writeFileSync(path.join(root, 'tracked.txt'), 'dirty\n');
    mutation(root, r => git(r, 'add', 'tracked.txt'), 'index');
    const both = fixture(); fs.writeFileSync(path.join(both, 'tracked.txt'), 'staged\n'); git(both, 'add', 'tracked.txt');
    fs.writeFileSync(path.join(both, 'tracked.txt'), 'working\n');
    mutation(both, r => { fs.writeFileSync(path.join(r, 'tracked.txt'), 'new-stage\n'); git(r, 'add', 'tracked.txt'); fs.writeFileSync(path.join(r, 'tracked.txt'), 'working\n'); }, 'index');
    mutation(fixture(), r => git(r, 'update-index', '--assume-unchanged', 'tracked.txt'), 'index');
    const branch = fixture(); git(branch, 'branch', 'same-head');
    mutation(branch, r => git(r, 'checkout', '-q', 'same-head'), 'head');
    const hooks = fixture(), custom = path.join(hooks, 'custom-hooks'); fs.mkdirSync(custom); git(hooks, 'config', 'core.hooksPath', 'custom-hooks');
    mutation(hooks, () => fs.writeFileSync(path.join(custom, 'pre-commit'), 'hook\n'), 'hooks');
    console.log('EXAMPLE S03/T06 mutation: exit3; native-readonly-mutation-detected; relative path and kind only');
  });
  check('owner control create modify delete append rewrite truncate and bounded100 changes', () => {
    for (const action of [r => fs.writeFileSync(path.join(r, '.gsd', 'new'), 'new'), r => fs.writeFileSync(path.join(r, '.gsd', 'control.json'), '{}'), r => fs.unlinkSync(path.join(r, '.gsd', 'control.json'))]) mutation(fixture(), action, 'owner-control');
    const options = { allowAppend: ['.gsd/forge/events.jsonl'] };
    for (const value of ['rewritten prefix\n', '']) mutation(fixture(), r => fs.writeFileSync(path.join(r, '.gsd', 'forge', 'events.jsonl'), value), 'append-rewrite', options);
    const result = mutation(fixture(), r => { for (let i = 0; i < 105; i++) fs.writeFileSync(path.join(r, `.gsd/new-${i}`), 'private'); }, 'owner-control');
    assert.equal(result.changes.length, 100); assert.equal(result.truncated, true);
    assert.ok(!JSON.stringify(result).includes('private'));
  });
  check('genuine event append exact publication and unpermitted append detection', () => {
    const root = fixture(), file = path.join(root, '.gsd', 'forge', 'events.jsonl');
    const before = capture(root, { allowAppend: ['.gsd/forge/events.jsonl'], allowPublication: ['.gsd/defense.md'] });
    const denied = capture(root);
    assert.equal(dispatchEvent.main(['--events', file, '--unit', 'review/S03', '--route-json', JSON.stringify({
      engine: 'codex', model: 'fixture-model', effort: 'high', host_runtime: 'codex', resolved_worker_engine: 'codex',
      worker_mode: 'native', dispatch_allowed: true, dispatch_reason_code: 'fixture', dispatch_posture: 'native', dispatch_decision: 'allowed',
    })], { stdout: { write() {} }, stderr: { write(text) { throw new Error(text); } } }), 0);
    fs.writeFileSync(path.join(root, '.gsd', 'defense.md'), 'PRIVATE_DEFENSE');
    const result = verify(before); assert.equal(result.exit_code, 0, JSON.stringify(result));
    assert.equal(result.appended[0].path, '.gsd/forge/events.jsonl');
    assert.equal(result.allowed_publications[0].path, '.gsd/defense.md');
    assert.equal(verify(denied).exit_code, 3);
    console.log('EXAMPLE S03/T06 allowed: exact event append and defense publication; no baseline recapture');
  });
  check('genuine own lease heartbeat validRecord owner generation exact clock transitions', () => {
    const root = fixture(), unit = 'review/S03';
    const acquired = lease.acquire(root, unit, { now: 1000, ttlMs: 10000 }); assert.equal(acquired.ok, true);
    const before = capture(root, { ownLease: unit }), denied = capture(root);
    assert.equal(lease.heartbeat(root, unit, acquired.owner_token, acquired.generation, { now: 2000, ttlMs: 10000 }).ok, true);
    const result = verify(before); assert.equal(result.exit_code, 0, JSON.stringify(result));
    assert.equal(result.owner_transitions[0].kind, 'lease-heartbeat'); assert.equal(verify(denied).exit_code, 3);
    assert.ok(!JSON.stringify(before).includes(acquired.owner_token));
    for (const patch of [{ generation: 'foreign' }, { owner_token: 'foreign' }, { heartbeat_at: 1 }, { grace_ms: 7 }, { protocol_version: 99 }]) {
      const baseline = capture(root, { ownLease: unit }); const target = lease.leaseFile(root, unit); const original = fs.readFileSync(target);
      fs.writeFileSync(target, JSON.stringify({ ...JSON.parse(original), ...patch })); assert.equal(verify(baseline).exit_code, 3); fs.writeFileSync(target, original);
    }
    console.log('EXAMPLE S03/T06 own transition: lease-heartbeat allowed only with exact own-lease');
  });
  check('genuine own run heartbeat foreign heartbeat alias and nonclock mutations', () => {
    const root = fixture();
    runs.add(root, { id: 'foreign', kind: 'milestone', session_id: 'fixture', started_at: 100, last_heartbeat: 100, write_claim: null });
    runs.add(root, { id: 'own', kind: 'milestone', session_id: 'fixture', started_at: 200, last_heartbeat: 200, write_claim: null });
    const before = capture(root, { ownRun: 'own' }), denied = capture(root);
    runs.bumpHeartbeat(root, 'own', 300);
    const result = verify(before); assert.equal(result.exit_code, 0, JSON.stringify(result));
    assert.equal(result.owner_transitions[0].kind, 'run-heartbeat'); assert.equal(verify(denied).exit_code, 3);
    mutation(root, r => runs.bumpHeartbeat(r, 'foreign', 400), 'owner-control', { ownRun: 'own' });
    mutation(root, r => runs.update(r, 'own', { active: false }), 'owner-control', { ownRun: 'own' });
  });
  check('code-only ignores owner but preserves all code roots refs stash config hooks and index', () => {
    const root = fixture(); const before = capture(root, { mode: 'code-only' });
    fs.writeFileSync(path.join(root, '.gsd', 'control.json'), 'ignored in this mode');
    assert.equal(verify(before).exit_code, 0); assert.equal(before.owner_snapshot, null);
    for (const [kind, action] of [['ref', r => git(r, 'tag', 'tag')], ['config', r => git(r, 'config', 'fixture.other', 'yes')], ['hooks', r => fs.writeFileSync(path.join(r, '.git', 'hooks', 'pre-commit'), 'x')], ['modified', r => fs.writeFileSync(path.join(r, 'tracked.txt'), 'x')]]) mutation(fixture(), action, kind, { mode: 'code-only' });
    const second = fixture(), baseline = capture(root, { mode: 'code-only', codeRoots: [{ id: 'forge', path: root }, { id: 'other', path: second }] });
    fs.writeFileSync(path.join(second, 'tracked.txt'), 'other root mutation');
    assert.ok(verify(baseline).changes.some(row => row.root === 'other'));
  });
  check('fail closed writer unavailable unexpected porcelain unstable links entry and byte limits', () => {
    const root = fixture(), baseline = capture(root);
    assert.equal(guard.verifyBaseline(baseline).reason, guard.REASONS.UNRECONCILED);
    assert.equal(guard.verifyBaseline(baseline).exit_code, 4);
    const original = vcs.workingStatus;
    try { vcs.workingStatus = () => ({ ok: false, error: 'git-status-unhandled:T ' }); assert.equal(verify(baseline).reason, guard.REASONS.UNAVAILABLE); }
    finally { vcs.workingStatus = original; }
    const snapshot = execution.protectedSnapshot;
    try { let n = 0; execution.protectedSnapshot = r => { const value = snapshot(r); fs.writeFileSync(path.join(r, '.gsd', 'control.json'), String(++n)); return value; }; assert.equal(verify(baseline).reason, guard.REASONS.UNAVAILABLE); }
    finally { execution.protectedSnapshot = snapshot; }
    const linked = fixture(); fs.symlinkSync(path.join(linked, '.gsd', 'forge'), path.join(linked, '.gsd', 'link'), 'junction');
    assert.equal(guard.captureBaseline({ owner: linked, codeRoots: [linked] }).reason, guard.REASONS.UNAVAILABLE);
    const hookRoot = fixture(); fs.symlinkSync(path.join(hookRoot, '.gsd'), path.join(hookRoot, '.git', 'hooks', 'linked'), 'junction');
    assert.equal(guard.captureBaseline({ owner: hookRoot, codeRoots: [hookRoot] }).reason, guard.REASONS.UNAVAILABLE);
    const missing = path.join(temporary, 'no-vcs'); fs.mkdirSync(missing);
    assert.equal(guard.captureBaseline({ owner: missing, codeRoots: [missing] }).reason, guard.REASONS.UNAVAILABLE);
    const oversized = fixture(); fs.writeFileSync(path.join(oversized, '.git', 'hooks', 'huge'), Buffer.alloc(1024 * 1024 + 1));
    assert.equal(guard.captureBaseline({ owner: oversized, codeRoots: [oversized] }).reason, guard.REASONS.UNAVAILABLE);
    const many = fixture(); for (let i = 0; i < 20001; i++) fs.writeFileSync(path.join(many, '.gsd', `entry-${i}`), '');
    assert.equal(guard.captureBaseline({ owner: many, codeRoots: [many] }).reason, guard.REASONS.UNAVAILABLE);
    console.log('EXAMPLE S03/T06 unreconciled: exit4; native-readonly-writer-unreconciled; no process proof');
  });
  check('pt-BR detection limits no sandbox ignored outside reverted network concurrent writers no repair', () => {
    const root = fixture(), before = capture(root);
    fs.mkdirSync(path.join(root, 'ignored')); fs.writeFileSync(path.join(root, 'ignored', 'file'), 'outside coverage');
    fs.writeFileSync(path.join(root, 'tracked.txt'), 'transient'); fs.writeFileSync(path.join(root, 'tracked.txt'), 'original\n');
    const result = verify(before); assert.equal(result.exit_code, 0);
    for (const term of ['sandbox do SO', 'ignorados', 'fora das raízes', 'revertida', 'rede', 'concorrentes', 'atestado do chamador']) assert.ok(JSON.stringify(result).includes(term), term);
    assert.equal(fs.readFileSync(path.join(root, 'ignored', 'file'), 'utf8'), 'outside coverage');
    assert.equal(verify(before).exit_code, 0, 'same original baseline is reusable without recapture');
  });
  check('review native legs full guard exact permissions terminal reconciliation and unchanged248 audit', () => {
    const review = fs.readFileSync(path.join(__dirname, '..', 'shared', 'forge-review.md'), 'utf8');
    const start = review.indexOf('Nas pernas nativas somente leitura no host Codex');
    const end = review.indexOf('### Resolução de pairing', start); assert.ok(start > 0 && end > start);
    const inserted = review.slice(start, end);
    for (const term of ['challenge', 'defense', 'rebuttal', '--mode full', '--allow-append .gsd/forge/events.jsonl', '--allow-publication', 'DEFENSE_FILE', '--own-lease', '--own-run', '--writer-stopped', 'saída 3 ou 4', 'REVIEW', 'review-fix', 'reconciliação', 'Claude', 'opcional']) assert.ok(inserted.includes(term), term);
    assert.ok(!inserted.split('\n').some(line => /^(#|\*\*)/.test(line)));
    assert.deepEqual(require('./forge-dispatch-source-guard').audit(), { ok: true, root: path.resolve(__dirname, '..'), discovered_count: 248, registered_count: 248, unexpected: [], missing: [], errors: [] });
  });
  check('permissions document G2-1 modes exact allowances limits review and renderer anchors', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'codex-agent-permissions.md'), 'utf8');
    for (const term of ['forge-native-readonly-guard.js', 'code-only', 'full', '--allow-append', '--allow-publication', '--own-lease', '--own-run', '--writer-stopped', 'ignorados', 'revertida', 'concorrentes', 'rede', 'forge-review.md', 'forge-native-invocation.js', 'forge-xllm.js', 'forge-headless.js', 'forge-dispatch-policy.js', 'G2', 'Nenhum escape de sandbox foi demonstrado', 'allowlists', 'permission mode']) assert.ok(doc.includes(term), term);
  });
  check('directed links actual protectedSnapshot VCS lease validation code-roots containment and CLI', () => {
    const root = fixture(); let protectedCalls = 0, dirtyCalls = 0, statusCalls = 0, headCalls = 0, validCalls = 0;
    const originals = { snapshot: execution.protectedSnapshot, dirty: vcs.captureDirty, status: vcs.workingStatus, head: vcs.baselineId, valid: lease.validRecord };
    const own = lease.acquire(root, 'review/link', { now: 1000, ttlMs: 10000 });
    try {
      execution.protectedSnapshot = (...args) => { protectedCalls++; return originals.snapshot(...args); };
      vcs.captureDirty = (...args) => { dirtyCalls++; return originals.dirty(...args); };
      vcs.workingStatus = (...args) => { statusCalls++; return originals.status(...args); };
      vcs.baselineId = (...args) => { headCalls++; return originals.head(...args); };
      lease.validRecord = (...args) => { validCalls++; return originals.valid(...args); };
      const baseline = capture(root, { ownLease: 'review/link' });
      lease.heartbeat(root, 'review/link', own.owner_token, own.generation, { now: 2000, ttlMs: 10000 });
      assert.equal(verify(baseline).exit_code, 0);
      for (const count of [protectedCalls, dirtyCalls, statusCalls, headCalls, validCalls]) assert.ok(count >= 2);
    } finally { execution.protectedSnapshot = originals.snapshot; vcs.captureDirty = originals.dirty; vcs.workingStatus = originals.status; vcs.baselineId = originals.head; lease.validRecord = originals.valid; }
    const roots = require('./forge-code-roots'), old = roots.key; let calls = 0;
    try { roots.key = value => { calls++; return old(value); }; assert.equal(cli(['--capture']).status, 2); const output = guard.captureBaseline({ owner: root, codeRoots: [root], out: path.join(root, 'denied.json') }); assert.equal(output.exit_code, 2); assert.ok(calls > 0); }
    finally { roots.key = old; }
  });
} finally {
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3 });
}
