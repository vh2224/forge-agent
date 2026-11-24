#!/usr/bin/env node
'use strict';

// M017 Phase 2 — the reviewable diff of one unit in an SVN working copy.
//
// Driven by the acceptance criteria, each asserted against a REAL working copy
// (svnadmin create / checkout / commit), because every defect being fixed here
// is a property of the svn CLI's actual behavior, not of our model of it:
//   - `svn diff` unscoped is the whole shared working copy (other owners' work)
//   - `svn diff` cannot render an unversioned file at all
//   - a path containing `@` leaves the diff silently (E205000)
//   - `svn diff --name-only` does not exist, yet consumers append that flag
//
// Plus the criterion that is about NOT changing anything: the git branch of both
// boundaries must stay byte-identical, asserted against the literal text.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const engine = require('./forge-review-diff.js');

const SCRIPT = path.join(__dirname, 'forge-review-diff.js');
const REPO_ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  const match = process.argv.indexOf('--match');
  if (match !== -1 && !name.includes(process.argv[match + 1] || '\0')) return;
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${name}\n    ${error && error.message}\n`);
  }
}

// ── Pure-unit and text guards run everywhere ────────────────────────────────

test('task Git boundary remains unchanged and slice Git uses physical-root bounded inventory', () => {
  // Acceptance: "Git: comportamento byte-idêntico ao atual". The SVN work must
  // not touch these lines, so they are pinned literally.
  const task = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'forge-task', 'SKILL.md'), 'utf8');
  for (const line of [
    'GIT_DIR_FLAG="-C ${CODE_DIR:-.}"',
    'DIFF_CMD="git $GIT_DIR_FLAG diff ${START_SHA}..HEAD"',
    'DIFF_CMD="git $GIT_DIR_FLAG diff HEAD"',
  ]) {
    assert.ok(task.includes(line), `forge-task git branch changed — missing: ${line}`);
  }

  const shared = fs.readFileSync(path.join(REPO_ROOT, 'shared', 'forge-review.md'), 'utf8');
  assert.ok(shared.includes('REVIEW_CODE_DIR="${CODE_DIR:-$WORKING_DIR}"'));
  assert.ok(shared.includes('git -C "$REVIEW_CODE_DIR" rev-parse'));
  assert.ok(shared.includes('--base \\"$BASE\\"'), 'branch changes and dirty/untracked changes share one helper');
  assert.ok(!shared.includes('DIFF_CMD="git diff HEAD"'), 'untracked-only work must not silently disappear');
});

test('Git worktree diff includes untracked, staged and unstaged code without changing index or owner artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rd-git-'));
  const owner = path.join(root, 'owner'), code = path.join(root, 'code'); fs.mkdirSync(owner);
  const git = args => {
    const value = spawnSync('git', args, { cwd: owner, encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.strictEqual(value.status, 0, value.stderr); return value.stdout.trim();
  };
  const run = args => spawnSync(process.execPath, [SCRIPT, '--cwd', code, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  try {
    git(['init', '-q']); fs.writeFileSync(path.join(owner, 'tracked.js'), 'before\n'); git(['add', 'tracked.js']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    git(['worktree', 'add', '--detach', code, 'HEAD']);
    fs.mkdirSync(path.join(code, 'src')); fs.writeFileSync(path.join(code, 'src/new.js'), 'export const untracked = 42;\n');
    fs.mkdirSync(path.join(code, '.gsd')); fs.writeFileSync(path.join(code, '.gsd/private.md'), 'owner metadata sentinel');
    const initial = run([]); assert.strictEqual(initial.status, 0, initial.stderr);
    assert(initial.stdout.includes('+export const untracked = 42;')); assert(!initial.stdout.includes('owner metadata sentinel'));
    const codeGit = args => {
      const out = spawnSync('git', args, { cwd: code, encoding: 'utf8', windowsHide: true, timeout: 15000 });
      assert.strictEqual(out.status, 0, out.stderr); return out.stdout;
    };
    fs.writeFileSync(path.join(code, 'tracked.js'), 'staged\n'); codeGit(['add', 'tracked.js']);
    fs.appendFileSync(path.join(code, 'tracked.js'), 'unstaged\n');
    const before = codeGit(['status', '--porcelain=v1']), index = codeGit(['diff', '--cached', '--binary']);
    const diff = run([]); assert.strictEqual(diff.status, 0, diff.stderr);
    for (const text of ['+staged', '+unstaged', '+export const untracked = 42;']) assert(diff.stdout.includes(text), text);
    const names = run(['--name-only']); assert.strictEqual(names.status, 0, names.stderr);
    assert.deepStrictEqual(names.stdout.trim().split(/\r?\n/), ['src/new.js', 'tracked.js']);
    const shard = run(['--', 'src/new.js']); assert.strictEqual(shard.status, 0, shard.stderr);
    assert(shard.stdout.includes('+export const untracked = 42;')); assert(!shard.stdout.includes('tracked.js\n'));
    assert.strictEqual(codeGit(['status', '--porcelain=v1']), before); assert.strictEqual(codeGit(['diff', '--cached', '--binary']), index);
    fs.writeFileSync(path.join(code, 'binary.bin'), Buffer.from([0, 1, 2]));
    const binary = run([]); assert.strictEqual(binary.status, 2); assert(binary.stderr.includes('git-review-content-unavailable'));
    fs.unlinkSync(path.join(code, 'binary.bin'));
    fs.linkSync(path.join(code, 'src/new.js'), path.join(code, 'alias.js'));
    const linked = run([]); assert.strictEqual(linked.status, 2); assert(linked.stderr.includes('git-review-file-type'));
  } finally {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Git bounded untracked reads refuse growth and replacement through actual CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rd-bound-')), code = path.join(root, 'code'); fs.mkdirSync(code);
  const target = path.join(code, 'new.js'), preload = path.join(root, 'preload.cjs'), limit = 2 * 1024 * 1024;
  const git = args => { const r = spawnSync('git', args, { cwd: code, encoding: 'utf8', windowsHide: true }); assert.strictEqual(r.status, 0, r.stderr); };
  try {
    git(['init', '-q']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
    fs.writeFileSync(preload, `const fs=require('fs'),path=require('path'),target=${JSON.stringify(target)},limit=${limit};
