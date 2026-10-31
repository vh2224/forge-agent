#!/usr/bin/env node
'use strict';

// forge-instructions.test.js — proves the routing-contract injector is
// idempotent, non-destructive, EOL-preserving, fence-blind in the right
// direction, and loud about every candidate target.
//
// The failure this guard exists for is not "the block was not added". It is
// the block being added by DELETING something: a splice that eats the bytes
// between a documentation example's quoted markers, or a CRLF file rewritten
// as LF so VCS reports the whole file as touched. Every refusal case below
// therefore asserts the file bytes are UNCHANGED, not merely that an outcome
// string said `skipped` — a refusal that still wrote is the exact shape of
// failure a status-string assertion cannot see.
//
// Fixtures live in fs.mkdtempSync under os.tmpdir(). Nothing reads or writes
// the operator's real project files.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const interaction = require('./forge-interaction');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mod = require('./forge-instructions.js');
const {
  MARKER_START,
  MARKER_END,
  TARGETS,
  OUTCOMES,
  renderBlock,
  scanMarkers,
  findBlock,
  detectEol,
  syncFile,
  syncInstructions,
  parseArgs,
} = mod;

const CLI = path.join(__dirname, 'forge-instructions.js');

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-instructions-'));
  tmps.push(d);
  return fs.realpathSync(d);
}

function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function project(files) {
  const root = mktmp();
  for (const [name, content] of Object.entries(files || {})) {
    fs.writeFileSync(path.join(root, name), content, 'utf8');
  }
  return root;
}

function read(root, name) {
  return fs.readFileSync(path.join(root, name), 'utf8');
}

function legacyBlock(version, eol = '\n') {
  return [
    `<!-- forge:routing-contract:start version=${version} -->`,
    'legacy contract body',
    MARKER_END,
  ].join(eol);
}

// ── R1: idempotence ─────────────────────────────────────────────────────────

test('interaction block is independently owned, fence-aware and refuses malformed spans', () => {
  const start = interaction.START, end = interaction.END;
  for (const body of [`${start}\nmissing`, `${end}\n${start}`, `${start}\nx\n${end}\n${start}`, '<!-- forge:interaction:start invalid -->']) {
    const root = project({ 'AGENTS.md': body });
    const result = syncFile(path.join(root, 'AGENTS.md'), { host: 'codex' });
    assertEqual(result.outcome, 'skipped', 'malformed interaction refused');
    assertEqual(read(root, 'AGENTS.md'), body, 'refusal wrote routing or interaction bytes');
  }
  const quoted = `# keep\r\n\r\n~~~md\r\n${start}\r\nx\r\n${end}\r\n~~~\r\n`;
  const first = interaction.sync(quoted).content;
  assert(first.startsWith(quoted), 'quoted marker was consumed');
  assertEqual(interaction.sync(first).content, first, 'interaction sync is not idempotent');
  const operatorTail = '\r\n# operator tail\r\n';
  const stale = `prefix\r\n${start}\r\nold\r\n${end}${operatorTail}`;
  const refreshed = interaction.sync(stale).content;
  assert(refreshed.startsWith('prefix\r\n') && refreshed.endsWith(operatorTail), 'interaction splice lost external bytes');
  assertEqual(findBlock(first), null, 'interaction expanded routing marker grammar');
});

console.log('R1 — idempotence');

test('primeiro sync escreve o bloco; o segundo não muda um byte', () => {
  const root = project({ 'CLAUDE.md': '# Projeto\n\nRegras do operador.\n' });
  const first = syncInstructions(root);
  const claudeFirst = first.files.find((f) => f.host === 'claude');
  assertEqual(claudeFirst.outcome, 'updated', 'primeiro sync');

  const afterFirst = read(root, 'CLAUDE.md');
  const second = syncInstructions(root);
  const claudeSecond = second.files.find((f) => f.host === 'claude');
  assertEqual(claudeSecond.outcome, 'unchanged', 'segundo sync');
  assertEqual(read(root, 'CLAUDE.md'), afterFirst, 'bytes após o segundo sync');
  assertEqual(second.changed, 0, 'changed no segundo sync');
});

test('um bloco de versão antiga é substituído, não duplicado', () => {
  const stale = legacyBlock('0.0.1');
  const root = project({ 'CLAUDE.md': `# Projeto\n\n${stale}\n` });
  const report = syncInstructions(root);
  assertEqual(report.files.find((f) => f.host === 'claude').outcome, 'updated', 'outcome');

  const text = read(root, 'CLAUDE.md');
  const starts = text.split('\n').filter((l) => l === MARKER_START).length;
  const ends = text.split('\n').filter((l) => l === MARKER_END).length;
  assertEqual(starts, 1, 'marcadores de início após o refresh');
  assertEqual(ends, 1, 'marcadores de fim após o refresh');
  assert(!text.includes('version=0.0.1'), 'a versão velha sobreviveu ao refresh');
});

// ── R2: the splice never eats operator bytes ────────────────────────────────

console.log('R2 — splice preserva tudo fora dos marcadores');

