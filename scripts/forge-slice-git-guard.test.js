'use strict';

// Standalone suite: run directly with Node.
//
// Two halves, both anchored to item I-20260814114608 (a forge-completer running
// complete-slice merged the milestone branch into master against an explicit
// prompt prohibition):
//   1. Contract — the surfaces a complete-slice completer actually reads carry
//      no merge instruction, and name the prohibition.  Measured against the
//      real repository files; no fixture can make this look better than it is.
//   2. Behaviour — the guard reports the violation on a real git repo where the
//      incident is reproduced, and stays quiet on a legitimate close-out.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { VERDICTS, EXIT, writeSnapshot, readSnapshot, consumeSnapshot, snapshotAgeMs, snapshotPath, verify } = require('./forge-slice-git-guard.js');

const REPO = path.resolve(__dirname, '..');
const GUARD = path.join(__dirname, 'forge-slice-git-guard.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok — ${name}`); }
  catch (e) { failed++; console.error(`  FAIL — ${name}\n    ${e && e.message}`); }
}

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

// ------------------------------------------------------- 1. contract surfaces

// Every surface a completer reads when running complete-slice.  The agent
// definition is split: only the complete-slice half is measured, because
// complete-milestone legitimately keeps git competence.
const SLICE_SURFACES = Object.freeze([
  'shared/templates/dispatch/complete-slice.md',
  'shared/forge-dispatch.md#complete-slice',
  'agents/forge-completer.md#For complete-slice',
]);

// An *instruction* to merge.  Deliberately narrow: the surfaces must be free of
// imperative merge steps while still being allowed to NAME the prohibition
// (which necessarily contains the word "merge").
const MERGE_INSTRUCTION = /^\s*(?:\d+\.\s*)?(?:\*\*)?(?:Git\s+)?(?:squash-merge|Squash-merge|Merge)\b/;

function sliceSection(surface) {
  const [rel, anchor] = surface.split('#');
  const text = read(rel);
  if (!anchor) return text;
  if (rel === 'shared/forge-dispatch.md') {
    // The fenced complete-slice prompt template.
    const start = text.indexOf('### complete-slice');
    assert.ok(start !== -1, 'complete-slice section not found in forge-dispatch.md');
    const next = text.indexOf('\n### ', start + 1);
    return text.slice(start, next === -1 ? text.length : next);
  }
  const start = text.indexOf('## For complete-slice');
  assert.ok(start !== -1, 'complete-slice section not found in forge-completer.md');
  // Span everything a complete-slice run is governed by — the steps AND the
  // Git boundary section — stopping exactly where complete-milestone (which
  // legitimately keeps git competence) begins.
  const next = text.indexOf('\n## For complete-milestone', start + 1);
  assert.ok(next !== -1, 'complete-milestone heading not found — cannot bound the slice surface');
  return text.slice(start, next);
}

console.log('forge-slice-git-guard — contract');

for (const surface of SLICE_SURFACES) {
  test(`${surface} carries no merge instruction`, () => {
    const offending = sliceSection(surface)
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => MERGE_INSTRUCTION.test(line));
    assert.deepStrictEqual(
      offending, [],
      `merge instruction still reachable: ${offending.map(([n, l]) => `${n}: ${l.trim()}`).join(' | ')}`,
    );
  });

  test(`${surface} names the prohibition explicitly`, () => {
    const section = sliceSection(surface);
    // Naming only "squash" is exactly the failure mode of the incident.
    assert.ok(/NO merge step|never integrates a branch|Git boundary/.test(section),
      'section does not state that complete-slice cannot merge');
    assert.ok(/rebase/.test(section) && /cherry-pick/.test(section),
      'prohibition is not stated as a class — sibling verbs (rebase/cherry-pick) unnamed');
  });
}

// CONTRACT CHANGE, deliberate: these two guards used to encode #96's rule —
// "the ban is scoped to the slice; complete-milestone RETAINS git competence".
// That rule described a competence nobody implemented: complete-milestone never
// had a merge step, only a blockquote claiming it did, while the loop shipped a
// guard whose whole purpose is detecting a worker that integrates. The contract
// is now repo-wide — NO unit integrates; the operator does — so the guards move
// with it instead of being deleted.
//
// The control the old test provided is preserved and is the reason this one is
// phrased over PERMITTED verbs: a blanket "no git" edit would disarm the
// close-out's tagging and run-branch push, which are not integration and must
// survive.
test('complete-milestone keeps the non-integrating verbs it needs', () => {
  const text = read('agents/forge-completer.md');
  const start = text.indexOf('## For complete-milestone');
  assert.ok(start !== -1, 'complete-milestone section missing');
  const section = text.slice(start);
  assert.ok(/auto_push/.test(section),
    'complete-milestone no longer names auto_push — a blanket git ban would have eaten the run-branch push');
  assert.ok(/git tag|`git commit`/.test(section),
    'complete-milestone no longer names the permitted verbs (tag/commit) — the ban stopped being about INTEGRATING');
});

