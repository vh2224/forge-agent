#!/usr/bin/env node
'use strict';

// forge-write-claim.test.js — the claim never lies about what it is.
//
// Properties this suite carries (mirroring forge-touch.test.js's structure,
// the direct precedent T01 composes on top of):
//
//   R1  a RunRecord written before `write_claim` existed reads as
//       `write_claim: null`, and the file's sha256 is UNCHANGED by the read
//       (additive by READ, no migration).
//   R2  `readClaim(recSemClaim) === null` and `readClaim(recComPathsVazio)`
//       is a distinct object — never collapsed.
//   R3  `code_dir` is a GIVEN fact: absent `--code-dir` -> `code_dir: null`,
//       never derived from root/branch/isolation_mode.
//   R4  `recordClaim` is the ONLY function that writes — `normalizeClaim`
//       and `readClaim` never touch disk, proved by sha256 before/after.
//   R5  paths are normalized via the IMPORTED `normalizePath` — `src\a.ts`
//       and `src/a.ts` land identical.
//   R6  `CLAIM_SOURCES` is a closed set, cross-checked in BOTH directions.
//   R7  the CLI is proved by SPAWN (never in-process call), exit 0 on the
//       success paths.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-write-claim.js');
const claimMod = require('./forge-write-claim.js');
const {
  normalizeClaim, recordClaim, readClaim, clearClaim, releaseClaim, recoverClaim, isHeld, validateHeldClaim,
  CLAIM_SOURCES, RELEASE_MECHANISMS,
} = claimMod;
const runs = require('./forge-runs.js');

// ── Runner ──────────────────────────────────────────────────────────────────
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
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

const tmps = [];
function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-claim-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Fixture wired the same shape as forge-touch.test.js's `makeFixture` —
 * `.gsd/forge/runs/<id>.json` under a synthetic workspace, no real HOME
 * touched.
 */
function makeFixture(runId, extraRun) {
  const tmp = mktmp();
  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsDir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');

  const runFile = path.join(wsDir, '.gsd', 'forge', 'runs', `${runId}.json`);
  writeJson(runFile, Object.assign({
    kind: 'milestone',
    id: runId,
    session_id: 'sess-fixture',
    active: true,
    started_at: 1785763253000,
    last_heartbeat: 1785763253000,
    worker: null,
    worker_started: null,
    isolation_mode: 'branch',
    milestone_dir: `.gsd/milestones/${runId}/`,
    cwd: wsDir,
  }, extraRun || {}));

  return { wsDir, runFile };
}