const open=fs.openSync,read=fs.readSync,readFile=fs.readFileSync;let fd,changed=false,total=0;
fs.openSync=function(file,...args){const reading=args[0]==='r'||typeof args[0]==='number'&&(args[0]&3)===fs.constants.O_RDONLY,match=path.resolve(String(file))===target&&reading;if(match&&process.env.FORGE_RD_CASE==='replace'&&!changed){changed=true;fs.renameSync(target,target+'.old');fs.writeFileSync(target,'replacement\\n');}const actual=open.call(this,file,...args);if(match)fd=actual;return actual;};
fs.readFileSync=function(file,...args){if(typeof file==='string'&&path.resolve(file)===target)throw Error('unbounded-target-read');return readFile.call(this,file,...args);};
fs.readSync=function(descriptor,...args){if(descriptor===fd&&!changed&&process.env.FORGE_RD_CASE==='grow'){changed=true;fs.appendFileSync(target,Buffer.alloc(limit+4096,65));}const n=read.call(this,descriptor,...args);if(descriptor===fd)total+=n;return n;};
process.once('exit',()=>process.stderr.write('RD-READ-BYTES='+total+'\\n'));
`);
    for (const mode of ['grow', 'replace']) {
      fs.writeFileSync(target, 'initial\n');
      const result = spawnSync(process.execPath, ['-r', preload, SCRIPT, '--cwd', code], { encoding: 'utf8', windowsHide: true,
        env: { ...process.env, FORGE_RD_CASE: mode }, timeout: 15000, maxBuffer: 4096 });
      assert.strictEqual(result.status, 2, result.stderr); assert.strictEqual(result.stdout, '', 'unsafe data never reaches a reviewer');
      assert(result.stderr.includes(mode === 'grow' ? 'git-review-file-limit' : 'git-review-file-changed'), result.stderr);
      const bytes = Number(/RD-READ-BYTES=(\d+)/.exec(result.stderr)?.[1]); assert(Number.isFinite(bytes) && bytes > 0 && bytes <= limit + 1);
      if (fs.existsSync(target + '.old')) fs.unlinkSync(target + '.old');
    }
  } finally { assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); }
});

test('both boundaries route SVN through this program and keep the appended-arg consumers', () => {
  const task = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'forge-task', 'SKILL.md'), 'utf8');
  const shared = fs.readFileSync(path.join(REPO_ROOT, 'shared', 'forge-review.md'), 'utf8');

  assert.ok(!/Limitation declared: SVN review scoping/.test(task),
    'the Phase-2 limitation notice must be gone, not merely contradicted elsewhere');
  for (const [label, text] of [['forge-task', task], ['shared/forge-review', shared]]) {
    assert.ok(/forge-review-diff\.js/.test(text), `${label} must route SVN through the program`);
    assert.ok(/--unit-dir/.test(text), `${label} must pass a manifest source`);
  }
  // The bare command that cannot serve `--name-only` must not come back as an
  // assignment. Prose may still quote it (the spec explains why it was dropped),
  // so this matches a statement line, not any mention.
  assert.ok(!/^\s*DIFF_CMD="svn diff"\s*$/m.test(shared), 'unscoped `svn diff` must no longer be assigned to DIFF_CMD');
  assert.ok(!/svn: `svn diff`/.test(shared), 'the boundary table must not still advertise the bare command');
  assert.ok(/svn info "\$\{CODE_DIR:-\.\}"/.test(task), 'forge-task must detect SVN before falling back to git');
  assert.ok(/--scope-file/.test(shared), 'the cost policy must count the scoped diff, not the shared working copy');

  // What was NOT reviewed has to reach the artifact in both boundaries.
  for (const [label, text] of [['forge-task', task], ['shared/forge-review', shared]]) {
    assert.ok(/Escopo do diff \(SVN\)/.test(text), `${label} must disclose the scope in the artifact`);
    assert.ok(/excluded|Fora do escopo/.test(text), `${label} must name the excluded paths, not just the reviewed ones`);
  }
  // `--scope-report` is asked only where it is answered.
  assert.ok(/SCOPE_REPORT=\$\(eval "\$DIFF_CMD" --scope-report/.test(task) && /SCOPE_REPORT=\$\(eval "\$DIFF_CMD" --scope-report/.test(shared),
    'the scope report must be captured inside the SVN branch');
});

test('no-VCS review is explicitly unavailable and never falls back to a Git command', () => {
  const shared = fs.readFileSync(path.join(REPO_ROOT, 'shared', 'forge-review.md'), 'utf8');
  const branch = shared.match(/elif svn info[\s\S]*?\nelse\n([\s\S]*?)\nfi\n```/);
  assert.ok(branch, 'review VCS selection branch must remain structurally visible');
  assert.ok(branch[1].includes('VCS_UNAVAILABLE_REASON="vcs-unavailable:none-or-detection-failed"'),
    'no-VCS branch must name why review is unavailable');
  assert.ok(branch[1].includes('DIFF_CMD=""'), 'no-VCS branch must carry no executable diff command');
  assert.ok(!/git\s+diff/.test(branch[1]), 'no-VCS branch must not execute or advertise Git');
});