// Guard against the new contract rotting: BOTH boundaries must state it, and
// neither may quietly re-grant integration to the unit it covers.
test('both Git boundary sections state the non-integration rule', () => {
  const text = read('agents/forge-completer.md');
  for (const heading of ['## Git boundary — complete-slice', '### Git boundary — complete-milestone']) {
    // Anchored at line start: both headings are also CITED inside the prose
    // ("see `## Git boundary — complete-slice` below"), and a bare indexOf
    // lands on the citation — extracting the wrong span and asserting about
    // text that isn't the section. The previous version of this guard had the
    // same flaw and passed by coincidence.
    const at = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').exec(text);
    assert.ok(at, `Git boundary section missing from forge-completer.md: ${heading}`);
    const start = at.index;
    const rest = text.slice(start + heading.length);
    const end = rest.search(/\n#{2,3} /);
    const section = end === -1 ? rest : rest.slice(0, end);
    assert.ok(/NEVER integrates|does NOT integrate|NO merge step/i.test(section),
      `${heading} does not state that this unit never integrates`);
    assert.ok(/rebase/.test(section) && /cherry-pick/.test(section),
      `${heading} does not state the prohibition as a class — sibling verbs (rebase/cherry-pick) unnamed`);
    assert.ok(/OPERATOR/.test(section),
      `${heading} does not name who does integrate — a ban with no owner reads as an oversight`);
  }
});

test('both dispatching skills wire the guard', () => {
  for (const rel of ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md']) {
    const text = read(rel);
    // The invoked path is shell-quoted, so match the flag near the script name
    // rather than assuming they are adjacent.
    assert.ok(/forge-slice-git-guard\.js"?\s+--snapshot/.test(text), `${rel} misses the snapshot call`);
    assert.ok(/forge-slice-git-guard\.js"?\s+--verify/.test(text), `${rel} misses the verify call`);
  }
});

// Item #112: a seam nothing passes is a seam that does not exist. `--gsd-dir`
// and `--run` fix defects that live at the CALL SITE — `--cwd` is the CODE_DIR,
// and two runs share a workspace — so the module gaining the flags proves
// nothing on its own. Both invocations of both skills are measured, and the run
// id must be the real variable rather than a placeholder somebody meant to fill
// in later.
test('#112 both skills pass --gsd-dir and --run on BOTH invocations', () => {
  for (const rel of ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md']) {
    // Line filtering, not a regex: the pattern would need an escaped newline
    // class and this assertion is not the place to fight escaping layers.
    const calls = read(rel).split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('node ') && line.includes('forge-slice-git-guard.js'));
    assert.strictEqual(calls.length, 2,
      rel + ': expected exactly the snapshot and the verify call, got ' + calls.length);
    for (const call of calls) {
      assert.ok(call.includes('--gsd-dir "$WORKING_DIR/.gsd"'),
        rel + ': this call writes .gsd under the CODE_DIR - ' + call);
      assert.ok(call.includes('--run "$RUN_ID"'),
        rel + ': this call is not scoped to a run, so two runs on one workspace collide - ' + call);
    }
  }
});

// -------------------------------------------------------- 2. guard behaviour

console.log('forge-slice-git-guard — behaviour');

function sh(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return String(r.stdout || '').trim();
}

function commit(cwd, file, body) {
  fs.writeFileSync(path.join(cwd, file), body, 'utf8');
  sh(cwd, ['add', file]);
  sh(cwd, ['commit', '-m', `add ${file}`]);
}

// Reproduces the incident's shape: a default branch plus a live milestone
// branch, checkout sitting on the milestone branch as a slice would.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-slice-guard-'));
  sh(dir, ['init', '-q', '-b', 'master']);
  sh(dir, ['config', 'user.email', 'test@example.com']);
  sh(dir, ['config', 'user.name', 'test']);
  sh(dir, ['config', 'commit.gpgsign', 'false']);
  commit(dir, 'base.txt', 'base\n');
  sh(dir, ['checkout', '-q', '-b', 'forge/M-test']);
  commit(dir, 'slice.txt', 'slice work\n');
  return dir;
}

function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

const UNIT = 'complete-slice/S05';

test('legitimate close-out (commit on the slice branch) is clean', () => {
  const dir = makeRepo();
  try {
    writeSnapshot(dir, UNIT);
    // What a complete-slice with auto_commit:true legitimately does.
    commit(dir, 'S05-SUMMARY.md', 'summary\n');
    const res = verify(dir, readSnapshot(dir, UNIT));
    assert.strictEqual(res.verdict, VERDICTS.CLEAN, JSON.stringify(res.violations));
    assert.ok(res.census.checks_conclusive >= 3, 'expected all three checks conclusive');
  } finally { cleanup(dir); }
});

test('doing nothing at all is clean', () => {
  const dir = makeRepo();
  try {
    writeSnapshot(dir, UNIT);
    const res = verify(dir, readSnapshot(dir, UNIT));
    assert.strictEqual(res.verdict, VERDICTS.CLEAN);
  } finally { cleanup(dir); }
});

test('THE INCIDENT: non-squash merge into master + checkout left on master', () => {
  const dir = makeRepo();
  try {
    writeSnapshot(dir, UNIT);
    // Exactly what happened on 2026-08-14: a real (ort, non-squash) merge of
    // the milestone branch into master, checkout left behind on master.
    sh(dir, ['checkout', '-q', 'master']);
    sh(dir, ['merge', '--no-ff', '-m', 'merge slice', 'forge/M-test']);

    const res = verify(dir, readSnapshot(dir, UNIT));
    assert.strictEqual(res.verdict, VERDICTS.VIOLATION);
    const names = res.violations.map(v => v.name).sort();
    assert.deepStrictEqual(names, [
      'current-branch-unchanged', 'default-branch-head-unchanged', 'no-merge-commit-created',
    ], `all three invariants should fire: ${JSON.stringify(res.checks)}`);
  } finally { cleanup(dir); }
});

test('squash merge into master is caught too (not just non-squash)', () => {
  const dir = makeRepo();
  try {
    writeSnapshot(dir, UNIT);
    sh(dir, ['checkout', '-q', 'master']);
    sh(dir, ['merge', '--squash', 'forge/M-test']);
    sh(dir, ['commit', '-m', 'squashed slice']);
    // A squash leaves no merge commit — the default-branch check is what bites.
    const res = verify(dir, readSnapshot(dir, UNIT));
    assert.strictEqual(res.verdict, VERDICTS.VIOLATION);
    assert.ok(res.violations.some(v => v.name === 'default-branch-head-unchanged'));
  } finally { cleanup(dir); }
});

test('checkout moved without merging is caught', () => {
  const dir = makeRepo();
  try {
    writeSnapshot(dir, UNIT);
    sh(dir, ['checkout', '-q', 'master']);
    const res = verify(dir, readSnapshot(dir, UNIT));
    assert.strictEqual(res.verdict, VERDICTS.VIOLATION);
    assert.deepStrictEqual(res.violations.map(v => v.name), ['current-branch-unchanged']);
  } finally { cleanup(dir); }
});

test('merge INTO the slice branch is caught (checks 1 and 2 both miss it)', () => {
  const dir = makeRepo();
  try {
    sh(dir, ['checkout', '-q', 'master']);
    commit(dir, 'other.txt', 'other\n');
    sh(dir, ['checkout', '-q', 'forge/M-test']);
    writeSnapshot(dir, UNIT);
    sh(dir, ['merge', '--no-ff', '-m', 'merge master in', 'master']);
    const res = verify(dir, readSnapshot(dir, UNIT));
    assert.strictEqual(res.verdict, VERDICTS.VIOLATION);
    assert.deepStrictEqual(res.violations.map(v => v.name), ['no-merge-commit-created']);
  } finally { cleanup(dir); }
});

test('missing snapshot is inconclusive, never clean', () => {
  const dir = makeRepo();
  try {
    const res = verify(dir, readSnapshot(dir, UNIT));
    assert.strictEqual(res.verdict, VERDICTS.INCONCLUSIVE);
    assert.strictEqual(res.census.checks_conclusive, 0);
  } finally { cleanup(dir); }
});

test('non-git directory is inconclusive, never clean', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-slice-guard-nogit-'));
  try {
    writeSnapshot(dir, UNIT);
    const res = verify(dir, readSnapshot(dir, UNIT));
    assert.strictEqual(res.verdict, VERDICTS.INCONCLUSIVE);
  } finally { cleanup(dir); }
});

