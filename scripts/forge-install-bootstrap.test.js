#!/usr/bin/env node
'use strict';

// forge-install-bootstrap.test.js — standing guard for the environment repair
// install.sh performs before handing control to the Node core.
//
// The failure this exists to prevent, measured on 2026-08-20 against app
// v4.18.0, arrived in two steps and the second one only appeared once the
// first was fixed:
//
//   1. `exec node` → exit 127, "exec: node: not found". A GUI launcher inherits
//      launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), and the Forge
//      app spawns the installer through `bash -lc` — a login bash, which does
//      NOT read the ~/.zshrc where nvm/fnm install themselves.
//   2. With node found, the install died one step later: "capability
//      obrigatória ausente para claude: claude". The core's capability probes
//      shell out to `claude`/`codex`, which live wherever the operator's rc put
//      them (~/.local/bin on the measured machine) — still not on that PATH.
//
// So the invariant is about the PATH the CORE receives, not about which node
// the wrapper picked. Text-matching install.sh cannot prove it: the script can
// mention every right token and still export nothing. These tests run the real
// script with a synthetic environment and read the PATH that actually arrives.
//
// The conditional matters as much as the repair: borrowing the login shell's
// PATH costs a subshell and can surprise a caller who set PATH deliberately, so
// it must happen ONLY when the inherited PATH is demonstrably not the
// operator's — evidenced by its inability to resolve node at all.
//
// POSIX only: install.sh is the bash wrapper. Windows ships install.ps1, which
// this file makes no claim about. Zero deps, standalone runner.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const installSh = path.join(repoRoot, 'install.sh');

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
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

console.log('\n=== forge install · bootstrap de ambiente ===\n');

if (process.platform === 'win32') {
  console.log('  ⊘ pulado: install.sh é o wrapper POSIX; o Windows usa install.ps1');
  process.exit(0);
}

// A sandbox holding a stand-in node and a stand-in login shell, so the test
// never depends on what happens to be installed on the machine running it.
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bootstrap-'));
  const nodeDir = path.join(dir, 'nodehome', 'bin');
  const operatorDir = path.join(dir, 'operator-only', 'bin');
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.mkdirSync(operatorDir, { recursive: true });

  // Stand-in for node: install.sh `exec`s this, so its stdout IS the wrapper's
  // stdout. It reports the environment the real core would have received.
  const fakeNode = path.join(nodeDir, 'node');
  fs.writeFileSync(fakeNode, '#!/bin/bash\necho "CORE_PATH=$PATH"\nexit 0\n');
  fs.chmodSync(fakeNode, 0o755);

  // Stand-in for $SHELL. Answers the two questions install.sh asks a login
  // shell, and prints rc noise first — a real rc does, and the wrapper must
  // still read the answer.
  const fakeShell = path.join(dir, 'fakeshell');
  fs.writeFileSync(fakeShell, [
    '#!/bin/bash',
    '# $1 is -lic, $2 is the command',
    'echo "ruído de rc que um ~/.zshrc de verdade imprime"',
    'case "$2" in',
    `  *"command -v node"*) echo ${JSON.stringify(fakeNode)} ;;`,
    `  *PATH*) echo ${JSON.stringify(`${operatorDir}:/usr/bin:/bin`)} ;;`,
    'esac',
    'exit 0',
  ].join('\n'));
  fs.chmodSync(fakeShell, 0o755);

  return { dir, nodeDir, operatorDir, fakeNode, fakeShell };
}

