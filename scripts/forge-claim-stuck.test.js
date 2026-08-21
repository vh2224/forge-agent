#!/usr/bin/env node
'use strict';

// forge-claim-stuck.test.js — the census that makes issue #120's dead end legible never invents a
// measurement, never reports its own inactivity as good news, and never touches a byte.
//
// Properties this suite carries:
//
//   C1  the population is EXACTLY "active + claim + heartbeat past the threshold", crossed in BOTH
//       directions: the same record WITHOUT the claim leaves the population (the reaper can already
//       reach it), and the same record WITH a fresh heartbeat leaves it too.
//   C2  the counterfactual does work the direct call CANNOT: `classifyRunLiveness` on the very same
//       record answers `holds-claim` and never `expired`, so a census built on the direct verdict
//       would find nothing. Asserted side by side.
//   C3  ONE clock: the threshold is the reaper's, and its strictness is inherited — age exactly AT
//       the threshold is not stuck (mirrors the reaper's own L4).
//   C4  a RELEASED claim is reported as stuck with its own `claim_state` — the run is equally out
//       of the reaper's reach, but it has nothing left to protect, and collapsing the two would
//       erase the single fact the policy decision turns on.
//   C5  anti-silence floor: `runs_classified === 0` is `inconclusive`, NEVER `clean` — proved from
//       both directions it can arise (no registry at all; a registry where every record is
//       unparseable).
//   C6  anti-vacuity: `clean` is also proved over a NON-EMPTY registry with real records, so it is
//       an assertion about work performed rather than the zero case wearing a green hat.
//   C7  a claim holder whose heartbeat cannot be READ goes to its OWN bucket with the reaper's own
//       reason — never merged into `stuck` (a measurement nobody made) and never dropped.
//   C8  an unparseable record is COUNTED in `runs_examined` and ENUMERATED — it cannot vanish
//       before the count.
//   C9  closed sets crossed BOTH ways: nothing emitted falls outside `VERDICTS`/`SKIP_REASONS`/
//       `UNMEASURED_REASONS`, and every declared member is emitted by >= 1 test.
//   C10 READ-ONLY, proved behaviourally: every file under the workspace is byte-identical after a
//       full CLI run, and no new file appears. Not asserted in a comment — hashed.
//   C11 the CLI exits 0 ALWAYS, proved by SPAWN: with stuck runs, with a broken registry, and with
//       no registry at all.
//   C12 the rendering is emitted for ALL THREE verdicts, `clean` included — a section that only
//       shows up on bad news is indistinguishable from a detector that stopped running.
//   C13 the seam into `forge-doctor` holds: the check is reachable by name, is INCLUDED in
//       `--check all`, never flips the exit code, and renders under ITS OWN label. That last one is
//       a bite for a bug this work hit for real — the label chain used to END at the projection
//       label, so a check added without one rendered under another check's name.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-claim-stuck.js');
const { classifyRunLiveness, DEFAULT_THRESHOLD_MS } = require('./forge-run-reaper.js');
const {
  VERDICTS, SKIP_REASONS, UNMEASURED_REASONS,
  claimState, classifyStuck, findStuckClaims, formatStuck, USAGE,
} = require('./forge-claim-stuck.js');

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-claim-stuck-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const NOW = 1785763253000;

// Closed-set coverage ledger (C9, both directions).
const emittedVerdicts = new Set();
const emittedSkips = new Set();
const emittedUnmeasured = new Set();

function record(result) {
  emittedVerdicts.add(result.verdict);
  for (const s of result.census.skipped) emittedSkips.add(s.reason);
  for (const u of result.unmeasured) emittedUnmeasured.add(u.reason);
  return result;
}

/**
 * Registry fixture: `.gsd/forge/runs/<id>.json` under a synthetic workspace. Same shape as
 * forge-run-reaper.test.js's `makeFixture` — copied, not reinvented. Fully self-contained: nothing
 * here reads the operator's real prefs or real `.gsd/`.
 */
