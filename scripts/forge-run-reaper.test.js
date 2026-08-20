#!/usr/bin/env node
'use strict';

// forge-run-reaper.test.js — the recovery path that replaced age-steals-lock is
// reversible, never reports its own inactivity, and never confuses "could not
// ask" with "dead".
//
// Properties this suite carries:
//
//   L1  REAPING IS DEACTIVATION, NEVER DELETION — the record file is still on
//       disk after a reap, `active` is `false`, and every OTHER field survives
//       byte-for-byte. Proved by a BITE (swap `updateWith` for `remove`).
//   L2  the claim gate holds in BOTH directions: a run WITH a claim is never
//       reaped no matter how old, and the SAME record without the claim IS
//       reaped — so the guard is measured, not assumed.
//   L3  `null` write_claim (explicitly cleared) and `undefined` (never written)
//       are both "no claim" — asserted SEPARATELY, never one standing for two.
//   L4  the threshold is strict: age EXACTLY at the threshold is `live`.
//   L5  `unmeasured` is never collapsed into dead — heartbeat absent, NaN, and
//       record absent each keep the run, with their OWN reason.
//   L6  anti-silence: the census is emitted in FULL even when empty, and an
//       unparseable record is COUNTED in `examined` and ENUMERATED — it can
//       never vanish before the count.
//   L7  closed sets (`LIVENESS_STATES`, `LIVENESS_REASONS`) crossed in BOTH
//       directions: nothing emitted falls outside them, and every declared
//       entry is emitted by >= 1 test. (R7d precedent, forge-claim-overlap.)
//   L8  the named event `run-orphan-reaped` reaches `events.jsonl` with run id,
//       reason and age — and is emitted ONLY for actual reaps.
//   L9  the CLI exits 0 ALWAYS, proved by SPAWN: with reaps, with a broken
//       registry, and without `--reap` (which must mutate NOTHING).
//   L10 a record that disappears between the census and the write is a NAMED
//       skip, never an exception that loses the reaps already done.
//   L11 anti-vacuity: the census tests run over NON-EMPTY registries too.
//   L12 TOCTOU (review R1): the classification is RE-ASKED inside the lock. A
//       run that bumps its heartbeat or writes a claim between the census and
//       the write is NOT deactivated, is NAMED in the census with its own
//       reason (`reclassified-under-lock`, never `record-absent`), and emits no
//       event. Crossed the other way: without a race the same orphan IS reaped.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-run-reaper.js');
const runs = require('./forge-runs.js');
const {
  DEFAULT_THRESHOLD_MS, LIVENESS_STATES, LIVENESS_REASONS,
  classifyRunLiveness, reapOrphanRuns, USAGE,
} = require('./forge-run-reaper.js');

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
function mktmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-run-reaper-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const NOW = 1785763253000;

/**
 * Registry fixture: `.gsd/forge/runs/<id>.json` under a synthetic workspace.
 * Same shape as forge-claim-overlap.test.js's `makeFixture` — copied, not
 * reinvented. The fixture is fully self-contained: NOTHING here reads the
 * operator's real prefs or real `.gsd/`.
 */
function makeFixture(specs) {
  const tmp = mktmp();
  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsDir, '.gsd', 'forge', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');

  const runFiles = [];
  for (const spec of specs) {
    const file = path.join(wsDir, '.gsd', 'forge', 'runs', `${spec.id}.json`);
    const base = {
      kind: 'milestone',
      id: spec.id,
      session_id: 'sess-fixture',
      active: spec.active === undefined ? true : spec.active,
      started_at: NOW - 7200000,
      last_heartbeat: spec.last_heartbeat === undefined ? NOW : spec.last_heartbeat,
      worker: null,
      worker_started: null,
      isolation_mode: 'branch',
      milestone_dir: `.gsd/milestones/${spec.id}/`,
      cwd: wsDir,
      branch: `forge/${spec.id}`,
    };
    if (spec.write_claim !== undefined) base.write_claim = spec.write_claim;
    fs.writeFileSync(file, JSON.stringify(base, null, 2), 'utf8');
    runFiles.push(file);
  }
  return { wsDir, runFiles };
}

