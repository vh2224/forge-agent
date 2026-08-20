#!/usr/bin/env node
'use strict';

// forge-claim-lease-repro.test.js — o incidente que originou a milestone, rodado
// ponta a ponta PELAS CLIs REAIS (S05/T05).
//
// ── Por que por spawn, e não por require ───────────────────────────────────
//
// As quatro tasks anteriores provaram peças ISOLADAS, cada uma chamando a
// função dona em processo. Isso é necessário e não é suficiente: um repro que
// passa chamando internals não prova que o OPERADOR consegue reproduzir. Aqui
// tudo passa por `spawnSync` das CLIs reais — `forge-claim-gate.js`,
// `forge-claim-release.js`, `forge-write-claim.js` — com `--cwd` apontando para
// o WORKSPACE da fixture e `--code-dir` para o repo git, que é a separação que o
// gate exige (B2) e que nenhuma chamada em processo exercita.
//
// ── As quatro fases ────────────────────────────────────────────────────────
//
//   F1  run A escreve e NÃO commita  -> B é recusada (block|defer), cause overlap
//   F2  ÚNICO delta = `git commit`   -> a MESMA invocação de B vira proceed,
//                                       e A sai do universo com skip NOMEADO
//   F4  claim vencido, A ATIVA       -> B SEGUE bloqueada  (controle negativo)
//   F3  mesmo relógio, A INATIVA     -> o TTL libera, com a expiração NOMEADA
//                                       lida do events.jsonl
//
// F4 roda ANTES de F3, sobre a MESMA fixture e o MESMO relógio: sem ele um TTL
// que liberasse tudo passaria nas outras três fases. É a exigência de D2 — o
// relógio é rede, nunca critério de posse.
//
// ── Fronteira desta repro, declarada e não omitida ─────────────────────────
//
// O eixo GIT é real (repositórios de verdade, `git` por `execFileSync`). O eixo
// SVN NÃO é exercitado aqui e não depende de `svn` instalado: ele é coberto pela
// suíte da T02 através do seam público de `forge-vcs.js` (`baselineId`,
// `workingStatus`), que é o mesmo ponto por onde o git passa. Esta repro roda em
// win32 sem nenhum binário além de `git` e `node`.
//
// ── Achado MEDIDO nesta task, e por que ele não vira assert de fantasia ────
//
// `claim-released:ttl-expired` NÃO é alcançável pelo caminho real do gate:
// `collectRunClaims` pula toda run com `active !== true` (skip `run-inactive`)
// ANTES de qualquer sonda de release, e `isHolderRunActive` — o predicado que a
// rede do TTL exige INATIVO — lê exatamente o mesmo campo `active`. As duas
// condições são mutuamente exclusivas por construção. Logo, na F3, o `proceed`
// de B é explicado pela INATIVIDADE de A, e a expiração nomeada vive na linha
// `claim-release` do `events.jsonl` (escrita pela CLI de release, que é onde a
// T04 pendurou o release: fronteira de unidade). Este arquivo assere as duas
// coisas SEPARADAMENTE e não finge que a linha `claim-gate` carrega o que ela
// não pode carregar. Ressuscitar a run para fabricar um assert verde seria
// exatamente o defeito que esta milestone existe para fechar.
//
// Zero deps. Runner standalone, convenção do repo: exit != 0 em falha.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const GATE_CLI = path.join(__dirname, 'forge-claim-gate.js');
const RELEASE_CLI = path.join(__dirname, 'forge-claim-release.js');
const WRITE_CLAIM_CLI = path.join(__dirname, 'forge-write-claim.js');
const RELEASE_MODULE = path.join(__dirname, 'forge-claim-release.js');
const SPEC = path.join(__dirname, '..', 'shared', 'forge-claim-gate.md');

/**
 * sha256 do módulo REAL no instante em que esta suíte começou. Toda mordida
 * confere contra ele DEPOIS de rodar: a mutação vive numa cópia, e este valor é
 * a prova de que ela ficou lá.
 */
const REAL_RELEASE_SHA = crypto.createHash('sha256')
  .update(fs.readFileSync(RELEASE_MODULE)).digest('hex');

