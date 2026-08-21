#!/usr/bin/env node
'use strict';

// forge-write-coverage.test.js — the measurement, and the floors under it.
//
//   R1  the three verdicts + `inconclusive`, in four distinct corpora, each
//       asserting the THRESHOLD is echoed in the output (json AND markdown) —
//       the threshold is the deliverable, so a report that decides without
//       stating the rule fails here
//   R2  exit codes read from the PROCESS, by spawn: `inconclusive` is the only
//       non-zero, and it is non-zero for both of its causes (empty corpus and
//       nothing measurable)
//   R3  the six skip reasons are each PRODUCED for real and cross-checked BOTH
//       WAYS against `SKIP_REASONS` — a declared reason nobody saw fire is
//       decoration; a produced reason the list omits is a silent drop
//   R4  reconciliation closes in both accounts, and is present in the rendered
//       report rather than only in an assertion here
//   R5  glob declarations match through `pathsOverlap` (`src/**` covers
//       `src/a/b.ts`) — no matcher of this module's own
//   R6  D6, negatively: `computeCoverage` cannot even SEE the evidence field,
//       and a fixture where the evidence log contradicts the VCS produces the
//       VCS's number
//   R7  the corpus admits what it should and excludes what it should:
//       `*-PLAN-GATE.md` and `status: DECOMPOSED` never become units
//
// Fixtures are real git repositories in tmpdirs. Zero deps.
//
// NOTE ON A DEVIATION, measured rather than assumed: T03's plan says to IMPORT
// the git fixture builders from `forge-unit-delta.test.js`. That file cannot be
// imported — it runs its suite at load and calls `process.exit`, verified by
// `node -e "require(...); console.log('AFTER')"`, where `AFTER` never prints.
// Making it importable means writing a file outside this task's declared
// `writes:`, in the very slice that exists to measure undeclared writes. The
// builders below are therefore local, and deliberately minimal.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-write-coverage.js');
const cov = require('./forge-write-coverage.js');
const {
  SKIP_REASONS, VERDICT_THRESHOLDS, VERDICTS, INCONCLUSIVE, DECLARED_DETAILS,
  measureCoverage, computeCoverage, renderMarkdown, discoverCorpus,
} = cov;

// ── Runner ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push({ name, error: e.message }); console.log(`  ✗ ${name}`); console.log(`      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}
function assertDeep(a, b, msg) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg || 'mismatch'}: esperado ${y}, veio ${x}`);
}

// Reasons observed firing during this run — collected from what the code
// emitted, never predicted, then cross-checked at the end (R3).
const reasonsSeen = new Set();
function observe(rep) {
  for (const s of (rep.skipped || [])) if (s.reason) reasonsSeen.add(s.reason);
  return rep;
}

// ── Fixture builders ───────────────────────────────────────────────────────
function g(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function newRepo(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `write-cov-${tag}-`));
  g(root, ['init', '-q', '--initial-branch=master', '.']);
  g(root, ['config', 'user.email', 't@example.com']);
  g(root, ['config', 'user.name', 'T']);
  g(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  g(root, ['add', '--', 'README.md']);
  g(root, ['commit', '-q', '-m', 'chore: base']);
  return root;
}

function commitFiles(root, files, msg) {
  for (const f of files) {
    const abs = path.join(root, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `x\n`);
    g(root, ['add', '--', f]);
  }
  g(root, ['commit', '-q', '-m', msg]);
}

function planBody(opts) {
  const o = opts || {};
  const writes = (o.writes || []).map((w) => `  - "${w}"`).join('\n');
  const expected = (o.expected || []).map((w) => `  - ${w}`).join('\n');
  if (o.legacy) {
    return `---\nid: ${o.task || 'T01'}\nwrites:\n${writes}\n---\n\n# plano legacy (sem must_haves)\n`;
  }
  return [
    '---',
    `id: ${o.task || 'T01'}`,
    o.decomposed ? 'status: DECOMPOSED' : null,
    'writes:',
    writes || '  []',
    'must_haves:',
    '  truths:',
    '    - "faz o que diz"',
    '  artifacts:',
    '    - path: "src/a.ts"',
    '      provides: "algo"',
    '      min_lines: 1',
    '  key_links: []',
    'expected_output:',
    expected || '  []',
    '---',
    '',
    '# plano',
    '',
  ].filter((l) => l !== null).join('\n');
}

