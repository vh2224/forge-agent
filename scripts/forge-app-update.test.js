#!/usr/bin/env node
'use strict';

// forge-app-update.test.js — standing regression guard for self-update.
//
// The app can detect a new release (UpdateStore.check compares git tags) and
// run the installer for you. What it could not do, until v3.1.0, was update
// ITSELF: `runUpdate()` shelled out to `install.sh --update`, and the app build
// lives behind `--with-app`. So the button refreshed every agent, skill, script
// and hook, printed success, and left the one binary the operator was looking
// at on the old version. Nothing failed — which is exactly why it survived.
//
// Three invariants, all cheap to check and all silent when they break:
//
//   1. The installer command passes `--with-app`. Without it the shared Node
//      installer skips the Swift build and the update
//      appears to have worked.
//   2. Replacing the bundle does not replace the running process, so the app
//      must offer a relaunch after an update rather than letting a stale window
//      look current. `needsRelaunch` + `relaunch()` are that affordance.
//   3. "Atualizar" uses the remote/stable updater and never pulls the local
//      clone. "Reinstalar" is the only explicit local-source affordance.
//
// Since v3.2.0 the anchors moved rather than loosened: both affordances share one
// runner (`runInstaller`) and one command builder (`InstallerCommand.build`, in
// ForgeKit), so the asserts that used to read `runUpdate()`'s body now read
// whichever of the two actually owns the property.
//
// It also pins the Node core that owns the gate. install.sh is intentionally a
// thin cross-platform wrapper and must not duplicate this implementation.
//
// Like forge-app-workspace.test.js and unlike forge-app.test.js, this is pure
// file reading — no swift invocation — so it NEVER skips and runs everywhere,
// including CI and Windows.
//
// Zero deps, standalone runner (repo convention): exit != 0 on any failure.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const updatesSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'Updates.swift');
const updateCoreSwift = path.join(repoRoot, 'app', 'Sources', 'ForgeKit', 'UpdateCore.swift');
const forgeAppSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'ForgeApp.swift');
const installSh = path.join(repoRoot, 'install.sh');
const installerJs = path.join(repoRoot, 'scripts', 'forge-installer.js');

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

/// Strip `//` line comments so a comment that merely MENTIONS a pattern cannot
/// satisfy — or trip — a guard. The doc comments in Updates.swift deliberately
/// discuss `--with-app` at length; matching them would make every assertion
/// below pass on a file whose code had been gutted.
function stripLineComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

