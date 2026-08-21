#!/usr/bin/env node
'use strict';

// forge-claim-gate.test.js — the decision core never refuses the wrong side,
// never substitutes one cause for the other, and never lets a `defer` with
// nowhere to go degrade into proceeding.
//
// Properties carried here (S04/T01 must_haves, one block each):
//
//   G1  D1 own side, BOTH branches with SEPARATE asserts: ineligible own claim
//       WITH a counterpart in scope -> `refuse`/`undeclared-writes`; the same
//       claim with NOBODY in scope -> `proceed`/`no-active-counterpart`.
//   G2  D1 counterpart side: the counterpart is the one that did not declare ->
//       the decision follows the POSTURE (never `refuse`), cause
//       `undeclared-writes`, `undeclared_side: 'counterpart'`.
//   G3  `overlap` and `undeclared-writes` are never reported one for the other —
//       asserted in BOTH senses.
//   G4  no collision with >= 1 counterpart confronted -> `proceed`/`no-conflict`,
//       distinct from `no-active-counterpart` by its own assert.
//   G5  D7: a conceded item with no path -> `pathless-conceded-item`, carrying
//       the R#s that lack a path; with a counterpart in scope -> `refuse`.
//   G6  D3 floor: `defer` + `ready_alternatives === 0` -> `block` with
//       `floor: 'defer-floor'`. Proved by an EXECUTED bite on a throwaway copy.
//   G7  scope fails CLOSED (W2/contract #5): `unknown` STAYS in scope with the
//       note attached; only a MEASURED `different` leaves, named.
//   G8  the S06/D8 seam receives BOTH complete RunRecords — the counterpart's
//       `isolation_mode` included.
//   G9  closed sets crossed in BOTH directions.
//   G10 `not_covered` (3 boundaries) and the census ride on EVERY result,
//       `proceed` included.
//   G11 the source never names `writesConflict` — positive AND negative control;
//       the two S03 polarity suites stay green BY SPAWN, without edition.
//   G12 CLI posture: exit 0 when it evaluated (any decision), 2 on usage, != 0
//       on an internal error — this gate is ENFORCING, not advisory.
//   G23 D8 (S06/T02): the SAME gate input decides `block` when the isolation
//       resolver returns `unmet_requirement` and `defer` when it does not —
//       the ONLY difference between the two runs being the presence of the
//       field. Plus the same pair against a REAL fixture (an `.svn` working
//       copy with `require_worktree: true` × a git checkout) with NO injected
//       resolver, an EXECUTED bite on the single line that reads the field,
//       both new closed sets crossed in both directions, the two
//       non-measurement notes (which never harden and never loosen), and the
//       interaction with the D3 floor (D8 fires BEFORE it, so `floor` is null
//       and the two routes to `block` stay distinguishable).
//   G24 doc↔code conformance (S06/T03): POSTURE_OVERRIDES/OVERRIDE_EFFECTS and
//       the three new event fields appear literally in shared/forge-claim-gate.md,
//       proved non-vacuous by a positive control (an invented member is NOT found).
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-claim-gate.js');
const POLARITY_TEST = path.join(__dirname, 'forge-claim-polarity.test.js');
const OVERLAP_TEST = path.join(__dirname, 'forge-claim-overlap.test.js');
const LEASE_REPRO_TEST = path.join(__dirname, 'forge-claim-lease-repro.test.js');

const gate = require('./forge-claim-gate.js');
const {
  deriveClaimFromPlan, deriveClaimFromConcededItems, resolvePosture, evaluateGate,
  GATE_DECISIONS, GATE_CAUSES, PROCEED_REASONS, GATE_SKIP_REASONS, GATE_NOTE_REASONS,
  UNCOVERED_BOUNDARIES, POSTURE_OVERRIDES, OVERRIDE_EFFECTS,
} = gate;

const SPEC_PATH = path.join(__dirname, '..', 'shared', 'forge-claim-gate.md');
const { CLAIM_NOTE_REASONS } = require('./forge-claim-overlap.js');

// ── Runner ─────────────────────────────────────────────────────────────────
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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-gate-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** A claim in the persisted shape (no disk). */
function claim(paths, codeDir, extra) {
  return Object.assign({
    at: 1785763253000,
    unit: 'execute-task/T01',
    source: 'manual',
    code_dir: codeDir === undefined ? '/code/dir' : codeDir,
    paths: paths === null ? [] : paths,
  }, extra || {});
}

/**
 * Synthetic registry `.gsd/forge/runs/<id>.json` — mould of
 * forge-claim-overlap.test.js. The LIVE registry under the workspace is never
 * read or written by this suite.
 */