function makeFixture(specs) {
  const tmp = mktmp();
  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(path.join(wsDir, '.gsd', 'forge', 'runs'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');
  for (const spec of specs) {
    const file = path.join(wsDir, '.gsd', 'forge', 'runs', `${spec.id}.json`);
    if (spec.raw !== undefined) { fs.writeFileSync(file, spec.raw, 'utf8'); continue; }
    const base = {
      kind: 'milestone',
      id: spec.id,
      session_id: 'sess-fixture',
      active: spec.active === undefined ? true : spec.active,
      started_at: NOW - 7200000,
      last_heartbeat: spec.last_heartbeat === undefined ? NOW : spec.last_heartbeat,
      worker: null,
      isolation_mode: 'branch',
      milestone_dir: `.gsd/milestones/${spec.id}/`,
      cwd: wsDir,
      branch: `forge/${spec.id}`,
    };
    if (spec.write_claim !== undefined) base.write_claim = spec.write_claim;
    fs.writeFileSync(file, JSON.stringify(base, null, 2), 'utf8');
  }
  return wsDir;
}

/** A claim in the persisted shape (`forge-write-claim.js`). */
function claim(extra) {
  return Object.assign({
    at: NOW - 7200000,
    unit: 'execute-task/T01',
    source: 'plan',
    code_dir: '/tmp/code',
    paths: ['scripts/a.js', 'scripts/b.js'],
    released: null,
  }, extra || {});
}

const OLD = NOW - DEFAULT_THRESHOLD_MS - 60000; // comfortably past
const FRESH = NOW - 1000;
const OPTS = { now: NOW };

/** Every file under a directory, hashed, for the read-only proof (C10). */
function hashTree(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.set(path.relative(root, full), crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

// ── C1 + C2 — the population, and why the counterfactual is load-bearing ────
console.log('\nC1/C2 — população e contrafactual');

test('uma run ativa, com claim e heartbeat vencido é reportada como travada', () => {
  const ws = makeFixture([{ id: 'M-stuck', last_heartbeat: OLD, write_claim: claim() }]);
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.verdict, 'stuck', 'veredito');
  assertEqual(r.stuck.length, 1, 'quantidade travada');
  assertEqual(r.stuck[0].id, 'M-stuck', 'id');
  assert(r.stuck[0].age_ms > DEFAULT_THRESHOLD_MS, 'a idade medida tem de passar do limiar');
  assertEqual(r.stuck[0].claimed_paths, 2, 'paths reivindicados contados');
});

test('a MESMA run sem o claim sai da população — o reaper já a alcança', () => {
  const ws = makeFixture([{ id: 'M-stuck', last_heartbeat: OLD }]);
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.verdict, 'clean', 'sem claim não há nada travado aqui');
  assertEqual(r.stuck.length, 0, 'nenhuma travada');
  assertEqual(r.census.skipped[0].reason, 'no-claim', 'razão do skip');
  assertEqual(r.census.claim_holders, 0, 'não é claim holder');
});

test('a MESMA run com heartbeat fresco sai da população, mas conta como claim holder', () => {
  const ws = makeFixture([{ id: 'M-live', last_heartbeat: FRESH, write_claim: claim() }]);
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.verdict, 'clean', 'holder vivo não está travado');
  assertEqual(r.census.skipped[0].reason, 'heartbeat-fresh', 'razão do skip');
  assertEqual(r.census.claim_holders, 1, 'continua sendo parte da população examinada');
});

test('run inativa com claim é pulada por `run-inactive`, não por `no-claim`', () => {
  const ws = makeFixture([{ id: 'M-off', active: false, last_heartbeat: OLD, write_claim: claim() }]);
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.stuck.length, 0, 'inativa já está onde a desativação a colocaria');
  assertEqual(r.census.skipped[0].reason, 'run-inactive', 'a razão precisa dizer QUAL fato a excluiu');
});

test('o contrafactual faz trabalho que a chamada direta não faz', () => {
  // Esta é a razão de o módulo existir: `classifyRunLiveness` NUNCA diz `expired` para um holder,
  // então um censo montado sobre o veredito direto acharia zero — e reportaria `clean`.
  const rec = {
    id: 'M-x', active: true, last_heartbeat: OLD, write_claim: claim(),
  };
  const direct = classifyRunLiveness(rec, OPTS);
  assertEqual(direct.state, 'holds-claim', 'a chamada direta pára no claim');
  assert(direct.age_ms === undefined, 'a chamada direta nem calcula idade');

  const c = classifyStuck(rec, OPTS);
  assertEqual(c.kind, 'stuck', 'o contrafactual alcança o fato que a direta não alcança');
  assert(typeof c.age_ms === 'number' && c.age_ms > 0, 'e traz a idade medida');
});

// ── C3 — um relógio só, com a estritude herdada ────────────────────────────
console.log('\nC3 — o limiar é o do reaper');