// Run install.sh with a fully controlled environment; returns the PATH the core
// would have received.
function corePath(env) {
  const res = spawnSync('/bin/bash', [installSh, '--update'], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const line = String(res.stdout || '').split('\n').find((l) => l.startsWith('CORE_PATH='));
  return { path: line ? line.slice('CORE_PATH='.length) : null, res };
}

const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

check('sob o PATH do launchd, o core recebe o PATH do operador', () => {
  const box = sandbox();
  const { path: got, res } = corePath({
    HOME: box.dir,
    PATH: LAUNCHD_PATH,
    SHELL: box.fakeShell,
    FORGE_LOGIN_TIMEOUT: '5',
  });
  assert(got !== null,
    `install.sh não chegou a executar o core (exit ${res.status}):\n${res.stdout}\n${res.stderr}`);
  const dirs = got.split(':');
  assert(dirs.includes(box.operatorDir),
    'o diretório que só o shell de login conhece não entrou no PATH do core — o probe ' +
      `de capability voltaria a falhar com "capability obrigatória ausente".\nPATH: ${got}`);
  assert(dirs[0] === box.nodeDir,
    `o diretório do node resolvido não é o primeiro do PATH: ${got}`);
  for (const keep of ['/usr/bin', '/bin']) {
    assert(dirs.includes(keep), `o PATH herdado perdeu ${keep}: ${got}`);
  }
});

check('o node vem do shell de login quando é a única fonte (o caso nvm)', () => {
  // nvm não publica shim nenhum: o único jeito de achá-lo é perguntar ao shell.
  // Este caso é o que produzia o exit 127.
  const box = sandbox();
  const { path: got, res } = corePath({
    HOME: box.dir,
    PATH: path.join(box.dir, 'vazio'), // nada aqui, e HOME sem shim nenhum
    SHELL: box.fakeShell,
    FORGE_LOGIN_TIMEOUT: '5',
  });
  // Um /opt/homebrew/bin/node ou /usr/local/bin/node real na máquina de teste
  // responderia antes do shell de login. O que a asserção fixa é o desfecho que
  // importa: o core foi executado, e não com "node: not found".
  assert(res.status === 0, `install.sh saiu ${res.status}: ${res.stderr}`);
  assert(got !== null, `o core não foi executado:\n${res.stdout}\n${res.stderr}`);
  assert(!/not found/i.test(String(res.stderr)), `saída de erro inesperada: ${res.stderr}`);
});

check('com o PATH do operador, nada é emprestado do shell de login', () => {
  // A evidência de que o PATH herdado é o do operador é ele resolver node
  // sozinho. Nesse caso o wrapper não paga subshell nenhum nem reescreve o que
  // o chamador montou de propósito.
  const box = sandbox();
  const { path: got, res } = corePath({
    HOME: box.dir,
    PATH: `${box.nodeDir}:${LAUNCHD_PATH}`,
    SHELL: box.fakeShell,
    FORGE_LOGIN_TIMEOUT: '5',
  });
  assert(got !== null, `o core não foi executado (exit ${res.status}): ${res.stderr}`);
  assert(!got.split(':').includes(box.operatorDir),
    'o PATH do shell de login foi emprestado mesmo com o PATH herdado resolvendo node — ' +
      `o empréstimo deixou de ser condicional.\nPATH: ${got}`);
});

check('um shell de login travado não pendura o instalador', () => {
  // O modo de falha que este bound evita é o pior de todos na UI do app: a
  // barra de progresso que não anda. Um rc pode bloquear indefinidamente.
  const box = sandbox();
  fs.writeFileSync(box.fakeShell, '#!/bin/bash\nsleep 120\n');
  fs.chmodSync(box.fakeShell, 0o755);
  const started = Date.now();
  const { path: got, res } = corePath({
    HOME: box.dir,
    PATH: LAUNCHD_PATH,
    SHELL: box.fakeShell,
    FORGE_NODE_PATH: box.fakeNode, // o node já está resolvido; o probe é só do PATH
    FORGE_LOGIN_TIMEOUT: '2',
  });
  const elapsed = Date.now() - started;
  assert(got !== null,
    `o core não foi executado (exit ${res.status}): ${res.stderr}`);
  assert(elapsed < 30_000,
    `o probe do shell de login não é limitado: levou ${elapsed}ms com um shell que dorme 120s`);
});

check('um FORGE_NODE_PATH quebrado é recusado, não contornado', () => {
  const box = sandbox();
  const res = spawnSync('/bin/bash', [installSh, '--update'], {
    env: {
      HOME: box.dir,
      PATH: `${box.nodeDir}:${LAUNCHD_PATH}`, // um node BOM está disponível
      SHELL: box.fakeShell,
      FORGE_NODE_PATH: path.join(box.dir, 'nao-existe'),
      FORGE_LOGIN_TIMEOUT: '5',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert(res.status !== 0,
    'o override quebrado foi contornado em silêncio — o operador não teria como saber ' +
      'que o caminho que ele definiu foi ignorado');
  assert(/FORGE_NODE_PATH/.test(String(res.stderr)),
    `o erro não nomeia o override: ${res.stderr}`);
});

check('sem node em lugar nenhum, o erro diz onde se procurou', () => {
  const box = sandbox();
  fs.writeFileSync(box.fakeShell, '#!/bin/bash\nexit 1\n'); // shell não responde
  fs.chmodSync(box.fakeShell, 0o755);
  // HOME vazio e PATH sem node. Caminhos fixos (/opt/homebrew, /usr/local) são
  // da máquina real: se um deles tiver node, este caso não é alcançável e o
  // teste não tem o que afirmar.
  const hasRealNode = ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']
    .some((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } });
  if (hasRealNode) {
    console.log('    (a máquina tem node num caminho fixo — caso não alcançável aqui)');
    return;
  }
  const res = spawnSync('/bin/bash', [installSh, '--update'], {
    env: { HOME: box.dir, PATH: path.join(box.dir, 'vazio'), SHELL: box.fakeShell, FORGE_LOGIN_TIMEOUT: '5' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert(res.status !== 0, 'sem node o instalador deveria falhar');
  const err = String(res.stderr);
  assert(/node não encontrado/.test(err), `o erro não é o diagnóstico do wrapper: ${err}`);
  assert(/FORGE_NODE_PATH=\/caminho\/para\/node/.test(err),
    `o diagnóstico não diz como consertar: ${err}`);
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