const { CLAIM_RELEASE_REASONS, DEFAULT_TTL_MS, DEFAULT_GRACE_MS } = require('./forge-claim-release.js');
const { GATE_SKIP_REASONS, GATE_DECISIONS, GATE_CAUSES } = require('./forge-claim-gate.js');

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
    throw new Error(`${msg || 'divergência'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

// ── Fixture ────────────────────────────────────────────────────────────────

const tmps = [];
function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-lease-repro-'));
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

/** `git` com `cwd` explícito — nunca herdando o diretório do processo (Windows). */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Repo git real com `src/a.js` JÁ COMMITADO — para que a escrita de A seja `modified`. */
function makeRepo(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['checkout', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'fixture@example.com']);
  git(dir, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'module.exports = 1;\n', 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

/** Registry real de runs — molde de `forge-claim-gate.test.js::makeFixture`. */
function registerRun(ws, id, opts) {
  const o = opts || {};
  const file = path.join(ws, '.gsd', 'forge', 'runs', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    kind: 'milestone',
    id,
    session_id: `sess-${id}`,
    active: o.active === undefined ? true : o.active,
    started_at: 1785763253000,
    // Keep the run live while this repro isolates claim-release semantics.
    // Tests that need an old claim age write `write_claim.at` explicitly.
    last_heartbeat: Date.now(),
    worker: null,
    worker_started: null,
    isolation_mode: 'worktree',
    milestone_dir: `.gsd/milestones/${id}/`,
    cwd: ws,
  }, null, 2), 'utf8');
  return file;
}

function runFile(ws, id) {
  return path.join(ws, '.gsd', 'forge', 'runs', `${id}.json`);
}
function readRun(ws, id) {
  return JSON.parse(fs.readFileSync(runFile(ws, id), 'utf8'));
}
function patchRun(ws, id, patch) {
  const rec = Object.assign(readRun(ws, id), patch);
  fs.writeFileSync(runFile(ws, id), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}
/** Envelhece o claim: o "relógio adiantado" da fase 3/4, como DADO da fixture. */
function ageClaim(ws, id, ms) {
  const rec = readRun(ws, id);
  rec.write_claim.at = Date.now() - ms;
  fs.writeFileSync(runFile(ws, id), JSON.stringify(rec, null, 2), 'utf8');
  return rec.write_claim.at;
}

/** Um T##-PLAN.md de verdade, com `must_haves` estruturado (senão vira legacy). */
function writePlan(ws, taskId, file) {
  const rel = `.gsd/milestones/M-repro/slices/S01/tasks/${taskId}/${taskId}-PLAN.md`;
  const abs = path.join(ws, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, [
    '---', `id: ${taskId}`, 'writes:', `  - "${file}"`,
    'must_haves:', '  truths:', '    - "a task escreve o arquivo"',
    '  artifacts:', `    - path: "${file}"`, '      provides: "algo"', '      min_lines: 1',
    '  key_links: []',
    'expected_output: []', '---', '', `# ${taskId}`, '',
  ].join('\n'), 'utf8');
  return rel;
}

/**
 * Uma cópia ISOLADA de `scripts/*.js` com UMA substituição aplicada, e o caminho
 * da CLI do gate DENTRO dela.
 *
 * Por que copiar o diretório inteiro, e não só o módulo mordido: o gate é
 * spawnado como processo e resolve `require('./forge-claim-release.js')` por
 * caminho RELATIVO ao próprio arquivo. Mutar uma cópia solta em outro lugar não
 * afetaria o filho — foi essa constatação que, na primeira versão desta suíte,
 * levou a mutar o módulo REAL sob `__dirname` e restaurá-lo num `finally`.
 *
 * O modo de falha que isso deixava aberto é o motivo desta função existir:
 * `finally` NÃO roda sob SIGKILL. Uma suíte morta no meio de uma mordida deixava
 * a working tree do próprio repo com a prova de commit neutralizada — a cerca
 * aberta, PERSISTIDA em disco — e `git status` sujo como único sinal. Copiando
 * o diretório e spawnando de lá, a mutação vive num tmp dir descartável: nenhum
 * sinal, nenhum kill e nenhuma ordem de execução pode alcançar o módulo real.
 *
 * Molde: `forge-hook-rewrite.test.js` (§7), que copia `scripts/*.js` para um dir
 * isolado e roda dali uma cópia do script de entrada.
 */
function mutatedScriptsDir(needle, replacement) {
  const dir = path.join(mktmp('forge-lease-bite-'), 'scripts');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(__dirname)) {
    if (!f.endsWith('.js')) continue;
    fs.copyFileSync(path.join(__dirname, f), path.join(dir, f));
  }
  const target = path.join(dir, path.basename(RELEASE_MODULE));
  const original = fs.readFileSync(target, 'utf8');
  assertEqual(original.split(needle).length - 1, 1,
    'a mordida precisa casar EXATAMENTE uma vez — 0 ou 2 casamentos a tornariam vazia');
  fs.writeFileSync(target, original.replace(needle, replacement), 'utf8');
  return { dir, gate: path.join(dir, path.basename(GATE_CLI)) };
}