function runCli(args) {
  const res = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// ── R1: legacy record reads as null, sha256 unchanged by the read ──────────
test('R1: legacy record (no write_claim) reads as null, sha256 unchanged by read', () => {
  const { wsDir, runFile } = makeFixture('M-20260813-legacy');
  const before = sha256(runFile);
  const rec = runs.get(wsDir, 'M-20260813-legacy');
  assertEqual(rec.write_claim, null, 'legacy record must default write_claim to null');
  const after = sha256(runFile);
  assertEqual(after, before, 'reading a legacy record must not rewrite it (sha256 must match)');
});

// ── R2: null (never claimed) vs { paths: [] } (claimed, empty) never collapse
test('R2: readClaim distinguishes null (never claimed) from claimed-empty', () => {
  const { wsDir } = makeFixture('M-20260813-r2');
  const recNever = runs.get(wsDir, 'M-20260813-r2');
  assertEqual(readClaim(recNever), null, 'never-claimed run must read as null');

  recordClaim(wsDir, 'M-20260813-r2', { unit: 'execute-task/T01', source: 'manual', paths: [] });
  const recClaimed = runs.get(wsDir, 'M-20260813-r2');
  const claim = readClaim(recClaimed);
  assert(claim !== null, 'claimed-empty run must not read as null');
  assert(Array.isArray(claim.paths) && claim.paths.length === 0, 'claimed-empty must carry paths: []');
});

// ── R3: code_dir is GIVEN, never derived ────────────────────────────────────
test('R3: code_dir absent from input -> null, never derived', () => {
  const { wsDir } = makeFixture('M-20260813-r3');
  const claim = recordClaim(wsDir, 'M-20260813-r3', { unit: 'execute-task/T01', source: 'manual' });
  assertEqual(claim.code_dir, null, 'code_dir must be null when not given, never derived from root/branch');
});

test('R3b: code_dir given is recorded verbatim', () => {
  const { wsDir } = makeFixture('M-20260813-r3b');
  const claim = recordClaim(wsDir, 'M-20260813-r3b', {
    unit: 'execute-task/T01', source: 'manual', code_dir: '/tmp/some/code-dir',
  });
  assertEqual(claim.code_dir, '/tmp/some/code-dir', 'code_dir must be recorded exactly as given');
});

// ── R4: recordClaim is the ONLY function that writes ────────────────────────
test('R4: normalizeClaim never touches disk', () => {
  const { runFile } = makeFixture('M-20260813-r4a');
  const before = sha256(runFile);
  normalizeClaim({ unit: 'execute-task/T01', source: 'manual', paths: ['a.js'] });
  const after = sha256(runFile);
  assertEqual(after, before, 'normalizeClaim must be pure — no disk writes');
});

test('R4: readClaim never touches disk', () => {
  const { wsDir, runFile } = makeFixture('M-20260813-r4b');
  recordClaim(wsDir, 'M-20260813-r4b', { unit: 'execute-task/T01', source: 'manual', paths: ['a.js'] });
  const before = sha256(runFile);
  const rec = runs.get(wsDir, 'M-20260813-r4b');
  readClaim(rec);
  readClaim(rec);
  const after = sha256(runFile);
  assertEqual(after, before, 'readClaim must never write');
});

// ── R5: paths normalized via imported normalizePath ─────────────────────────
test('R5: backslash and forward-slash paths normalize identically', () => {
  const { wsDir } = makeFixture('M-20260813-r5a');
  const claimA = recordClaim(wsDir, 'M-20260813-r5a', {
    unit: 'execute-task/T01', source: 'manual', paths: ['src\\a.ts'],
  });
  const { wsDir: wsDir2 } = makeFixture('M-20260813-r5b');
  const claimB = recordClaim(wsDir2, 'M-20260813-r5b', {
    unit: 'execute-task/T01', source: 'manual', paths: ['src/a.ts'],
  });
  assertEqual(claimA.paths[0], claimB.paths[0], 'src\\a.ts and src/a.ts must normalize to the same path');
  assertEqual(claimA.paths[0], 'src/a.ts');
});

// ── R6: CLAIM_SOURCES closed set, cross-checked both directions ────────────
const sourcesSeen = new Set();
test('R6a: every declared CLAIM_SOURCES entry is accepted by normalizeClaim', () => {
  for (const source of CLAIM_SOURCES) {
    const claim = normalizeClaim({ unit: 'execute-task/T01', source, paths: [] });
    assertEqual(claim.source, source, `source ${source} must round-trip through normalizeClaim`);
    sourcesSeen.add(source);
  }
});
test('R6b: an unknown source is rejected, never recorded', () => {
  let threw = false;
  let message = '';
  try {
    normalizeClaim({ unit: 'execute-task/T01', source: 'chute', paths: [] });
  } catch (e) {
    threw = true;
    message = e.message;
  }
  assert(threw, 'unknown source must throw');
  assert(message.includes('chute'), 'error message must name the rejected value');
});
test('R6c: CLAIM_SOURCES cross-check — every listed source was exercised above', () => {
  for (const source of CLAIM_SOURCES) {
    assert(sourcesSeen.has(source), `CLAIM_SOURCES entry ${source} was never exercised by a test`);
  }
  assertEqual(sourcesSeen.size, CLAIM_SOURCES.length, 'no test exercised a source outside CLAIM_SOURCES');
});

// ── clearClaim resets to null ───────────────────────────────────────────────
test('clearClaim resets a claimed run back to null', () => {
  const { wsDir } = makeFixture('M-20260813-clear');
  recordClaim(wsDir, 'M-20260813-clear', { unit: 'execute-task/T01', source: 'manual', paths: ['a.js'] });
  clearClaim(wsDir, 'M-20260813-clear');
  const rec = runs.get(wsDir, 'M-20260813-clear');
  assertEqual(readClaim(rec), null, 'clearClaim must reset write_claim to null');
});

// ── R7: CLI proved by SPAWN ──────────────────────────────────────────────
test('R7a: CLI --claim spawns, exits 0, --json parses', () => {
  const { wsDir } = makeFixture('M-20260813-cli-claim');
  const res = runCli(['--claim', 'M-20260813-cli-claim', '--unit', 'execute-task/T01',
    '--source', 'manual', '--paths', 'a.js,b.js', '--json', '--cwd', wsDir]);
  assertEqual(res.status, 0, `--claim must exit 0, stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assertEqual(parsed.unit, 'execute-task/T01');
  assert(Array.isArray(parsed.paths) && parsed.paths.length === 2, 'claim must carry the two paths given');
});

test('R7b: CLI --show spawns, exits 0, --json parses the recorded claim', () => {
  const { wsDir } = makeFixture('M-20260813-cli-show');
  recordClaim(wsDir, 'M-20260813-cli-show', { unit: 'execute-task/T01', source: 'manual', paths: ['x.js'] });
  const res = runCli(['--show', 'M-20260813-cli-show', '--json', '--cwd', wsDir]);
  assertEqual(res.status, 0, `--show must exit 0, stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assertEqual(parsed.unit, 'execute-task/T01');
});

test('R7c: CLI --show spawns, exits 0, --json prints null for a never-claimed run', () => {
  const { wsDir } = makeFixture('M-20260813-cli-shownull');
  const res = runCli(['--show', 'M-20260813-cli-shownull', '--json', '--cwd', wsDir]);
  assertEqual(res.status, 0, `--show must exit 0, stderr=${res.stderr}`);
  assertEqual(JSON.parse(res.stdout), null, 'never-claimed run must print JSON null');
});

test('R7d: CLI --clear spawns, exits 0, resets the claim', () => {
  const { wsDir } = makeFixture('M-20260813-cli-clear');
  recordClaim(wsDir, 'M-20260813-cli-clear', { unit: 'execute-task/T01', source: 'manual', paths: ['x.js'] });
  const res = runCli(['--clear', 'M-20260813-cli-clear', '--json', '--cwd', wsDir]);
  assertEqual(res.status, 0, `--clear must exit 0, stderr=${res.stderr}`);
  const rec = runs.get(wsDir, 'M-20260813-cli-clear');
  assertEqual(readClaim(rec), null, 'after --clear the run must read as unclaimed');
});

test('R7e: CLI rejects an unknown source, non-zero exit, no write', () => {
  const { wsDir, runFile } = makeFixture('M-20260813-cli-badsource');
  const before = sha256(runFile);
  const res = runCli(['--claim', 'M-20260813-cli-badsource', '--unit', 'execute-task/T01',
    '--source', 'chute', '--cwd', wsDir]);
  assert(res.status !== 0, 'unknown source must produce a non-zero exit');
  const after = sha256(runFile);
  assertEqual(after, before, 'a rejected claim must never write to the run file');
});

// ── Mordida obrigatória (Step 6 of T01-PLAN) ────────────────────────────────
// Reverts withAddressDefaults' write_claim default in forge-runs.js, shows
// the assert that goes red nominally, restores. Uses a disposable sibling
// copy so the original module is never touched mid-suite.
test('mordida: withAddressDefaults default removed -> legacy read no longer null', () => {
  const runsSrcPath = path.join(__dirname, 'forge-runs.js');
  const src = fs.readFileSync(runsSrcPath, 'utf8');
  const marker = "write_claim: (rec.write_claim === undefined || rec.write_claim === '') ? null : rec.write_claim,";
  assert(src.includes(marker), 'expected write_claim default line not found in forge-runs.js — mordida cannot run');

  const baited = src.replace(marker, '');
  // Baited copy must live NEXT TO its relative deps (./forge-ids.js,
  // ./forge-lock.js, ./forge-runtime.js) to resolve — a disposable sibling
  // in scripts/, not an unrelated tmpdir.
  const baitPath = path.join(__dirname, `.forge-runs-bait-${process.pid}.js`);
  fs.writeFileSync(baitPath, baited, 'utf8');

  delete require.cache[require.resolve(baitPath)];
  const baitedRuns = require(baitPath);

  const { wsDir } = makeFixture('M-20260813-mordida');
  const rec = baitedRuns.get(wsDir, 'M-20260813-mordida');

  let biteFailed = false;
  try {
    assertEqual(rec.write_claim, null, 'baited module: legacy record should read write_claim as null');
  } catch (e) {
    biteFailed = true;
  }
  assert(biteFailed, 'mordida did not bite: removing the default should have made this assert fail');

  delete require.cache[require.resolve(baitPath)];
  try { fs.unlinkSync(baitPath); } catch { /* best effort */ }
});

// ── R8 (review R3): code_dir validado na ESCRITA ───────────────────────────
//
// `code_dir` é fato DADO — o que não significa "qualquer coisa". Um valor
// não-string era persistido verbatim (só `source` era checado) e, na leitura,
// `path.isAbsolute` lançava dentro do comparador, cujo catch global devolvia
// exit 0 SEM veredicto e SEM censo: um registro ruim calava a comparação de
// todas as runs. Recusado aqui, no único ponto que escreve.
test('R8a: normalizeClaim recusa code_dir não-string, nomeando valor e tipo', () => {
  for (const bad of [42, true, {}, ['/x'], 0]) {
    let threw = null;
    try {
      normalizeClaim({ source: 'manual', code_dir: bad });
    } catch (e) { threw = e; }
    assert(threw !== null, `code_dir ${JSON.stringify(bad)} (${typeof bad}) deveria ter sido recusado`);
    assert(/code_dir/.test(threw.message), `a mensagem deve nomear o campo, veio: ${threw.message}`);
  }
});

test('R8b: os valores legítimos continuam passando (a recusa não é larga demais)', () => {
  assertEqual(normalizeClaim({ source: 'manual', code_dir: '/code/dir' }).code_dir, '/code/dir');
  assertEqual(normalizeClaim({ source: 'manual' }).code_dir, null, 'ausente -> null, nunca derivado');
  assertEqual(normalizeClaim({ source: 'manual', code_dir: null }).code_dir, null);
  assertEqual(normalizeClaim({ source: 'manual', code_dir: '' }).code_dir, null);
});

test('R8c: nada é gravado quando o code_dir é recusado', () => {
  const { wsDir, runFile } = makeFixture('M-20260813-badcodedir');
  const before = sha256(runFile);
  let threw = false;
  try {
    recordClaim(wsDir, 'M-20260813-badcodedir', { source: 'manual', code_dir: 42, paths: ['a.js'] });
  } catch (_) { threw = true; }
  assert(threw, 'recordClaim deveria propagar a recusa');
  assertEqual(sha256(runFile), before, 'um claim recusado NÃO pode ter tocado o registro');
});

// ── R9: vcs_baseline — additive, validated at the write boundary ───────────
test('R9a: vcs_baseline absent/null -> null, never derived', () => {
  assertEqual(normalizeClaim({ source: 'manual' }).vcs_baseline, null);
  assertEqual(normalizeClaim({ source: 'manual', vcs_baseline: null }).vcs_baseline, null);
});
test('R9b: vcs_baseline valid shape round-trips', () => {
  const claim = normalizeClaim({ source: 'manual', vcs_baseline: { vcs: 'git', id: 'abc123' } });
  assertEqual(claim.vcs_baseline.vcs, 'git');
  assertEqual(claim.vcs_baseline.id, 'abc123');
  const svnClaim = normalizeClaim({ source: 'manual', vcs_baseline: { vcs: 'svn', id: '42' } });
  assertEqual(svnClaim.vcs_baseline.vcs, 'svn');
});
test('R9c: vcs_baseline malformed throws, naming the rejected value and accepted shape, nothing written', () => {
  const bad = [
    42, 'git:abc', [],
    { vcs: 'hg', id: 'x' },
    { vcs: 'git', id: '' },
    { vcs: 'git', id: 42 },
    { vcs: 'git' },
  ];
  for (const v of bad) {
    let threw = null;
    try { normalizeClaim({ source: 'manual', vcs_baseline: v }); }
    catch (e) { threw = e; }
    assert(threw !== null, `vcs_baseline ${JSON.stringify(v)} deveria ter sido recusado`);
    assert(/vcs_baseline/.test(threw.message), `mensagem deve nomear vcs_baseline, veio: ${threw.message}`);
  }
  const { wsDir, runFile } = makeFixture('M-20260813-r9c');
  const before = sha256(runFile);
  let threw = false;
  try { recordClaim(wsDir, 'M-20260813-r9c', { source: 'manual', vcs_baseline: { vcs: 'hg', id: 'x' } }); }
  catch (_) { threw = true; }
  assert(threw, 'recordClaim deve propagar a recusa');
  assertEqual(sha256(runFile), before, 'vcs_baseline recusado não pode ter tocado o registro');
});

// ── R10: released — additive, validated at the write boundary ──────────────
test('R10a: released absent/null -> null', () => {
  assertEqual(normalizeClaim({ source: 'manual' }).released, null);
  assertEqual(normalizeClaim({ source: 'manual', released: null }).released, null);
});
test('R10b: released valid shape round-trips', () => {
  const claim = normalizeClaim({
    source: 'manual', released: { at: 123, mechanism: 'explicit', evidence: { foo: 'bar' } },
  });
  assertEqual(claim.released.at, 123);
  assertEqual(claim.released.mechanism, 'explicit');
  assertEqual(claim.released.evidence.foo, 'bar');
});
test('R10c: released malformed throws, naming rejected value, nothing written', () => {
  const bad = [
    42, [], { at: 'x', mechanism: 'explicit', evidence: {} },
    { at: 1, mechanism: 'chute', evidence: {} },
    { at: 1, mechanism: 'explicit', evidence: null },
    { at: 1, mechanism: 'explicit' },
  ];
  for (const v of bad) {
    let threw = null;
    try { normalizeClaim({ source: 'manual', released: v }); }
    catch (e) { threw = e; }
    assert(threw !== null, `released ${JSON.stringify(v)} deveria ter sido recusado`);
    assert(/released/.test(threw.message), `mensagem deve nomear released, veio: ${threw.message}`);
  }
  const { wsDir, runFile } = makeFixture('M-20260813-r10c');
  const before = sha256(runFile);
  let threw = false;
  try { recordClaim(wsDir, 'M-20260813-r10c', { source: 'manual', released: { at: 1, mechanism: 'chute', evidence: {} } }); }
  catch (_) { threw = true; }
  assert(threw, 'recordClaim deve propagar a recusa de released');
  assertEqual(sha256(runFile), before, 'released recusado não pode ter tocado o registro');
});

// ── R11: RELEASE_MECHANISMS closed set, cross-checked both directions ──────
const mechanismsSeen = new Set();
test('R11a: every RELEASE_MECHANISMS entry is accepted by normalizeClaim', () => {
  for (const mechanism of RELEASE_MECHANISMS) {
    const claim = normalizeClaim({ source: 'manual', released: { at: 1, mechanism, evidence: {} } });
    assertEqual(claim.released.mechanism, mechanism, `mechanism ${mechanism} must round-trip`);
    mechanismsSeen.add(mechanism);
  }
});
test('R11b: an unknown mechanism is rejected', () => {
  let threw = false, message = '';
  try { normalizeClaim({ source: 'manual', released: { at: 1, mechanism: 'chute', evidence: {} } }); }
  catch (e) { threw = true; message = e.message; }
  assert(threw, 'mecanismo desconhecido deve lançar');
  assert(message.includes('chute'), 'mensagem deve nomear o valor recusado');
});
test('R11c: RELEASE_MECHANISMS cross-check — every listed mechanism was exercised', () => {
  for (const m of RELEASE_MECHANISMS) {
    assert(mechanismsSeen.has(m), `RELEASE_MECHANISMS entry ${m} nunca foi exercitado`);
  }
  assertEqual(mechanismsSeen.size, RELEASE_MECHANISMS.length, 'nenhum teste exercitou mecanismo fora do conjunto');
});

// ── R12: releaseClaim preserves the rest of the claim, field by field ──────
test('R12a: releaseClaim preserves paths/unit/source/code_dir/vcs_baseline exactly', () => {
  const { wsDir } = makeFixture('M-20260813-r12a');
  recordClaim(wsDir, 'M-20260813-r12a', {
    unit: 'execute-task/T01', source: 'manual', code_dir: '/code/dir',
    paths: ['a.js', 'b.js'], vcs_baseline: { vcs: 'git', id: 'deadbeef' },
  });
  const before = readClaim(runs.get(wsDir, 'M-20260813-r12a'));
  const result = releaseClaim(wsDir, 'M-20260813-r12a', { at: 999, mechanism: 'committed', evidence: { probe: 'ok' } });
  assert(result.ok, 'releaseClaim deve retornar ok:true quando há claim');
  const after = readClaim(runs.get(wsDir, 'M-20260813-r12a'));
  assertEqual(after.unit, before.unit, 'unit deve ser preservado');
  assertEqual(after.source, before.source, 'source deve ser preservado');
  assertEqual(after.code_dir, before.code_dir, 'code_dir deve ser preservado');
  assertEqual(JSON.stringify(after.paths), JSON.stringify(before.paths), 'paths devem ser preservados');
  assertEqual(JSON.stringify(after.vcs_baseline), JSON.stringify(before.vcs_baseline), 'vcs_baseline deve ser preservado');
  assertEqual(after.released.mechanism, 'committed');
  assertEqual(after.released.at, 999);
});

test('R12b: releaseClaim on a run with no claim returns a named result, writes nothing', () => {
  const { wsDir, runFile } = makeFixture('M-20260813-r12b');
  const before = sha256(runFile);
  const result = releaseClaim(wsDir, 'M-20260813-r12b', { at: 1, mechanism: 'explicit', evidence: {} });
  assertEqual(result.ok, false, 'run sem claim deve retornar ok:false');
  assertEqual(result.reason, 'no-claim', 'razão deve ser nomeada como no-claim, nunca inventar claim');
  assertEqual(sha256(runFile), before, 'releaseClaim sem claim não pode escrever no registro');
});

test('R12c: releaseClaim writes through runs.update (locked), never fs.writeFileSync directly', () => {
  const { wsDir } = makeFixture('M-20260813-r12c');
  recordClaim(wsDir, 'M-20260813-r12c', { unit: 'execute-task/T01', source: 'manual', paths: [] });
  const result = releaseClaim(wsDir, 'M-20260813-r12c', { at: 1, mechanism: 'explicit', evidence: {} });
  assert(result.ok, 'release deve ter sucesso');
  const rec = runs.get(wsDir, 'M-20260813-r12c');
  assert(rec.write_claim.released !== null, 'released deve estar persistido no registry');
});

// ── R13: THREE distinct facts — absent × claimed-empty × released — never collapse
test('R13: absent, claimed-empty and released are three distinct facts, each with its own assert', () => {
  const { wsDir } = makeFixture('M-20260813-r13');

  // Fact 1: absent — never claimed.
  const recAbsent = runs.get(wsDir, 'M-20260813-r13');
  assertEqual(readClaim(recAbsent), null, 'fact 1: absent must read as null');
  assertEqual(isHeld(readClaim(recAbsent)), false, 'fact 1: isHeld(absent) must be false');

  // Fact 2: claimed, honestly empty.
  recordClaim(wsDir, 'M-20260813-r13', { unit: 'execute-task/T01', source: 'manual', paths: [] });
  const recEmpty = runs.get(wsDir, 'M-20260813-r13');
  const claimEmpty = readClaim(recEmpty);
  assert(claimEmpty !== null, 'fact 2: claimed-empty must not read as null');
  assertEqual(claimEmpty.released, null, 'fact 2: claimed-empty must not carry a released envelope');
  assertEqual(isHeld(claimEmpty), true, 'fact 2: isHeld(claimed-empty) must be true');

  // Fact 3: released — paths stay intact, released envelope present.
  releaseClaim(wsDir, 'M-20260813-r13', { at: 1, mechanism: 'ttl-expired', evidence: {} });
  const recReleased = runs.get(wsDir, 'M-20260813-r13');
  const claimReleased = readClaim(recReleased);
  assert(claimReleased !== null, 'fact 3: released claim must still be present, not absent');
  assert(claimReleased.released !== null, 'fact 3: released envelope must be present');
  assertEqual(isHeld(claimReleased), false, 'fact 3: isHeld(released) must be false');

  // isHeld(false) happens for BOTH fact 1 and fact 3, for DIFFERENT reasons —
  // distinguishable only by inspecting the claim itself, never by isHeld alone.
  assertEqual(readClaim(recAbsent), null, 'fact 1 remains null (re-asserted)');
  assert(readClaim(recReleased) !== null, 'fact 3 remains non-null (re-asserted) — released ≠ absent');
});

test('R13b: malformed release envelope remains held (fail closed)', () => {
  assertEqual(isHeld({ paths: ['valuable.js'], released: 'corrupt' }), true, 'string ilegível');
  assertEqual(isHeld({ paths: ['valuable.js'], released: {} }), true, 'objeto parcial');
});

// ── R14: legacy record — vcs_baseline/released default null, sha256 unchanged by read
test('R13c: only null/undefined mean absence; malformed falsy claims remain held', () => {
  assertEqual(isHeld(null), false, 'null is canonical absence');
  assertEqual(isHeld(undefined), false, 'undefined is canonical absence');
  for (const malformed of [false, 0, '', NaN]) {
    assertEqual(isHeld(malformed), true, `malformed claim ${String(malformed)}`);
  }
});

test('R14: legacy record (no vcs_baseline/released) reads both as null, sha256 unchanged', () => {
  const { wsDir, runFile } = makeFixture('M-20260813-legacy-r14');
  const before = sha256(runFile);
  const rec = runs.get(wsDir, 'M-20260813-legacy-r14');
  assertEqual(rec.write_claim, null, 'legacy record has no write_claim at all -> null');
  const after = sha256(runFile);
  assertEqual(after, before, 'reading a legacy record must not rewrite it');
});

// ── R15 (review posture): guard-of-source scan — runs.update only, never fs.writeFileSync
// directly on the run registry file, with a POSITIVE control (planting the
// forbidden pattern in a copy must turn the scan red).
test('R15: source scan — every write path uses runs.update, never fs.writeFileSync on the run file directly', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  const stripped = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const forbidden = /fs\.writeFileSync\s*\(\s*(runFile|rf|f)\b/;
  assert(!forbidden.test(stripped), 'forge-write-claim.js não deve chamar fs.writeFileSync diretamente no arquivo do run');

  // Positive control: plant the forbidden pattern and confirm the scan goes red.
  const planted = `${stripped}\nfunction bait(){ fs.writeFileSync(runFile, "{}"); }`;
  assert(forbidden.test(planted), 'controle positivo: a varredura deve acusar o padrão plantado');
});

// ── R16 (review R1): the release is atomic against the claim's IDENTITY ─────
//
// The race, simulated at the only point where it can be observed from a single
// process: the caller measures a claim, the OWNER records the next unit's claim
// in that window, and only then is the release asked for. Before the fix, the
// stale object (already carrying the `released` envelope) overwrote the fresh
// one — live in-flight writes covered by a released claim, which is the
// under-block this milestone exists to prevent.
test('R16a: a claim recorded between the read and the write makes the release REFUSE (stale-claim)', () => {
  const { wsDir } = makeFixture('M-20260813-r16a');
  recordClaim(wsDir, 'M-20260813-r16a', {
    at: 1000, unit: 'execute-task/T01', source: 'plan-writes',
    code_dir: '/code', paths: ['a.js'], vcs_baseline: { vcs: 'git', id: 'aaa' },
  });
  // The caller measures THIS claim...
  const observed = readClaim(runs.get(wsDir, 'M-20260813-r16a'));
  assertEqual(observed.unit, 'execute-task/T01', 'pré-condição: o claim medido é o da T01');

  // ...and the owner records the NEXT unit's claim in the window.
  recordClaim(wsDir, 'M-20260813-r16a', {
    at: 2000, unit: 'execute-task/T02', source: 'plan-writes',
    code_dir: '/code', paths: ['b.js'], vcs_baseline: { vcs: 'git', id: 'bbb' },
  });

  const result = releaseClaim(
    wsDir, 'M-20260813-r16a',
    { at: 3000, mechanism: 'committed', evidence: {} },
    { expect: observed });

  assertEqual(result.ok, false, 'o release deve RECUSAR — o claim medido não é mais o persistido');
  assertEqual(result.reason, 'stale-claim', 'a recusa deve ser NOMEADA, nunca silenciosa');

  const after = readClaim(runs.get(wsDir, 'M-20260813-r16a'));
  assertEqual(after.unit, 'execute-task/T02', 'o claim FRESCO deve sobreviver — jamais sobrescrito pelo velho');
  assertEqual(after.at, 2000, 'o `at` fresco deve sobreviver');
  assertEqual(after.released, null, 'o claim fresco NÃO pode sair liberado por um release da unidade anterior');
  assertEqual(JSON.stringify(after.paths), JSON.stringify(['b.js']), 'os paths frescos devem sobreviver');
});

test('R16b: identity matching — the SAME claim still releases (a refusal that refuses everything is inert)', () => {
  const { wsDir } = makeFixture('M-20260813-r16b');
  recordClaim(wsDir, 'M-20260813-r16b', {
    at: 1000, unit: 'execute-task/T01', source: 'plan-writes',
    code_dir: '/code', paths: ['a.js'], vcs_baseline: { vcs: 'git', id: 'aaa' },
  });
  const observed = readClaim(runs.get(wsDir, 'M-20260813-r16b'));
  const result = releaseClaim(
    wsDir, 'M-20260813-r16b',
    { at: 3000, mechanism: 'committed', evidence: {} },
    { expect: observed });
  assertEqual(result.ok, true, 'sem corrida, o release deve acontecer');
  assertEqual(readClaim(runs.get(wsDir, 'M-20260813-r16b')).released.mechanism, 'committed');
});

test('R16c: the read happens INSIDE the lock — releaseClaim goes through runs.updateWith', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  const body = src.slice(src.indexOf('function releaseClaim('), src.indexOf('function isHeld('));
  const stripped = body.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert(/runs\.updateWith\s*\(/.test(stripped),
    'releaseClaim deve escrever pelo mutator locado (runs.updateWith)');
  assert(!/runs\.update\s*\(/.test(stripped),
    'releaseClaim NÃO pode voltar ao runs.update com patch derivado de leitura fora do lock');
  // Positive control: the same predicate must go red on a planted regression.
  const planted = `${stripped}\n runs.update(cwd, runId, { write_claim: nextClaim });`;
  assert(/runs\.update\s*\(/.test(planted), 'controle positivo: a varredura deve acusar o padrão plantado');
});

// ── R17 (review R4): the CLI may not stamp a mechanism it never measured ────
test('R17a: CLI --release --mechanism committed is REFUSED by name, nothing written', () => {
  const { wsDir, runFile } = makeFixture('M-20260813-r17a');
  recordClaim(wsDir, 'M-20260813-r17a', { unit: 'execute-task/T01', source: 'manual', paths: ['a.js'] });
  const before = sha256(runFile);
  const res = runCli(['--release', 'M-20260813-r17a', '--mechanism', 'committed', '--cwd', wsDir]);
  assertEqual(res.status, 1, 'a CLI deve sair 1 ao recusar');
  assert(/committed/.test(res.stderr), 'a recusa deve NOMEAR o mecanismo rejeitado');
  assert(/forge-claim-release/.test(res.stderr), 'a recusa deve apontar quem MEDE o mecanismo corroborado');
  assertEqual(sha256(runFile), before, 'nada pode ser gravado numa recusa');
  const claim = readClaim(runs.get(wsDir, 'M-20260813-r17a'));
  assertEqual(claim.released, null, 'o envelope forjado não pode existir');
});

test('R17b: CLI --release --mechanism ttl-expired is REFUSED too (both corroborated names)', () => {
  const { wsDir } = makeFixture('M-20260813-r17b');
  recordClaim(wsDir, 'M-20260813-r17b', { unit: 'execute-task/T01', source: 'manual', paths: [] });
  const res = runCli(['--release', 'M-20260813-r17b', '--mechanism', 'ttl-expired', '--cwd', wsDir]);
  assertEqual(res.status, 1, 'ttl-expired também afirma medição — deve ser recusado');
  assertEqual(readClaim(runs.get(wsDir, 'M-20260813-r17b')).released, null, 'nada gravado');
});

test('R17c: CLI --release writes `manual` (the mechanism that asserts NOTHING) — default and explicit', () => {
  const { wsDir } = makeFixture('M-20260813-r17c');
  recordClaim(wsDir, 'M-20260813-r17c', { unit: 'execute-task/T01', source: 'manual', paths: ['a.js'] });
  const res = runCli(['--release', 'M-20260813-r17c', '--cwd', wsDir, '--json']);
  assertEqual(res.status, 0, 'o caminho permitido continua saindo 0');
  const claim = readClaim(runs.get(wsDir, 'M-20260813-r17c'));
  assertEqual(claim.released.mechanism, 'manual', 'o default da CLI é `manual`');
  assertEqual(JSON.stringify(claim.paths), JSON.stringify(['a.js']), 'o resto do claim é preservado');

  const { wsDir: ws2 } = makeFixture('M-20260813-r17d');
  recordClaim(ws2, 'M-20260813-r17d', { unit: 'execute-task/T01', source: 'manual', paths: [] });
  const res2 = runCli(['--release', 'M-20260813-r17d', '--mechanism', 'manual', '--cwd', ws2]);
  assertEqual(res2.status, 0, '`manual` explícito também é aceito');
  assertEqual(readClaim(runs.get(ws2, 'M-20260813-r17d')).released.mechanism, 'manual');
});

test('R17e: the library seam keeps the full set — the restriction is CLI-only (T02 depends on it)', () => {
  assert(claimMod.RELEASE_MECHANISMS.includes('committed'), 'a biblioteca mantém `committed`');
  assert(claimMod.RELEASE_MECHANISMS.includes('manual'), '`manual` entrou no conjunto fechado');
  assertEqual(JSON.stringify(claimMod.CLI_RELEASE_MECHANISMS), JSON.stringify(['manual']),
    'a CLI só pode gravar `manual`');
  const { wsDir } = makeFixture('M-20260813-r17e');
  recordClaim(wsDir, 'M-20260813-r17e', { unit: 'execute-task/T01', source: 'manual', paths: [] });
  const r = releaseClaim(wsDir, 'M-20260813-r17e', { at: 1, mechanism: 'committed', evidence: {} });
  assertEqual(r.ok, true, 'a chamada de biblioteca com `committed` segue possível');
});

// ── Suite close ──────────────────────────────────────────────────────────
test('R18: recoverClaim faz release manual + active:false atomicamente', () => {
  const { wsDir } = makeFixture('M-20260813-r18');
  recordClaim(wsDir, 'M-20260813-r18', { unit: 'execute-task/T01', source: 'manual', paths: ['a.js'] });
  const expected = runs.get(wsDir, 'M-20260813-r18');
  const result = recoverClaim(wsDir, expected.id, expected, { at: 9, mechanism: 'manual', evidence: { intent: 'test' } });
  assertEqual(result.ok, true);
  const after = runs.get(wsDir, expected.id);
  assertEqual(after.active, false);
  assertEqual(after.write_claim.released.mechanism, 'manual');
  assertEqual(after.ended_at, 9);
});

test('R18b: recoverClaim aborta CAS quando o claim mudou', () => {
  const { wsDir } = makeFixture('M-20260813-r18b');
  recordClaim(wsDir, 'M-20260813-r18b', { unit: 'execute-task/T01', source: 'manual', paths: ['a.js'] });
  const expected = runs.get(wsDir, 'M-20260813-r18b');
  recordClaim(wsDir, expected.id, { unit: 'execute-task/T02', source: 'manual', paths: ['b.js'] });
  const result = recoverClaim(wsDir, expected.id, expected, { at: 9, mechanism: 'manual', evidence: {} });
  assertEqual(result.ok, false);
  assertEqual(result.reason, 'stale-run');
  assertEqual(runs.get(wsDir, expected.id).active, true);
  assertEqual(runs.get(wsDir, expected.id).write_claim.released, null);
});

test('R18c: validateHeldClaim recusa shape persistido parcial', () => {
  assertEqual(validateHeldClaim({ at: 1, source: 'manual', code_dir: 'C:/x', paths: [], vcs_baseline: null, released: null }).at, 1);
  let reason = null;
  try { validateHeldClaim({ source: 'manual', code_dir: 'C:/x', paths: [], vcs_baseline: null, released: null }); } catch (error) { reason = error.message; }
  assertEqual(reason, 'claim-at-invalid');
});

test('R18d: recoverClaim aborta CAS quando a run mudou fora do claim', () => {
  const { wsDir } = makeFixture('M-20260813-r18d');
  recordClaim(wsDir, 'M-20260813-r18d', { unit: 'execute-task/T01', source: 'manual', paths: ['a.js'] });
  const expected = runs.get(wsDir, 'M-20260813-r18d');
  runs.update(wsDir, expected.id, { last_heartbeat: expected.last_heartbeat + 1 });
  const result = recoverClaim(wsDir, expected.id, expected, { at: 9, mechanism: 'manual', evidence: {} });
  assertEqual(result.ok, false);
  assertEqual(runs.get(wsDir, expected.id).active, true);
});

test('R18e: precondition falha dentro da transição sem publicar patch', () => {
  const { wsDir } = makeFixture('M-20260813-r18e');
  recordClaim(wsDir, 'M-20260813-r18e', { unit: 'execute-task/T01', source: 'manual', paths: ['a.js'] });
  const expected = runs.get(wsDir, 'M-20260813-r18e'); let called = false;
  let reason = null;
  try { recoverClaim(wsDir, expected.id, expected, { at: 9, mechanism: 'manual', evidence: {} }, { precondition: () => { called = true; throw new Error('precondition-refused'); } }); } catch (error) { reason = error.message; }
  assertEqual(called, true); assertEqual(reason, 'precondition-refused'); assertEqual(runs.get(wsDir, expected.id).active, true); assertEqual(runs.get(wsDir, expected.id).write_claim.released, null);
});

cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
