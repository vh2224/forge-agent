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

// ── R1: idempotence ─────────────────────────────────────────────────────────

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
  const stale = renderBlock({ version: '0.0.1' });
  const root = project({ 'CLAUDE.md': `# Projeto\n\n${stale}\n` });
  const report = syncInstructions(root);
  assertEqual(report.files.find((f) => f.host === 'claude').outcome, 'updated', 'outcome');

  const text = read(root, 'CLAUDE.md');
  const starts = text.split('\n').filter((l) => l.startsWith(MARKER_START)).length;
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
  const root = project({ 'CLAUDE.md': `${before}${renderBlock({ version: '0.0.1' })}${after}` });

  syncInstructions(root);
  const text = read(root, 'CLAUDE.md');
  assert(text.startsWith(before), 'o texto anterior ao bloco foi alterado');
  assert(text.endsWith(after), 'o texto posterior ao bloco foi alterado');
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
  ['start-marker-without-end', `# P\n\n${MARKER_START} version=1 -->\ncorpo\n`],
  ['end-marker-without-start', `# P\n\ncorpo\n${MARKER_END}\n`],
  ['end-marker-before-start', `# P\n\n${MARKER_END}\ncorpo\n${MARKER_START} version=1 -->\n`],
  ['duplicate-start-marker', `${MARKER_START} version=1 -->\na\n${MARKER_START} version=2 -->\nb\n${MARKER_END}\n`],
  ['duplicate-end-marker', `${MARKER_START} version=1 -->\na\n${MARKER_END}\nb\n${MARKER_END}\n`],
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
  assert(text.trimEnd().endsWith(MARKER_END), 'o bloco real não foi anexado');
});

test('bite: sem fence-awareness o mesmo fixture seria destrutivo', () => {
  // Positive control for the guard above — proves the fixture actually contains
  // a marker pair a naive (regex-over-the-whole-text) detector WOULD match, so
  // R5 is not passing because the fixture is inert.
  const naive = /^<!-- forge:routing-contract:start[^\n]*-->[ \t]*$/m;
  const doc = `\`\`\`\n${MARKER_START} version=X -->\nx\n${MARKER_END}\n\`\`\`\n`;
  assert(naive.test(doc), 'o fixture não contém um marcador que um detector ingênuo casaria');
  assertEqual(findBlock(doc), null, 'o detector real casou um marcador em fence');
});

test('marcador indentado é prosa, não bloco', () => {
  assertEqual(findBlock(`  ${MARKER_START} version=1 -->\n  ${MARKER_END}\n`), null, 'marcador indentado casou');
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

test('o bloco nomeia o resolvedor, o sidecar, o fallback nomeado e a proibição de inline', () => {
  const block = renderBlock();
  for (const needle of [
    'forge-dispatch-resolve.js',
    'forge-xllm.js',
    'worker-engine-fallback',
    'events.jsonl',
    'inline',
  ]) {
    assert(block.includes(needle), `o contrato não menciona ${needle}`);
  }
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

cleanup();

console.log('');
console.log(`forge-instructions: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
  process.exit(1);
}
