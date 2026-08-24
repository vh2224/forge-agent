#!/usr/bin/env node
'use strict';

// forge-app-progress.test.js — the drift guard that makes ONE hardcode legal.
//
// `file_audit.ignore_list` has a canonical source: the prefs cascade, read via
// `forge-prefs.js --resolved --key file_audit.ignore_list`. A compiled Swift app
// cannot read that at build time, so `GitActivity.defaultIgnoreList` restates
// the engine's fallback list — the same seven globs `agents/forge-completer.md`
// inlines for the very same "prefs absent or empty" case (DS5).
//
// Two copies of a list is a drift bug waiting to happen, and the drift would be
// SILENT in the worst possible way: the panel would keep counting lines, just
// the wrong ones. Nobody reads a line count and thinks "that number is off by
// the size of dist/". So the duplication is allowed on one condition — that
// this suite fails the moment the two copies stop agreeing.
//
// It also asserts that the completer's own two inline copies (the `try` branch
// and the `catch` fallback of the same shell pipeline) agree with each other:
// a list that appears twice in one line is a list that gets edited once.
//
// Pure file reading, like forge-app-sidebar.test.js and forge-app-update.test.js:
// no swift invocation, so it NEVER skips and runs everywhere, Windows included.
//
// Zero deps, standalone runner (repo convention): exit != 0 on any failure.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const gitActivitySwift = path.join(repoRoot, 'app', 'Sources', 'ForgeKit', 'GitActivity.swift');
// 2026-08-24 completer split: the inline ignore_list literals live in the slice spec.
const completerMd = path.join(repoRoot, 'shared', 'forge-completer-slice.md');

const REL_SWIFT = path.relative(repoRoot, gitActivitySwift);
const REL_COMPLETER = path.relative(repoRoot, completerMd);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function read(file) {
  assert(fs.existsSync(file), `arquivo ausente: ${path.relative(repoRoot, file)}`);
  return fs.readFileSync(file, 'utf8');
}

/// Strip `//` line comments so the doc comment above the constant — which
/// explains the whole arrangement, names both files and could easily come to
/// quote the globs themselves — can never satisfy the extraction. A guard that
/// reads prose instead of code proves nothing.
function stripLineComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/// The Swift side: the array literal of `defaultIgnoreList`, read by locating
/// the declaration and taking the bracketed body. Anchored on the declaration
/// rather than on the glob strings, so deleting an entry SHRINKS the extracted
/// list (and fails) instead of quietly matching somewhere else in the file.
function swiftDefaultList() {
  const src = stripLineComments(read(gitActivitySwift));
  const at = src.indexOf('defaultIgnoreList');
  assert(
    at !== -1,
    `\`defaultIgnoreList\` não existe em ${REL_SWIFT} — a constante única da DS5 sumiu, `
      + 'e com ela o único lado deste guard que o app realmente executa'
  );
  const open = src.indexOf('[', at);
  const close = src.indexOf(']', open);
  assert(open !== -1 && close !== -1, `array literal de defaultIgnoreList não encontrado em ${REL_SWIFT}`);
  return (src.slice(open + 1, close).match(/"([^"]*)"/g) || []).map((s) => s.slice(1, -1));
}

/// The completer side: every JS array literal of single-quoted strings that
/// contains `package-lock.json`. There are two (the parsed-prefs branch and the
/// catch fallback), both on the same line, and both are returned so they can be
/// compared against each other as well.
function completerDefaultLists() {
  const src = read(completerMd);
  const literals = src.match(/\[(?:\s*'[^']*'\s*,)*\s*'[^']*'\s*\]/g) || [];
  return literals
    .filter((lit) => lit.includes('package-lock.json'))
    .map((lit) => (lit.match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1)));
}

console.log('\nforge-app-progress.test.js\n');

// ------------------------------------------- both sides are actually readable

check('a lista default é extraível dos dois arquivos', () => {
  const swift = swiftDefaultList();
  assert(
    swift.length > 0,
    `nenhuma string extraída de \`defaultIgnoreList\` em ${REL_SWIFT} — extração vazia é `
      + 'falha, nunca "as duas listas são iguais porque as duas são vazias"'
  );
  const completer = completerDefaultLists();
  assert(
    completer.length > 0,
    `nenhuma lista default inline encontrada em ${REL_COMPLETER} — o fallback do pipeline `
      + '`forge-prefs.js --resolved --key file_audit.ignore_list` mudou de forma, e este '
      + 'guard passou a olhar para o nada'
  );
  completer.forEach((list, i) => {
    assert(
      list.length > 0,
      `a ${i + 1}ª lista inline de ${REL_COMPLETER} saiu vazia da extração`
    );
  });
});

// --------------------------- as duas cópias inline do completer entre si

check(`as cópias inline de ${REL_COMPLETER} concordam entre si`, () => {
  const lists = completerDefaultLists();
  const first = JSON.stringify([...lists[0]].sort());
  lists.forEach((list, i) => {
    assert(
      JSON.stringify([...list].sort()) === first,
      `a ${i + 1}ª lista default inline de ${REL_COMPLETER} diverge da 1ª: `
        + `${JSON.stringify(list)} vs ${JSON.stringify(lists[0])}. São o ramo normal e o `
        + 'fallback do MESMO pipeline, na mesma linha — editar uma e esquecer a outra faz '
        + 'o audit ignorar coisas diferentes conforme as prefs existam ou não'
    );
  });
});

// ------------------------------------------------------ o guard de drift em si

check('GitActivity.defaultIgnoreList == a lista default do forge-completer.md (DS5)', () => {
  const swift = swiftDefaultList();
  const completer = completerDefaultLists()[0];
  const a = [...swift].sort();
  const b = [...completer].sort();
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `a lista default divergiu entre ${REL_SWIFT} e ${REL_COMPLETER}:\n`
      + `      ${REL_SWIFT}: ${JSON.stringify(a)}\n`
      + `      ${REL_COMPLETER}: ${JSON.stringify(b)}\n`
      + '    Só de um lado, a divergência é invisível em runtime: o painel continua '
      + 'mostrando um número de linhas, apenas o número errado — e ninguém lê uma '
      + 'contagem de linhas e percebe que ela está inflada pelo tamanho de dist/. '
      + 'Sincronize as duas, ou mova a lista para uma fonte que os dois leiam.'
  );
});

// ------------------------------------- a lógica de contagem não relê a lista

check('a lógica de contagem recebe [String] e não hardcoda glob nenhum (DS5)', () => {
  const src = stripLineComments(read(gitActivitySwift));
  const at = src.indexOf('defaultIgnoreList');
  const close = src.indexOf(']', src.indexOf('[', at));
  // Tudo depois da constante: linesTouched, isIgnored, Glob, collect. Nenhum
  // deles pode citar um glob literal — a lista entra por parâmetro, resolvida
  // pelo caller, e um segundo hardcode aqui não teria guard nenhum.
  const rest = src.slice(close);
  for (const glob of swiftDefaultList()) {
    assert(
      !rest.includes(`"${glob}"`),
      `o glob "${glob}" aparece literalmente na lógica de ${REL_SWIFT}, depois da `
        + 'constante — a contagem tem de receber [String] do caller (DS5). Um segundo '
        + 'hardcode não é coberto por este guard e reintroduz exatamente o drift que '
        + 'ele existe para impedir'
    );
  }
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
