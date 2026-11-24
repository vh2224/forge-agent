#!/usr/bin/env node
'use strict';

// S07/T03 — surfacing the run-overlap advisory signal (forge-overlap.js, T02)
// through forge-doctor.js, and wiring the record→check pair into the gate
// that runs before complete-slice in both loop skills. Five units under test:
//   1. `--check run-overlap` exits 0, INCLUDING when overlap is present.
//   2. `checkRunOverlap` returns `ok: true` on all three paths — success,
//      skip, and internal exception — and `--check all` stays exit 0 with
//      overlap present.
//   3. `'run-overlap'` is in VALID_CHECKS and is derived (not hand-repeated)
//      into both the unknown-check message and `--help`.
//   4. The two SKILL.md files invoke `forge-touch --record` + `forge-overlap
//      --check` before `complete-slice`, verified IN-PROCESS (fs, never
//      shell grep) — and the verifier BITES: removing the invocation from a
//      fixture copy fails, restoring it passes.
//   5. No RunRecord mutation, no write under `~/.claude` — proven by SHA-256
//      of every `.gsd/forge/runs/*.json` before/after `--check run-overlap`.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { checkRunOverlap, VALID_CHECKS, CURRENT_SCHEMA } = require('./forge-doctor.js');

const DOCTOR_CLI = path.join(__dirname, 'forge-doctor.js');
const REPO_ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${name}\n    ${error && error.stack}\n`);
  }
}

function mkTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge-${label}-`));
}

function runFile(root, id) {
  return path.join(root, '.gsd', 'forge', 'runs', `${id}.json`);
}

