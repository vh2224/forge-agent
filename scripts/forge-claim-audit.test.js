#!/usr/bin/env node
'use strict';

// forge-claim-audit.test.js — the cross-run detector never reports its own
// inactivity as good news, never discards a remainder silently, and derives
// the WRITTEN side from the VCS rather than from a per-tool activity log.
//
// One block per truth of T01-PLAN.md § must_haves.truths:
//
//   A  the floor is STRUCTURAL: `pairs_compared === 0` yields `inconclusive`
//      BEFORE any other branch — forced over a NON-EMPTY universe whose pairs
//      are ALL skipped, so no comparison happens and `clean` is still
//      unreachable. Proved by an EXECUTED bite.
//   B  every `skipped[]` row carries a reason from the closed exported set,
//      and a value from outside it THROWS at the seam — both directions.
//   C  the census RECONCILES by arithmetic equality, and a claim source that
//      contributed ZERO is present and NAMED with `contributed: 0`.
//   D  source guard: the module never reads the per-tool activity log as the
//      source of what was written (D6) and never references the intra-slice
//      predicate (D1) — scanned with comments stripped, WITH a positive
//      control and a negative control.
//   E  the two claim sources are distinct and named; a finding reachable ONLY
//      through the history (claim already released, registry empty) is still
//      found.
//   F  `code-dir-unknown` is PROPAGATED to the pair, never dropped and never
//      converted into a skip, and it does not alter the verdict.
//   G  `auditClaims` writes NOTHING: sha256 of every run record, of
//      `events.jsonl` and of the target SUMMARY identical before and after.
//   H  a collector that THROWS becomes a named skip and the report still
//      exists — an exception is never silence and never a crash.
//   I  the CLI exits 0 ALWAYS — proved by SPAWN, including with a planted
//      overlap.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-claim-audit.js');
const mod = require('./forge-claim-audit.js');
const {
  compareClaimAudit, auditClaims, collectClaims, recordSkip, recordNote,
  formatClaimAudit, VERDICTS, CLAIM_SOURCES, AUDIT_SKIP_REASONS, AUDIT_NOTE_REASONS,
} = mod;

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

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}\n     expected: ${expected}\n     actual:   ${actual}`);
  }
}

function throws(fn, needle, msg) {
  let threw = null;
  try { fn(); } catch (e) { threw = e; }
  assert(threw !== null, msg || 'expected a throw, got none');
  assert(String(threw.message).includes(needle),
    `${msg || 'wrong throw'} — expected message to include "${needle}", got: ${threw.message}`);
}

// Strip line and block comments, so a guard that scans source is not fooled by
// the very words the header must be free to explain.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

const tmpRoots = [];
function mktmp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-claim-audit-${label}-`));
  tmpRoots.push(dir);
  return dir;
}
function cleanup() {
  for (const d of tmpRoots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ── Builders for the PURE core (no disk needed — that is the point) ────────
const ABS_A = mktmp('physical-alpha');
const ABS_B = mktmp('physical-beta');

function writtenUnit(unit, files) {
  return { unit, owner: 'M-x', slice: 'S07', task: 'T01', files };
}

function claimRow(run, paths, extra) {
  return Object.assign({
    run,
    source: 'run-registry',
    paths,
    claim: { paths, code_dir: ABS_A },
    scope_source: 'code-dir',
    scope: null,
    note: null,
  }, extra || {});
}

function input(over) {
  return Object.assign({
    milestone: 'M-x',
    slice: 'S07',
    code_dir: ABS_A,
    written: { units: [], skipped: [] },
    declared: { byUnit: new Map(), notes: [] },
    claims: { claims: [], sources: [], skipped: [], notes: [] },
  }, over || {});
}

function sources(registry, gate) {
  return [
    { source: 'run-registry', consulted: true, contributed: registry },
    { source: 'gate-events', consulted: true, contributed: gate },
  ];
}

console.log('\n=== forge-claim-audit.test.js ===\n');

// ── Bloco A — o piso é ESTRUTURAL ──────────────────────────────────────────
//
// `clean` é uma alegação sobre TRABALHO FEITO. Um comparador que a emite sem
// ter confrontado nada relata a própria inatividade como boa notícia, e esse
// relatório é indistinguível de um detector quebrado. O caso decisivo NÃO é o
// universo vazio (trivial): é o universo NÃO-VAZIO cujos pares são TODOS
// pulados — nenhuma comparação acontece e `clean` ainda assim é inalcançável.
console.log('\nBloco A: piso inconclusive antes de todo ramo (truth 1)');

test('universo NÃO-VAZIO com TODOS os pares pulados (different-code-dir) → inconclusive, NUNCA clean', () => {
  const r = compareClaimAudit(input({
    written: { units: [writtenUnit('M-x::S07/T01', ['scripts/a.js'])], skipped: [] },
    claims: {
      claims: [claimRow('RUN-B', ['scripts/a.js'], { claim: { paths: ['scripts/a.js'], code_dir: ABS_B } })],
      sources: sources(1, 0), skipped: [], notes: [],
    },
  }));
  assert(r.census.units_compared > 0, 'o universo tem de ser não-vazio para o caso valer');
  assert(r.census.claims_considered > 0, 'o universo tem de ter claim para o caso valer');
  eq(r.census.pairs_compared, 0, 'nenhum par pode ter sido confrontado');
  eq(r.verdict, 'inconclusive', 'zero pares confrontados NÃO é clean');
  assert(r.verdict !== 'clean', 'clean é inalcançável sem comparação');
});

test('o piso precede o ramo overlap: mesmo com achados possíveis, zero pares → inconclusive', () => {
  // Sem claims não há par; a unidade escreveu e ainda assim o veredicto não
  // pode ser `clean`.
  const r = compareClaimAudit(input({
    written: { units: [writtenUnit('M-x::S07/T01', ['scripts/a.js'])], skipped: [] },
    claims: { claims: [], sources: sources(0, 0), skipped: [], notes: [] },
  }));
  eq(r.verdict, 'inconclusive');
  assert(r.reason.includes('0 par'), `a razão deve nomear zero pares, veio: ${r.reason}`);
});

test('com par confrontado e sem colisão → clean (o piso não engole o caminho feliz)', () => {
  const r = compareClaimAudit(input({
    written: { units: [writtenUnit('M-x::S07/T01', ['scripts/a.js'])], skipped: [] },
    claims: { claims: [claimRow('RUN-B', ['scripts/zz.js'])], sources: sources(1, 0), skipped: [], notes: [] },
  }));
  eq(r.census.pairs_compared, 1);
  eq(r.verdict, 'clean');
});

test('com par confrontado e colisão → overlap, nomeando arquivo e contraparte', () => {
  const r = compareClaimAudit(input({
    written: { units: [writtenUnit('M-x::S07/T01', ['scripts/a.js'])], skipped: [] },
    claims: { claims: [claimRow('RUN-B', ['scripts/a.js'])], sources: sources(1, 0), skipped: [], notes: [] },
  }));
  eq(r.verdict, 'overlap');
  eq(r.findings.length, 1);
  eq(r.findings[0].counterpart_run, 'RUN-B');
  assert(r.findings[0].paths.includes('scripts/a.js'), 'o achado deve nomear o arquivo em disputa');
});

test('VERDICTS é fechado e todo veredicto produzido pertence a ele (duas direções)', () => {
  eq(VERDICTS.join(','), 'overlap,clean,inconclusive');
  const seen = new Set();
  seen.add(compareClaimAudit(input()).verdict);
  seen.add(compareClaimAudit(input({
    written: { units: [writtenUnit('u', ['a.js'])], skipped: [] },
    claims: { claims: [claimRow('R', ['zz.js'])], sources: sources(1, 0), skipped: [], notes: [] },
  })).verdict);
  seen.add(compareClaimAudit(input({
    written: { units: [writtenUnit('u', ['a.js'])], skipped: [] },
    claims: { claims: [claimRow('R', ['a.js'])], sources: sources(1, 0), skipped: [], notes: [] },
  })).verdict);
  for (const v of seen) assert(VERDICTS.includes(v), `veredicto fora do conjunto: ${v}`);
  eq(seen.size, 3, 'os três veredictos devem ser alcançáveis por teste');
});

// ── Bloco B — razões nomeadas, seam que LANÇA ──────────────────────────────
console.log('\nBloco B: razões de skip em conjunto fechado, com seam (truth 2)');

test('razão do conjunto passa; razão inventada LANÇA no seam (as duas direções)', () => {
  const s = [];
  recordSkip(s, 'unit', 'u1', 'no-written-files', 'ok');
  eq(s.length, 1, 'uma razão válida deve ser aceita');
  throws(() => recordSkip(s, 'unit', 'u2', 'razao-inventada'),
    'fora de AUDIT_SKIP_REASONS', 'uma razão inventada deve lançar, nunca virar string sem rótulo');
});

test('kind inventado LANÇA — o censo reconcilia por kind, então um kind errado não pode passar', () => {
  throws(() => recordSkip([], 'kind-inventado', 'x', 'no-written-files'),
    'fora de AUDIT_SKIP_KINDS');
});

test('nota inventada LANÇA no mesmo molde', () => {
  throws(() => recordNote([], 'x', 'nota-inventada'), 'fora de AUDIT_NOTE_REASONS');
});

test('toda linha de skipped[] produzida pelo módulo carrega razão do conjunto fechado', () => {
  const r = compareClaimAudit(input({
    written: { units: [writtenUnit('u-vazia', []), writtenUnit('u', ['a.js'])], skipped: [] },
    claims: {
      claims: [claimRow('RUN-B', ['a.js'], { claim: { paths: ['a.js'], code_dir: ABS_B } })],
      sources: sources(1, 0), skipped: [], notes: [],
    },
  }));
  assert(r.skipped.length >= 2, 'o caso deve produzir skips');
  for (const s of r.skipped) {
    assert(AUDIT_SKIP_REASONS.includes(s.reason), `razão fora do conjunto: ${s.reason}`);
  }
  assert(r.skipped.some((s) => s.reason === 'no-written-files'), 'unidade sem escrita vira skip nomeado');
  assert(r.skipped.some((s) => s.reason === 'different-code-dir'), 'par fora do CODE_DIR vira skip nomeado');
});

test('toda nota produzida pertence ao conjunto fechado de notas', () => {
  const r = compareClaimAudit(input({
    written: { units: [writtenUnit('u', ['a.js'])], skipped: [] },
    claims: {
      claims: [claimRow('RUN-B', ['a.js'], { claim: { paths: ['a.js'], code_dir: null } })],
      sources: sources(1, 0), skipped: [], notes: [],
    },
  }));
  assert(r.notes.length > 0, 'o caso deve produzir nota');
  for (const n of r.notes) assert(AUDIT_NOTE_REASONS.includes(n.reason), `nota fora do conjunto: ${n.reason}`);
});

// ── Bloco C — o censo RECONCILIA por igualdade aritmética ──────────────────
console.log('\nBloco C: censo reconcilia e fonte que contribuiu zero é NOMEADA (truth 3)');

test('units_examined === units_compared + Σ skipped(kind=unit)', () => {
  const r = compareClaimAudit(input({
    written: {
      units: [writtenUnit('u1', ['a.js']), writtenUnit('u2', []), writtenUnit('u3', ['b.js'])],
      skipped: [{ kind: 'unit', id: 'u4', reason: 'delta-unavailable', detail: 'no-attributed-commits' }],
    },
    claims: { claims: [claimRow('RUN-B', ['zz.js'])], sources: sources(1, 0), skipped: [], notes: [] },
  }));
  const unitSkips = r.skipped.filter((s) => s.kind === 'unit').length;
  eq(r.census.units_examined, r.census.units_compared + unitSkips,
    'a conta de unidades tem de fechar por igualdade');
  eq(r.census.units_compared, 2);
  eq(unitSkips, 2, 'uma sem escrita + uma sem delta');
});

// R3 — a reconciliação alimentada pelo RESULTADO REAL de `collectClaims` sob
// falha, nunca por um `sources` montado à mão. A versão anterior deste teste
// passava só porque o fixture fornecia DUAS linhas `consulted:true` mais um skip
// manual SEM a linha `consulted:false` irmã — uma forma que a produção NUNCA
// emite: no `catch`, `collectClaims` empurra as duas coisas. Com a forma de
// produção, a igualdade que o teste alegava provar QUEBRAVA (2 fontes, 1
// falhando → examinadas 3, contribuindo 1 + skips 1 = 2).
test('censo de fontes fecha sobre o resultado REAL de collectClaims com uma fonte falhando', () => {
  const cwd = mkWorkspace('census-real');
  writeRun(cwd, { id: 'M-x', kind: 'milestone', active: true, milestone_dir: '.gsd/milestones/M-x/', write_claim: null });
  writeRun(cwd, { id: 'RUN-B', kind: 'milestone', active: true, write_claim: { paths: ['a.js'], code_dir: ABS_A } });
  // Falha REAL dentro do try de `gate-events`: a fonte lança ao ser percorrida,
  // exatamente como um log ilegível — e o resultado consumido abaixo é o que a
  // produção produz, não um fixture.
  const collected = collectClaims(cwd, {
    milestone: 'M-x', run: 'M-x', codeDir: ABS_A,
    scopeRunIds: new Set(['M-x']),
    events: { [Symbol.iterator]() { throw new Error('log ilegível'); } },
  });
  eq(collected.sources.length, 2, 'as duas fontes têm de aparecer, inclusive a que falhou');
  const gate = collected.sources.find((s) => s.source === 'gate-events');
  eq(gate.consulted, false, 'a fonte que falhou é a MESMA linha, com consulted:false');
  eq(collected.skipped.filter((s) => s.kind === 'claim-source').length, 1, 'e o skip nomeado existe');

  const r = compareClaimAudit(input({
    written: { units: [writtenUnit('u1', ['a.js'])], skipped: [] },
    claims: collected,
  }));
  const srcSkips = r.skipped.filter((s) => s.kind === 'claim-source').length;
  eq(r.census.claim_sources_examined, 2, 'existem DUAS fontes; contar a falha em dobro é inflar o censo');
  eq(r.census.claim_sources_examined, r.census.claim_sources_contributing + srcSkips,
    'a conta de fontes tem de fechar por igualdade NA FORMA DE PRODUÇÃO');
});

test('uma fonte que contribuiu ZERO aparece NOMEADA com contributed: 0, nunca ausente', () => {
  const r = compareClaimAudit(input({
    written: { units: [writtenUnit('u1', ['a.js'])], skipped: [] },
    claims: { claims: [claimRow('RUN-B', ['a.js'])], sources: sources(1, 0), skipped: [], notes: [] },
  }));
  const gate = r.claim_sources.find((s) => s.source === 'gate-events');
  assert(gate, 'a fonte gate-events tem de aparecer mesmo contribuindo zero');
  eq(gate.contributed, 0);
  eq(r.census.claim_sources_examined, 2, 'as DUAS fontes foram examinadas');
  eq(r.census.claim_sources_contributing, 1, 'só uma contribuiu');
  assert(formatClaimAudit(r).includes('gate-events: contribuiu 0'),
    'a forma legível também tem de nomear a fonte silenciosa');
});

test('CLAIM_SOURCES é fechado e as duas fontes nomeadas pertencem a ele', () => {
  eq(CLAIM_SOURCES.join(','), 'run-registry,gate-events');
});

// ── Bloco D — guard de fonte (D6 e D1), com controle positivo e negativo ───
//
// Sem o controle positivo o guard pode estar CEGO à própria palavra-alvo —
// precedente medido neste repo (Layer 3 do forge-doctor).
console.log('\nBloco D: guard de fonte com comentários removidos + controles (truths 4 e 5)');

const realSource = fs.readFileSync(MODULE, 'utf8');

function guardPasses(src, needle) {
  return !stripComments(src).includes(needle);
}

test('D6: o módulo NÃO lê o log de atividade por-tool como fonte do escrito', () => {
  assert(guardPasses(realSource, 'evidence-'),
    'o lado escrito vem do delta de VCS; ler o log por-tool foi refutado por medição (D6)');
});

test('controle positivo (D6): cópia sintética com a leitura injetada é REPROVADA pelo mesmo predicado', () => {
  const injected = `${realSource}\nconst x = readEvidence('evidence-T01.jsonl');\n`;
  assert(!guardPasses(injected, 'evidence-'), 'o guard não mordeu a injeção — controle positivo falhou');
});

test('D1: o módulo NÃO referencia a predicado intra-slice (polaridade proibida cross-run)', () => {
  assert(guardPasses(realSource, 'writesConflict'),
    'a álgebra reusada é a de S03 via claimsConflict; a predicado intra-slice é proibida cross-run (D1)');
});

test('controle positivo (D1): cópia com a chamada injetada é REPROVADA', () => {
  const injected = `${realSource}\nconst y = writesConflict(a, b);\n`;
  assert(!guardPasses(injected, 'writesConflict'), 'o guard não mordeu a injeção — controle positivo falhou');
});

test('controle negativo: a palavra dentro de um COMENTÁRIO não falso-positiva (comentário é removido antes)', () => {
  const commented = `${realSource}\n// writesConflict e evidence- citados só em prosa\n`;
  assert(guardPasses(commented, 'writesConflict'), 'comentário não pode reprovar o guard');
  assert(guardPasses(commented, 'evidence-'), 'comentário não pode reprovar o guard');
});

// PISO ANTI-CEGUEIRA do próprio scanner: um `slash-star` dentro de um
// comentário de linha abre um bloco fantasma e `stripComments` engole o resto
// do arquivo — medido nesta task (14k de 27k caracteres sumiram, os requires
// junto). Um guard que varre um texto vazio passa VERDE sobre o defeito que
// existe para pegar. Este assert exige que o texto varrido ainda contenha o
// código real, então os guards D6/D1 acima só valem quando de fato leram algo.
test('o módulo importa de fato os três colaboradores exigidos pelos key_links (piso anti-cegueira do scanner)', () => {
  const code = stripComments(realSource);
  assert(code.length > realSource.length / 4,
    `stripComments engoliu o arquivo (${code.length} de ${realSource.length}) — o guard estaria cego`);
  for (const dep of ['./forge-unit-delta.js', './forge-claim-overlap.js', './forge-write-coverage.js']) {
    assert(code.includes(dep), `key_link ausente: require de ${dep}`);
  }
  for (const fn of ['writtenByUnit', 'declaredFor', 'collectRunClaims', 'claimsConflict', 'codeDirScope']) {
    assert(code.includes(fn), `key_link ausente: chamada de ${fn}`);
  }
});

test('fronteira travada: o módulo não ordena runs, não bloqueia merge, não persiste fila', () => {
  const code = stripComments(realSource);
  for (const needle of ['mergeOrder', 'blockMerge', 'persistQueue', 'writeQueue']) {
    assert(!code.includes(needle), `fronteira atravessada: ${needle} apareceu no código`);
  }
});

// ── Bloco E — as DUAS fontes, e o achado que só o histórico alcança ────────
console.log('\nBloco E: duas fontes nomeadas; claim liberado ainda é achado pelo histórico (truth 6)');

function mkWorkspace(label) {
  const cwd = mktmp(label);
  fs.mkdirSync(path.join(cwd, '.gsd', 'forge', 'runs'), { recursive: true });
  return cwd;
}

function writeRun(cwd, rec) {
  fs.writeFileSync(path.join(cwd, '.gsd', 'forge', 'runs', `${rec.id}.json`), JSON.stringify(rec, null, 2));
}

function writeEvents(cwd, lines) {
  fs.writeFileSync(path.join(cwd, '.gsd', 'forge', 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

test('achado alcançável SÓ pelo histórico: registry sem claim da contraparte, gate-events ainda encontra', () => {
  const cwd = mkWorkspace('history');
  // A run desta milestone existe no registry, e o claim dela JÁ FOI LIBERADO
  // (D2/S05) — o registry, sozinho, não tem nada da contraparte RUN-B.
  writeRun(cwd, { id: 'M-x', kind: 'milestone', active: true, milestone_dir: '.gsd/milestones/M-x/', write_claim: null });
  writeEvents(cwd, [
    { event: 'claim-gate', run: 'M-x', unit: 'execute-task/T01', decision: 'defer',
      counterparts: [{ id: 'RUN-B', cause: 'overlap', paths: ['scripts/alvo.js'], scope: 'same', note: null }] },
  ]);

  const collected = collectClaims(cwd, { milestone: 'M-x', slice: 'S07', run: 'M-x', codeDir: ABS_A });
  const registry = collected.sources.find((s) => s.source === 'run-registry');
  const gate = collected.sources.find((s) => s.source === 'gate-events');
  eq(registry.contributed, 0, 'o registry não pode contribuir — o claim já foi liberado');
  eq(gate.contributed, 1, 'o histórico tem de contribuir o claim liberado');

  const r = compareClaimAudit(input({
    written: { units: [writtenUnit('M-x::S07/T01', ['scripts/alvo.js'])], skipped: [] },
    claims: collected,
  }));
  eq(r.verdict, 'overlap', 'o achado alcançável só pelo histórico ainda tem de ser encontrado');
  eq(r.findings[0].claim_source, 'gate-events', 'a fonte do achado tem de ser nomeada');
  eq(r.findings[0].counterpart_run, 'RUN-B');
});

test('a própria run é excluída por skip NOMEADO (same-run), nunca confrontada consigo mesma', () => {
  const cwd = mkWorkspace('selfrun');
  writeRun(cwd, { id: 'M-x', kind: 'milestone', active: true, write_claim: { paths: ['scripts/a.js'], code_dir: ABS_A } });
  const collected = collectClaims(cwd, { milestone: 'M-x', run: 'M-x', codeDir: ABS_A });
  eq(collected.claims.length, 0, 'nenhum claim da própria run entra na comparação');
  assert(collected.skipped.some((s) => s.reason === 'same-run'), 'a exclusão tem de ser um skip nomeado');
});

// R1 — escopo imedível NÃO é permissão máxima.
test('registry sem nenhuma run desta milestone: gate-events contribui ZERO com razão nomeada (scope-unresolved)', () => {
  const cwd = mkWorkspace('scope-unresolved');
  // Uma linha histórica de OUTRA run, de outra milestone. Sem ponte
  // run→milestone (o registry não conhece M-x), a pertinência dela é imedível.
  writeEvents(cwd, [
    { event: 'claim-gate', run: 'RUN-ALHEIA', unit: 'execute-task/T09', decision: 'defer',
      counterparts: [{ id: 'RUN-B', cause: 'overlap', paths: ['scripts/alvo.js'], scope: 'same', note: null }] },
  ]);
  const collected = collectClaims(cwd, { milestone: 'M-x', slice: 'S07', run: 'M-x', codeDir: ABS_A });
  const gate = collected.sources.find((s) => s.source === 'gate-events');
  eq(gate.contributed, 0, 'escopo imedível não pode admitir TODO o histórico do workspace');
  eq(gate.consulted, false);
  const skip = collected.skipped.find((s) => s.reason === 'scope-unresolved');
  assert(skip, 'a impossibilidade tem de virar razão NOMEADA do conjunto fechado');
  eq(skip.kind, 'claim-source');
  eq(collected.claims.length, 0, 'nenhum claim fabricado a partir de linha de pertinência imedível');

  const r = compareClaimAudit(input({
    written: { units: [writtenUnit('M-x::S07/T01', ['scripts/alvo.js'])], skipped: [] },
    claims: collected,
  }));
  eq(r.verdict, 'inconclusive', 'sem escopo medível o resultado caminha para inconclusive, nunca para achado');
  eq(r.findings.length, 0, 'nenhum achado fabricado — e portanto nenhum work-lost falso em disco');
});

test('controle positivo de R1: COM a ponte run→milestone no registry, a mesma linha histórica É admitida', () => {
  const cwd = mkWorkspace('scope-resolved');
  writeRun(cwd, { id: 'M-x', kind: 'milestone', active: true, milestone_dir: '.gsd/milestones/M-x/', write_claim: null });
  writeEvents(cwd, [
    { event: 'claim-gate', run: 'M-x', unit: 'execute-task/T01', decision: 'defer',
      counterparts: [{ id: 'RUN-B', cause: 'overlap', paths: ['scripts/alvo.js'], scope: 'same', note: null }] },
  ]);
  const collected = collectClaims(cwd, { milestone: 'M-x', slice: 'S07', run: 'M-x', codeDir: ABS_A });
  eq(collected.sources.find((s) => s.source === 'gate-events').contributed, 1,
    'o guard de R1 não pode cegar o caminho medível — controle positivo');
  assert(!collected.skipped.some((s) => s.reason === 'scope-unresolved'), 'com escopo medido não há razão a registrar');
});

// R2 — o schema NÃO preserva de quem é o operando do rótulo composto.
test('rótulo COMPOSTO em linha histórica: operandos NÃO viram claim da contraparte; nota nomeada, e nada em silêncio', () => {
  const cwd = mkWorkspace('composite');
  writeRun(cwd, { id: 'M-x', kind: 'milestone', active: true, milestone_dir: '.gsd/milestones/M-x/', write_claim: null });
  writeEvents(cwd, [
    { event: 'claim-gate', run: 'M-x', unit: 'execute-task/T01', decision: 'defer',
      counterparts: [{ id: 'RUN-B', cause: 'overlap', paths: ['src/meu.js × outro/dele.js'], scope: 'same', note: null }] },
  ]);
  const collected = collectClaims(cwd, { milestone: 'M-x', slice: 'S07', run: 'M-x', codeDir: ABS_A });
  eq(collected.claims.length, 0, 'nenhum operando de rótulo composto pode virar caminho claimado pela contraparte');
  assert(collected.notes.some((n) => n.reason === 'composite-label-ownership' && n.id === 'RUN-B'),
    'a incerteza tem de ser CARREGADA com nota nomeada');
  const skip = collected.skipped.find((s) => s.reason === 'no-attributable-paths');
  assert(skip, 'a linha sem caminho atribuível sai da comparação NOMEADA, nunca por continue mudo');

  // E o dano concreto que isso evita: `src/meu.js` é escrito por ESTA slice.
  const r = compareClaimAudit(input({
    written: { units: [writtenUnit('M-x::S07/T01', ['src/meu.js'])], skipped: [] },
    claims: collected,
  }));
  eq(r.findings.length, 0, 'atribuir o operando fabricaria overlap contra o arquivo da própria run');
});

test('rótulo NÃO-composto (a === b) segue atribuível — foi claimado pelos dois lados', () => {
  const cwd = mkWorkspace('non-composite');
  writeRun(cwd, { id: 'M-x', kind: 'milestone', active: true, milestone_dir: '.gsd/milestones/M-x/', write_claim: null });
  writeEvents(cwd, [
    { event: 'claim-gate', run: 'M-x', unit: 'execute-task/T01', decision: 'defer',
      counterparts: [{ id: 'RUN-B', cause: 'overlap', paths: ['scripts/alvo.js × scripts/alvo.js'], scope: 'same', note: null }] },
  ]);
  const collected = collectClaims(cwd, { milestone: 'M-x', slice: 'S07', run: 'M-x', codeDir: ABS_A });
  eq(collected.claims.length, 1, 'operandos idênticos nomeiam UM arquivo real dos dois lados');
  eq(collected.claims[0].paths.join(','), 'scripts/alvo.js');
  assert(!collected.notes.some((n) => n.reason === 'composite-label-ownership'), 'não há ambiguidade de propriedade aqui');
});

test('contraparte sem caminho algum também sai NOMEADA (o continue mudo de :326 não voltou pela porta dos fundos)', () => {
  const cwd = mkWorkspace('nopaths');
  writeRun(cwd, { id: 'M-x', kind: 'milestone', active: true, milestone_dir: '.gsd/milestones/M-x/', write_claim: null });
  writeEvents(cwd, [
    { event: 'claim-gate', run: 'M-x', unit: 'execute-task/T01', decision: 'proceed',
      counterparts: [{ id: 'RUN-B', cause: null, paths: [], scope: 'same', note: null }] },
  ]);
  const collected = collectClaims(cwd, { milestone: 'M-x', run: 'M-x', codeDir: ABS_A });
  assert(collected.skipped.some((s) => s.reason === 'no-attributable-paths' && s.id === 'RUN-B'),
    'descarte silencioso é o defeito de origem deste módulo');
});

test('sem run própria identificada, a incerteza é NOMEADA (self-run-unknown), não assumida inofensiva', () => {
  const cwd = mkWorkspace('noself');
  const collected = collectClaims(cwd, { milestone: 'M-x', codeDir: ABS_A });
  assert(collected.notes.some((n) => n.reason === 'self-run-unknown'), 'a incerteza tem de aparecer nomeada');
});

test('conjunto fechado CRUZADO nos dois sentidos: toda razão listada é alcançada por >= 1 cenário', () => {
  const seenSkips = new Set();
  const seenNotes = new Set();
  const collect = (r) => {
    for (const s of (r.skipped || [])) seenSkips.add(s.reason);
    for (const n of (r.notes || [])) seenNotes.add(n.reason);
  };

  // unit: no-written-files + delta-unavailable · pair: different-code-dir
  collect(compareClaimAudit(input({
    written: {
      units: [writtenUnit('u-vazia', []), writtenUnit('u', ['a.js'])],
      skipped: [{ kind: 'unit', id: 'u4', reason: 'delta-unavailable', detail: 'no-attributed-commits' }],
    },
    claims: {
      claims: [claimRow('RUN-B', ['a.js'], { claim: { paths: ['a.js'], code_dir: ABS_B } })],
      sources: sources(1, 0), skipped: [], notes: [],
    },
  })));
  // notas de code_dir herdadas de S03
  for (const value of [null, 42, 'relativo/nao/absoluto']) {
    collect(compareClaimAudit(input({
      written: { units: [writtenUnit('u', ['a.js'])], skipped: [] },
      claims: {
        claims: [claimRow('R', ['a.js'], { claim: { paths: ['a.js'], code_dir: value } })],
        sources: sources(1, 0), skipped: [], notes: [],
      },
    })));
  }
  // code-dir-unresolved: dois absolutos, ao menos um irresolvível em disco
  collect(compareClaimAudit(input({
    written: { units: [writtenUnit('u', ['a.js'])], skipped: [] },
    claims: {
      claims: [claimRow('R', ['a.js'], { claim: { paths: ['a.js'], code_dir: path.join(ABS_A, 'nao-existe-jamais') } })],
      sources: sources(1, 0), skipped: [], notes: [],
    },
  })));
  // collector-failed
  collect(auditClaims({
    cwd: mkWorkspace('cross-collector'), milestone: 'M-x', run: 'M-x',
    collectors: {
      written: () => { throw new Error('VCS ausente'); },
      declared: () => ({ byUnit: new Map(), notes: [] }),
      claims: () => ({ claims: [], sources: sources(0, 0), skipped: [], notes: [] }),
    },
  }));
  // source-unavailable (forma de produção) + self-run-unknown
  const cwdSrc = mkWorkspace('cross-source');
  collect(collectClaims(cwdSrc, {
    milestone: 'M-x', codeDir: ABS_A, scopeRunIds: new Set(['M-x']),
    events: { [Symbol.iterator]() { throw new Error('log ilegível'); } },
  }));
  // scope-unresolved
  collect(collectClaims(mkWorkspace('cross-scope'), { milestone: 'M-x', run: 'M-x', codeDir: ABS_A }));
  // same-run + no-attributable-paths + composite-label-ownership
  const cwdEv = mkWorkspace('cross-events');
  writeRun(cwdEv, { id: 'M-x', kind: 'milestone', active: true, milestone_dir: '.gsd/milestones/M-x/', write_claim: { paths: ['a.js'], code_dir: ABS_A } });
  writeEvents(cwdEv, [
    { event: 'claim-gate', run: 'M-x', unit: 'execute-task/T01', decision: 'defer',
      counterparts: [{ id: 'RUN-B', cause: 'overlap', paths: ['x/a.js × y/b.js'], scope: 'same', note: null }] },
  ]);
  collect(collectClaims(cwdEv, { milestone: 'M-x', run: 'M-x', codeDir: ABS_A }));
  // plan-legacy-schema é nota de `collectDeclared`; alcançada pela sua própria
  // rota, mas o cruzamento aqui exige que ela seja alcançável — construída
  // diretamente pelo seam, que é o único produtor legítimo.
  collect({ notes: recordNote([], 'u', 'plan-legacy-schema') });

  for (const reason of AUDIT_SKIP_REASONS) {
    assert(seenSkips.has(reason), `razão de skip listada e NUNCA alcançada por cenário: ${reason}`);
  }
  for (const reason of AUDIT_NOTE_REASONS) {
    assert(seenNotes.has(reason), `razão de nota listada e NUNCA alcançada por cenário: ${reason}`);
  }
});

// ── Bloco F — `code-dir-unknown` é CARREGADA, nunca descartada ─────────────
console.log('\nBloco F: code-dir-unknown propagada ao par sem alterar o veredicto (truth 7)');

test('code_dir desconhecido: o par É comparado, a nota chega ao par e o veredicto não muda', () => {
  const withKnown = compareClaimAudit(input({
    written: { units: [writtenUnit('M-x::S07/T01', ['scripts/a.js'])], skipped: [] },
    claims: { claims: [claimRow('RUN-B', ['scripts/a.js'])], sources: sources(1, 0), skipped: [], notes: [] },
  }));
  const withUnknown = compareClaimAudit(input({
    written: { units: [writtenUnit('M-x::S07/T01', ['scripts/a.js'])], skipped: [] },
    claims: {
      claims: [claimRow('RUN-B', ['scripts/a.js'], { claim: { paths: ['scripts/a.js'], code_dir: null } })],
      sources: sources(1, 0), skipped: [], notes: [],
    },
  }));
  eq(withUnknown.census.pairs_compared, 1, 'desconhecido NUNCA vira skip — excluir seria a polaridade que D1 proíbe');
  assert(!withUnknown.skipped.some((s) => s.reason === 'different-code-dir'), 'não pode virar skip');
  const note = withUnknown.notes.find((n) => n.reason === 'code-dir-unknown');
  assert(note, 'a nota tem de existir');
  eq(note.id, 'M-x::S07/T01 × RUN-B', 'a nota tem de chegar AO PAR, nomeando os dois lados');
  eq(withUnknown.findings[0].note, 'code-dir-unknown', 'a nota tem de viajar no achado');
  eq(withUnknown.verdict, withKnown.verdict, 'S07 carrega a incerteza; a política é do gate (S04)');
});

test('as demais notas de code_dir herdadas de S03 são alcançáveis e nomeadas', () => {
  const cases = [
    [42, 'code-dir-invalid'],
    ['relativo/nao/absoluto', 'code-dir-relative'],
  ];
  for (const [value, expected] of cases) {
    const r = compareClaimAudit(input({
      written: { units: [writtenUnit('u', ['a.js'])], skipped: [] },
      claims: {
        claims: [claimRow('R', ['a.js'], { claim: { paths: ['a.js'], code_dir: value } })],
        sources: sources(1, 0), skipped: [], notes: [],
      },
    }));
    assert(r.notes.some((n) => n.reason === expected), `nota esperada ausente: ${expected}`);
    eq(r.census.pairs_compared, 1, 'incerteza nunca exclui o par');
  }
});

// ── Bloco G — não-escrita provada por SHA-256 ──────────────────────────────
console.log('\nBloco G: auditClaims não escreve nada (truth 8)');

test('sha256 de todo run record, do events.jsonl e do SUMMARY idênticos antes e depois', () => {
  const cwd = mkWorkspace('nowrite');
  writeRun(cwd, { id: 'M-x', kind: 'milestone', active: true, write_claim: { paths: ['scripts/a.js'], code_dir: ABS_A } });
  writeRun(cwd, { id: 'RUN-B', kind: 'milestone', active: true, write_claim: { paths: ['scripts/a.js'], code_dir: ABS_A } });
  writeEvents(cwd, [
    { event: 'claim-gate', run: 'M-x', unit: 'execute-task/T01', decision: 'proceed',
      counterparts: [{ id: 'RUN-B', cause: null, paths: [], scope: 'same', note: null }] },
  ]);
  const summary = path.join(cwd, 'S07-SUMMARY.md');
  fs.writeFileSync(summary, '# S07\n\ncorpo intocado\n');

  const runsDir = path.join(cwd, '.gsd', 'forge', 'runs');
  const before = new Map();
  for (const f of fs.readdirSync(runsDir)) before.set(f, sha(path.join(runsDir, f)));
  before.set('events.jsonl', sha(path.join(cwd, '.gsd', 'forge', 'events.jsonl')));
  before.set('SUMMARY', sha(summary));

  const r = auditClaims({ cwd, codeDir: cwd, milestone: 'M-x', slice: 'S07', run: 'M-x' });
  assert(VERDICTS.includes(r.verdict), 'a corrida completa tem de produzir um veredicto do conjunto');

  for (const f of fs.readdirSync(runsDir)) {
    eq(sha(path.join(runsDir, f)), before.get(f), `run record foi ESCRITO: ${f}`);
  }
  eq(sha(path.join(cwd, '.gsd', 'forge', 'events.jsonl')), before.get('events.jsonl'), 'events.jsonl foi ESCRITO');
  eq(sha(summary), before.get('SUMMARY'), 'o SUMMARY foi ESCRITO — esta task não escreve seção (T02 acrescenta)');
});

// ── Bloco H — exceção de coletor nunca vira silêncio nem crash ─────────────
console.log('\nBloco H: coletor que LANÇA vira skip nomeado e o relatório existe (truth 9)');

test('coletor injetado que lança → skipped[collector-failed] e relatório existente', () => {
  const cwd = mkWorkspace('throwing');
  const r = auditClaims({
    cwd, codeDir: cwd, milestone: 'M-x', slice: 'S07', run: 'M-x',
    collectors: {
      written: () => { throw new Error('VCS ausente nesta máquina'); },
      declared: () => ({ byUnit: new Map(), notes: [] }),
      claims: () => ({ claims: [], sources: sources(0, 0), skipped: [], notes: [] }),
    },
  });
  assert(r && r.verdict, 'o relatório tem de continuar existindo');
  const hit = r.skipped.find((s) => s.reason === 'collector-failed');
  assert(hit, 'a exceção tem de virar skip NOMEADO, nunca silêncio');
  eq(hit.kind, 'collector');
  assert(String(hit.detail).includes('VCS ausente'), 'a mensagem original tem de viajar em detail');
  eq(r.verdict, 'inconclusive', 'sem par confrontado o veredicto é inconclusive, nunca clean');
});

test('os três coletores são individualmente protegidos (um que lança não derruba os outros)', () => {
  const cwd = mkWorkspace('throwing2');
  const r = auditClaims({
    cwd, codeDir: cwd, milestone: 'M-x', slice: 'S07', run: 'M-x',
    collectors: {
      written: () => ({ units: [writtenUnit('u', ['a.js'])], skipped: [] }),
      declared: () => { throw new Error('corpus ilegível'); },
      // `code_dir: null` — desconhecido NÃO exclui o par (D1), e é o que o
      // caminho integrado produz quando a contraparte não registrou a árvore.
      claims: () => ({
        claims: [claimRow('RUN-B', ['a.js'], { claim: { paths: ['a.js'], code_dir: null } })],
        sources: sources(1, 0), skipped: [], notes: [],
      }),
    },
  });
  eq(r.verdict, 'overlap', 'os coletores sobreviventes continuam produzindo o achado');
  assert(r.skipped.some((s) => s.reason === 'collector-failed'), 'a falha do coletor declarado é nomeada');
});

// ── Bloco I — a CLI sai 0 SEMPRE, provado por SPAWN ────────────────────────
console.log('\nBloco I: exit 0 incondicional, asserido spawnando a CLI (postura advisory)');

function runCli(args, cwd) {
  return spawnSync(process.execPath, [MODULE].concat(args), { cwd, encoding: 'utf8' });
}

test('CLI com sobreposição PLANTADA: verdict overlap na saída e exit 0 do PROCESSO', () => {
  const cwd = mkWorkspace('cli-overlap');
  writeRun(cwd, { id: 'M-x', kind: 'milestone', active: true, write_claim: null });
  writeRun(cwd, { id: 'RUN-B', kind: 'milestone', active: true, write_claim: { paths: ['scripts/a.js'], code_dir: ABS_A } });
  const res = runCli(['--milestone', 'M-x', '--slice', 'S07', '--cwd', cwd, '--code-dir', cwd, '--run', 'M-x', '--json'], cwd);
  eq(res.status, 0, `exit code do processo tem de ser 0, veio ${res.status} — stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert(VERDICTS.includes(out.verdict), `veredicto fora do conjunto: ${out.verdict}`);
});

test('CLI sobre um diretório sem .gsd: ainda exit 0 (advisory absoluto)', () => {
  const cwd = mktmp('cli-bare');
  const res = runCli(['--milestone', 'M-x', '--slice', 'S07', '--cwd', cwd, '--code-dir', cwd], cwd);
  eq(res.status, 0, `exit code tem de ser 0, veio ${res.status} — stderr: ${res.stderr}`);
});

test('CLI sem --milestone imprime o uso e sai 0', () => {
  const cwd = mktmp('cli-usage');
  const res = runCli([], cwd);
  eq(res.status, 0);
  assert(res.stdout.includes('forge-claim-audit.js'), 'o uso deve ser impresso');
});

test('formato legível: a razão está na primeira linha e o censo na segunda, inclusive em inconclusive', () => {
  const lines = formatClaimAudit(compareClaimAudit(input())).split('\n');
  assert(lines[0].includes('inconclusive'), `veio: ${lines[0]}`);
  assert(lines[1].includes('censo:'), `veio: ${lines[1]}`);
});

// ── Bloco J — a PARTIÇÃO acionável × histórico (triagem, 2026-08-16) ───────
//
// O detector rodado sobre o corpo real deste repositório produziu 45 achados,
// todos `undeclared-writes`, todos contra runs que já acabaram. São
// VERDADEIROS e não são ACIONÁVEIS. O remédio NÃO é filtrar: é particionar,
// mostrar os dois grupos e fechar o censo. Este bloco prova as duas metades —
// que nada some, e que a classificação é MEDIÇÃO, nunca heurística.
console.log('\nBloco J: partição acionável × histórico — nada é filtrado, a ambiguidade fica VISÍVEL');

const { FINDING_GROUPS, COUNTERPART_ACTIVITY, ACTIVITY_REASONS, groupOf, classifyActivity } = mod;

// Um workspace com registry REAL: a run própria, e contrapartes cujo `active`
// é o único fato lido. Nada é montado à mão do lado da classificação.
function mkRegistry(label, counterparts) {
  const cwd = mkWorkspace(label);
  writeRun(cwd, { id: 'M-x', kind: 'milestone', active: true, milestone_dir: '.gsd/milestones/M-x/', write_claim: null });
  for (const rec of counterparts) writeRun(cwd, rec);
  return cwd;
}

function findingsOver(cwd, files) {
  const collected = collectClaims(cwd, { milestone: 'M-x', slice: 'S07', run: 'M-x', codeDir: ABS_A });
  return {
    collected,
    result: compareClaimAudit(input({
      written: { units: [writtenUnit('M-x::S07/T01', files)], skipped: [] },
      claims: collected,
    })),
  };
}

test('contraparte MEDIDA como encerrada (active:false no registry) → historical/ended/registry-inactive', () => {
  const cwd = mkRegistry('grp-ended', [
    { id: 'RUN-MORTA', kind: 'milestone', active: false, write_claim: { paths: ['scripts/a.js'], code_dir: ABS_A } },
  ]);
  const { result: r } = findingsOver(cwd, ['scripts/a.js']);
  eq(r.findings.length, 1, 'o achado continua existindo — particionar não é filtrar');
  eq(r.findings[0].group, 'historical');
  eq(r.findings[0].counterpart_activity, 'ended');
  eq(r.findings[0].activity_reason, 'registry-inactive', 'a razão nomeia o FATO LIDO, não uma inferência');
  eq(r.verdict, 'overlap', 'o veredicto não amolece: o achado é verdadeiro');
});

test('contraparte MEDIDA como viva (active:true) → actionable/live/registry-active', () => {
  const cwd = mkRegistry('grp-live', [
    { id: 'RUN-VIVA', kind: 'milestone', active: true, write_claim: { paths: ['scripts/a.js'], code_dir: ABS_A } },
  ]);
  const { result: r } = findingsOver(cwd, ['scripts/a.js']);
  eq(r.findings.length, 1);
  eq(r.findings[0].group, 'actionable');
  eq(r.findings[0].counterpart_activity, 'live');
  eq(r.findings[0].activity_reason, 'registry-active');
});

test('record SEM o campo active → unmeasured/activity-not-recorded, e o grupo é ACIONÁVEL (a ambiguidade fica visível)', () => {
  const cwd = mkRegistry('grp-nofield', [
    { id: 'RUN-ANTIGA', kind: 'milestone', write_claim: { paths: ['scripts/a.js'], code_dir: ABS_A } },
  ]);
  const { result: r } = findingsOver(cwd, ['scripts/a.js']);
  eq(r.findings.length, 1);
  eq(r.findings[0].counterpart_activity, 'unmeasured');
  eq(r.findings[0].activity_reason, 'activity-not-recorded');
  eq(r.findings[0].group, 'actionable', 'fato imedível NUNCA cai no balde inerte');
});

test('contraparte fora do registry (achada só pelo histórico) → unmeasured/run-not-registered e ACIONÁVEL', () => {
  const cwd = mkWorkspace('grp-unregistered');
  writeRun(cwd, { id: 'M-x', kind: 'milestone', active: true, milestone_dir: '.gsd/milestones/M-x/', write_claim: null });
  writeEvents(cwd, [
    { event: 'claim-gate', run: 'M-x', unit: 'execute-task/T01', decision: 'defer',
      counterparts: [{ id: 'RUN-FANTASMA', cause: 'overlap', paths: ['scripts/a.js'], scope: 'same', note: null }] },
  ]);
  const { result: r } = findingsOver(cwd, ['scripts/a.js']);
  eq(r.findings.length, 1);
  eq(r.findings[0].claim_source, 'gate-events');
  eq(r.findings[0].activity_reason, 'run-not-registered');
  eq(r.findings[0].group, 'actionable', 'contraparte que o registry não conhece continua VISÍVEL');
});

test('registry ILEGÍVEL: toda contraparte vira unmeasured → ACIONÁVEL (falha ao medir jamais silencia achado)', () => {
  // A ponte run→milestone é injetada, então o histórico é admitido mesmo com o
  // registry inacessível — e é exatamente aí que a polaridade importa.
  const cwd = mkWorkspace('grp-registry-dead');
  writeEvents(cwd, [
    { event: 'claim-gate', run: 'M-x', unit: 'execute-task/T01', decision: 'defer',
      counterparts: [{ id: 'RUN-B', cause: 'overlap', paths: ['scripts/a.js'], scope: 'same', note: null }] },
  ]);
  const collected = collectClaims(cwd, {
    milestone: 'M-x', slice: 'S07', run: 'M-x', codeDir: ABS_A,
    scopeRunIds: new Set(['M-x']),
    runRecords: new Map(), // o que `runRecordsById` devolve quando listAll lança
  });
  const r = compareClaimAudit(input({
    written: { units: [writtenUnit('M-x::S07/T01', ['scripts/a.js'])], skipped: [] },
    claims: collected,
  }));
  eq(r.findings.length, 1);
  eq(r.findings[0].group, 'actionable');
  eq(r.census.findings_historical, 0, 'nenhum achado pode virar inerte por causa de um registry que não pôde ser lido');
});

test('conjuntos fechados nas DUAS direções, e só `ended` alcança o balde inerte', () => {
  eq(FINDING_GROUPS.join(','), 'actionable,historical');
  eq(COUNTERPART_ACTIVITY.join(','), 'live,ended,unmeasured');
  const groups = new Set();
  for (const a of COUNTERPART_ACTIVITY) {
    const g = groupOf(a);
    assert(FINDING_GROUPS.includes(g), `grupo fora do conjunto: ${g}`);
    groups.add(g);
    if (g === 'historical') eq(a, 'ended', `só a atividade MEDIDA como encerrada pode ser inerte, veio: ${a}`);
  }
  eq(groups.size, 2, 'os dois grupos têm de ser alcançáveis');
  for (const r of ACTIVITY_REASONS) {
    assert(typeof r === 'string' && r.length > 0, 'razão de atividade vazia');
  }
});

test('seam: atividade inventada LANÇA — nunca vira `historical` em silêncio (as duas direções)', () => {
  eq(groupOf('ended'), 'historical', 'o valor do conjunto passa');
  throws(() => groupOf('provavelmente-morta'), 'fora de COUNTERPART_ACTIVITY',
    'uma atividade inventada que virasse inerte suprimiria um incidente real');
  throws(() => compareClaimAudit(input({
    written: { units: [writtenUnit('u', ['a.js'])], skipped: [] },
    claims: {
      claims: [claimRow('R', ['a.js'], { activity: 'meio-morta', activity_reason: 'registry-active' })],
      sources: sources(1, 0), skipped: [], notes: [],
    },
  })), 'fora de COUNTERPART_ACTIVITY');
  throws(() => compareClaimAudit(input({
    written: { units: [writtenUnit('u', ['a.js'])], skipped: [] },
    claims: {
      claims: [claimRow('R', ['a.js'], { activity: 'ended', activity_reason: 'achei-que-sim' })],
      sources: sources(1, 0), skipped: [], notes: [],
    },
  })), 'fora de ACTIVITY_REASONS');
});

test('classifyActivity lê UM fato e nada mais (registro ausente, sem campo, true, false)', () => {
  eq(classifyActivity(null).activity, 'unmeasured');
  eq(classifyActivity(null).activity_reason, 'run-not-registered');
  eq(classifyActivity({ id: 'R' }).activity_reason, 'activity-not-recorded');
  eq(classifyActivity({ id: 'R', active: true }).activity, 'live');
  eq(classifyActivity({ id: 'R', active: false }).activity, 'ended');
  // Nada além de `active` decide: um record "que parece velho" pela data ainda
  // é `live` se o fato registrado disser isso. Heurística não entra aqui.
  eq(classifyActivity({ id: 'R', active: true, ts: '1999-01-01T00:00:00Z' }).activity, 'live');
});

test('CENSO fecha por igualdade: findings === acionáveis + históricos, sobre registry REAL misto', () => {
  const cwd = mkRegistry('grp-census', [
    { id: 'RUN-VIVA', kind: 'milestone', active: true, write_claim: { paths: ['scripts/a.js'], code_dir: ABS_A } },
    { id: 'RUN-MORTA-1', kind: 'milestone', active: false, write_claim: { paths: ['scripts/a.js'], code_dir: ABS_A } },
    { id: 'RUN-MORTA-2', kind: 'milestone', active: false, write_claim: { paths: ['scripts/b.js'], code_dir: ABS_A } },
  ]);
  const { result: r } = findingsOver(cwd, ['scripts/a.js', 'scripts/b.js']);
  eq(r.census.findings, 3, 'os TRÊS achados continuam existindo — a partição não descarta nenhum');
  eq(r.census.findings_actionable, 1);
  eq(r.census.findings_historical, 2);
  eq(r.census.findings, r.census.findings_actionable + r.census.findings_historical,
    'a partição tem de fechar por igualdade aritmética');
  eq(r.findings.length, r.census.findings, 'o censo tem de contar as linhas que existem, não uma fórmula');
  // E cada linha pertence a um dos dois grupos: nenhuma órfã.
  for (const f of r.findings) assert(FINDING_GROUPS.includes(f.group), `achado sem grupo: ${f.group}`);
});

test('ORDEM de apresentação: acionáveis primeiro, históricos depois (o sinal não afoga no ruído)', () => {
  const cwd = mkRegistry('grp-order', [
    { id: 'AAA-MORTA', kind: 'milestone', active: false, write_claim: { paths: ['scripts/a.js'], code_dir: ABS_A } },
    { id: 'ZZZ-VIVA', kind: 'milestone', active: true, write_claim: { paths: ['scripts/a.js'], code_dir: ABS_A } },
  ]);
  const { result: r } = findingsOver(cwd, ['scripts/a.js']);
  eq(r.findings.length, 2);
  // `AAA-MORTA` vence `ZZZ-VIVA` na ordenação alfabética antiga: só o rank de
  // grupo põe a viva na frente, então este assert morde de verdade.
  eq(r.findings[0].counterpart_run, 'ZZZ-VIVA', 'o acionável tem de vir primeiro');
  eq(r.findings[1].counterpart_run, 'AAA-MORTA');
});

test('TODOS os achados históricos: o veredicto continua overlap e a razão NOMEIA os dois grupos', () => {
  const cwd = mkRegistry('grp-all-hist', [
    { id: 'RUN-MORTA', kind: 'milestone', active: false, write_claim: { paths: ['scripts/a.js'], code_dir: ABS_A } },
  ]);
  const { result: r } = findingsOver(cwd, ['scripts/a.js']);
  eq(r.verdict, 'overlap', 'relatar `clean` sobre achados verdadeiros seria o filtro silencioso recusado');
  assert(/0 acionável\(is\), 1 histórico\(s\)/.test(r.reason), `a razão tem de nomear os dois grupos, veio: ${r.reason}`);
  assert(formatClaimAudit(r).includes('acionáveis 0'), 'a forma legível também tem de nomear a partição');
});

// ── Suite close ────────────────────────────────────────────────────────────
test('v2 audit reports only the root whose physical file overlaps', () => {
  const strict = require('assert'), f = require('./forge-code-roots.test').fixture();
  const claim = { schema_version: 2, execution_contract: f.contract, paths: ['beta::same.txt'] };
  const result = require('./forge-claim-audit').compareClaimAudit({ code_dir: f.a, execution_contract: f.contract,
    written: { units: [{ unit: 'execute-task/T-one', files: ['beta::same.txt'] }] },
    claims: { claims: [{ run: 'T-other', claim, active: true }] }, declared: { byUnit: new Map() } });
  strict.strictEqual(result.findings.length, 1, JSON.stringify(result));
  f.cleanup();
});
test('v2 audit integration collects qualified deltas from every declared root', () => {
  const strict = require('assert'), f = require('./forge-code-roots.test').fixture();
  try {
    const unit = 'execute-task/T-one', milestone = 'M-one';
    const result = require('./forge-claim-audit').auditClaims({ cwd: f.owner, codeDir: f.a, milestone,
      execution_contract: f.contract,
      deltasByRoot: Object.fromEntries(f.contract.code_roots.map(root => [root.id,
        { units: [{ unit, owner: milestone, files: ['same.txt'] }], skipped: [] }])),
      collectors: { declared: () => ({ byUnit: new Map([[unit, ['alpha::same.txt', 'beta::same.txt']]]) }),
        claims: () => ({ claims: [{ run: 'T-other', active: true, claim: {
          schema_version: 2, execution_contract: f.contract, paths: ['beta::same.txt'] } }], sources: [], skipped: [], notes: [] }) } });
    strict.strictEqual(result.findings.length, 1, JSON.stringify(result));
    strict.deepStrictEqual(result.findings[0].paths, ['beta::same.txt \u00d7 beta::same.txt']);
  } finally { f.cleanup(); }
});
cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