// Milestone-owned unit plan at the canonical path.
function writeUnitPlan(root, owner, slice, task, opts) {
  const dir = path.join(root, '.gsd', 'milestones', owner, 'slices', slice, 'tasks', task);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${task}-PLAN.md`), planBody({ ...opts, task }));
  return dir;
}

function writeLoosePlan(root, taskId, opts) {
  const dir = path.join(root, '.gsd', 'tasks', taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${taskId}-PLAN.md`), planBody(opts));
  return dir;
}

test('owner scope isolates one milestone from every other milestone', () => {
  const root = newRepo('owner-scope');
  writeUnitPlan(root, 'M101', 'S01', 'T01', { writes: ['src/a.js'], expected: ['src/a.js'] });
  writeUnitPlan(root, 'M202', 'S01', 'T01', { writes: ['src/other.js'], expected: ['src/other.js'] });
  const delta = {
    vcs: 'git', default_branch: 'master', commits_walked: 2, attributed: 2, unattributed: [], skipped: [],
    units: [
      { unit: 'M101::S01/T01', owner: 'M101', ref: 'forge/M101', files: ['src/a.js'], commits: ['a'] },
      { unit: 'M202::S01/T01', owner: 'M202', ref: 'forge/M202', files: ['src/b.js'], commits: ['b'] },
    ],
  };
  const rep = measureCoverage(root, { owner: 'M202', delta, refs: [{ id: 'M101' }, { id: 'M202' }] });
  assertEqual(rep.scope.owner, 'M202', 'escopo declarado');
  assertEqual(rep.units_considered, 1, 'somente uma unidade');
  assertEqual(rep.units[0].owner, 'M202', 'somente o milestone pedido');
  assertEqual(rep.coverage, 0, 'M101 não melhora a cobertura de M202');
  assertEqual(rep.reconciliation.commits.commits_walked, 1, 'commits também isolados');
  assert(rep.reconciliation.commits.balances, 'reconciliação continua fechada');
});

test('owner scope nunca pinta reconciliação SVN ownerless de verde', () => {
  const root = newRepo('owner-scope-svn');
  writeUnitPlan(root, 'M202', 'S01', 'T01', { writes: ['src/b.js'], expected: ['src/b.js'] });
  const delta = {
    vcs: 'svn', commits_walked: 2, attributed: 1,
    units: [{ unit: 'M202::S01/T01', owner: 'M202', files: ['src/b.js'], commits: ['r2'] }],
    unattributed: [{ sha: 'r1', reason: 'no-unit-marker' }], skipped: [],
  };
  const rep = measureCoverage(root, { owner: 'M202', delta });
  assertEqual(rep.reconciliation.commits.balances, false, 'saldo não é inventado');
  assertEqual(rep.reconciliation.commits.source, 'unavailable:svn-unattributed-ownerless', 'limitação nomeada');
});

function sweptMilestone(root, owner) {
  fs.mkdirSync(path.join(root, '.gsd', 'milestones', owner, 'slices'), { recursive: true });
}

const M_GO = 'M-20990101000000-go';
const M_RE = 'M-20990102000000-rescope';
const M_NO = 'M-20990103000000-notarget';
const M_SWEPT = 'M-20990104000000-swept';
const M_NOREF = 'M-20990105000000-noref';
const M_NOCOMMIT = 'M-20990106000000-nocommit';
const M_AMBIG = 'M-20990107000000-ambig';