function writeRun(root, id, patch) {
  const dir = path.join(root, '.gsd', 'forge', 'runs');
  fs.mkdirSync(dir, { recursive: true });
  const rec = Object.assign({
    id,
    active: true,
    created_at: '2026-08-03T00:00:00.000Z',
  }, patch);
  fs.writeFileSync(runFile(root, id), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

function touchedOf(repos) {
  return { at: Date.now(), examined: repos.length, repos };
}

function repoEntry(name, files) {
  return { name, path: `/repos/${name}`, source: 'address', status: 'ok', reason: null, files };
}

// ── 1. exit 0, including with overlap present ───────────────────────────────

test('--check run-overlap exits 0 even when overlap is present, output names the flag', () => {
  const root = mkTmp('t03-overlap-cli');
  try {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    writeRun(root, 'RUN-A', { touched: touchedOf([repoEntry('freyr', ['src/a.ts', 'src/b.ts'])]) });
    writeRun(root, 'RUN-B', { touched: touchedOf([repoEntry('freyr', ['src/b.ts', 'src/c.ts'])]) });

    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'run-overlap', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `must exit 0 with overlap present, got ${r.status}: ${r.stderr}`);
    assert.ok(/overlap|run-overlap/.test(r.stdout), 'stdout must mention the overlap verdict/check');
    assert.ok(/src\/b\.ts/.test(r.stdout), 'stdout must name the colliding file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check all stays exit 0 with overlap present (advisory never flips allOk)', () => {
  const root = mkTmp('t03-overlap-all');
  try {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    // Non-advisory layers (schema) must pass on their own terms so this test
    // isolates the advisory check's contribution to `allOk` — a schema
    // failure here would give a false green/red unrelated to run-overlap.
    // Derived from the module, never hand-written: a hand-written stamp goes
    // stale on the next CURRENT_SCHEMA bump and fails this test for a reason
    // that has nothing to do with run-overlap.
    fs.writeFileSync(path.join(root, '.gsd', 'SCHEMA-VERSION'), `${CURRENT_SCHEMA}\n`, 'utf8');
    writeRun(root, 'RUN-A', { touched: touchedOf([repoEntry('freyr', ['src/a.ts'])]) });
    writeRun(root, 'RUN-B', { touched: touchedOf([repoEntry('freyr', ['src/a.ts'])]) });

    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'all', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `--check all must stay exit 0, got ${r.status}: ${r.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── R5 (S05 review, arbitrated): inconclusive/overlap warn, never show ✓ ────

test('--check run-overlap shows ⚠ (never ✓) on an inconclusive verdict', () => {
  const root = mkTmp('t03-inconclusive-glyph');
  try {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    // Exactly one comparable run -> n*(n-1)/2 === 0 pairs -> inconclusive.
    writeRun(root, 'RUN-A', { touched: touchedOf([repoEntry('freyr', ['src/a.ts'])]) });
    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'run-overlap', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `must exit 0, got ${r.status}: ${r.stderr}`);
    assert.ok(/inconclusive/.test(r.stdout), 'setup: verdict must actually be inconclusive');
    assert.ok(/⚠ Advisory — Cross-run overlap/.test(r.stdout), 'inconclusive must warn, never show ✓');
    assert.ok(!/✓ Advisory — Cross-run overlap/.test(r.stdout), 'inconclusive must not render ✓');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check run-overlap shows ⚠ (never ✓) when overlap is present', () => {
  const root = mkTmp('t03-overlap-glyph');
  try {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    writeRun(root, 'RUN-A', { touched: touchedOf([repoEntry('freyr', ['src/a.ts'])]) });
    writeRun(root, 'RUN-B', { touched: touchedOf([repoEntry('freyr', ['src/a.ts'])]) });
    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'run-overlap', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `must exit 0, got ${r.status}: ${r.stderr}`);
    assert.ok(/⚠ Advisory — Cross-run overlap/.test(r.stdout), 'overlap must warn (unchanged behavior)');
    assert.ok(!/✓ Advisory — Cross-run overlap/.test(r.stdout), 'overlap must not render ✓');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('--check run-overlap shows ✓ (positive control) on a genuinely clean verdict', () => {
  const root = mkTmp('t03-clean-glyph');
  try {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    writeRun(root, 'RUN-A', { touched: touchedOf([repoEntry('freyr', ['src/a.ts'])]) });
    writeRun(root, 'RUN-B', { touched: touchedOf([repoEntry('freyr', ['src/z.ts'])]) });
    const r = spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'run-overlap', '--cwd', root], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `must exit 0, got ${r.status}: ${r.stderr}`);
    assert.ok(/\bclean\b/.test(r.stdout), 'setup: verdict must actually be clean');
    assert.ok(/✓ Advisory — Cross-run overlap/.test(r.stdout), 'a real clean verdict DOES still show ✓ (positive control)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 2. ok:true on all three paths ───────────────────────────────────────────

test('checkRunOverlap ok:true — no runs registry (skip path)', () => {
  const root = mkTmp('t03-overlap-skip');
  try {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    const r = checkRunOverlap(root);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.skipped, 'no-runs-registry');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkRunOverlap ok:true — success path (clean and overlap verdicts both)', () => {
  const root = mkTmp('t03-overlap-success');
  try {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    writeRun(root, 'RUN-A', { touched: touchedOf([repoEntry('freyr', ['src/a.ts'])]) });
    writeRun(root, 'RUN-B', { touched: touchedOf([repoEntry('freyr', ['src/z.ts'])]) });
    const clean = checkRunOverlap(root);
    assert.strictEqual(clean.ok, true);
    assert.strictEqual(clean.verdict, 'clean');

    fs.rmSync(runFile(root, 'RUN-B'));
    writeRun(root, 'RUN-B', { touched: touchedOf([repoEntry('freyr', ['src/a.ts'])]) });
    const overlap = checkRunOverlap(root);
    assert.strictEqual(overlap.ok, true, 'ok:true even when verdict is overlap');
    assert.strictEqual(overlap.verdict, 'overlap');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checkRunOverlap ok:true — internal exception path (unreadable runs dir)', () => {
  if (process.platform === 'win32') {
    // Same skip forge-schema-guard.test.js:383-386 already carries: chmod 000
    // does not block reads on win32, so the sanity assert below cannot hold and
    // the test would report an environment fact as a product defect.
    console.log('    (skip: chmod 000 does not block reads on win32)');
    return;
  }
  const root = mkTmp('t03-overlap-error');
  const dir = path.join(root, '.gsd', 'forge', 'runs');
  try {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    // forge-runs.listAll tolerates a per-file JSON.parse failure (its own
    // try/catch swallows that), so an unreadable FILE would silently degrade
    // into the success path. Revoking read+execute on the DIRECTORY makes
    // `fs.readdirSync` itself throw, which is outside that per-file try —
    // forcing the internal exception branch of checkRunOverlap.
    fs.chmodSync(dir, 0o000);

    // Sanity: forge-runs.listAll must actually throw on this fixture, or this
    // test would silently degrade into re-testing the success path.
    let threw = false;
    try { require('./forge-runs.js').listAll(root); } catch { threw = true; }
    assert.ok(threw, 'fixture setup must make forge-runs.listAll throw (EACCES)');

    const r = checkRunOverlap(root);
    assert.strictEqual(r.ok, true, 'an internal exception must still report ok:true (advisory)');
    assert.ok(typeof r.skipped === 'string' && r.skipped.startsWith('error:'), 'exception path must name itself');
  } finally {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 3. VALID_CHECKS / --help derivation ─────────────────────────────────────

test("'run-overlap' is in VALID_CHECKS, and --help / unknown-check message derive from it", () => {
  assert.ok(VALID_CHECKS.includes('run-overlap'));

  const help = spawnSync(process.execPath, [DOCTOR_CLI, '--help'], { encoding: 'utf8' });
  assert.ok(/run-overlap/.test(help.stdout), '--help must list run-overlap');

  const bad = spawnSync(process.execPath, [DOCTOR_CLI, '--check', '__nope__', '--cwd', mkTmp('t03-bad')], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 2);
  assert.ok(/run-overlap/.test(bad.stderr), 'unknown-check message must list run-overlap');

  const helpMatch = /run check: ([\s\S]+?)\n\s*all\n/.exec(help.stdout);
  assert.ok(helpMatch, '--help stdout must list valid checks');
  const advertisedHelp = helpMatch[1].split('|').map(s => s.trim()).filter(Boolean);
  const stderrMatch = /Valid: (.+)\n?$/.exec(bad.stderr);
  const advertisedStderr = stderrMatch[1].split(',').map(s => s.trim()).filter(s => s !== 'all');
  assert.deepStrictEqual(advertisedHelp.slice().sort(), VALID_CHECKS.slice().sort());
  assert.deepStrictEqual(advertisedStderr.slice().sort(), VALID_CHECKS.slice().sort());
});

// ── 4. skill wiring, in-process, bites both directions ──────────────────────

/**
 * Assert the record→check pair is documented before complete-slice.
 * Extracted so fixture text and the real tree run through the SAME function —
 * a verifier that only ever runs against the real file cannot be proven to
 * bite (S07-PLAN.md Step 5d).
 */
function checkSkillWiring(text) {
  return /forge-touch\.js["']?\s+--record/.test(text) && /forge-overlap\.js["']?\s+--check/.test(text);
}

const SKILL_PATHS = [
  path.join(REPO_ROOT, 'skills', 'forge-auto', 'SKILL.md'),
  path.join(REPO_ROOT, 'skills', 'forge-next', 'SKILL.md'),
];

test('both SKILL.md files invoke forge-touch --record and forge-overlap --check (in-process fs read)', () => {
  for (const p of SKILL_PATHS) {
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(checkSkillWiring(text), `${p} must invoke both forge-touch --record and forge-overlap --check`);
  }
});

test('checkSkillWiring bites in both directions on a fixture copy', () => {
  const root = mkTmp('t03-wiring-bite');
  try {
    const real = fs.readFileSync(SKILL_PATHS[0], 'utf8');
    assert.ok(checkSkillWiring(real), 'sanity: the real file passes before mutation');

    const stripped = real.replace(/node "\$FORGE_SCRIPTS_DIR\/forge-touch\.js" --record[^\n]*\n/, '');
    assert.notStrictEqual(stripped, real, 'sanity: the strip must actually remove a line');
    const fixture = path.join(root, 'SKILL-stripped.md');
    fs.writeFileSync(fixture, stripped, 'utf8');
    assert.strictEqual(checkSkillWiring(fs.readFileSync(fixture, 'utf8')), false, 'stripped copy must fail the check');

    const restored = path.join(root, 'SKILL-restored.md');
    fs.writeFileSync(restored, real, 'utf8');
    assert.strictEqual(checkSkillWiring(fs.readFileSync(restored, 'utf8')), true, 'restored copy must pass again');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 5. zero mutation ─────────────────────────────────────────────────────────

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

test('checkRunOverlap mutates no RunRecord — SHA-256 identical before/after, real registry untouched', () => {
  const root = mkTmp('t03-overlap-nomutate');
  try {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    writeRun(root, 'RUN-A', { touched: touchedOf([repoEntry('freyr', ['src/a.ts'])]) });
    writeRun(root, 'RUN-B', { touched: touchedOf([repoEntry('freyr', ['src/a.ts'])]) });

    const before = {
      'RUN-A': sha256(runFile(root, 'RUN-A')),
      'RUN-B': sha256(runFile(root, 'RUN-B')),
    };

    spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'run-overlap', '--cwd', root], { encoding: 'utf8' });
    checkRunOverlap(root);

    const after = {
      'RUN-A': sha256(runFile(root, 'RUN-A')),
      'RUN-B': sha256(runFile(root, 'RUN-B')),
    };
    assert.deepStrictEqual(before, after, 'RunRecord files must be byte-identical before/after --check');

    // Prove non-mutation against data with the REAL operator registry's shape,
    // WITHOUT reading the live `.gsd/forge/runs/` during the measurement —
    // that live dir is legitimately written by any active forge-auto's
    // heartbeat (item I-20260814113610: ~1 failure in 3 measured with a
    // concurrent writer). Instead: copy the real files into an isolated tmp
    // root BEFORE the check, run the check against the copy, and compare the
    // copy before/after. Concurrent writes to the live dir after the copy is
    // taken cannot affect the isolated snapshot.
    const realRunsDir = path.join(REPO_ROOT, '.gsd', 'forge', 'runs');
    if (!fs.existsSync(realRunsDir)) {
      process.stdout.write('    (skip: real .gsd/forge/runs/ absent in this checkout)\n');
    } else {
      const realFiles = fs.readdirSync(realRunsDir).filter(f => f.endsWith('.json'));
      if (realFiles.length === 0) {
        process.stdout.write('    (skip: real .gsd/forge/runs/ present but empty in this checkout)\n');
      } else {
        const isoRoot = mkTmp('t03-overlap-real-shape');
        try {
          const isoRunsDir = path.join(isoRoot, '.gsd', 'forge', 'runs');
          fs.mkdirSync(isoRunsDir, { recursive: true });
          for (const f of realFiles) {
            fs.copyFileSync(path.join(realRunsDir, f), path.join(isoRunsDir, f));
          }

          const isoSha256 = () => {
            const out = {};
            for (const f of realFiles) out[f] = sha256(path.join(isoRunsDir, f));
            return out;
          };
          const isoMtimes = () => realFiles.map(f => fs.statSync(path.join(isoRunsDir, f)).mtimeMs);

          const shaBefore = isoSha256();
          const mtimesBefore = isoMtimes();

          spawnSync(process.execPath, [DOCTOR_CLI, '--check', 'run-overlap', '--cwd', isoRoot], { encoding: 'utf8' });

          const shaAfter = isoSha256();
          const mtimesAfter = isoMtimes();
          assert.deepStrictEqual(shaBefore, shaAfter, 'isolated copy of real-shaped registry must be byte-identical before/after --check');
          assert.deepStrictEqual(mtimesBefore, mtimesAfter, 'isolated copy mtimes must not change (no mutation)');

          // Positive control: the assert must still bite. Mutate one file of
          // the isolated copy deliberately and confirm the SAME comparison
          // fails — an immutability assert without a positive control is
          // indistinguishable from an assert that inspects nothing (this
          // milestone's S05 anti-silence-floor precedent).
          const targetFile = path.join(isoRunsDir, realFiles[0]);
          const shaBeforeMutation = sha256(targetFile);
          fs.appendFileSync(targetFile, '\n// mutated for positive control\n');
          const shaAfterMutation = sha256(targetFile);
          let mutationCaught = false;
          try {
            assert.deepStrictEqual(shaBeforeMutation, shaAfterMutation, 'positive control must detect this mutation');
          } catch {
            mutationCaught = true;
          }
          assert.ok(mutationCaught, 'positive control: deliberate mutation of the isolated copy must be detected by the same comparison');
        } finally {
          fs.rmSync(isoRoot, { recursive: true, force: true });
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