// Exit codes are a property of the process, so they are asserted by spawning
// the CLI — never claimed in a comment.
test('CLI exit codes: 0 clean, 3 violation — one snapshot per verify', () => {
  const dir = makeRepo();
  try {
    assert.strictEqual(
      spawnSync(process.execPath, [GUARD, '--snapshot', '--cwd', dir, '--unit', UNIT]).status, EXIT.OK);
    assert.strictEqual(
      spawnSync(process.execPath, [GUARD, '--verify', '--cwd', dir, '--unit', UNIT]).status, EXIT.OK);

    // The baseline is SPENT by that verify (item #112.2), so the second scenario
    // takes its own — which is exactly the production sequence: the skills call
    // --snapshot immediately before each dispatch and --verify once after it.
    // Asserted rather than assumed, right below.
    assert.strictEqual(
      spawnSync(process.execPath, [GUARD, '--snapshot', '--cwd', dir, '--unit', UNIT]).status, EXIT.OK);

    sh(dir, ['checkout', '-q', 'master']);
    sh(dir, ['merge', '--no-ff', '-m', 'merge slice', 'forge/M-test']);
    const bad = spawnSync(process.execPath, [GUARD, '--verify', '--cwd', dir, '--unit', UNIT], { encoding: 'utf8' });
    assert.strictEqual(bad.status, EXIT.VIOLATION);
    assert.ok(/VIOLATION/.test(bad.stderr), 'violation not reported on stderr');
    assert.strictEqual(JSON.parse(bad.stdout).verdict, VERDICTS.VIOLATION);

    // The consequence of consumption, pinned as contract instead of left as a
    // side effect: a verify with no fresh baseline reports INCONCLUSIVE at exit
    // 0. It must never re-report the violation it already reported (a stale
    // baseline answering a new question) nor claim clean.
    const again = spawnSync(process.execPath, [GUARD, '--verify', '--cwd', dir, '--unit', UNIT], { encoding: 'utf8' });
    assert.strictEqual(again.status, EXIT.OK);
    assert.strictEqual(JSON.parse(again.stdout).verdict, VERDICTS.INCONCLUSIVE);
  } finally { cleanup(dir); }
});