// A corpus with one measurable unit whose coverage is chosen by construction:
// `declaredOf` files out of `writtenCount` written land inside the declaration.
function makeVerdictCorpus(tag, owner, declared, writtenFiles) {
  const root = newRepo(tag);
  writeUnitPlan(root, owner, 'S01', 'T01', { writes: declared, expected: [] });
  g(root, ['checkout', '-q', '-b', `forge/${owner}`]);
  commitFiles(root, writtenFiles, 'feat(S01/T01): trabalho');
  g(root, ['checkout', '-q', 'master']);
  return root;
}

function runCli(args) {
  return spawnSync(process.execPath, [MODULE, ...args], { encoding: 'utf8' });
}

// ── R1 + R2: the four outcomes, with thresholds echoed and exits spawned ────

test('R1 GO: cobertura total → GO, com os thresholds ecoados no json e no markdown', () => {
  const root = makeVerdictCorpus('go', M_GO, ['src/**'], ['src/a/b.ts', 'src/c.ts']);
  const rep = observe(measureCoverage(root, {}));
  assertEqual(rep.units_measured, 1, 'uma unidade medida');
  assertEqual(rep.coverage, 1, 'coverage');
  assertEqual(rep.verdict, 'GO', 'veredito');
  assertEqual(rep.thresholds.go, VERDICT_THRESHOLDS.go, 'threshold go ecoado no json');
  assertEqual(rep.thresholds.rescope, VERDICT_THRESHOLDS.rescope, 'threshold rescope ecoado no json');
  const md = renderMarkdown(rep);
  assert(md.includes(`GO: coverage >= ${VERDICT_THRESHOLDS.go}`), 'markdown ecoa o threshold de GO');
  assert(md.includes('**GO**'), 'markdown nomeia o veredito');
  assert(md.includes('Limitação'), 'markdown carrega a limitação incondicional');
});

test('R5 glob: `src/**` declarado cobre `src/a/b.ts` escrito (pathsOverlap, sem matcher próprio)', () => {
  const root = makeVerdictCorpus('glob', M_GO, ['src/**'], ['src/a/b/c/deep.ts']);
  const rep = observe(measureCoverage(root, {}));
  assertDeep(rep.units[0].undeclared, [], 'nada não-declarado sob o glob');
  assertEqual(rep.units[0].declared_hits, 1, 'o arquivo profundo casou o glob');
});

test('R1 RESCOPE: metade dos escritos declarada → RESCOPE, threshold ecoado', () => {
  const root = makeVerdictCorpus('rescope', M_RE, ['src/**'], ['src/a.ts', 'src/b.ts', 'lib/c.ts', 'lib/d.ts']);
  const rep = observe(measureCoverage(root, {}));
  assertEqual(rep.coverage, 0.5, 'coverage');
  assertEqual(rep.verdict, 'RESCOPE', 'veredito');
  assertDeep(rep.units[0].undeclared, ['lib/c.ts', 'lib/d.ts'], 'não-declarados nomeados');
  const md = renderMarkdown(rep);
  assert(md.includes(`RESCOPE: ${VERDICT_THRESHOLDS.rescope} <= coverage < ${VERDICT_THRESHOLDS.go}`), 'markdown ecoa a faixa de RESCOPE');
});

test('R1 NO-TARGET: um quarto declarado → NO-TARGET, threshold ecoado', () => {
  const root = makeVerdictCorpus('notarget', M_NO, ['src/a.ts'], ['src/a.ts', 'lib/b.ts', 'lib/c.ts', 'lib/d.ts']);
  const rep = observe(measureCoverage(root, {}));
  assertEqual(rep.coverage, 0.25, 'coverage');
  assertEqual(rep.verdict, 'NO-TARGET', 'veredito');
  const md = renderMarkdown(rep);
  assert(md.includes(`NO-TARGET: coverage < ${VERDICT_THRESHOLDS.rescope}`), 'markdown ecoa a faixa de NO-TARGET');
});

test('R1 inconclusive está FORA do conjunto fechado de vereditos', () => {
  assert(!VERDICTS.includes(INCONCLUSIVE), 'inconclusive não pode ser um veredito');
  assertDeep(VERDICTS, ['GO', 'RESCOPE', 'NO-TARGET'], 'conjunto fechado de vereditos');
});