test('texto antes E depois do bloco sobrevive byte a byte a um refresh', () => {
  const before = '# Projeto\n\nParágrafo do operador com `código` e **negrito**.\n\n';
  const after = '\n## Seção do operador depois do bloco\n\nConteúdo que ninguém pode perder.\n';
  const root = project({ 'CLAUDE.md': `${before}${legacyBlock('0.0.1')}${after}` });

  syncInstructions(root);
  const text = read(root, 'CLAUDE.md');
  assert(text.startsWith(before), 'o texto anterior ao bloco foi alterado');
  assert(text.includes(after + '\n' + interaction.START), 'o texto posterior ao bloco foi alterado');
});

test('arquivo sem newline final ganha o bloco sem colar na última linha', () => {
  const root = project({ 'CLAUDE.md': '# Projeto\nSem newline final' });
  syncInstructions(root);
  const text = read(root, 'CLAUDE.md');
  assert(text.includes(`Sem newline final\n\n${MARKER_START}`), `separação incorreta:\n${text.slice(0, 120)}`);
});

test('os bytes originais são PREFIXO estrito do resultado — nada é aparado no append', () => {
  for (const original of ['# P\nlinha', '# P\n', '# P\n\n', '# P\n\n\n\n', '# P\r\n\r\n']) {
    const root = project({ 'CLAUDE.md': original });
    syncInstructions(root);
    const text = read(root, 'CLAUDE.md');
    assert(text.startsWith(original), `append aparou o final de ${JSON.stringify(original)} → ${JSON.stringify(text.slice(0, original.length + 4))}`);
    assert(text.includes(MARKER_END), 'bloco não anexado');
  }
});

// ── R3: line endings ────────────────────────────────────────────────────────

console.log('R3 — EOL do arquivo manda');

test('arquivo CRLF continua 100% CRLF depois do sync', () => {
  const root = project({ 'CLAUDE.md': '# Projeto\r\n\r\nLinha do operador.\r\n' });
  syncInstructions(root);
  const text = read(root, 'CLAUDE.md');
  const loneLf = (text.match(/(?<!\r)\n/g) || []).length;
  assertEqual(loneLf, 0, 'LF solto introduzido em arquivo CRLF');
  assert((text.match(/\r\n/g) || []).length > 20, 'o bloco não foi escrito');
});

test('legacy CRLF migration preserves external bytes and line endings', () => {
  const before = '# Project\r\noperator before\r\n';
  const after = '\r\noperator after\r\n';
  const original = `${before}${legacyBlock('1.2.3', '\r\n')}${after}`;
  const root = project({ 'CLAUDE.md': original });
  syncInstructions(root);
  const migrated = read(root, 'CLAUDE.md');
  assert(migrated.startsWith(before) && migrated.includes(after + '\r\n' + interaction.START), 'external CRLF bytes changed');
  assertEqual((migrated.match(/(?<!\r)\n/g) || []).length, 0, 'migration introduced lone LF');
  const second = syncInstructions(root);
  assertEqual(second.changed, 0, 'migration second sync changed bytes');
  assertEqual(read(root, 'CLAUDE.md'), migrated, 'migration second sync differs');
});

test('arquivo LF não ganha nenhum CR', () => {
  const root = project({ 'CLAUDE.md': '# Projeto\n\nLinha.\n' });
  syncInstructions(root);
  assertEqual(read(root, 'CLAUDE.md').includes('\r'), false, 'CR introduzido em arquivo LF');
});

test('detectEol classifica pelos bytes, não pela plataforma', () => {
  assertEqual(detectEol('a\r\nb\n'), 'crlf', 'misto com CRLF');
  assertEqual(detectEol('a\nb\n'), 'lf', 'LF puro');
});

// ── R4: malformed blocks are refused WITHOUT writing ────────────────────────

console.log('R4 — bloco malformado é recusado e nada é escrito');

const MALFORMED = [
  ['start-marker-without-end', `# P\n\n${MARKER_START}\ncorpo\n`],
  ['end-marker-without-start', `# P\n\ncorpo\n${MARKER_END}\n`],
  ['end-marker-before-start', `# P\n\n${MARKER_END}\ncorpo\n${MARKER_START}\n`],
  ['duplicate-start-marker', `${MARKER_START}\na\n${legacyBlock('1.2.3')}\n`],
  ['duplicate-end-marker', `${MARKER_START}\na\n${MARKER_END}\nb\n${MARKER_END}\n`],
];

for (const [reason, content] of MALFORMED) {
  test(`${reason}: outcome skipped E arquivo intacto`, () => {
    const root = project({ 'CLAUDE.md': content });
    const report = syncInstructions(root);
    const entry = report.files.find((f) => f.host === 'claude');
    assertEqual(entry.outcome, 'skipped', 'outcome');
    assertEqual(entry.reason, `malformed-block:${reason}`, 'reason');
    assertEqual(read(root, 'CLAUDE.md'), content, 'o arquivo foi escrito apesar da recusa');
  });
}