// Shell comments, and ONLY whole-line ones. A `#` mid-line is code far more
// often than prose (`${VAR#prefix}`), and a stripper that ate those would
// quietly blind every assert below — the failure mode this file exists to
// prevent. install.sh documents the app build in prose; that is a mention, not
// a duplication.
function stripShellComments(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/// Extract a function body by COUNTING BRACES, not by regex.
///
/// The previous version matched `/func runUpdate\(\)\s*\{[\s\S]*?\n    \}/` — non
/// greedy up to the first line that is four spaces and a closing brace. Once
/// `runUpdate()` gained closures (`onLine:`/`onExit:`, whose closing lines are
/// `    }, onExit: { code in` and `    })`), that regex truncated the body at the
/// first nested closure — and a guard asserting something is ABSENT from the body
/// would then pass because of the truncation rather than the code. See the
/// bite-proof case at the bottom.
function bodyOf(source, signature) {
  const at = source.indexOf(signature);
  assert(at !== -1, `assinatura não encontrada: ${signature}`);
  const open = source.indexOf('{', at);
  assert(open !== -1, `sem abertura de bloco após ${signature}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`bloco não fechado em ${signature}`);
}

/// The text preceding the `{` that opens the block containing `index` — i.e. the
/// condition an assignment sits under. Used to prove WHERE `needsRelaunch = true`
/// happens, instead of hoping it is near the right line.
function enclosingBlockHeader(source, index) {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    const c = source[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) return source.slice(source.lastIndexOf('\n', i) + 1, i);
      depth--;
    }
  }
  return null;
}

function indexesOf(source, re) {
  const out = [];
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = rx.exec(source)) !== null) out.push(m.index);
  return out;
}

console.log('\n=== forge app · self-update ===\n');

const updatesSource = read(updatesSwift);
const updatesCode = stripLineComments(updatesSource);
const coreCode = stripLineComments(read(updateCoreSwift));
const appCode = stripLineComments(read(forgeAppSwift));
const installSource = read(installSh);
const installCode = stripShellComments(installSource);
const installerSource = read(installerJs);

check('o core Node mantém --with-app load-bearing e o shell permanece fino', () => {
  assert(
    /arg === ['"]--with-app['"]\) result\.withApp = true/.test(installerSource),
    'forge-installer.js não mapeia --with-app para withApp=true'
  );
  assert(
    /const app = installApp\(repo, plan, options, paths\.platform\)/.test(installerSource),
    'o instalador não encaminha a instalação concluída ao build do app'
  );
  assert(/exec\s+"\$\{FORGE_NODE\}"\s+"\$\{REPO_DIR\}\/scripts\/forge-installer\.js"/.test(installSource),
    'install.sh deixou de delegar ao core Node');
  assert(!/swift build|app\/build\.sh/.test(installCode),
    'install.sh voltou a duplicar o build do app');
});

check('nem o app nem o install.sh confiam no PATH para achar o node', () => {
  // Regressão medida em 2026-08-20 (app v4.18.0): "Atualizar" saía com
  // "código 127 — exec: node: not found". O app roda o comando por
  // `bash -lc`, herdando o PATH mínimo do launchd
  // (/usr/bin:/bin:/usr/sbin:/sbin), e um login bash não lê o ~/.zshrc onde
  // nvm/fnm se instalam. As duas pontas são consertadas de propósito: o app
  // injeta o node que o NodeLocator já resolveu, e o install.sh mantém a
  // própria busca de bootstrap para quem o chama fora do app.
  assert(!/^\s*exec\s+node\s/m.test(installSource),
    'install.sh voltou a fazer `exec node` — sob o PATH do launchd isso sai 127');
  assert(/FORGE_NODE_PATH/.test(installSource),
    'install.sh não honra mais o override FORGE_NODE_PATH — um node fora do padrão ' +
      'deixaria de ter escape');
  assert(/-lic/.test(installSource),
    'install.sh não pergunta mais ao shell de login — é o único jeito de achar o nvm, ' +
      'que não publica shim nenhum');
  // A prova positiva do lado do app: o builder recebe o node e o põe no PATH.
  assert(/nodePath:\s*String\?/.test(coreCode),
    'InstallerCommand.build não recebe mais o node resolvido');
  assert(/PATH=\\\(ShellQuote\.posix\(dir\)\)/.test(coreCode),
    'o builder não prefixa mais o diretório do node no PATH do instalador');
  assert(/InstallerCommand\.build\([^)]*nodePath:\s*ForgeCore\.nodePath/.test(updatesCode),
    'runInstaller() não passa mais ForgeCore.nodePath — o app voltaria a depender ' +
      'do PATH herdado do launchd');
});

const buildBody = bodyOf(coreCode, 'static func build(');
const runnerBody = bodyOf(updatesCode, 'func runInstaller(');

check('a consulta de versão lê tags do servidor sem fetch no clone', () => {
  const checkBody = bodyOf(updatesCode, 'func check()');
  assert(/ls-remote/.test(checkBody), 'check() não consulta as tags diretamente no servidor');
  assert(!/fetch|origin\/HEAD|--sort=-v:refname/.test(checkBody),
    'check() voltou a atualizar ou usar refs do clone local');
});

check('InstallerCommand.build passa --update E --with-app nos dois modos', () => {
  assert(
    buildBody.includes('--update'),
    'o comando do instalador não passa --update'
  );
  assert(
    buildBody.includes('--with-app'),
    'o comando do instalador não passa --with-app — o app atualizaria tudo menos ' +
      'ele mesmo (forge-installer.js gateia o build do app em withApp)'
  );
});

check('update é remoto e reinstall é a única fonte local explícita', () => {
  assert(
    /case\s+\.update:\s*return\s+installer\b/.test(buildBody),
    'o modo update não usa mais o updater remoto padrão'
  );
  assert(
    /case\s+\.reinstall:[^\n]*--source local --repo/.test(buildBody),
    'reinstall não declara a fonte local explicitamente'
  );
  assert(!/pull --ff-only/.test(buildBody), 'InstallerCommand voltou a puxar o clone local');
});

check('o runner roda o instalador headless, não num Terminal', () => {
  assert(
    !/openTerminal/.test(runnerBody),
    'runInstaller() ainda abre um Terminal — o progresso tem que ser exibido pelo app'
  );
  // A ausência sozinha passaria num corpo vazio: exigir a prova positiva.
  assert(
    /ForgeCore\.stream\(/.test(runnerBody),
    'runInstaller() não chama ForgeCore.stream — sem streaming a barra fica parada ' +
      'durante os minutos de swift build'
  );
});

check('as duas entradas delegam ao runner e não constroem comando', () => {
  for (const sig of ['func runUpdate()', 'func runReinstall()']) {
    const body = bodyOf(updatesCode, sig);
    assert(
      /runInstaller\(/.test(body),
      `${sig} não delega a runInstaller — os dois caminhos voltariam a divergir`
    );
    for (const forbidden of ['ForgeCore.stream', 'install.sh', 'pull',
                             'needsRelaunch', 'InstallerCommand.build']) {
      assert(
        !body.includes(forbidden),
        `${sig} menciona ${forbidden} — é caminho de execução duplicado, não entrada fina`
      );
    }
  }
});

check('o runner não inspeciona nem modifica o clone local', () => {
  assert(
    !/Self\.git\(|Git\.isDirty\(|pull --ff-only/.test(runnerBody),
    'runInstaller voltou a depender do estado do clone local'
  );
});

check('o guard de repo ausente não é mais silencioso', () => {
  const guardBlock = bodyOf(runnerBody, 'guard let repo else');
  assert(
    /lastError/.test(guardBlock),
    'o `guard let repo else` volta a ser no-op — com "Reinstalar" visível sem versão ' +
      'resolvida, o clique não produziria barra nem erro'
  );
});

check('a UI expõe Reinstalar e ele não se disfarça de Atualizar', () => {
  assert(
    /store\.runReinstall\(\)/.test(updatesCode),
    'nenhuma view chama store.runReinstall() — o runner existiria sem afordance'
  );
  assert(
    /Button\("Reinstalar"\)/.test(updatesCode),
    'o rótulo do botão não é "Reinstalar" — não pode prometer atualização'
  );
  assert(
    indexesOf(updatesCode, /\.disabled\(store\.updating\)/).length >= 2,
    'os dois botões precisam ficar desabilitados durante uma instalação — é o que ' +
      'substitui o diálogo de confirmação'
  );
});

check('needsRelaunch só é setado depois do exit 0 do instalador', () => {
  // Invertido de propósito: até a v3.1.4 este guard exigia a atribuição DENTRO
  // de runUpdate(), que é justamente o bug — o botão aparecia enquanto o
  // instalador ainda compilava, e clicar nele matava o build.
  assert(
    !/needsRelaunch\s*=\s*true/.test(runnerBody),
    'runInstaller() seta needsRelaunch — o botão apareceria com o instalador ainda ' +
      'rodando, e clicar nele mata o build'
  );
  const sites = indexesOf(updatesCode, /needsRelaunch\s*=\s*true/);
  assert(
    sites.length > 0,
    'ninguém seta needsRelaunch — a janela ficaria no binário antigo sem afordance'
  );
  for (const at of sites) {
    const header = enclosingBlockHeader(updatesCode, at);
    assert(header !== null, 'atribuição fora de qualquer bloco');
    assert(
      /canRelaunch|==\s*0/.test(header),
      'needsRelaunch = true não está sob uma condição de exit code zero: ' +
        `\`${header.trim()}\``
    );
  }
});

