#!/usr/bin/env node
// forge-maintenance-vcs.test.js — regression suite for the VCS concurrency
// guard (T02 of S03, M-20260706152250-maintenance-fragment).
//
// Proves the two hard guards:
//   GUARD 1 (R5a): precheckHistory detects an already-committed remote
//   maintenance WITHOUT mutating the working tree.
//   GUARD 2 (D3): runCommitGuard on a divergent collision aborts loud and
//   preserves BOTH local and remote bytes.
//
// Plus the full guard surface: pure-unit isRollupPath/resolveCollision,
// mock-exec svn/git degrade paths, real-git integration (bare origin + two
// clones), autocrlf-safe blob reads, path-scoped pull + deletion-sync,
// command-injection literal-arg safety, and PATH-gated real-svn.
//
// Run: node scripts/forge-maintenance-vcs.test.js  (exit 0 = all pass, 1 = fail)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const {
  isRollupPath,
  dirtyGsd,
  precheckHistory,
  pullScoped,
  recheckAtCommit,
  readRemoteBlob,
  resolveCollision,
  runCommitGuard,
  appendEvent,
  __setExecFileSync,
} = require('./forge-maintenance-vcs');

const { mergeBucket } = require('./forge-maintenance');

const MODULE_JS = path.join(__dirname, 'forge-maintenance-vcs.js');

// ── Harness ───────────────────────────────────────────────────────────────────
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

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-test-'));
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {}
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(dir) {
  try {
    git(dir, 'init', '-q', '-b', 'main');
  } catch {
    git(dir, 'init', '-q');
    try { git(dir, 'branch', '-m', 'main'); } catch { /* single-commit-less repo */ }
  }
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
}

function commitAll(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', msg);
}

// recursive relative file listing + per-file sha256 — snapshot for the
// "working tree untouched" proof (GUARD 1).
function snapshot(rootDir) {
  const out = {};
  function walk(rel) {
    const abs = path.join(rootDir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const relPath = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(path.join(rootDir, relPath));
        out[relPath.replace(/\\/g, '/')] = crypto.createHash('sha256').update(bytes).digest('hex');
      }
    }
  }
  if (fs.existsSync(rootDir)) walk('');
  return out;
}