test('findBlock nomeia cada forma malformada — nunca devolve um intervalo chutado', () => {
  for (const [reason, content] of MALFORMED) {
    const found = findBlock(content);
    assertEqual(found && found.malformed, reason, `findBlock(${reason})`);
    assertEqual(found.start, undefined, `${reason} devolveu um start`);
  }
});

test('invalid reserved candidates are refused without writing', () => {
  for (const start of [
    '<!-- forge:routing-contract:start --> ',
    '<!-- forge:routing-contract:start version= -->',
    '<!-- forge:routing-contract:start version=1 -->',
    '<!-- forge:routing-contract:start version=X -->',
    '<!-- forge:routing-contract:start version=1.2.3 extra -->',
    '<!-- forge:routing-contract:start foo=bar -->',
    '<!-- forge:routing-contract:end extra -->',
  ]) {
    const content = `# P\n${start}\n`;
    const root = project({ 'CLAUDE.md': content });
    const entry = syncInstructions(root).files.find((f) => f.host === 'claude');
    assertEqual(entry.reason, 'malformed-block:invalid-marker', start);
    assertEqual(read(root, 'CLAUDE.md'), content, `${start}: wrote despite refusal`);
  }
});

test('scanMarkers inventories valid and invalid reserved candidates separately', () => {
  const scanned = scanMarkers([
    MARKER_START,
    MARKER_END,
    '<!-- forge:routing-contract:start version=1.2.3 -->',
    '<!-- forge:routing-contract:start version=X -->',
  ].join('\n'));
  assertEqual(scanned.starts.length, 2, 'valid starts');
  assertEqual(scanned.ends.length, 1, 'valid ends');
  assertEqual(scanned.invalid.length, 1, 'invalid candidates');
});

// ── R5: fence awareness, in both directions ─────────────────────────────────

console.log('R5 — marcador citado em code fence não é bloco');

test('par de marcadores dentro de ``` é ignorado; o arquivo recebe um bloco real', () => {
  const doc = [
    '# Doc do Forge',
    '',
    'O bloco gerenciado tem esta forma:',
    '',
    '```markdown',
    `${MARKER_START} version=X -->`,
    'CONTEUDO-DE-EXEMPLO-QUE-NAO-PODE-SUMIR',
    MARKER_END,
    '```',
    '',
    'Fim.',
    '',
  ].join('\n');
  const root = project({ 'CLAUDE.md': doc });

  assertEqual(findBlock(doc), null, 'marcador em fence foi lido como bloco');
  syncInstructions(root);
  const text = read(root, 'CLAUDE.md');
  assert(text.includes('CONTEUDO-DE-EXEMPLO-QUE-NAO-PODE-SUMIR'), 'o exemplo dentro da fence foi comido pelo splice');
  assert(text.startsWith(doc.replace(/\n+$/, '')), 'o documento original foi alterado');
  assert(text.trimEnd().endsWith(interaction.END), 'o bloco real não foi anexado');
});

test('stable and legacy markers in backtick and tilde fences are ignored', () => {
  for (const [open, close, start] of [
    ['```markdown', '```', MARKER_START],
    ['~~~markdown', '~~~', '<!-- forge:routing-contract:start version=1.2.3 -->'],
  ]) {
    const doc = [open, start, 'DO-NOT-REMOVE', MARKER_END, close, ''].join('\n');
    const root = project({ 'CLAUDE.md': doc });
    assertEqual(findBlock(doc), null, 'fenced marker became managed');
    syncInstructions(root);
    const written = read(root, 'CLAUDE.md');
    assert(written.includes('DO-NOT-REMOVE'), 'fenced bytes lost');
    assert(written.trimEnd().endsWith(interaction.END), 'stable block not appended');
  }
});

test('indented and long fences do not expose quoted markers', () => {
  for (const lines of [
    ['   ```markdown', MARKER_START, 'INDENTED-FENCE-BYTES', MARKER_END, '   ```', ''],
    ['````markdown', '```', MARKER_START, 'LONG-FENCE-BYTES', MARKER_END, '````', ''],
  ]) {
    const doc = lines.join('\n');
    const root = project({ 'CLAUDE.md': doc });
    assertEqual(findBlock(doc), null, 'quoted marker became managed');
    const first = syncInstructions(root);
    const written = read(root, 'CLAUDE.md');
    assertEqual(first.files.find((f) => f.host === 'claude').outcome, 'updated', 'sync outcome');
    assert(written.startsWith(doc), 'fenced bytes changed');
    assert(written.includes('FENCE-BYTES'), 'fenced content lost');
    const second = syncInstructions(root);
    assertEqual(second.changed, 0, 'second sync changed fenced fixture');
    assertEqual(read(root, 'CLAUDE.md'), written, 'second sync bytes differ');
  }
});

