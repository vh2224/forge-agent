'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeFragment } = require('./forge-memory');
const {
  DETECTOR_VERSION,
  DETECTOR_FINGERPRINT_TABLES,
  DETECTOR_FINGERPRINT_FUNCTIONS,
  METALINGUISTIC_EXTENSION_REASON,
  computeDetectorVersion,
  detectMentions,
  detectSignalMentions,
  detectorFalsePositive,
  classifyCitationPrecision,
  measureF2,
} = require('./forge-index-f2');

// Helper for the noise-rule tests: [raw, motivo] for every detected mention.
function fpOf(text) {
  return detectMentions(text).map((item) => [item.raw, detectorFalsePositive(item)]);
}

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`ok - ${name}`); }
  catch (error) { console.error(`not ok - ${name}`); throw error; }
}
function snapshotTree(root) {
  const result = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      const stat = fs.statSync(target);
      result.push({ path: path.relative(root, target), size: stat.size, mtime: stat.mtimeMs, isDirectory: entry.isDirectory() });
      if (entry.isDirectory()) walk(target);
    }
  }
  walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
function fact(mem_id, text) { return { mem_id, category: 'test', text, created_at: '2026-01-01T00:00:00Z', source_unit: 'T01' }; }
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-'));
  fs.mkdirSync(path.join(cwd, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'scripts', 'covered.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(cwd, 'scripts', 'partial.js'), 'module.exports = 1;');
  fs.writeFileSync(path.join(cwd, 'scripts', 'other.md'), '# other\n');
  writeFragment(cwd, {
    unit_id: 'T01',
    facts: [
      fact('f-covered', '`scripts/covered.js`'),
      fact('f-partial', '`scripts/partial.js` e other.py'),
      fact('f-missed', 'Veja scripts/absent.js'),
      fact('f-no-mention', 'Uma decisão sem arquivo.'),
      fact('f-fp', 'O plano T01-PLAN.md foi revisado.'),
      fact('f-noise', 'A versão 1.2.0 e o caminho e/ou são ruído.'),
    ],
  });
  return cwd;
}

test('detector usa vocabulário independente e largo', () => {
  const source = fs.readFileSync(path.join(__dirname, 'forge-index-f2.js'), 'utf8');
  const body = source.slice(source.indexOf('function detectMentions'), source.indexOf('function detectorFalsePositive'));
  assert(!body.includes('CODE_EXT'));
  assert(!body.includes('CITATION_REGEXES'));
  const mentions = detectMentions('`arquivo.weird` src/a/b token.js 1.2.0');
  assert.deepStrictEqual(mentions.map((item) => item.normalized), ['arquivo.weird', 'b', 'token.js', '1.2.0']);
  assert(mentions.every((item) => item.raw && item.why));
});

test('detecta ruído próprio sem ocultá-lo', () => {
  const report = detectMentions('A versão 1.2.0 e o fluxo e/ou foram citados.');
  assert(report.some((item) => item.normalized === '1.2.0'));
  assert(report.some((item) => item.raw === 'e/ou'));
});

test('precision enumera a citação -PLAN.md', () => {
  const mentions = detectMentions('O plano T01-PLAN.md foi revisado.');
  const citations = [{ raw: '-PLAN.md', path: '-PLAN.md', line: null, pattern: 'bare-basename' }];
  const fp = classifyCitationPrecision(citations, mentions, 'synthetic');
  assert.strictEqual(fp.length, 1);
  assert.strictEqual(fp[0].mem_id, 'synthetic');
  assert.strictEqual(fp[0].raw, '-PLAN.md');
});

test('mede covered, partial, missed e no-mention por listas', () => {
  const cwd = fixture();
  try {
    const report = measureF2(cwd);
    // S02 R1 (review-fix): o denominador passou de 5 para 4 — `f-noise` (versão
    // nua + `e/ou`) deixou de contar como fato que menciona arquivo, e com isso
    // deixou de ser `missed`. Não é ajuste de expectativa: é a mudança de
    // denominador sancionada pelo review.
    assert.strictEqual(report.facts_that_mention_file, 4);
    assert.strictEqual(report.facts_covered.length, 3);
    assert.strictEqual(report.facts_missed_total.length, 0);
    assert.strictEqual(report.facts_missed_partial.length, 1);
    assert.strictEqual(report.facts_no_mention.length, 2);
    assert.strictEqual(report.facts_missed_partial[0].missing_mentions[0].normalized, 'other.py');
    assert.strictEqual(report.f2_recall, 1 - 1 / 4);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('publica resolution_rate e identidade de motivos', () => {
  const cwd = fixture();
  try {
    const report = measureF2(cwd);
    const sum = Object.values(report.unresolved_by_reason).reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, report.citations_total - report.citations_resolved);
    assert.strictEqual(report.resolution_rate, report.citations_resolved / report.citations_total);
    assert(report.detector_false_positives.some((item) => item.raw.includes('1.2.0')));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('denominador vazio gera verdict próprio e recall nulo', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-empty-'));
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('empty', 'somente prosa')] });
    const report = measureF2(cwd);
    assert.strictEqual(report.verdict, 'EMPTY-DENOMINATOR');
    assert.strictEqual(report.f2_recall, null);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('a medição é read-only', () => {
  const cwd = fixture();
  try {
    const before = snapshotTree(cwd);
    measureF2(cwd);
    const after = snapshotTree(cwd);
    assert.deepStrictEqual(after, before);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('CLI JSON tem uma linha e exit 0', () => {
  const cwd = fixture();
  try {
    const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-index-f2.js'), '--cwd', cwd, '--json'], { encoding: 'utf8' });
    assert.strictEqual(cli.status, 0);
    const lines = cli.stdout.trim().split(/\r?\n/);
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(JSON.parse(lines[0]).verdict, 'MEASURED');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('CLI rejeita argumento desconhecido com exit 2', () => {
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-index-f2.js'), '--wat'], { encoding: 'utf8' });
  assert.strictEqual(cli.status, 2);
  assert(JSON.parse(cli.stderr).error);
});

test('classificador mantém raw, motivo e mem_id', () => {
  const result = classifyCitationPrecision(
    [{ raw: '`x.weird`', path: 'x.weird' }],
    [{ raw: 'x.js', normalized: 'x.js', why: 'suffix' }],
    'f-precision',
  );
  assert.deepStrictEqual(result, [{
    mem_id: 'f-precision',
    raw: '`x.weird`',
    motivo: 'citação extraída sem menção independente correspondente',
  }]);
});

test('relatório expõe buckets derivados sem contador oculto', () => {
  const cwd = fixture();
  try {
    const report = measureF2(cwd);
    assert.strictEqual(report.coverage_identity, true);
    assert.strictEqual(report.fact_counts.covered, report.facts_covered.length);
    assert.strictEqual(report.fact_counts.partial, report.facts_missed_partial.length);
    assert.strictEqual(report.fact_counts.missed, report.facts_missed_total.length);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// ── S02 R1 (review-fix): ruído do detector fora do denominador ───────────────
test('menção só-ruído não conta como missed; menção real ainda conta', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-noise-'));
  try {
    writeFragment(cwd, {
      unit_id: 'T01',
      facts: [
        fact('só-ruído', 'A versão 3.1.2 apareceu e/ou não.'),
        // `.py` é extensão REAL fora do CODE_EXT do extrator: continua sinal
        // (gap do extrator), diferente de `.weird`, que virou ruído enumerado.
        fact('menção-real', 'Veja outro.py aqui.'),
      ],
    });
    const report = measureF2(cwd);
    // O fato só-ruído sai do denominador inteiro (não é missed nem partial).
    assert.strictEqual(report.facts_that_mention_file, 1);
    assert.deepStrictEqual(report.facts_missed_total.map((item) => item.mem_id), ['menção-real']);
    assert.deepStrictEqual(report.facts_no_mention.map((item) => item.mem_id), ['só-ruído']);
    assert.strictEqual(report.f2_recall, 0);
    // O descarte permanece ENUMERADO — diagnóstico preservado, nunca silencioso.
    assert(report.detector_false_positives.some((item) => item.raw.includes('3.1.2')));
    assert(report.detector_false_positives.some((item) => item.raw === 'e/ou'));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('detectSignalMentions remove o ruído que detectMentions ainda reporta', () => {
  const text = 'A versão 3.1.2 e/ou o arquivo real.js.';
  assert.strictEqual(detectMentions(text).length, 3);
  assert.deepStrictEqual(detectSignalMentions(text).map((item) => item.normalized), ['real.js']);
});

// ── Ruído do instrumento (censo 2026-08-15): cada regra com caso que morde ───
// Cada teste asserta o MOTIVO exato: reverter a regra específica muda o motivo
// (ou o torna null) e o teste falha — nenhuma regra é coberta por outra.

test('cleanToken tira pontuação à esquerda: (forge-smoke.js normaliza igual à citação', () => {
  // Revert da limpeza à esquerda → normalized vira '(forge-smoke.js' e diverge
  // da citação que o extrator produz corretamente (8 misses fantasma medidos).
  const mentions = detectMentions('Guard em (forge-smoke.js e (install.sh, hoje.');
  assert.deepStrictEqual(mentions.map((item) => item.normalized), ['forge-smoke.js', 'install.sh']);
  assert.deepStrictEqual(detectMentions("'forge-runs.js")[0].normalized, 'forge-runs.js');
  // Continuam sinal — a limpeza não pode criar falso positivo.
  assert.deepStrictEqual(detectSignalMentions('(forge-smoke.js').map((item) => item.normalized), ['forge-smoke.js']);
});

test('abreviação latina e.g/i.e é ruído nomeado, não arquivo', () => {
  const motivo = 'abreviação latina (e.g/i.e), não arquivo';
  // O motivo é assertado por igualdade: sem a regra dedicada, `(e.g.,` cairia
  // na regra de sufixo genérica e o motivo mudaria — o teste morde a regra certa.
  const eg = detectMentions('(e.g., exemplo')[0];
  assert.strictEqual(eg.normalized, 'e.g');
  assert.strictEqual(detectorFalsePositive(eg), motivo);
  const ie = detectMentions('(i.e. isto')[0];
  assert.strictEqual(detectorFalsePositive(ie), motivo);
  // Composto ('threshold—e.g.,') não é a abreviação nua: cai na regra de sufixo
  // — ainda ruído, mas com a razão que de fato o classifica.
  assert.deepStrictEqual(
    fpOf('threshold—e.g., fora.'),
    [['threshold—e.g.,', 'sufixo não é extensão de arquivo real (identificador com ponto)']],
  );
});

test('placeholder/template/glob é ruído nomeado: ##, {x}, <x>, *', () => {
  const motivo = 'placeholder/template/glob (##, {x}, <x>, *), não um arquivo concreto';
  // `T##-PLAN.md` morde: o sufixo `.md` é extensão REAL, então só a regra de
  // placeholder o descarta — revert → volta a ser menção-sinal e o teste falha.
  for (const raw of ['T##-PLAN.md', 'runs/{id}.json', 'agent-<id>.jsonl', 'evidence-*.jsonl', 'xllm-state-{unitId}.json']) {
    const mention = detectMentions(raw)[0];
    assert(mention, `${raw} deve ser detectado antes de ser classificado`);
    assert.strictEqual(detectorFalsePositive(mention), motivo, raw);
  }
  // Um plano concreto continua sinal: a regra não engole T01-PLAN.md.
  assert.strictEqual(detectorFalsePositive(detectMentions('T01-PLAN.md')[0]), null);
});

test('token entre crases sem extensão e sem barra é keyword/flag, não arquivo', () => {
  const motivo = 'keyword/flag entre crases, sem extensão de arquivo nem barra';
  // '`default`' morde: sem ponto e sem barra, NENHUMA outra regra o alcança —
  // revert → detectorFalsePositive volta null e o strictEqual falha.
  for (const raw of ['`default`', '`--cwd`', '`if`', '`domain:`', '`expected_output`']) {
    assert.strictEqual(detectorFalsePositive(detectMentions(raw)[0]), motivo, raw);
  }
  // Crases com extensão real ou com barra continuam sinal.
  assert.strictEqual(detectorFalsePositive(detectMentions('`forge-hook.js`')[0]), null);
  assert.strictEqual(detectorFalsePositive(detectMentions('`scripts/forge-hook.js`')[0]), null);
});

test('referência a diretório entre crases (barra final) é ruído nomeado', () => {
  // '`.gsd/`' morde: basename vazio escapa das regras de sufixo e de crases
  // (tem barra) — sem esta regra vira menção permanentemente incasável.
  assert.strictEqual(detectorFalsePositive(detectMentions('`.gsd/`')[0]), 'referência a diretório (termina em /), não arquivo');
});

test('sufixo que não é extensão de arquivo real é identificador, não arquivo', () => {
  const motivo = 'sufixo não é extensão de arquivo real (identificador com ponto)';
  // 'JSON.parse' morde: não é crase, não é placeholder, não é versão — só a
  // regra de extensão-real o descarta; revert → volta a inflar o denominador.
  for (const raw of ['JSON.parse', 'turn.id', 'cmd.exe', 'v2.0', 'it.skip', 'evidence.mode']) {
    const mention = detectMentions(raw)[0];
    assert(mention, `${raw} deve ser detectado antes de ser classificado`);
    assert.strictEqual(detectorFalsePositive(mention), motivo, raw);
  }
  // Extensões reais fora do CODE_EXT do extrator PERMANECEM sinal: o detector
  // continua uma segunda observação mais larga (gap do extrator visível).
  for (const raw of ['events.jsonl', 'seed.txt', 'GitActivity.swift', 'other.py', 'main.go']) {
    assert.strictEqual(detectorFalsePositive(detectMentions(raw)[0]), null, raw);
  }
  assert.strictEqual(detectorFalsePositive(detectMentions('`.svn`')[0]), null, 'dotfile arbitrário não depende de cadastro semântico');
});

test('descarte das novas classes é enumerado no relatório com motivo nomeado', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-inst-'));
  try {
    writeFragment(cwd, {
      unit_id: 'T01',
      facts: [fact('só-instrumento', 'Formatos (e.g., `--cwd`) em T##-PLAN.md via JSON.parse e `.gsd/`.')],
    });
    const report = measureF2(cwd);
    // O fato sai do denominador (nenhuma menção-sinal restante)...
    assert.strictEqual(report.verdict, 'EMPTY-DENOMINATOR');
    assert.deepStrictEqual(report.facts_no_mention.map((item) => item.mem_id), ['só-instrumento']);
    // ...mas cada classe descartada aparece CONTADA com sua razão nomeada.
    const byRaw = new Map(report.detector_false_positives.map((item) => [item.raw, item.motivo]));
    assert.strictEqual(byRaw.get('(e.g.,'), 'abreviação latina (e.g/i.e), não arquivo');
    assert.strictEqual(byRaw.get('`--cwd`)'), 'keyword/flag entre crases, sem extensão de arquivo nem barra');
    assert.strictEqual(byRaw.get('T##-PLAN.md'), 'placeholder/template/glob (##, {x}, <x>, *), não um arquivo concreto');
    assert.strictEqual(byRaw.get('JSON.parse'), 'sufixo não é extensão de arquivo real (identificador com ponto)');
    assert.strictEqual(byRaw.get('`.gsd/`.'), 'referência a diretório (termina em /), não arquivo');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

// ── #107: duas classes que o detector contava como sinal e o extrator estava
// CERTO em ignorar. Corrigi-las no DETECTOR, e não alargando o extrator, é a
// diferença entre subtrair ruído do denominador e fabricar citação irresolúvel.

test('#107 lista de tokens entre crases unida por / não é caminho', () => {
  const motivo = 'lista de tokens entre crases unida por /, não um caminho';
  const fps = new Map(fpOf('Os campos `writes:`/`expected_output:` do frontmatter.'));
  assert.strictEqual([...fps.values()][0], motivo, JSON.stringify([...fps]));
  assert.deepStrictEqual(detectSignalMentions('Os campos `writes:`/`expected_output:` ali.'), []);

  // Controle: um caminho REAL entre crases não tem crase por dentro depois de
  // desembrulhado, então continua sendo sinal. Sem este assert a regra poderia
  // matar toda citação backticada e o teste acima ainda passaria.
  assert.deepStrictEqual(
    detectSignalMentions('Veja `scripts/forge-runs.js` aqui.').map((m) => m.normalized),
    ['forge-runs.js']);
});

test('#107 par de extensões nuas unidas por / não é arquivo', () => {
  const motivo = 'par/lista de extensões nuas unidas por /, não um arquivo concreto';
  const fps = new Map(fpOf('O wrapper existe nas formas (.cmd/.bat) no PATH.'));
  assert.strictEqual(fps.get('(.cmd/.bat)'), motivo, JSON.stringify([...fps]));
  assert.deepStrictEqual(detectSignalMentions('Formas (.cmd/.bat) no PATH.'), []);

  // Controles nas DUAS direções em que a regra poderia ser larga demais:
  // um dotfile real com barra tem segmento que não é extensão...
  assert.deepStrictEqual(
    detectSignalMentions('O arquivo src/.env é lido em runtime.').map((m) => m.normalized),
    ['.env']);
  // ...e um dotfile solto não tem barra nenhuma, então a regra nem a alcança.
  assert.deepStrictEqual(detectSignalMentions('Leia o .env da raiz.').map((m) => m.normalized), ['.env']);
});

test('#126 gramática metalinguística cobre singular, plural, pontuação, listas e crases', () => {
  for (const text of [
    'A extensão .md é tratada de forma especial.',
    'As extensões .js e .ts são aceitas.',
    'Extensões: .swift, .kt ou .tsx.',
    'Use a extensão `.env` neste exemplo.',
    'Extensões .js,.ts e .tsx.',
    'Extensões:.js;.ts.',
    'Extensões – .js — .ts.',
  ]) {
    const mentions = detectMentions(text);
    assert.ok(mentions.length > 0, text);
    assert.ok(mentions.every((mention) => detectorFalsePositive(mention) === METALINGUISTIC_EXTENSION_REASON), text);
    assert.deepStrictEqual(detectSignalMentions(text), [], text);
  }
});

test('#126 palavras lexicais interrompem o governo e dotfiles concretos permanecem sinais', () => {
  for (const text of [
    'A extensão do arquivo .env deve ser preservada.',
    'Leia o .env da raiz.',
    'Crie .md agora.',
    'Consulte src/.env durante o boot.',
    'Leia `.npmrc` antes de instalar.',
    'O arquivo .md tem extensão conhecida.',
  ]) {
    assert.ok(detectSignalMentions(text).length > 0, text);
  }
});

test('#126 contexto público aditivo sobrevive a JSON e spread e torna o descarte diagnóstico', () => {
  const mention = detectMentions('A extensão .md é metalinguagem.')[0];
  assert.deepStrictEqual(Object.keys(mention), ['raw', 'normalized', 'why', 'detector_context']);
  const roundTripped = JSON.parse(JSON.stringify(mention));
  const spread = { ...mention };
  assert.deepStrictEqual(roundTripped, mention);
  assert.deepStrictEqual(spread, mention);
  assert.strictEqual(detectorFalsePositive(roundTripped), METALINGUISTIC_EXTENSION_REASON);
  assert.strictEqual(detectorFalsePositive(spread), METALINGUISTIC_EXTENSION_REASON);
  assert.strictEqual(detectorFalsePositive(mention), METALINGUISTIC_EXTENSION_REASON);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'f2-meta-ext-'));
  try {
    writeFragment(cwd, { unit_id: 'T01', facts: [fact('meta', 'Extensões: .js, .ts e .tsx.')] });
    const report = measureF2(cwd);
    assert.strictEqual(report.detector_version, DETECTOR_VERSION);
    assert.strictEqual(report.verdict, 'EMPTY-DENOMINATOR');
    assert.strictEqual(report.detector_false_positives.length, 3);
    assert.ok(report.detector_false_positives.every((item) => item.motivo === METALINGUISTIC_EXTENSION_REASON));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('#126 classifica pelo texto apenas e expõe identidade estável da taxonomia', () => {
  const text = 'Extensões .md e .env; depois leia src/.env.';
  assert.deepStrictEqual(detectMentions(text), detectMentions(text));
  assert.match(DETECTOR_VERSION, /^sha256:[a-f0-9]{64}$/);
  assert.strictEqual(DETECTOR_VERSION, computeDetectorVersion());
  assert.notStrictEqual(
    computeDetectorVersion({
      tables: { ...DETECTOR_FINGERPRINT_TABLES, real_file_ext: [...DETECTOR_FINGERPRINT_TABLES.real_file_ext, 'changed'] },
    }),
    DETECTOR_VERSION,
    'alterar o vocabulário efetivo deve necessariamente alterar o fingerprint');
  assert.notStrictEqual(
    computeDetectorVersion({
      tables: {
        ...DETECTOR_FINGERPRINT_TABLES,
        compiled_regexes: {
          ...DETECTOR_FINGERPRINT_TABLES.compiled_regexes,
          list_conjunction_at: {
            ...DETECTOR_FINGERPRINT_TABLES.compiled_regexes.list_conjunction_at,
            flags: DETECTOR_FINGERPRINT_TABLES.compiled_regexes.list_conjunction_at.flags.replace('i', ''),
          },
        },
      },
    }),
    DETECTOR_VERSION,
    'remover uma flag efetivamente compilada deve alterar o fingerprint');
  assert.notStrictEqual(
    computeDetectorVersion({
      functions: DETECTOR_FINGERPRINT_FUNCTIONS.map((fn) => fn.name === 'detectorFalsePositive'
        ? function detectorFalsePositive() { return 'changed'; }
        : fn),
    }),
    DETECTOR_VERSION,
    'alterar o comportamento serializado do detector deve necessariamente alterar o fingerprint');
});

test('#126 scanner adjacente não confunde caminhos com listas metalinguísticas', () => {
  assert.deepStrictEqual(detectSignalMentions('Extensões src/.env e lib/.npmrc.').map((item) => item.normalized), ['.env', '.npmrc']);
  assert.deepStrictEqual(detectSignalMentions('Leia src/.ts e lib/.md.').map((item) => item.normalized), ['.ts', '.md']);
  const pathLike = detectMentions('Extensões .js/path não formam uma lista.')[0];
  assert.notStrictEqual(detectorFalsePositive(pathLike), METALINGUISTIC_EXTENSION_REASON);
});

test('#126 boundary posterior recusa sufixos mistos e preserva o restante concreto do token', () => {
  for (const text of ['Extensões .js_foo', 'Extensões .js.map']) {
    const mentions = detectMentions(text);
    assert.ok(mentions.every((item) => detectorFalsePositive(item) !== METALINGUISTIC_EXTENSION_REASON), text);
  }
  const mixedPath = detectMentions('Extensões .js,src/.env');
  assert.deepStrictEqual(mixedPath.map((item) => item.normalized), ['.js', '.env']);
  assert.strictEqual(detectorFalsePositive(mixedPath[0]), METALINGUISTIC_EXTENSION_REASON);
  assert.strictEqual(detectorFalsePositive(mixedPath[1]), null);

  const mixedFile = detectMentions('Extensões .js,config.ts');
  assert.deepStrictEqual(mixedFile.map((item) => item.normalized), ['.js', 'config.ts']);
  assert.strictEqual(detectorFalsePositive(mixedFile[0]), METALINGUISTIC_EXTENSION_REASON);
  assert.strictEqual(detectorFalsePositive(mixedFile[1]), null);
});


console.log(`\n${passed} testes F2 passaram`);