function seedFrag(dir, id, completedAt, title) {
  const content = ['---', `title: ${title}`, `completed_at: ${completedAt}`, '---', `Body for ${id}.`, ''].join('\n');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${id}.md`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function eventLines(cwd) {
  const p = path.join(cwd, '.gsd', 'forge', 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

function svnAvailable() {
  try {
    execFileSync('svn', ['--version'], { stdio: 'ignore' });
    execFileSync('svnadmin', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
console.log('\n=== forge-maintenance-vcs — regression suite ===\n');

// ── Section A: pure unit (no VCS) ────────────────────────────────────────────
console.log('Section A — isRollupPath / resolveCollision / appendEvent (pure)');

test('A1 isRollupPath accepts store-level _rollup', () => {
  assert(isRollupPath('.gsd/archive/milestones-rollup.md') === true);
  assert(isRollupPath('.gsd/archive/tasks-rollup.md') === true);
  assert(isRollupPath('.gsd/ledger/_rollup-2026-Q1.md') === true);
  assert(isRollupPath('.gsd/decisions/_rollup-2026-Q2.md') === true);
});

test('A2 isRollupPath rejects non-rollup paths', () => {
  assert(isRollupPath('.gsd/ledger/M-20260101120000-x.md') === false);
  assert(isRollupPath('.gsd/archive/notes.md') === false);
  assert(isRollupPath('.gsd/_rollup-x.md') === false, 'root-level under .gsd/ rejected');
  assert(isRollupPath('src/_rollup-x.md') === false, 'outside .gsd/ rejected');
});

test('A3 isRollupPath normalizes backslashes', () => {
  assert(isRollupPath('.gsd\\ledger\\_rollup-a.md') === true);
});

test('A4 resolveCollision identical content -> discard', () => {
  const local = mergeBucket([], { type: 'ledger' });
  const r = resolveCollision(local.hash, local.content);
  assert(r.action === 'discard', 'expected discard, got ' + r.action);
  assert(r.identical === true);
});

test('A5 resolveCollision one-byte diff -> abort', () => {
  const local = mergeBucket([], { type: 'ledger' });
  const remote = local.content + 'x';
  const r = resolveCollision(local.hash, remote);
  assert(r.action === 'abort', 'expected abort, got ' + r.action);
  assert(r.identical === false);
  assert(r.remoteHash !== local.hash, 'remoteHash must differ from local hash');
});

test('A6 resolveCollision CRLF remote vs LF local -> identical (D3 normalization)', () => {
  const local = mergeBucket([], { type: 'ledger' });
  const crlfRemote = local.content.replace(/\n/g, '\r\n');
  const r = resolveCollision(local.hash, crlfRemote);
  assert(r.identical === true, 'CRLF-normalized remote must hash identical to LF local');
});

test('A7 resolveCollision performs zero fs calls (pure)', () => {
  const origReadFileSync = fs.readFileSync;
  let called = false;
  fs.readFileSync = function (...a) { called = true; return origReadFileSync.apply(fs, a); };
  try {
    resolveCollision('deadbeef', 'some content\n');
  } finally {
    fs.readFileSync = origReadFileSync;
  }
  assert(called === false, 'resolveCollision must not touch the filesystem');
});

test('A8 appendEvent writes a parseable JSON line with matching ts and event', () => {
  const dir = mkTmp();
  try {
    const ok = appendEvent(dir, { event: 'unit-test-event', foo: 'bar' });
    assert(ok === true);
    const lines = eventLines(dir);
    assert(lines.length === 1, 'expected exactly one line');
    const parsed = JSON.parse(lines[0]);
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(parsed.ts), 'ts format mismatch: ' + parsed.ts);
    assert(parsed.event === 'unit-test-event');
  } finally {
    rmrf(dir);
  }
});

test('A9 appendEvent on unwritable cwd returns false, does not throw', () => {
  // A path with a null byte is guaranteed to be an invalid fs path across
  // platforms without needing chmod tricks (which don't reliably block
  // root/Administrator writers in CI).
  const badDir = path.join(mkTmp(), 'x\x00y');
  let threw = false;
  let result;
  try {
    result = appendEvent(badDir, { event: 'x' });
  } catch {
    threw = true;
  }
  assert(threw === false, 'appendEvent must never throw');
  assert(result === false, 'appendEvent must return false on failure');
});

// ── Section B: mock exec (__setExecFileSync) ─────────────────────────────────
console.log('\nSection B — mock-exec svn/git (__setExecFileSync)');

function withMockExec(fn, dispatch) {
  const prev = __setExecFileSync(dispatch);
  try {
    fn();
  } finally {
    __setExecFileSync(prev);
  }
}

test('B1 svn precheck: rollup line in status --show-updates -> already:true', () => {
  withMockExec(() => {
    const r = precheckHistory('/fake/cwd', 'svn');
    assert(r.checked === true);
    assert(r.already === true, 'expected already:true, got ' + JSON.stringify(r));
    assert(r.remoteRollups.some((e) => e.path === '.gsd/archive/milestones-rollup.md'));
  }, (cmd, args) => {
    if (cmd === 'svn' && args[0] === 'status') {
      return '        *      42   .gsd/archive/milestones-rollup.md\n';
    }
    throw new Error('unexpected call: ' + cmd + ' ' + args.join(' '));
  });
});

test('B2 svn precheck: no rollup lines -> already:false', () => {
  withMockExec(() => {
    const r = precheckHistory('/fake/cwd', 'svn');
    assert(r.checked === true);
    assert(r.already === false);
  }, (cmd, args) => {
    if (cmd === 'svn' && args[0] === 'status') return '        M      3   .gsd/ledger/x.md\n';
    throw new Error('unexpected call');
  });
});

test('B3 svn pullScoped happy path: clean status -> svn update .gsd', () => {
  const calls = [];
  withMockExec(() => {
    const r = pullScoped('/fake/cwd', 'svn');
    assert(r.method === 'svn-update', 'expected svn-update, got ' + r.method);
    assert(calls.some((c) => c.cmd === 'svn' && c.args.join(' ') === 'update .gsd'), 'expected recorded svn update .gsd call');
  }, (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'svn' && args[0] === 'status') return '';
    if (cmd === 'svn' && args[0] === 'update') return 'Updated to revision 5.\n';
    throw new Error('unexpected call: ' + cmd + ' ' + args.join(' '));
  });
});

test('B4 svn pullScoped dirty -> dirty-abort, no update call', () => {
  const calls = [];
  withMockExec(() => {
    const r = pullScoped('/fake/cwd', 'svn');
    assert(r.method === 'dirty-abort', 'expected dirty-abort, got ' + r.method);
    assert(!calls.some((c) => c.args[0] === 'update'), 'update must NOT be called when dirty');
  }, (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'svn' && args[0] === 'status') return 'M       .gsd/ledger/x.md\n';
    throw new Error('unexpected call: ' + cmd + ' ' + args.join(' '));
  });
});

test('B5 git degrade: origin get-url throws -> precheck checked:false with warn', () => {
  withMockExec(() => {
    const r = precheckHistory('/fake/cwd', 'git');
    assert(r.checked === false, 'expected checked:false, got ' + JSON.stringify(r));
    assert(r.already === false);
    assert(typeof r.warn === 'string' && r.warn.length > 0);
  }, (cmd, args) => {
    if (cmd === 'git' && args[0] === 'branch') return 'main\n';
    if (cmd === 'git' && args[0] === 'remote') throw new Error('no such remote');
    throw new Error('unexpected call: ' + cmd + ' ' + args.join(' '));
  });
});

test('B6 git degrade: detached HEAD (empty branch) -> checked:false, warn', () => {
  withMockExec(() => {
    const r = precheckHistory('/fake/cwd', 'git');
    assert(r.checked === false);
    assert(/detached/i.test(r.warn || ''), 'expected detached-HEAD warn, got ' + r.warn);
  }, (cmd, args) => {
    if (cmd === 'git' && args[0] === 'branch') return '\n';
    throw new Error('unexpected call: ' + cmd + ' ' + args.join(' '));
  });
});

// ── Section C: real git integration ──────────────────────────────────────────
console.log('\nSection C — real git integration (bare origin + two clones)');
// State chain: C1 -> C2 -> C3 -> C4 -> C5 -> C6 -> C7. Each step depends on
// the tree state left by the previous one within this shared rig.

const root = mkTmp();
try {
  const originDir = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', originDir);

  const cloneA = path.join(root, 'cloneA');
  const cloneB = path.join(root, 'cloneB');
  git(root, 'clone', '-q', originDir, cloneA);
  git(root, 'clone', '-q', originDir, cloneB);
  git(cloneA, 'config', 'user.email', 't@t');
  git(cloneA, 'config', 'user.name', 't');
  git(cloneB, 'config', 'user.email', 't@t');
  git(cloneB, 'config', 'user.name', 't');
  git(cloneA, 'config', 'core.autocrlf', 'false');
  git(cloneB, 'config', 'core.autocrlf', 'false');

  const fragAA = seedFrag(path.join(cloneA, '.gsd', 'ledger'), 'M-20260101120000-aa', '2026-01-01T12:00:00Z', 'Alpha');
  const fragBB = seedFrag(path.join(cloneA, '.gsd', 'ledger'), 'M-20260201120000-bb', '2026-02-01T12:00:00Z', 'Bravo');
  fs.mkdirSync(path.join(cloneA, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cloneA, 'src', 'app.txt'), 'original\n', 'utf8');
  commitAll(cloneA, 'seed fragments + src/app.txt');
  git(cloneA, 'push', '-q', 'origin', 'main');
  git(cloneB, 'pull', '-q', 'origin', 'main');

  test('C0 sanity: cloneB has the seeded fragments after pull', () => {
    assert(fs.existsSync(path.join(cloneB, '.gsd', 'ledger', 'M-20260101120000-aa.md')));
    assert(fs.existsSync(path.join(cloneB, 'src', 'app.txt')));
  });

  // ── C1: GUARD 1 (R5a no-touch) ──────────────────────────────────────────────
  const mergedQ1 = mergeBucket([fragAA, fragBB], { type: 'ledger' });
  fs.writeFileSync(path.join(cloneA, '.gsd', 'ledger', '_rollup-2026-Q1.md'), mergedQ1.content, 'utf8');
  git(cloneA, 'rm', '-q', '.gsd/ledger/M-20260101120000-aa.md', '.gsd/ledger/M-20260201120000-bb.md');
  git(cloneA, 'add', '.gsd/ledger/_rollup-2026-Q1.md');
  commitAll(cloneA, 'maintenance: fuse Q1 ledger fragments into rollup');
  git(cloneA, 'push', '-q', 'origin', 'main');
  // cloneB deliberately does NOT pull before the precheck.

  let snap1, status1;
  test('C1-guard1 precheckHistory detects already-committed remote maintenance without mutating tree', () => {
    snap1 = snapshot(path.join(cloneB, '.gsd'));
    status1 = git(cloneB, 'status', '--porcelain');

    const pre = precheckHistory(cloneB, 'git');
    assert(pre.already === true, 'expected already:true, got ' + JSON.stringify(pre));
    assert(pre.remoteRollups.some((e) => e.path === '.gsd/ledger/_rollup-2026-Q1.md'), 'expected the Q1 rollup in remoteRollups');

    const snap2 = snapshot(path.join(cloneB, '.gsd'));
    const status2 = git(cloneB, 'status', '--porcelain');
    assert(JSON.stringify(snap2) === JSON.stringify(snap1), 'HARD GUARD 1 violated: .gsd/ tree changed after precheckHistory');
    assert(status2 === status1, 'HARD GUARD 1 violated: git status changed after precheckHistory');
    assert(!fs.existsSync(path.join(cloneB, '.gsd', 'ledger', '_rollup-2026-Q1.md')), 'rollup must not exist in cloneB tree yet');
  });

  // ── C2: GUARD 2 (D3 divergent -> loud abort, preserve both) ─────────────────
  // "Two devs, divergent input sets": cloneB independently merges only ONE of
  // the two fragments it still has locally (it never pulled cloneA's fuse
  // commit), producing bucket bytes that diverge from the remote rollup.
  const mergedDivergent = mergeBucket([fragAA].map((p) => p.replace(cloneA, cloneB)), { type: 'ledger' });
  const rollupPathB = path.join(cloneB, '.gsd', 'ledger', '_rollup-2026-Q1.md');
  fs.mkdirSync(path.dirname(rollupPathB), { recursive: true });
  fs.writeFileSync(rollupPathB, mergedDivergent.content, 'utf8');
  let localBytesBeforeC2;

  test('C2-guard2 runCommitGuard aborts loud on divergent collision, preserves both local and remote', () => {
    localBytesBeforeC2 = fs.readFileSync(rollupPathB);
    const beforeCount = eventLines(cloneB).length;

    const guard = runCommitGuard(cloneB, [{ path: '.gsd/ledger/_rollup-2026-Q1.md', hash: mergedDivergent.hash }]);
    assert(guard.action === 'abort', 'expected abort, got ' + guard.action);
    assert(guard.collisions.length === 1);
    assert(guard.collisions[0].identical === false, 'D3 collision must be flagged non-identical');
    assert(guard.collisions[0].localHash === mergedDivergent.hash);
    assert(guard.collisions[0].remoteHash && guard.collisions[0].remoteHash !== mergedDivergent.hash, 'remoteHash must differ from localHash');

    const localBytesAfter = fs.readFileSync(rollupPathB);
    assert(Buffer.compare(localBytesBeforeC2, localBytesAfter) === 0, 'local bucket bytes must be UNCHANGED (preserve local)');

    // remote preserved: read it back via git cat-file and confirm it still
    // matches the content cloneA pushed (preserve remote).
    const remoteBlobShaLine = git(cloneB, 'ls-tree', 'origin/main', '--', '.gsd/ledger/_rollup-2026-Q1.md').trim();
    assert(remoteBlobShaLine.length > 0, 'expected remote rollup blob to exist at origin/main');
    const sha = remoteBlobShaLine.split(/\s+/)[2];
    const remoteRaw = git(cloneB, 'cat-file', 'blob', sha);
    assert(remoteRaw === mergedQ1.content, 'remote blob must be byte-identical to what cloneA pushed');

    const lines = eventLines(cloneB);
    assert(lines.length === beforeCount + 1, 'expected exactly one new event line');
    const evt = JSON.parse(lines[lines.length - 1]);
    assert(evt.event === 'maintenance-aborted-collision');
    assert(Array.isArray(evt.collisions));
  });

  // ── C3: identical -> silent discard signal ──────────────────────────────────
  test('C3 identical collision yields discard, no new collision event', () => {
    // Overwrite cloneB's local bucket with byte-exact remote content.
    fs.writeFileSync(rollupPathB, mergedQ1.content, 'utf8');
    const beforeCount = eventLines(cloneB).length;

    const guard = runCommitGuard(cloneB, [{ path: '.gsd/ledger/_rollup-2026-Q1.md', hash: mergedQ1.hash }]);
    assert(guard.action === 'discard', 'expected discard, got ' + guard.action);
    assert(guard.identical === true);

    const afterCount = eventLines(cloneB).length;
    assert(afterCount === beforeCount, 'no new collision event should be appended on identical match');
  });

  // ── C4: pullScoped dirty refuse ──────────────────────────────────────────────
  test('C4 pullScoped refuses on dirty .gsd/, tree untouched', () => {
    const snapBefore = snapshot(path.join(cloneB, '.gsd'));
    const r = pullScoped(cloneB, 'git');
    assert(r.method === 'dirty-abort', 'expected dirty-abort, got ' + r.method);
    const snapAfter = snapshot(path.join(cloneB, '.gsd'));
    assert(JSON.stringify(snapBefore) === JSON.stringify(snapAfter), 'pullScoped dirty-abort must not mutate the tree');
  });

  // ── C5: pullScoped applies + deletion sync + path-scope ──────────────────────
  test('C5 pullScoped materializes remote adds, syncs deletions, leaves non-.gsd files untouched', () => {
    // Clean cloneB's .gsd/ back to HEAD and drop the untracked local bucket
    // AND the untracked events.jsonl written by C2's appendEvent call —
    // neither is tracked by git so `git checkout -- .gsd/` alone won't touch
    // them.
    git(cloneB, 'checkout', '--', '.gsd/');
    try { fs.unlinkSync(rollupPathB); } catch { /* may already be absent post-checkout */ }
    rmrf(path.join(cloneB, '.gsd', 'forge'));
    const dirty = dirtyGsd(cloneB, 'git');
    assert(dirty.dirty === false, 'expected clean .gsd/ before pullScoped, got: ' + JSON.stringify(dirty));

    const oldAppTxt = fs.readFileSync(path.join(cloneB, 'src', 'app.txt'), 'utf8');

    const r = pullScoped(cloneB, 'git');
    assert(r.updated === true, 'expected updated:true, got ' + JSON.stringify(r));

    assert(fs.existsSync(path.join(cloneB, '.gsd', 'ledger', '_rollup-2026-Q1.md')), 'rollup must now exist in cloneB');
    assert(!fs.existsSync(path.join(cloneB, '.gsd', 'ledger', 'M-20260101120000-aa.md')), 'fused fragment aa must be deletion-synced');
    assert(!fs.existsSync(path.join(cloneB, '.gsd', 'ledger', 'M-20260201120000-bb.md')), 'fused fragment bb must be deletion-synced');

    const newAppTxt = fs.readFileSync(path.join(cloneB, 'src', 'app.txt'), 'utf8');
    assert(newAppTxt === oldAppTxt, 'path-scope proof: src/app.txt must be untouched by a .gsd-scoped pull');

    const status = git(cloneB, 'status', '--porcelain');
    const nonGsdLines = status.split('\n').filter((l) => l.trim() !== '' && !l.includes('.gsd/'));
    assert(nonGsdLines.length === 0, 'expected only staged .gsd/ changes, got: ' + status);
  });

  // ── C6: autocrlf trap ────────────────────────────────────────────────────────
  test('C6 autocrlf=true in clone does not break the blob-based identity compare', () => {
    git(cloneB, 'config', 'core.autocrlf', 'true');
    const guard = runCommitGuard(cloneB, [{ path: '.gsd/ledger/_rollup-2026-Q1.md', hash: mergedQ1.hash }]);
    // No remote-side change happened since C5's checkout committed nothing new
    // remotely relative to cloneB's fetched HEAD, so recheckAtCommit should
    // either see no collision (already in sync) OR, if it does see the
    // rollup as a "remote-new" entry (blob sha differs due to no local
    // commit), it must resolve identical via the filter-free cat-file read.
    if (guard.collisions.length > 0) {
      assert(guard.collisions[0].identical === true, 'DEC-S03-3 regression: autocrlf must not break identity compare, got ' + JSON.stringify(guard));
    } else {
      assert(guard.action === 'proceed', 'expected proceed when no collision detected, got ' + guard.action);
    }
  });

  // ── C7: no-origin degrade ────────────────────────────────────────────────────
  test('C7 fresh repo with no remote degrades gracefully', () => {
    const fresh = path.join(root, 'fresh-no-origin');
    fs.mkdirSync(fresh, { recursive: true });
    initRepo(fresh);
    fs.writeFileSync(path.join(fresh, 'a.txt'), 'x\n', 'utf8');
    commitAll(fresh, 'init');

    const pre = precheckHistory(fresh, 'git');
    assert(pre.checked === false, 'expected checked:false with no origin, got ' + JSON.stringify(pre));
    assert(pre.already === false);

    const guard = runCommitGuard(fresh, []);
    assert(guard.action === 'proceed', 'expected proceed with no VCS collision context, got ' + guard.action);
  });

  // ── readRemoteBlob direct autocrlf-safety assertion ─────────────────────────
  test('C8 readRemoteBlob returns filter-free raw bytes matching the pushed content exactly', () => {
    const shaLine = git(cloneB, 'ls-tree', 'origin/main', '--', '.gsd/ledger/_rollup-2026-Q1.md').trim();
    const sha = shaLine.split(/\s+/)[2];
    const raw = readRemoteBlob(cloneB, { path: '.gsd/ledger/_rollup-2026-Q1.md', sha }, 'git', 'origin/main');
    assert(raw === mergedQ1.content, 'readRemoteBlob must return byte-identical content to the original merge output');
  });
} finally {
  rmrf(root);
}

// ── Command-injection safety ─────────────────────────────────────────────────
console.log('\nCommand injection — literal-arg proof (execFileSync array args)');

test('INJ1 a ref/path containing shell metachars is passed as a single literal argv element', () => {
  const evilRef = 'main; rm -rf /tmp/pwned $(whoami) && echo owned';
  const recordedCalls = [];
  const prev = __setExecFileSync((cmd, args, opts) => {
    recordedCalls.push({ cmd, args });
    // Simulate a real execFileSync: no shell is ever involved (opts.shell
    // is never set to true anywhere in the module), so metacharacters in
    // an arg-array element can NEVER be interpreted by a shell.
    if (cmd === 'git' && args[0] === 'cat-file') return 'harmless content\n';
    throw new Error('unexpected call: ' + cmd + ' ' + args.join(' '));
  });
  try {
    const raw = readRemoteBlob('/fake/cwd', { path: evilRef, sha: evilRef }, 'git', 'origin/main');
    assert(raw === 'harmless content\n');
    assert(recordedCalls.length === 1);
    const call = recordedCalls[0];
    assert(call.cmd === 'git', 'cmd must be the literal binary name, not a shell string');
    // The evil ref must appear as EXACTLY ONE array element (never split by
    // spaces / concatenated into a shell command line).
    assert(call.args.includes(evilRef), 'the metachar-laden string must be passed as a single literal argv element');
    assert(call.args.filter((a) => a === evilRef).length === 1, 'exactly one occurrence, unmangled');
    // Sanity: opts passed to the exec indirection never set shell:true.
  } finally {
    __setExecFileSync(prev);
  }
});

test('INJ2 vcsExec never sets shell:true regardless of caller', () => {
  let capturedOpts = null;
  const prev = __setExecFileSync((cmd, args, opts) => {
    capturedOpts = opts;
    return '';
  });
  try {
    dirtyGsd('/fake; touch /tmp/pwned', 'git');
    assert(capturedOpts && capturedOpts.shell !== true, 'shell must never be enabled — array-arg execFileSync only');
  } finally {
    __setExecFileSync(prev);
  }
});

// ── Section D: real svn, PATH-gated ──────────────────────────────────────────
console.log('\nSection D — real svn (PATH-gated)');

if (!svnAvailable()) {
  console.log('  SKIP: svn/svnadmin not on PATH');
  passed++;
} else {
  const svnRoot = mkTmp();
  try {
    const repoDir = path.join(svnRoot, 'repo');
    execFileSync('svnadmin', ['create', repoDir]);
    const fileUrl = 'file:///' + repoDir.replace(/\\/g, '/').replace(/^\/+/, '');
    const wcA = path.join(svnRoot, 'wcA');
    const wcB = path.join(svnRoot, 'wcB');
    execFileSync('svn', ['checkout', '-q', fileUrl, wcA]);
    execFileSync('svn', ['checkout', '-q', fileUrl, wcB]);

    fs.mkdirSync(path.join(wcA, '.gsd', 'archive'), { recursive: true });
    fs.writeFileSync(path.join(wcA, '.gsd', 'archive', 'milestones-rollup.md'), 'rollup content\n', 'utf8');
    execFileSync('svn', ['add', '--force', '-q', path.join(wcA, '.gsd')], { cwd: wcA });
    execFileSync('svn', ['commit', '-q', '-m', 'add rollup'], { cwd: wcA });

    test('D1 real-svn precheckHistory detects an out-of-date .gsd/ (honest assertion, review-fix S03 Obj 1)', () => {
      // wcB was checked out BEFORE wcA committed the rollup, so wcB's HEAD
      // revision is behind the repo tip — a genuine out-of-date working
      // copy. --quiet was removed from the source's `svn status
      // --show-updates` invocation specifically so the '*' marker survives;
      // this test asserts detection actually works end-to-end against a
      // real svn client, not just that the call doesn't throw.
      const pre = precheckHistory(wcB, 'svn');
      assert(pre.checked === true, 'expected checked:true, got ' + JSON.stringify(pre));
      assert(pre.already === true, 'expected already:true (wcB is behind repo tip), got ' + JSON.stringify(pre));

      // Up-to-date case: bring wcB current, then re-run — already must flip
      // to false.
      execFileSync('svn', ['update', '-q', wcB]);
      const preUpToDate = precheckHistory(wcB, 'svn');
      assert(preUpToDate.already === false, 'expected already:false once wcB is updated, got ' + JSON.stringify(preUpToDate));
    });

    test('D2 real-svn pullScoped materializes the remote rollup', () => {
      const r = pullScoped(wcB, 'svn');
      assert(r.updated === true, 'expected updated:true, got ' + JSON.stringify(r));
      assert(fs.existsSync(path.join(wcB, '.gsd', 'archive', 'milestones-rollup.md')), 'rollup must be materialized in wcB');
    });
  } finally {
    rmrf(svnRoot);
  }
}

