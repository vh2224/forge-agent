#!/usr/bin/env node
'use strict';

// forge-claim-audit-write.test.js — the detector WRITES its own section, in all
// three verdicts, and emits the `work-lost` event BY CODE with an additive
// origin marker.
//
// One block per truth of T02-PLAN.md § must_haves.truths:
//
//   A  the section is written for `overlap`, `clean` AND `inconclusive`, and
//      the clean case ASSERTS THE WORK PERFORMED (how many pairs, how many
//      paths) — a clean section never merely exists.
//   B  the upsert is IDEMPOTENT and SURGICAL, proved BY BYTES: a second call
//      yields a byte-identical file, and every other section (including an
//      intra-slice `## File Audit` and a `## Route`) keeps its bytes. Heading
//      disjointness proved in BOTH directions.
//   C  the file's line-ending convention is PRESERVED: CRLF stays CRLF, LF
//      stays LF, counted.
//   D  the write guard refuses `target-missing`, `target-symlink` and
//      `outside-gsd`, and on each refusal the target keeps its bytes.
//   E  the `work-lost` event is appended BY THIS MODULE on `overlap`, carrying
//      `origin: 'code'` + `emitter`, and is NOT emitted on `clean` nor on
//      `inconclusive` — the three directions.
//   F  `originOf` classifies a REAL historical narrated line as `narrated` and
//      a freshly emitted one as `code` — both directions.
//   G  POSITIVE CONTROL, end to end BY SPAWN over a real git repo with a
//      PLANTED overlap: exit 0 read from the process, verdict `overlap`, the
//      disputed file NAMED in the section on disk, the `work-lost` line with
//      `origin: 'code'` on disk.
//   H  a failure to append NEVER swallows the finding: `event_written: false`
//      + `event_error`, section still written, exit still 0.
//   I  `exit 0` stays unconditional — asserted by SPAWN in four cases.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-claim-audit.js');
const {
  compareClaimAudit, formatClaimAuditMd, upsertClaimAuditSection, emitWorkLostEvent,
  originOf, AUDIT_SECTION_HEADING, AUDIT_SECTION_ANCHOR, WORK_LOST_EMITTER, WORK_LOST_ORIGINS,
} = require('./forge-claim-audit.js');
const { upsertRouteSection } = require('./forge-route-audit.js');

// ── Runner ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    if (e && e.__skip) {
      skipped++;
      // A skip is NAMED and loud. A silently dropped case is the very defect
      // this suite exists to prevent, one level up.
      console.log(`  ⊘ ${name} — PULADO: ${e.message}`);
      return;
    }
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function skip(msg) { const e = new Error(msg); e.__skip = true; throw e; }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
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
    `${msg || 'wrong throw'} — esperava "${needle}", veio: ${threw.message}`);
}

const tmpRoots = [];
function mktmp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-claim-audit-w-${label}-`));
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

// ── Result builders (pure core, no disk — that is the point) ───────────────
const ABS_A = process.platform === 'win32' ? 'C:\\wt\\alpha' : '/wt/alpha';

function result(kind) {
  const base = {
    milestone: 'M-x', slice: 'S07', code_dir: ABS_A,
    declared: { byUnit: new Map(), notes: [] },
  };
  if (kind === 'inconclusive') {
    return compareClaimAudit({ ...base, written: { units: [], skipped: [] }, claims: { claims: [], sources: [], skipped: [], notes: [] } });
  }
  const claimPaths = kind === 'overlap' ? ['scripts/a.js'] : ['scripts/z.js'];
  return compareClaimAudit({
    ...base,
    written: { units: [{ unit: 'M-x::S07/T02', owner: 'M-x', slice: 'S07', task: 'T02', files: ['scripts/a.js', 'scripts/b.js'] }], skipped: [] },
    claims: {
      claims: [{
        run: 'RUN-B', source: 'run-registry', paths: claimPaths,
        claim: { paths: claimPaths, code_dir: ABS_A }, scope_source: 'code-dir', scope: null, note: null,
      }],
      sources: [{ source: 'run-registry', consulted: true, contributed: 1, runs_examined: 2 }],
      skipped: [], notes: [],
    },
  });
}

// A SUMMARY carrying the neighbours this section must never touch: the
// intra-slice `## File Audit` of sub-step 1.6, a `## Route` owned by
// forge-route-audit, and a `## Forward Intelligence`.
function summaryFixture(eol) {
  return [
    '# S07-SUMMARY', '',
    '## Resumo', '', 'Texto do resumo.', '',
    '## File Audit', '', '- unexpected: nenhum', '- missing: nenhum', '',
    '## Route', '', '_Advisory_', '', '- rota configurada rodou em 2/2 tasks.', '',
    '## Forward Intelligence', '', '- nada a reportar.', '',
  ].join(eol);
}