test('cost policy counts the scoped diff and fails open when the scope misses', () => {
  const { applyScopeFile } = require('./forge-cost-policy.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rd-policy-'));
  try {
    const diff = {
      vcs: 'svn',
      ok: true,
      warning: null,
      entries: [
        { file: 'src/ours.ts', added: 10, deleted: 0, binary: false },
        { file: 'src/theirs.ts', added: 900, deleted: 40, binary: false },
        { file: 'vendor/sdk/blob.bin', added: 0, deleted: 0, binary: true },
      ],
    };

    const scope = path.join(dir, 'scope.txt');
    fs.writeFileSync(scope, 'src/ours.ts\n', 'utf8');
    const scoped = applyScopeFile(diff, scope);
    assert.deepStrictEqual(scoped.entries.map(e => e.file), ['src/ours.ts'],
      "a colleague's 900-line change must not decide this unit's review budget");
    assert.strictEqual(scoped.scoped, 2, 'how many entries were dropped is reported');

    // Fail-open cases — a mis-applied scope must never shrink the diff to zero,
    // because a zero-entry diff decides `skip` (a silently skipped review).
    fs.writeFileSync(scope, 'nothing/here.ts\n', 'utf8');
    const missed = applyScopeFile(diff, scope);
    assert.strictEqual(missed.entries.length, 3, 'a scope that matches nothing keeps the full diff');
    assert.strictEqual(missed.warning, 'scope-file-matched-nothing');

    fs.writeFileSync(scope, '\n\n', 'utf8');
    assert.strictEqual(applyScopeFile(diff, scope).warning, 'scope-file-empty');
    assert.strictEqual(applyScopeFile(diff, path.join(dir, 'absent.txt')).warning, 'scope-file-unreadable');
    assert.strictEqual(applyScopeFile(diff, null), diff, 'no scope file is a no-op (git path untouched)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('scoping never yields an empty diff — a mis-matched manifest falls back to unscoped', () => {
  const versioned = ['src/a.ts', 'other/owner.ts'];
  const untracked = ['src/new.ts'];

  const matched = engine.computeScope({ versioned, untracked, manifest: new Set(['src/a.ts', 'src/new.ts']) });
  assert.deepStrictEqual(matched.versioned, ['src/a.ts']);
  assert.deepStrictEqual(matched.untracked, ['src/new.ts']);
  assert.strictEqual(matched.reason, 'manifest');
  assert.deepStrictEqual(matched.excluded, ['other/owner.ts'], 'what was dropped is reported, never silent');

  const disjoint = engine.computeScope({ versioned, untracked, manifest: new Set(['nothing/here.ts']) });
  assert.strictEqual(disjoint.reason, 'unscoped:manifest-matched-nothing');
  assert.deepStrictEqual(disjoint.versioned, versioned, 'a mis-fired scope reviews everything, never nothing');

  const none = engine.computeScope({ versioned, untracked, manifest: new Set() });
  assert.strictEqual(none.reason, 'unscoped:no-manifest');
  assert.deepStrictEqual(none.untracked, untracked);

  const dir = engine.computeScope({ versioned, untracked, manifest: new Set(['src']) });
  assert.deepStrictEqual(dir.versioned, ['src/a.ts'], 'a directory in the manifest covers its subtree');
});

test('manifest reader tolerates the plan shapes actually on disk', () => {
  const block = engine.readDeclaredPaths([
    '---',
    'id: T01',
    'expected_output:',
    '  - "src/a.ts"',
    '  - src/b.ts',
    'writes: [src/c.ts, src/d.ts]',
    'key_files: src/e.ts',
    'unrelated:',
    '  - not/a/path/key.ts',
    '---',
  ].join('\n'));
  assert.deepStrictEqual(block.sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts']);
  assert.doesNotThrow(() => engine.readDeclaredPaths('expected_output:\n  garbage without dash\n'));
  assert.deepStrictEqual(engine.readDeclaredPaths(''), []);
});

test('manifest reader reads the object form of must_haves.artifacts, whole', () => {
  // The shape every T##-PLAN.md in this repo writes. The nested keys of an
  // entry used to end the list at the first one — so `artifacts` contributed
  // one quote-mangled string and silently dropped every entry after it. That
  // is under-inclusion, the direction the manifest comment calls out by name.
  const declared = engine.readDeclaredPaths([
    '---',
    'expected_output:',
    '  - scripts/foo.js',
    'must_haves:',
    '  truths:',
    '    - "a behaviour, not a path"',
    '  artifacts:',
    '    - path: "scripts/bar.js"',
    '      provides: "does the thing"',
    '      min_lines: 40',
    '      stub_patterns: ["TODO", "FIXME"]',
    '    - path: scripts/baz.js',
    '      min_lines: 10',
    '      stub_patterns:',
    '        - "throw new Error\\\\(\'not implemented\'\\\\)"',
    '  key_links:',
    '    - "docs/x.md#L1 — prose"',
    '---',
  ].join('\n'));
  assert.deepStrictEqual(declared.sort(), ['scripts/bar.js', 'scripts/baz.js', 'scripts/foo.js']);
});

test('an entry\'s metadata keys never become manifest paths, and the list still ends', () => {
  const declared = engine.readDeclaredPaths([
    'artifacts:',
    '  - path: scripts/only.js',
    '    min_lines: 40',
    'writes:',
    '  - scripts/after.js',
    'key_files:',
    '  - scripts/summary.js',
  ].join('\n'));
  assert.deepStrictEqual(declared.sort(), ['scripts/after.js', 'scripts/only.js', 'scripts/summary.js'],
    'a sibling key at the list indent ends the list; metadata deeper than it does not');
  for (const entry of declared) {
    assert.ok(!/[:"']/.test(entry), `manifest entry is not a path: ${entry}`);
  }
});

test('argv batching stays under the Windows command-line ceiling', () => {
  const many = Array.from({ length: 500 }, (_, i) => `src/some/fairly/long/path/file-${i}.ts`);
  const batches = engine.batched(many);
  assert.ok(batches.length > 1, 'a 500-path diff must be split');
  assert.strictEqual(batches.flat().length, many.length, 'batching must not drop a path');
  for (const batch of batches) {
    assert.ok(batch.join(' ').length < 8000, 'each batch stays far below the 32K cap');
  }
});

test('a new file is rendered as an added-file hunk, and a binary one is not dumped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rd-untracked-'));
  try {
    fs.writeFileSync(path.join(dir, 'new.ts'), 'const a = 1;\nconst b = 2;\n');
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
    fs.writeFileSync(path.join(dir, 'noeol.ts'), 'x');

    const out = engine.untrackedDiff(dir, ['new.ts', 'blob.bin', 'noeol.ts']);
    assert.ok(out.includes('Index: new.ts'), 'svn-shaped index header');
    assert.ok(out.includes('@@ -0,0 +1,2 @@'), 'hunk counts the added lines');
    assert.ok(out.includes('+const a = 1;') && out.includes('+const b = 2;'));
    assert.ok(out.includes('Cannot display: file marked as a binary type.'), 'binary is described, not dumped');
    assert.ok(!out.includes('\0'), 'no NUL byte reaches the reviewer');
    assert.ok(out.includes('\\ No newline at end of file'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a no-VCS directory is refused instead of silently producing nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rd-nonsvn-'));
  try {
    const r = spawnSync(process.execPath, [SCRIPT, '--cwd', dir], { encoding: 'utf8' });
    assert.strictEqual(r.status, 2, 'must exit 2, not exit 0 with an empty diff');
    assert.ok(/vcs-unavailable:none-or-detection-failed/.test(r.stderr), 'stderr names the reason');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Gate — mirrors forge-smoke.js § svnGateDecision ─────────────────────────

function binaryPresent(bin) {
  try { return spawnSync(bin, ['--version', '--quiet'], { encoding: 'utf8' }).status === 0; }
  catch { return false; }
}

if (!(binaryPresent('svn') && binaryPresent('svnadmin'))) {
  if (process.env.CI && process.platform === 'linux') {
    process.stdout.write('  FAIL svn/svnadmin missing on a runner that must gate SVN behavior\n');
    failed += 1;
  } else {
    process.stdout.write('  skip real-working-copy cases — svn/svnadmin not on PATH\n');
  }
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
  return;
}

// ── Shared-working-copy fixture ─────────────────────────────────────────────
//
// Models the situation the bug was found in: one working copy, two developers.
// "ours" is the unit under review; "theirs" is a colleague's uncommitted work
// sitting in the same tree at the same time.

function sharedWc(label, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `forge-rd-${label}-`));
  const repo = path.join(root, 'repo');
  const wc = path.join(root, 'wc');
  const configDir = path.join(root, 'svnconfig');
  fs.mkdirSync(configDir, { recursive: true });

  const svn = (cwd, args) => {
    const r = spawnSync('svn', ['--non-interactive', '--config-dir', configDir, ...args], { cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
  const write = (rel, body) => {
    const abs = path.join(wc, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
  };

  try {
    assert.strictEqual(spawnSync('svnadmin', ['create', repo], { encoding: 'utf8' }).status, 0, 'svnadmin create');
    assert.strictEqual(svn(root, ['checkout', pathToFileURL(repo).href, wc]).status, 0, 'svn checkout');

    // Committed baseline: our file, a colleague's file, and a peg-shaped path.
    write('src/ours.ts', 'export const ours = 1;\n');
    write('src/theirs.ts', 'export const theirs = 1;\n');
    write('SERVICES/services@1.2.0.ts', 'export const pegged = 1;\n');
    assert.strictEqual(svn(wc, ['add', '--', 'src@', 'SERVICES@']).status, 0, 'svn add baseline');
    assert.strictEqual(svn(wc, ['commit', '-m', 'baseline']).status, 0, 'svn commit baseline');

    // Now the working copy holds two owners' uncommitted work at once.
    write('src/ours.ts', 'export const ours = 2;\n');                 // ours, modified
    write('src/theirs.ts', 'export const theirs = 999;\n');           // colleague, modified
    write('SERVICES/services@1.2.0.ts', 'export const pegged = 2;\n');// ours, modified, peg-shaped
    write('src/brand-new.ts', 'export const fresh = true;\n');        // ours, UNVERSIONED
    write('their-notes.txt', 'scratch\n');                            // colleague, UNVERSIONED

    const run = (args = []) => {
      const r = spawnSync(process.execPath, [SCRIPT, '--cwd', wc, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
    };
    const manifestFile = path.join(root, 'manifest.txt');
    fs.writeFileSync(manifestFile, ['src/ours.ts', 'SERVICES/services@1.2.0.ts', 'src/brand-new.ts'].join('\n') + '\n', 'utf8');

    fn({ root, wc, svn, write, run, manifestFile });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ── Acceptance criteria, against the real client ────────────────────────────

test('ACCEPTANCE: real diff, scoped to the unit, including new files', () => {
  sharedWc('accept', ({ run, manifestFile }) => {
    const out = run(['--paths-file', manifestFile]).stdout;
    assert.ok(out.length > 0, 'the diff is real, not "no diff to review"');
    assert.ok(/^\+export const ours = 2;$/m.test(out), "the unit's modification is present");
    assert.ok(/^\+export const fresh = true;$/m.test(out), 'the UNVERSIONED new file is present');
    assert.ok(out.includes('src/brand-new.ts'), 'the new file is named');
  });
});

test("ACCEPTANCE: a colleague's file in the same working copy stays out of the diff", () => {
  sharedWc('shared-owner', ({ run, manifestFile }) => {
    const out = run(['--paths-file', manifestFile]).stdout;
    assert.ok(!out.includes('theirs.ts'), "colleague's modified file must not be reviewed");
    assert.ok(!/999/.test(out), "colleague's content must not reach the challenger");
    assert.ok(!out.includes('their-notes.txt'), "colleague's untracked file must not be reviewed either");

    // And the unscoped behavior is what it replaced — proving the scoping is
    // what excludes them, not some unrelated filter.
    const unscoped = run().stdout;
    assert.ok(unscoped.includes('theirs.ts'), 'without a manifest the colleague IS included (today\'s behavior)');
  });
});

test('ACCEPTANCE: a path containing @ makes it into the diff', () => {
  sharedWc('peg', ({ run, manifestFile }) => {
    const out = run(['--paths-file', manifestFile]).stdout;
    assert.ok(out.includes('services@1.2.0.ts'), 'the peg-shaped path is named in the diff');
    assert.ok(/^\+export const pegged = 2;$/m.test(out), 'its change is actually present');
  });
});

test('peg-escape asymmetry is pinned against the real client, not assumed', () => {
  // The obvious fix for `@` paths — append the documented trailing `@` escape —
  // is CORRECT for `svn info`/`add`/`delete` and WRONG for `svn diff`, which
  // does not peg-parse working-copy targets at all. Applying it to diff breaks
  // every path, including ones with no `@`. If a future client changes either
  // half of this, the diff silently loses files, so both halves are measured.
  sharedWc('peg-asymmetry', ({ wc }) => {
    const svnRun = (...args) => spawnSync('svn', ['--non-interactive', ...args], { cwd: wc, encoding: 'utf8' });

    const literal = svnRun('diff', '--', 'SERVICES/services@1.2.0.ts');
    assert.strictEqual(literal.status, 0, 'svn diff must accept an @ path LITERALLY');
    assert.ok(/^\+export const pegged = 2;$/m.test(literal.stdout), 'and produce its hunk');

    const escaped = svnRun('diff', '--', 'SERVICES/services@1.2.0.ts@');
    assert.notStrictEqual(escaped.status, 0, 'the trailing-@ escape must still BREAK svn diff');

    const escapedPlain = svnRun('diff', '--', 'src/ours.ts@');
    assert.notStrictEqual(escapedPlain.status, 0, 'and it breaks ordinary paths too — hence no blanket escaping');

    // The other half of the asymmetry: `svn info` REQUIRES the escape.
    assert.notStrictEqual(svnRun('info', '--', 'SERVICES/services@1.2.0.ts').status, 0,
      'svn info without the escape reads @1.2.0 as a revision');
    assert.strictEqual(svnRun('info', '--', 'SERVICES/services@1.2.0.ts@').status, 0,
      'svn info with the escape resolves the file');
  });
});

test('the appended-argument consumers work: --name-only and -- <files>', () => {
  sharedWc('consumers', ({ run, manifestFile }) => {
    // `$DIFF_CMD --name-only` (pattern scan) — `svn diff --name-only` does not exist.
    const names = run(['--paths-file', manifestFile, '--name-only']).stdout.trim().split('\n').sort();
    assert.deepStrictEqual(names, ['SERVICES/services@1.2.0.ts', 'src/brand-new.ts', 'src/ours.ts']);

    // `{DIFF_CMD} -- <files>` (per-shard scoping, forge-review Step 2.0).
    const shard = run(['--paths-file', manifestFile, '--', 'src/ours.ts']).stdout;
    assert.ok(shard.includes('src/ours.ts'), 'the requested shard file is present');
    assert.ok(!shard.includes('brand-new'), 'a file outside the shard is absent');
  });
});

test('scope report states the baseline, what was reviewed and what was dropped', () => {
  sharedWc('report', ({ run, manifestFile }) => {
    const report = JSON.parse(run(['--paths-file', manifestFile, '--scope-report']).stdout);
    assert.strictEqual(report.baseline, 'BASE', 'the inert-marker decision is stated in the artifact');
    assert.strictEqual(report.reason, 'manifest');
    assert.deepStrictEqual(report.scoped, ['SERVICES/services@1.2.0.ts', 'src/brand-new.ts', 'src/ours.ts']);
    assert.deepStrictEqual(report.untracked_included, ['src/brand-new.ts']);
    assert.deepStrictEqual(report.excluded, ['src/theirs.ts', 'their-notes.txt'],
      'excluded paths are named — a review that skipped files must say so');
  });
});

test('the manifest can come from the unit plan on disk, not only from a paths file', () => {
  sharedWc('unit-dir', ({ root, run }) => {
    const unitDir = path.join(root, 'unit', 'TASK-900');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(unitDir, 'TASK-900-PLAN.md'),
      ['---', 'id: TASK-900', 'expected_output:', '  - "src/ours.ts"', '---', '', '# plan'].join('\n'), 'utf8');

    const report = JSON.parse(run(['--unit-dir', unitDir, '--scope-report']).stdout);
    assert.strictEqual(report.reason, 'manifest');
    assert.deepStrictEqual(report.scoped, ['src/ours.ts']);
  });
});

test('an unversioned DIRECTORY contributes its files, not one useless entry', () => {
  sharedWc('untracked-dir', ({ wc, run }) => {
    fs.mkdirSync(path.join(wc, 'src', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(wc, 'src', 'feature', 'one.ts'), 'export const one = 1;\n', 'utf8');
    fs.writeFileSync(path.join(wc, 'src', 'feature', 'two.ts'), 'export const two = 2;\n', 'utf8');

    const names = run(['--name-only']).stdout.trim().split('\n');
    assert.ok(names.includes('src/feature/one.ts'), 'files inside a new directory are reachable');
    assert.ok(names.includes('src/feature/two.ts'));
    assert.ok(!names.includes('src/feature'), 'the directory itself is not offered as a diff target');

    const out = run().stdout;
    assert.ok(/^\+export const one = 1;$/m.test(out), 'and their content is actually diffed');
  });
});

test('END-TO-END: the DIFF_CMD block from forge-task, executed verbatim, reviews the unit', () => {
  // The strongest available proof of the wiring. Everything above tests the
  // engine; this extracts the actual bash from skills/forge-task/SKILL.md,
  // substitutes only the placeholders the orchestrator substitutes, and RUNS it
  // against a real working copy. Quoting mistakes in that block are invisible to
  // every other test here and would surface as "no diff to review" in the field.
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
  if (bash.status !== 0) {
    process.stdout.write('    (skipped: bash unavailable)\n');
    return;
  }

  // Normalize line endings: the repo is checked out with CRLF on Windows.
  const skill = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'forge-task', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const fence = /```bash\n(GIT_DIR_FLAG="-C \$\{CODE_DIR:-\.\}"[\s\S]*?)```/.exec(skill);
  assert.ok(fence, 'the DIFF_CMD block must be findable in SKILL.md');

  sharedWc('e2e', ({ root, wc }) => {
    const block = fence[1].replace(/\{TASK_ID\}/g, 'TASK-900');
    const taskDir = path.join(wc, '.gsd', 'tasks', 'TASK-900');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, '.review-manifest'),
      ['src/ours.ts', 'SERVICES/services@1.2.0.ts', 'src/brand-new.ts'].join('\n') + '\n', 'utf8');
    // The SVN baseline marker is present and must be ignored, not consumed.
    fs.writeFileSync(path.join(taskDir, '.start-sha'), '44531:44534M\n', 'utf8');

    const script = [
      'set -u',
      `WORKING_DIR=${JSON.stringify(wc.replace(/\\/g, '/'))}`,
      `FORGE_SCRIPTS_DIR=${JSON.stringify(__dirname.replace(/\\/g, '/'))}`,
      'CODE_DIR=""',
      'SCOPE_REPORT=""',
      block,
      'echo "---DIFF_CMD---"',
      'echo "$DIFF_CMD"',
      'echo "---NAMES---"',
      'eval "$DIFF_CMD" --name-only',
      'echo "---DIFF---"',
      'eval "$DIFF_CMD"',
      'echo "---SCOPE---"',
      'echo "$SCOPE_REPORT"',
    ].join('\n');

    const scriptFile = path.join(root, 'block.sh');
    fs.writeFileSync(scriptFile, script, 'utf8');
    const run = spawnSync('bash', [scriptFile], {
      cwd: wc, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    assert.strictEqual(run.status, 0, `block failed: ${run.stderr}`);

    const section = name => {
      const m = new RegExp(`---${name}---\\n([\\s\\S]*?)(?:\\n---[A-Z_]+---|$)`).exec(run.stdout);
      return m ? m[1] : '';
    };

    assert.ok(/forge-review-diff\.js/.test(section('DIFF_CMD')),
      `SVN must route through the program, got: ${section('DIFF_CMD')}`);
    assert.ok(!/git .*diff/.test(section('DIFF_CMD')), 'the git branch must not win in an SVN working copy');

    const names = section('NAMES').trim().split('\n').filter(Boolean).sort();
    assert.deepStrictEqual(names, ['SERVICES/services@1.2.0.ts', 'src/brand-new.ts', 'src/ours.ts'],
      'the composed command answers --name-only with the unit paths');

    const diff = section('DIFF');
    assert.ok(/^\+export const ours = 2;$/m.test(diff), 'a real hunk reaches the reviewer');
    assert.ok(/^\+export const fresh = true;$/m.test(diff), 'the new file is in the executed diff');
    assert.ok(/^\+export const pegged = 2;$/m.test(diff), 'the @ path survives the composed command');
    assert.ok(!/999/.test(diff), "the colleague's change is excluded end-to-end");

    const scope = JSON.parse(section('SCOPE').trim());
    assert.strictEqual(scope.reason, 'manifest');
    assert.strictEqual(scope.baseline, 'BASE', 'the inert-marker decision holds even with .start-sha present');
    assert.deepStrictEqual(scope.excluded, ['src/theirs.ts', 'their-notes.txt'],
      "excluded lists the colleague's files only — Forge's own artifacts are not code under review");
    assert.ok(scope.gsd_excluded >= 1, '.gsd/** is excluded and counted, not silently dropped');
    assert.ok(!/\.gsd\//.test(diff), 'no Forge artifact reaches the challenger');
  });
});

test('a deleted file is still part of the review', () => {
  sharedWc('deleted', ({ wc, svn, run }) => {
    // `--force` because the fixture leaves local modifications on this file;
    // the escape IS required here (svn delete peg-parses, unlike svn diff).
    assert.strictEqual(svn(wc, ['delete', '--force', '--', 'src/theirs.ts@']).status, 0, 'svn delete');
    const names = run(['--name-only']).stdout;
    assert.ok(names.includes('src/theirs.ts'), 'a deletion is a change under review');
  });
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