test('idade EXATAMENTE no limiar não é travada (estritude herdada do reaper)', () => {
  const ws = makeFixture([{ id: 'M-edge', last_heartbeat: NOW - DEFAULT_THRESHOLD_MS, write_claim: claim() }]);
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.stuck.length, 0, 'no limiar exato o reaper diz `live`, e este censo tem de concordar');
  assertEqual(r.census.skipped[0].reason, 'heartbeat-fresh', 'razão');
});

test('um limiar customizado é honrado nos dois sentidos', () => {
  const ws = makeFixture([{ id: 'M-c', last_heartbeat: NOW - 5000, write_claim: claim() }]);
  assertEqual(findStuckClaims(ws, { now: NOW, thresholdMs: 10000 }).stuck.length, 0, 'limiar largo: nada travado');
  const tight = record(findStuckClaims(ws, { now: NOW, thresholdMs: 1000 }));
  assertEqual(tight.stuck.length, 1, 'limiar apertado: travada');
  assertEqual(tight.threshold_ms, 1000, 'o limiar usado é reportado, nunca implícito');
});

// ── C4 — claim liberado é um fato diferente de claim ativo ─────────────────
console.log('\nC4 — claim liberado × claim ativo');

test('somente claim ativo é travado; claim já liberado volta ao alcance do reaper', () => {
  const ws = makeFixture([
    { id: 'M-live-claim', last_heartbeat: OLD, write_claim: claim() },
    {
      id: 'M-released',
      last_heartbeat: OLD,
      write_claim: claim({ released: { at: NOW - 3600000, mechanism: 'committed', evidence: {} } }),
    },
  ]);
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.stuck.length, 1, 'somente posse efetiva fica fora do alcance do reaper');
  const byId = new Map(r.stuck.map((s) => [s.id, s]));
  assertEqual(byId.get('M-live-claim').claim_state, 'live', 'claim ativo');
  assert(byId.get('M-live-claim').release_mechanism === null, 'claim ativo não inventa mecanismo');
  const releasedSkip = r.census.skipped.find((s) => s.id === 'M-released');
  assertEqual(releasedSkip.reason, 'no-claim', 'envelope released não é holder stuck');
  assertEqual(r.census.claim_holders, 1, 'o censo conta apenas posse efetiva');
});

test('claim de forma inesperada lê como `live`, nunca como liberado', () => {
  // Direção deliberada: `released` é o estado que diz "nada a proteger". Adivinhá-lo a partir de
  // uma forma que não deu para ler subestimaria o risco da própria run que estamos reportando.
  assertEqual(claimState('não-é-objeto').state, 'live', 'claim não-objeto');
  assertEqual(claimState({ released: 'lixo' }).state, 'live', 'envelope ilegível');
  assertEqual(claimState({ released: { at: 'x', mechanism: 7 } }).state, 'live', 'envelope parcial permanece protegido');
  assertEqual(claimState({ released: { at: 'x', mechanism: 7 } }).released_at, null, 'campo ruim vira null, nunca um palpite');
});

// ── C5 + C6 — o piso, e a anti-vacuidade do `clean` ────────────────────────
console.log('\nC5/C6 — piso anti-silêncio e anti-vacuidade');

test('sem registry algum o veredito é `inconclusive`, jamais `clean`', () => {
  const tmp = mktmp();
  const ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.verdict, 'inconclusive', 'nada classificado não pode virar boa notícia');
  assertEqual(r.census.runs_classified, 0, 'e o censo diz exatamente isso');
});

test('registry onde TODO registro é ilegível também é `inconclusive`', () => {
  const ws = makeFixture([
    { id: 'M-bad1', raw: '{ isto não é json' },
    { id: 'M-bad2', raw: '' },
  ]);
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.verdict, 'inconclusive', 'universo não-vazio mas nada classificado');
  assertEqual(r.census.runs_examined, 2, 'os ilegíveis contam no examinado');
  assertEqual(r.census.runs_classified, 0, 'e nenhum foi classificado');
});

test('`clean` é provado sobre registry NÃO-VAZIO — trabalho feito, não o caso zero', () => {
  const ws = makeFixture([
    { id: 'M-a', last_heartbeat: FRESH },
    { id: 'M-b', last_heartbeat: OLD },
    { id: 'M-c', last_heartbeat: FRESH, write_claim: claim() },
  ]);
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.verdict, 'clean', 'confrontei três e nenhuma estava travada');
  assertEqual(r.census.runs_classified, 3, 'e classifiquei as três');
  assertEqual(r.census.skipped.length, 3, 'cada exclusão é enumerada, nunca silenciosa');
});