test('bite: sem fence-awareness o mesmo fixture seria destrutivo', () => {
  // Positive control for the guard above — proves the fixture actually contains
  // a marker pair a naive (regex-over-the-whole-text) detector WOULD match, so
  // R5 is not passing because the fixture is inert.
  const naive = /^<!-- forge:routing-contract:start[^\n]*-->[ \t]*$/m;
  const doc = `\`\`\`\n${MARKER_START}\nx\n${MARKER_END}\n\`\`\`\n`;
  assert(naive.test(doc), 'o fixture não contém um marcador que um detector ingênuo casaria');
  assertEqual(findBlock(doc), null, 'o detector real casou um marcador em fence');
});

test('marcador indentado é prosa, não bloco', () => {
  assertEqual(findBlock(`  ${MARKER_START}\n  ${MARKER_END}\n`), null, 'marcador indentado casou');
});

// ── R6: target selection ────────────────────────────────────────────────────

console.log('R6 — seleção de alvos');

test('repo sem nenhum arquivo de instrução ganha CLAUDE.md, nunca AGENTS.md', () => {
  const root = project({});
  const report = syncInstructions(root);
  assertEqual(report.files.find((f) => f.host === 'claude').outcome, 'created', 'CLAUDE.md');
  assertEqual(report.files.find((f) => f.host === 'codex').outcome, 'skipped', 'AGENTS.md');
  assertEqual(fs.existsSync(path.join(root, 'AGENTS.md')), false, 'AGENTS.md foi criado sem ser pedido');
  assert(read(root, 'CLAUDE.md').includes(MARKER_END), 'CLAUDE.md criado sem o bloco');
});

test('AGENTS.md existente é sincronizado sem que --host precise pedir', () => {
  const root = project({ 'AGENTS.md': '# Codex host\n' });
  const report = syncInstructions(root);
  assertEqual(report.files.find((f) => f.host === 'codex').outcome, 'updated', 'AGENTS.md');
  // CLAUDE.md ausente e não pedido: o seed default só vale quando NENHUM
  // arquivo de instrução existe — um projeto codex-only não ganha CLAUDE.md.
  assertEqual(report.files.find((f) => f.host === 'claude').outcome, 'skipped', 'CLAUDE.md');
  assertEqual(fs.existsSync(path.join(root, 'CLAUDE.md')), false, 'CLAUDE.md criado num projeto codex-only');
});

test('--host both cria os dois', () => {
  const root = project({});
  const report = syncInstructions(root, { host: 'both' });
  assertEqual(report.files.filter((f) => f.outcome === 'created').length, 2, 'arquivos criados');
});

test('--no-create nunca semeia arquivo: refresca o que existe, ignora o que falta', () => {
  const empty = project({});
  const report = syncInstructions(empty, { create: false });
  assertEqual(fs.readdirSync(empty).length, 0, '--no-create criou arquivo num repo vazio');
  for (const entry of report.files) assertEqual(entry.outcome, 'skipped', `${entry.file} não foi pulado`);

  const seeded = project({ 'CLAUDE.md': '# P\n' });
  const second = syncInstructions(seeded, { create: false });
  assertEqual(second.files.find((f) => f.host === 'claude').outcome, 'updated', 'arquivo existente não foi refrescado');
});

test('--no-create pela CLI: o guard de "projeto não inicializado" continua de pé', () => {
  const root = project({});
  const run = spawnSync(process.execPath, [CLI, '--sync', '--cwd', root, '--no-create'], { encoding: 'utf8' });
  assertEqual(run.status, 0, 'exit code');
  assertEqual(fs.existsSync(path.join(root, 'CLAUDE.md')), false, 'a CLI semeou CLAUDE.md apesar do --no-create');
});

// ── R7: anti-silence floor ──────────────────────────────────────────────────

console.log('R7 — piso anti-silêncio');

test('todo alvo conhecido aparece no relatório, com outcome do conjunto fechado e reason nomeado', () => {
  const root = project({ 'CLAUDE.md': '# P\n' });
  const report = syncInstructions(root);
  assertEqual(report.files.length, TARGETS.length, 'um registro por alvo conhecido');
  for (const entry of report.files) {
    assert(OUTCOMES.includes(entry.outcome), `outcome fora do conjunto fechado: ${entry.outcome}`);
    assert(typeof entry.reason === 'string' && entry.reason.length > 0, `reason vazio em ${entry.file}`);
    assert(path.isAbsolute(entry.file), `caminho relativo no relatório: ${entry.file}`);
  }
});

test('a saída de texto lista TODOS os alvos, inclusive os inalterados', () => {
  const root = project({ 'CLAUDE.md': '# P\n' });
  spawnSync(process.execPath, [CLI, '--sync', '--cwd', root], { encoding: 'utf8' });
  const out = spawnSync(process.execPath, [CLI, '--sync', '--cwd', root], { encoding: 'utf8' }).stdout;
  assert(/CLAUDE\.md — unchanged/.test(out), `alvo inalterado omitido do relatório:\n${out}`);
  assert(/AGENTS\.md — skipped/.test(out), `alvo pulado omitido do relatório:\n${out}`);
});

// ── R8: --check is read-only and reports drift by exit code ─────────────────

console.log('R8 — --check não escreve');