check('existe o afordance de reabrir (needsRelaunch + relaunch())', () => {
  assert(
    /@Published\s+var\s+needsRelaunch/.test(updatesCode),
    'needsRelaunch não é @Published — a view não reagiria a ele'
  );
  assert(
    /func relaunch\(\)/.test(updatesCode),
    'relaunch() não existe'
  );
  const relaunchBody = bodyOf(updatesCode, 'func relaunch()');
  assert(
    /terminate/.test(relaunchBody),
    'relaunch() não encerra a instância antiga'
  );
  // `open -n` mudou de lugar: dispará-lo antes da confirmação de término deixava
  // duas instâncias quando o alerta de sessões vivas era cancelado.
  assert(
    !relaunchBody.includes('"-n"'),
    'relaunch() ainda sobe a nova cópia antes da confirmação de término'
  );
  const launchBody = bodyOf(updatesCode, 'func launchNewInstance()');
  assert(
    launchBody.includes('"-n"'),
    'launchNewInstance() não usa `open -n` — sem isso a nova cópia não sobe antes desta sair'
  );
});

check('a nova instância só sobe depois de o término ser confirmado', () => {
  const body = bodyOf(appCode, 'func applicationShouldTerminate(');
  assert(
    /relaunchPending/.test(appCode),
    'ForgeApp não consulta relaunchPending'
  );
  assert(
    /launchNewInstance\(\)/.test(body) ||
      /launchNewInstance\(\)/.test(bodyOf(appCode, 'func terminateNow()')),
    'applicationShouldTerminate não dispara launchNewInstance() — a ordenação ' +
      'corrigida (terminar → relançar) não está garantida'
  );
});