/** A synthetic claim in the persisted shape. */
function claim(paths) {
  return { at: NOW, unit: 'execute-task/T01', source: 'manual', code_dir: '/code/dir', paths: paths || ['a.js'] };
}

function eventsOf(wsDir) {
  const f = path.join(wsDir, '.gsd', 'forge', 'events.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function runCli(args) {
  const res = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Both-directions crossing of the closed sets.
const statesSeen = new Set();
const reasonsSeen = new Set();

function record(c) {
  assert(LIVENESS_STATES.includes(c.state), `estado fora de LIVENESS_STATES: ${JSON.stringify(c.state)}`);
  assert(LIVENESS_REASONS.includes(c.reason), `razão fora de LIVENESS_REASONS: ${JSON.stringify(c.reason)}`);
  statesSeen.add(c.state);
  reasonsSeen.add(c.reason);
  return c;
}
function recordCensus(out) {
  for (const s of out.skipped) record({ state: s.state, reason: s.reason });
  for (const r of out.reaped) record({ state: 'expired', reason: r.reason });
  return out;
}

console.log('\nforge-run-reaper — desativação reversível de run órfã\n');

// ── L4 + classify basics ────────────────────────────────────────────────────
test('classify: heartbeat recente -> live/heartbeat-fresh', () => {
  const c = record(classifyRunLiveness({ id: 'M-a', active: true, last_heartbeat: NOW - 1000 }, { now: NOW }));
  assertEqual(c.state, 'live', 'estado');
  assertEqual(c.reason, 'heartbeat-fresh', 'razão');
  assertEqual(c.age_ms, 1000, 'age_ms é medido, não estimado');
});

test('classify: heartbeat além do limiar -> expired/heartbeat-expired', () => {
  const c = record(classifyRunLiveness(
    { id: 'M-a', active: true, last_heartbeat: NOW - DEFAULT_THRESHOLD_MS - 1 }, { now: NOW }));
  assertEqual(c.state, 'expired', 'estado');
  assertEqual(c.reason, 'heartbeat-expired', 'razão');
});

test('L4: idade EXATAMENTE no limiar ainda é live — o corte é estrito', () => {
  const c = record(classifyRunLiveness(
    { id: 'M-a', active: true, last_heartbeat: NOW - DEFAULT_THRESHOLD_MS }, { now: NOW }));
  assertEqual(c.state, 'live',
    'idade == limiar não pode expirar: um limiar não-estrito ceifa uma run que acabou de bater o teto');
});

test('classify: thresholdMs customizado é honrado (e 0/negativo cai no default)', () => {
  const rec = { id: 'M-a', active: true, last_heartbeat: NOW - 5000 };
  assertEqual(record(classifyRunLiveness(rec, { now: NOW, thresholdMs: 1000 })).state, 'expired', 'limiar curto expira');
  assertEqual(record(classifyRunLiveness(rec, { now: NOW, thresholdMs: 0 })).state, 'live',
    'limiar 0 é inválido e cai no default — nunca vira "ceife tudo"');
  assertEqual(record(classifyRunLiveness(rec, { now: NOW, thresholdMs: -1 })).state, 'live', 'limiar negativo idem');
});

// ── L2 + L3: the claim gate, both directions, and null vs undefined ─────────
test('L2: run COM claim nunca expira, por mais velha que seja (holds-claim/claim-present)', () => {
  const c = record(classifyRunLiveness(
    { id: 'M-a', active: true, last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 100, write_claim: claim() },
    { now: NOW }));
  assertEqual(c.state, 'holds-claim',
    'a escada de liberação do claim é dona dessa run — o relógio não tem jurisdição aqui');
  assertEqual(c.reason, 'claim-present', 'razão');
});

test('L2 (outro sentido): o MESMO registro sem o claim expira — o guard é medido, não presumido', () => {
  const base = { id: 'M-a', active: true, last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 100 };
  assertEqual(record(classifyRunLiveness(Object.assign({ write_claim: claim() }, {}, base, { write_claim: claim() }), { now: NOW })).state,
    'holds-claim', 'com claim');
  assertEqual(record(classifyRunLiveness(base, { now: NOW })).state, 'expired',
    'sem claim, o mesmo registro TEM de expirar — senão o teste do claim passaria por outro motivo qualquer');
});

test('L3: write_claim null (limpo explicitamente) NÃO é claim vivo', () => {
  const c = record(classifyRunLiveness(
    { id: 'M-a', active: true, last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 2, write_claim: null }, { now: NOW }));
  assertEqual(c.state, 'expired', 'null é o claim liberado — não segura a run');
});

test('L3: write_claim undefined (nunca escrito) NÃO é claim vivo — assert SEPARADO', () => {
  const rec = { id: 'M-a', active: true, last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 2 };
  assert(!Object.prototype.hasOwnProperty.call(rec, 'write_claim'), 'o campo tem de estar ausente de verdade');
  assertEqual(record(classifyRunLiveness(rec, { now: NOW })).state, 'expired',
    'registro anterior ao write claim nunca declarou nada — ausência não é posse');
});

// ── L5: `unmeasured` is never "dead" ────────────────────────────────────────
test('L5: run já inativa -> unmeasured/run-inactive (nada a ceifar)', () => {
  const c = record(classifyRunLiveness({ id: 'M-a', active: false, last_heartbeat: 0 }, { now: NOW }));
  assertEqual(c.state, 'unmeasured', 'estado');
  assertEqual(c.reason, 'run-inactive', 'razão');
});

test('L5: heartbeat ausente/null -> unmeasured/heartbeat-absent, NUNCA expired', () => {
  for (const beat of [undefined, null]) {
    const c = record(classifyRunLiveness({ id: 'M-a', active: true, last_heartbeat: beat }, { now: NOW }));
    assertEqual(c.state, 'unmeasured', `beat=${JSON.stringify(beat)}: pergunta que não pôde ser feita mantém a run`);
    assertEqual(c.reason, 'heartbeat-absent', 'razão');
  }
});

test('L5: heartbeat não-numérico -> unmeasured/heartbeat-not-a-number', () => {
  const c = record(classifyRunLiveness({ id: 'M-a', active: true, last_heartbeat: 'ontem' }, { now: NOW }));
  assertEqual(c.state, 'unmeasured', 'estado');
  assertEqual(c.reason, 'heartbeat-not-a-number', 'razão');
});

test('L5: registro ausente -> unmeasured/record-absent', () => {
  for (const rec of [null, undefined, 'nope']) {
    const c = record(classifyRunLiveness(rec, { now: NOW }));
    assertEqual(c.state, 'unmeasured', `rec=${JSON.stringify(rec)}`);
    assertEqual(c.reason, 'record-absent', 'razão');
  }
});

test('exclude: a própria run do chamador nunca se ceifa (unmeasured/excluded)', () => {
  const rec = { id: 'M-eu', active: true, last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 10 };
  assertEqual(record(classifyRunLiveness(rec, { now: NOW })).state, 'expired', 'sem exclude, expiraria');
  const c = record(classifyRunLiveness(rec, { now: NOW, exclude: ['M-eu'] }));
  assertEqual(c.state, 'unmeasured', 'estado');
  assertEqual(c.reason, 'excluded', 'razão');
});

// ── L1: deactivation, never deletion ────────────────────────────────────────
test('L1: reap DESATIVA e NÃO deleta — arquivo em disco, active:false, demais campos intactos', () => {
  const { wsDir, runFiles } = makeFixture([{ id: 'M-morta', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3 }]);
  const before = JSON.parse(fs.readFileSync(runFiles[0], 'utf8'));

  const out = recordCensus(reapOrphanRuns(wsDir, { now: NOW }));
  assertEqual(out.reaped.length, 1, 'a run órfã tem de ser ceifada');
  assertEqual(out.reaped[0].id, 'M-morta', 'id nomeado');

  assert(fs.existsSync(runFiles[0]),
    'DELETAR destrói uma run que alguém planejava retomar — o reap é reversível por desenho (D15)');
  const after = JSON.parse(fs.readFileSync(runFiles[0], 'utf8'));
  assertEqual(after.active, false, 'active passa a false');
  for (const k of Object.keys(before)) {
    if (k === 'active') continue;
    assertEqual(JSON.stringify(after[k]), JSON.stringify(before[k]), `campo ${k} não pode mudar num reap`);
  }
  assert(runs.get(wsDir, 'M-morta') !== null, 'o RunRecord continua legível — um resume reativa e re-reivindica');
});

test('L1: um resume consegue reverter — active volta a true e o registro é o mesmo', () => {
  const { wsDir } = makeFixture([{ id: 'M-morta', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3 }]);
  recordCensus(reapOrphanRuns(wsDir, { now: NOW }));
  const res = runs.updateWith(wsDir, 'M-morta', () => ({ active: true }));
  assertEqual(res.updated, true, 'a reativação tem de funcionar');
  assertEqual(runs.get(wsDir, 'M-morta').active, true, 'reversível de fato, não só na prosa');
});

test('L1: nada é escrito quando nada expira — sha256 idêntico antes e depois', () => {
  const { wsDir, runFiles } = makeFixture([
    { id: 'M-viva', last_heartbeat: NOW },
    { id: 'M-com-claim', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 5, write_claim: claim() },
    { id: 'M-inativa', active: false, last_heartbeat: 0 },
  ]);
  const before = runFiles.map(sha256);
  const out = recordCensus(reapOrphanRuns(wsDir, { now: NOW }));
  assertEqual(out.reaped.length, 0, 'nenhuma dessas é ceifável');
  assertEqual(out.skipped.length, 3, 'as três aparecem NOMEADAS no censo, nenhuma some');
  const after = runFiles.map(sha256);
  for (let i = 0; i < runFiles.length; i++) {
    assertEqual(after[i], before[i], `o reaper escreveu em ${path.basename(runFiles[i])} sem ceifar`);
  }
});

// ── L6: anti-silence census ─────────────────────────────────────────────────
test('L6: registry vazio -> censo COMPLETO mesmo assim (silêncio == detector quebrado)', () => {
  const { wsDir } = makeFixture([]);
  const out = reapOrphanRuns(wsDir, { now: NOW });
  assertEqual(out.ok, true, 'ok');
  assertEqual(out.examined, 0, 'examined');
  assert(Array.isArray(out.reaped) && Array.isArray(out.skipped) && Array.isArray(out.unparseable),
    'as três coleções são sempre emitidas, inclusive vazias');
});

test('L6/L11: registro ilegível é CONTADO em examined e ENUMERADO — nunca some antes da conta', () => {
  const { wsDir } = makeFixture([
    { id: 'M-viva', last_heartbeat: NOW },
    { id: 'M-morta', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3 },
  ]);
  fs.writeFileSync(path.join(wsDir, '.gsd', 'forge', 'runs', 'M-truncada.json'),
    '{"kind":"milestone","id":"M-truncada","act', 'utf8');

  const out = recordCensus(reapOrphanRuns(wsDir, { now: NOW }));
  assertEqual(out.examined, 3, 'examined conta parsed + unparseable — a conta é do universo, não do resto');
  assertEqual(out.unparseable.length, 1, 'o ilegível é enumerado');
  assertEqual(out.unparseable[0].id, 'M-truncada', 'nomeado');
  assert(out.unparseable[0].reason, 'com razão nomeada');
  assertEqual(out.reaped.length + out.skipped.length + out.unparseable.length, out.examined,
    'reaped + skipped + unparseable reconcilia com examined: ninguém cai fora do censo');
});

test('L11 (anti-vacuidade): o censo dos skips roda sobre registry NÃO-vazio e nomeia cada estado', () => {
  const { wsDir } = makeFixture([
    { id: 'M-viva', last_heartbeat: NOW },
    { id: 'M-claim', last_heartbeat: 0, write_claim: claim() },
    { id: 'M-inativa', active: false },
    { id: 'M-sem-beat', last_heartbeat: null },
    { id: 'M-morta', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3 },
  ]);
  const out = recordCensus(reapOrphanRuns(wsDir, { now: NOW }));
  assert(out.examined >= 5, 'o censo tem de rodar sobre entradas de verdade — zero entradas passando é inerte');
  assertEqual(out.reaped.length, 1, 'só a órfã é ceifada');
  const byId = Object.fromEntries(out.skipped.map((s) => [s.id, s]));
  assertEqual(byId['M-viva'].reason, 'heartbeat-fresh', 'viva');
  assertEqual(byId['M-claim'].reason, 'claim-present', 'com claim');
  assertEqual(byId['M-inativa'].reason, 'run-inactive', 'inativa');
  assertEqual(byId['M-sem-beat'].reason, 'heartbeat-absent', 'sem heartbeat');
});

// ── L8: the named event ─────────────────────────────────────────────────────
test('L8: o reap emite run-orphan-reaped em events.jsonl com run, razão e idade', () => {
  const { wsDir } = makeFixture([{ id: 'M-morta', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3 }]);
  fs.mkdirSync(path.join(wsDir, '.gsd', 'forge'), { recursive: true });
  recordCensus(reapOrphanRuns(wsDir, { now: NOW }));
  const evs = eventsOf(wsDir).filter((e) => e.event === 'run-orphan-reaped');
  assertEqual(evs.length, 1, 'um evento nomeado por reap');
  assertEqual(evs[0].run, 'M-morta', 'a run é nomeada');
  assertEqual(evs[0].reason, 'heartbeat-expired', 'a razão é a medida');
  assert(typeof evs[0].age_ms === 'number' && evs[0].age_ms > 0, 'a idade medida viaja no evento');
  assert(typeof evs[0].ts === 'string', 'timestamp');
});

test('L8 (outro sentido): sem reap, nenhum evento é emitido', () => {
  const { wsDir } = makeFixture([{ id: 'M-viva', last_heartbeat: NOW }]);
  recordCensus(reapOrphanRuns(wsDir, { now: NOW }));
  assertEqual(eventsOf(wsDir).filter((e) => e.event === 'run-orphan-reaped').length, 0,
    'evento sem ceife seria um relatório de trabalho que não houve');
});

// ── L10: record vanishing between census and write ──────────────────────────
test('L10: registro que some entre o censo e a escrita vira skip NOMEADO, não exceção', () => {
  const { wsDir } = makeFixture([
    { id: 'M-some', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3 },
    { id: 'M-morta', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3 },
  ]);
  const realUpdateWith = runs.updateWith;
  runs.updateWith = function patched(cwd, id, mutator) {
    if (id === 'M-some') throw new Error(`forge-runs.updateWith: run ${id} not found`);
    return realUpdateWith(cwd, id, mutator);
  };
  let out;
  try {
    out = reapOrphanRuns(wsDir, { now: NOW });
  } finally {
    runs.updateWith = realUpdateWith;
  }
  recordCensus(out);
  assertEqual(out.reaped.length, 1,
    'uma corrida numa run não pode perder os ceifes já feitos das outras');
  assertEqual(out.reaped[0].id, 'M-morta', 'a que sobreviveu foi ceifada');
  const skip = out.skipped.find((s) => s.id === 'M-some');
  assert(skip, 'a que sumiu tem de aparecer NOMEADA — sumir dela é o silêncio que o censo existe para proibir');
  assertEqual(skip.reason, 'record-absent', 'razão do conjunto fechado');
});

// ── L12: TOCTOU between the census and the write (review R1) ────────────────
//
// The classification comes from a snapshot taken BEFORE the lock. If it were applied
// unconditionally inside the lock, a target that bumps its heartbeat or writes a claim in that
// window would be deactivated while LIVE / while HOLDING A CLAIM — the two guarantees this module
// exists to sustain. Both directions of the race are asserted; each test FAILS (the run comes back
// `active: false`) if the re-classification inside the mutator is removed.
//
// The race is staged, not hoped for: `updateWith` is wrapped so the record on disk changes between
// the census and the real call. `updateWith` re-reads inside the lock, so the mutator sees it.
function raceFixture(specs, mutateOnDisk) {
  const { wsDir, runFiles } = makeFixture(specs);
  const realUpdateWith = runs.updateWith;
  runs.updateWith = function patched(cwd, id, mutator) {
    mutateOnDisk(cwd, id);
    return realUpdateWith(cwd, id, mutator);
  };
  try {
    return { wsDir, runFiles, out: recordCensus(reapOrphanRuns(wsDir, { now: NOW })) };
  } finally {
    runs.updateWith = realUpdateWith;
  }
}
function patchRecord(cwd, id, patch) {
  const f = path.join(cwd, '.gsd', 'forge', 'runs', `${id}.json`);
  const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify(Object.assign(rec, patch), null, 2), 'utf8');
}

test('L12: run que bumpa o heartbeat entre o censo e a escrita NÃO é desativada', () => {
  const { wsDir, runFiles, out } = raceFixture(
    [{ id: 'M-ressuscita', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3 }],
    (cwd, id) => patchRecord(cwd, id, { last_heartbeat: NOW }),
  );
  assertEqual(out.reaped.length, 0, 'uma run VIVA no instante da escrita não pode ser ceifada');
  assertEqual(JSON.parse(fs.readFileSync(runFiles[0], 'utf8')).active, true,
    'o registro tem de continuar active:true — desativar aqui é exatamente o defeito');
  const skip = out.skipped.find((s) => s.id === 'M-ressuscita');
  assert(skip, 'o censo tem de NOMEAR a run poupada — poupar em silêncio é indistinguível de não olhar');
  assertEqual(skip.reason, 'reclassified-under-lock', 'razão própria, do conjunto fechado');
  assertEqual(skip.state, 'live', 'e o estado fresco medido dentro do lock');
  assertEqual(skip.recheck.reason, 'heartbeat-fresh', 'a evidência da reavaliação viaja no censo');
  assertEqual(eventsOf(wsDir).filter((e) => e.event === 'run-orphan-reaped').length, 0,
    'evento só depois do update condicional ter sucedido');
});

test('L12: run que grava write_claim entre o censo e a escrita NÃO é desativada', () => {
  const { runFiles, out } = raceFixture(
    [{ id: 'M-claima', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3 }],
    (cwd, id) => patchRecord(cwd, id, { write_claim: claim(['x.js']) }),
  );
  assertEqual(out.reaped.length, 0, 'o claim tem dono e ladder próprios — o relógio não decide aqui');
  assertEqual(JSON.parse(fs.readFileSync(runFiles[0], 'utf8')).active, true, 'segue ativa');
  const skip = out.skipped.find((s) => s.id === 'M-claima');
  assertEqual(skip.reason, 'reclassified-under-lock', 'razão nomeada');
  assertEqual(skip.recheck.reason, 'claim-present', 'a reavaliação mediu o claim recém-gravado');
});

test('L12 (o outro sentido): sem corrida, a mesma órfã É ceifada — o guard não é um freio geral', () => {
  const { wsDir, runFiles } = makeFixture([
    { id: 'M-morta', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3 },
  ]);
  const out = recordCensus(reapOrphanRuns(wsDir, { now: NOW }));
  assertEqual(out.reaped.length, 1, 'sem mudança sob o lock a reavaliação confirma e o ceife acontece');
  assertEqual(JSON.parse(fs.readFileSync(runFiles[0], 'utf8')).active, false, 'desativada');
});

test('L12: abort por reavaliação e record-absent são fatos SEPARADOS no censo', () => {
  const { wsDir } = makeFixture([
    { id: 'M-some', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3 },
    { id: 'M-ressuscita', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3 },
  ]);
  const realUpdateWith = runs.updateWith;
  runs.updateWith = function patched(cwd, id, mutator) {
    if (id === 'M-some') throw new Error(`forge-runs.updateWith: run ${id} not found`);
    patchRecord(cwd, id, { last_heartbeat: NOW });
    return realUpdateWith(cwd, id, mutator);
  };
  let out;
  try { out = recordCensus(reapOrphanRuns(wsDir, { now: NOW })); } finally { runs.updateWith = realUpdateWith; }
  const byId = Object.fromEntries(out.skipped.map((s) => [s.id, s]));
  assertEqual(byId['M-some'].reason, 'record-absent', 'o registro que sumiu');
  assertEqual(byId['M-ressuscita'].reason, 'reclassified-under-lock', 'o que mudou de resposta');
  assert(byId['M-some'].reason !== byId['M-ressuscita'].reason,
    'colapsar os dois esconderia uma run viva poupada atrás de "o arquivo sumiu"');
});

// ── L7: closed sets, both directions ────────────────────────────────────────
test('L7: LIVENESS_STATES — toda entrada declarada foi emitida por >= 1 teste', () => {
  for (const s of LIVENESS_STATES) {
    assert(statesSeen.has(s),
      `LIVENESS_STATES: ${s} nunca foi emitido — um estado declarado que nada produz é indistinguível de um estado morto`);
  }
});

test('L7: LIVENESS_REASONS — toda entrada declarada foi emitida por >= 1 teste', () => {
  for (const r of LIVENESS_REASONS) {
    assert(reasonsSeen.has(r),
      `LIVENESS_REASONS: ${r} nunca foi emitida — razão declarada e nunca produzida é razão morta`);
  }
});

test('L7: o próprio módulo recusa estado/razão fora do conjunto (guard interno vivo)', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  assert(src.includes('LIVENESS_STATES.includes(c.state)'), 'o guard de estado tem de existir no módulo');
  assert(src.includes('LIVENESS_REASONS.includes(c.reason)'), 'o guard de razão tem de existir no módulo');
});