test('--check num projeto sem bloco: exit 1 e ZERO escrita', () => {
  const root = project({ 'CLAUDE.md': '# P\n\ncorpo\n' });
  const before = read(root, 'CLAUDE.md');
  const run = spawnSync(process.execPath, [CLI, '--check', '--cwd', root], { encoding: 'utf8' });
  assertEqual(run.status, 1, 'exit code com drift');
  assertEqual(read(root, 'CLAUDE.md'), before, '--check escreveu no arquivo');
});

test('--check num projeto já sincronizado: exit 0', () => {
  const root = project({ 'CLAUDE.md': '# P\n' });
  spawnSync(process.execPath, [CLI, '--sync', '--cwd', root], { encoding: 'utf8' });
  const run = spawnSync(process.execPath, [CLI, '--check', '--cwd', root], { encoding: 'utf8' });
  assertEqual(run.status, 0, 'exit code sem drift');
});

test('--check não cria arquivo nenhum num repo vazio', () => {
  const root = project({});
  const run = spawnSync(process.execPath, [CLI, '--check', '--cwd', root], { encoding: 'utf8' });
  assertEqual(run.status, 1, 'exit code');
  assertEqual(fs.readdirSync(root).length, 0, '--check criou arquivo');
});

// ── R9: the block says what it must say ─────────────────────────────────────

console.log('R9 — conteúdo do contrato');

test('o bloco nomeia o resolvedor, o sidecar e a manutenção direta sem troca silenciosa', () => {
  const block = renderBlock();
  for (const needle of [
    'forge-dispatch-resolve.js',
    'forge-xllm.js',
    'worker-engine-fallback',
    'events.jsonl',
    'shared/forge-direct-actions.md',
    'executor real',
    'revisão independente',
    'dispatch_allowed:true',
    'provider_called:false',
    '.gsd/tasks/',
    'receipt',
  ]) {
    assert(block.includes(needle), `o contrato não menciona ${needle}`);
  }
  assert(!block.includes('Nunca execute a unidade inline'), 'proibição absoluta reapareceu');
});

test('o contrato separa recusa local de rejeição do provedor e exige a cadeia real', () => {
  const block = renderBlock();
  for (const needle of [
    'modelo',
    'escolhido, worker, host, transporte',
    'fonte atual',
    'instalação efetivamente lida',
    'argumentos do',
    'caller. Para task solta',
    'milestone fictício',
  ]) assert(block.includes(needle), `diagnóstico incompleto: ${needle}`);
  assert(
    /anterior ao spawn[\s\S]+não é[\s\S]+rejeição do provedor/.test(block),
    'recusa anterior ao spawn foi apresentada como rejeição do provedor',
  );
});

test('o bloco não afirma nada sobre a config de routing DESTE projeto', () => {
  // A claim measured once at sync time ("este projeto roteia execute-task para
  // codex") is wrong the first time alguém edita as prefs. O bloco enuncia o
  // invariante e aponta o comando que reporta a decisão viva.
  const block = renderBlock();
  assert(!/routing:\s*$/m.test(block), 'o bloco embute um snapshot de prefs');
  assert(block.includes('--json'), 'o bloco não aponta o comando que reporta a rota viva');
});

test('renderBlock respeita o EOL pedido', () => {
  assertEqual(renderBlock({ eol: 'crlf' }).includes('\r\n'), true, 'crlf');
  assertEqual(renderBlock({ eol: 'lf' }).includes('\r'), false, 'lf');
});

test('renderBlock emits only the stable marker', () => {
  const block = renderBlock();
  assert(block.startsWith(`${MARKER_START}\n`), 'exact stable start');
  assertEqual(block.includes('version='), false, 'renderer emitted version');
});

// ── R9b: the standing entry contract travels with the block ─────────────────

console.log('R9b — contrato de entrada por intenção');

test('o bloco carrega o contrato de entrada, nomeia o helper e a especificação', () => {
  const block = renderBlock();
  for (const needle of [
    'shared/forge-intent-entry.md',
    'scripts/forge-entry-assessment.js',
    'consulta/diagnóstico',
    'não é consentimento',
    'preparação',
  ]) {
    assert(block.includes(needle), `o contrato de entrada não menciona ${needle}`);
  }
  assert(block.includes(mod.renderEntryContract()), 'o projetor não embutiu o contrato de entrada');
});

test('o contrato de entrada não promete autorização nem fase pulada por padrão', () => {
  // The two claims that would make this block dangerous instead of useful: that
  // an artifact can consent, and that reuse is the default. Both are asserted
  // against the rendered bytes, not against the intent of the source.
  const entry = mod.renderEntryContract();
  assert(/pendente/.test(entry), 'uma decisão necessária sem resposta deixou de ser pendente');
  assert(/gates/.test(entry), 'o contrato não devolve a autorização aos gates');
  assert(/mant[eé]m a prepara[çc][ãa]o/.test(entry), 'evidência insuficiente sem preparação normal');
  assert(/Revalide fontes e escopo/.test(entry), 'o contrato não exige revalidação antes de pular fase');
  assert(/nunca crie artefato vazio/.test(entry), 'o contrato não proíbe o stub que compra um skip por existência');
});