check('a UI expõe o botão de reabrir quando needsRelaunch', () => {
  assert(
    /store\.needsRelaunch/.test(updatesCode),
    'nenhuma view lê store.needsRelaunch — o estado existiria sem afordance'
  );
  assert(
    /store\.relaunch\(\)/.test(updatesCode),
    'nenhuma view chama store.relaunch()'
  );
});

// Bite-proof: the comment-stripping must not be the reason a guard passes.
check('o matcher ignora menções em comentário (bite-proof)', () => {
  const onlyComment = '// runUpdate() should pass --with-app and set needsRelaunch = true\nfunc x() {}';
  const stripped = stripLineComments(onlyComment);
  assert(
    !stripped.includes('--with-app'),
    'stripLineComments deixou passar uma menção em comentário'
  );
  assert(
    !/needsRelaunch\s*=\s*true/.test(stripped),
    'stripLineComments deixou passar uma atribuição comentada'
  );
});

// Bite-proof II: a mention in a comment must not SATISFY the "someone sets it
// under exit 0" half of the guard either. Absence proofs and presence proofs
// need the same matcher.
check('atribuição só em comentário não satisfaz a prova positiva (bite-proof)', () => {
  const fake = [
    'func finishUpdate(exitCode: Int32) {',
    '    if UpdateOutcome.canRelaunch(exitCode: exitCode) {',
    '        // needsRelaunch = true',
    '    }',
    '}',
  ].join('\n');
  assert(
    indexesOf(stripLineComments(fake), /needsRelaunch\s*=\s*true/).length === 0,
    'um fonte que só menciona a atribuição em comentário contaria como prova'
  );
});

// Bite-proof III: the reason the regex had to go. This is the shape runUpdate()
// actually has now — closures whose closing lines start with four spaces.
check('bodyOf não trunca em closure aninhada (bite-proof)', () => {
  const fake = [
    'func runUpdate() {',
    '    ForgeCore.stream(cwd: r, command: c, onLine: { line in',
    '        keep(line)',
    '    }, onExit: { code in',
    '        needsRelaunch = true',
    '    })',
    '}',
  ].join('\n');

  const body = bodyOf(fake, 'func runUpdate()');
  assert(
    /needsRelaunch\s*=\s*true/.test(body),
    'bodyOf perdeu a atribuição dentro da closure — o guard de ausência passaria ' +
      'por truncamento, não por mérito'
  );

  // And the matcher that used to be here would have missed it, silently.
  const old = fake.match(/func runUpdate\(\)\s*\{[\s\S]*?\n    \}/);
  assert(
    old && !/needsRelaunch\s*=\s*true/.test(old[0]),
    'o regex antigo deveria truncar aqui — se não trunca, este caso não prova nada'
  );

  // The header walk must find the closure's condition, not the function's.
  const at = indexesOf(fake, /needsRelaunch\s*=\s*true/)[0];
  assert(
    /onExit/.test(enclosingBlockHeader(fake, at) || ''),
    'enclosingBlockHeader não achou o bloco imediato da atribuição'
  );
});

check('o stripper de shell ignora comentário mas não engole código (bite-proof)', () => {
  assert(stripShellComments('# swift build\necho ok').trim() === 'echo ok',
    'o stripper não removeu um comentário de linha inteira');
  assert(/swift build/.test(stripShellComments('  swift build --package-path app')),
    'uma duplicação real do build escapou do assert — o guard ficaria cego');
  assert(/\$\{PATH#\/usr\}/.test(stripShellComments('X="${PATH#/usr}"')),
    'o stripper comeu um `#` que era código, não comentário');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