function sectionsOf(text) {
  const out = new Map();
  const parts = text.split(/(?=^## )/m);
  for (const p of parts) {
    const head = (p.split(/\r?\n/)[0] || '').trim();
    if (head.startsWith('## ')) out.set(head, p);
  }
  return out;
}

function writeSummary(dir, eol) {
  const gsd = path.join(dir, '.gsd', 'milestones', 'M-x', 'slices', 'S07');
  fs.mkdirSync(gsd, { recursive: true });
  const p = path.join(gsd, 'S07-SUMMARY.md');
  fs.writeFileSync(p, summaryFixture(eol || '\n'), 'utf8');
  return p;
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco A: a seção é escrita nos TRÊS veredictos, e a limpa AFIRMA o trabalho feito (truth 1)');

for (const verdict of ['overlap', 'clean', 'inconclusive']) {
  test(`veredicto ${verdict}: a seção é emitida com heading, veredicto na 1ª bullet e censo na 2ª`, () => {
    const r = result(verdict);
    eq(r.verdict, verdict, 'fixture não produziu o veredicto pretendido');
    const md = formatClaimAuditMd(r);
    assert(md.startsWith(`${AUDIT_SECTION_HEADING}\n`), `heading ausente: ${md.slice(0, 60)}`);
    const bullets = md.split('\n').filter((l) => l.startsWith('- '));
    assert(bullets[0].includes(`**${verdict}**`), `veredicto fora da 1ª bullet: ${bullets[0]}`);
    assert(bullets[1].startsWith('- Censo:'), `censo fora da 2ª bullet: ${bullets[1]}`);
  });
}

test('o caso CLEAN afirma o trabalho feito: nomeia quantos PARES e quantos CAMINHOS, não só existe', () => {
  const r = result('clean');
  eq(r.verdict, 'clean');
  eq(r.census.pairs_compared, 1);
  eq(r.census.paths_compared, 2, 'dois arquivos escritos entraram na comparação');
  const md = formatClaimAuditMd(r);
  assert(/Confrontei 1 par\(es\) sobre 2 caminho\(s\)/.test(md),
    `a seção limpa tem de AFIRMAR pares e caminhos; veio:\n${md}`);
  assert(/não achei colisão/.test(md), 'a alegação de ausência de colisão tem de estar escrita');
});

test('o caso INCONCLUSIVE jamais é apresentado como limpo', () => {
  const md = formatClaimAuditMd(result('inconclusive'));
  assert(md.includes('Não é uma afirmação de limpeza'), `veio:\n${md}`);
  assert(!/não achei colisão/.test(md), 'inconclusive não pode usar a frase do caso limpo');
});

test('o caso OVERLAP nomeia arquivo, unidade e contraparte', () => {
  const md = formatClaimAuditMd(result('overlap'));
  assert(md.includes('M-x::S07/T02'), 'a unidade tem de ser nomeada');
  assert(md.includes('RUN-B'), 'a contraparte tem de ser nomeada');
  assert(md.includes('scripts/a.js'), 'o arquivo em disputa tem de ser nomeado');
});

test('toda linha de skipped[] aparece com sua razão — nenhum descarte silencioso', () => {
  const r = result('clean');
  r.skipped.push({ kind: 'pair', id: 'X × Y', reason: 'different-code-dir', detail: 'D2' });
  const md = formatClaimAuditMd(r);
  assert(md.includes('X × Y') && md.includes('different-code-dir'), `veio:\n${md}`);
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco B: upsert idempotente e CIRÚRGICO, provado por bytes (truth 2)');

test('segunda invocação produz arquivo BYTE-IDÊNTICO (nenhuma segunda seção appendada)', () => {
  const dir = mktmp('idem');
  const p = writeSummary(dir);
  const md = formatClaimAuditMd(result('overlap'));
  eq(upsertClaimAuditSection(p, md, dir).written, true);
  const first = fs.readFileSync(p);
  eq(upsertClaimAuditSection(p, md, dir).written, true);
  const second = fs.readFileSync(p);
  assert(Buffer.compare(first, second) === 0, 'a segunda escrita mudou bytes — upsert não é idempotente');
  const occurrences = second.toString('utf8').split(AUDIT_SECTION_HEADING).length - 1;
  eq(occurrences, 1, 'a seção foi appendada duas vezes');
});

test('os bytes de TODAS as outras seções ficam idênticos (incluindo `## File Audit` intra-slice e `## Route`)', () => {
  const dir = mktmp('surgery');
  const p = writeSummary(dir);
  const before = sectionsOf(fs.readFileSync(p, 'utf8'));
  eq(upsertClaimAuditSection(p, formatClaimAuditMd(result('overlap')), dir).written, true);
  const after = sectionsOf(fs.readFileSync(p, 'utf8'));
  for (const head of ['## Resumo', '## File Audit', '## Route', '## Forward Intelligence']) {
    assert(before.has(head), `fixture perdeu ${head}`);
    eq(after.get(head), before.get(head), `os bytes de ${head} foram alterados`);
  }
  assert(after.has(AUDIT_SECTION_HEADING), 'a seção cross-run não foi escrita');
});

test('disjunção de heading nas DUAS direções, no nível do regex', () => {
  const intra = /^## File Audit\r?$/m;
  assert(!intra.test(AUDIT_SECTION_HEADING), 'o âncora intra-slice casou o heading cross-run');
  assert(!AUDIT_SECTION_ANCHOR.test('## File Audit'), 'o âncora cross-run casou o heading intra-slice');
  assert(AUDIT_SECTION_ANCHOR.test(AUDIT_SECTION_HEADING), 'o âncora cross-run não casa o próprio heading');
  assert(intra.test('## File Audit'), 'controle positivo: o âncora intra-slice casa o próprio heading');
});

test('o dono vizinho escrevendo a SUA seção (`## Route`, forge-route-audit) não toca a cross-run', () => {
  const dir = mktmp('neighbour');
  const p = writeSummary(dir);
  eq(upsertClaimAuditSection(p, formatClaimAuditMd(result('overlap')), dir).written, true);
  const mine = sectionsOf(fs.readFileSync(p, 'utf8')).get(AUDIT_SECTION_HEADING);
  eq(upsertRouteSection(p, '## Route\n\n_Advisory_\n\n- reescrita pelo vizinho.\n', dir).written, true);
  const after = sectionsOf(fs.readFileSync(p, 'utf8'));
  eq(after.get(AUDIT_SECTION_HEADING), mine, 'o upsert vizinho alterou a seção cross-run');
  assert(after.get('## Route').includes('reescrita pelo vizinho'), 'controle positivo: o vizinho de fato reescreveu a dele');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco C: convenção de fim de linha preservada (truth 3)');

test('um SUMMARY CRLF continua CRLF, e a seção injetada adota CRLF', () => {
  const dir = mktmp('crlf');
  const p = writeSummary(dir, '\r\n');
  const before = fs.readFileSync(p, 'utf8');
  const crlfBefore = (before.match(/\r\n/g) || []).length;
  const loneBefore = (before.match(/(?<!\r)\n/g) || []).length;
  eq(loneBefore, 0, 'fixture CRLF não devia ter LF solto');
  eq(upsertClaimAuditSection(p, formatClaimAuditMd(result('clean')), dir).written, true);
  const after = fs.readFileSync(p, 'utf8');
  eq((after.match(/(?<!\r)\n/g) || []).length, 0, 'apareceu LF solto num arquivo CRLF');
  assert((after.match(/\r\n/g) || []).length > crlfBefore, 'a seção não foi adicionada');
});

test('um SUMMARY LF continua LF (nenhum CR introduzido)', () => {
  const dir = mktmp('lf');
  const p = writeSummary(dir, '\n');
  eq(upsertClaimAuditSection(p, formatClaimAuditMd(result('clean')), dir).written, true);
  const after = fs.readFileSync(p, 'utf8');
  eq((after.match(/\r/g) || []).length, 0, 'apareceu CR num arquivo LF');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco D: as três recusas nomeadas do guard, com o alvo BYTE-IDÊNTICO (truth 4)');

test('target-missing: alvo inexistente é recusado por nome', () => {
  const dir = mktmp('missing');
  writeSummary(dir);
  const ghost = path.join(dir, '.gsd', 'milestones', 'M-x', 'slices', 'S07', 'NAO-EXISTE.md');
  const r = upsertClaimAuditSection(ghost, formatClaimAuditMd(result('clean')), dir);
  eq(r.written, false);
  eq(r.reason, 'target-missing');
  assert(!fs.existsSync(ghost), 'o guard criou o arquivo que recusou');
});

test('outside-gsd: alvo fora de <cwd>/.gsd é recusado e o alvo fica byte-idêntico', () => {
  const dir = mktmp('outside');
  writeSummary(dir);
  const outside = path.join(dir, 'FORA.md');
  fs.writeFileSync(outside, summaryFixture('\n'), 'utf8');
  const before = sha(outside);
  const r = upsertClaimAuditSection(outside, formatClaimAuditMd(result('clean')), dir);
  eq(r.written, false);
  eq(r.reason, 'outside-gsd');
  eq(sha(outside), before, 'o alvo recusado foi mutado');
});

test('target-symlink: link é recusado por nome e o alvo real fica byte-idêntico', () => {
  const dir = mktmp('symlink');
  const real = writeSummary(dir);
  const before = sha(real);
  const link = path.join(path.dirname(real), 'LINK-SUMMARY.md');
  // Duas formas do MESMO ramo (`lstat().isSymbolicLink()`). O symlink de
  // arquivo exige privilégio no Windows; a junction de diretório não, e o
  // `lstat` a reporta igualmente como link — então o ramo é exercido de fato
  // nos dois sistemas, em vez de virar um pulo permanente na plataforma onde
  // este repo roda.
  let kind = 'file-symlink';
  try {
    fs.symlinkSync(real, link, 'file');
  } catch (_) {
    try {
      fs.symlinkSync(path.dirname(real), link, 'junction');
      kind = 'dir-junction';
    } catch (e2) {
      skip(`nenhuma forma de link criável neste ambiente (${e2.code}) — recusa não exercida`);
    }
  }
  assert(fs.lstatSync(link).isSymbolicLink(), `controle positivo: o ${kind} deve ser visto como link pelo lstat`);
  const r = upsertClaimAuditSection(link, formatClaimAuditMd(result('clean')), dir);
  eq(r.written, false, `a recusa não aconteceu (forma: ${kind})`);
  eq(r.reason, 'target-symlink');
  eq(sha(real), before, 'o alvo real foi mutado através do link');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco E: o evento work-lost é emitido POR CÓDIGO só em overlap (truth 5)');

function eventsPath(dir) { return path.join(dir, '.gsd', 'forge', 'events.jsonl'); }

test('overlap: a linha é appendada com origin:code + emitter e os campos do achado', () => {
  const dir = mktmp('ev-overlap');
  const r = emitWorkLostEvent(dir, result('overlap'));
  eq(r.event_written, true, `evento não escrito: ${r.event_error}`);
  eq(r.event_lines, 1);
  const lines = fs.readFileSync(eventsPath(dir), 'utf8').trim().split('\n');
  eq(lines.length, 1);
  const ev = JSON.parse(lines[0]);
  eq(ev.event, 'work-lost');
  eq(ev.origin, 'code');
  eq(ev.emitter, WORK_LOST_EMITTER);
  eq(ev.milestone, 'M-x');
  eq(ev.slice, 'S07');
  eq(ev.unit, 'M-x::S07/T02');
  eq(ev.other_run, 'RUN-B');
  assert(Array.isArray(ev.files) && ev.files.length > 0, 'os arquivos em disputa têm de viajar na linha');
});

for (const verdict of ['clean', 'inconclusive']) {
  test(`${verdict}: NENHUMA linha é emitida (o evento é o achado, não o relatório)`, () => {
    const dir = mktmp(`ev-${verdict}`);
    const r = emitWorkLostEvent(dir, result(verdict));
    eq(r.event_written, false);
    eq(r.event_error, null, 'ausência de achado não é erro');
    eq(r.event_skipped, 'no-finding');
    assert(!fs.existsSync(eventsPath(dir)), 'o log foi criado sem achado');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco F: originOf classifica narrada × emitida por código, nas DUAS direções (truth 6)');

// Linha HISTÓRICA real, copiada verbatim de um events.jsonl de produção
// (protected-wc, 2026-08-13): a forma escrita à mão, sem marcador.
const HISTORICAL = '{"ts":"2026-08-13T04:07:30Z","event":"work-lost","milestone":"M-20260812160209-resize-coluna-arrasto","slice":"S02","unit":"execute-task/S02-T02","cause":"concurrent-run-overwrite","other_run":"T-20260813031731-corrigir-janela-linhas","files":["component-grid-shadow-styled.js","component-grid-shadow.vue"]}';

test('a linha histórica narrada é classificada `narrated` e permanece LEGÍVEL', () => {
  eq(originOf(HISTORICAL), 'narrated');
  const ev = JSON.parse(HISTORICAL);
  eq(ev.event, 'work-lost', 'o nome do evento não mudou — a legibilidade histórica é preservada');
  assert(ev.files.length === 2, 'os campos históricos continuam legíveis');
});

test('a linha emitida por este módulo é classificada `code`', () => {
  const dir = mktmp('origin-code');
  emitWorkLostEvent(dir, result('overlap'));
  const line = fs.readFileSync(eventsPath(dir), 'utf8').trim();
  eq(originOf(line), 'code');
  eq(originOf(JSON.parse(line)), 'code', 'aceita objeto já parseado');
});

test('marcador PELA METADE não vira `code` (o par origin+emitter é o marcador)', () => {
  eq(originOf({ event: 'work-lost', origin: 'code' }), 'narrated');
  eq(originOf({ event: 'work-lost', emitter: WORK_LOST_EMITTER }), 'narrated');
});

test('o conjunto é fechado e uma linha que não é work-lost é LOUD no seam', () => {
  eq(WORK_LOST_ORIGINS.length, 2);
  assert(WORK_LOST_ORIGINS.includes('code') && WORK_LOST_ORIGINS.includes('narrated'));
  eq(WORK_LOST_ORIGINS.includes(originOf(HISTORICAL)), true);
  throws(() => originOf('{"event":"dispatch"}'), 'só classifica linhas work-lost');
  throws(() => originOf('nao-e-json'), 'ilegível');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco H: falha ao appendar NUNCA engole o achado (truth 8)');

test('events.jsonl inescrevível → event_written:false + event_error, e a seção AINDA é escrita', () => {
  const dir = mktmp('ev-fail');
  const p = writeSummary(dir);
  // O caminho do log existe como DIRETÓRIO: o append falha com EISDIR nos dois
  // sistemas operacionais, sem depender de permissão de arquivo.
  fs.mkdirSync(eventsPath(dir), { recursive: true });
  const r = result('overlap');
  const up = upsertClaimAuditSection(p, formatClaimAuditMd(r), dir);
  const ev = emitWorkLostEvent(dir, r);
  eq(up.written, true, 'a seção tem de ser escrita mesmo com o evento falhando');
  eq(ev.event_written, false);
  assert(ev.event_error && ev.event_error.length > 0, 'a falha tem de ser NOMEADA, não engolida');
  assert(fs.readFileSync(p, 'utf8').includes('scripts/a.js'), 'o achado continua nomeado na seção');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco G/I: CONTROLE POSITIVO ponta-a-ponta por SPAWN + exit 0 incondicional (truths 7 e 9)');

function runCli(args, cwd) {
  return spawnSync(process.execPath, [MODULE].concat(args), { cwd, encoding: 'utf8' });
}
function git(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const MILESTONE = 'M-20260813133328-lease-escrita-cross-run';

/**
 * A REAL workspace: a git repo whose `forge/<milestone>` branch carries a
 * commit scoped `feat(S07/T02):` touching `scripts/a.js`, plus another run
 * whose live claim names that very file from the SAME code_dir. That is the
 * planted overlap — nothing is stubbed on the way to the verdict.
 */
function plantWorkspace(label, opts) {
  // `claimPath` is what the COUNTERPART claims. Default: the very file this
  // slice writes (the planted overlap). Point it elsewhere and the same
  // fixture produces a GENUINELY clean verdict — which is the only way the
  // unconditionality assert can bite. A "clean" case that is actually
  // `inconclusive` passes green over the exact defect it exists to catch
  // (measured: the first version of this suite did precisely that).
  const claimPath = (opts && opts.claimPath) || 'scripts/a.js';
  const cwd = mktmp(label);
  const repo = path.join(cwd, 'code');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t']);
  git(repo, ['config', 'user.name', 'T']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-m', 'chore: base']);
  git(repo, ['checkout', '-b', `forge/${MILESTONE}`]);
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'a.js'), '// escrito por esta slice\n');
  git(repo, ['add', path.join('scripts', 'a.js')]);
  git(repo, ['commit', '-m', 'feat(S07/T02): escreve scripts/a.js']);

  const runsDir = path.join(cwd, '.gsd', 'forge', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const rec = (id, claim, active) => fs.writeFileSync(
    path.join(runsDir, `${id}.json`),
    `${JSON.stringify({ id, kind: 'milestone', active: active !== false, cwd: repo, code_dir: repo, write_claim: claim }, null, 2)}\n`,
    'utf8',
  );
  rec(MILESTONE, null);
  // A CONTRAPARTE: outra run, MESMO code_dir, claimando o arquivo escrito aqui.
  rec('RUN-CONTRAPARTE', { paths: [claimPath], code_dir: repo, ts: new Date().toISOString() });
  // Contrapartes extras — usadas pelo bloco da partição para plantar uma run
  // MEDIDA como encerrada ao lado da viva, na forma REAL de produção.
  for (const extra of ((opts && opts.extraRuns) || [])) {
    rec(extra.id, { paths: [extra.claimPath || claimPath], code_dir: repo, ts: new Date().toISOString() }, extra.active);
  }

  const summary = path.join(cwd, '.gsd', 'milestones', MILESTONE, 'slices', 'S07', 'S07-SUMMARY.md');
  fs.mkdirSync(path.dirname(summary), { recursive: true });
  fs.writeFileSync(summary, summaryFixture('\n'), 'utf8');
  return { cwd, repo, summary };
}

let planted = null;
try { planted = plantWorkspace('positive-control'); } catch (e) { planted = { error: e.message }; }

test('CONTROLE POSITIVO: sobreposição plantada → exit 0 do PROCESSO, verdict overlap, arquivo e contraparte NOMEADOS na seção em disco, linha work-lost origin:code em disco', () => {
  if (planted.error) skip(`fixture git indisponível: ${planted.error}`);
  const { cwd, repo, summary } = planted;
  const res = runCli(['--milestone', MILESTONE, '--slice', 'S07', '--cwd', cwd, '--code-dir', repo,
    '--run', MILESTONE, '--write', summary, '--json'], cwd);
  eq(res.status, 0, `exit code LIDO DO PROCESSO tem de ser 0, veio ${res.status} — stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  eq(out.verdict, 'overlap', `o detector não mordeu a sobreposição plantada — censo: ${JSON.stringify(out.census)} / skipped: ${JSON.stringify(out.skipped)}`);

  const written = fs.readFileSync(summary, 'utf8');
  assert(written.includes(AUDIT_SECTION_HEADING), 'a seção não foi escrita em disco');
  assert(written.includes('scripts/a.js'), 'o arquivo em disputa não foi NOMEADO na seção em disco');
  assert(written.includes('RUN-CONTRAPARTE'), 'a contraparte não foi NOMEADA na seção em disco');

  const log = fs.readFileSync(eventsPath(cwd), 'utf8').trim().split('\n').filter(Boolean);
  const lost = log.map((l) => JSON.parse(l)).filter((e) => e.event === 'work-lost');
  assert(lost.length >= 1, 'nenhuma linha work-lost em disco');
  eq(originOf(lost[lost.length - 1]), 'code', 'a linha em disco não carrega o marcador de origem');
  assert(lost[lost.length - 1].files.includes('scripts/a.js'), 'a linha não nomeia o arquivo em disputa');
});

test('exit 0 com RECUSA de escrita (alvo fora do .gsd)', () => {
  if (planted.error) skip(`fixture git indisponível: ${planted.error}`);
  const { cwd, repo } = planted;
  const outside = path.join(cwd, 'FORA.md');
  fs.writeFileSync(outside, '# fora\n', 'utf8');
  const res = runCli(['--milestone', MILESTONE, '--slice', 'S07', '--cwd', cwd, '--code-dir', repo,
    '--write', outside, '--json'], cwd);
  eq(res.status, 0, `exit code tem de ser 0, veio ${res.status}`);
  assert(res.stderr.includes('refused: outside-gsd'), `stderr humano deve nomear a recusa; veio: ${res.stderr}`);
  eq(fs.readFileSync(outside, 'utf8'), '# fora\n', 'o alvo recusado foi mutado');
});

test('exit 0 com FALHA de evento (log inescrevível), e a seção ainda escrita', () => {
  const p = plantWorkspace('evfail-cli');
  const evFile = eventsPath(p.cwd);
  fs.mkdirSync(evFile, { recursive: true });
  const res = runCli(['--milestone', MILESTONE, '--slice', 'S07', '--cwd', p.cwd, '--code-dir', p.repo,
    '--run', MILESTONE, '--write', p.summary, '--json'], p.cwd);
  eq(res.status, 0, `exit code tem de ser 0, veio ${res.status} — stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  eq(out.verdict, 'overlap');
  eq(out.event_written, false, 'a falha de evento tem de aparecer no relatório');
  assert(out.event_error, 'event_error tem de ser nomeado');
  assert(fs.readFileSync(p.summary, 'utf8').includes(AUDIT_SECTION_HEADING), 'a seção deixou de ser escrita por causa do evento');
});

test('workspace GENUINAMENTE limpo (pares confrontados, zero colisão): exit 0, seção escrita mesmo assim, nenhum evento', () => {
  let p;
  try { p = plantWorkspace('cli-clean', { claimPath: 'scripts/outro-arquivo.js' }); } catch (e) { skip(`fixture git indisponível: ${e.message}`); }
  const res = runCli(['--milestone', MILESTONE, '--slice', 'S07', '--cwd', p.cwd, '--code-dir', p.repo,
    '--run', MILESTONE, '--write', p.summary, '--json'], p.cwd);
  eq(res.status, 0, `exit code tem de ser 0, veio ${res.status} — stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  // O piso: este caso tem de ser CLEAN de verdade. Um `inconclusive` disfarçado
  // de limpo faria o assert seguinte passar sem nunca exercer a omissão.
  eq(out.verdict, 'clean', `o fixture precisa ser genuinamente limpo — censo: ${JSON.stringify(out.census)}`);
  assert(out.census.pairs_compared > 0, 'clean sem par confrontado seria o piso violado');
  const written = fs.readFileSync(p.summary, 'utf8');
  assert(written.includes(AUDIT_SECTION_HEADING),
    'seção OMITIDA quando limpa — é exatamente o defeito de origem que esta task fecha');
  assert(/Confrontei \d+ par\(es\) sobre \d+ caminho\(s\)/.test(written),
    'a seção limpa em disco tem de AFIRMAR o trabalho feito, não só existir');
  const log = fs.existsSync(eventsPath(p.cwd))
    ? fs.readFileSync(eventsPath(p.cwd), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
  eq(log.filter((e) => e.event === 'work-lost').length, 0, 'evento emitido sem achado');
});

// R4 — o espelho exato do assert de idempotência que a seção já tem. Re-rodar o
// fechamento (retry após `partial`, resume, CLI manual) re-afirma um achado
// VERDADEIRO; appendar de novo corrompe a MULTIPLICIDADE — um overlap lido como
// N perdas por quem conta incidentes. Deixar de appendar o redundante não viola
// o idioma append-only, que proíbe reescrever e deletar.
test('duas invocações idênticas da CLI: a SEGUNDA appenda ZERO linha work-lost (evento idempotente como a seção)', () => {
  let p;
  try { p = plantWorkspace('idem-event'); } catch (e) { skip(`fixture git indisponível: ${e.message}`); }
  const args = ['--milestone', MILESTONE, '--slice', 'S07', '--cwd', p.cwd, '--code-dir', p.repo,
    '--run', MILESTONE, '--write', p.summary, '--json'];

  const first = runCli(args, p.cwd);
  eq(first.status, 0, `exit 0 na primeira, veio ${first.status} — ${first.stderr}`);
  const out1 = JSON.parse(first.stdout);
  eq(out1.verdict, 'overlap', 'o fixture precisa achar de verdade para o caso valer');
  assert(out1.event_lines >= 1, 'a primeira invocação tem de appendar o achado');
  const lostAfterFirst = fs.readFileSync(eventsPath(p.cwd), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e) => e.event === 'work-lost').length;
  eq(lostAfterFirst, out1.event_lines, 'o relatado tem de bater com o que está em disco');

  const second = runCli(args, p.cwd);
  eq(second.status, 0, `exit 0 na segunda, veio ${second.status} — ${second.stderr}`);
  const out2 = JSON.parse(second.stdout);
  eq(out2.verdict, 'overlap', 'o mesmo achado continua verdadeiro — não é o achado que some, é a duplicata');
  eq(out2.event_lines, 0, 'a segunda invocação NÃO pode appendar linha alguma');
  eq(out2.event_skipped, 'already-recorded', 'e a supressão tem de ser NOMEADA, nunca silenciosa');
  const lostAfterSecond = fs.readFileSync(eventsPath(p.cwd), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e) => e.event === 'work-lost').length;
  eq(lostAfterSecond, lostAfterFirst, 'o achado foi multiplicado no log');
});

test('a supressão é por IDENTIDADE do achado, não por "já existe alguma linha": um achado NOVO ainda é appendado', () => {
  const dir = mktmp('idem-newfinding');
  const r = result('overlap');
  eq(emitWorkLostEvent(dir, r).event_lines, 1);
  eq(emitWorkLostEvent(dir, r).event_lines, 0, 'o mesmo achado não repete');
  const other = result('overlap');
  other.findings = other.findings.map((f) => ({ ...f, counterpart_run: 'RUN-C' }));
  eq(emitWorkLostEvent(dir, other).event_lines, 1, 'contraparte diferente é OUTRO achado e tem de ser registrado');
  const lost = fs.readFileSync(eventsPath(dir), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  eq(lost.length, 2);
  eq(lost.map((e) => e.other_run).join(','), 'RUN-B,RUN-C');
});

test('linha HISTÓRICA narrada (sem marcador) NÃO suprime o achado medido por código', () => {
  const dir = mktmp('idem-narrated');
  const r = result('overlap');
  const f = r.findings[0];
  fs.mkdirSync(path.dirname(eventsPath(dir)), { recursive: true });
  fs.appendFileSync(eventsPath(dir), `${JSON.stringify({
    ts: '2026-08-13T04:07:30Z', event: 'work-lost', milestone: r.milestone, slice: r.slice,
    unit: f.unit, cause: f.cause, other_run: f.counterpart_run, files: f.paths,
  })}\n`, 'utf8');
  eq(emitWorkLostEvent(dir, r).event_lines, 1,
    'a narrada e a medida são fatos de origens distintas — a primeira não pode calar a segunda');
});

test('workspace sem .gsd nenhum: exit 0 e recusa nomeada (advisory absoluto)', () => {
  const cwd = mktmp('cli-bare');
  const res = runCli(['--milestone', MILESTONE, '--slice', 'S07', '--cwd', cwd, '--code-dir', cwd,
    '--write', path.join(cwd, '.gsd', 'x.md'), '--json'], cwd);
  eq(res.status, 0, `exit code tem de ser 0, veio ${res.status}`);
  assert(res.stderr.includes('refused:'), `a recusa deve ser nomeada no stderr; veio: ${res.stderr}`);
});

// ── Suite close ────────────────────────────────────────────────────────────
cleanup();

// ═══════════════════════════════════════════════════════════════════════════
console.log('\nBloco J: a partição é RENDERIZADA inteira e só o ACIONÁVEL vira incidente (triagem 2026-08-16)');

// Um resultado MISTO montado pelo núcleo puro: uma contraparte viva e duas
// medidas como encerradas, todas colidindo com o mesmo arquivo escrito.
function mixedResult() {
  const claim = (run, activity, activity_reason) => ({
    run, source: 'run-registry', paths: ['scripts/a.js'],
    claim: { paths: ['scripts/a.js'], code_dir: ABS_A },
    scope_source: 'code-dir', scope: null, note: null, activity, activity_reason,
  });
  return compareClaimAudit({
    milestone: 'M-x', slice: 'S07', code_dir: ABS_A, declared: { byUnit: new Map(), notes: [] },
    written: { units: [{ unit: 'M-x::S07/T02', owner: 'M-x', slice: 'S07', task: 'T02', files: ['scripts/a.js'] }], skipped: [] },
    claims: {
      claims: [
        claim('RUN-VIVA', 'live', 'registry-active'),
        claim('RUN-MORTA-1', 'ended', 'registry-inactive'),
        claim('RUN-MORTA-2', 'ended', 'registry-inactive'),
      ],
      sources: [{ source: 'run-registry', consulted: true, contributed: 3, runs_examined: 4 }],
      skipped: [], notes: [],
    },
  });
}

test('a seção lista os DOIS grupos por inteiro, com contagem nomeada — nenhuma linha some, nenhum "e mais N"', () => {
  const r = mixedResult();
  eq(r.census.findings, 3);
  const md = formatClaimAuditMd(r);
  assert(/\*\*Acionáveis \(1\)\*\*/.test(md), `o grupo acionável tem de sair com contagem; veio:\n${md}`);
  assert(/\*\*Históricos\/inertes \(2\)\*\*/.test(md), `o grupo histórico tem de sair com contagem; veio:\n${md}`);
  for (const run of ['RUN-VIVA', 'RUN-MORTA-1', 'RUN-MORTA-2']) {
    assert(md.includes(run), `linha suprimida da seção: ${run} — particionar não é filtrar`);
  }
  assert(md.includes('acionáveis 1, históricos 2'), 'o censo da seção tem de nomear os dois termos');
  assert(!/e mais \d+/.test(md), 'nenhuma linha pode ser colapsada em contagem');
});

test('só históricos: a seção AINDA lista tudo e diz explicitamente que há zero acionáveis', () => {
  const r = mixedResult();
  r.findings = r.findings.filter((f) => f.group === 'historical');
  r.census.findings = 2; r.census.findings_actionable = 0; r.census.findings_historical = 2;
  const md = formatClaimAuditMd(r);
  assert(/\*\*Acionáveis \(0\)\*\*/.test(md), 'o grupo vazio tem de aparecer nomeado, nunca omitido');
  assert(md.includes('- nenhum.'), 'o grupo vazio tem de dizer "nenhum" — ausência de linha é ambígua');
  assert(md.includes('RUN-MORTA-1') && md.includes('RUN-MORTA-2'), 'os históricos continuam listados por inteiro');
});

test('evento: só os ACIONÁVEIS viram linha, e a supressão dos históricos é REPORTADA por número', () => {
  const dir = mktmp('ev-partition');
  const r = emitWorkLostEvent(dir, mixedResult());
  eq(r.event_written, true, `evento não escrito: ${r.event_error}`);
  eq(r.event_lines, 1, 'uma linha por achado ACIONÁVEL, e só');
  eq(r.event_historical_suppressed, 2, 'a supressão tem de ser NOMEADA por número, nunca silenciosa');
  const lines = fs.readFileSync(eventsPath(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq(lines.length, 1);
  eq(lines[0].other_run, 'RUN-VIVA', 'o incidente emitido é o da contraparte viva');
  eq(lines[0].counterpart_activity, 'live', 'a linha carrega a atividade medida (aditiva)');
  eq(originOf(lines[0]), 'code', 'o marcador de origem tem de sobreviver à partição');
});

test('achados TODOS históricos: nenhuma linha, razão NOMEADA (historical-only) e o log nem é criado', () => {
  const dir = mktmp('ev-hist-only');
  const r = mixedResult();
  r.findings = r.findings.filter((f) => f.group === 'historical');
  const out = emitWorkLostEvent(dir, r);
  eq(out.event_written, false);
  eq(out.event_error, null, 'não é erro: é uma decisão sobre o SIGNIFICADO do evento');
  eq(out.event_skipped, 'historical-only', 'a razão tem de ser nomeada, não um false mudo');
  eq(out.event_historical_suppressed, 2);
  assert(!fs.existsSync(eventsPath(dir)), 'nenhum incidente para uma contraparte encerrada');
});

test('idempotência R4 sobrevive à partição: a SEGUNDA emissão do mesmo misto appenda ZERO', () => {
  const dir = mktmp('ev-partition-idem');
  eq(emitWorkLostEvent(dir, mixedResult()).event_lines, 1);
  const second = emitWorkLostEvent(dir, mixedResult());
  eq(second.event_lines, 0);
  eq(second.event_skipped, 'already-recorded', 'a supressão por IDENTIDADE continua valendo');
  eq(second.event_historical_suppressed, 2, 'e a contagem histórica continua reportada');
  eq(fs.readFileSync(eventsPath(dir), 'utf8').trim().split('\n').length, 1);
});

// ── A reconciliação sobre a FORMA REAL DE PRODUÇÃO, por SPAWN ─────────────
//
// Não um fixture montado à mão: um repositório git de verdade, um registry de
// verdade com uma contraparte VIVA e uma MEDIDA COMO ENCERRADA, a CLI real, e
// o censo lido do JSON que o processo imprimiu. Foi exatamente a asserção sobre
// forma montada à mão que produziu o defeito recorrente desta milestone.
let mixedPlant = null;
try {
  mixedPlant = plantWorkspace('partition-real', {
    extraRuns: [{ id: 'RUN-ENCERRADA', active: false }],
  });
} catch (e) { mixedPlant = { error: e.message }; }

test('FORMA REAL por SPAWN: censo fecha por igualdade, os DOIS grupos saem na seção em disco, e só o acionável vira work-lost', () => {
  if (mixedPlant.error) skip(`fixture git indisponível: ${mixedPlant.error}`);
  const { cwd, repo, summary } = mixedPlant;
  const res = runCli(['--milestone', MILESTONE, '--slice', 'S07', '--cwd', cwd, '--code-dir', repo,
    '--run', MILESTONE, '--write', summary, '--json'], cwd);
  eq(res.status, 0, `exit code LIDO DO PROCESSO tem de ser 0, veio ${res.status} — stderr: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  eq(out.verdict, 'overlap', `o detector não mordeu — censo: ${JSON.stringify(out.census)}`);

  // (1) o censo reconcilia por IGUALDADE ARITMÉTICA, na forma de produção.
  eq(out.census.findings, 2, `duas contrapartes colidem; censo: ${JSON.stringify(out.census)}`);
  eq(out.census.findings, out.census.findings_actionable + out.census.findings_historical,
    'a partição tem de fechar por igualdade sobre a saída REAL do processo');
  eq(out.census.findings_actionable, 1);
  eq(out.census.findings_historical, 1);
  eq(out.findings.length, out.census.findings, 'o censo conta as linhas que existem');
  const unitSkips = out.skipped.filter((s) => s.kind === 'unit').length;
  eq(out.census.units_examined, out.census.units_compared + unitSkips, 'a conta de unidades continua fechando');

  // (2) NADA foi filtrado: a seção em disco nomeia as DUAS contrapartes.
  const written = fs.readFileSync(summary, 'utf8');
  assert(written.includes('RUN-CONTRAPARTE'), 'a contraparte viva sumiu da seção');
  assert(written.includes('RUN-ENCERRADA'), 'a contraparte encerrada foi FILTRADA da seção — o defeito recusado pelo operador');
  assert(/\*\*Históricos\/inertes \(1\)\*\*/.test(written), 'o grupo histórico tem de sair nomeado e contado em disco');

  // (3) só o acionável virou incidente, e a supressão foi ANUNCIADA no stderr.
  const lost = fs.readFileSync(eventsPath(cwd), 'utf8').trim().split('\n')
    .filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'work-lost');
  eq(lost.length, 1, `só o achado acionável vira incidente; veio: ${JSON.stringify(lost.map((l) => l.other_run))}`);
  eq(lost[0].other_run, 'RUN-CONTRAPARTE');
  assert(/1 achado\(s\) histórico\(s\)/.test(res.stderr),
    `a supressão tem de ser anunciada no stderr; veio: ${res.stderr}`);
});

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