// ── L9: the CLI ─────────────────────────────────────────────────────────────
test('L9: CLI sem --reap imprime uso e NÃO muta nada (exit 0)', () => {
  const { wsDir, runFiles } = makeFixture([{ id: 'M-morta', last_heartbeat: 1 }]);
  const before = runFiles.map(sha256);
  const r = runCli(['--cwd', wsDir]);
  assertEqual(r.status, 0, 'exit 0');
  assert(r.stdout.includes('uso:'), `o uso deve ser impresso, veio: ${r.stdout}`);
  assertEqual(sha256(runFiles[0]), before[0], 'sem --reap nada pode ser escrito');
  assert(USAGE.includes('NUNCA deleta'), 'o próprio uso declara que o reap não deleta');
});

test('L9: CLI --reap --json ceifa, exit 0, e o censo sai completo no JSON', () => {
  const { wsDir, runFiles } = makeFixture([
    { id: 'M-morta', last_heartbeat: 1 },
    { id: 'M-viva', last_heartbeat: Date.now() },
  ]);
  const r = runCli(['--reap', '--cwd', wsDir, '--json']);
  assertEqual(r.status, 0, `exit 0 sempre (advisory); stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assertEqual(out.reaped.length, 1, 'ceifou a órfã');
  assertEqual(out.reaped[0].id, 'M-morta', 'nomeada');
  assertEqual(out.examined, 2, 'censo do universo');
  assert(Array.isArray(out.skipped) && Array.isArray(out.unparseable), 'censo completo no JSON');
  assert(fs.existsSync(runFiles[0]), 'CLI também DESATIVA, nunca deleta');
  assertEqual(JSON.parse(fs.readFileSync(runFiles[0], 'utf8')).active, false, 'active:false via CLI');
});

test('L9: CLI --threshold-ms é honrado (a viva de 5s cai sob limiar de 1ms)', () => {
  const { wsDir } = makeFixture([{ id: 'M-quase-viva', last_heartbeat: Date.now() - 5000 }]);
  const r = runCli(['--reap', '--cwd', wsDir, '--json', '--threshold-ms', '1']);
  assertEqual(r.status, 0, 'exit 0');
  assertEqual(JSON.parse(r.stdout).reaped.length, 1, 'o limiar da linha de comando tem de valer');
});

test('L9: CLI com registry ilegível ainda sai 0 e emite censo (advisory nunca derruba ninguém)', () => {
  const { wsDir } = makeFixture([]);
  fs.writeFileSync(path.join(wsDir, '.gsd', 'forge', 'runs', 'M-lixo.json'), 'nao sou json', 'utf8');
  const r = runCli(['--reap', '--cwd', wsDir, '--json']);
  assertEqual(r.status, 0, 'exit 0 mesmo com registry quebrado');
  const out = JSON.parse(r.stdout);
  assertEqual(out.unparseable.length, 1, 'o ilegível é enumerado, não engolido');
  assertEqual(out.examined, 1, 'e contado');
});

test('L9: CLI em diretório sem .gsd sai 0 e não fabrica .gsd/', () => {
  const tmp = mktmp();
  const r = runCli(['--reap', '--cwd', tmp, '--json']);
  assertEqual(r.status, 0, 'exit 0');
  assert(!fs.existsSync(path.join(tmp, '.gsd')), 'o reaper não pode manufaturar um .gsd/');
});

// ── Suite close ─────────────────────────────────────────────────────────────
test('claim released volta ao relógio e é desativado sem perder evidência', () => {
  const released = Object.assign(claim(['released.js']), {
    released: { at: NOW - 1000, mechanism: 'committed', evidence: { commit: 'abc123' } },
  });
  const classified = record(classifyRunLiveness(
    { id: 'M-released-unit', active: true, last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 2, write_claim: released },
    { now: NOW }));
  assertEqual(classified.state, 'expired', 'released não representa posse efetiva');
  const { wsDir, runFiles } = makeFixture([
    { id: 'M-released', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3, write_claim: released },
  ]);
  const before = JSON.parse(fs.readFileSync(runFiles[0], 'utf8')).write_claim;
  const out = recordCensus(reapOrphanRuns(wsDir, { now: NOW }));
  assertEqual(out.reaped.length, 1, 'released não bloqueia o ceife reversível');
  const after = JSON.parse(fs.readFileSync(runFiles[0], 'utf8'));
  assertEqual(after.active, false, 'run desativada');
  assertEqual(JSON.stringify(after.write_claim), JSON.stringify(before), 'evidência preservada');
});

test('claim released que vira live entre censo e lock NÃO é desativado', () => {
  const released = Object.assign(claim(['old.js']), {
    released: { at: NOW - 1000, mechanism: 'committed', evidence: {} },
  });
  const { runFiles, out } = raceFixture(
    [{ id: 'M-reclaim', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3, write_claim: released }],
    (cwd, id) => patchRecord(cwd, id, { write_claim: claim(['new.js']) }),
  );
  assertEqual(out.reaped.length, 0, 'a posse adquirida na janela impede a desativação');
  assertEqual(JSON.parse(fs.readFileSync(runFiles[0], 'utf8')).active, true, 'segue ativa');
  const skip = out.skipped.find((s) => s.id === 'M-reclaim');
  assertEqual(skip.reason, 'reclassified-under-lock', 'corrida nomeada');
  assertEqual(skip.recheck.state, 'holds-claim', 'revalidação vê posse efetiva');
});

test('release malformado nunca autoriza reap', () => {
  for (const released of ['corrupt', {}]) {
    const c = classifyRunLiveness({
      id: 'M-corrupt', active: true, last_heartbeat: NOW - DEFAULT_THRESHOLD_MS * 3,
      write_claim: { paths: ['valuable.js'], released },
    }, { now: NOW });
    assertEqual(c.state, 'holds-claim', `shape ${JSON.stringify(released)}`);
    assertEqual(c.reason, 'claim-present', 'razão fail-closed');
  }
});

cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