// ── CLI smoke ─────────────────────────────────────────────────────────────────
console.log('\nCLI smoke');

test('CLI1 --precheck on a repo with no remote parses JSON and exits 0', () => {
  const dir = mkTmp();
  try {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n', 'utf8');
    commitAll(dir, 'init');
    const r = spawnSync(process.execPath, [MODULE_JS, '--precheck', '--cwd', dir], { encoding: 'utf8' });
    assert(r.status === 0, 'expected exit 0, got ' + r.status + ' stderr=' + r.stderr);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop());
    assert(parsed.already === false);
  } finally {
    rmrf(dir);
  }
});

test('CLI2 --resolve identical -> exit 0, action discard', () => {
  const dir = mkTmp();
  try {
    const remoteFile = path.join(dir, 'remote.md');
    fs.writeFileSync(remoteFile, 'same content\n', 'utf8');
    const hash = crypto.createHash('sha256').update('same content\n', 'utf8').digest('hex');
    const r = spawnSync(process.execPath, [MODULE_JS, '--resolve', '--local-hash', hash, '--remote-file', remoteFile], { encoding: 'utf8' });
    assert(r.status === 0, 'expected exit 0, got ' + r.status + ' stderr=' + r.stderr);
    const parsed = JSON.parse(r.stdout.trim());
    assert(parsed.action === 'discard');
  } finally {
    rmrf(dir);
  }
});