test('R1/R2 inconclusive por corpus só-varrido: nenhuma porcentagem, exit NÃO-ZERO lido do processo', () => {
  const root = newRepo('swept');
  sweptMilestone(root, M_SWEPT);
  const rep = observe(measureCoverage(root, {}));
  assertEqual(rep.units_measured, 0, 'nada medido');
  assertEqual(rep.verdict, INCONCLUSIVE, 'veredito');
  assertEqual(rep.coverage, null, 'coverage nunca vira 0 nem 100 sobre nada');
  assertDeep(rep.skipped.map((s) => s.reason), ['plan-swept'], 'o milestone varrido saiu nomeado');
  assert(/inconclusive:/.test(rep.exit_reason), 'motivo nomeado');

  const r = runCli(['--cwd', root, '--json']);
  assertEqual(r.status, 2, 'exit code do PROCESSO (spawn), não de uma função');
  assert(r.stderr.includes('inconclusive'), 'motivo nomeado no stderr');
  assertEqual(JSON.parse(r.stdout).verdict, INCONCLUSIVE, 'o json ainda sai completo');
});

test('R2 inconclusive por corpus vazio (--cwd errado) FALHA nomeado, nunca mede vazio', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'write-cov-empty-'));
  const r = runCli(['--cwd', root, '--json']);
  assertEqual(r.status, 2, 'exit não-zero');
  const rep = JSON.parse(r.stdout);
  assertEqual(rep.units_considered, 0, 'corpus vazio');
  assertEqual(rep.verdict, INCONCLUSIVE, 'veredito');
  assert(rep.exit_reason.includes('nenhuma unidade no corpus'), 'a causa vazia é distinguida da causa não-medível');
});

test('R2 os três vereditos saem com exit ZERO — só o inconclusive é não-zero', () => {
  for (const [tag, owner, dec, wr] of [['e-go', M_GO, ['src/**'], ['src/a.ts']], ['e-re', M_RE, ['src/**'], ['src/a.ts', 'lib/b.ts']], ['e-no', M_NO, ['src/a.ts'], ['src/a.ts', 'l/b.ts', 'l/c.ts', 'l/d.ts']]]) {
    const root = makeVerdictCorpus(tag, owner, dec, wr);
    const r = runCli(['--cwd', root, '--json']);
    assertEqual(r.status, 0, `${tag}: exit`);
    assert(VERDICTS.includes(JSON.parse(r.stdout).verdict), `${tag}: veredito do conjunto fechado`);
  }
});

test('R2 --markdown emite só o relatório, com thresholds e reconciliação por extenso', () => {
  const root = makeVerdictCorpus('md', M_GO, ['src/**'], ['src/a.ts']);
  const r = runCli(['--cwd', root, '--markdown']);
  assertEqual(r.status, 0, 'exit');
  assert(r.stdout.startsWith('# Cobertura'), 'só o relatório');
  assert(r.stdout.includes(`GO: coverage >= ${VERDICT_THRESHOLDS.go}`), 'threshold ecoado no markdown da CLI');
  assert(/considerada\(s\) === .* medida\(s\) \+ .* skipped/.test(r.stdout), 'reconciliação de unidades impressa');
  assert(/caminhado\(s\) === .* atribuído\(s\) \+ .* não-atribuído\(s\)/.test(r.stdout), 'reconciliação de commits impressa');
});

// ── R3: the six reasons, each produced for real ────────────────────────────

test('R3 no-code-writes: declarado 100% .gsd/** sai nomeado, com detalhe gsd-only', () => {
  const root = newRepo('gsdonly');
  writeUnitPlan(root, M_GO, 'S01', 'T02', { writes: ['.gsd/milestones/x/S01-SUMMARY.md'], expected: [] });
  const rep = observe(measureCoverage(root, {}));
  const s = rep.skipped.find((x) => x.reason === 'no-code-writes');
  assert(s, 'razão produzida');
  assertEqual(s.detail, DECLARED_DETAILS.GSD_ONLY, 'sub-razão distinguida');
});