// ── R10: CLI argument handling ──────────────────────────────────────────────

console.log('R10 — CLI');

test('argumento desconhecido falha com exit 2, sem escrever', () => {
  const root = project({ 'CLAUDE.md': '# P\n' });
  const before = read(root, 'CLAUDE.md');
  const run = spawnSync(process.execPath, [CLI, '--sync', '--cwd', root, '--wat'], { encoding: 'utf8' });
  assertEqual(run.status, 2, 'exit code');
  assertEqual(read(root, 'CLAUDE.md'), before, 'escreveu apesar do argumento inválido');
});

test('--host inválido é recusado', () => {
  const parsed = parseArgs(['--sync', '--host', 'gemini']);
  assert(parsed.error, 'host inválido aceito');
});

test('--print emite o bloco e não toca em disco', () => {
  const root = project({});
  const run = spawnSync(process.execPath, [CLI, '--print'], { encoding: 'utf8', cwd: root });
  assertEqual(run.status, 0, 'exit code');
  assert(run.stdout.includes(MARKER_START), 'stdout sem o marcador');
  assertEqual(fs.readdirSync(root).length, 0, '--print escreveu em disco');
});

test('--json emite uma linha parseável com o relatório completo', () => {
  const root = project({ 'CLAUDE.md': '# P\n' });
  const run = spawnSync(process.execPath, [CLI, '--sync', '--cwd', root, '--json'], { encoding: 'utf8' });
  const report = JSON.parse(run.stdout);
  assertEqual(report.files.length, TARGETS.length, 'alvos no JSON');
  assertEqual(report.changed, 1, 'changed');
});

// ── R11: unreadable target is named, not silently skipped ───────────────────

console.log('R11 — alvo ilegível');

test('diretório no lugar do arquivo vira skipped com errno nomeado', () => {
  const root = mktmp();
  fs.mkdirSync(path.join(root, 'CLAUDE.md'));
  const entry = syncFile(path.join(root, 'CLAUDE.md'), { host: 'claude' });
  assertEqual(entry.outcome, 'skipped', 'outcome');
  assert(/^unreadable:/.test(entry.reason), `reason sem errno: ${entry.reason}`);
});

// ── R12: --quiet still surfaces refusals ────────────────────────────────────

console.log('R12 — --quiet cala o irrelevante, nunca a recusa');

test('--quiet num projeto já sincronizado não imprime nada', () => {
  const root = project({ 'CLAUDE.md': '# P\n' });
  spawnSync(process.execPath, [CLI, '--sync', '--cwd', root], { encoding: 'utf8' });
  const run = spawnSync(process.execPath, [CLI, '--sync', '--cwd', root, '--quiet'], { encoding: 'utf8' });
  assertEqual(run.stdout, '', `--quiet falou sobre um sync sem novidade:\n${run.stdout}`);
});

test('--quiet AINDA imprime uma recusa por bloco malformado', () => {
  const root = project({ 'CLAUDE.md': `# P\n\n${MARKER_END}\n` });
  const run = spawnSync(process.execPath, [CLI, '--sync', '--cwd', root, '--quiet'], { encoding: 'utf8' });
  assert(/malformed-block/.test(run.stdout), `recusa engolida pelo --quiet:\n${JSON.stringify(run.stdout)}`);
});

// ── Summary ─────────────────────────────────────────────────────────────────

test('recovery contract sync preserves standing personal authorization bytes and is idempotent', () => {
  const prefix = '<!-- user:forge-routing-continuity:start -->\r\nPERSONAL ACCEPTANCE Ω\r\n<!-- user:forge-routing-continuity:end -->\r\n';
  const root = project({ 'AGENTS.md': prefix });
  const file = path.join(root, 'AGENTS.md');
  syncFile(file, { host: 'codex' });
  const once = fs.readFileSync(file, 'utf8');
  assert(once.startsWith(prefix), 'personal authorization bytes changed');
  assert(!once.includes('60000ms'), 'projected recovery contract carries no cumulative 60000ms clock');
  for (const term of ['createRecoveryAuthorizationAdapter', 'registerStandingAuthorization', 'tier safety ceiling', 'Standing permission never answers a functional question']) {
    assert(once.includes(term), `missing ${term}`);
  }
  assertEqual(syncFile(file, { host: 'codex' }).outcome, 'unchanged', 'second sync');
  assertEqual(fs.readFileSync(file, 'utf8'), once, 'byte identity');
});

test('both generated boot entries require effective core composition before phase dispatch', () => {
  const root = project({ 'CLAUDE.md': '# Claude\r\n', 'AGENTS.md': '# Codex\r\n' });
  for (const [file, host] of [['CLAUDE.md', 'claude'], ['AGENTS.md', 'codex']]) {
    syncFile(path.join(root, file), { host });
    const content = read(root, file);
    for (const term of ['forge-procedure-context.js', '--phase boot', 'shared/forge-procedure-core.md',
      'conteúdo', 'antes do despacho']) assert(content.includes(term), `${host}: missing ${term}`);
  }
});