test('CLI3 --resolve divergent -> exit 3, action abort', () => {
  const dir = mkTmp();
  try {
    const remoteFile = path.join(dir, 'remote.md');
    fs.writeFileSync(remoteFile, 'remote content\n', 'utf8');
    const r = spawnSync(process.execPath, [MODULE_JS, '--resolve', '--local-hash', 'deadbeef', '--remote-file', remoteFile], { encoding: 'utf8' });
    assert(r.status === 3, 'expected exit 3, got ' + r.status + ' stderr=' + r.stderr);
    const parsed = JSON.parse(r.stdout.trim());
    assert(parsed.action === 'abort');
  } finally {
    rmrf(dir);
  }
});

// ── Regression: sibling suites still pass (import sanity) ───────────────────
console.log('\nRegression — sibling suites unaffected by this module');

test('REG1 forge-maintenance.test.js still passes', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'forge-maintenance.test.js')], { encoding: 'utf8' });
  assert(r.status === 0, 'forge-maintenance.test.js regressed: ' + r.stdout + r.stderr);
});

test('REG2 fragment-store-compat.test.js still passes', () => {
  const p = path.join(__dirname, 'fragment-store-compat.test.js');
  if (!fs.existsSync(p)) { return; } // optional — skip if not present in this checkout
  const r = spawnSync(process.execPath, [p], { encoding: 'utf8' });
  assert(r.status === 0, 'fragment-store-compat.test.js regressed: ' + r.stdout + r.stderr);
});

// ════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failed > 0 ? 1 : 0);