// ── C7 — holder que não pôde ser medido ────────────────────────────────────
console.log('\nC7 — holder sem heartbeat legível');

test('holder com heartbeat ausente vai para o balde próprio, com a razão do reaper', () => {
  const ws = makeFixture([{ id: 'M-nohb', last_heartbeat: null, write_claim: claim() }]);
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.stuck.length, 0, 'não pode entrar em stuck — ninguém mediu a idade');
  assertEqual(r.unmeasured.length, 1, 'e não pode sumir');
  assertEqual(r.unmeasured[0].reason, 'heartbeat-absent', 'razão vinda do vocabulário do reaper');
  assertEqual(r.census.claim_holders, 1, 'continua sendo parte da população');
});

test('holder com heartbeat não-numérico também, com a SUA razão', () => {
  const ws = makeFixture([{ id: 'M-nan', last_heartbeat: 'ontem', write_claim: claim() }]);
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.unmeasured[0].reason, 'heartbeat-not-a-number', 'ausente e ilegível não colapsam');
});

test('um holder não-medido NÃO faz o veredito virar `stuck`', () => {
  const ws = makeFixture([{ id: 'M-nohb', last_heartbeat: null, write_claim: claim() }]);
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.verdict, 'clean', 'nada foi medido como travado, então nada é afirmado como travado');
  assert(formatStuck(r).includes('M-nohb'), 'mas ele aparece na renderização — nunca engolido');
});

// ── C8 — o ilegível conta e é nomeado ──────────────────────────────────────
console.log('\nC8 — registro ilegível');

test('ilegível é contado em runs_examined E enumerado, ao lado de registros bons', () => {
  const ws = makeFixture([
    { id: 'M-ok', last_heartbeat: OLD, write_claim: claim() },
    { id: 'M-bad', raw: 'nope' },
  ]);
  const r = record(findStuckClaims(ws, OPTS));
  assertEqual(r.census.runs_examined, 2, 'examinado inclui o ilegível');
  assertEqual(r.census.runs_classified, 1, 'classificado, não');
  assertEqual(r.census.unparseable.length, 1, 'e ele é nomeado');
  assertEqual(r.census.unparseable[0].id, 'M-bad', 'pelo id');
  assertEqual(r.verdict, 'stuck', 'e não impede o veredito sobre o que foi lido');
  assert(formatStuck(r).includes('M-bad'), 'a renderização também o carrega');
});

// ── C10 — read-only, provado por hash ──────────────────────────────────────
console.log('\nC10 — read-only');

test('uma execução completa da CLI deixa cada byte do workspace idêntico', () => {
  // A CLI não aceita `--now`: ela mede contra o relógio real, de propósito. Então ESTE fixture é
  // ancorado em `Date.now()`, e não no `NOW` fixo que os testes em processo usam — senão o caso
  // "fresco" nasceria vencido e o teste mediria o próprio anacronismo em vez do caminho da CLI.
  const realNow = Date.now();
  const ws = makeFixture([
    { id: 'M-stuck', last_heartbeat: realNow - DEFAULT_THRESHOLD_MS - 60000, write_claim: claim() },
    { id: 'M-live', last_heartbeat: realNow, write_claim: claim() },
    { id: 'M-bad', raw: '{{{' },
  ]);
  const before = hashTree(ws);
  const res = spawnSync(process.execPath, [MODULE, '--cwd', ws, '--json'], { encoding: 'utf8' });
  assertEqual(res.status, 0, 'exit');
  const after = hashTree(ws);
  assertEqual(after.size, before.size, 'nenhum arquivo novo apareceu');
  for (const [rel, hash] of before) {
    assertEqual(after.get(rel), hash, `arquivo alterado: ${rel}`);
  }
  const parsed = JSON.parse(res.stdout);
  assertEqual(parsed.stuck.length, 1, 'e o censo saiu de fato — só a vencida');
  assertEqual(parsed.census.runs_classified, 2, 'as duas legíveis foram classificadas');
  assertEqual(parsed.census.unparseable.length, 1, 'e a ilegível foi nomeada');
});

// ── C11 — exit 0 sempre, por spawn ─────────────────────────────────────────
console.log('\nC11 — exit 0 sempre (spawn)');

