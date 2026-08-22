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

  // Stand-ins for the directories a minimal launcher PATH is made of. The
  // literal '/usr/bin:/bin:/usr/sbin:/sbin' cannot express "a PATH that cannot
  // resolve node": every CI runner ships /usr/bin/node, so on those machines the
  // literal string resolves node and the scenario evaporates. These are empty
  // and owned by the test, so the property is the same everywhere.
  const sysDirs = ['usr-bin', 'bin'].map((n) => {
    const d = path.join(dir, 'sys', n);
    fs.mkdirSync(d, { recursive: true });
    return d;
  });

  // A fixed-candidate list that resolves to nothing, for the cases whose whole
  // subject is what happens when the fixed rung misses. Without it those cases
  // are unreachable wherever node sits at a fixed path.
  const noFixed = path.join(dir, 'sem-node', 'node');

  // Um SEGUNDO node de mentira, para o degrau dos caminhos fixos. Precisa ser
  // distinto do que o shell de login devolve: se os dois degraus respondessem o
  // mesmo binário, um teste do degrau 3 passaria de graça sempre que a resolução
  // escorregasse para o degrau 4 — foi assim que a primeira versão deste caso
  // não mordeu quando o laço foi mutado para rodar em subshell.
  const fixedNodeDir = path.join(dir, 'fixed', 'bin');
  fs.mkdirSync(fixedNodeDir, { recursive: true });
  const fixedNode = path.join(fixedNodeDir, 'node');
  fs.writeFileSync(fixedNode, '#!/bin/bash\necho "CORE_PATH=$PATH"\nexit 0\n');
  fs.chmodSync(fixedNode, 0o755);

  return { dir, nodeDir, operatorDir, fakeNode, fakeShell, sysDirs,
           minimalPath: sysDirs.join(':'), noFixed, fixedNodeDir, fixedNode };
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


check('sob o PATH de um launcher, o core recebe o PATH do operador', () => {
  // Este caso também é o guard do degrau 2 do install.sh, e a razão é medida: o
  // wrapper apenda um piso (/usr/bin:/bin:...) ao PATH antes de procurar node.
  // Enquanto o degrau 2 procurava no PATH JÁ com o piso, um /usr/bin/node do
  // sistema — que todo runner de CI tem — era lido como "o PATH herdado é o do
  // operador", a fonte virava `path`, o empréstimo era suprimido e o install
  // morria em "capability obrigatória ausente para claude". Aqui o PATH herdado
  // não resolve node de jeito nenhum, então exigir o empréstimo reprova aquela
  // leitura.
  const box = sandbox();
  const { path: got, res } = corePath({
    HOME: box.dir,
    PATH: box.minimalPath,
    SHELL: box.fakeShell,
    FORGE_NODE_FIXED_CANDIDATES: box.noFixed,
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
  for (const keep of box.sysDirs) {
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
    FORGE_NODE_FIXED_CANDIDATES: box.noFixed, // nem caminho fixo responde antes
    FORGE_LOGIN_TIMEOUT: '5',
  });
  // Sem a costura acima, um /usr/bin/node do sistema responderia antes do shell
  // de login e este caso — o único que exercita o degrau que consertou o 127 —
  // nunca seria alcançado onde ele mais precisa valer.
  assert(res.status === 0, `install.sh saiu ${res.status}: ${res.stderr}`);
  assert(got !== null, `o core não foi executado:\n${res.stdout}\n${res.stderr}`);
  assert(!/not found/i.test(String(res.stderr)), `saída de erro inesperada: ${res.stderr}`);
});

check('o caminho fixo resolve e ainda assim empresta o PATH do operador', () => {
  // Duas coisas de uma vez. (a) O degrau dos caminhos fixos não tinha teste
  // nenhum, e é o que roda num Mac com Homebrew — o caso mais comum que existe.
  // (b) Ele percorre a lista com `while ... done <<EOF`, e um laço alimentado
  // por pipe rodaria em subshell: FORGE_NODE seria atribuído lá dentro e
  // voltaria vazio, o mesmo tropeço de shell que este arquivo documenta no
  // topo. Se o laço perder a atribuição, o core não é executado e isto reprova.
  const box = sandbox();
  const { path: got, res } = corePath({
    HOME: box.dir,
    PATH: box.minimalPath, // o PATH herdado não resolve node
    SHELL: box.fakeShell,
    FORGE_NODE_FIXED_CANDIDATES: `${path.join(box.dir, 'nao-existe')}:${box.fixedNode}`,
    FORGE_LOGIN_TIMEOUT: '5',
  });
  assert(got !== null,
    `o degrau fixo não chegou a executar o core (exit ${res.status}):\n${res.stdout}\n${res.stderr}`);
  const dirs = got.split(':');
  // O node do degrau fixo é DIFERENTE do que o shell de login devolve, então
  // esta linha separa os dois degraus: se o laço perder a atribuição num
  // subshell, a resolução escorrega para o degrau 4 e o primeiro diretório é o
  // outro — que é como esta asserção morde.
  assert(dirs[0] === box.fixedNodeDir,
    `o node do caminho fixo não é o primeiro do PATH (degrau 3 não resolveu): ${got}`);
  assert(dirs.includes(box.operatorDir),
    'resolver por caminho fixo não é evidência de que o PATH herdado é o do ' +
      `operador — o empréstimo tinha de acontecer mesmo assim.\nPATH: ${got}`);
});

check('com o PATH do operador, nada é emprestado do shell de login', () => {
  // A evidência de que o PATH herdado é o do operador é ele resolver node
  // sozinho. Nesse caso o wrapper não paga subshell nenhum nem reescreve o que
  // o chamador montou de propósito.
  const box = sandbox();
  const { path: got, res } = corePath({
    HOME: box.dir,
    PATH: `${box.nodeDir}:${box.minimalPath}`,
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
    PATH: box.minimalPath,
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
      PATH: `${box.nodeDir}:${box.minimalPath}`, // um node BOM está disponível
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
  // Este caso já se pulou sozinho em toda máquina com node num caminho fixo,
  // imprimindo uma nota e contando como ✓ — um gate que reporta verde sem ter
  // medido nada, que é exatamente a patologia que este repo persegue. A costura
  // de candidatos torna o caso alcançável em qualquer lugar, então o pulo
  // ambiente saiu.
  const res = spawnSync('/bin/bash', [installSh, '--update'], {
    env: {
      HOME: box.dir,
      PATH: path.join(box.dir, 'vazio'),
      SHELL: box.fakeShell,
      FORGE_NODE_FIXED_CANDIDATES: box.noFixed,
      FORGE_LOGIN_TIMEOUT: '5',
    },
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
