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
// milestone). O range `merge-base..HEAD` acusa qualquer commit da branch, não só
// os da curadoria — e a branch legitimamente carrega o commit de OUTRA task
// (T-20260819190830, achado A2 do review da PR #125) que acrescenta ao
// `forge-sweep/SKILL.md` a regra de leitura de `quarantined:true`. Sob o range,
// esta cerca condenava a task errada. Ela pergunta, por commit, se foi a
// curadoria que tocou o arquivo.
const CURATE_SUBJECT = /curate|curadoria/i;
test('a curadoria não alterou skills/forge-sweep', () => {
  assert(fs.existsSync(sweepPath));
  const repo = path.join(__dirname, '..');
  const git = args => require('child_process').spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  const working = git(['diff', '--name-only', '--', 'skills/forge-sweep/SKILL.md']);
  assert.strictEqual(working.status, 0, `git indisponível: ${working.stderr || working.error}`);
  if (working.stdout.trim()) {
    // Uma edição não commitada não tem autoria atribuível — não existe assunto
    // de commit para perguntar. Skip NOMEADO, nunca um verde afirmando limpeza.
    console.log('    ↳ perna de working tree pulada (nomeada): edição não commitada em skills/forge-sweep é inatribuível');
  }
  const base = ['master', 'origin/master']
    .map(ref => git(['merge-base', 'HEAD', ref]))
    .find(result => result.status === 0 && result.stdout.trim());
  if (!base) {
    // Named skip, never a silent pass: without a base ref the committed range
    // is unmeasurable and this check reports exactly that.
    console.log('    ↳ pulado (nomeado): merge-base indisponível — nem master nem origin/master resolvem');
    return;
  }
  const log = git(['log', '--format=%H %s', `${base.stdout.trim()}..HEAD`, '--', 'skills/forge-sweep/SKILL.md']);
  assert.strictEqual(log.status, 0, `git log merge-base..HEAD falhou: ${log.stderr}`);
  const commits = log.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  // Piso anti-silêncio: o minerador tem que ser capaz de ver um assunto de
  // curadoria. Controle positivo — se o predicado não morde nem no assunto que
  // ele existe para pegar, a cerca é cega e o verde não vale nada.
  assert(CURATE_SUBJECT.test('abc curate xyz'), 'predicado de assunto cego');
  const offenders = commits.filter(line => CURATE_SUBJECT.test(line.slice(41)));
  assert.deepStrictEqual(offenders, [], `commit da curadoria alterou skills/forge-sweep:\n${offenders.join('\n')}`);
  console.log(`    ↳ commits examinados que tocam skills/forge-sweep: ${commits.length}`);
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