test('exit 0 com runs travadas', () => {
  const ws = makeFixture([{ id: 'M-stuck', last_heartbeat: OLD, write_claim: claim() }]);
  const res = spawnSync(process.execPath, [MODULE, '--cwd', ws], { encoding: 'utf8' });
  assertEqual(res.status, 0, 'exit');
  assert(res.stdout.includes('M-stuck'), 'e nomeia a run');
});

test('exit 0 com registry quebrado', () => {
  const ws = makeFixture([{ id: 'M-bad', raw: 'x' }]);
  const res = spawnSync(process.execPath, [MODULE, '--cwd', ws], { encoding: 'utf8' });
  assertEqual(res.status, 0, 'exit');
});

test('exit 0 sem registry nenhum', () => {
  const tmp = mktmp();
  const res = spawnSync(process.execPath, [MODULE, '--cwd', tmp], { encoding: 'utf8' });
  assertEqual(res.status, 0, 'exit');
  assert(res.stdout.includes('inconclusivo'), 'e diz que foi inconclusivo, não que está limpo');
});

test('--help imprime o uso e sai 0', () => {
  const res = spawnSync(process.execPath, [MODULE, '--help'], { encoding: 'utf8' });
  assertEqual(res.status, 0, 'exit');
  assert(res.stdout.includes('READ-ONLY'), 'o uso declara a postura');
  assert(USAGE.includes('--threshold-ms'), 'e documenta o limiar');
});

// ── C12 — a renderização sai para os três vereditos ────────────────────────
console.log('\nC12 — renderização em todos os vereditos');

test('formatStuck emite texto para stuck, clean e inconclusive', () => {
  const stuck = findStuckClaims(makeFixture([{ id: 'M-s', last_heartbeat: OLD, write_claim: claim() }]), OPTS);
  const clean = findStuckClaims(makeFixture([{ id: 'M-c', last_heartbeat: FRESH }]), OPTS);
  const inconc = findStuckClaims(mktmp(), OPTS);
  for (const [name, r] of [['stuck', stuck], ['clean', clean], ['inconclusive', inconc]]) {
    const text = formatStuck(r);
    assert(typeof text === 'string' && text.trim().length > 0, `${name} tem de renderizar algo`);
  }
  assert(clean.verdict === 'clean' && formatStuck(clean).includes('0 runs travadas'),
    'o caso limpo diz explicitamente que rodou e não achou');
  assert(formatStuck(stuck).includes('/forge-pause'), 'o caso travado nomeia a saída que existe hoje');
});

// ── C9 — conjuntos fechados, nos dois sentidos ─────────────────────────────
console.log('\nC9 — conjuntos fechados');

test('nada emitido cai fora dos conjuntos declarados', () => {
  for (const v of emittedVerdicts) assert(VERDICTS.includes(v), `veredito fora do conjunto: ${v}`);
  for (const s of emittedSkips) assert(SKIP_REASONS.includes(s), `skip fora do conjunto: ${s}`);
  for (const u of emittedUnmeasured) assert(UNMEASURED_REASONS.includes(u), `unmeasured fora do conjunto: ${u}`);
});

test('todo membro declarado é emitido por >= 1 teste (exceto o inalcançável, nomeado)', () => {
  for (const v of VERDICTS) assert(emittedVerdicts.has(v), `veredito declarado e nunca emitido: ${v}`);
  for (const u of UNMEASURED_REASONS) assert(emittedUnmeasured.has(u), `razão declarada e nunca emitida: ${u}`);
  // `record-absent` vem de `classifyRunLiveness(null)`. `listAllDetailed` nunca entrega null — um
  // registro que não parseia vai para `unparseable`, não para `parsed`. A razão existe porque
  // `classifyStuck` é chamável direto, e é aí que ela é exercitada.
  assertEqual(classifyStuck(null, OPTS).reason, 'record-absent', 'a razão inalcançável pelo sweep é exercitada pela função');
  for (const s of SKIP_REASONS) {
    if (s === 'record-absent') continue;
    assert(emittedSkips.has(s), `skip declarado e nunca emitido: ${s}`);
  }
});

// ── C13 — a fiação no forge-doctor ─────────────────────────────────────────
console.log('\nC13 — fiação no forge-doctor');

const DOCTOR = path.join(__dirname, 'forge-doctor.js');
const { VALID_CHECKS, checkClaimStuck } = require('./forge-doctor.js');

test('o check está declarado em VALID_CHECKS', () => {
  assert(VALID_CHECKS.includes('claim-stuck'), 'sem isso `--check all` nunca o alcança');
});