test('R3 no-code-writes: lado declarado VAZIO sai como contradição medida, nunca absorvida', () => {
  const root = newRepo('nosignal');
  writeUnitPlan(root, M_GO, 'S01', 'T03', { writes: [], expected: [] });
  const rep = observe(measureCoverage(root, {}));
  const s = rep.skipped.find((x) => x.reason === 'no-code-writes');
  assertEqual(s.detail, DECLARED_DETAILS.NO_PATH_SIGNAL, 'sub-razão no-path-signal');
  assertEqual(rep.contradictions.length, 1, 'a condição de reversão do S02-PLAN § Notes é reportada');
  assert(rep.contradictions[0].note.includes('no-path-signal'), 'a contradição nomeia a medição contrariada');
});

test('R3 no-branch-ref: unidade com plano e sem ref forge/* (a razão que o T02 deixou para o join)', () => {
  const root = newRepo('noref');
  writeUnitPlan(root, M_NOREF, 'S01', 'T01', { writes: ['src/**'], expected: [] });
  const rep = observe(measureCoverage(root, {}));
  const s = rep.skipped.find((x) => x.reason === 'no-branch-ref');
  assert(s, 'razão produzida');
  assert(!require('./forge-unit-delta.js').DELTA_REASONS.includes('no-branch-ref'), 'e ela NÃO pertence ao conjunto do T02 — a fronteira é deliberada');
});

test('R3 no-attributed-commits: ref existe, nenhum commit com o escopo da unidade', () => {
  const root = newRepo('nocommit');
  writeUnitPlan(root, M_NOCOMMIT, 'S01', 'T01', { writes: ['src/**'], expected: [] });
  g(root, ['checkout', '-q', '-b', `forge/${M_NOCOMMIT}`]);
  commitFiles(root, ['src/a.ts'], 'chore: batch que agrega várias tasks');
  g(root, ['checkout', '-q', 'master']);
  const rep = observe(measureCoverage(root, {}));
  const s = rep.skipped.find((x) => x.reason === 'no-attributed-commits');
  assert(s, 'razão produzida');
  assertEqual(rep.units_measured, 0, 'nunca 0% e nunca 100% para essa unidade');
});

test('R3 legacy-plan-schema: plano sem bloco must_haves estruturado', () => {
  const root = newRepo('legacy');
  writeUnitPlan(root, M_GO, 'S01', 'T04', { writes: ['src/**'], legacy: true });
  const rep = observe(measureCoverage(root, {}));
  assert(rep.skipped.some((x) => x.reason === 'legacy-plan-schema'), 'razão produzida');
});

test('R3 ambiguous-unit-owner: o delta svn recusou o dono → a unidade sai nomeada, nunca chutada', () => {
  const root = newRepo('ambig');
  writeUnitPlan(root, M_AMBIG, 'S04', 'T01', { writes: ['src/**'], expected: [] });
  const delta = {
    vcs: 'svn', units: [], units_measured: 0, refs_examined: 0,
    commits_walked: 1, attributed: 0,
    unattributed: [{ sha: 'r1', subject: 'feat(S04/T01): x', reason: 'ambiguous-unit-owner' }],
    skipped: [{ unit: 'S04/T01', rev: 1, reason: 'ambiguous-unit-owner' }],
  };
  const rep = observe(measureCoverage(root, { delta }));
  const s = rep.skipped.find((x) => x.reason === 'ambiguous-unit-owner');
  assert(s, 'razão produzida');
  assertEqual(s.unit, `${M_AMBIG}::S04/T01`, 'a unidade é nomeada pela chave COMPOSTA');
});

// ── R8 — objeções concedidas do review de S02 (R3 e a propagação de R5) ────
console.log('\nR8 — review de S02: plan-swept keyed no que existe, ref-divergent propagado');