function cli(module, args) {
  const r = spawnSync(process.execPath, [module, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** Roda a CLI e devolve o JSON DO STDOUT DO PROCESSO — nunca um require. */
function cliJson(module, args) {
  const r = cli(module, args);
  assertEqual(r.status, 0, `CLI ${path.basename(module)} deveria avaliar (stderr: ${r.stderr})`);
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch (e) {
    throw new Error(`stdout não-JSON de ${path.basename(module)}: ${r.stdout.slice(0, 200)}`);
  }
  return parsed;
}

/** Linhas do events.jsonl da fixture, filtradas por evento — LIDAS DO ARQUIVO. */
function readEvents(ws, eventName) {
  const file = path.join(ws, '.gsd', 'forge', 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
    .filter((l) => !eventName || l.event === eventName);
}

const RUN_A = 'M-run-a';
const RUN_B = 'M-run-b';

/**
 * Fixture completa e no MESMO estado inicial das duas metades da repro:
 * workspace real com registry real, repo git real, claim de A gravado PELA CLI
 * do gate (baseline medido no instante do claim) e `src/a.js` sujo, não commitado.
 */
function buildFixture() {
  const tmp = mktmp();
  const ws = path.join(tmp, 'ws');
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(ws, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');
  makeRepo(repo);

  // A é registrada e reivindica ANTES de B existir: assim o próprio gate de A
  // não confronta ninguém e o único claim em jogo na F1 é o dela.
  registerRun(ws, RUN_A, { active: true });
  const aGate = cliJson(GATE_CLI, [
    '--claim-and-check', '--paths', 'src/a.js', '--run', RUN_A,
    '--unit', 'execute-task/T01', '--code-dir', repo, '--cwd', ws, '--json',
  ]);

  // A escreve — e NÃO commita.
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'module.exports = 2; // trabalho de A\n', 'utf8');

  registerRun(ws, RUN_B, { active: true });
  const planRel = writePlan(ws, 'T01', 'src/a.js');

  // A invocação de B, LITERAL e reusada byte a byte entre F1 e F2.
  const bArgs = [
    '--claim-and-check', '--plan', planRel, '--run', RUN_B,
    '--unit', 'execute-task/T01', '--code-dir', repo, '--cwd', ws, '--json',
  ];
  return { tmp, ws, repo, aGate, planRel, bArgs };
}

// ══════════════════════════════════════════════════════════════════════════
// F1 + F2 — a única diferença entre "recusada" e "passa" é o commit
// ══════════════════════════════════════════════════════════════════════════
console.log('\nF1/F2: o incidente e o commit que o encerra — mesma fixture, mesma invocação');

const fx = buildFixture();
let f1 = null;
let f2 = null;

test('F0: o claim de A foi gravado pela CLI com o baseline MEDIDO no instante do claim', () => {
  const claim = cliJson(WRITE_CLAIM_CLI, ['--show', RUN_A, '--cwd', fx.ws, '--json']);
  assert(claim !== null, 'o claim de A tem de estar persistido — cerca invisível não cerca');
  assertEqual(claim.code_dir, fx.repo, '--code-dir é fato DADO, gravado verbatim');
  assert(claim.vcs_baseline && claim.vcs_baseline.vcs === 'git' && /^[0-9a-f]{40}$/.test(claim.vcs_baseline.id),
    `o baseline "antes" precisa existir e ser um sha real, veio ${JSON.stringify(claim.vcs_baseline)}`);
  assertEqual(claim.released, null, 'nascer liberado tornaria toda a repro vazia');
  // A separação workspace × code_dir: o registry vive no WORKSPACE, não no repo.
  assert(fs.existsSync(runFile(fx.ws, RUN_A)), 'o registry vive sob --cwd (workspace)');
  assert(!fs.existsSync(path.join(fx.repo, '.gsd')), 'nada de .gsd é criado dentro do CODE_DIR');
});

test('F1: A escreveu e NÃO commitou -> B é recusada, com cause overlap, lida do stdout do processo', () => {
  f1 = cliJson(GATE_CLI, fx.bArgs);
  assert(['block', 'defer'].includes(f1.decision),
    `a decisão precisa ser bloqueante, veio ${f1.decision}`);
  assertEqual(f1.cause, 'overlap', 'a colisão é MEDIDA — nunca reportada como undeclared-writes');
  assert(f1.paths.includes('src/a.js'), `o path em disputa é nomeado, veio ${JSON.stringify(f1.paths)}`);
  assertEqual(f1.census.counterparts_in_scope, 1, 'A tem de estar EM ESCOPO — mesmo code_dir medido');
  assertEqual(f1.released_counterparts.length, 0, 'nada foi liberado ainda');
  assert(!f1.census.skipped.some((s) => String(s.reason).startsWith('claim-released:')),
    'nenhum skip de release na F1 — o simétrico da F2 sobre a MESMA fixture');
});

test('F2: ÚNICO delta = git commit -> a MESMA invocação passa, e A sai com skip NOMEADO', () => {
  const headBefore = git(fx.repo, ['rev-parse', 'HEAD']).trim();
  git(fx.repo, ['add', 'src/a.js']);
  git(fx.repo, ['commit', '-q', '-m', 'A commita seu trabalho']);
  const headAfter = git(fx.repo, ['rev-parse', 'HEAD']).trim();
  assert(headBefore !== headAfter, 'o commit precisa ter acontecido de verdade');
  assertEqual(git(fx.repo, ['status', '--porcelain']).trim(), '', 'depois do commit a árvore está limpa');

  f2 = cliJson(GATE_CLI, fx.bArgs); // args LITERALMENTE os mesmos da F1
  assertEqual(f2.decision, 'proceed', 'depois do commit de A, B passa');
  assertEqual(f2.census.counterparts_in_scope, 0, 'A saiu do universo');
  const rel = f2.released_counterparts.find((r) => r.id === RUN_A);
  assert(rel, `A precisa aparecer em released_counterparts, veio ${JSON.stringify(f2.released_counterparts)}`);
  assertEqual(rel.mechanism, 'committed');
  assertEqual(rel.reason, 'released-committed');
  assert(f2.census.skipped.some((s) => s.id === RUN_A && s.reason === 'claim-released:committed'),
    `o skip precisa ser NOMEADO no censo, veio ${JSON.stringify(f2.census.skipped)}`);
  assert(!f2.census.notes.some((n) => n.id === RUN_A && n.reason === 'claim-absent'),
    'um claim liberado JAMAIS pode virar claim-absent (contrato #6) — release não é undeclared-writes');
});

test('F1×F2: o delta entre as duas é o commit e NADA MAIS — args idênticos, fixture idêntica', () => {
  assert(f1 && f2, 'as duas fases precisam ter rodado');
  assert(f1.decision !== f2.decision, 'sem mudança de decisão a repro não prova nada');
  assertEqual(f1.run, f2.run, 'mesma run própria');
  assertEqual(JSON.stringify(f1.claim.paths), JSON.stringify(f2.claim.paths), 'mesmo claim derivado do MESMO plano');
  assertEqual(f1.claim.code_dir, f2.claim.code_dir, 'mesmo code_dir');
  assertEqual(f1.census.counterparts_considered, f2.census.counterparts_considered,
    'o universo considerado é o mesmo: o que mudou foi o que a sonda MEDIU nele');
});

test('F2b: a linha claim-gate da F2 no events.jsonl carrega o counterpart liberado, lida do arquivo', () => {
  const gateLines = readEvents(fx.ws, 'claim-gate').filter((l) => l.run === RUN_B);
  assert(gateLines.length >= 2, `as duas avaliações de B precisam ter deixado evento, vieram ${gateLines.length}`);
  const last = gateLines[gateLines.length - 1];
  assertEqual(last.decision, 'proceed');
  assert((last.released_counterparts || []).some((r) => r.id === RUN_A && r.mechanism === 'committed'),
    'o evento precisa registrar QUEM saiu e por qual mecanismo');
  const first = gateLines[gateLines.length - 2];
  assertEqual(first.cause, 'overlap', 'o simétrico: a linha da F1 registra a colisão');
});

// ══════════════════════════════════════════════════════════════════════════
// MORDIDA contra o MÓDULO REAL — sem ela a F2 poderia estar verde por acidente
// ══════════════════════════════════════════════════════════════════════════
console.log('\nMordida: neutralizar a conjunção das duas sondas deixa a F2 VERMELHA');
{
  test('BITE-a: com a prova de commit neutralizada, a F2 volta a bloquear', () => {
    const needle = 'if (f.baseline_advanced === true && f.paths_in_flight === false) {';
    // A conjunção precisa casar EXATAMENTE uma vez — conferido contra o módulo
    // REAL (lido, nunca escrito) antes de qualquer cópia: se a needle deixar de
    // existir no real, a mordida vira vazia mesmo casando na cópia.
    assertEqual(fs.readFileSync(RELEASE_MODULE, 'utf8').split(needle).length - 1, 1,
      'a needle precisa casar 1× no MÓDULO REAL — senão a mordida perdeu o sujeito');

    // Fixture NOVA, e isso é o ponto: desde S05/review R3 o gate PERSISTE o
    // veredito `committed` que corroborou, então a `fx` da F2 já carrega o
    // envelope e uma reavaliação ali sairia por `released-explicit` — a prova
    // neutralizada nunca seria consultada e a mordida ficaria VAZIA (verde por
    // ausência de premissa, não por mérito). A mordida precisa de um mundo onde
    // nenhuma avaliação anterior persistiu nada.
    const bfx = buildFixture();
    git(bfx.repo, ['add', 'src/a.js']);
    git(bfx.repo, ['commit', '-q', '-m', 'A commita seu trabalho']);
    assertEqual(git(bfx.repo, ['status', '--porcelain']).trim(), '', 'a fixture da mordida está commitada');
    assertEqual(readRun(bfx.ws, RUN_A).write_claim.released, null,
      'a fixture da mordida NÃO pode nascer com envelope — senão a mordida é vazia');

    // A mutação vive numa CÓPIA descartável de `scripts/`, e o gate é spawnado
    // DE LÁ: nenhum `finally` é necessário, logo nenhum SIGKILL pode deixar o
    // módulo real neutralizado na working tree.
    const bite = mutatedScriptsDir(needle, 'if (false) {');
    const bitten = cliJson(bite.gate, bfx.bArgs);
    assertEqual(sha256(RELEASE_MODULE), REAL_RELEASE_SHA,
      'o módulo real segue byte-idêntico — sha256 conferido, não presumido');

    assert(bitten && bitten.decision !== 'proceed',
      `com a prova neutralizada a F2 tem de ficar vermelha, veio ${bitten && bitten.decision}`);
    assertEqual(bitten.cause, 'overlap');
    assertEqual(bitten.released_counterparts.length, 0, 'sem prova, ninguém sai do universo');
    assertEqual(readRun(bfx.ws, RUN_A).write_claim.released, null,
      'sem veredito corroborado, NADA pode ter sido persistido no claim alheio');

    // Controle positivo: a MESMA fixture, avaliada pelo gate REAL, passa. É o
    // que garante que o vermelho acima veio da mutação e não da cópia — a cópia
    // difere do real por essa única substituição, e por nada mais.
    assertEqual(cliJson(GATE_CLI, bfx.bArgs).decision, 'proceed',
      'pelo gate real o mesmo comando passa — a única diferença é a mutação da cópia');
  });

  // ── BITE-b (D16): a mordida da doutrina NOVA ────────────────────────────
  //
  // A BITE-a morde a CONJUNÇÃO (duas sondas), que é doutrina de S05 e continua
  // de pé. Ela não morde o que D16 acrescentou: que a sonda A é sobre O
  // TRABALHO DESTE CLAIM, não sobre a árvore. Com a sonda A imprecisa ("a
  // baseline andou"), um commit de A FORA dos paths que ela reivindicou
  // satisfazia a prova e a cerca abria em definitivo — que é o defeito #1 do
  // review, o caso do claim-união T01+T02.
  //
  // Esta mordida cerca exatamente isso: neutralizar a PRECISÃO (devolver a
  // sonda A ao fato cru `baseline_moved`) tem de fazer a F2 LIBERAR
  // INDEVIDAMENTE — a direção oposta à da BITE-a, e é essa oposição que prova
  // que as duas mordem coisas diferentes.
  test('BITE-b: com a PRECISÃO da sonda A neutralizada, um commit fora dos paths libera indevidamente', () => {
    const needle = '  facts.baseline_advanced = hits.length > 0;';
    assertEqual(fs.readFileSync(RELEASE_MODULE, 'utf8').split(needle).length - 1, 1,
      'a atribuição da sonda precisa tem de casar 1× no MÓDULO REAL — senão a mordida perdeu o sujeito');

    // Fixture onde A commita algo que NÃO é o path reivindicado (`src/a.js`), e
    // desfaz o próprio voo. É o instante do claim-união: árvore limpa, baseline
    // andada, e o trabalho reivindicado AINDA POR VIR.
    const bfx = buildFixture();
    git(bfx.repo, ['checkout', '--', 'src/a.js']);
    fs.writeFileSync(path.join(bfx.repo, 'outro.js'), '// commit da T01, fora do claim\n', 'utf8');
    git(bfx.repo, ['add', 'outro.js']);
    git(bfx.repo, ['commit', '-q', '-m', 'A commita FORA dos paths reivindicados']);
    assertEqual(git(bfx.repo, ['status', '--porcelain']).trim(), '', 'a árvore da mordida está limpa');
    assertEqual(readRun(bfx.ws, RUN_A).write_claim.released, null,
      'a fixture da mordida NÃO pode nascer com envelope — senão a mordida é vazia');

    // Estado SÃO, com o módulo real: a sonda A precisa recusa, B fica bloqueada.
    const sane = cliJson(GATE_CLI, bfx.bArgs);
    assert(sane.decision !== 'proceed',
      `com a sonda A precisa, o commit fora dos paths NÃO pode liberar A, veio ${sane.decision}`);
    assertEqual(sane.cause, 'overlap');
    assertEqual(sane.released_counterparts.length, 0, 'ninguém sai do universo por um commit alheio ao claim');

    // A neutralização é EXATAMENTE a sonda pré-D16 (a árvore andou) e vive numa
    // cópia descartável de `scripts/` — o real nunca é escrito, então um SIGKILL
    // aqui não pode deixar a cerca aberta na working tree do repo.
    const bite = mutatedScriptsDir(needle, '  facts.baseline_advanced = facts.baseline_moved;');
    const bitten = cliJson(bite.gate, bfx.bArgs);
    assertEqual(sha256(RELEASE_MODULE), REAL_RELEASE_SHA,
      'o módulo real segue byte-idêntico — sha256 conferido, não presumido');

    assertEqual(bitten.decision, 'proceed',
      'com a precisão neutralizada a cerca abre — é este o defeito que D16 fecha');
    assert((bitten.released_counterparts || []).some((r) => r.id === RUN_A && r.mechanism === 'committed'),
      'e abre pelo mecanismo errado: `committed` sobre um commit que não tocou o claim');

    // O dano é IRREVERSÍVEL, e isso é medido, não narrado: o gate PERSISTIU o
    // envelope no claim de A. Restaurar o módulo não fecha a cerca de volta —
    // a próxima avaliação sai por `released-explicit`. É por isso que a
    // imprecisão da sonda A não era um erro de leitura, e sim uma perda de
    // cerca definitiva.
    const envelope = readRun(bfx.ws, RUN_A).write_claim.released;
    assert(envelope && envelope.mechanism === 'committed',
      'a mordida tem de deixar o envelope gravado — é o dano que ela cerca');
    assertEqual(cliJson(GATE_CLI, bfx.bArgs).decision, 'proceed',
      'e pelo GATE REAL a cerca segue aberta: released-explicit, não há como desfazer');

    // Controle positivo sobre uma fixture VIRGEM — a de cima não serve mais,
    // justamente porque foi contaminada. Sem este controle, uma cópia que
    // divergisse do real por mais do que a mutação passaria despercebida.
    const cfx = buildFixture();
    git(cfx.repo, ['checkout', '--', 'src/a.js']);
    fs.writeFileSync(path.join(cfx.repo, 'outro.js'), '// idem\n', 'utf8');
    git(cfx.repo, ['add', 'outro.js']);
    git(cfx.repo, ['commit', '-q', '-m', 'A commita FORA dos paths reivindicados']);
    assert(cliJson(GATE_CLI, cfx.bArgs).decision !== 'proceed',
      'pelo gate real, a MESMA situação bloqueia');
  });

  // ── S05/review R3, sobre git REAL: o veredito vivo virou registro ─────────
  test('R3: o `committed` que a F2 corroborou foi PERSISTIDO no claim de A (release monotônico)', () => {
    const claimA = readRun(fx.ws, RUN_A).write_claim;
    assert(claimA.released, 'o envelope tem de existir — sem persistência o release re-bloqueia na próxima unidade');
    assertEqual(claimA.released.mechanism, 'committed');
    assertEqual(claimA.released.evidence.observed_by, 'claim-gate',
      'a origem do envelope é nomeada: quem observou foi o gate de B, não o dono');
    assertEqual(claimA.paths.includes('src/a.js'), true, 'persistir NUNCA apaga o claim — só acrescenta o envelope');
    const rel = f2.released_counterparts.find((r) => r.id === RUN_A);
    assertEqual(rel.persisted, true, 'o resultado diz que o REGISTRO passou a concordar com o veredito');

    // A monotonicidade, medida: sujar o path de novo (trabalho NÃO relacionado)
    // não pode ressuscitar o bloqueio — que era exatamente a objeção R3.
    fs.writeFileSync(path.join(fx.repo, 'src', 'a.js'), '// trabalho novo, alheio ao claim de A\n', 'utf8');
    assert(git(fx.repo, ['status', '--porcelain']).trim() !== '', 'a árvore precisa estar suja de novo');
    const after = cliJson(GATE_CLI, fx.bArgs);
    assertEqual(after.decision, 'proceed',
      'REGRESSÃO R3: o path sujo re-bloqueou um counterpart já provado committed — release não-monotônico');
    const rel2 = after.released_counterparts.find((r) => r.id === RUN_A);
    assertEqual(rel2.mechanism, 'explicit', 'a segunda avaliação sai pelo ENVELOPE persistido, não por sondar de novo');
  });
}

// ══════════════════════════════════════════════════════════════════════════
// F4 + F3 — o relógio é REDE, nunca critério de posse (D2)
// ══════════════════════════════════════════════════════════════════════════
console.log('\nF4/F3: mesmo relógio, duas respostas — o que decide é a run estar viva');

const fx2 = buildFixture();
// A rede do TTL exige `paths_in_flight !== true` (PR #110, `#2(c)`): árvore suja
// nos paths reivindicados é a assinatura de *checkpointed*, não de abandonado, e
// a rede corretamente se recusa a recolher esse claim. A `buildFixture` deixa
// `src/a.js` escrito e não commitado — o estado da F1/F2 — então a F3 precisa
// desfazer o VOO para medir o que é o seu sujeito: a expiração por inatividade.
//
// O desfazer é `checkout --` do path reivindicado: limpa o voo SEM avançar a
// baseline (HEAD intocado, conferido abaixo). Assim o único delta entre F4 e F3
// continua sendo `active`, que é o controle que o par inteiro carrega — se a F3
// commitasse para limpar, ela sairia por `released-committed` e o par não
// provaria nada sobre o TTL.
{
  const headBefore = git(fx2.repo, ['rev-parse', 'HEAD']).trim();
  git(fx2.repo, ['checkout', '--', 'src/a.js']);
  assert(git(fx2.repo, ['status', '--porcelain']).trim() === '',
    'a F3 exige a árvore limpa — senão a rede recusa por paths em voo');
  assert(git(fx2.repo, ['rev-parse', 'HEAD']).trim() === headBefore,
    'e exige a baseline PARADA — limpar o voo não pode virar prova de commit');
}
const AGED_MS = DEFAULT_TTL_MS + DEFAULT_GRACE_MS + 60000;
const agedAt = ageClaim(fx2.ws, RUN_A, AGED_MS);
let f4status = null;
let f3status = null;

test('F4 (controle negativo): claim vencido + run A ATIVA -> claim MANTIDO e B segue bloqueada', () => {
  assertEqual(readRun(fx2.ws, RUN_A).active, true, 'a fase 4 exige A viva');
  f4status = cliJson(RELEASE_CLI, ['--status', RUN_A, '--cwd', fx2.ws, '--json']);
  assertEqual(f4status.facts.ttl_expired, true, 'a janela ttl+grace precisa estar vencida — senão o controle é vazio');
  assertEqual(f4status.facts.owner_active, true, 'A está ativa');
  assertEqual(f4status.held, true, 'uma run viva NUNCA perde o claim para o relógio (D2)');
  assertEqual(f4status.reason, 'held-uncommitted');

  const b = cliJson(GATE_CLI, fx2.bArgs);
  assert(['block', 'defer'].includes(b.decision), `B segue bloqueada, veio ${b.decision}`);
  assertEqual(b.cause, 'overlap');
  assertEqual(b.census.counterparts_in_scope, 1, 'A continua em escopo — nada expirou');
});

test('F4b: o pedido de release é RECUSADO e nada é gravado enquanto A está viva', () => {
  const r = cliJson(RELEASE_CLI, ['--release', RUN_A, '--cwd', fx2.ws, '--json']);
  assertEqual(r.released, false);
  assertEqual(r.refusal, 'not-observable', 'a recusa é NOMEADA');
  assertEqual(readRun(fx2.ws, RUN_A).write_claim.released, null, 'nada foi gravado no claim');
});

test('F3: ÚNICO delta = A marcada inativa (mesmo relógio) -> TTL libera, expiração NOMEADA', () => {
  patchRun(fx2.ws, RUN_A, { active: false });
  assertEqual(readRun(fx2.ws, RUN_A).write_claim.at, agedAt, 'o relógio da F3 é o MESMO da F4');

  f3status = cliJson(RELEASE_CLI, ['--release', RUN_A, '--cwd', fx2.ws, '--json']);
  assertEqual(f3status.released, true, 'com a run morta a rede tem de recolher o claim');
  assertEqual(f3status.reason, 'released-ttl-expired');
  assertEqual(f3status.mechanism, 'ttl-expired');
  assertEqual(f3status.facts.owner_active, false, 'o delta medido é a inatividade');
  assertEqual(f3status.facts.ttl_expired, true);
  // O simétrico, sobre a MESMA fixture: F4 disse held com os MESMOS fatos de relógio.
  assertEqual(f4status.facts.ttl_expired, f3status.facts.ttl_expired,
    'a idade é idêntica nas duas fases — o que mudou foi a posse, não o relógio');
  assert(f4status.held !== f3status.held, 'sem inversão de veredito o par não prova nada');

  const envelope = readRun(fx2.ws, RUN_A).write_claim.released;
  assert(envelope && envelope.mechanism === 'ttl-expired', 'o envelope persistido nomeia o mecanismo');
});

test('F3b: a expiração NOMEADA está no events.jsonl da fixture, lida do arquivo', () => {
  const lines = readEvents(fx2.ws, 'claim-release').filter((l) => l.run === RUN_A);
  assert(lines.length >= 2, `o pedido recusado (F4b) e o concedido (F3) deixam evento, vieram ${lines.length}`);
  const last = lines[lines.length - 1];
  assertEqual(last.reason, 'released-ttl-expired', 'a expiração é NOMEADA no evento, não inferida');
  assertEqual(last.mechanism, 'ttl-expired');
  assertEqual(last.held, false);
  const refused = lines[lines.length - 2];
  assertEqual(refused.held, true, 'o simétrico: o pedido recusado também deixou linha');
  assertEqual(refused.reason, 'held-uncommitted');
});

test('F3c: B passa — e o censo diz POR QUE, sem atribuir ao release o que a inatividade fez', () => {
  const b = cliJson(GATE_CLI, fx2.bArgs);
  assertEqual(b.decision, 'proceed', 'com A morta e o claim recolhido, B passa');
  assertEqual(b.reason, 'no-active-counterpart');
  // O achado medido, asserido em vez de narrado: uma run inativa é pulada como
  // `run-inactive` ANTES de qualquer sonda de release, então o `proceed` de B
  // NÃO é obra do TTL. `claim-released:ttl-expired` continua sendo o registro
  // correto do que aconteceu — na linha `claim-release`, escrita pela CLI de
  // release na fronteira de unidade (T04), que é onde a rede realmente atua.
  assert(b.census.skipped.some((s) => s.id === RUN_A && s.reason === 'run-inactive'),
    `A precisa aparecer pulada por inatividade, veio ${JSON.stringify(b.census.skipped)}`);
  assertEqual(b.released_counterparts.length, 0,
    'nenhum release é atribuído ao gate nesta fase — a sonda nem foi feita');
});

// ══════════════════════════════════════════════════════════════════════════
// O spec — a afirmação de over-block não pode ter sobrevivido à S05
// ══════════════════════════════════════════════════════════════════════════
console.log('\nSPEC: § Release lifecycle substituiu a afirmação de over-block (com controle positivo)');
{
  // Predicado ÚNICO, aplicado ao arquivo real E ao texto pré-S05 embutido: um
  // predicado que só é rodado contra o alvo que se espera limpo é um detector
  // que nunca foi visto morder.
  const FORBIDDEN = [
    { re: /claims are not released/i, what: 'a afirmação de que claims nunca são liberados' },
    { re: /§ Over-block/, what: 'a referência à seção § Over-block' },
    { re: /Over-block between S04 and S05/, what: 'o título da seção de over-block' },
    { re: /em S04 o claim NÃO é liberado pelo commit/, what: 'o aviso do § Step 4' },
  ];
  const REQUIRED = /^## Release lifecycle/m;

  // Literal PRÉ-S05 (extraído do que a T04 removeu) — o controle positivo.
  const PRE_S05 = [
    '### Over-block between S04 and S05 is design, not a bug',
    '',
    'Between this gate going live (S04) and release-on-commit (S05), **claims are not released**. A',
    'counterpart that already committed and finished still holds its claim.',
    '',
    '   1. Aguardar o commit da run counterpart e re-rodar esta unidade.',
    '      (Atenção: em S04 o claim NÃO é liberado pelo commit — ver § Over-block abaixo.)',
  ].join('\n');

  function offendersIn(text) {
    return FORBIDDEN.filter((f) => f.re.test(text)).map((f) => f.what);
  }

  test('SPEC-a: o arquivo real NÃO carrega mais nenhuma das afirmações de over-block', () => {
    const text = fs.readFileSync(SPEC, 'utf8');
    const hits = offendersIn(text);
    assertEqual(hits.length, 0, `o spec ainda afirma over-block: ${hits.join('; ')}`);
  });

  test('SPEC-b: o arquivo real contém o § Release lifecycle', () => {
    const text = fs.readFileSync(SPEC, 'utf8');
    assert(REQUIRED.test(text), 'o § Release lifecycle precisa existir — remover a afirmação sem pôr o contrato no lugar é meia entrega');
  });

  test('SPEC-c: CONTROLE POSITIVO — o MESMO predicado acusa os 4 padrões no texto pré-S05', () => {
    const hits = offendersIn(PRE_S05);
    assertEqual(hits.length, FORBIDDEN.length,
      `todo padrão precisa morder no texto antigo (senão é detector cego), acusou ${hits.length} de ${FORBIDDEN.length}`);
    assert(!REQUIRED.test(PRE_S05), 'o texto antigo não tem § Release lifecycle — a checagem de presença também morde');
  });

  test('SPEC-d: o spec real linka a CLI de release (o contrato aponta para código que existe)', () => {
    const text = fs.readFileSync(SPEC, 'utf8');
    assert(text.includes('forge-claim-release.js'), 'o § Release lifecycle sem a CLI seria contrato sem implementação');
  });
}

// ══════════════════════════════════════════════════════════════════════════
// Conjuntos fechados — direção 1 sobre TUDO que esta repro observou
// ══════════════════════════════════════════════════════════════════════════
console.log('\nSETS: nada que esta repro observou cai fora dos conjuntos fechados');
{
  test('SETS-a: razões de release observadas ⊂ CLAIM_RELEASE_REASONS', () => {
    const seen = [f4status.reason, f3status.reason].filter(Boolean);
    assert(seen.length >= 2, 'as duas fases do par precisam ter razão');
    for (const r of seen) {
      assert(CLAIM_RELEASE_REASONS.includes(r), `razão fora do conjunto fechado: ${r}`);
    }
  });

  test('SETS-b: decisões, causas e skips observados ⊂ conjuntos do gate', () => {
    const results = [f1, f2].filter(Boolean);
    for (const r of results) {
      assert(GATE_DECISIONS.includes(r.decision), `decisão fora do conjunto: ${r.decision}`);
      if (r.cause) assert(GATE_CAUSES.includes(r.cause), `causa fora do conjunto: ${r.cause}`);
      for (const s of r.census.skipped) {
        if (s.reason === 'run-inactive') continue; // vem do conjunto da S03, não do gate
        assert(GATE_SKIP_REASONS.includes(s.reason), `skip fora do conjunto: ${s.reason}`);
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════
// GUARD — a mordida nunca mais escreve sob `scripts/` do repo
// ══════════════════════════════════════════════════════════════════════════
//
// Um conserto que depende de ninguém regredir não é conserto. As duas provas:
// (a) o sha do módulo real no fim da suíte é o do começo — comportamental;
// (b) o TEXTO desta suíte não contém escrita para dentro de `__dirname` —
//     estrutural, o que morde a REINTRODUÇÃO do padrão, não só o seu efeito.
console.log('\nGUARD: nenhuma mordida escreve no módulo real');
{
  const SELF = __filename;
  // Escrita cujo destino é derivado de `__dirname` (onde vivem os módulos reais)
  // ou a constante `RELEASE_MODULE`. A cópia da mordida escreve em `target`,
  // derivado do tmp dir — fora deste predicado por construção.
  // `copyFileSync` fica FORA da lista de propósito: o primeiro argumento dele é
  // a ORIGEM, e `mutatedScriptsDir` legitimamente lê de `__dirname` para copiar
  // PARA o tmp dir. Incluí-lo acusaria a própria correção. A limitação fica
  // nomeada: uma cópia cujo DESTINO fosse `scripts/` escaparia deste predicado —
  // o GUARD-a (sha do módulo real) é a rede comportamental para esse caso.
  const FORBIDDEN_WRITE = /(?:writeFileSync|appendFileSync|rmSync|truncateSync|openSync)\s*\(\s*(?:RELEASE_MODULE|GATE_CLI|WRITE_CLAIM_CLI|RELEASE_CLI|SPEC|path\.join\(__dirname)/;

  test('GUARD-a: o módulo real terminou a suíte byte-idêntico ao que começou', () => {
    assertEqual(sha256(RELEASE_MODULE), REAL_RELEASE_SHA,
      'alguma coisa nesta suíte escreveu em scripts/forge-claim-release.js');
  });

  test('GUARD-b: o TEXTO desta suíte não escreve em nenhum caminho sob scripts/ do repo', () => {
    const text = fs.readFileSync(SELF, 'utf8');
    assert(!FORBIDDEN_WRITE.test(text),
      'reintroduziram escrita no módulo real: SIGKILL deixaria a cerca aberta na working tree');
  });

  test('GUARD-c: CONTROLE POSITIVO — o MESMO predicado acusa o padrão antigo', () => {
    // Montado por concatenação DE PROPÓSITO: escrito inteiro, este literal
    // seria acusado pelo GUARD-b acima — o detector morderia o próprio controle.
    const W = 'writeFile' + 'Sync';
    const PRE_FIX = [
      '    try {',
      `      fs.${W}(RELEASE_MODULE, original.replace(needle, 'if (false) {'), 'utf8');`,
      '    } finally {',
      `      fs.${W}(RELEASE_MODULE, original, 'utf8');`,
      '    }',
    ].join('\n');
    assert(FORBIDDEN_WRITE.test(PRE_FIX),
      'o predicado precisa morder a forma antiga — senão é detector cego');
    assert(FORBIDDEN_WRITE.test(`fs.${W}(path.join(__` + `dirname, 'forge-claim-release.js'), x)`),
      'e precisa morder o desvio óbvio: reconstruir o caminho a partir de __dirname');
  });
}

// ── Fecho ──────────────────────────────────────────────────────────────────
cleanup();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFalhas:');
  for (const f of failures) console.log(`  · ${f.name}: ${f.error}`);
  process.exit(1);
}