// ------------------------------------------ 3. where the snapshot is written
//
// Item #112: three defects living in one file name.

console.log('forge-slice-git-guard - snapshot placement');

test('#112.1 --gsd-dir keeps .gsd OUT of the CODE_DIR (the worktree convention)', () => {
  const dir = makeRepo();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-slice-ws-'));
  try {
    const gsdDir = path.join(workspace, '.gsd');
    const { file } = writeSnapshot(dir, UNIT, { gsdDir });
    assert.ok(file.startsWith(path.resolve(gsdDir)), 'snapshot escaped the declared .gsd: ' + file);
    assert.strictEqual(fs.existsSync(path.join(dir, '.gsd')), false,
      'the guard wrote .gsd inside the CODE_DIR - under worktree isolation that is an untracked file '
      + 'in the worktree, which can make cleanupWorktreeOne report skipped (dirty)');
    // ...and the baseline stays usable from where it landed.
    assert.strictEqual(verify(dir, readSnapshot(dir, UNIT, { gsdDir })).verdict, VERDICTS.CLEAN);
  } finally { cleanup(dir); cleanup(workspace); }
});

test('#112.1 control: with no --gsd-dir the path is byte-identical to before', () => {
  // The seam must be additive: a caller that never passes it keeps today's file.
  assert.strictEqual(
    snapshotPath('/code', UNIT),
    path.join('/code', '.gsd', 'forge', 'slice-git-snapshot-complete-slice-S05.json'));
});

test('#112.3 --run scopes the name: two runs closing the same S## do not collide', () => {
  const dir = makeRepo();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-slice-ws-'));
  try {
    const gsdDir = path.join(workspace, '.gsd');
    const a = writeSnapshot(dir, UNIT, { gsdDir, run: 'M-AAA' }).file;
    const b = writeSnapshot(dir, UNIT, { gsdDir, run: 'M-BBB' }).file;
    assert.notStrictEqual(a, b,
      'two runs closing the same slice in one workspace still share a snapshot file - '
      + 'one run baseline answers for the other');
    assert.ok(fs.existsSync(a) && fs.existsSync(b), 'both baselines must survive side by side');
    assert.ok(path.basename(a).includes('M-AAA') && path.basename(b).includes('M-BBB'),
      'the run id must stay legible in the name, not hashed away');
  } finally { cleanup(dir); cleanup(workspace); }
});