test('R8/R3 milestone toda DECOMPOSED sai como plans-all-excluded — nunca "sem nenhum T##-PLAN.md"', () => {
  const M_DEC = 'M-20990108000000-decomposed';
  const root = newRepo('alldec');
  writeUnitPlan(root, M_DEC, 'S01', 'T01', { writes: ['src/**'], expected: [], decomposed: true });
  writeUnitPlan(root, M_DEC, 'S01', 'T02', { writes: ['src/**'], expected: [], decomposed: true });
  const rep = observe(measureCoverage(root, {}));
  const s = rep.skipped.find((x) => x.unit === M_DEC);
  assert(s, `o diretório precisa sair nomeado: ${JSON.stringify(rep.skipped)}`);
  assertEqual(s.reason, 'plans-all-excluded', 'razão própria, não plan-swept');
  // O assert que morde: a string antiga afirmava ausência sobre planos presentes.
  assert(!/sem nenhum T##-PLAN\.md/.test(s.detail), `detail afirma ausência sobre planos que existem: ${s.detail}`);
  assert(/2 T##-PLAN\.md/.test(s.detail), `detail precisa contar os planos vistos: ${s.detail}`);
  assertEqual(rep.corpus.plan_files_seen, 2, 'arquivos de plano vistos contados à parte dos admitidos');
  assertEqual(rep.corpus.plans_found, 0, 'nenhum admitido');
  assertEqual(rep.corpus.excluded.decomposed, 2, 'e continuam contados como DECOMPOSED');
  assert(rep.reconciliation.units.balances, 'a reconciliação fecha com o desfecho novo');
});

test('R8/R3 plan-swept continua reservado ao diretório sem NENHUM plano', () => {
  const root = newRepo('swept-only');
  sweptMilestone(root, M_SWEPT);
  const rep = observe(measureCoverage(root, {}));
  const s = rep.skipped.find((x) => x.unit === M_SWEPT);
  assertEqual(s.reason, 'plan-swept', 'zero planos → plan-swept');
  assert(/sem nenhum T##-PLAN\.md/.test(s.detail), 'e aqui a afirmação é verdadeira');
  assertEqual(rep.corpus.plan_files_seen, 0, 'nenhum arquivo de plano visto');
});

test('R8/R5 ref-divergent do delta vira razão própria, não "no-attributed-commits"', () => {
  const M_DIV = 'M-20990109000000-divergente';
  const root = newRepo('divergente');
  writeUnitPlan(root, M_DIV, 'S01', 'T01', { writes: ['src/**'], expected: [] });
  const delta = {
    vcs: 'git', units: [], units_measured: 0,
    commits_walked: 0, attributed: 0, unattributed: [],
    skipped: [{
      unit: M_DIV, ref: null, reason: 'ref-divergent',
      refs: [`refs/heads/forge/${M_DIV}`, `refs/remotes/origin/forge/${M_DIV}`],
    }],
  };
  const rep = observe(measureCoverage(root, { delta, refs: [{ id: M_DIV }] }));
  const s = rep.skipped.find((x) => x.unit === `${M_DIV}::S01/T01`);
  assert(s, `unidade não nomeada: ${JSON.stringify(rep.skipped)}`);
  assertEqual(s.reason, 'ref-divergent', 'a razão do delta é propagada, não reetiquetada');
  assert(s.detail.includes('refs/heads/forge/'), `os dois refs viajam no detail: ${s.detail}`);
  assert(s.detail.includes('refs/remotes/origin/forge/'), `os dois refs viajam no detail: ${s.detail}`);
  assert(!/nenhum commit com o escopo/.test(s.detail), 'não pode afirmar que se caminhou ref nenhum');
});

test('R3 as razões cruzam nos DOIS sentidos com SKIP_REASONS', () => {
  const produced = Array.from(reasonsSeen).sort();
  const undeclaredProduced = produced.filter((r) => !SKIP_REASONS.includes(r));
  assertDeep(undeclaredProduced, [], 'razões produzidas que o conjunto fechado não declara (descarte silencioso)');
  const neverSeen = SKIP_REASONS.filter((r) => !reasonsSeen.has(r)).sort();
  assertDeep(neverSeen, [], 'razões declaradas que nenhum cenário produziu (entrada decorativa)');
});

// ── R4: reconciliation ─────────────────────────────────────────────────────

test('R4 reconciliação fecha nas duas contas e vem no relatório, não só no assert', () => {
  const root = newRepo('recon');
  writeUnitPlan(root, M_GO, 'S01', 'T01', { writes: ['src/**'], expected: [] });
  writeUnitPlan(root, M_GO, 'S01', 'T02', { writes: ['.gsd/x.md'], expected: [] });
  writeUnitPlan(root, M_NOREF, 'S01', 'T01', { writes: ['src/**'], expected: [] });
  sweptMilestone(root, M_SWEPT);
  g(root, ['checkout', '-q', '-b', `forge/${M_GO}`]);
  commitFiles(root, ['src/a.ts'], 'feat(S01/T01): trabalho');
  commitFiles(root, ['r.txt'], 'fix(review): objeção');
  g(root, ['checkout', '-q', 'master']);

  const rep = observe(measureCoverage(root, {}));
  const ru = rep.reconciliation.units;
  assertEqual(ru.units_considered, ru.units_measured + ru.skipped, 'unidades fecham');
  assert(ru.balances, 'balances das unidades');
  const rc = rep.reconciliation.commits;
  assertEqual(rc.commits_walked, rc.attributed + rc.unattributed, 'commits fecham');
  assert(rc.balances, 'balances dos commits');
  for (const r of rep.reconciliation.refs) assert(r.balances, `ref ${r.ref} não fecha`);
  const walked = rep.reconciliation.refs.find((r) => r.ref.includes(M_GO));
  assertEqual(walked.source, 'vcs', 'o walked por ref é re-derivado do VCS, não reconstruído das partes');
});

test('R4 instrument_warning dispara quando Σ skipped > medidas, com a frase que separa "não achei" de "não há"', () => {
  const root = newRepo('warn');
  writeUnitPlan(root, M_NOREF, 'S01', 'T01', { writes: ['src/**'], expected: [] });
  writeUnitPlan(root, M_NOREF, 'S01', 'T02', { writes: ['src/**'], expected: [] });
  const rep = observe(measureCoverage(root, {}));
  assertEqual(rep.instrument_warning, true, 'campo aditivo');
  const md = renderMarkdown(rep);
  assert(md.includes('não achei'), 'a frase está no markdown');
  assert(md.includes('não há'), 'e distingue as duas coisas');
});

test('R4 a limitação git/Claude × SVN/codex é INCONDICIONAL (aparece até no inconclusive)', () => {
  const root = newRepo('lim');
  sweptMilestone(root, M_SWEPT);
  const rep = observe(measureCoverage(root, {}));
  assert(rep.limitation.includes('SVN'), 'campo no json');
  assert(renderMarkdown(rep).includes('não demonstra equivalência') || renderMarkdown(rep).includes('nada nesta medição'), 'parágrafo no markdown');
});

// ── R6: D6, negatively ─────────────────────────────────────────────────────

test('R6 nenhum caminho do módulo lê o log de evidência como fonte do lado escrito', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  assert(!src.includes('.jsonl'), 'o módulo não nomeia nenhum arquivo de log');
  assert(!/readFileSync\([^)]*evidence/i.test(src), 'o módulo não lê nenhum arquivo de evidência');
  assertEqual(/computeCoverage\s*\(/.test(String(cov.computeCoverage)), true, 'sanidade: a função existe');
  assert(!/evidence/i.test(String(cov.computeCoverage)), 'computeCoverage não consegue sequer VER o campo de evidência');
});

test('R6 o evidence contradiz o VCS e o coverage segue o VCS; remover o campo não muda o número', () => {
  const root = makeVerdictCorpus('d6', M_GO, ['src/**'], ['src/a.ts', 'lib/b.ts']);
  const evDir = path.join(root, '.gsd', 'forge');
  fs.mkdirSync(evDir, { recursive: true });
  // Um log que "prova" um mundo diferente: só arquivos declarados, nenhum
  // arquivo fora da declaração. Se ele fosse fonte, o coverage seria 100%.
  fs.writeFileSync(
    path.join(evDir, `evidence${'-'}${M_GO}${'~'}S01${'~'}execute-task,T01.jsonl`),
    `${JSON.stringify({ tool: 'Write', file: 'src/a.ts' })}\n`
  );
  const withEv = observe(measureCoverage(root, {}));
  const withoutEv = measureCoverage(root, { evidence: false });
  assertEqual(withEv.coverage, 0.5, 'o coverage é o do VCS (1 de 2), não o do log');
  assertEqual(withEv.coverage, withoutEv.coverage, 'remover o campo informativo não muda o coverage');
  assertEqual(withEv.verdict, withoutEv.verdict, 'nem o veredito');
  assert(withoutEv.units.every((u) => u.evidence_file === undefined), 'o campo some quando desligado');
});

// ── R7: what the corpus admits and refuses ─────────────────────────────────

test('R7 *-PLAN-GATE.md nunca vira unidade; status: DECOMPOSED é excluído e CONTADO', () => {
  const root = newRepo('corpus');
  const dir = writeUnitPlan(root, M_GO, 'S01', 'T01', { writes: ['src/**'], expected: [] });
  fs.writeFileSync(path.join(dir, 'T01-PLAN-GATE.md'), planBody({ writes: ['src/**'] }));
  writeUnitPlan(root, M_GO, 'S01', 'T02', { writes: ['src/**'], decomposed: true });
  const corpus = discoverCorpus(root);
  assertEqual(corpus.units.length, 1, 'só o plano canônico virou unidade');
  assertEqual(corpus.excluded.decomposed, 1, 'a exclusão é visível, não apenas verdadeira');
  assertEqual(corpus.units[0].unit, `${M_GO}::S01/T01`, 'chave composta');
});

test('R7 task solta entra pelo .gsd/tasks e sua chave é o próprio id (sem S##/T## abaixo)', () => {
  const root = newRepo('loose');
  const id = 'T-20990105000000-loose';
  writeLoosePlan(root, id, { writes: ['src/**'], expected: [], task: id });
  const corpus = discoverCorpus(root);
  assertEqual(corpus.units.length, 1, 'a task solta foi enumerada');
  assertEqual(corpus.units[0].unit, id, 'a chave é o id da task');
  assertEqual(corpus.units[0].slice, null, 'sem eixo de slice');
});

test('R7 o join indexa pela chave COMPOSTA: o mesmo par S##/T## em duas milestones não se mistura', () => {
  const root = newRepo('bait');
  writeUnitPlan(root, M_GO, 'S04', 'T01', { writes: ['a/**'], expected: [] });
  writeUnitPlan(root, M_RE, 'S04', 'T01', { writes: ['b/**'], expected: [] });
  g(root, ['checkout', '-q', '-b', `forge/${M_GO}`]);
  commitFiles(root, ['a/one.ts'], 'feat(S04/T01): milestone A');
  g(root, ['checkout', '-q', 'master']);
  g(root, ['checkout', '-q', '-b', `forge/${M_RE}`]);
  commitFiles(root, ['b/two.ts'], 'feat(S04/T01): milestone B');
  g(root, ['checkout', '-q', 'master']);

  const rep = observe(measureCoverage(root, {}));
  assertEqual(rep.units_measured, 2, 'duas unidades distintas');
  const a = rep.units.find((u) => u.owner === M_GO);
  const b = rep.units.find((u) => u.owner === M_RE);
  assertDeep(a.written, ['a/one.ts'], 'A ficou com os seus arquivos');
  assertDeep(b.written, ['b/two.ts'], 'B ficou com os seus');
  assertEqual(rep.coverage, 1, 'e cada uma casou a sua própria declaração');
});

test('R7 computeCoverage nunca divide por zero nem inventa um número sobre nada', () => {
  const empty = computeCoverage([]);
  assertEqual(empty.coverage, null, 'sem linhas → null, não 0 e não 1');
  assertEqual(empty.coverage_mean_per_unit, null, 'média idem');
});

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
