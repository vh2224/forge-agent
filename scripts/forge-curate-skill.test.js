'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const clusters = require('./forge-memory-clusters');
const curate = require('./forge-sweep-curate');

const skillPath = path.join(__dirname, '..', 'skills', 'forge-curate', 'SKILL.md');
const sweepPath = path.join(__dirname, '..', 'skills', 'forge-sweep', 'SKILL.md');
const source = fs.readFileSync(skillPath, 'utf8');
const frontmatterMatch = source.match(/^---\n([\s\S]*?)\n---/);
const body = source.slice(frontmatterMatch ? frontmatterMatch[0].length : 0);
let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (error) { failed += 1; console.log(`  ✗ ${name}: ${error.message}`); }
}

function frontmatter() {
  assert(frontmatterMatch, 'frontmatter ausente');
  const fields = {};
  for (const line of frontmatterMatch[1].split('\n')) {
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return fields;
}

function flags(text) { return [...new Set([...text.matchAll(/--[a-z][a-z-]*/g)].map(match => match[0]))].sort(); }
function accepted(parse, flag) {
  const args = flag === '--apply' ? ['--apply', '--arbitration', 'decisions.json']
    : flag === '--undo' ? ['--undo']
      : flag === '--json' ? ['--json'] : flag === '--help' ? ['--help']
        : flag === '--yes' ? ['--apply', '--arbitration', 'decisions.json', '--yes']
        : [flag, flag === '--cwd' || flag === '--arbitration' || flag === '--min-score' ? (flag === '--min-score' ? '0.4' : '.') : ''];
  parse(args.filter(Boolean));
}

function example() {
  const match = source.match(/Exemplo mínimo válido[\s\S]*?```json\n([\s\S]*?)\n```/);
  assert(match, 'exemplo JSON ausente');
  return JSON.parse(match[1]);
}

function planForExample() {
  return { clusters: [{ id: 'M001::MEM001|M002::MEM002', items: [
    { storage_key: 'M001', mem_id: 'MEM001' }, { storage_key: 'M002', mem_id: 'MEM002' },
  ] }] };
}

console.log('\n=== forge-curate-skill.test.js ===\n');

test('arquivo, diretório e tamanho são substantivos', () => {
  assert(fs.existsSync(skillPath));
  assert(fs.statSync(path.dirname(skillPath)).isDirectory());
  assert(source.split('\n').length >= 120);
});

test('frontmatter declara identidade, ferramenta e invocação humana', () => {
  const fields = frontmatter();
  assert.strictEqual(fields.name, 'forge-curate');
  assert(fields.description);
  assert(fields['allowed-tools'].includes('AskUserQuestion'));
  assert.strictEqual(fields['disable-model-invocation'], 'true');
  assert(body.includes('## Invocation policy'));
  assert(/invoca[çc][ãa]o HUMANA/i.test(body));
});

// The claim is about the CURATE work's provenance — "a curadoria não estendeu a
// mão para dentro do forge-sweep" —, so the working tree alone cannot answer it:
// once committed, an unbased `git diff` reads clean and the guard goes green
// while blind. Measure the committed range too.
//
// ATRIBUIÇÃO POR COMMIT, NÃO POR RANGE (precedente medido: S07 desta mesma
// milestone, `scripts/forge-smoke.js` § (e)). O range `merge-base..HEAD` acusa
// qualquer commit da branch, não só os da curadoria — e a branch legitimamente
// carrega o commit de OUTRA task (T-20260819190830, achado A2 do review da
// PR #125) que acrescenta ao `forge-sweep/SKILL.md` a regra de leitura de
// `quarantined:true`. Sob o range, esta cerca condenava a task errada.
//
// DOIS PRONGS, como o precedente (`isS07 = assunto OU caminho exclusivo`). O
// prong de assunto sozinho tem escape MEDIDO nesta branch: dos 3 commits que
// tocam caminho exclusivo da curadoria, só 1 traz `curate` no assunto — os
// outros dois ("fix(review): S07 conceded item …") escapariam da cerca inteira.
//
// O QUE NÃO ENTRA NA LISTA, e por quê: `scripts/forge-curate-skill.test.js` foi
// criado pela curadoria (6ad9e2b), mas é o INSTRUMENTO de medição, não o
// produto. Um instrumento que conta a própria edição como prova de autoria do
// medido é circular — toda task que endurece esta cerca (inclusive esta) viraria
// "a curadoria". A lista carrega só o produto.
const CURATE_SUBJECT = /curate|curadoria/i;
const CURATE_EXCLUSIVE = [
  'skills/forge-curate/',              // prefixo de diretório
  'scripts/forge-sweep-curate.js',
  'scripts/forge-sweep-curate.test.js',
];
const SWEEP_REL = 'skills/forge-sweep/SKILL.md';
// Predicado de caminho, compartilhado pelas duas pernas (commit e working tree).
// Função pura de propósito: é o que torna a mordida de cada perna provável sobre
// estado sintético, sem depender do que a branch por acaso tem em disco.
function touchesCurate(files) {
  return files.some(f => CURATE_EXCLUSIVE.some(e => (e.endsWith('/') ? f.startsWith(e) : f === e)));
}
function isCurateCommit(c) { return CURATE_SUBJECT.test(c.subject) || touchesCurate(c.files); }
// Veredicto da working tree — MESMA lógica de dois prongs, por co-ocorrência de
// caminho. Uma edição não commitada não tem assunto, mas tem caminhos: se ela
// toca forge-sweep E TAMBÉM caminho exclusivo da curadoria, é a curadoria
// mexendo e a cerca REPROVA; se toca forge-sweep sozinho, é inatribuível pelo
// mesmo critério e vira skip NOMEADO. Isso fecha a janela de falso negativo sem
// reintroduzir o falso positivo medido (a edição legítima do achado A2).
function workingVerdict(paths) {
  if (!paths.includes(SWEEP_REL)) return 'clean';
  return touchesCurate(paths) ? 'fail' : 'skip';
}

test('a curadoria não alterou skills/forge-sweep', () => {
  assert(fs.existsSync(sweepPath));
  const repo = path.join(__dirname, '..');
  const git = args => require('child_process').spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  // A lista é confirmada no disco: um caminho renomeado faria o prong parar de
  // casar em silêncio, que é a forma de falha que esta milestone inteira caça.
  for (const entry of CURATE_EXCLUSIVE) {
    assert(fs.existsSync(path.join(repo, entry)), `caminho exclusivo da curadoria sumiu do disco: ${entry}`);
  }

  // Perna 1: working tree, dois prongs.
  const status = git(['status', '--porcelain']);
  assert.strictEqual(status.status, 0, `git indisponível: ${status.stderr || status.error}`);
  const workingPaths = status.stdout.split('\n').map(line => line.slice(3).trim())
    .filter(Boolean).map(line => (line.includes(' -> ') ? line.split(' -> ')[1] : line))
    .map(line => line.replace(/^"|"$/g, ''));
  const verdict = workingVerdict(workingPaths);
  assert.notStrictEqual(verdict, 'fail',
    `working tree: a curadoria tocou ${SWEEP_REL} (co-ocorrência com caminho exclusivo):\n${workingPaths.join('\n')}`);
  if (verdict === 'skip') {
    console.log(`    ↳ perna de working tree pulada (nomeada): ${SWEEP_REL} editado sem co-ocorrência com caminho exclusivo da curadoria — inatribuível`);
  }

  // Perna 2: range commitado, dois prongs, atribuição por commit.
  const base = ['master', 'origin/master']
    .map(ref => git(['merge-base', 'HEAD', ref]))
    .find(result => result.status === 0 && result.stdout.trim());
  if (!base) {
    // Named skip, never a silent pass: without a base ref the committed range
    // is unmeasurable and this check reports exactly that.
    console.log('    ↳ pulado (nomeado): merge-base indisponível — nem master nem origin/master resolvem');
    return;
  }
  const shas = (git(['rev-list', `${base.stdout.trim()}..HEAD`]).stdout || '').split('\n').filter(Boolean);
  const commits = shas.map(sha => ({
    sha,
    subject: (git(['log', '-1', '--format=%s', sha]).stdout || '').trim(),
    files: (git(['show', '--name-only', '--format=', sha]).stdout || '')
      .split('\n').map(line => line.trim()).filter(Boolean),
  }));
  const selected = commits.filter(isCurateCommit);
  const bySubject = selected.filter(commit => CURATE_SUBJECT.test(commit.subject));
  const onlyByPath = selected.filter(commit => !CURATE_SUBJECT.test(commit.subject));
  const offenders = selected.filter(commit => commit.files.includes(SWEEP_REL))
    .map(commit => `${commit.sha.slice(0, 7)} ${commit.subject}`);
  assert.deepStrictEqual(offenders, [], `commit da curadoria alterou skills/forge-sweep:\n${offenders.join('\n')}`);

  // CONTROLE POSITIVO SOBRE A POPULAÇÃO REAL, nunca contra uma constante — um
  // assert do regex contra uma string literal testa o literal, não o minerador.
  // O censo é impresso sempre; quando a população não sustenta um piso, a
  // limitação é NOMEADA em vez de o controle passar sem olhar dado.
  console.log(`    ↳ censo: ${commits.length} commits no range · ${selected.length} da curadoria`
    + ` (${bySubject.length} por assunto, ${onlyByPath.length} SÓ por caminho exclusivo)`);
  if (selected.length === 0) {
    console.log('    ↳ controle limitado (nomeado): nenhum commit da curadoria nesta população — o seletor não pôde ser visto mordendo na população real');
  } else if (onlyByPath.length > 0) {
    console.log(`    ↳ segundo prong mordeu na população real: ${onlyByPath.map(c => c.sha.slice(0, 7)).join(', ')} escapariam do prong de assunto`);
  } else {
    console.log('    ↳ limitação nomeada: nesta população o prong de caminho não acrescentou commit ao conjunto do prong de assunto');
  }
});

// Mordida de cada perna nova, sobre estado SINTÉTICO — o repo real só oferece um
// estado por vez, então provar "reprova" exige montar o estado que deve reprovar.
test('as duas pernas mordem: co-ocorrência reprova, forge-sweep sozinho pula', () => {
  assert.strictEqual(workingVerdict([SWEEP_REL, 'scripts/forge-sweep-curate.js']), 'fail',
    'co-ocorrência na working tree tem que REPROVAR');
  assert.strictEqual(workingVerdict([SWEEP_REL, 'skills/forge-curate/SKILL.md']), 'fail',
    'co-ocorrência por prefixo de diretório tem que REPROVAR');
  assert.strictEqual(workingVerdict([SWEEP_REL, 'scripts/forge-distill.js']), 'skip',
    'forge-sweep sem co-ocorrência é inatribuível — skip nomeado, não reprovação');
  assert.strictEqual(workingVerdict([SWEEP_REL, 'scripts/forge-curate-skill.test.js']), 'skip',
    'o instrumento de medição não é prova de autoria do medido — seria circular');
  assert.strictEqual(workingVerdict(['scripts/forge-sweep-curate.js']), 'clean',
    'sem tocar forge-sweep não há o que atribuir');
  // O prong de commit, mordendo nos dois sentidos.
  assert.strictEqual(isCurateCommit({ subject: 'fix(review): S07 conceded item', files: ['scripts/forge-sweep-curate.js'] }), true,
    'o assunto genérico que ESCAPAVA da cerca tem que ser pego pelo caminho exclusivo');
  assert.strictEqual(isCurateCommit({ subject: 'feat: curadoria de memória', files: ['outro.js'] }), true,
    'o prong de assunto continua valendo sozinho');
  assert.strictEqual(isCurateCommit({ subject: 'fix(review): A2 instrução aos consumidores', files: [SWEEP_REL, 'scripts/forge-curate-skill.test.js'] }), false,
    'editar a cerca + forge-sweep não é a curadoria — o falso positivo medido continua fechado');
});

test('Steps 3, 5 e 6 mantêm a ordem operacional', () => {
  const s3 = body.indexOf('### Step 3');
  const s5 = body.indexOf('### Step 5');
  const s6 = body.indexOf('### Step 6');
  assert(s3 >= 0 && s5 > s3 && s6 > s5);
  assert(body.includes('forge-memory-clusters.js --cwd . --json'));
  assert(body.includes('AskUserQuestion'));
  assert(body.includes('node scripts/forge-sweep-curate.js --apply --arbitration <file>'));
  assert(/nunca escreve\s+fragmento diretamente/i.test(body));
  assert(!/\.gsd\/memory[^\n]*(?:>|rm\b|delete|escrev)/i.test(body));
});

test('cada lote oferece revisão individual e cancelamento', () => {
  const step = body.slice(body.indexOf('### Step 5'), body.indexOf('### Step 6'));
  assert(/um `AskUserQuestion` por lote/i.test(step));
  assert(step.includes('revisar um a um'));
  assert(step.includes('cancelar'));
  assert(/TODO lote/i.test(step));
  assert(body.indexOf('recomendação') < body.indexOf('### Step 5'));
});

test('caps são interpolados das constantes reais', () => {
  assert(new RegExp(`máximo ${clusters.CLUSTERS_PER_BATCH} clusters`).test(body));
  assert(new RegExp(`máximo ${clusters.ITEMS_PER_CLUSTER} itens`).test(body));
  assert.strictEqual(clusters.CLUSTERS_PER_BATCH, 3);
  assert.strictEqual(clusters.ITEMS_PER_CLUSTER, 8);
});

test('todas as flags da skill existem nos parseArgs reais', () => {
  const skillFlags = flags(source);
  const clusterParse = clusters._private.parseArgs;
  const curateParse = curate._private.parseArgs;
  const clusterFlags = ['--cwd', '--min-score', '--json', '--help'];
  const curateFlags = ['--cwd', '--arbitration', '--apply', '--undo', '--yes', '--json', '--help'];
  for (const flag of skillFlags) {
    assert(clusterFlags.includes(flag) || curateFlags.includes(flag), `flag não mapeada: ${flag}`);
    if (clusterFlags.includes(flag)) accepted(clusterParse, flag);
    if (curateFlags.includes(flag)) accepted(curateParse, flag);
  }
  // Negative direction proved against the real parsers, not against a token
  // planted in the doc text: an undocumented flag must be rejected by name.
  for (const [label, parse] of [['clusters', clusterParse], ['curate', curateParse]]) {
    assert.throws(() => parse(['--out', 'arquivo.json']), /desconhecido: --out/i, `${label} aceitou --out`);
  }
});

test('exemplo embutido é aceito pelo validador real', () => {
  const doc = example();
  curate.validateArbitrationShape(doc, planForExample());
  assert.strictEqual(doc.clusters[0].items.filter(item => item.verdict === 'manter').length, 1);
});

test('declara explicitamente o limite de forge-auto e os caminhos suportados', () => {
  assert(/não roda em `\/forge-auto`/i.test(body));
  assert(body.includes('/forge-next'));
  assert(/invoca[çc][ãa]o direta do\s+operador/i.test(body));
});

test('documenta journal id e undo exato', () => {
  assert(body.includes('journal id'));
  assert(body.includes('node scripts/forge-sweep-curate.js --undo --yes'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