// Communication is delivered by the same block in both hosts. These checks
// exercise real rendering/synchronization, including a source update between
// installation and sync, rather than treating the presence of a heading as proof.
test('communication canonical content, bounded form and presentation boundaries', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'shared', 'forge-communication.md'), 'utf8');
  const canonical = source.replace(/\r\n/g, '\n').trimEnd();
  assertEqual(mod.renderCommunicationContract(), canonical, 'canonical bytes');
  assert(!source.includes('\r'), 'canonical source must be LF');
  assert(canonical.split('\n').length <= 80, 'communication exceeds 80 lines');
  assert(!/<!-- forge:|```|~~~/.test(canonical), 'communication contains markers or fences');
  for (const term of ['resultado buscado', 'fase', 'executor', 'próximo passo', 'decisão pendente',
    'desconhecido', 'abertura', 'trabalho', 'delegação', 'falha', 'entrega',
    'preparando', 'planejando', 'executando agente', 'verificando a entrega', 'publicando evidência',
    'revisando', 'aguardando decisão', 'concluído', 'falhou', 'nativo', 'sidecar', 'transporte',
    'solicitado', 'resolvido', 'enviado', 'observado', 'distribuído', 'demonstrado', 'condicional',
    'implementado', 'planejado', 'indisponível', 'comum', '1.1.0', 'TaskCreate', 'TaskUpdate',
    'VS Code', 'CLI', 'shared/forge-interaction.md', 'SUMMARY', 'DELIVERY', 'receipts', 'events.jsonl',
    'personality', 'model_verbosity', 'output style', 'barra de status', 'aceite humano']) {
    assert(canonical.includes(term), `communication missing ${term}`);
  }
  assert(/não altera roteamento, modelo, esforço, gates, claims, receipts, critérios nem preferências/.test(canonical), 'authority boundary missing');
  const block = renderBlock();
  assertEqual(block.split(canonical).length - 1, 1, 'contract count');
  assert(block.indexOf(canonical) > block.indexOf(mod.renderEntryContract()), 'communication precedes entry contract');
  assert(!/routing:\s*$/m.test(block), 'routing snapshot introduced');
  assert(!block.includes('Nunca execute a unidade inline'), 'absolute inline prohibition introduced');
  for (const name of ['forge-instructions.js', 'forge-codex-renderer.js', 'forge-claude-renderer.js']) {
    const script = fs.readFileSync(path.join(__dirname, name), 'utf8');
    for (const line of canonical.split('\n').filter(line => line.length > 100)) {
      assert(!script.includes(line), `${name} embeds communication prose`);
    }
  }
  console.log('PASS communication source: bounded pt-BR contract, authority, rubric, moments, vocabulary, channels, preferences and independent human acceptance');
  console.log('PASS communication projector: adjacent canonical bytes once after entry, no script copy or routing regression');
  const blockBytes = Buffer.byteLength(block, 'utf8');
  assert(blockBytes <= 16384, 'local managed block budget exceeded (not a host limit)');
  const documentation = fs.readFileSync(path.join(__dirname, '..', 'shared', 'forge-codex-renderer.md'), 'utf8');
  for (const term of ['9 764', '14 138', '16 384', 'não é um limite verificado do host']) {
    assert(documentation.includes(term), `local byte measurement missing ${term}`);
  }
  console.log(`communication measurement: ${canonical.split('\n').length} lines; managed block ${blockBytes} UTF-8 bytes`);
  console.log('PASS communication local budget: block stays within the declared test ceiling and before-after bytes are documented without a host limit claim');
});

test('communication sync both hosts preserves CRLF and every operator byte', () => {
  const prefix = '# Operador Ω\r\n\r\n  texto e espaços  \r\n';
  const suffix = '\r\n\r\nCauda do operador Ω  \r\n';
  const root = project(Object.fromEntries(TARGETS.map(target => [target.file, prefix + legacyBlock('1.0.0', '\r\n') + suffix])));
  const first = syncInstructions(root, { host: 'both' });
  assertEqual(first.changed, 2, 'both targets changed');
  const canonical = mod.renderCommunicationContract();
  const once = TARGETS.map(target => read(root, target.file));
  for (const content of once) {
    const found = findBlock(content);
    assertEqual(content.slice(0, found.start), prefix, 'operator prefix');
    assert(content.slice(found.end).startsWith(suffix), 'operator suffix');
    assertEqual(content.replace(/\r\n/g, '\n').split(canonical).length - 1, 1, 'canonical bytes exactly once');
    assert(!content.replace(/\r\n/g, '').includes('\n'), 'lone LF in CRLF file');
  }
  assertEqual(syncInstructions(root, { host: 'both' }).changed, 0, 'second sync');
  TARGETS.forEach((target, index) => assertEqual(read(root, target.file), once[index], 'stable bytes'));
  console.log('PASS communication sync: both hosts exact canonical bytes once, CRLF, operator prefix and suffix preserved, second sync changed zero');
});

test('communication missing or unreadable source fails before any target write', () => {
  const check = require('assert');
  const isolated = mktmp();
  fs.mkdirSync(path.join(isolated, 'scripts'));
  fs.mkdirSync(path.join(isolated, 'shared'));
  for (const name of ['forge-instructions.js', 'forge-interaction.js']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(isolated, 'scripts', name));
  }
  fs.copyFileSync(path.join(__dirname, '..', 'shared', 'forge-interaction.md'), path.join(isolated, 'shared', 'forge-interaction.md'));
  const isolatedMod = require(path.join(isolated, 'scripts', 'forge-instructions.js'));
  const target = path.join(isolated, 'AGENTS.md');
  const namedError = error => error.code === 'communication-contract-missing'
    && error.message === 'communication-contract-missing';
  for (const existing of [false, true]) {
    if (existing) fs.writeFileSync(target, '# Operador Ω\r\n');
    check.throws(() => isolatedMod.syncFile(target, { host: 'codex' }), namedError);
    if (existing) assertEqual(fs.readFileSync(target, 'utf8'), '# Operador Ω\r\n', 'operator file changed');
    else assert(!fs.existsSync(target), 'missing source created target');
  }
  const source = path.join(isolated, 'shared', 'forge-communication.md');
  fs.mkdirSync(source);
  check.throws(() => isolatedMod.renderBlock(), namedError);
  check.throws(() => isolatedMod.renderCommunicationContract({ file: path.join(isolated, 'absent.md') }), namedError);
  fs.rmdirSync(source);
  fs.writeFileSync(source, 'Fonte adjacente Ω  \r\nsegunda linha\r\n\r\n');
  assertEqual(isolatedMod.renderCommunicationContract(), 'Fonte adjacente Ω  \nsegunda linha', 'adjacent source and EOL normalization');
  console.log('PASS communication read failures: absent and unreadable sources throw communication-contract-missing before writes, adjacent source normalizes LF and trims only the end');
});

test('communication renderer and real sync compose one current contract', () => {
  const renderer = require('./forge-codex-renderer');
  const root = mktmp();
  const report = renderer.render({ repo: path.join(__dirname, '..'), projectRoot: root,
    codexHome: path.join(root, 'host'), forgeHome: path.join(root, 'forge'), ...renderer.PRODUCTION_DISPATCH_DIALECT });
  const instructions = report.artifacts.find(item => item.kind === 'instructions');
  const canonical = mod.renderCommunicationContract();
  assertEqual(instructions.content.split(canonical).length - 1, 1, 'renderer canonical count');
  const prefix = '# Operador preservado Ω\n\n';
  const file = path.join(root, 'AGENTS.md');
  fs.writeFileSync(file, prefix + instructions.content);
  assertEqual(syncFile(file, { host: 'codex' }).outcome, 'unchanged', 'render then sync');
  const sourceFile = path.resolve(__dirname, '..', 'shared', 'forge-communication.md');
  const originalRead = fs.readFileSync;
  const updated = canonical + '\n\nFonte atualizada em fixture isolada Ω.';
  try {
    // Present changed canonical bytes at the I/O seam without editing source or
    // bypassing the real renderBlock/syncFile composition under test.
    fs.readFileSync = function (name, ...args) {
      return path.resolve(String(name)) === sourceFile ? updated + '\r\n' : originalRead.call(this, name, ...args);
    };
    assertEqual(syncFile(file, { host: 'codex' }).outcome, 'updated', 'source update');
    const once = read(root, 'AGENTS.md');
    assert(once.startsWith(prefix), 'operator prefix lost');
    assertEqual(once.split(updated).length - 1, 1, 'current canonical once');
    assertEqual(once.split(canonical).length - 1, 1, 'no stale duplicate');
    assertEqual(syncFile(file, { host: 'codex' }).outcome, 'unchanged', 'updated second sync');
    assertEqual(read(root, 'AGENTS.md'), once, 'updated bytes stable');
    const claudeFile = path.join(root, 'CLAUDE.md');
    syncFile(claudeFile, { host: 'claude' });
    const claudeBlock = read(root, 'CLAUDE.md');
    assertEqual(claudeBlock.replace(/\r\n/g, '\n').split(updated).length - 1, 1, 'Claude same canonical source');
    const rerendered = renderer.render({ repo: path.join(__dirname, '..'), projectRoot: root,
      codexHome: path.join(root, 'host'), forgeHome: path.join(root, 'forge'), ...renderer.PRODUCTION_DISPATCH_DIALECT }).artifacts.find(item => item.kind === 'instructions');
    assertEqual(rerendered.content.split(updated).length - 1, 1, 'updated renderer');
  } finally { fs.readFileSync = originalRead; }
  console.log('PASS communication composition: Codex render then real sync unchanged, updated source replaces owned block once, second sync stable and Claude bytes identical');
});

cleanup();

console.log('');
console.log(`forge-instructions: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