test('#112.3 control: omitting --run reproduces the un-scoped name', () => {
  assert.strictEqual(snapshotPath('/code', UNIT, { run: null }), snapshotPath('/code', UNIT));
});

// ----------------------------------------- 4. the baseline is spent by reading

console.log('forge-slice-git-guard - snapshot lifetime');

test('#112.2 verify CONSUMES the baseline, so a skipped snapshot cannot be answered by an old one', () => {
  const dir = makeRepo();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-slice-ws-'));
  try {
    const gsdDir = path.join(workspace, '.gsd');
    const { file } = writeSnapshot(dir, UNIT, { gsdDir, run: 'M-AAA' });
    const taken = consumeSnapshot(dir, UNIT, { gsdDir, run: 'M-AAA' });
    assert.ok(taken.snapshot, 'the baseline was returned to the caller');
    assert.strictEqual(taken.removed, true, 'consumption is reported, never assumed');
    assert.strictEqual(fs.existsSync(file), false, 'the spent baseline is still on disk');

    const second = consumeSnapshot(dir, UNIT, { gsdDir, run: 'M-AAA' });
    assert.strictEqual(second.snapshot, null);
    assert.strictEqual(second.removed, false, 'nothing to remove must not be reported as a removal');
    const res = verify(dir, second.snapshot);
    assert.strictEqual(res.verdict, VERDICTS.INCONCLUSIVE);
    assert.strictEqual(res.checks[0].reason, 'snapshot-missing',
      'a spent baseline must degrade to the NAMED missing reason, never to clean');
  } finally { cleanup(dir); cleanup(workspace); }
});

test('#112.2 consuming one run baseline leaves the other run alone', () => {
  const dir = makeRepo();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-slice-ws-'));
  try {
    const gsdDir = path.join(workspace, '.gsd');
    writeSnapshot(dir, UNIT, { gsdDir, run: 'M-AAA' });
    const kept = writeSnapshot(dir, UNIT, { gsdDir, run: 'M-BBB' }).file;
    consumeSnapshot(dir, UNIT, { gsdDir, run: 'M-AAA' });
    assert.ok(fs.existsSync(kept),
      'consuming one run baseline destroyed another run - the scoping is decorative');
  } finally { cleanup(dir); cleanup(workspace); }
});

test('#112.2 taken_at is finally read: age reported, and undatable is null not zero', () => {
  const now = Date.parse('2026-08-18T12:00:00.000Z');
  assert.strictEqual(snapshotAgeMs({ taken_at: '2026-08-18T11:59:00.000Z' }, now), 60000);
  // Absent and unparseable are the same fact - we cannot say how old it is - and
  // `0` would assert a freshness nobody measured.
  assert.strictEqual(snapshotAgeMs({}, now), null);
  assert.strictEqual(snapshotAgeMs({ taken_at: 'nao-e-uma-data' }, now), null);
  assert.strictEqual(snapshotAgeMs(null, now), null);
});

test('#112 the verify CLI reports where the baseline was and that it was spent', () => {
  const dir = makeRepo();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-slice-ws-'));
  try {
    const gsdDir = path.join(workspace, '.gsd');
    const where = ['--gsd-dir', gsdDir, '--run', 'M-AAA'];
    spawnSync(process.execPath, [GUARD, '--snapshot', '--cwd', dir, '--unit', UNIT].concat(where), { encoding: 'utf8' });
    const r = spawnSync(process.execPath, [GUARD, '--verify', '--cwd', dir, '--unit', UNIT].concat(where), { encoding: 'utf8' });
    assert.strictEqual(r.status, EXIT.OK);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.verdict, VERDICTS.CLEAN);
    assert.strictEqual(out.snapshot_removed, true);
    assert.ok(out.snapshot_file.startsWith(path.resolve(gsdDir)), out.snapshot_file);
    assert.ok(Number.isFinite(out.snapshot_age_ms) && out.snapshot_age_ms >= 0,
      'the age must reach the caller: ' + out.snapshot_age_ms);
  } finally { cleanup(dir); cleanup(workspace); }
});

console.log(`\nforge-slice-git-guard: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
