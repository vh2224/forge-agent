#!/usr/bin/env node
'use strict';

// forge-projection-self.test.js — the guard that stops the installer from
// rewriting its own canonical source.
//
// Measured on 2026-08-22, installing v4.21.1 from this repo: the summary said
// `[adopted] /Users/.../forge-agent/CLAUDE.md`, and the file that IS the
// manifest's declared input for `claude-instructions` came back with a
// `<!-- forge-source: -->` marker stamped on it. The damage is circular, not
// cosmetic: the app's *Atualizar* refuses to start on a dirty tree, so an
// install performed from this repo blocks the next update with a diff nobody
// wrote.
//
// Both directions matter here. A guard that refuses everything inside the repo
// would be trivially green on the case above while breaking every legitimate
// destination — the repo IS a valid project root — so each test below has a
// negative twin that must still be projected.
//
// Zero deps, standalone runner.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const self = require('./forge-projection-self');
const claude = require('./forge-claude-renderer');

let passed = 0;
let failed = 0;
let skipped = 0;
const SKIP = Symbol('skip');
const symlinkUnavailable = (error) => ['EPERM', 'EACCES', 'UNKNOWN'].includes(error && error.code);
function test(name, fn) {
  try {
    if (fn() === SKIP) { skipped++; console.log(`  ⊘ ${name} (file symlink unavailable)`); }
    else { passed++; console.log(`  ✓ ${name}`); }
  }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

console.log('\n=== forge projection · destino que é a própria fonte ===\n');

function box() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-self-')));
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# fonte canônica\n');
  return dir;
}

test('o mesmo arquivo, alcançado pelos dois lados, é recusado', () => {
  const repo = box();
  assert.strictEqual(
    self.isSelfProjection({ repo, source: 'CLAUDE.md', destination: path.join(repo, 'CLAUDE.md') }),
    true);
});

test('um destino DIFERENTE dentro do mesmo repo continua projetável', () => {
  // A cerca é sobre identidade de arquivo, não sobre "está dentro do repo". O
  // repo é uma raiz de projeto legítima: seus agents, skills e .gsd são destinos
  // válidos, e recusá-los quebraria o dogfood inteiro em vez de consertá-lo.
  const repo = box();
  assert.strictEqual(
    self.isSelfProjection({ repo, source: 'CLAUDE.md', destination: path.join(repo, 'skills', 'x', 'SKILL.md') }),
    false);
});

test('basename igual em arquivos diferentes não é auto-projeção', () => {
  const repo = box();
  const outro = box();
  assert.strictEqual(
    self.isSelfProjection({ repo, source: 'CLAUDE.md', destination: path.join(outro, 'CLAUDE.md') }),
    false);
});

test('um symlink que aponta para a fonte é a fonte', () => {
  // Um clone alcançado por caminho symlinkado (/tmp → /private/tmp no macOS é o
  // caso comum) compararia desigual a si mesmo sem resolução real.
  const repo = box();
  const link = path.join(repo, 'LINKED.md');
  try { fs.symlinkSync(path.join(repo, 'CLAUDE.md'), link); }
  catch (error) {
    if (symlinkUnavailable(error)) return SKIP;
    throw error;
  }
  assert.strictEqual(
    self.isSelfProjection({ repo, source: 'CLAUDE.md', destination: link }),
    true);
});

test('fonte sintetizada — rótulo sem arquivo em disco — nunca é auto-projeção', () => {
  // O AGENTS.md do host Codex é conteúdo gerado; o campo `source` ali é rótulo.
  // Responder false é a resposta certa, e ela precisa vir de uma decisão e não
  // de a pergunta não ter sido feita.
  const repo = box();
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'destino que existe, fonte que não\n');
  assert.strictEqual(
    self.isSelfProjection({ repo, source: 'AGENTS.md-que-nao-existe', destination: path.join(repo, 'AGENTS.md') }),
    false);
});

test('destino inexistente não pode ser a fonte', () => {
  const repo = box();
  assert.strictEqual(
    self.isSelfProjection({ repo, source: 'CLAUDE.md', destination: path.join(repo, 'ainda-nao-existe.md') }),
    false);
});

test('o renderer recusa o CLAUDE.md deste repo e o mantém intacto em disco', () => {
  // O teste de ponta: `projectRoot` faz default para o repo, então rodar o
  // renderer aqui é exatamente a configuração que produziu o incidente.
  const repo = path.resolve(__dirname, '..');
  const alvo = path.join(repo, 'CLAUDE.md');
  const antes = fs.readFileSync(alvo);
  const report = claude.write({ repo, dryRun: true });

  const recusados = (report.self_sourced || []).map((item) => item.destination);
  assert.ok(recusados.includes(alvo),
    `o CLAUDE.md do repo não foi recusado como auto-fonte: ${JSON.stringify(recusados)}`);
  assert.ok(!(report.written || []).some((item) => item.destination === alvo),
    'o CLAUDE.md do repo continua na lista de escritos');
  assert.ok(Buffer.compare(antes, fs.readFileSync(alvo)) === 0,
    'o dry-run alterou bytes do CLAUDE.md');
});

test('a recusa vem ANTES da decisão de propriedade, não depois', () => {
  // A ordem é o conserto, não um detalhe. As rungs de propriedade concedem o
  // arquivo cujos bytes vieram deste repo — e os bytes da fonte trivialmente
  // vieram. Posto depois delas, o guard seria inalcançável: o veredito já teria
  // sido `ours` e a escrita já teria acontecido. Isto morde comparando as duas
  // posições possíveis no mesmo relatório.
  const repo = path.resolve(__dirname, '..');
  const alvo = path.join(repo, 'CLAUDE.md');
  const report = claude.write({ repo, dryRun: true });
  assert.ok(!(report.preserved || []).some((item) => item.destination === alvo),
    'o CLAUDE.md apareceu como preserved — sinal de que caiu numa rung de propriedade antes do guard');
  assert.ok(!(report.conflicts || []).some((item) => item.destination === alvo),
    'o CLAUDE.md apareceu como conflict — a cerca certa não é "user_owned"');
});

console.log(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
process.exit(failed === 0 ? 0 : 1);