test('sem registry o check devolve ok:true e diz que pulou, sem inventar `clean`', () => {
  const tmp = mktmp();
  const r = checkClaimStuck(tmp);
  assertEqual(r.ok, true, 'advisory');
  assertEqual(r.verdict, 'inconclusive', 'ausência de registry não é limpeza');
  assertEqual(r.skipped, 'no-runs-registry', 'e o motivo é nomeado');
});

test('`--check claim-stuck` nomeia a run travada e sai 0', () => {
  const realNow = Date.now();
  const ws = makeFixture([{ id: 'M-doc', last_heartbeat: realNow - DEFAULT_THRESHOLD_MS - 60000, write_claim: claim() }]);
  const res = spawnSync(process.execPath, [DOCTOR, '--check', 'claim-stuck', '--cwd', ws], { encoding: 'utf8' });
  assertEqual(res.status, 0, 'exit 0 mesmo com run travada — advisory');
  assert(res.stdout.includes('M-doc'), 'a run é nomeada');
});

test('`--check all` inclui o achado e NÃO muda o exit code por causa dele', () => {
  // Asserir `exit 0` num fixture cru mediria outro check: `schema` reprova sem .gsd/SCHEMA-VERSION,
  // e o exit 1 viria de lá. A propriedade que importa é a CONTRIBUIÇÃO deste check — então o mesmo
  // workspace é medido com e sem a run travada, e os dois exit codes têm de ser iguais.
  const realNow = Date.now();
  const stuckWs = makeFixture([{ id: 'M-doc', last_heartbeat: realNow - DEFAULT_THRESHOLD_MS - 60000, write_claim: claim() }]);
  const calmWs = makeFixture([{ id: 'M-doc', last_heartbeat: realNow, write_claim: claim() }]);

  const withStuck = spawnSync(process.execPath, [DOCTOR, '--check', 'all', '--cwd', stuckWs], { encoding: 'utf8' });
  const without = spawnSync(process.execPath, [DOCTOR, '--check', 'all', '--cwd', calmWs], { encoding: 'utf8' });

  assertEqual(withStuck.status, without.status, 'uma run travada não pode mudar o veredito do doctor');
  assert(withStuck.stdout.includes('M-doc'), '`--check all` carrega o achado');
  assert(withStuck.stdout.includes('reaper'), 'sob o rótulo deste check');
});

test('renderiza sob o PRÓPRIO rótulo, nunca sob o de outro check', () => {
  // Bite: a cadeia de rótulos terminava em `Layer 3 — Projection versioned` como default, então
  // este check nasceu exibindo o nome de outro. Um diagnóstico que mente sobre o que mediu é
  // exatamente a falha que este arquivo existe para pegar em outro lugar.
  //
  // O assert mira a LINHA DO RÓTULO (a que carrega o ícone), não o stdout inteiro: a mensagem do
  // censo também contém a palavra "reaper", então procurar no stdout passaria mesmo sem rótulo
  // nenhum — medido, não suposto.
  const realNow = Date.now();
  const ws = makeFixture([{ id: 'M-doc', last_heartbeat: realNow - DEFAULT_THRESHOLD_MS - 60000, write_claim: claim() }]);
  const res = spawnSync(process.execPath, [DOCTOR, '--check', 'claim-stuck', '--cwd', ws], { encoding: 'utf8' });
  const labelLine = res.stdout.split('\n').find((l) => /^\s*[⚠✓✗]\s/.test(l)) || '';
  assert(labelLine.includes('reaper'), `o rótulo tem de dizer o que ESTE check mede: ${JSON.stringify(labelLine)}`);
  assert(!labelLine.includes('Projection versioned'), 'e não pode herdar o rótulo do check vizinho');
  assert(!labelLine.trim().endsWith('claim-stuck'), 'nem cair no nome cru do check por falta de rótulo');
});

test('um veredito diferente de `clean` renderiza ⚠, não ✓', () => {
  const realNow = Date.now();
  const ws = makeFixture([{ id: 'M-doc', last_heartbeat: realNow - DEFAULT_THRESHOLD_MS - 60000, write_claim: claim() }]);
  const res = spawnSync(process.execPath, [DOCTOR, '--check', 'claim-stuck', '--cwd', ws], { encoding: 'utf8' });
  const line = res.stdout.split('\n').find((l) => l.includes('reaper')) || '';
  assert(line.includes('⚠'), `inconclusive/stuck não pode exibir ✓ ao lado de um limpo medido: ${line}`);
});

// ── Suite close ─────────────────────────────────────────────────────────────
cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