function makeFixture(specs) {
  const tmp = mktmp();
  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsDir, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');

  for (const spec of specs) {
    const file = path.join(wsDir, '.gsd', 'forge', 'runs', `${spec.id}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.assign({
      kind: 'milestone',
      id: spec.id,
      session_id: 'sess-fixture',
      active: spec.active === undefined ? true : spec.active,
      started_at: 1785763253000,
      // Fresh by default: release-specific tests exercise the gate census,
      // not the stale-run reaper that recordAndEvaluate invokes first.
      last_heartbeat: Date.now(),
      worker: null,
      worker_started: null,
      isolation_mode: spec.isolation_mode || 'branch',
      milestone_dir: `.gsd/milestones/${spec.id}/`,
      cwd: wsDir,
    }, spec.write_claim === undefined ? {} : { write_claim: spec.write_claim }), null, 2), 'utf8');
  }
  return wsDir;
}

function runCli(args) {
  const res = spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Direction 1 of every crossing, applied to EVERY result that passes through:
// nothing this code emits may fall outside the declared sets.
const decisionsSeen = new Set();
const causesSeen = new Set();
const proceedReasonsSeen = new Set();
const skipsSeen = new Set();
const notesSeen = new Set();

function record(result) {
  assert(GATE_DECISIONS.includes(result.decision), `decisão fora de GATE_DECISIONS: ${result.decision}`);
  decisionsSeen.add(result.decision);
  if (result.cause !== null && result.cause !== undefined) {
    assert(GATE_CAUSES.includes(result.cause), `causa fora de GATE_CAUSES: ${result.cause}`);
    causesSeen.add(result.cause);
  }
  if (result.reason !== null && result.reason !== undefined) {
    assert(PROCEED_REASONS.includes(result.reason), `razão fora de PROCEED_REASONS: ${result.reason}`);
    proceedReasonsSeen.add(result.reason);
  }
  for (const s of result.census.skipped) {
    assert(GATE_SKIP_REASONS.includes(s.reason) || CLAIM_SKIP_REASONS_OK(s.reason),
      `skip fora de GATE_SKIP_REASONS: ${s.reason}`);
    skipsSeen.add(s.reason);
  }
  for (const n of result.census.notes) {
    assert(GATE_NOTE_REASONS.includes(n.reason) || CLAIM_NOTE_REASONS.includes(n.reason),
      `note fora de GATE_NOTE_REASONS ∪ CLAIM_NOTE_REASONS: ${n.reason}`);
    notesSeen.add(n.reason);
  }
  // G10, checked on EVERY result rather than in one dedicated test: a census or
  // an enumeration that is present only where someone remembered to look is
  // exactly the silence this milestone exists to remove.
  assert(result.census && typeof result.census.runs_examined === 'number',
    'resultado sem censo — decisão sem censo não existe');
  assertEqual(result.not_covered.length, 3, 'not_covered deve enumerar 3 fronteiras');
  return result;
}
// Skips inherited from S03's collector (e.g. `run-inactive`) travel verbatim.
function CLAIM_SKIP_REASONS_OK(reason) {
  return require('./forge-claim-overlap.js').CLAIM_SKIP_REASONS.includes(reason);
}

console.log('\n=== forge-claim-gate.test.js ===\n');

// ── G1: D1 own side, both branches, separate asserts ───────────────────────
console.log('G1: D1 lado próprio — refuse com counterpart, proceed sem counterpart');
{
  test('G1a: claim próprio vazio + 1 counterpart em escopo -> refuse/undeclared-writes', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim([]) },
      { id: 'M-other', write_claim: claim(['src/a.ts']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim([]), posture: 'defer', readyAlternatives: 3,
    }));
    assertEqual(r.decision, 'refuse');
    assertEqual(r.cause, 'undeclared-writes');
    assertEqual(r.undeclared_side, 'own');
    assertEqual(r.census.counterparts_in_scope, 1);
  });

  test('G1b: MESMO claim vazio, ZERO counterparts -> proceed/no-active-counterpart', () => {
    const ws = makeFixture([{ id: 'M-own', write_claim: claim([]) }]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim([]), posture: 'defer', readyAlternatives: 0,
    }));
    assertEqual(r.decision, 'proceed', 'sem counterpart, não declarar não é incidente (D1)');
    assertEqual(r.reason, 'no-active-counterpart');
    assertEqual(r.cause, null);
    assert(r.census.notes.some((n) => n.reason === 'own-claim-ineligible-no-counterpart'),
      'a inelegibilidade própria deve ficar VISÍVEL como note, mesmo sem punição');
  });

  test('G1c: claim próprio ausente (null) + counterpart -> refuse (mesma polaridade de D1)', () => {
    const ws = makeFixture([
      { id: 'M-own' },
      { id: 'M-other', write_claim: claim(['src/a.ts']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: null, posture: 'block', readyAlternatives: 1,
    }));
    assertEqual(r.decision, 'refuse');
    assertEqual(r.cause, 'undeclared-writes');
  });

  test('G1d: os dois lados sem declarar -> refuse com undeclared_side "both"', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim([]) },
      { id: 'M-other', write_claim: claim([]) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim([]), posture: 'defer', readyAlternatives: 2,
    }));
    assertEqual(r.decision, 'refuse');
    assertEqual(r.undeclared_side, 'both');
  });
}

// ── G2: D1 counterpart side — posture, never refuse ────────────────────────
console.log('\nG2: D1 lado alheio — postura, nunca refuse do plano próprio');
{
  function counterpartUndeclared(posture, ready) {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['src/a.ts']) },
      { id: 'M-other', write_claim: claim([]) },
    ]);
    return record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['src/a.ts']), posture, readyAlternatives: ready,
    }));
  }

  test('G2a: counterpart não declarou, postura defer + alternativa -> defer/undeclared-writes', () => {
    const r = counterpartUndeclared('defer', 2);
    assertEqual(r.decision, 'defer');
    assertEqual(r.cause, 'undeclared-writes');
    assertEqual(r.undeclared_side, 'counterpart',
      'o lado alheio é nomeado — o plano próprio declarou e não pode ser recusado por isso');
    assert(r.decision !== 'refuse', 'refuse é do lado próprio, nunca do alheio');
  });

  test('G2b: mesma colisão, postura block -> block (a postura decide, não o gate)', () => {
    const r = counterpartUndeclared('block', 5);
    assertEqual(r.decision, 'block');
    assertEqual(r.cause, 'undeclared-writes');
    assertEqual(r.floor, null, 'com alternativa ready, o piso D3 não é a razão do block');
  });
}

// ── G3: as duas causas, nunca uma no lugar da outra ────────────────────────
console.log('\nG3: overlap × undeclared-writes — nos dois sentidos');
{
  test('G3a: dois lados declarados que colidem -> cause overlap, com os paths', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
    }));
    assertEqual(r.cause, 'overlap');
    assert(r.cause !== 'undeclared-writes', 'overlap NUNCA reportado como undeclared-writes');
    assert(r.paths.length >= 1, 'a colisão medida deve nomear os caminhos');
    assertEqual(r.undeclared_side, null);
  });

  test('G3b: lado alheio sem declarar -> cause undeclared-writes, NUNCA overlap', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim([]) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
    }));
    assertEqual(r.cause, 'undeclared-writes');
    assert(r.cause !== 'overlap', 'undeclared-writes NUNCA reportado como overlap');
  });
}

// ── G4: proceed que CONFRONTOU ─────────────────────────────────────────────
console.log('\nG4: proceed/no-conflict — distinto de no-active-counterpart');
{
  test('G4: counterpart declarado sem sobreposição -> proceed/no-conflict com escopo >= 1', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/a.js']) },
      { id: 'M-other', write_claim: claim(['scripts/b.js']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/a.js']), posture: 'defer', readyAlternatives: 0,
    }));
    assertEqual(r.decision, 'proceed');
    assertEqual(r.reason, 'no-conflict');
    assert(r.census.counterparts_in_scope >= 1,
      'um proceed que não confrontou nada não pode se vestir de confronto limpo');
    assert(r.reason !== 'no-active-counterpart', 'as duas razões de proceed são distintas');
  });
}

// ── G5: D7 — item concedido sem path ───────────────────────────────────────
console.log('\nG5: D7 — derivação de itens concedidos');
{
  test('G5a: itens com path -> elegível, com o :line removido e sem duplicatas', () => {
    const d = deriveClaimFromConcededItems([
      { r: 'R1', path: 'scripts/a.js:12' },
      { r: 'R2', path: 'scripts/a.js:88' },
      { r: 'R3', path: 'scripts/b.js' },
    ]);
    assertEqual(d.eligible, true);
    assertEqual(JSON.stringify(d.paths), JSON.stringify(['scripts/a.js', 'scripts/b.js']));
    assertEqual(d.source, 'review-fix-paths');
  });

  test('G5b: >= 1 item sem path -> pathless-conceded-item carregando os R#s (fixture sintético)', () => {
    const d = deriveClaimFromConcededItems([
      { r: 'R1', path: 'scripts/a.js:12' },
      { r: 'R7' },
      { r: 'R9', path: '' },
    ]);
    assertEqual(d.eligible, false);
    assertEqual(d.cause, 'pathless-conceded-item');
    assertEqual(JSON.stringify(d.pathless), JSON.stringify(['R7', 'R9']));
    assert(d.detail.includes('R7'), 'o detalhe deve nomear os itens sem path');
  });

  test('G5c: derivação pathless + counterpart em escopo -> refuse/pathless-conceded-item', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/a.js']) },
      { id: 'M-other', write_claim: claim(['scripts/z.js']) },
    ]);
    const d = deriveClaimFromConcededItems([{ r: 'R7' }]);
    const own = claim(d.paths, undefined, { eligible: d.eligible, cause: d.cause });
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: own, posture: 'defer', readyAlternatives: 4,
    }));
    assertEqual(r.decision, 'refuse');
    assertEqual(r.cause, 'pathless-conceded-item');
    assertEqual(r.undeclared_side, null, 'pathless não é "não declarou" — a causa é própria');
  });
}

// ── G6: D3 floor, with an EXECUTED bite ────────────────────────────────────
console.log('\nG6: piso D3 — defer sem alternativa vira block, com mordida executada');
{
  function deferNoAlternative(cwd) {
    return evaluateGate({
      cwd, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'defer', readyAlternatives: 0,
    });
  }

  const ws = makeFixture([
    { id: 'M-own', write_claim: claim(['scripts/x.js']) },
    { id: 'M-other', write_claim: claim(['scripts/x.js']) },
  ]);

  test('G6a: defer + ready_alternatives 0 -> block com floor "defer-floor"', () => {
    const r = record(deferNoAlternative(ws));
    assertEqual(r.decision, 'block');
    assertEqual(r.floor, 'defer-floor');
    assert(r.decision !== 'proceed', 'o piso NUNCA degrada para prosseguir (D3)');
  });

  test('G6b: defer + 1 alternativa ready -> defer (o piso só morde sem alternativa)', () => {
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'defer', readyAlternatives: 1,
    }));
    assertEqual(r.decision, 'defer');
    assertEqual(r.floor, null);
  });

  test('G6c: MORDIDA — neutralizar o piso numa cópia descartável deixa o assert vermelho', () => {
    const src = fs.readFileSync(MODULE, 'utf8');
    const needle = "if (decision === 'defer' && readyAlternatives === 0) {";
    const occurrences = src.split(needle).length - 1;
    assertEqual(occurrences, 1, 'a mordida precisa casar EXATAMENTE o piso — 0 ou 2 casamentos a tornariam vazia');

    // Copy lives beside the original so its relative `require`s still resolve.
    const biteFile = path.join(__dirname, 'forge-claim-gate.__bite__.js');
    fs.writeFileSync(biteFile, src.replace(needle, 'if (false) {'), 'utf8');
    try {
      // eslint-disable-next-line global-require
      const bitten = require(biteFile);
      const r = bitten.evaluateGate({
        cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'defer', readyAlternatives: 0,
      });
      assertEqual(r.decision, 'defer', 'com o piso neutralizado a decisão deixa de ser block — a mordida morde');
      assertEqual(r.floor, null);
      // And the real module, on the SAME input, still blocks:
      assertEqual(deferNoAlternative(ws).decision, 'block', 'o módulo real permanece intacto após a mordida');
    } finally {
      delete require.cache[require.resolve(biteFile)];
      fs.rmSync(biteFile, { force: true });
    }
  });
}

// ── G7: scope fails CLOSED ─────────────────────────────────────────────────
console.log('\nG7: escopo fail-closed (W2 / contrato #5)');
{
  test('G7a: counterpart com code_dir desconhecido FICA em escopo, com a note anexada', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js'], null) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
    }));
    assertEqual(r.census.counterparts_in_scope, 1, 'unknown NUNCA sai do escopo — excluir seria "ausência = seguro"');
    assertEqual(r.decision, 'block');
    assert(r.census.notes.some((n) => n.reason === 'code-dir-unknown'), 'a incerteza viaja como note');
    assert(r.counterparts.some((c) => c.scope === 'unknown' && c.note === 'code-dir-unknown'),
      'a note também fica anexada ao counterpart, não só ao censo');
  });

  test('G7b: só um code_dir MEDIDO diferente sai de escopo, com skip nomeado', () => {
    const a = mktmp();
    const b = mktmp();
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js'], a) },
      { id: 'M-other', write_claim: claim(['scripts/x.js'], b) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js'], a), posture: 'block', readyAlternatives: 1,
    }));
    assertEqual(r.census.counterparts_in_scope, 0);
    assert(r.census.skipped.some((s) => s.id === 'M-other' && s.reason === 'different-code-dir'),
      'o par fora de escopo é NOMEADO, nunca descartado em silêncio');
    assertEqual(r.decision, 'proceed');
    assertEqual(r.reason, 'no-active-counterpart');
  });
}

// ── G8: the S06/D8 seam ────────────────────────────────────────────────────
console.log('\nG8: seam de postura (W3/D8) — os DOIS RunRecords chegam');
{
  test('G8a: resolvePosture valida a pref e nomeia o valor fora do conjunto', () => {
    assertEqual(resolvePosture({ pref: 'block' }).posture, 'block');
    assertEqual(resolvePosture({ pref: 'defer' }).posture, 'defer');
    const bad = resolvePosture({ pref: 'sim-por-favor' });
    assertEqual(bad.posture, 'defer');
    assertEqual(bad.note, 'posture-invalid');
    assertEqual(bad.override, null, 'o override é de S06 (D8) — aqui é null por decisão, não por esquecimento');
  });

  test('G8b: o RunRecord da run ALHEIA (com isolation_mode) chega ao seam', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']), isolation_mode: 'branch' },
      { id: 'M-other', write_claim: claim(['scripts/x.js']), isolation_mode: 'worktree' },
    ]);
    const real = gate.resolvePosture;
    const seen = [];
    gate.resolvePosture = (opts) => { seen.push(opts); return real(opts); };
    try {
      evaluateGate({
        cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
      });
    } finally {
      gate.resolvePosture = real;
    }
    assertEqual(seen.length, 1, 'o seam deve ser atravessado exatamente uma vez por decisão de postura');
    const call = seen[0];
    assert(call.ownRun && call.ownRun.id === 'M-own', 'o RunRecord próprio chega ao seam');
    assert(call.counterpartRun && call.counterpartRun.id === 'M-other', 'o RunRecord ALHEIO chega ao seam');
    assertEqual(call.counterpartRun.isolation_mode, 'worktree',
      'o isolation_mode do counterpart é o campo que S06 vai ler — precisa chegar inteiro');
  });

  test('G8c: postura inválida com colisão -> note posture-invalid no censo', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'talvez', readyAlternatives: 2,
    }));
    assert(r.census.notes.some((n) => n.reason === 'posture-invalid'), 'pref inválida é NOMEADA, nunca aceita calada');
    assertEqual(r.decision, 'defer');
  });
}

// ── G9/G10: closed sets, both directions; enumeration on every result ──────
console.log('\nG9/G10: conjuntos fechados nos dois sentidos + enumeração em todo resultado');
{
  test('G10a: UNCOVERED_BOUNDARIES tem 3 entradas, cada uma com razão não vazia', () => {
    assertEqual(UNCOVERED_BOUNDARIES.length, 3);
    const names = UNCOVERED_BOUNDARIES.map((b) => b.boundary).sort().join(',');
    assertEqual(names, 'complete-slice,forge-task,orchestrator-writes');
    for (const b of UNCOVERED_BOUNDARIES) {
      assert(typeof b.reason === 'string' && b.reason.length > 10, `fronteira ${b.boundary} sem razão`);
    }
  });

  test('G10b: um resultado PROCEED também carrega not_covered e censo', () => {
    const ws = makeFixture([{ id: 'M-own', write_claim: claim(['scripts/a.js']) }]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/a.js']), posture: 'defer', readyAlternatives: 0,
    }));
    assertEqual(r.decision, 'proceed');
    assertEqual(r.not_covered.length, 3, 'a enumeração não pode sumir justamente no caminho feliz');
    assertEqual(typeof r.census.counterparts_considered, 'number');
  });

  // Direction 2 lives at the END of this file (see "G9: direção 2"): the sets
  // are only fully exercised after the T02 blocks run, and asserting the
  // crossing here would report "declared and never emitted" for a value the
  // suite emits fifty lines later — a false red that teaches nothing.
}

// ── G11: source guard + the S03 suites, by spawn, unedited ─────────────────
console.log('\nG11: guard de fonte (nunca writesConflict) + suítes de S03 por spawn');
{
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }
  const realSource = fs.readFileSync(MODULE, 'utf8');
  function guardPasses(src) {
    return !stripComments(src).includes('writesConflict');
  }

  test('G11a: o fonte real, sem comentários, NÃO contém "writesConflict"', () => {
    assert(guardPasses(realSource), 'writesConflict vazou para forge-claim-gate.js — a polaridade errada');
  });
  test('G11b: controle positivo — cópia com a chamada injetada é REPROVADA pelo mesmo predicado', () => {
    assert(!guardPasses(`${realSource}\nconst x = writesConflict(a, b);\n`),
      'o guard não mordeu a chamada injetada — controle positivo falhou (guard cego)');
  });
  test('G11c: controle negativo — menção apenas em comentário NÃO reprova', () => {
    assert(guardPasses(`${realSource}\n// writesConflict citado só em prosa\n`),
      'o guard deu falso positivo numa menção que é só comentário');
  });

  test('G11d: forge-claim-polarity.test.js passa por SPAWN, sem edição', () => {
    const r = spawnSync(process.execPath, [POLARITY_TEST], { encoding: 'utf8' });
    assertEqual(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  });
  test('G11e: forge-claim-overlap.test.js passa por SPAWN, sem edição', () => {
    const r = spawnSync(process.execPath, [OVERLAP_TEST], { encoding: 'utf8' });
    assertEqual(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  });
}

// ── G12: CLI posture — enforcing, not advisory ─────────────────────────────
console.log('\nG12: CLI — exit 0 quando avaliou, 2 em usage, != 0 em erro interno');
{
  test('G12a: --evaluate com uma fonte e uma decisão refuse -> exit 0, decisão no JSON', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim([]) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = runCli(['--evaluate', '--paths', '', '--run', 'M-own', '--cwd', ws, '--json']);
    assertEqual(r.status, 0, `a decisão viaja no payload, não no exit code\n${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assertEqual(out.decision, 'refuse');
    assertEqual(out.not_covered.length, 3);
  });

  test('G12b: --evaluate com colisão real -> exit 0 e block impresso na forma legível', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = runCli(['--evaluate', '--paths', 'scripts/x.js', '--run', 'M-own', '--cwd', ws, '--posture', 'block']);
    assertEqual(r.status, 0);
    assert(r.stdout.includes('block'), `esperava block no stdout, veio:\n${r.stdout}`);
    assert(r.stdout.includes('fronteira não coberta'), 'a enumeração também é impressa na forma legível');
  });

  test('G12c: duas fontes de claim -> exit 2 (usage), nada avaliado', () => {
    const r = runCli(['--evaluate', '--paths', 'a.js', '--plan', 'x.md', '--run', 'M-own']);
    assertEqual(r.status, 2);
  });

  test('G12d: sem --run -> exit 2 (usage)', () => {
    const r = runCli(['--evaluate', '--paths', 'a.js']);
    assertEqual(r.status, 2);
  });

  test('G12e: erro interno (plano inexistente) -> exit != 0 — este gate falha FECHADO', () => {
    const ws = makeFixture([{ id: 'M-own', write_claim: claim(['a.js']) }]);
    const r = runCli(['--evaluate', '--plan', 'nao/existe/T99-PLAN.md', '--run', 'M-own', '--cwd', ws]);
    assert(r.status !== 0, 'exit 0 num erro interno faria um gate quebrado parecer aprovação');
    assert(r.stderr.includes('forge-claim-gate'), 'o erro é nomeado em stderr');
  });
}

// ── Derivation from a real plan file ───────────────────────────────────────
console.log('\nG13: deriveClaimFromPlan — reuso de declaredFor, legacy ≠ vazio honesto');
{
  function planFixture(body) {
    const tmp = mktmp();
    const rel = '.gsd/milestones/M-x/slices/S01/tasks/T01/T01-PLAN.md';
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
    return { cwd: tmp, rel };
  }

  test('G13a: plano com writes: e expected_output: -> união declarada, elegível', () => {
    const { cwd, rel } = planFixture([
      '---', 'id: T01', 'writes:', '  - "scripts/a.js"',
      'must_haves:', '  truths:', '    - "t"',
      '  artifacts:', '    - path: "scripts/a.js"', '      provides: "algo"', '      min_lines: 1',
      '  key_links: []',
      'expected_output:', '  - scripts/b.js', '---', '', '# T01', '',
    ].join('\n'));
    const d = deriveClaimFromPlan(cwd, rel);
    assertEqual(d.eligible, true);
    assertEqual(d.source, 'plan-writes');
    assertEqual(JSON.stringify(d.paths), JSON.stringify(['scripts/a.js', 'scripts/b.js']));
  });

  test('G13b: plano legacy (sem must_haves estruturado) -> detail legacy-plan-schema, NÃO "vazio honesto"', () => {
    const { cwd, rel } = planFixture('---\nid: T01\n---\n\n# T01 legacy\n');
    const d = deriveClaimFromPlan(cwd, rel);
    assertEqual(d.eligible, false);
    assertEqual(d.cause, 'undeclared-writes');
    assert(d.detail.startsWith('legacy-plan-schema'), `detail deve nomear o schema legacy, veio ${d.detail}`);
  });

  test('G13c: plano estruturado sem nenhum path -> detail declared-empty (fato diferente de legacy)', () => {
    const { cwd, rel } = planFixture([
      '---', 'id: T01',
      'must_haves:', '  truths:', '    - "t"', '  artifacts: []', '  key_links: []',
      'expected_output: []', '---', '', '# T01', '',
    ].join('\n'));
    const d = deriveClaimFromPlan(cwd, rel);
    assertEqual(d.eligible, false);
    assertEqual(d.detail, 'declared-empty');
  });

  test('G13d: plano ilegível LANÇA — nunca vira claim elegível vazio', () => {
    let threw = false;
    try { deriveClaimFromPlan(mktmp(), 'nao/existe.md'); } catch (_) { threw = true; }
    assert(threw, 'um plano ilegível precisa falhar fechado, não degradar para "não declara nada"');
  });
}

// ══════════════════════════════════════════════════════════════════════════
// S04/T02 — the knob made live, the waiting machine, the event
// ══════════════════════════════════════════════════════════════════════════
//
//   G14 B1 IN BOTH SENSES: the SAME pair of colliding runs decides `defer` with
//       the pref at defer and `block` with the pref at block — two tests, each
//       reading a REAL prefs file, never the `--posture` parameter. Plus an
//       EXECUTED bite: a throwaway copy with the pref read neutralised leaves
//       the `block` assert red.
//   G15 record BEFORE evaluate — after a call that decided `block`, `readClaim`
//       of the own run returns the recorded claim (the fence is visible).
//   G16 B2 — no `--code-dir` records `code_dir: null` (never derived) AND the
//       consequence: the counterpart stays in scope, fail closed.
//   G17 the ceiling — `--wait` polls to `parallelism.block_wait_ms` and escalates
//       `wait-ceiling` with the decision still `block`; a conflict that CLEARS
//       during the poll produces `proceed`.
//   G18 the cap — consecutive defers up to `parallelism.defer_cap` escalate
//       `defer-cap`; a `proceed` resets; an unreadable ledger is a named note
//       with the counter treated as 0, never a crash.
//   G19 the event, written BY CODE, read back from the fixture's events.jsonl;
//       a write failure becomes `event_written: false` + `event_error`.
//   G20 ESCALATIONS crossed in both senses; escalation is a FIELD, never a
//       fifth decision.

const {
  resolvePostureFromPrefs, readParallelism, recordAndEvaluate, emitGateEvent,
  PARALLELISM_FALLBACKS, ESCALATIONS,
} = gate;
const { readClaim } = require('./forge-write-claim.js');
const runsApi = require('./forge-runs.js');

const escalationsSeen = new Set();
function recordEsc(result) {
  if (result.escalation !== null && result.escalation !== undefined) {
    assert(ESCALATIONS.includes(result.escalation), `escalação fora de ESCALATIONS: ${result.escalation}`);
    escalationsSeen.add(result.escalation);
  }
  // Escalation is a FIELD, never a decision value — checked on every result that
  // passes through, so a future "decision: 'wait-ceiling'" cannot slip in.
  assert(!ESCALATIONS.includes(result.decision),
    `escalação virou valor de decisão: ${result.decision} — a decisão permanece block/defer`);
  return record(result);
}

/** An isolated GLOBAL prefs layer: the operator's real home is never read. */
const EMPTY_GLOBAL = mktmp();
function prefsOpts() {
  return { globalDir: EMPTY_GLOBAL };
}

/** Writes the fixture's LOCAL prefs layer (`<cwd>/.gsd/forge-prefs.jsonc`). */
function withPrefs(ws, parallelism) {
  fs.writeFileSync(
    path.join(ws, '.gsd', 'forge-prefs.jsonc'),
    `${JSON.stringify({ parallelism }, null, 2)}\n`,
    'utf8',
  );
  return ws;
}

/** The SAME collision, every time: two runs claiming the same file. */
function collidingFixture(parallelism, ownPaths) {
  const ws = makeFixture([
    { id: 'M-own', write_claim: claim([]) },
    { id: 'M-other', write_claim: claim(['scripts/x.js']) },
  ]);
  if (parallelism) withPrefs(ws, parallelism);
  return { ws, paths: ownPaths || ['scripts/x.js'] };
}

// ── G14: B1 — the knob decides, in both senses, with a real prefs file ──────
console.log('\nG14: B1 — a MESMA colisão sob defer e sob block, lendo a pref de verdade');
{
  function decideWithPref(value) {
    const { ws, paths } = collidingFixture({ cross_run_overlap: value });
    return {
      ws,
      result: recordEsc(recordAndEvaluate({
        cwd: ws,
        runId: 'M-own',
        unit: 'execute-task/T02',
        paths,
        // NO `posture` — the pref is the deciding input, which is the whole point.
        readyAlternatives: 2,
        prefsOpts: prefsOpts(),
        emitEvent: false,
      })),
    };
  }

  test('G14a: pref cross_run_overlap=defer -> decisão defer (posture_source prefs)', () => {
    const { result } = decideWithPref('defer');
    assertEqual(result.decision, 'defer');
    assertEqual(result.posture, 'defer');
    assertEqual(result.posture_source, 'prefs', 'a decisão veio da pref, não de um parâmetro');
    assertEqual(result.cause, 'overlap');
  });

  test('G14b: MESMA colisão com pref cross_run_overlap=block -> decisão block', () => {
    const { result } = decideWithPref('block');
    assertEqual(result.decision, 'block', 'mudar a pref TEM de mudar a decisão — senão o knob é inerte (B1)');
    assertEqual(result.posture, 'block');
    assertEqual(result.posture_source, 'prefs');
    assertEqual(result.floor, null, 'com alternativa ready o block vem da postura, não do piso D3');
  });

  test('G14c: MORDIDA — neutralizar a leitura da pref deixa o caso block VERMELHO', () => {
    const src = fs.readFileSync(MODULE, 'utf8');
    const needle = '  const raw = readParallelism(cwd, opts).cross_run_overlap;';
    assertEqual(src.split(needle).length - 1, 1,
      'a mordida precisa casar EXATAMENTE a leitura da pref — 0 ou 2 casamentos a tornariam vazia');

    const biteFile = path.join(__dirname, 'forge-claim-gate.__bite-pref__.js');
    fs.writeFileSync(biteFile, src.replace(needle, "  const raw = 'defer';"), 'utf8');
    try {
      // eslint-disable-next-line global-require
      const bitten = require(biteFile);
      const { ws, paths } = collidingFixture({ cross_run_overlap: 'block' });
      const bittenResult = bitten.recordAndEvaluate({
        cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths,
        readyAlternatives: 2, prefsOpts: prefsOpts(), emitEvent: false,
      });
      assertEqual(bittenResult.decision, 'defer',
        'com a leitura da pref neutralizada, block deixa de acontecer — G14b ficaria vermelho: a mordida morde');

      // And the real module, on an equivalent fixture, still blocks.
      const live = collidingFixture({ cross_run_overlap: 'block' });
      assertEqual(recordAndEvaluate({
        cwd: live.ws, runId: 'M-own', unit: 'execute-task/T02', paths: live.paths,
        readyAlternatives: 2, prefsOpts: prefsOpts(), emitEvent: false,
      }).decision, 'block', 'o módulo real permanece intacto após a mordida');
    } finally {
      delete require.cache[require.resolve(biteFile)];
      fs.rmSync(biteFile, { force: true });
    }
  });

  test('G14d: sem arquivo de prefs -> fallback hardcoded defer, com a origem NOMEADA', () => {
    const { ws, paths } = collidingFixture(null);
    const r = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths,
      readyAlternatives: 2, prefsOpts: prefsOpts(), emitEvent: false,
    }));
    assertEqual(r.posture, PARALLELISM_FALLBACKS.cross_run_overlap);
    assertEqual(r.posture, 'defer', 'o fallback é defer — e é idêntico ao default do schema (witness no schema test)');
    assertEqual(r.posture_source, 'fallback', 'ausência de pref é um fato distinto de uma pref escrita');
  });

  test('G14e: pref fora de {defer, block} -> defer com note invalid-posture-pref', () => {
    const { ws, paths } = collidingFixture({ cross_run_overlap: 'talvez-sim' });
    const r = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths,
      readyAlternatives: 2, prefsOpts: prefsOpts(), emitEvent: false,
    }));
    assertEqual(r.posture, 'defer');
    assertEqual(r.posture_source, 'invalid-pref');
    assert(r.census.notes.some((n) => n.reason === 'invalid-posture-pref'),
      'uma pref inválida é NOMEADA, nunca aceita calada');
  });

  test('G14f: --posture explícito continua sendo override da pref (T01 intocado)', () => {
    const { ws, paths } = collidingFixture({ cross_run_overlap: 'defer' });
    const r = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths, posture: 'block',
      readyAlternatives: 2, prefsOpts: prefsOpts(), emitEvent: false,
    }));
    assertEqual(r.decision, 'block');
    assertEqual(r.posture_source, 'explicit');
  });

  test('G14g: timing inválido na pref -> fallback + note invalid-timing-pref', () => {
    const ws = withPrefs(makeFixture([{ id: 'M-own', write_claim: claim([]) }]), {
      cross_run_overlap: 'defer', block_wait_ms: -5, block_poll_ms: 'já', defer_cap: 0,
    });
    const p = readParallelism(ws, prefsOpts());
    assertEqual(p.block_wait_ms, PARALLELISM_FALLBACKS.block_wait_ms);
    assertEqual(p.block_poll_ms, PARALLELISM_FALLBACKS.block_poll_ms);
    assertEqual(p.defer_cap, PARALLELISM_FALLBACKS.defer_cap);
    assertEqual(p.notes.length, 3, 'cada timing inválido é nomeado individualmente');
    assert(p.notes.every((n) => n.reason === 'invalid-timing-pref'));

    // And the note travels to the RESULT — a note nobody carries is silence.
    const r = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths: ['scripts/x.js'],
      readyAlternatives: 1, prefsOpts: prefsOpts(), emitEvent: false,
    }));
    assert(r.census.notes.some((n) => n.reason === 'invalid-timing-pref'),
      'a note do timing inválido precisa chegar ao censo do resultado');
  });

  test('G14h: resolvePostureFromPrefs isolado — pref vale, ausência cai no fallback', () => {
    const withBlock = withPrefs(makeFixture([{ id: 'M-own' }]), { cross_run_overlap: 'block' });
    assertEqual(resolvePostureFromPrefs(withBlock, prefsOpts()).posture, 'block');
    const bare = makeFixture([{ id: 'M-own' }]);
    assertEqual(resolvePostureFromPrefs(bare, prefsOpts()).source, 'fallback');
  });
}

// ── G15: record BEFORE evaluate — an invisible fence does not fence ─────────
console.log('\nG15: gravar ANTES de avaliar — a cerca fica visível mesmo bloqueado');
{
  test('G15a: após uma decisão block, readClaim da PRÓPRIA run devolve o claim gravado', () => {
    const { ws, paths } = collidingFixture({ cross_run_overlap: 'block' });
    const r = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', source: 'plan-writes',
      codeDir: '/code/dir', paths, readyAlternatives: 2, prefsOpts: prefsOpts(), emitEvent: false,
    }));
    assertEqual(r.decision, 'block');

    const persisted = readClaim(runsApi.get(ws, 'M-own'));
    assert(persisted !== null, 'a cerca precisa estar em disco — bloqueado NÃO é motivo para não gravar');
    assertEqual(JSON.stringify(persisted.paths), JSON.stringify(paths));
    assertEqual(persisted.unit, 'execute-task/T02');
    assertEqual(persisted.source, 'plan-writes');
    assertEqual(JSON.stringify(r.claim_persisted), JSON.stringify(persisted),
      'o claim relido pelo próprio gate é o mesmo que ficou em disco');
  });

  test('G15b: duas runs simétricas se VEEM mutuamente (sem tie-break, sem ordenação)', () => {
    const ws = withPrefs(makeFixture([
      { id: 'M-a', write_claim: claim([]) },
      { id: 'M-b', write_claim: claim([]) },
    ]), { cross_run_overlap: 'block' });

    const a = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-a', unit: 'execute-task/T01', paths: ['scripts/x.js'],
      readyAlternatives: 2, prefsOpts: prefsOpts(), emitEvent: false,
    }));
    // A recorded first and saw B undeclared; B now records and sees A's fence.
    const b = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-b', unit: 'execute-task/T01', paths: ['scripts/x.js'],
      readyAlternatives: 2, prefsOpts: prefsOpts(), emitEvent: false,
    }));
    assertEqual(b.cause, 'overlap', 'a segunda run VÊ a cerca da primeira — foi por isso que gravar veio antes');
    assertEqual(b.decision, 'block');
    assert(a.decision !== 'proceed', 'nenhuma das duas prossegue: o empate escala, nunca é desempatado aqui');
  });
}

// ── G16: B2 — code_dir is a GIVEN fact, and the consequence ────────────────
console.log('\nG16: B2 — sem --code-dir grava null, e a avaliação segue fail-closed');
{
  test('G16a: invocação sem codeDir grava code_dir null (nunca derivado de root/branch/isolation)', () => {
    const ws = makeFixture([{ id: 'M-own', write_claim: claim([]), isolation_mode: 'worktree' }]);
    recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths: ['scripts/x.js'],
      posture: 'block', readyAlternatives: 1, prefsOpts: prefsOpts(), emitEvent: false,
    });
    const persisted = readClaim(runsApi.get(ws, 'M-own'));
    assertEqual(persisted.code_dir, null, 'ausência de fato dado é null — nunca um palpite');
  });

  test('G16b: consequência — counterpart com code_dir conhecido fica EM ESCOPO (unknown fail-closed)', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim([]) },
      { id: 'M-other', write_claim: claim(['scripts/x.js'], '/outro/code/dir') },
    ]);
    const r = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths: ['scripts/x.js'],
      posture: 'block', readyAlternatives: 1, prefsOpts: prefsOpts(), emitEvent: false,
    }));
    assertEqual(r.census.counterparts_in_scope, 1,
      'code_dir desconhecido do lado próprio NÃO tira o par do escopo — ausência de informação nunca é "seguro"');
    assertEqual(r.decision, 'block');
    assert(r.census.notes.some((n) => CLAIM_NOTE_REASONS.includes(n.reason)),
      'a incerteza de identidade viaja como note de S03');
  });
}

// ── G17: the ceiling ───────────────────────────────────────────────────────
console.log('\nG17: teto de espera — escala, nunca prossegue por expiração');
{
  // `--wait` É um ato, e sob `advisory` o módulo NÃO polla (esperar é agir). A
  // máquina de espera só existe sob `enforcing`, então a fixture desta seção
  // DECLARA a postura em vez de herdar o default advisory — sem isso os asserts
  // abaixo mediriam a supressão, não o teto.
  const TINY = {
    cross_run_overlap: 'block', block_wait_ms: 60, block_poll_ms: 10, claim_gate: 'enforcing',
  };

  test('G17a: --wait com teto curto e conflito persistente -> escalation wait-ceiling, decisão block', () => {
    const { ws, paths } = collidingFixture(TINY);
    const r = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths,
      readyAlternatives: 2, wait: true, prefsOpts: prefsOpts(), emitEvent: false,
    }));
    assertEqual(r.enforcement, 'enforcing',
      'o teto só EXISTE sob enforcing — se a postura caísse para advisory este teste mediria a supressão');
    assertEqual(r.decision, 'block', 'expirar o teto NUNCA vira proceed');
    assertEqual(r.escalation, 'wait-ceiling');
    assert(r.wait.polls >= 1, `esperava >= 1 re-avaliação por poll, veio ${r.wait.polls}`);
    assertEqual(r.wait.suppressed_by, undefined,
      'sob enforcing a espera ACONTECEU — `suppressed_by` é o carimbo do ramo advisory e não pode aparecer aqui');
    assertEqual(r.wait.ceiling_ms, 60, 'o teto vem da pref, não de constante mágica (W6)');
  });

  test('G17b: conflito que LIMPA durante o poll -> proceed (com o censo da última avaliação)', () => {
    const { ws, paths } = collidingFixture(TINY);
    const r = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths,
      readyAlternatives: 2, wait: true, prefsOpts: prefsOpts(), emitEvent: false,
      // The counterpart releases its claim between polls.
      onPoll: () => { runsApi.update(ws, 'M-other', { write_claim: claim(['scripts/outro.js']) }); },
    }));
    assertEqual(r.enforcement, 'enforcing', 'o poll que limpa o conflito só corre sob enforcing');
    assertEqual(r.decision, 'proceed');
    assertEqual(r.reason, 'no-conflict', 'o proceed confrontou de verdade na última re-avaliação');
    assert(r.wait.polls >= 1, 'o proceed veio de uma RE-avaliação, não da primeira passada');
    assertEqual(r.escalation, null);
  });

  test('G17c: sem --wait não há espera nenhuma (o poll é opt-in do consumidor)', () => {
    const { ws, paths } = collidingFixture(TINY);
    const r = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths,
      readyAlternatives: 2, prefsOpts: prefsOpts(), emitEvent: false,
    }));
    assertEqual(r.decision, 'block');
    assertEqual(r.wait, null);
    assertEqual(r.escalation, null, 'sem espera não há teto a atingir — escalar aqui seria inventar urgência');
  });
}

// ── G18: the defer cap ─────────────────────────────────────────────────────
console.log('\nG18: cap de deferimentos — escala ao operador, reseta em proceed, nunca crasha');
{
  function deferOnce(ws, paths) {
    return recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths: paths || ['scripts/x.js'],
      readyAlternatives: 2, prefsOpts: prefsOpts(), emitEvent: false,
    }));
  }

  test('G18a: defers consecutivos até defer_cap -> escalation defer-cap com decisão block', () => {
    const { ws } = collidingFixture({ cross_run_overlap: 'defer', defer_cap: 2 });
    assertEqual(deferOnce(ws).decision, 'defer');
    assertEqual(deferOnce(ws).decision, 'defer');
    const third = deferOnce(ws);
    assertEqual(third.decision, 'block', 'esperar deixou de ser produtivo — escala, não degrada para prosseguir (D3)');
    assertEqual(third.escalation, 'defer-cap');
    assertEqual(third.defer_cap, 2, 'o cap vem da pref (W6)');
  });

  test('G18b: um proceed RESETA o contador da unidade', () => {
    const { ws } = collidingFixture({ cross_run_overlap: 'defer', defer_cap: 2 });
    deferOnce(ws);
    deferOnce(ws);
    // Same unit, now claiming something nobody else touches -> proceed.
    const clean = deferOnce(ws, ['scripts/só-meu.js']);
    assertEqual(clean.decision, 'proceed');
    const ledger = JSON.parse(fs.readFileSync(path.join(ws, '.gsd', 'forge', 'claim-gate-defers.json'), 'utf8'));
    assert(!Object.prototype.hasOwnProperty.call(ledger, 'M-own|execute-task/T02'),
      'o proceed apaga a entrada — o cap mede defers CONSECUTIVOS, não defers de sempre');
    // And the next defer starts over instead of arriving already capped.
    assertEqual(deferOnce(ws).decision, 'defer');
  });

  test('G18c: ledger ilegível -> note defer-ledger-unreadable, contador 0, NUNCA crash', () => {
    const { ws } = collidingFixture({ cross_run_overlap: 'defer', defer_cap: 1 });
    const file = path.join(ws, '.gsd', 'forge', 'claim-gate-defers.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{isso não é json', 'utf8');
    const r = deferOnce(ws);
    assertEqual(r.decision, 'defer', 'um ledger quebrado não pode travar tudo — a rede não vira o obstáculo');
    assert(r.census.notes.some((n) => n.reason === 'defer-ledger-unreadable'),
      'ledger ilegível é NOMEADO, nunca um 0 silencioso');
  });

  test('G18d: ledger impossível de gravar -> note defer-ledger-unwritable, decisão intacta', () => {
    const { ws } = collidingFixture({ cross_run_overlap: 'defer', defer_cap: 3 });
    // A DIRECTORY where the ledger file belongs: writeFileSync fails, and the
    // decision must survive it (precedent: the SCHEMA-VERSION-as-directory dogfood).
    fs.mkdirSync(path.join(ws, '.gsd', 'forge', 'claim-gate-defers.json'), { recursive: true });
    const r = deferOnce(ws);
    assertEqual(r.decision, 'defer');
    assert(r.census.notes.some((n) => n.reason === 'defer-ledger-unwritable'),
      'falhar em gravar a rede é dito em voz alta, nunca engolido');
  });
}

// ── G19: the event, written BY CODE ────────────────────────────────────────
console.log('\nG19: evento claim-gate escrito por CÓDIGO em .gsd/forge/events.jsonl');
{
  function lastEvent(ws) {
    const lines = fs.readFileSync(path.join(ws, '.gsd', 'forge', 'events.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim() !== '');
    return JSON.parse(lines[lines.length - 1]);
  }

  test('G19a: --claim-and-check emite UMA linha com os campos do contrato', () => {
    const { ws, paths } = collidingFixture({ cross_run_overlap: 'block' });
    const r = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', codeDir: '/code/dir', paths,
      readyAlternatives: 2, prefsOpts: prefsOpts(),
    }));
    assertEqual(r.event_written, true);

    const ev = lastEvent(ws);
    assertEqual(ev.event, 'claim-gate');
    assert(typeof ev.ts === 'string' && ev.ts.length >= 20, 'o evento carrega timestamp ISO');
    assertEqual(ev.run, 'M-own');
    assertEqual(ev.unit, 'execute-task/T02');
    assertEqual(ev.decision, 'block');
    assertEqual(ev.cause, 'overlap');
    assertEqual(ev.posture, 'block');
    assertEqual(ev.posture_source, 'prefs');
    assertEqual(ev.escalation, null);
    assertEqual(ev.floor, null);
    assertEqual(ev.undeclared_side, null);
    assert(Array.isArray(ev.counterparts) && ev.counterparts.length === 1, 'os counterparts confrontados viajam no evento');
    assertEqual(typeof ev.census.runs_examined, 'number');
    assertEqual(ev.not_covered.length, 3, 'as fronteiras não cobertas também são enumeradas NO EVENTO');
  });

  test('G19b: a escalação também viaja no evento', () => {
    // `claim_gate: 'enforcing'` porque a escalação `wait-ceiling` é a MEDIDA de
    // uma espera que não limpou: sob advisory não há espera, logo não há o que
    // medir e o campo viaja `null` legitimamente (guardado em G24e/f).
    const { ws, paths } = collidingFixture({
      cross_run_overlap: 'block', block_wait_ms: 40, block_poll_ms: 10, claim_gate: 'enforcing',
    });
    recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths,
      readyAlternatives: 2, wait: true, prefsOpts: prefsOpts(),
    }));
    assertEqual(lastEvent(ws).escalation, 'wait-ceiling');
  });

  test('G19c: falha de escrita -> event_written false + event_error, decisão intacta', () => {
    const { ws, paths } = collidingFixture({ cross_run_overlap: 'block' });
    fs.mkdirSync(path.join(ws, '.gsd', 'forge', 'events.jsonl'), { recursive: true });
    const r = recordEsc(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths,
      readyAlternatives: 2, prefsOpts: prefsOpts(),
    }));
    assertEqual(r.decision, 'block', 'o gate decide mesmo sem conseguir logar');
    assertEqual(r.event_written, false, '...e DIZ que não logou — nunca finge que logou');
    assert(typeof r.event_error === 'string' && r.event_error.length > 0, 'o erro de escrita é nomeado');
  });

  test('G19d: --evaluate puro NÃO emite evento e NÃO grava claim (T01 intocado)', () => {
    const ws = makeFixture([
      { id: 'M-own' },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = runCli(['--evaluate', '--paths', 'scripts/x.js', '--run', 'M-own', '--cwd', ws, '--posture', 'block', '--json']);
    assertEqual(r.status, 0, r.stderr);
    assertEqual(JSON.parse(r.stdout).decision, 'block');
    assert(!fs.existsSync(path.join(ws, '.gsd', 'forge', 'events.jsonl')), '--evaluate não emite evento');
    assertEqual(readClaim(runsApi.get(ws, 'M-own')), null, '--evaluate não grava claim');
  });

  test('G19e: CLI --claim-and-check grava, avalia, emite — exit 0 com a decisão no payload', () => {
    const ws = makeFixture([
      { id: 'M-own' },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = runCli(['--claim-and-check', '--paths', 'scripts/x.js', '--run', 'M-own',
      '--unit', 'execute-task/T02', '--cwd', ws, '--posture', 'block', '--json']);
    assertEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assertEqual(out.decision, 'block');
    assertEqual(out.event_written, true);
    assertEqual(readClaim(runsApi.get(ws, 'M-own')).paths[0], 'scripts/x.js');
    assertEqual(lastEvent(ws).unit, 'execute-task/T02');
  });

  test('G19f: emitGateEvent é chamável isoladamente e nunca lança', () => {
    const ws = mktmp();
    const out = emitGateEvent(ws, {
      run: 'M-x', unit: null, decision: 'proceed', cause: null, undeclared_side: null,
      census: { runs_examined: 0, counterparts_considered: 0, counterparts_in_scope: 0, skipped: [], notes: [] },
      not_covered: UNCOVERED_BOUNDARIES, counterparts: [],
    });
    assertEqual(out.event_written, true);
    assertEqual(lastEvent(ws).decision, 'proceed');
  });
}

// ── G20: ESCALATIONS as a closed set, both senses ──────────────────────────
console.log('\nG20: ESCALATIONS — conjunto fechado nos dois sentidos');
{
  test('G20a: ESCALATIONS é exatamente [wait-ceiling, defer-cap]', () => {
    assertEqual(ESCALATIONS.slice().sort().join(','), 'defer-cap,wait-ceiling');
  });
  test('G20b: toda escalação declarada foi emitida por >= 1 teste', () => {
    for (const e of ESCALATIONS) assert(escalationsSeen.has(e), `escalação declarada e nunca emitida: ${e}`);
  });
  test('G20c: nenhuma escalação é um valor de GATE_DECISIONS (é campo, não decisão)', () => {
    for (const e of ESCALATIONS) {
      assert(!GATE_DECISIONS.includes(e), `${e} virou decisão — a decisão permanece block/defer`);
    }
  });
}

// ── G21: o wiring do batch (S04 review — R1, R2, R5, R6) ──────────────────
//
// O núcleo estava sólido e o wiring não conectava: a união do batch nascia
// vazia (R1), o laço por task destruía a cerca (R2), a regravação dos
// sobreviventes era um no-op (R5) e `--wait` nunca era passado (R6). Estes
// asserts rodam o EXTRATOR LITERAL publicado no fence do forge-auto contra a
// CLI real — não uma reimplementação — para que reverter a correção deixe o
// teste vermelho.
console.log('\nG21: wiring do batch — união não-vazia, cerca preservada, sobreviventes regravados');
{
  const SKILL = path.join(__dirname, '..', 'skills', 'forge-auto', 'SKILL.md');
  const skillText = fs.readFileSync(SKILL, 'utf8');
  const runsApi21 = require('./forge-runs.js');
  const { readClaim: readClaim21 } = require('./forge-write-claim.js');

  function fenceLiteral(name) {
    const m = skillText.match(new RegExp(`^${name}='([^']*)'`, 'm'));
    assert(m, `one-liner ${name} ausente do fence do forge-auto`);
    return m[1];
  }
  const EXTRACT = fenceLiteral('EXTRACT_CLAIM_PATHS');
  const UNION_ADD = fenceLiteral('UNION_ADD');

  function planIn(ws, taskId, file) {
    const rel = `.gsd/milestones/M-x/slices/S01/tasks/${taskId}/${taskId}-PLAN.md`;
    const abs = path.join(ws, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, [
      '---', `id: ${taskId}`, 'writes:', `  - "${file}"`,
      'must_haves:', '  truths:', '    - "t"',
      '  artifacts:', `    - path: "${file}"`, '      provides: "algo"', '      min_lines: 1',
      '  key_links: []',
      'expected_output: []', '---', '', `# ${taskId}`, '',
    ].join('\n'), 'utf8');
    return rel;
  }

  // O extrator do fence, aplicado ao stdout REAL da CLI. Exit != 0 = fail closed.
  function extractPaths(stdout) {
    const r = spawnSync(process.execPath, ['-e', EXTRACT], { input: stdout, encoding: 'utf8' });
    return { status: r.status, paths: r.status === 0 ? JSON.parse(r.stdout) : null, stderr: r.stderr };
  }
  function unionOf(ws, rels) {
    let acc = '[]';
    for (const rel of rels) {
      const cli = runCli(['--evaluate', '--plan', rel, '--run', 'M-own', '--cwd', ws, '--json']);
      assertEqual(cli.status, 0, `--evaluate deveria avaliar (${cli.stderr})`);
      const e = extractPaths(cli.stdout);
      assertEqual(e.status, 0, `extração do claim falhou — R1 de volta: ${e.stderr}`);
      const u = spawnSync(process.execPath, ['-e', UNION_ADD, acc, JSON.stringify(e.paths)], { encoding: 'utf8' });
      assertEqual(u.status, 0, 'união falhou');
      acc = u.stdout;
    }
    return JSON.parse(acc);
  }

  test('G21a: R1 — a união de um batch multi-task real é NÃO-VAZIA (extrator do fence, CLI real)', () => {
    const ws = makeFixture([{ id: 'M-own' }]);
    const rels = [planIn(ws, 'T01', 'scripts/a.js'), planIn(ws, 'T02', 'scripts/b.js')];
    const union = unionOf(ws, rels);
    assertEqual(JSON.stringify(union), JSON.stringify(['scripts/a.js', 'scripts/b.js']),
      'união do batch — vazia significa cerca inexistente em runtime');
  });

  test('G21b: R1 — o extrator FALHA FECHADO quando o resultado não traz claim (nunca vira [])', () => {
    const e = extractPaths(JSON.stringify({ decision: 'proceed' }));
    assert(e.status !== 0, 'resultado sem claim deveria sair != 0, nunca degradar para []');
    assert(/claim/.test(e.stderr), 'a falha deve nomear a derivação do claim');
  });

  test('G21c: R2 — --check-only avalia, EMITE evento e PRESERVA o claim persistido (união intacta)', () => {
    const ws = makeFixture([{ id: 'M-own' }]);
    const rels = [planIn(ws, 'T01', 'scripts/a.js'), planIn(ws, 'T02', 'scripts/b.js')];
    const union = unionOf(ws, rels);
    const rec = runCli(['--claim-and-check', '--paths', union.join(','), '--source', 'manual',
      '--run', 'M-own', '--unit', 'BATCH:T01,T02', '--cwd', ws, '--json']);
    assertEqual(rec.status, 0, 'gravação da união falhou');

    const before = fs.readFileSync(path.join(ws, '.gsd', 'forge', 'events.jsonl'), 'utf8').trim().split('\n').length;
    for (const [i, rel] of rels.entries()) {
      const one = runCli(['--check-only', '--wait', '--run', 'M-own', '--unit', `execute-task/T0${i + 1}`,
        '--source', 'plan-writes', '--plan', rel, '--posture', 'defer',
        '--ready-alternatives', '1', '--cwd', ws, '--json']);
      assertEqual(one.status, 0, `--check-only falhou: ${one.stderr}`);
      const out = record(JSON.parse(one.stdout));
      assertEqual(out.claim_recorded, false, '--check-only não pode gravar');
      assertEqual(out.event_written, true, '--check-only deve emitir o evento (spec § Step 5)');
      // A cerca confrontada é a união, não a task da vez.
      assertEqual(JSON.stringify(readClaim21(runsApi21.get(ws, 'M-own')).paths), JSON.stringify(union),
        'o claim persistido foi sobrescrito pelo laço — a cerca do batch morreu (R2)');
    }
    const after = fs.readFileSync(path.join(ws, '.gsd', 'forge', 'events.jsonl'), 'utf8').trim().split('\n').length;
    assertEqual(after - before, 2, '--check-only deve deixar um evento claim-gate por task');
  });

  test('G21d: R5 — após um batch MISTO, o claim persistido descreve os SOBREVIVENTES', () => {
    // T03 colide com uma counterpart em escopo; T01/T02 passam.
    const ws = makeFixture([
      { id: 'M-own' },
      { id: 'M-other', write_claim: claim(['scripts/c.js'], null) },
    ]);
    const rels = [planIn(ws, 'T01', 'scripts/a.js'), planIn(ws, 'T02', 'scripts/b.js'), planIn(ws, 'T03', 'scripts/c.js')];
    const union = unionOf(ws, rels);
    assertEqual(union.length, 3, 'pré-condição: união do batch inteiro');
    runCli(['--claim-and-check', '--paths', union.join(','), '--source', 'manual',
      '--run', 'M-own', '--unit', 'BATCH:T01,T02,T03', '--cwd', ws, '--json']);

    const survivors = [];
    for (const [i, rel] of rels.entries()) {
      const out = record(JSON.parse(runCli(['--check-only', '--run', 'M-own',
        '--unit', `execute-task/T0${i + 1}`, '--source', 'plan-writes', '--plan', rel,
        '--posture', 'defer', '--ready-alternatives', '2', '--cwd', ws, '--json']).stdout));
      if (out.decision === 'proceed') survivors.push(rel);
    }
    assertEqual(survivors.length, 2, 'T03 deveria ser descartada pelo overlap medido');

    const survivorUnion = unionOf(ws, survivors);
    const re = runCli(['--claim-and-check', '--paths', survivorUnion.join(','), '--source', 'manual',
      '--run', 'M-own', '--unit', 'BATCH:T01,T02', '--cwd', ws, '--json']);
    assertEqual(re.status, 0, 'regravação dos sobreviventes falhou');
    assertEqual(JSON.stringify(readClaim21(runsApi21.get(ws, 'M-own')).paths),
      JSON.stringify(['scripts/a.js', 'scripts/b.js']),
      'o claim persistido deve ser a união dos sobreviventes, não a última task avaliada');
  });

  test('G21e: R5/R6 — o fence do forge-auto passa --wait, regrava sobreviventes e nomeia zero-sobreviventes', () => {
    const fence = skillText.slice(skillText.indexOf('# 1. Union of the whole ready batch'));
    assert(/--check-only --wait/.test(fence), 'R6: o laço por task do modo auto deve passar --wait incondicionalmente');
    assert(!/--claim-and-check[^\n]*--plan /.test(fence), 'R2: o laço não pode gravar o claim por task');
    assert(!/:\s+#\s+\(same shape as step 1/.test(fence), 'R5: a regravação dos sobreviventes não pode ser um no-op');
    assert(/BATCH_CHANGED=1/.test(fence), 'R5: BATCH_CHANGED precisa ser atribuída em algum ramo');
    assert(/SURVIVOR_UNION_PATHS=\$\(claim_union/.test(fence), 'R5: a união dos sobreviventes precisa ser computada');
    assert(/forge-write-claim\.js" --clear/.test(fence), 'R5: o caso zero-sobreviventes precisa ser nomeado');
  });
}

// ── G22: release no gate (S05/T03) ─────────────────────────────────────────
//
// O erro mais caro possível desta slice tem assert PRÓPRIO e vem primeiro: um
// counterpart LIBERADO que caísse em `claim-absent` viraria `undeclared-writes`
// (D1) e o release PIORARIA o bloqueio que veio consertar (contrato #6).
console.log('\nG22: release — skip nomeado, mordida nos dois sentidos, sonda fail-closed, baseline medido');
{
  const release = require('./forge-claim-release.js');
  const runsApi22 = require('./forge-runs.js');
  const { readClaim: readClaim22, RELEASE_MECHANISMS: MECHS } = require('./forge-write-claim.js');
  const { recordAndEvaluate, DEFAULT_RELEASE_PROBE, DEFAULT_RELEASE_CLASSIFY,
    RELEASE_SKIP_BY_MECHANISM } = gate;

  /** O envelope `released` de T01, na forma que `normalizeReleased` aceita. */
  function releasedEnvelope(mechanism) {
    return { at: 1785763254000, mechanism, evidence: {} };
  }

  /** Reescreve o claim de uma run já gravada — o "único delta" das mordidas. */
  function patchClaim(ws, id, patch) {
    const file = path.join(ws, '.gsd', 'forge', 'runs', `${id}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.write_claim = Object.assign({}, rec.write_claim, patch);
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
  }

  /** Sonda injetada que devolve FATOS fixos — o mundo, sem VCS nem relógio. */
  function factsProbe(facts) {
    return () => Object.assign({
      claim_present: true,
      explicit_release: false,
      code_dir: '/code/dir',
      vcs: 'git',
      baseline_before: 'aaa',
      baseline_now: 'aaa',
      baseline_advanced: false,
      dirty_paths: [],
      paths_in_flight: true,
      age_ms: 1,
      ttl_ms: 10,
      grace_ms: 1,
      ttl_expired: false,
      owner_active: true,
      probe_error: null,
    }, facts);
  }

  test('G22a: contrato #6 — counterpart LIBERADO sai com skip nomeado e NUNCA vira claim-absent', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js'], undefined, { released: releasedEnvelope('explicit') }) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
    }));

    // 1. Saiu do universo NOMEADO e CONTADO.
    assert(r.census.skipped.some((s) => s.id === 'M-other' && s.reason === 'claim-released:explicit'),
      'o counterpart liberado precisa sair com skip nomeado carregando o mecanismo');
    assertEqual(r.census.counterparts_considered, 1, 'considerado: o liberado CONTA no censo');
    assertEqual(r.census.counterparts_in_scope, 0, 'em escopo: o liberado NÃO conta');

    // 2. A NÃO-CONVERSÃO, que é o assert dedicado desta slice.
    assert(!r.census.notes.some((n) => String(n.id).includes('M-other') && n.reason === 'claim-absent'),
      'REGRESSÃO CONTRATO #6: claim liberado colapsou em claim-absent — o release viraria undeclared-writes');
    assert(!r.census.notes.some((n) => n.reason === 'claim-absent'),
      'nenhuma note claim-absent pode nascer de um claim que EXISTE e foi liberado');
    assertEqual(r.cause, null, 'um claim liberado nunca pode produzir cause alguma');
    assert(r.cause !== 'undeclared-writes',
      'REGRESSÃO CONTRATO #6: o release piorou o bloqueio — virou undeclared-writes');
    assertEqual(r.decision !== 'refuse' && r.decision !== 'block', true, 'liberado não bloqueia');

    // 3. Razão do proceed: nada foi confrontado.
    assertEqual(r.decision, 'proceed');
    assertEqual(r.reason, 'no-active-counterpart',
      'com o liberado como único candidato, NADA foi confrontado — no-conflict alegaria um confronto inexistente');
    assert(r.reason !== 'no-conflict', 'as duas razões de proceed continuam distintas');

    // 4. O campo aditivo nomeia quem saiu e por quê.
    assertEqual(JSON.stringify(r.released_counterparts),
      JSON.stringify([{
        id: 'M-other', mechanism: 'explicit', reason: 'released-explicit', persisted_mechanism: 'explicit',
      }]));
  });

  test('G22b: mordida nos DOIS sentidos sobre a MESMA fixture — único delta é o envelope released', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const args = { cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 2 };

    const held = record(evaluateGate(args));
    assertEqual(held.decision, 'block', 'sentido 1: counterpart NÃO liberado bloqueia');
    assertEqual(held.cause, 'overlap');
    assertEqual(held.census.counterparts_in_scope, 1);
    assertEqual(held.released_counterparts.length, 0);

    patchClaim(ws, 'M-other', { released: releasedEnvelope('committed') });

    const freed = record(evaluateGate(args));
    assertEqual(freed.decision, 'proceed', 'sentido 2: o MESMO estado com o envelope released passa');
    assertEqual(freed.reason, 'no-active-counterpart');
    assertEqual(freed.census.counterparts_in_scope, 0);
    assertEqual(freed.census.skipped.filter((s) => s.reason.startsWith('claim-released:')).length, 1);
  });

  test('G22c: os três mecanismos produzem os três skips nomeados (committed / ttl-expired / explicit)', () => {
    function withProbe(facts) {
      const ws = makeFixture([
        { id: 'M-own', write_claim: claim(['scripts/x.js']) },
        { id: 'M-other', write_claim: claim(['scripts/x.js']) },
      ]);
      return record(evaluateGate({
        cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
        releaseProbe: factsProbe(facts),
      }));
    }
    // As DUAS sondas de T02 satisfeitas -> released-committed.
    const committed = withProbe({ baseline_advanced: true, paths_in_flight: false });
    assertEqual(committed.decision, 'proceed');
    assertEqual(committed.released_counterparts[0].mechanism, 'committed');
    assert(committed.census.skipped.some((s) => s.reason === 'claim-released:committed'));

    // A rede do TTL (D2): janela vencida SOBRE RUN INATIVA E SEM TRABALHO EM VOO
    // nos paths reivindicados — nunca idade sozinha. O terceiro fato é exigência
    // do degrau (`paths_in_flight !== true`): árvore suja é assinatura de
    // pause/handoff, e a rede não pode confundir isso com abandono
    // (par de polaridade em forge-claim-release.test.js R13c).
    const ttl = withProbe({ ttl_expired: true, owner_active: false, paths_in_flight: false });
    assertEqual(ttl.decision, 'proceed');
    assertEqual(ttl.released_counterparts[0].mechanism, 'ttl-expired');
    assert(ttl.census.skipped.some((s) => s.reason === 'claim-released:ttl-expired'));

    // Par de polaridade: MESMA janela vencida e MESMA árvore limpa, run ATIVA ->
    // segue em escopo. O único delta contra `ttl` é `owner_active`, então o
    // assert morde sobre a vitalidade do dono e não por acidente de outro fato.
    const alive = withProbe({ ttl_expired: true, owner_active: true, paths_in_flight: false });
    assertEqual(alive.decision, 'block', 'run viva nunca perde o claim para o relógio (D2)');
    assertEqual(alive.cause, 'overlap');
    assertEqual(alive.census.counterparts_in_scope, 1);
  });

  test('G22d: fail-closed — held-probe-unavailable MANTÉM o counterpart, com note nomeada', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
      releaseProbe: factsProbe({ probe_error: 'vcs-baseline-absent', baseline_advanced: null, paths_in_flight: null }),
    }));
    assertEqual(r.decision, 'block', 'pergunta que não pôde ser feita NUNCA abre a cerca');
    assertEqual(r.cause, 'overlap');
    assertEqual(r.census.counterparts_in_scope, 1);
    assertEqual(r.released_counterparts.length, 0);
    assert(r.census.notes.some((n) => n.reason === 'release-probe-unavailable'),
      'o motivo da sonda indisponível precisa aparecer no censo');
  });

  test('G22e: fail-closed — sonda que LANÇA mantém o counterpart e nomeia o throw', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
      releaseProbe: () => { throw new Error('sonda quebrada'); },
    }));
    assertEqual(r.decision, 'block', 'uma sonda quebrada que removesse counterparts abriria a cerca em silêncio');
    assertEqual(r.census.counterparts_in_scope, 1);
    const note = r.census.notes.find((n) => n.reason === 'release-probe-threw');
    assert(note, 'o throw precisa virar note nomeada');
    assert(/sonda quebrada/.test(note.detail || ''), 'a note deve carregar o erro nomeado');
  });

  test('G22f: fail-closed — veredito irreconhecível (razão E mecanismo) mantém o counterpart', () => {
    function withClassify(verdict) {
      const ws = makeFixture([
        { id: 'M-own', write_claim: claim(['scripts/x.js']) },
        { id: 'M-other', write_claim: claim(['scripts/x.js']) },
      ]);
      return record(evaluateGate({
        cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
        releaseProbe: factsProbe({}), releaseClassify: () => verdict,
      }));
    }
    // (a) razão fora de CLAIM_RELEASE_REASONS.
    const badReason = withClassify({ held: false, reason: 'liberado-por-vibe', mechanism: 'committed' });
    assertEqual(badReason.decision, 'block');
    assertEqual(badReason.census.counterparts_in_scope, 1);
    assert(badReason.census.notes.some((n) => n.reason === 'release-probe-unrecognised'));

    // (b) razão conhecida, MECANISMO fora de RELEASE_MECHANISMS: sem nome não há
    //     skip, e sem skip a saída seria invisível — então não há saída.
    const badMech = withClassify({ held: false, reason: 'released-committed', mechanism: 'bogus' });
    assertEqual(badMech.decision, 'block', 'mecanismo sem nome não pode tirar counterpart do universo');
    assertEqual(badMech.census.counterparts_in_scope, 1);
    assert(badMech.census.notes.some((n) => n.reason === 'release-probe-unrecognised'));
  });

  // Review R4: `manual` — o release de mão do operador, que NÃO alega medição.
  // `classifyRelease` nunca o emite (por construção: não há razão que o
  // produza), então o skip é alcançado pela MESMA seam injetada que prova os
  // ramos fail-closed acima. O que a produção mostra hoje de um claim liberado
  // à mão é `persisted_mechanism: 'manual'`, asserido junto — os dois fatos
  // (mecanismo DESTE veredito × mecanismo que aposentou o claim) nunca colapsam.
  test('G22f2: `manual` produz o skip nomeado claim-released:manual, e o envelope persistido aparece', () => {
    const releasedClaim = Object.assign(claim(['scripts/x.js']), {
      released: { at: 1, mechanism: 'manual', evidence: {} },
    });
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: releasedClaim },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
      releaseProbe: factsProbe({}),
      releaseClassify: () => ({ held: false, reason: 'released-explicit', mechanism: 'manual' }),
    }));
    assertEqual(r.decision, 'proceed', 'o counterpart liberado sai do universo');
    assert(r.census.skipped.some((s) => s.reason === 'claim-released:manual'),
      'o skip precisa NOMEAR o mecanismo — um skip sem nome é uma saída invisível');
    assertEqual(r.released_counterparts[0].mechanism, 'manual');
    assertEqual(r.released_counterparts[0].persisted_mechanism, 'manual',
      'o envelope persistido é reportado ao lado do veredito, nunca no lugar dele');
  });

  test('G22g: sem sonda injetada, o DEFAULT roda e um claim sem baseline segue em escopo', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
    }));
    assertEqual(r.decision, 'block', 'claim sem vcs_baseline não é prova de release');
    assertEqual(r.census.counterparts_in_scope, 1);
    assert(r.census.notes.some((n) => n.reason === 'release-probe-unavailable'),
      'a ausência de baseline é um buraco na evidência, e é nomeada');
  });

  test('G22h: o seam é INJETÁVEL e observável — recebe o claim do counterpart E o RunRecord dele', () => {
    const seen = [];
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']), isolation_mode: 'worktree' },
    ]);
    record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
      releaseProbe: (c, opts) => { seen.push({ c, opts }); return factsProbe({})(); },
    }));
    assertEqual(seen.length, 1, 'a sonda deve ser chamada uma vez por counterpart em escopo');
    assertEqual(JSON.stringify(seen[0].c.paths), JSON.stringify(['scripts/x.js']),
      'o claim do COUNTERPART precisa chegar à sonda');
    assert(seen[0].opts.runRecord, 'o RunRecord do counterpart precisa chegar à sonda');
    assertEqual(seen[0].opts.runRecord.id, 'M-other');
    assertEqual(seen[0].opts.runRecord.isolation_mode, 'worktree',
      'o RunRecord COMPLETO viaja — um seam que ninguém alimenta é um seam descoberto quebrado depois');
    assertEqual(seen[0].opts.runId, 'M-other');
  });

  test('G22i: o default do seam é o probeClaim de T02 — por IDENTIDADE DE REFERÊNCIA', () => {
    assertEqual(DEFAULT_RELEASE_PROBE, release.probeClaim,
      'o default precisa SER a função de T02, não uma cópia com o mesmo comportamento');
    assertEqual(DEFAULT_RELEASE_CLASSIFY, release.classifyRelease,
      'a decisão de release não é reimplementada no gate — é a de T02, por referência');
  });

  test('G22j: recordAndEvaluate MEDE o baseline na gravação e o persiste no claim', () => {
    const ws = makeFixture([{ id: 'M-own' }]);
    const seam = {
      detectVcs: () => 'git',
      baselineId: () => ({ ok: true, id: 'abc123' }),
      workingStatus: () => ({ ok: true, entries: [] }),
    };
    const r = record(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T01', source: 'manual',
      codeDir: '/code/dir', paths: ['scripts/x.js'], vcsSeam: seam, emitEvent: false,
    }));
    assertEqual(JSON.stringify(r.claim.vcs_baseline), JSON.stringify({ vcs: 'git', id: 'abc123' }));
    assertEqual(JSON.stringify(readClaim22(runsApi22.get(ws, 'M-own')).vcs_baseline),
      JSON.stringify({ vcs: 'git', id: 'abc123' }),
      'o baseline medido precisa estar PERSISTIDO — um "antes" lido depois não é um antes');
    assert(!r.census.notes.some((n) => String(n.reason).startsWith('vcs-baseline-')),
      'baseline medido com sucesso não gera note');
  });

  test('G22k: sem code_dir ou com medição falha -> vcs_baseline null NOMEADO, nunca adivinhado (B2)', () => {
    const wsA = makeFixture([{ id: 'M-own' }]);
    const semCodeDir = record(recordAndEvaluate({
      cwd: wsA, runId: 'M-own', unit: 'execute-task/T01', source: 'manual',
      paths: ['scripts/x.js'], emitEvent: false,
    }));
    assertEqual(semCodeDir.claim.vcs_baseline, null);
    assert(semCodeDir.census.notes.some((n) => n.reason === 'vcs-baseline-absent'),
      'a ausência é FATO e é nomeada — nunca derivada de root+branch');

    const wsB = makeFixture([{ id: 'M-own' }]);
    const falhou = record(recordAndEvaluate({
      cwd: wsB, runId: 'M-own', unit: 'execute-task/T01', source: 'manual',
      codeDir: '/code/dir', paths: ['scripts/x.js'], emitEvent: false,
      vcsSeam: { detectVcs: () => 'git', baselineId: () => ({ ok: false, error: 'boom' }) },
    }));
    assertEqual(falhou.claim.vcs_baseline, null, 'medição falha nunca vira id inventado');
    const note = falhou.census.notes.find((n) => n.reason === 'vcs-baseline-unmeasured');
    assert(note, 'a falha de medição precisa ser nomeada');
    assert(/boom/.test(note.detail || ''), 'a note deve carregar o erro nomeado da sonda');
  });

  test('G22l: o evento claim-gate carrega released_counterparts (campo ADITIVO, lido do events.jsonl)', () => {
    const ws = makeFixture([
      { id: 'M-own' },
      { id: 'M-other', write_claim: claim(['scripts/x.js'], undefined, { released: releasedEnvelope('committed') }) },
    ]);
    const r = record(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T01', source: 'manual',
      codeDir: '/code/dir', paths: ['scripts/x.js'],
      vcsSeam: { detectVcs: () => 'git', baselineId: () => ({ ok: true, id: 'zzz' }) },
    }));
    assertEqual(r.decision, 'proceed');
    const lines = fs.readFileSync(path.join(ws, '.gsd', 'forge', 'events.jsonl'), 'utf8').trim().split('\n');
    const ev = JSON.parse(lines[lines.length - 1]);
    assertEqual(ev.event, 'claim-gate');
    // `mechanism` é o do VEREDITO (o envelope já estava lá -> explicit) e
    // `persisted_mechanism` é o que originalmente aposentou o claim. Os dois
    // viajam: colapsá-los diria "liberado explicitamente" sobre um claim que um
    // commit medido aposentou.
    assertEqual(JSON.stringify(ev.released_counterparts),
      JSON.stringify([{
        id: 'M-other', mechanism: 'explicit', reason: 'released-explicit', persisted_mechanism: 'committed',
      }]),
      'o evento precisa nomear quem saiu e por qual mecanismo');
    // Leitor ANTIGO que ignora o campo continua correto: tudo que ele lia segue lá.
    for (const k of ['decision', 'cause', 'census', 'counterparts', 'not_covered', 'run', 'unit']) {
      assert(Object.prototype.hasOwnProperty.call(ev, k), `campo pré-existente sumiu do evento: ${k}`);
    }
  });

  test('G22m: compareClaims segue PURA — nenhum import de release em forge-claim-overlap.js', () => {
    const src = fs.readFileSync(path.join(__dirname, 'forge-claim-overlap.js'), 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const guard = (s) => !/forge-claim-release|probeClaim|classifyRelease/.test(s);
    assert(guard(stripped), 'a sondagem vazou para o comparador — contrato #7 quebrado');
    // Controle positivo: o mesmo predicado precisa MORDER quando o import existe.
    assert(!guard(`${stripped}\nconst { probeClaim } = require('./forge-claim-release.js');\n`),
      'o guard não mordeu o import injetado — guard cego');
    // E o gate, que É impuro, carrega o import: prova de que a fronteira está do lado certo.
    assert(/forge-claim-release/.test(fs.readFileSync(MODULE, 'utf8')),
      'o gate é quem importa o release — se nem ele importa, o guard acima passa por vacuidade');
  });

  test('G22n: cruzamento dos skips de release nos DOIS sentidos, contra RELEASE_MECHANISMS', () => {
    const mapped = Object.values(RELEASE_SKIP_BY_MECHANISM).sort();
    const declared = GATE_SKIP_REASONS.filter((s) => s.startsWith('claim-released:')).sort();
    assertEqual(JSON.stringify(mapped), JSON.stringify(declared),
      'todo mecanismo tem skip declarado, e todo skip declarado vem de um mecanismo');
    assertEqual(mapped.length, MECHS.length, 'um skip por mecanismo de T01, nem mais nem menos');
  });

  test('G22o: R7 intocada — as primitivas do ledger de defer seguem íntegras e nomeadas', () => {
    const { readDeferLedger, writeDeferLedger, deferKey, deferLedgerPath } = gate._private;
    const ws = mktmp();
    assertEqual(JSON.stringify(readDeferLedger(ws)), JSON.stringify({ data: {}, note: null }),
      'ledger inexistente não é falha');
    assertEqual(writeDeferLedger(ws, { 'a|b': { count: 1 } }), null);
    assertEqual(readDeferLedger(ws).data['a|b'].count, 1);
    assertEqual(deferKey('R', 'execute-task/T01'), 'R|execute-task/T01');
    assert(deferLedgerPath(ws).endsWith(path.join('.gsd', 'forge', 'claim-gate-defers.json')));
  });

  test('G22p: a razão de complete-slice deixou de citar a colisão com o release de IN-6', () => {
    assertEqual(UNCOVERED_BOUNDARIES.length, 3, 'a fronteira continua enumerada — o conjunto segue com 3');
    const cs = UNCOVERED_BOUNDARIES.find((b) => b.boundary === 'complete-slice');
    assert(cs, 'a fronteira complete-slice não pode sumir da enumeração');
    assert(!/colide com o release/.test(cs.reason),
      'a razão antiga virou mentira enumerada: o release de IN-6 foi entregue nesta slice');
    assert(/Deferred do CONTEXT/.test(cs.reason), 'a razão precisa dizer que a fronteira está fora por DECISÃO');
  });
}

// ── G23: D8 — o gate CONSOME o campo de S06/T01 ────────────────────────────
//
// A prova NÃO é "o gate lê o campo" (T02/S04 desta milestone pagou por medir a
// coisa errada). A prova é: a MESMA entrada de gate decide DIFERENTE conforme a
// presença do campo, e a única diferença entre as duas execuções é essa.
console.log('\nG23: D8 — a MESMA entrada decide diferente conforme a presença de unmet_requirement');
{
  const { POSTURE_OVERRIDES, OVERRIDE_EFFECTS, DEFAULT_ISOLATION_RESOLVER } = gate;
  const isolation = require('./forge-isolation.js');

  // A forma EXATA que S06/T01 entrega (lida do T01-SUMMARY, não suposta).
  const UNMET = Object.freeze({
    requirement: 'worktree',
    asked_by: ['require_worktree:true'],
    blocked_by: 'vcs:svn',
    write_engine: null,
  });

  // Um ÚNICO retorno base. O caso `presente` é ele MAIS a chave; o caso
  // `ausente` é ele. Construir os dois de bases separadas deixaria a frase "a
  // única diferença é o campo" como afirmação; assim ela é construção.
  const BASE_EFF = Object.freeze({
    mode: 'shared', user_mode: 'shared', mode_origin: 'default',
    require_worktree: 'true', elevated: false, write_engine: null, vcs: 'svn',
  });
  const effAusente = () => Object.assign({}, BASE_EFF);
  const effPresente = () => Object.assign({}, BASE_EFF, { unmet_requirement: UNMET });

  /** A MESMA colisão, sempre: duas runs reivindicando o mesmo arquivo. */
  function d8Fixture(codeDir) {
    return makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js'], codeDir) },
      { id: 'M-other', write_claim: claim(['scripts/x.js'], codeDir) },
    ]);
  }
  function decide(ws, resolver, over) {
    return record(evaluateGate(Object.assign({
      cwd: ws,
      runId: 'M-own',
      claim: claim(['scripts/x.js'], over && 'codeDir' in over ? over.codeDir : undefined),
      posture: 'defer',
      readyAlternatives: 2, // longe do piso D3, para o block NUNCA vir dele aqui
      isolationResolver: resolver,
    }, (over && over.gate) || {})));
  }

  test('G23a: o delta entre os dois retornos do resolvedor é EXATAMENTE a chave unmet_requirement', () => {
    const a = Object.keys(effAusente()).sort();
    const b = Object.keys(effPresente()).sort();
    assertEqual(JSON.stringify(b.filter((k) => !a.includes(k))), JSON.stringify(['unmet_requirement']),
      'o caso presente só pode ter A MAIS a chave do campo');
    assertEqual(JSON.stringify(a.filter((k) => !b.includes(k))), JSON.stringify([]),
      'e nada a menos — senão a comparação de decisão mediria outra coisa junto');
  });

  test('G23b: PAR D8 — campo PRESENTE endurece defer em block (override nomeado, sem piso)', () => {
    const r = decide(d8Fixture(), effPresente);
    assertEqual(r.decision, 'block', 'com o campo presente, defer deixa de ser opção (D8)');
    assertEqual(r.posture_effective, 'block');
    assertEqual(r.posture_override, 'svn-unmet-worktree');
    assertEqual(r.posture_override_effect, 'hardened');
    assertEqual(r.floor, null, 'este block vem de D8, não do piso D3 — as duas rotas não são a mesma coisa');
    assertEqual(r.cause, 'overlap');
  });

  test('G23c: PAR D8 — MESMA entrada, campo AUSENTE: decisão defer, nenhum override', () => {
    const r = decide(d8Fixture(), effAusente);
    assertEqual(r.decision, 'defer', 'sem o campo, a pref decide como sempre decidiu');
    assertEqual(r.posture_effective, 'defer');
    assertEqual(r.posture_override, null);
    assertEqual(r.posture_override_effect, null);
    assert(!r.census.notes.some((n) => /^isolation-/.test(n.reason)),
      'a árvore FOI medida (o resolvedor respondeu) — nenhuma note de não-medição cabe aqui');
  });

  test('G23d: pref block + campo presente -> segue block, mas o endurecimento é REPORTADO (already-block)', () => {
    const r = decide(d8Fixture(), effPresente, { gate: { posture: 'block' } });
    assertEqual(r.decision, 'block');
    assertEqual(r.posture_override, 'svn-unmet-worktree');
    assertEqual(r.posture_override_effect, 'already-block',
      'um block que a pref já pedia precisa ser distinguível de um que D8 impôs');
    // E o contraste que dá sentido ao rótulo:
    assertEqual(decide(d8Fixture(), effPresente).posture_override_effect, 'hardened');
  });

  test('G23e: piso D3 — com campo, block com override e floor null; sem campo, block por defer-floor', () => {
    const semAlternativa = { gate: { readyAlternatives: 0 } };
    const comCampo = decide(d8Fixture(), effPresente, semAlternativa);
    assertEqual(comCampo.decision, 'block');
    assertEqual(comCampo.posture_override, 'svn-unmet-worktree');
    assertEqual(comCampo.floor, null,
      'o endurecimento acontece ANTES do piso: o piso só vê `defer`, e já não há defer');

    const semCampo = decide(d8Fixture(), effAusente, semAlternativa);
    assertEqual(semCampo.decision, 'block', 'a mesma entrada sem campo também bloqueia — por outra rota');
    assertEqual(semCampo.floor, 'defer-floor');
    assertEqual(semCampo.posture_override, null,
      'o piso NUNCA se disfarça de endurecimento D8 — as duas rotas para block são nomeadas separadamente');
  });

  test('G23f: sem code_dir em NENHUM dos lados -> zero override + note isolation-unmeasured (com controle)', () => {
    let chamadas = 0;
    const contando = (dir) => { chamadas++; return effPresente(dir); };
    const r = decide(d8Fixture(null), contando, { codeDir: null });
    assertEqual(r.decision, 'defer', 'não-medição não endurece — a postura da pref permanece');
    assertEqual(r.posture_override, null);
    assertEqual(chamadas, 0, 'sem árvore não há o que medir: o resolvedor sequer é chamado');
    const note = r.census.notes.find((n) => n.reason === 'isolation-unmeasured');
    assert(note, 'a não-medição precisa ser NOMEADA, nunca silenciosa');

    // Controle positivo: a MESMA fixture, com code_dir, produz o override —
    // prova de que o `defer` acima veio da ausência de árvore, não de um
    // resolvedor que nunca teria endurecido nada.
    assertEqual(decide(d8Fixture(), contando).posture_override, 'svn-unmet-worktree');
    assertEqual(chamadas, 1, 'e agora o resolvedor FOI chamado — o controle não é vacuidade');
  });

  test('G23g: resolvedor que LANÇA -> zero override + note isolation-probe-threw carregando o erro', () => {
    const r = decide(d8Fixture(), () => { throw new Error('probe boom'); });
    assertEqual(r.decision, 'defer', 'sonda quebrada nunca endurece nem afrouxa');
    assertEqual(r.posture_override, null);
    const note = r.census.notes.find((n) => n.reason === 'isolation-probe-threw');
    assert(note, 'a sonda que lançou precisa ser nomeada');
    assert(/probe boom/.test(note.detail || ''), `a note deve carregar o erro: ${JSON.stringify(note)}`);
  });

  test('G23h: o code_dir PRÓPRIO tem precedência; o do counterpart é o fallback', () => {
    const medidos = [];
    const espia = (dir) => { medidos.push(dir); return effAusente(); };
    // Próprio com code_dir, counterpart com outro: mede o PRÓPRIO.
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js'], '/arvore/propria') },
      { id: 'M-other', write_claim: claim(['scripts/x.js'], '/arvore/propria') },
    ]);
    record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js'], '/arvore/propria'),
      posture: 'defer', readyAlternatives: 2, isolationResolver: espia,
    }));
    assertEqual(JSON.stringify(medidos), JSON.stringify(['/arvore/propria']),
      'é a árvore em que ESTA run vai escrever que decide');

    // Próprio SEM code_dir: cai para o do counterpart (que segue em escopo por
    // `unknown` — fail closed), e mede aquele.
    medidos.length = 0;
    const ws2 = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js'], null) },
      { id: 'M-other', write_claim: claim(['scripts/x.js'], '/arvore/do/outro') },
    ]);
    record(evaluateGate({
      cwd: ws2, runId: 'M-own', claim: claim(['scripts/x.js'], null),
      posture: 'defer', readyAlternatives: 2, isolationResolver: espia,
    }));
    assertEqual(JSON.stringify(medidos), JSON.stringify(['/arvore/do/outro']),
      'sem árvore própria, a do counterpart em confronto é a melhor medição disponível');
  });

  test('G23i: o default do seam é resolveEffectiveMode de S06/T01 — por IDENTIDADE DE REFERÊNCIA', () => {
    assertEqual(DEFAULT_ISOLATION_RESOLVER, isolation.resolveEffectiveMode,
      'o wiring é deste módulo; o COMPORTAMENTO já tem suíte um módulo ao lado');
  });

  test('G23j: valor fora dos conjuntos fechados é LOUD no seam — nunca string sem rótulo', () => {
    const real = gate.resolvePosture;
    const ws = d8Fixture();
    const call = () => evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'defer', readyAlternatives: 2,
    });
    try {
      gate.resolvePosture = () => ({ posture: 'defer', override: 'inventado', override_effect: null, note: null });
      let threw = null;
      try { call(); } catch (e) { threw = e.message; }
      assert(threw && /POSTURE_OVERRIDES/.test(threw), `override fora do conjunto tem de gritar: ${threw}`);

      gate.resolvePosture = () => ({ posture: 'defer', override: null, override_effect: 'inventado', note: null });
      threw = null;
      try { call(); } catch (e) { threw = e.message; }
      assert(threw && /OVERRIDE_EFFECTS/.test(threw), `efeito fora do conjunto tem de gritar: ${threw}`);

      gate.resolvePosture = () => ({ posture: 'talvez', override: null, override_effect: null, note: null });
      threw = null;
      try { call(); } catch (e) { threw = e.message; }
      assert(threw && /POSTURES/.test(threw), `postura fora do conjunto tem de gritar: ${threw}`);
    } finally {
      gate.resolvePosture = real;
    }
    // E o seam restaurado volta a decidir normalmente — o teste não deixa
    // destroço para os blocos seguintes.
    assertEqual(record(call()).decision, 'defer');
  });

  test('G23k: cruzamento dos conjuntos novos nos DOIS sentidos', () => {
    const overridesSeen = new Set();
    const effectsSeen = new Set();
    for (const r of [
      decide(d8Fixture(), effPresente),
      decide(d8Fixture(), effPresente, { gate: { posture: 'block' } }),
    ]) {
      overridesSeen.add(r.posture_override);
      effectsSeen.add(r.posture_override_effect);
    }
    // Direção 1: tudo que o código emitiu está declarado.
    for (const v of overridesSeen) assert(POSTURE_OVERRIDES.includes(v), `override fora do conjunto: ${v}`);
    for (const v of effectsSeen) assert(OVERRIDE_EFFECTS.includes(v), `efeito fora do conjunto: ${v}`);
    // Direção 2: tudo que está declarado foi emitido por >= 1 caso.
    for (const v of POSTURE_OVERRIDES) assert(overridesSeen.has(v), `override declarado e nunca emitido: ${v}`);
    for (const v of OVERRIDE_EFFECTS) assert(effectsSeen.has(v), `efeito declarado e nunca emitido: ${v}`);
    assert(Object.isFrozen(POSTURE_OVERRIDES) && Object.isFrozen(OVERRIDE_EFFECTS), 'conjuntos fechados são congelados');
  });

  test('G23l: os três campos viajam no evento, no --json e no render; `posture` NÃO muda de sentido', () => {
    const ws = d8Fixture();
    const r = recordEsc(recordAndEvaluate({
      cwd: ws,
      runId: 'M-own',
      unit: 'execute-task/T02',
      paths: ['scripts/x.js'],
      codeDir: '/code/dir',
      readyAlternatives: 2,
      prefsOpts: prefsOpts(),
      isolationResolver: effPresente,
    }));
    assertEqual(r.decision, 'block');
    assertEqual(r.posture, 'defer',
      '`posture` continua sendo a postura RESOLVIDA DA PREF — trocar seu sentido falsificaria retroativamente todo events.jsonl já escrito');
    assertEqual(r.posture_effective, 'block', 'a que decidiu viaja em campo PRÓPRIO');

    const ev = JSON.parse(fs.readFileSync(path.join(ws, '.gsd', 'forge', 'events.jsonl'), 'utf8').trim().split('\n').pop());
    assertEqual(ev.event, 'claim-gate');
    assertEqual(ev.posture, 'defer');
    assertEqual(ev.posture_effective, 'block');
    assertEqual(ev.posture_override, 'svn-unmet-worktree');
    assertEqual(ev.posture_override_effect, 'hardened');
    // Leitor ANTIGO que ignora as chaves novas continua correto.
    for (const k of ['decision', 'cause', 'census', 'counterparts', 'not_covered', 'posture', 'posture_source']) {
      assert(Object.prototype.hasOwnProperty.call(ev, k), `campo pré-existente sumiu do evento: ${k}`);
    }

    const rendered = gate.formatGate(r);
    assert(/endurecimento D8: svn-unmet-worktree/.test(rendered), `o render precisa mostrar o endurecimento:\n${rendered}`);
    assert(/hardened/.test(rendered), 'e o efeito — endurecimento que ninguém lê é endurecimento inerte');
    // O --json é o próprio resultado serializado: as chaves estão nele.
    const asJson = JSON.parse(JSON.stringify(r));
    for (const k of ['posture_effective', 'posture_override', 'posture_override_effect']) {
      assert(Object.prototype.hasOwnProperty.call(asJson, k), `chave ausente do --json: ${k}`);
    }
  });

  // ── G23m: o par PRESENÇA/AUSÊNCIA contra FIXTURE REAL, sem resolvedor injetado ──
  //
  // O seam injetado prova o DETERMINISMO (a decisão muda só pelo campo); a
  // fixture real prova o FIO (o campo que o gate lê é mesmo o que
  // `resolveEffectiveMode` produz numa árvore de verdade). Nenhuma das duas
  // substitui a outra.
  test('G23m: fixture REAL — working copy .svn + require_worktree:true bloqueia; checkout git defere', () => {
    const home = mktmp(); // HOME neutro: as prefs globais do operador nunca decidem um teste
    const prevHome = process.env.HOME;
    const prevUp = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const svnTree = mktmp();
      fs.mkdirSync(path.join(svnTree, '.svn'), { recursive: true });
      fs.mkdirSync(path.join(svnTree, '.gsd'), { recursive: true });
      fs.writeFileSync(path.join(svnTree, '.gsd', 'forge-prefs.jsonc'),
        `${JSON.stringify({ workers: { require_worktree: 'true' } }, null, 2)}\n`, 'utf8');

      const gitTree = mktmp();
      fs.mkdirSync(path.join(gitTree, '.git'), { recursive: true });
      fs.mkdirSync(path.join(gitTree, '.gsd'), { recursive: true });
      fs.writeFileSync(path.join(gitTree, '.gsd', 'forge-prefs.jsonc'),
        `${JSON.stringify({ workers: { require_worktree: 'true' } }, null, 2)}\n`, 'utf8');

      // Controle: a fixture PODERIA produzir o campo — e a irmã, não.
      const effSvn = isolation.resolveEffectiveMode(svnTree);
      assertEqual(effSvn.vcs, 'svn');
      assert(effSvn.unmet_requirement, 'a working copy SVN com require_worktree:true precisa nomear o requisito recusado');
      const effGit = isolation.resolveEffectiveMode(gitTree);
      assertEqual(effGit.vcs, 'git');
      assert(!('unmet_requirement' in effGit), 'em git com worktree possível NADA é recusado — o campo é ausente');

      // Sem `isolationResolver`: o default é quem mede.
      const bloqueado = record(evaluateGate({
        cwd: d8Fixture(svnTree), runId: 'M-own', claim: claim(['scripts/x.js'], svnTree),
        posture: 'defer', readyAlternatives: 2,
      }));
      assertEqual(bloqueado.decision, 'block', 'árvore SVN sem isolamento físico e com pedido recusado -> block');
      assertEqual(bloqueado.posture_override, 'svn-unmet-worktree');

      const deferido = record(evaluateGate({
        cwd: d8Fixture(gitTree), runId: 'M-own', claim: claim(['scripts/x.js'], gitTree),
        posture: 'defer', readyAlternatives: 2,
      }));
      assertEqual(deferido.decision, 'defer', 'em git NADA muda — é a metade do par que prova a ausência de dano');
      assertEqual(deferido.posture_override, null);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUp === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUp;
    }
  });

  // ── G23n: A MORDIDA, EXECUTADA ─────────────────────────────────────────────
  //
  // Mecanismo escolhido (dos dois que o plano admite): CÓPIA DESCARTÁVEL ao lado
  // do original — os `require` relativos continuam resolvendo e o arquivo real
  // NUNCA é escrito. A restauração byte-idêntica é conferida mesmo assim
  // (`Buffer.compare` antes/depois), porque "não escrevi" é premissa, e premissa
  // conferida custa uma linha. O teste REPORTA o vermelho que observou.
  test('G23n: MORDIDA — neutralizar a única linha que lê o campo deixa o caso PRESENTE vermelho', () => {
    const antes = fs.readFileSync(MODULE);
    const src = antes.toString('utf8');
    const needle = '  const unmet = effective && effective.unmet_requirement;';
    assertEqual(src.split(needle).length - 1, 1,
      'a mordida precisa casar EXATAMENTE a leitura do campo — 0 ou 2 casamentos a tornariam vazia');

    // O DIRETÓRIO é escolha medida (os `require` relativos do módulo mordido
    // precisam resolver de `scripts/`); o NOME fixo nunca foi exigido por isso
    // (S06/R3). Sufixo único por processo: duas execuções concorrentes na mesma
    // árvore deixam de disputar o mesmo caminho, e cada invocação limpa só o
    // seu — sem mover a mordida para um tmpdir, que quebraria os `require`.
    const biteFile = path.join(
      __dirname,
      `forge-claim-gate.__bite-d8__.${process.pid}-${Math.random().toString(36).slice(2, 10)}.js`,
    );
    fs.writeFileSync(biteFile, src.replace(needle, '  const unmet = null;'), 'utf8');
    let observado = null;
    try {
      // eslint-disable-next-line global-require
      const bitten = require(biteFile);
      const ws = d8Fixture();
      observado = bitten.evaluateGate({
        cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']),
        posture: 'defer', readyAlternatives: 2, isolationResolver: effPresente,
      });
      assertEqual(observado.decision, 'defer',
        'com a leitura neutralizada o caso PRESENTE deixa de bloquear — G23b ficaria vermelho: a mordida morde');
      assertEqual(observado.posture_override, null, 'e o override some junto');

      // O módulo real, na MESMA entrada, segue bloqueando.
      assertEqual(decide(d8Fixture(), effPresente).decision, 'block',
        'o módulo real permanece intacto após a mordida');
    } finally {
      delete require.cache[require.resolve(biteFile)];
      fs.rmSync(biteFile, { force: true });
    }
    const depois = fs.readFileSync(MODULE);
    assertEqual(Buffer.compare(antes, depois), 0, 'o arquivo real precisa sair byte-idêntico da mordida');
  });

  // ── G23p/q/r (S06/R1): sem code_dir PRÓPRIO, TODO counterpart em conflito é
  // sondado — e o veredicto não pode depender da ordem de iteração do registry.
  //
  // A ordem persistida é a única variável entre as duas execuções: mesma
  // colisão, mesmas duas árvores, mesmo resolvedor. Um teste que rodasse uma só
  // ordem não detectaria o defeito — ele ERA a ordem.
  const SVN_TREE = '/arvore/svn-unmet';
  const GIT_TREE = '/arvore/git-ok';
  // Resolvedor por ÁRVORE: só a SVN recusa o worktree.
  const porArvore = (medidos) => (dir) => {
    if (medidos) medidos.push(dir);
    return dir === SVN_TREE ? effPresente() : effAusente();
  };
  /** Own SEM code_dir; dois counterparts em conflito, um por árvore, na ordem dada. */
  function multiFixture(ordem) {
    return makeFixture([{ id: 'M-own', write_claim: claim(['scripts/x.js'], null) }].concat(
      ordem.map(([id, dir]) => ({ id, write_claim: claim(['scripts/x.js'], dir) })),
    ));
  }
  function decideMulti(ordem, medidos) {
    return record(evaluateGate({
      cwd: multiFixture(ordem),
      runId: 'M-own',
      claim: claim(['scripts/x.js'], null),
      posture: 'defer',
      readyAlternatives: 2, // longe do piso D3: o block só pode vir de D8
      isolationResolver: porArvore(medidos),
    }));
  }
  // Os ids são POSICIONAIS de propósito: a iteração do registry é por id, então
  // trocar só a posição no array não trocaria nada — a ordem seria a mesma nas
  // duas execuções e o teste mediria a coisa errada (medido: com ids `M-git`/
  // `M-svn` o mordido devolvia `defer` nas duas). Aqui a árvore é atribuída à
  // POSIÇÃO, e a ordem de iteração realmente inverte.
  const ORDEM_GIT_PRIMEIRO = [['M-1', GIT_TREE], ['M-2', SVN_TREE]];
  const ORDEM_SVN_PRIMEIRO = [['M-1', SVN_TREE], ['M-2', GIT_TREE]];

  test('G23p: MESMO veredicto nas DUAS ordens persistidas — a ordem de iteração deixou de decidir', () => {
    const medidosA = [];
    const a = decideMulti(ORDEM_GIT_PRIMEIRO, medidosA);
    const medidosB = [];
    const b = decideMulti(ORDEM_SVN_PRIMEIRO, medidosB);

    // Antes do fix, `firstConflicting` sondava só a primeira: git primeiro ->
    // `defer`. É esta linha que fica vermelha com o comportamento anterior.
    assertEqual(a.decision, 'block',
      'counterpart git iterado PRIMEIRO não pode esconder o SVN-unmet que vem atrás (under-block silencioso)');
    assertEqual(b.decision, 'block', 'e com o SVN primeiro o veredicto é o mesmo');
    assertEqual(a.posture_effective, b.posture_effective);
    assertEqual(a.posture_override, b.posture_override);
    assertEqual(a.posture_override_effect, b.posture_override_effect);
    assertEqual(a.posture_override, 'svn-unmet-worktree');
    assertEqual(a.floor, null, 'este block é D8, não o piso D3');

    // E as DUAS árvores foram efetivamente medidas nas duas ordens — sem isso
    // o assert acima poderia estar verde por acaso de fixture.
    assertEqual(JSON.stringify(medidosA.slice().sort()), JSON.stringify([GIT_TREE, SVN_TREE].sort()));
    assertEqual(JSON.stringify(medidosB.slice().sort()), JSON.stringify([GIT_TREE, SVN_TREE].sort()));
    assertEqual(a.census.counterparts_in_scope, 2, 'a sondagem é limitada por counterparts_in_scope');
  });

  test('G23q: controle negativo — dois counterparts SEM unmet nenhum: segue defer, sem override', () => {
    const medidos = [];
    const r = decideMulti([['M-1', GIT_TREE], ['M-2', '/arvore/git-ok-2']], medidos);
    assertEqual(r.decision, 'defer', 'sondar todos não endurece por sondar — endurece por MEDIR o campo');
    assertEqual(r.posture_override, null);
    assertEqual(medidos.length, 2, 'e ambas foram medidas — o defer não veio de não ter olhado');
  });

  test('G23r: sonda que LANÇA é nomeada e NUNCA decide — nem endurece, nem cala a irmã que mediu', () => {
    // Uma árvore lança, a outra mede `unmet`: a que mediu decide, a que lançou
    // vira note. (S05, verbatim: medição que não pôde ser feita não é evidência.)
    const resolverMisto = (dir) => {
      if (dir === GIT_TREE) throw new Error('probe boom multi');
      return effPresente();
    };
    const comMedicao = record(evaluateGate({
      cwd: multiFixture(ORDEM_GIT_PRIMEIRO),
      runId: 'M-own',
      claim: claim(['scripts/x.js'], null),
      posture: 'defer',
      readyAlternatives: 2,
      isolationResolver: resolverMisto,
    }));
    assertEqual(comMedicao.decision, 'block', 'a sonda que lançou não pode suprimir a que mediu');
    const nota = comMedicao.census.notes.find((n) => n.reason === 'isolation-probe-threw');
    assert(nota, 'a sonda que lançou precisa ser NOMEADA mesmo num veredicto endurecido');
    assert(/probe boom multi/.test(nota.detail || ''), `a note carrega o erro: ${JSON.stringify(nota)}`);

    // E o espelho: TODAS lançam -> a postura da pref permanece, com uma note
    // por sonda. Nunca endurece por não ter conseguido medir.
    const todasLancam = record(evaluateGate({
      cwd: multiFixture(ORDEM_GIT_PRIMEIRO),
      runId: 'M-own',
      claim: claim(['scripts/x.js'], null),
      posture: 'defer',
      readyAlternatives: 2,
      isolationResolver: () => { throw new Error('todas boom'); },
    }));
    assertEqual(todasLancam.decision, 'defer');
    assertEqual(todasLancam.posture_override, null);
    assertEqual(todasLancam.census.notes.filter((n) => n.reason === 'isolation-probe-threw').length, 2,
      'uma note POR sonda — colapsar em uma esconderia justamente a árvore que ninguém mediu');
  });

  test('G23s: com code_dir PRÓPRIO nada muda — só a árvore própria é medida (a garantia de escopo vale aqui)', () => {
    const medidos = [];
    // Counterpart SEM code_dir (escopo `unknown` — segue em confronto, fail
    // closed) e próprio na árvore git: mede-se a PRÓPRIA, e só ela.
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js'], GIT_TREE) },
      { id: 'M-outro', write_claim: claim(['scripts/x.js'], null) },
    ]);
    const r = record(evaluateGate({
      cwd: ws,
      runId: 'M-own',
      claim: claim(['scripts/x.js'], GIT_TREE),
      posture: 'defer',
      readyAlternatives: 2,
      isolationResolver: porArvore(medidos),
    }));
    assertEqual(JSON.stringify(medidos), JSON.stringify([GIT_TREE]),
      'com árvore própria declarada, é ELA que decide — e é a única medida');
    assertEqual(r.decision, 'defer');
    assertEqual(r.posture_override, null);

    // No nível da unidade, a mesma fronteira dita explicitamente: mesmo com
    // `counterpartRuns` carregando a árvore SVN-unmet, o ramo com code_dir
    // próprio NÃO a sonda — é onde a garantia de escopo do projeto vale.
    const medidosUnit = [];
    const semAlargar = resolvePosture({
      pref: 'defer',
      ownRun: { write_claim: { code_dir: GIT_TREE } },
      counterpartRuns: [{ write_claim: { code_dir: SVN_TREE } }],
      isolationResolver: porArvore(medidosUnit),
    });
    assertEqual(JSON.stringify(medidosUnit), JSON.stringify([GIT_TREE]));
    assertEqual(semAlargar.posture, 'defer');
    assertEqual(semAlargar.override, null);
  });

  test('G23o: forge-claim-lease-repro.test.js segue verde por SPAWN, sem uma linha de edição', () => {
    const r = spawnSync(process.execPath, [LEASE_REPRO_TEST], { encoding: 'utf8' });
    assertEqual(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  });
}

// ══════════════════════════════════════════════════════════════════════════
// G25 (triagem final) — S05/R3: o release observado vira REGISTRO
//                       S07/R2c: a propriedade do operando vira MEDIDA
// ══════════════════════════════════════════════════════════════════════════
console.log('\nG25: R3 — o veredito `committed` corroborado é PERSISTIDO (e a recusa é NOMEADA)');
{
  const { evaluateGate, DEFAULT_RELEASE_PERSIST, OPERAND_OWNERS, LABEL_SEPARATOR } = gate;
  const { releaseClaim: releaseClaimReal, readClaim: readClaim25 } = require('./forge-write-claim.js');
  const runsApi25 = require('./forge-runs.js');

  /** Sonda injetada que satisfaz as DUAS provas -> veredito `committed`. */
  function committedProbe() {
    return () => ({
      claim_present: true, explicit_release: false, code_dir: '/code/dir', vcs: 'git',
      baseline_before: 'aaa', baseline_now: 'bbb', baseline_advanced: true,
      dirty_paths: [], paths_in_flight: false,
      age_ms: 1, ttl_ms: 10, grace_ms: 1, ttl_expired: false, owner_active: true, probe_error: null,
    });
  }
  /** TTL: liberado por rede, NÃO corroborado por este gate. */
  function ttlProbe() {
    return () => ({
      claim_present: true, explicit_release: false, code_dir: '/code/dir', vcs: 'git',
      baseline_before: 'aaa', baseline_now: 'aaa', baseline_advanced: false,
      // `paths_in_flight: false` é EXIGÊNCIA do degrau TTL, não conveniência:
      // com a árvore suja nos paths reivindicados o degrau recusa (pause/handoff
      // não é abandono) e esta sonda nunca produziria o mecanismo `ttl-expired`
      // que o teste abaixo precisa observar.
      dirty_paths: [], paths_in_flight: false,
      age_ms: 99, ttl_ms: 10, grace_ms: 1, ttl_expired: true, owner_active: false, probe_error: null,
    });
  }
  function twoRuns() {
    return makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
  }
  const baseArgs = (ws) => ({
    cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 1,
  });

  test('G25a: o seam de persistência É `forge-write-claim.releaseClaim`, por IDENTIDADE de referência', () => {
    assertEqual(DEFAULT_RELEASE_PERSIST === releaseClaimReal, true,
      'a escrita nunca é reimplementada aqui — se o seam divergir, a atomicidade de R1 fica de fora');
  });

  test('G25b: veredito `committed` corroborado é GRAVADO no RunRecord do counterpart', () => {
    const ws = twoRuns();
    const before = readClaim25(runsApi25.get(ws, 'M-other'));
    assertEqual(before.released, undefined, 'o claim não pode nascer liberado — senão o teste é vazio');

    const r = record(evaluateGate(Object.assign(baseArgs(ws), { releaseProbe: committedProbe() })));
    assertEqual(r.decision, 'proceed');
    assertEqual(r.released_counterparts[0].mechanism, 'committed');
    assertEqual(r.released_counterparts[0].persisted, true, 'o campo aditivo diz que o registro concordou');

    const after = readClaim25(runsApi25.get(ws, 'M-other'));
    assert(after.released, 'REGRESSÃO R3: o veredito vivo não virou registro — re-bloqueia na próxima unidade');
    assertEqual(after.released.mechanism, 'committed');
    assertEqual(after.released.evidence.observed_by, 'claim-gate');
    assertEqual(after.released.evidence.baseline_advanced, true, 'a evidência é a MEDIDA, não um envelope vazio');
    assertEqual(JSON.stringify(after.paths), JSON.stringify(['scripts/x.js']),
      'persistir ACRESCENTA o envelope — nunca apaga o claim');
  });

  test('G25c: mordida — sem a persistência, a MESMA fixture volta a não ter registro nenhum', () => {
    const ws = twoRuns();
    // A mordida neutraliza o seam (mesma fixture, mesmo veredito): o único delta
    // é a escrita. Se o registro continuasse gravado aqui, o assert de G25b
    // estaria medindo outra coisa.
    const r = record(evaluateGate(Object.assign(baseArgs(ws), {
      releaseProbe: committedProbe(),
      releasePersist: () => ({ ok: false, reason: 'no-claim' }),
    })));
    assertEqual(r.decision, 'proceed', 'o VEREDITO VIVO segue de pé — a persistência não decide nada');
    assertEqual(r.released_counterparts[0].persisted, false);
    assertEqual(r.released_counterparts[0].persist_refusal, 'no-claim');
    assert(r.census.notes.some((n) => n.id === 'M-own × M-other' && n.reason === 'release-persist-failed'),
      'uma persistência recusada é NOTA nomeada, nunca silêncio');
    assertEqual(readClaim25(runsApi25.get(ws, 'M-other')).released, undefined,
      'com o seam neutralizado nada pode ter sido gravado');
  });

  test('G25d: `expect` viaja com a IDENTIDADE medida — nunca um read-then-write', () => {
    const ws = twoRuns();
    const seen = [];
    record(evaluateGate(Object.assign(baseArgs(ws), {
      releaseProbe: committedProbe(),
      releasePersist: (cwd, id, released, opts) => { seen.push({ cwd, id, released, opts }); return { ok: true }; },
    })));
    assertEqual(seen.length, 1, 'uma escrita, para o counterpart medido');
    assertEqual(seen[0].id, 'M-other');
    assert(seen[0].opts && seen[0].opts.expect, 'sem `expect` a escrita cross-run reabre a corrida RMW de R1');
    assertEqual(seen[0].opts.expect.at, claim(['scripts/x.js']).at, 'o `expect` é o claim que ESTE gate mediu');
    assertEqual(seen[0].released.mechanism, 'committed');
  });

  test('G25e: corrida PERDIDA de verdade — dono grava claim novo na janela -> `stale-claim`, nada escrito', () => {
    const ws = twoRuns();
    // A escrita usa o `releaseClaim` REAL; o wrapper só simula o dono gravando
    // um claim novo entre a sonda e a escrita — a janela exata que R1 fechou.
    const r = record(evaluateGate(Object.assign(baseArgs(ws), {
      releaseProbe: committedProbe(),
      releasePersist: (cwd, id, released, opts) => {
        runsApi25.update(cwd, id, { write_claim: claim(['scripts/y.js'], undefined, { at: 1785763999000, unit: 'execute-task/T02' }) });
        return releaseClaimReal(cwd, id, released, opts);
      },
    })));
    assertEqual(r.decision, 'proceed', 'o veredito vivo continua valendo PARA ESTA avaliação');
    assertEqual(r.released_counterparts[0].persisted, false);
    assertEqual(r.released_counterparts[0].persist_refusal, 'stale-claim');
    assert(r.census.notes.some((n) => n.reason === 'release-persist-stale-claim'),
      'perder a corrida é "não consegui persistir" — NOMEADO, nunca inferido como "o release não aconteceu"');
    const after = readClaim25(runsApi25.get(ws, 'M-other'));
    assertEqual(after.released, undefined, 'o claim NOVO do dono não pode ter sido coberto por um envelope');
    assertEqual(after.unit, 'execute-task/T02', 'o claim novo sobreviveu intacto');
  });

  test('G25f: seam que LANÇA -> `release-persist-failed`, e o veredito vivo segue de pé', () => {
    const ws = twoRuns();
    const r = record(evaluateGate(Object.assign(baseArgs(ws), {
      releaseProbe: committedProbe(),
      releasePersist: () => { throw new Error('registry em chamas'); },
    })));
    assertEqual(r.decision, 'proceed');
    assertEqual(r.released_counterparts[0].persist_refusal, 'persist-threw');
    const n = r.census.notes.find((x) => x.reason === 'release-persist-failed');
    assert(n && /registry em chamas/.test(n.detail), 'o detalhe do erro é carregado, não engolido');
  });

  test('G25g: só `committed` é persistido — `ttl-expired` e `explicit` NUNCA são gravados por este gate', () => {
    const wsTtl = twoRuns();
    const calls = [];
    const spy = () => { calls.push(1); return { ok: true }; };
    const ttl = record(evaluateGate(Object.assign(baseArgs(wsTtl), { releaseProbe: ttlProbe(), releasePersist: spy })));
    assertEqual(ttl.released_counterparts[0].mechanism, 'ttl-expired');
    assertEqual(calls.length, 0, 'a rede do TTL é veredito sobre run MORTA alheia — carvá-lo num registro alheio não é corroboração deste gate');
    assertEqual(ttl.released_counterparts[0].persisted, undefined, 'sem tentativa, sem campo — ausência não é `false`');

    const wsExp = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim(['scripts/x.js'], undefined, { released: { at: 1, mechanism: 'committed', evidence: {} } }) },
    ]);
    record(evaluateGate(Object.assign(baseArgs(wsExp), { releasePersist: spy })));
    assertEqual(calls.length, 0, 'um claim que JÁ carrega o envelope não é reescrito');
  });
}

console.log('\nG26: R2c — a propriedade do operando é MEDIDA e viaja no evento (campo aditivo)');
{
  const { evaluateGate, recordAndEvaluate, OPERAND_OWNERS } = gate;
  const ownersSeen = new Set();

  function collide(ownPaths, cpPaths) {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(ownPaths) },
      { id: 'M-other', write_claim: claim(cpPaths) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(ownPaths), posture: 'block', readyAlternatives: 0,
    }));
    for (const cp of r.counterparts) {
      for (const po of (cp.path_operands || [])) for (const op of po.operands) ownersSeen.add(op.owner);
    }
    return { ws, r };
  }

  test('G26a: rótulo COMPOSTO carrega os operandos com dono medido — e o `label` fica intocado', () => {
    const { r } = collide(['src/**'], ['src/a.js']);
    assertEqual(r.cause, 'overlap');
    const cp = r.counterparts[0];
    assertEqual(JSON.stringify(cp.paths), JSON.stringify(['src/** × src/a.js']),
      'o campo pré-existente NÃO pode ser reescrito — linhas históricas seguem legíveis');
    assertEqual(cp.path_operands.length, 1);
    assertEqual(cp.path_operands[0].label, 'src/** × src/a.js');
    assertEqual(JSON.stringify(cp.path_operands[0].operands), JSON.stringify([
      { value: 'src/**', owner: 'own', run: 'M-own' },
      { value: 'src/a.js', owner: 'counterpart', run: 'M-other' },
    ]), 'cada operando nomeia o dono E a run — o fato que o schema não garantia');
  });

  test('G26b: a propriedade segue o CONTEÚDO, não a posição — fixture espelhada', () => {
    const { r } = collide(['src/a.js'], ['src/**']);
    const ops = r.counterparts[0].path_operands[0].operands;
    assertEqual(r.counterparts[0].paths[0], 'src/a.js × src/**', 'a posição dos operandos inverteu');
    assertEqual(ops[0].owner, 'own');
    assertEqual(ops[0].value, 'src/a.js', 'quem é dono de QUAL path acompanhou a claim, não a casa no rótulo');
    assertEqual(ops[1].owner, 'counterpart');
    assertEqual(ops[1].value, 'src/**');
  });

  test('G26c: rótulo NÃO-composto -> um operando `both` (os dois lados declararam o mesmo path)', () => {
    const { r } = collide(['scripts/x.js'], ['scripts/x.js']);
    const po = r.counterparts[0].path_operands[0];
    assertEqual(po.label, 'scripts/x.js');
    assertEqual(JSON.stringify(po.operands), JSON.stringify([{ value: 'scripts/x.js', owner: 'both', run: null }]),
      '`both` não nomeia run: nomear uma das duas afirmaria uma medição que ninguém fez');
  });

  test('G26d: path que CONTÉM o separador -> `unknown` nomeado, nunca atribuído por posição', () => {
    const { r } = collide(['src/a × b.js'], ['src/a × b.js']);
    const po = r.counterparts[0].path_operands[0];
    assertEqual(po.label, 'src/a × b.js', 'o rótulo bruto é preservado');
    assertEqual(po.operands.length, 2, 'o split não distingue separador de conteúdo — e é justamente por isso que existe `unknown`');
    for (const op of po.operands) assertEqual(op.owner, 'unknown');
    for (const op of po.operands) assertEqual(op.run, null);
  });

  test('G26e: `undeclared-writes` não inventa operando — sem colisão medida, sem campo', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim(['scripts/x.js']) },
      { id: 'M-other', write_claim: claim([]) },
    ]);
    const r = record(evaluateGate({
      cwd: ws, runId: 'M-own', claim: claim(['scripts/x.js']), posture: 'block', readyAlternatives: 0,
    }));
    assertEqual(r.cause, 'undeclared-writes');
    assertEqual(r.counterparts[0].path_operands, undefined,
      'sem overlap não há operando a possuir — um campo vazio aqui seria estrutura sem medição');
  });

  test('G26f: o evento claim-gate carrega `path_operands`, LIDO do events.jsonl, sem perder campo antigo', () => {
    const ws = makeFixture([
      { id: 'M-own', active: true },
      { id: 'M-other', write_claim: claim(['src/a.js']) },
    ]);
    const r = record(recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T01', source: 'manual',
      codeDir: '/code/dir', paths: ['src/**'],
      vcsSeam: { detectVcs: () => 'git', baselineId: () => ({ ok: true, id: 'zzz' }) },
    }));
    assertEqual(r.cause, 'overlap');
    const lines = fs.readFileSync(path.join(ws, '.gsd', 'forge', 'events.jsonl'), 'utf8').trim().split('\n');
    const ev = JSON.parse(lines[lines.length - 1]);
    const cp = ev.counterparts.find((c) => c.id === 'M-other');
    assertEqual(JSON.stringify(cp.path_operands[0].operands), JSON.stringify([
      { value: 'src/**', owner: 'own', run: 'M-own' },
      { value: 'src/a.js', owner: 'counterpart', run: 'M-other' },
    ]), 'a linha gravada é o que torna a propriedade MEDÍVEL para o consumidor de S07');
    for (const k of ['decision', 'cause', 'census', 'counterparts', 'not_covered', 'run', 'unit', 'released_counterparts']) {
      assert(Object.prototype.hasOwnProperty.call(ev, k), `campo pré-existente sumiu do evento: ${k}`);
    }
    assertEqual(JSON.stringify(cp.paths), JSON.stringify(['src/** × src/a.js']), '`paths` mantém o significado de sempre');
  });

  test('G26g: OPERAND_OWNERS cruzado nos DOIS sentidos', () => {
    for (const o of ownersSeen) assert(OPERAND_OWNERS.includes(o), `dono emitido fora do conjunto: ${o}`);
    for (const o of OPERAND_OWNERS) assert(ownersSeen.has(o), `dono declarado e nunca emitido: ${o}`);
  });

  test('G26h: o separador é o MESMO literal que forge-claim-overlap.js renderiza (guard de drift)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'forge-claim-overlap.js'), 'utf8');
    assert(src.includes(`\${a}${gate.LABEL_SEPARATOR}\${b}`),
      'o separador divergiu do vizinho — o split pararia de dividir e produziria operandos de aparência medida');
    // Controle positivo: um separador inventado NÃO é encontrado.
    assert(!src.includes('${a} ×× ${b}'), 'o predicado não morde — controle positivo falhou');
  });

  test('G26i: o spec documenta o campo novo e os quatro donos (conformance doc↔código)', () => {
    const specText = fs.readFileSync(SPEC_PATH, 'utf8');
    assert(specText.includes('path_operands'), 'campo do evento ausente do spec — foi exatamente o defeito de S06/R2');
    for (const o of OPERAND_OWNERS) assert(specText.includes(`\`${o}\``), `dono ausente do spec: ${o}`);
    for (const f of ['release-persist-stale-claim', 'release-persist-failed']) {
      assert(specText.includes(f), `note nova ausente do spec: ${f}`);
    }
    assert(!specText.includes('path_operands_INVENTED_CONTROL'), 'a busca não morde');
  });
}

// ── G9: direção 2 dos conjuntos fechados — depois de TUDO ter rodado ───────
console.log('\nG9: direção 2 — todo valor declarado foi emitido por >= 1 teste');
{
  test('G9a: toda decisão de GATE_DECISIONS foi emitida por >= 1 teste', () => {
    for (const d of GATE_DECISIONS) assert(decisionsSeen.has(d), `decisão declarada e nunca emitida: ${d}`);
  });
  test('G9b: toda causa de GATE_CAUSES foi emitida por >= 1 teste', () => {
    for (const c of GATE_CAUSES) assert(causesSeen.has(c), `causa declarada e nunca emitida: ${c}`);
  });
  test('G9c: toda razão de PROCEED_REASONS foi emitida por >= 1 teste', () => {
    for (const p of PROCEED_REASONS) assert(proceedReasonsSeen.has(p), `razão declarada e nunca emitida: ${p}`);
  });
  test('G9d: todo skip de GATE_SKIP_REASONS foi emitido por >= 1 teste', () => {
    for (const s of GATE_SKIP_REASONS) assert(skipsSeen.has(s), `skip declarado e nunca emitido: ${s}`);
  });
  test('G9e: toda note de GATE_NOTE_REASONS foi emitida por >= 1 teste', () => {
    for (const n of GATE_NOTE_REASONS) assert(notesSeen.has(n), `note declarada e nunca emitida: ${n}`);
  });
}

// ── G24 (S06/T03): the spec doc↔code conformance — D8's closed sets appear
// literally in shared/forge-claim-gate.md, and the search is PROVED to bite
// with a positive control (an invented member is NOT found).
console.log('\nG24: shared/forge-claim-gate.md documenta D8 literalmente (POSTURE_OVERRIDES/OVERRIDE_EFFECTS)');
{
  const specText = fs.readFileSync(SPEC_PATH, 'utf8');

  test('G24a: todo membro de POSTURE_OVERRIDES aparece literalmente no spec', () => {
    for (const m of POSTURE_OVERRIDES) {
      assert(specText.includes(m), `membro exportado ausente do spec: ${m}`);
    }
  });
  test('G24b: todo membro de OVERRIDE_EFFECTS aparece literalmente no spec', () => {
    for (const m of OVERRIDE_EFFECTS) {
      assert(specText.includes(m), `membro exportado ausente do spec: ${m}`);
    }
  });
  test('G24c: controle positivo — um membro INVENTADO não é encontrado (a busca morde)', () => {
    const invented = 'svn-unmet-worktree-INVENTED-CONTROL-XYZ';
    assert(!specText.includes(invented), 'o membro inventado apareceu no spec — a busca não morde');
  });
  test('G24d: o spec nomeia os três campos novos do evento claim-gate', () => {
    for (const field of ['posture_effective', 'posture_override', 'posture_override_effect']) {
      assert(specText.includes(field), `campo do evento ausente do spec: ${field}`);
    }
  });

  // ── G24e/f/g (S06/R2): o eixo que faltava — a FORMA do evento ─────────────
  //
  // G24a–d conferem que os MEMBROS dos conjuntos fechados aparecem no spec.
  // Isso passou verde ao lado de uma forma de evento que o código não produzia
  // (`posture_effective` documentado como `defer|block`, emitido como `null` em
  // todo proceed/refuse). Um assert de conformidade que escolhe o eixo mais
  // fácil de medir passa verde ao lado do eixo que importa — então aqui o eixo
  // é o evento EMITIDO, lido do disco.
  const TRES = ['posture_effective', 'posture_override', 'posture_override_effect'];
  function ultimoEvento(ws) {
    const linhas = fs.readFileSync(path.join(ws, '.gsd', 'forge', 'events.jsonl'), 'utf8').trim().split('\n');
    return JSON.parse(linhas[linhas.length - 1]);
  }

  test('G24e: o evento de um PROCEED carrega os três campos, e os três são null', () => {
    // Sem counterpart: nada foi confrontado, logo nenhuma postura foi resolvida.
    const ws = makeFixture([{ id: 'M-own', write_claim: claim(['scripts/x.js']) }]);
    const r = recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths: ['scripts/x.js'],
      readyAlternatives: 2, prefsOpts: prefsOpts(),
    });
    assertEqual(r.decision, 'proceed');
    const ev = ultimoEvento(ws);
    for (const k of TRES) {
      assert(Object.prototype.hasOwnProperty.call(ev, k), `chave ausente do evento de proceed: ${k}`);
      assertEqual(ev[k], null,
        `${k} num proceed precisa ser null — nenhuma colisão foi confrontada, nenhuma postura foi resolvida`);
    }
  });

  test('G24f: o evento de um REFUSE também carrega os três como null (postura nunca participa)', () => {
    const ws = makeFixture([
      { id: 'M-own', write_claim: claim([]) },
      { id: 'M-other', write_claim: claim(['scripts/x.js']) },
    ]);
    const r = recordAndEvaluate({
      cwd: ws, runId: 'M-own', unit: 'execute-task/T02', paths: [],
      readyAlternatives: 2, prefsOpts: prefsOpts(),
    });
    assertEqual(r.decision, 'refuse');
    const ev = ultimoEvento(ws);
    for (const k of TRES) {
      assert(Object.prototype.hasOwnProperty.call(ev, k), `chave ausente do evento de refuse: ${k}`);
      assertEqual(ev[k], null, `${k} num refuse precisa ser null`);
    }
  });

  test('G24g: e o spec DIZ isso — `defer|block|null` e a frase do null fora de colisão', () => {
    assert(specText.includes('"posture_effective":"defer|block|null"'),
      'o spec precisa declarar o `|null` que o código emite — os dois irmãos já o declaravam');
    assert(/`null` whenever no collision was confronted/.test(specText),
      'o spec precisa dizer, em prosa, que os três são null quando nada foi confrontado');
    assert(!/All three come straight from `resolvePosture`'s return — the event never\nre-derives them\./.test(specText),
      'a prosa antiga afirmava que os três vêm SEMPRE do retorno de resolvePosture — nesses desfechos ele nunca rodou');
    assert(/supplied by `emitGateEvent` itself/.test(specText),
      'e precisa dizer quem fabrica o null nesses desfechos');
  });
}

// --- Summary ---
cleanup();
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
