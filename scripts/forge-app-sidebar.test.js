#!/usr/bin/env node
'use strict';

// forge-app-sidebar.test.js — standing guard for the sidebar redesign.
//
// Everything this suite pins is a SUBTRACTION, and subtractions are the easiest
// changes in the world to undo by accident: nobody notices a badge that comes
// back, and nobody notices a preview file that quietly stops existing. So each
// invariant below is one that would fail silently if it regressed.
//
//   1. `badge(for:)` has no `.updates` case (D27). The numeral it used to show
//      was always `1` — it counted nothing. One signal, one place: the footer.
//      Asserted together with the four cases that DO count something, so the
//      guard cannot pass on a gutted function.
//   2. The sidebar list has exactly one `Divider()`, after `.runs` (D29), and it
//      lives inside the single `ForEach(Section.allCases)`. Splitting `allCases`
//      into two arrays is the one way D29 could invalidate a saved preference,
//      because `Stores.swift` feeds `SectionRestore`'s validator from it (D31) —
//      so `allCases` staying whole is asserted too.
//   3. `RootView` observes `UpdateStore` (D32). Without it SwiftUI never
//      re-renders the sidebar when `checkOnLaunch` publishes, and every update
//      signal in this column is born empty. This was a real pre-existing bug,
//      not a hypothetical.
//   4. The footer shows the RUNNING version and the sentinel for "unknown" is
//      the ABSENCE of the `ForgeGitDescribe` bundle key — never a comparison
//      against `0.1.0` (D25). `0.1.0` is the placeholder in the versioned
//      Info.plist and also a legitimate version string: filtering it would blank
//      the footer for whoever actually shipped it, with no findable cause. The
//      shortcut is tempting for exactly as long as the placeholder is still
//      there, which is why this is pinned rather than trusted.
//   5. The version label wraps instead of truncating (`fixedSize`, no
//      `lineLimit(1)`). At the 180pt minimum the ellipsis eats the second number,
//      which is the one R9 says must be legible.
//   6. The preview harness is alive: `Previews.swift` exists, is inside
//      `#if DEBUG`, and still has previews. On a machine without Xcode the
//      harness is the only way to judge form at a fixed width, and a chunk that
//      deletes it would look like a passing build.
//   7. `build.sh` stamps the bundle copy of Info.plist, and stamps it strictly
//      BETWEEN the plist copy and `codesign` (D25, R8). Both fronteiras are
//      invisible at runtime — out of order, the build still exits 0 and the app
//      still launches — while one order dirties the versioned file on every build
//      and the other invalidates the signature. Nothing but a guard notices.
//   8. The `versionCard` has no 54pt `Circle` (D28) — and still has all three
//      states of its action slot, "Atualizar" and "Reinstalar" together (D34).
//      Both halves are asserted in the same place on purpose: the subtraction is
//      the icon column and only the icon column, and "simplifying the card" is
//      exactly how a property bought with a review objection gets lost.
//   9. No two `## <version>` headings in CHANGELOG.md, and no `## Unreleased`
//      at all (D36). `Release.id` is the version string, so a repeat is a
//      duplicate id in a `ForEach` — undefined behaviour, and silent. This was
//      real: `## Unreleased` sat at line 1 and line 104. Renaming the two fixed
//      the file; only this guard stops the habit that produced them. The
//      detection is the APP'S OWN rule, not a literal string: the literal
//      `'\n## Unreleased'` this guard used ran green across the six tags from
//      v4.2.0 to v4.6.1 while line 1 read `## [Unreleased]`. Two brackets
//      evaded the only mechanism that existed against exactly that regression,
//      so the guard is paired with a case proving it bites. Section ids are
//      guarded on the same footing: `ReleaseSection.id` identifies a section
//      inside the card, and while every heading outside the enum collapsed to
//      `.other` ("Outros") eight releases handed `ForEach` repeated ids.
//
// Pure file reading, like forge-app-update.test.js and unlike forge-app.test.js:
// no swift invocation, so it NEVER skips and runs everywhere, Windows included.
//
// Zero deps, standalone runner (repo convention): exit != 0 on any failure.

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const viewsSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'Views.swift');
const storesSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'Stores.swift');
const previewsSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'Previews.swift');
const updatesSwift = path.join(repoRoot, 'app', 'Sources', 'Forge', 'Updates.swift');
const updateCoreSwift = path.join(repoRoot, 'app', 'Sources', 'ForgeKit', 'UpdateCore.swift');
const buildSh = path.join(repoRoot, 'app', 'build.sh');
const changelogMd = path.join(repoRoot, 'CHANGELOG.md');

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
/// satisfy — or trip — a guard. The doc comments in Views.swift discuss D27, D29
/// and D32 by name at length; matching them would make the assertions below pass
/// on a file whose code had been gutted.
function stripLineComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//');
      return i === -1 ? line : line.slice(0, i);
    })
    .join('\n');
}

/// Extract a block body by COUNTING BRACES, not by regex. Same helper, and the
/// same reasoning, as forge-app-update.test.js: a non-greedy regex terminates at
/// the first nested closure, and a guard that asserts something is ABSENT from a
/// truncated body passes because of the truncation rather than the code.
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

function countOf(source, needle) {
  let n = 0;
  let i = 0;
  for (;;) {
    const at = source.indexOf(needle, i);
    if (at === -1) return n;
    n++;
    i = at + needle.length;
  }
}

console.log('\nforge-app-sidebar.test.js\n');

// ---------------------------------------------------------------- D27: no badge

check('badge(for:) não tem mais caso .updates (D27)', () => {
  const views = stripLineComments(read(viewsSwift));
  const body = bodyOf(views, 'private func badge(for');
  assert(
    !body.includes('.updates'),
    'o caso `.updates` voltou a `badge(for:)` — o numeral da sidebar era sempre 1 '
      + 'e o sinal de update pertence ao rodapé (D27)'
  );
});

check('badge(for:) mantém os quatro casos que contam coisa de verdade', () => {
  const views = stripLineComments(read(viewsSwift));
  const body = bodyOf(views, 'private func badge(for');
  // `.now` left the enum with the Início screen; the gate count it carried
  // moved onto `.terminal`, which is where the banner now lives.
  for (const c of ['.runs', '.terminal', '.projects']) {
    assert(
      body.includes(`case ${c}:`),
      `\`case ${c}:\` desapareceu de badge(for:) — a ausência da D27 estaria sendo `
        + 'provada por uma função gutada, não pela decisão'
    );
  }
});

check('nenhum outro caminho reintroduz o numeral de update na lista', () => {
  const views = stripLineComments(read(viewsSwift));
  const list = bodyOf(views, 'private var sidebarList');
  assert(
    !/updateAvailable/.test(list),
    'a lista da sidebar voltou a ler `updateAvailable` — a D27 move esse sinal para '
      + 'o rodapé, e ter os dois é exatamente o que ela subtrai'
  );
});

// ------------------------------------------------------------- D29: one Divider

check('sidebarList tem exatamente um Divider(), depois de .runs (D29)', () => {
  const views = stripLineComments(read(viewsSwift));
  const list = bodyOf(views, 'private var sidebarList');
  const n = countOf(list, 'Divider()');
  assert(n === 1, `esperado exatamente 1 Divider() em sidebarList, encontrados ${n}`);
  const atDivider = list.indexOf('Divider()');
  const atRuns = list.indexOf('.runs');
  assert(atRuns !== -1, '`.runs` não aparece em sidebarList — o âncora da D29 sumiu');
  assert(
    atRuns < atDivider,
    'o Divider() aparece antes de `.runs`: a D29 fecha o bloco de trabalho '
      + '(Terminal, Projetos, Itens, Runs), então a régua vem depois de Runs'
  );
});

check('o Divider é emitido dentro do único ForEach(Section.allCases)', () => {
  const views = stripLineComments(read(viewsSwift));
  const list = bodyOf(views, 'private var sidebarList');
  const n = countOf(list, 'ForEach(Section.allCases)');
  assert(
    n === 1,
    `esperado 1 ForEach(Section.allCases) em sidebarList, encontrados ${n} — `
      + 'quebrar allCases em dois arrays cria uma segunda fonte de verdade ao lado '
      + 'do validador do SectionRestore (D31)'
  );
  const atForEach = list.indexOf('ForEach(Section.allCases)');
  assert(
    atForEach < list.indexOf('Divider()'),
    'o Divider() está fora do ForEach — a D29 é por iteração, não por concatenação'
  );
});

// ------------------------------------------------------- D31: allCases intacto

check('a sidebar renderiza Section.title, nunca o rawValue (rotulo != chave)', () => {
  const src = read(viewsSwift);
  const lines = stripLineComments(src).split('\n');
  const list = lines.slice(lines.findIndex((l) => l.includes('private var sidebarList')));
  const end = list.findIndex((l, i) => i > 0 && /^    \}/.test(l));
  const body = list.slice(0, end === -1 ? 60 : end).join('\n');
  assert(!/Text\(s\.rawValue\)/.test(body),
    'a sidebar voltou a exibir s.rawValue. rawValue e a CHAVE de persistencia '
    + '(Stores.swift grava section?.rawValue em UserDefaults("lastSection") e valida o restore '
    + 'contra Section.allCases.map(\\.rawValue)); exibir por ele faz qualquer renome de rotulo '
    + 'derrubar a secao restaurada de todo usuario (MEM004). Use Section.title.');
  assert(/Text\(s\.title\)/.test(body),
    'a sidebar nao exibe Section.title — o rotulo deixou de ter fonte propria');
});

check('Section.title cobre todos os casos e items le "Tarefas"', () => {
  const src = stripLineComments(read(viewsSwift));
  assert(/var title: String/.test(src), 'Section.title sumiu — rotulo e chave voltaram a ser a mesma coisa');
  assert(/case \.items: return "Tarefas"/.test(src),
    'Section.items deveria exibir "Tarefas" enquanto persiste como "Itens"');
  assert(/case items = "Itens"/.test(src),
    'o rawValue de items mudou — isso invalida o lastSection gravado, que e justamente o que title evita');
});

check('Section tem 12 casos e nenhum rawValue mudou (D31)', () => {
  // R1: contar `case \w+ = "` só prova a CONTAGEM — um rename mantém 13 casos e
  // passaria mesmo assim, degradando silenciosamente toda seleção salva em
  // `UserDefaults("lastSection")` (Stores.swift persiste `section?.rawValue` e
  // valida o restore contra `Section.allCases.map(\.rawValue)`) para o fallback.
  // A lista explícita e ORDENADA é o que de fato ancora "nenhum rawValue mudou".
  //
  // "Início" saiu daqui por REMOÇÃO DELIBERADA da seção, não por renome: a tela
  // não tinha mais conteúdo próprio (composer foi para Terminal, tirinhas de run
  // eram um RunsView pior, e o banner de gates foi junto para Terminal). O
  // fallback passou a ser `.terminal` — quem tinha "Início" salvo cai na tela
  // que a absorveu. Este guard segue proibindo renome e remoção silenciosa: para
  // mexer de novo é preciso editar esta lista e dizer por quê.
  const EXPECTED_RAW_VALUES = [
    'Terminal', 'Projetos', 'Itens', 'Runs',
    'Contas', 'Métricas', 'Modelos', 'Segredos', 'Preferências',
    'Histórico', 'Atualizações', 'Exemplos',
  ];
  const views = stripLineComments(read(viewsSwift));
  const decl = bodyOf(views, 'enum Section: String, CaseIterable, Identifiable');
  const cases = decl.match(/^\s*case \w+ = "([^"]*)"/gm) || [];
  const rawValues = cases.map((c) => c.match(/=\s*"([^"]*)"/)[1]);
  assert(
    rawValues.length === 12,
    `esperados 12 casos em Section, encontrados ${rawValues.length} — a D29 não renomeia `
      + 'nem remove seção nenhuma (D31)'
  );
  assert(
    !rawValues.includes('Início'),
    '"Início" voltou para Section sem que este guard fosse atualizado — se a seção '
      + 'está voltando de verdade, diga aqui por quê; se não, é rawValue órfão'
  );
  assert(
    JSON.stringify(rawValues) === JSON.stringify(EXPECTED_RAW_VALUES),
    'um ou mais rawValue de Section mudaram (D31): '
      + `esperado ${JSON.stringify(EXPECTED_RAW_VALUES)}, encontrado ${JSON.stringify(rawValues)} — `
      + 'isso rebaixa silenciosamente qualquer seleção salva de sidebar para o fallback'
  );
});

check('o fallback do lastSection aponta para uma seção que existe (D31)', () => {
  // O buraco que a remoção de "Início" abriria: `SectionRestore` valida contra
  // `allCases`, mas o FALLBACK é uma constante escrita à mão. Um fallback
  // apontando para um caso removido não compila hoje — e um apontando para um
  // caso que existe mas não é a tela certa passa batido, então ele é fixado.
  const stores = stripLineComments(read(storesSwift));
  assert(
    /fallback:\s*Section\.terminal\.rawValue/.test(stores),
    'o fallback de lastSection não é mais `Section.terminal.rawValue` — depois que '
      + 'Início saiu, é a tela que absorveu o conteúdo dela, e portanto onde quem '
      + 'tinha "Início" salvo tem que aterrissar'
  );
  assert(
    !/Section\.now/.test(stores),
    'Stores.swift ainda menciona Section.now — a seção foi removida do enum'
  );
});

check('Stores.swift continua alimentando o validador com allCases (D31)', () => {
  const stores = stripLineComments(read(storesSwift));
  assert(
    stores.includes('Section.allCases.map(\\.rawValue)'),
    'Stores.swift não usa mais `Section.allCases.map(\\.rawValue)` — é a única porta '
      + 'pela qual a D29 poderia invalidar a seção salva do operador (D31)'
  );
});

// ------------------------------------------------------- D32: RootView observa

check('RootView observa o UpdateStore (D32)', () => {
  const views = stripLineComments(read(viewsSwift));
  const root = bodyOf(views, 'struct RootView: View');
  assert(
    /@(StateObject|ObservedObject)\s+private\s+var\s+\w+\s*=\s*UpdateStore\.shared/
      .test(root),
    'RootView não declara observação de UpdateStore.shared — sem ela a sidebar nunca '
      + 're-renderiza quando o checkOnLaunch publica, e todo sinal de update nesta '
      + 'coluna nasce vazio e fica vazio (D32)'
  );
});

// --------------------------------------------- anti-deleção do harness (chunk 1)

check('o harness de preview está vivo e sob #if DEBUG', () => {
  const previews = read(previewsSwift);
  assert(
    previews.includes('#if DEBUG'),
    'Previews.swift saiu do #if DEBUG — o harness passaria a compilar no release'
  );
  assert(
    !previews.includes('#Preview('),
    'o macro `#Preview` apareceu: ele vem do plugin PreviewsMacros do Xcode, ausente '
      + 'nas Command Line Tools, e derruba `swift build` — o único sinal autoritativo '
      + 'desta máquina. Use PreviewProvider.'
  );
  // Lower bound, never an exact count: os chunks seguintes acrescentam previews.
  // Subiu de 8 para 12 no chunk 3 (seis estados do rótulo de versão a mais) e de
  // 12 para 14 no chunk 6 (a lista longa da D30), hoje 15 no total. Suba este
  // número quando isso acontecer de novo; nunca o troque por igualdade — foi um
  // must-have de contagem EXATA que impediu o chunk 1 de proteger o próprio
  // harness.
  const n = countOf(previews, 'previewDisplayName');
  assert(
    n >= 14,
    `esperados >= 14 previewDisplayName em Previews.swift, encontrados ${n} — um chunk `
      + 'apagou parte do harness'
  );
});

check('existe preview da sidebar completa a 180pt', () => {
  const previews = read(previewsSwift);
  assert(
    previews.includes('previewSidebarList'),
    'nenhum preview renderiza `previewSidebarList` — o Divider da D29 se julga contra '
      + 'a coluna, não contra uma janela de largura arbitrária'
  );
  assert(
    /previewSidebarList[\s\S]{0,200}?width:\s*180/.test(previews),
    'o preview da sidebar não está travado em 180pt: é o `min:` da coluna, a largura '
      + 'onde qualquer adição tem de caber'
  );
});

// -------------------------------------------- D25/D26: o rodapé mostra a versão

check('o rodapé monta o SidebarVersionLabel, e nada disputa a linha com ele (D26)', () => {
  const views = stripLineComments(read(viewsSwift));
  const footer = bodyOf(views, 'private var sidebarFooter');
  assert(
    footer.includes('SidebarVersionLabel('),
    'o rodapé não monta mais o SidebarVersionLabel — a versão em execução voltou a '
      + 'não ser visível de nenhuma tela (D25/D26)'
  );
  // Este check EXIGIA "Adicionar projeto" no rodapé: a D26 acrescentou a versão
  // ao lado do que ja estava la, e o guard travou aquele arranjo. O operador
  // removeu o botao — a acao existe no menu do app, na toolbar de Projetos e no
  // estado vazio de Projetos, entao nada se perdeu. A PROPRIEDADE que a D26
  // protegia nunca foi "o botao existe": era a largura. A 180pt sobram 152pt
  // uteis, e qualquer controle de ~100pt dividindo a linha faz o texto da versao
  // truncar — e a elipse come justamente o segundo numero (R9). Com o rodape so
  // para a versao, a propriedade fica MAIS forte, nao menos.
  assert(
    !/Label\("Adicionar projeto"/.test(footer),
    'um botão "Adicionar projeto" voltou ao rodapé — a 180pt ele divide a linha com a '
      + 'versão e a elipse come o segundo número (R9). A ação vive no menu do app e na seção Projetos'
  );
  assert(
    !/\bLabel\(|\bTextField\(|\bPicker\(/.test(footer.replace(/SidebarVersionLabel\([^)]*\)/g, '')),
    'outro controle apareceu no rodapé disputando largura com a versão'
  );
});

check('o rótulo de versão deriva o texto de VersionFooter.display (D25)', () => {
  const views = stripLineComments(read(viewsSwift));
  const label = bodyOf(views, 'struct SidebarVersionLabel');
  assert(
    label.includes('VersionFooter.display('),
    'SidebarVersionLabel não chama VersionFooter.display — os quatro estados do '
      + 'rodapé (e a decisão de divergência) são lógica pura testada em ForgeKit, '
      + 'e reimplementá-los na view os tira do alcance dos testes'
  );
});

check('a versão do rodapé leva à seção Atualizações em um clique (D26)', () => {
  const views = stripLineComments(read(viewsSwift));
  const footer = bodyOf(views, 'private var sidebarFooter');
  assert(
    /state\.section\s*=\s*\.updates/.test(footer),
    'clicar a versão não seleciona mais a seção Atualizações: `state.section` é '
      + '@Published e o binding de List(selection:) é bidirecional, então essa '
      + 'atribuição é o que também acende a linha na sidebar (D26)'
  );
});

check('o rótulo quebra em duas linhas em vez de truncar a 180pt', () => {
  const views = stripLineComments(read(viewsSwift));
  const label = bodyOf(views, 'struct SidebarVersionLabel');
  assert(
    /fixedSize\(horizontal:\s*false,\s*vertical:\s*true\)/.test(label),
    'SidebarVersionLabel perdeu `.fixedSize(horizontal: false, vertical: true)` — '
      + 'sem isso o Text é comprimido verticalmente e o pior caso a 180pt trunca'
  );
  assert(
    !/lineLimit\(1\)/.test(label),
    'apareceu `lineLimit(1)` no rótulo de versão: a 180pt o pior caso tem de '
      + 'QUEBRAR, e a elipse esconde justamente o segundo número (R9)'
  );
});

check('modo desenvolvedor: badge por #if DEBUG, sem roubar o sinal de update', () => {
  const views = read(viewsSwift);
  const label = bodyOf(stripLineComments(views), 'struct SidebarVersionLabel');
  assert(/#if DEBUG/.test(label),
    'o badge "dev" não é gateado por #if DEBUG — sem o flag de compilação a única alternativa '
    + 'seria uma heurística sobre o describe, que responde outra pergunta: "tem commits além da tag" '
    + 'é VERDADE para um release cortado no meio do ciclo e FALSO para um debug de tag limpa');
  assert(/"dev"/.test(label), 'o badge "dev" sumiu do rótulo de versão');
  // O badge nao pode virar um segundo sinal de update: laranja e o ponto sao da
  // REGRA VISUAL 1 ("precisa de voce"), e rodar um build de dev e um fato sobre
  // o binario, nao um chamado para acao. Um dev build COM update pendente tem de
  // mostrar os dois — badge e ponto — sem que um se disfarce do outro.
  const devBlock = label.slice(label.indexOf('#if DEBUG'), label.indexOf('#endif'));
  assert(!/accentOrange/.test(devBlock),
    'o badge "dev" usa accentOrange — laranja é reservado a "precisa de você" (REGRA VISUAL 1), '
    + 'e um build de desenvolvimento não é um chamado para ação');
  assert(!/circle\.fill/.test(devBlock),
    'o badge "dev" usa o ponto — o ponto é o sinal de update (D26/D27), e dois sinais com a '
    + 'mesma forma deixam de distinguir estado de chamado');
});

check('o único sinal de update no rodapé é laranja com ponto (D26/D27)', () => {
  const views = stripLineComments(read(viewsSwift));
  const label = bodyOf(views, 'struct SidebarVersionLabel');
  assert(
    label.includes('updateAvailable'),
    'SidebarVersionLabel não lê mais `updateAvailable` — a D27 tirou o numeral da '
      + 'lista prometendo que o sinal viveria aqui; sem isso o app perdeu o sinal'
  );
  assert(
    label.includes('accentOrange'),
    'o rótulo não usa mais Color.accentOrange: laranja = "precisa de você" é a '
      + 'regra visual 1 do arquivo, e o rodapé é agora o único lugar que a exerce'
  );
  assert(
    /circle\.fill|Circle\(\)/.test(label),
    'o ponto de update desapareceu do rótulo — cor sozinha é sinal frágil'
  );
});

// ------------------------------- a sentinela é a AUSÊNCIA da chave, não o 0.1.0

check('a versão em execução vem da chave ForgeGitDescribe do bundle (D25)', () => {
  const updates = stripLineComments(read(updatesSwift));
  assert(
    /Bundle\.main\.object\(forInfoDictionaryKey:\s*"ForgeGitDescribe"\)/.test(updates),
    'o store não lê mais `ForgeGitDescribe` do bundle — voltaria a exibir a tag do '
      + 'repo como se fosse a versão em execução, que é a mentira que a D25 conserta'
  );
  assert(
    /VersionFooter\.stamped\(/.test(updates),
    'a leitura do bundle não passa mais por VersionFooter.stamped — a decisão '
      + '"o que conta como não estampado" é pura e testada; duplicá-la na view a '
      + 'tira do alcance dos testes'
  );
});

check('nada trata o literal 0.1.0 como sentinela de "não estampado"', () => {
  // A sentinela é a AUSÊNCIA da chave custom. `0.1.0` é o placeholder do
  // Info.plist versionado E uma versão perfeitamente legítima: filtrá-la
  // apagaria o rodapé de quem a publicasse de verdade, e a causa seria
  // inachável. Este guard existe porque o atalho é tentador exatamente enquanto
  // o placeholder ainda está lá.
  for (const [name, file] of [
    ['Updates.swift', updatesSwift],
    ['UpdateCore.swift', updateCoreSwift],
    ['Views.swift', viewsSwift],
  ]) {
    const src = stripLineComments(read(file));
    assert(
      !src.includes('0.1.0'),
      `${name} compara com o literal 0.1.0: a sentinela de "build não estampado" `
        + 'é a ausência da chave ForgeGitDescribe, nunca um valor de versão'
    );
  }
});

check('VersionFooter existe em ForgeKit, com os quatro estados alcançáveis', () => {
  const core = stripLineComments(read(updateCoreSwift));
  const decl = bodyOf(core, 'public enum VersionFooter');
  for (const sig of ['static func stamped(', 'static func short(', 'static func display(']) {
    assert(decl.includes(sig), `VersionFooter perdeu \`${sig}\` — é a lógica que o `
      + 'rodapé exibe, e ela mora em ForgeKit porque o target Forge não é '
      + 'importável por target de teste');
  }
  for (const field of ['let text', 'let detail', 'let diverged', 'let known']) {
    assert(
      decl.includes(field),
      `VersionFooter.Display perdeu \`${field}\` — o rodapé precisa dos quatro: `
        + 'texto curto, frase inteira para o .help(), divergência e "sei ou não"'
    );
  }
});

check('divergência é decidida no describe completo, não na forma curta', () => {
  const core = stripLineComments(read(updateCoreSwift));
  const decl = bodyOf(core, 'public enum VersionFooter');
  const body = bodyOf(decl, 'static func display(');
  // A comparação tem de ser entre os valores crus (`r == p`), nunca entre
  // `short(r) == short(p)`: mesma tag e mesma contagem com shas diferentes é
  // justo o caso "commitei e não recompilei" que o rodapé existe para mostrar.
  assert(
    !/short\([^)]*\)\s*==\s*short\(/.test(body),
    'display() compara formas curtas: dois describes com a mesma tag e a mesma '
      + 'contagem de commits seriam lidos como "em dia" mesmo apontando para '
      + 'commits diferentes'
  );
});

// -------------------------------------- previews dos estados do rodapé (chunk 3)

check('os quatro estados do rótulo de versão têm preview a 180pt', () => {
  const previews = read(previewsSwift);
  assert(
    previews.includes('SidebarVersionLabel('),
    'nenhum preview renderiza SidebarVersionLabel — os estados dele não são '
      + 'alcançáveis por navegação (exigem um bundle estampado e um repo que andou)'
  );
  const n = countOf(previews, 'SidebarVersionLabel(');
  assert(
    n >= 5,
    `esperados >= 5 previews de SidebarVersionLabel (em dia, divergente, não `
      + `estampado, desconhecido, update disponível), encontrados ${n}`
  );
  // O estado não estampado é o que se pode rodar HOJE, antes de existir
  // estampagem nenhuma — e o que `swift run Forge` mostra para sempre.
  assert(
    /SidebarVersionLabel\(running:\s*nil/.test(previews),
    'nenhum preview cobre `running: nil` — é o estado real de todo build feito '
      + 'antes da estampagem e de qualquer `swift run`, não um caso hipotético'
  );
});

// ------------------------------------- D25/R8: build.sh estampa o bundle (chunk 4)

/// Strip WHOLE-LINE `#` comments from a shell script, and only those. Stripping
/// from the first `#` anywhere would mangle `sed 's/^# \{0,1\}//'`, which is real
/// code; and NOT stripping at all would let the long comment block that explains
/// the stamp ordering — it names `codesign`, `PlistBuddy` and `app/Info.plist` —
/// satisfy or trip every guard below on prose instead of on behaviour.
function stripShellComments(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

check('build.sh estampa as três chaves via plutil -replace (D25)', () => {
  const sh = stripShellComments(read(buildSh));
  assert(
    sh.includes('plutil -replace'),
    'a estampagem desapareceu de build.sh — sem ela `ForgeGitDescribe` nunca '
      + 'chega ao bundle e o rodapé volta a dizer "repo vX" para sempre (D25)'
  );
  for (const key of ['ForgeGitDescribe', 'CFBundleShortVersionString', 'CFBundleVersion']) {
    assert(
      new RegExp(`plutil -replace ${key}\\b`).test(sh),
      `build.sh não estampa ${key} — as três chaves têm consumidores diferentes: `
        + 'a custom alimenta o rodapé, e as duas da Apple são o que o Finder e o '
        + 'próprio macOS mostram'
    );
  }
  assert(
    !/PlistBuddy/.test(sh),
    'build.sh usa PlistBuddy: `-c "Set …"` numa chave AUSENTE sai 1, e sob '
      + '`set -euo pipefail` isso mata o build no primeiro uso. `plutil -replace` '
      + 'cria a chave e sai 0'
  );
});

check('a estampagem acontece entre o cp do plist e o codesign', () => {
  const sh = stripShellComments(read(buildSh));
  const copiedPlist = sh.indexOf('cp "${APP_DIR}/Info.plist"');
  const sign = sh.indexOf('codesign --force');
  assert(copiedPlist !== -1, 'o cp do Info.plist para o bundle desapareceu de build.sh');
  assert(sign !== -1, 'o `codesign --force` desapareceu de build.sh');
  // R3: `indexOf('plutil -replace')` só encontra a PRIMEIRA das três chamadas —
  // build.sh tem uma por chave (ForgeGitDescribe, CFBundleShortVersionString,
  // CFBundleVersion). Mover só a escrita de CFBundleVersion para depois do
  // codesign passava nas três checagens de build.sh (a primeira `plutil` segue
  // antes do sign) e ainda assim invalidava a assinatura — a falha invisível em
  // runtime que este guard existe para pegar. Cada chave é ancorada por si.
  const KEYS = ['ForgeGitDescribe', 'CFBundleShortVersionString', 'CFBundleVersion'];
  for (const key of KEYS) {
    const stamp = sh.indexOf(`plutil -replace ${key}`);
    assert(stamp !== -1, `nenhum \`plutil -replace ${key}\` em build.sh`);
    // Esta é a razão de existir deste guard: as duas fronteiras são INVISÍVEIS em
    // runtime. Fora de ordem, o build continua saindo 0 e o app continua abrindo.
    assert(
      copiedPlist < stamp,
      `a estampagem de ${key} vem ANTES do \`cp\` do Info.plist — nessa ordem ela edita o `
        + 'app/Info.plist VERSIONADO, e cada build passa a sujar a árvore. A '
        + 'pré-checagem do atualizador in-app recusa árvore suja, então buildar '
        + 'bloquearia a própria atualização que a estampagem serve (R8)'
    );
    assert(
      stamp < sign,
      `a estampagem de ${key} vem DEPOIS do \`codesign\` — a assinatura cobre o Info.plist, `
        + 'então nessa ordem `codesign --verify` deixa de dizer "valid on disk" e '
        + 'passa a dizer "invalid Info.plist (plist or signature have been '
        + 'modified)". Probado, não suposto'
    );
  }
});

check('nenhuma escrita de plist tem o arquivo versionado como destino (R8)', () => {
  const sh = stripShellComments(read(buildSh));
  for (const line of sh.split('\n')) {
    if (!line.includes('plutil')) continue;
    assert(
      !line.includes('${APP_DIR}/Info.plist'),
      `uma escrita de plist tem o arquivo versionado como destino: ${line.trim()}`
    );
    assert(
      line.includes('${BUNDLE}/Contents/Info.plist'),
      `uma escrita de plist não tem a cópia do bundle como destino: ${line.trim()}`
    );
  }
});

check('o --install copia o bundle já assinado e já estampado', () => {
  const sh = stripShellComments(read(buildSh));
  const sign = sh.indexOf('codesign --force');
  const install = sh.indexOf('if $DO_INSTALL');
  assert(install !== -1, 'o bloco `if $DO_INSTALL` desapareceu de build.sh');
  assert(
    sign < install,
    'a instalação acontece antes de assinar. Mover a estampagem para depois do '
      + '`--install` "para pegar as duas cópias" pega ZERO cópias corretamente '
      + 'assinadas: /Applications recebe uma cópia do bundle já pronto'
  );
});

// --------------------------------- D28: o versionCard perdeu a coluna de ícone

check('o versionCard não tem mais o Circle de 54pt (D28)', () => {
  const updates = stripLineComments(read(updatesSwift));
  const card = bodyOf(updates, 'private var versionCard');
  assert(
    !card.includes('Circle('),
    'o Circle voltou ao versionCard: era o maior pedaço de decoração da tela e não '
      + 'dizia nada que o headline ("Atualização disponível: vX", em palavras) e a '
      + 'strokeBorder laranja da própria borda do card já não dissessem (D28)'
  );
  assert(
    !/\b54\b/.test(card),
    'o número 54 reapareceu no versionCard — era o diâmetro do disco removido (D28)'
  );
});

check('o slot de ação do versionCard segue intacto (D34)', () => {
  // A subtração da D28 é a COLUNA DO ÍCONE, e só ela. A coexistência
  // Atualizar+Reinstalar foi comprada com objeção de review numa task irmã
  // (esconder Reinstalar quando o update aparece o escondia no único estado em
  // que ele importa), e "simplificar o card" é justamente como ela se perderia.
  const updates = stripLineComments(read(updatesSwift));
  const card = bodyOf(updates, 'private var versionCard');
  for (const label of ['Atualizar', 'Reinstalar', 'Reabrir na nova versão']) {
    assert(
      card.includes(`"${label}"`),
      `o botão "${label}" desapareceu do versionCard — os três estados do slot de `
        + 'ação e a coexistência Atualizar+Reinstalar são intocáveis (D34)'
    );
  }
  assert(
    /needsRelaunch/.test(card),
    'o versionCard não distingue mais `needsRelaunch`: o relaunch ganha o slot '
      + 'inteiro depois que o instalador roda, e perder isso deixa o operador '
      + 'olhando uma janela velha que parece atual (D34)'
  );
});

// ------------------------------------- D36: o CHANGELOG deixa de colidir em id

check('nenhum heading `## <version>` se repete em CHANGELOG.md (D36)', () => {
  // `Release.id` é a própria version (Changelog.swift), e a tela passa a lista a
  // um ForEach: dois headings iguais são dois ids iguais, que em SwiftUI é
  // comportamento INDEFINIDO — nada avisa. Era o caso real (`## Unreleased` na
  // linha 1 e na 104) e ficaria visível agora que a lista é curta.
  const src = read(changelogMd);
  const seen = new Map();
  for (const line of src.split('\n')) {
    if (!line.startsWith('## ')) continue;
    const version = line.slice(3).split(/ — | - /)[0].trim();
    seen.set(version, (seen.get(version) || 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([v, n]) => `${v} (${n}x)`);
  assert(
    dupes.length === 0,
    `headings repetidos em CHANGELOG.md: ${dupes.join(', ')} — renomeie para a versão `
      + 'que a entrada efetivamente é; `git describe --contains <commit>` responde qual'
  );
  assert(seen.size > 10, `só ${seen.size} headings lidos em CHANGELOG.md — o formato mudou`);
});

/// Headings de release "Unreleased", pela MESMA regra que o app aplica em runtime:
/// `Release.isUnreleased` (Changelog.swift) é `version.lowercased().contains("unreleased")`,
/// e `version` é o que vem ANTES do travessão. Duas cópias de uma regra que casavam
/// por acaso: este guard comparava com o literal `'\n## Unreleased'` e ficou cego para
/// `## [Unreleased]` — a forma que de fato sobreviveu na linha 1 por seis tags, de
/// v4.2.0 a v4.6.1, sempre verde. Agora a regra é uma só, e é a que o app executa.
function unreleasedHeadings(source) {
  return source
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .filter((line) => line.slice(3).split(/ — | - /)[0].trim().toLowerCase().includes('unreleased'));
}

check('nenhum `## Unreleased` sobrou em CHANGELOG.md (D36)', () => {
  const found = unreleasedHeadings(read(changelogMd));
  assert(
    found.length === 0,
    `${found.length} heading(s) Unreleased em CHANGELOG.md: ${found.join(' | ')} — todos `
      + 'colidem no mesmo id, e o hábito de abrir um e não fechá-lo é exatamente como a '
      + 'colisão voltou a existir na linha 1 depois de já ter sido criada a tag v3.2.0'
  );
});

check('o detector de Unreleased morde as formas que já apareceram no arquivo', () => {
  // Sem este caso o guard acima é indistinguível de uma asserção vazia: ele prova
  // que o arquivo está limpo, não que a sujeira seria vista. A forma com colchetes
  // não é hipotética — é a que evadiu a comparação literal ao longo de seis tags.
  for (const linha of [
    '## Unreleased',
    '## [Unreleased]',
    '## [Unreleased] — o bloco que vazou de v4.2.0 a v4.6.1',
    '## UNRELEASED - caixa alta e travessão simples',
  ]) {
    assert(unreleasedHeadings(linha).length === 1, `não mordeu: ${linha}`);
  }
  // O outro sentido: a palavra fora do slot da versão não é um heading Unreleased,
  // senão o guard passaria a acusar release legítima e seria desligado por ruído.
  for (const linha of [
    '## v4.6.1 — Three copies of one rule stop disagreeing',
    '## v4.6.0 — o que ficou unreleased até aqui',
    '### Unreleased',
    '- um bullet que menciona Unreleased',
  ]) {
    assert(unreleasedHeadings(linha).length === 0, `falso positivo: ${linha}`);
  }
});

check('nenhuma release repete um heading `### <seção>` em CHANGELOG.md (D36)', () => {
  // Um nível abaixo da checagem de versão: `ReleaseSection.id` é a identidade da
  // seção dentro do card. Enquanto todo heading fora do enum virava `.other`
  // (id "Outros"), OITO releases deste arquivo entregavam ids repetidos ao
  // `ForEach` — `Breaking` + `Notes` na mesma release bastava. Agora `.other`
  // carrega o próprio heading (Changelog.swift), então a colisão exige o MESMO
  // heading literal duas vezes na mesma release, que é o que se assere aqui.
  // Espelha o teste Swift porque este arquivo roda sem swift, Windows incluído.
  const src = read(changelogMd);
  let release = null;
  let sections = 0;
  const perRelease = new Map();
  for (const line of src.split('\n')) {
    if (line.startsWith('## ')) {
      release = line.slice(3).split(/ — | - /)[0].trim();
      perRelease.set(release, new Map());
    } else if (line.startsWith('### ') && release) {
      const heading = line.slice(4).trim();
      const seen = perRelease.get(release);
      seen.set(heading, (seen.get(heading) || 0) + 1);
      sections++;
    }
  }
  const dupes = [];
  for (const [rel, seen] of perRelease) {
    for (const [heading, n] of seen) if (n > 1) dupes.push(`${rel} › ${heading} (${n}x)`);
  }
  assert(
    dupes.length === 0,
    `heading de seção repetido na mesma release: ${dupes.join(', ')} — dois ids iguais `
      + 'num ForEach é comportamento indefinido em SwiftUI. Funda as duas seções ou '
      + 'renomeie uma delas para o que ela de fato é'
  );
  assert(sections > 10, `só ${sections} seções \`###\` lidas em CHANGELOG.md — o formato mudou`);
});

check('as entradas que a D36 nomeia existem em CHANGELOG.md', () => {
  const src = read(changelogMd);
  for (const v of ['v3.3.0', 'v3.2.0', 'v2.5.0']) {
    assert(
      src.startsWith(`## ${v} `) || src.includes(`\n## ${v} `),
      `nenhum heading \`## ${v}\` em CHANGELOG.md — os dois Unreleased foram renomeados `
        + 'para as versões em que efetivamente saíram (v3.2.0 e v2.5.0), e a v3.3.0 é a '
        + 'entrada desta leva de tasks; sem ela a tag nasceria sem notas no app'
    );
  }
});

// ------------------------------- D30/R10: 5 releases em repouso, o resto a um clique

check('a lista de releases não usa mais prefix(12) (D30)', () => {
  const updates = stripLineComments(read(updatesSwift));
  assert(
    !updates.includes('prefix(12)'),
    'o `prefix(12)` voltou a Updates.swift — ele corta por POSIÇÃO, sem nenhuma noção '
      + 'de quais cards não podem ser cortados; a D30 exige que a entrada da versão '
      + 'instalada e a da disponível nunca caiam atrás do "mostrar mais"'
  );
  const body = bodyOf(updates, 'var body: some View');
  assert(
    !/\.prefix\(/.test(body),
    'o corpo da UpdatesView voltou a cortar a lista com `.prefix(` inline — a janela '
      + 'inteira mora em ReleaseWindow, que é onde os pinos existem'
  );
});

check('a janela passa por ReleaseWindow, não por literal inline (D30)', () => {
  const updates = stripLineComments(read(updatesSwift));
  const body = bodyOf(updates, 'var body: some View');
  assert(
    body.includes('releaseWindow.visible'),
    'o ForEach da lista não renderiza `releaseWindow.visible` — sem isso não há '
      + 'garantia de que os pinos da D30 cheguem à tela'
  );
  const window = bodyOf(updates, 'private var releaseWindow');
  assert(
    window.includes('ReleaseWindow.visible('),
    'a janela deixou de chamar `ReleaseWindow.visible(` — a lógica pura (dedupe, '
      + 'pinos, hiddenCount) é a única que tem teste, porque o target Forge não é '
      + 'importável por target de teste'
  );
  for (const arg of ['installed:', 'latest:']) {
    assert(
      window.includes(arg),
      `a chamada de ReleaseWindow.visible não passa \`${arg}\` — um pino que não é `
        + 'informado não é um pino, e o corte voltaria a poder pegar o topo'
    );
  }
  assert(
    window.includes('ReleaseWindow.restingLimit'),
    'o limite em repouso virou literal no corpo da view. Ele é uma constante nomeada '
      + 'de propósito: o número 5 nunca foi validado olhando uma lista ao vivo, então '
      + 'trocá-lo tem de ser uma linha, não uma caçada'
  );
  assert(
    !/limit:\s*\d/.test(window),
    'a janela passa um limite numérico literal — use `ReleaseWindow.restingLimit`'
  );
});

check('o controle de mostrar mais existe, expande in-place e rotula pelo ForgeKit', () => {
  const updates = stripLineComments(read(updatesSwift));
  const body = bodyOf(updates, 'var body: some View');
  assert(
    body.includes('showMoreControl'),
    'o corpo da UpdatesView não monta o controle de mostrar mais — sem ele o corte da '
      + 'D30 esconde a cauda para sempre, que não é o que ela pede'
  );
  const control = bodyOf(updates, 'private var showMoreControl');
  assert(
    control.includes('ReleaseWindow.moreLabel(') && control.includes('ReleaseWindow.lessLabel'),
    'o rótulo do controle não vem do ForgeKit — o plural ("1 versões") é um branch de '
      + 'verdade, e um corpo de view é onde ele passa despercebido'
  );
  assert(
    /hiddenCount/.test(control),
    'o controle não consulta `hiddenCount`: um botão que diz "mostrar mais 0" é pior '
      + 'que nenhum botão'
  );
  assert(
    /showAllReleases\s*\.toggle\(\)/.test(control) || /showAllReleases\.toggle\(\)/.test(control),
    'o controle não alterna `showAllReleases` — a revelação é in-place, não navegação'
  );
});

check('ReleaseWindow deduplica por version e pina os três casos (D30/R10)', () => {
  const core = stripLineComments(read(updateCoreSwift));
  const fn = bodyOf(core, 'public static func visible(releases');
  assert(
    /Set<String>|Set</.test(fn) && /seen/.test(fn),
    'a janela não deduplica por version. `Release.id` É a version, então duas entradas '
      + 'iguais são dois ids iguais num ForEach — comportamento indefinido no SwiftUI, '
      + 'e silencioso. O arquivo deste repo foi consertado num chunk irmão; isto '
      + 'protege o PROGRAMA, que também tem de sobreviver a um fork'
  );
  for (const pin of ['isUnreleased', 'installed', 'latest']) {
    assert(
      fn.includes(pin),
      `a janela não considera \`${pin}\` como pino — a D30 permite cortar a cauda `
        + 'histórica e nada mais'
    );
  }
  assert(
    !/\.sorted|sort\(/.test(fn),
    'a janela ordena a lista. A ordem do arquivo NÃO é a ordem das versões neste repo '
      + '(v1.35.0 precede v1.36.0), e a promessa é "as 5 primeiras do arquivo mais os '
      + 'pinos" — nunca "as 5 mais recentes"'
  );
  assert(
    /restingLimit\s*=\s*5/.test(core),
    'o limite em repouso deixou de valer 5 (ou deixou de ser uma constante nomeada)'
  );
});

check('existe preview de lista longa, com duas Unreleased e fora de ordem (D30)', () => {
  const previews = read(previewsSwift);
  assert(
    previews.includes('previewLongReleases'),
    'nenhum fixture de lista longa em Previews.swift — o "mostrar mais" e o dedupe só '
      + 'aparecem num render com mais de 5 entradas'
  );
  // Recorte a partir do `parse("""`, não da declaração: o doc comment acima do
  // fixture CITA `## Unreleased` ao explicar por que ele tem duas, e contar a
  // citação faria o guard passar por prosa em vez de por conteúdo — foi
  // exatamente assim que a mutação M24 primeiro escapou.
  const decl = previews.indexOf('previewLongReleases');
  const open = previews.indexOf('parse("""', decl);
  assert(open !== -1, 'o fixture longo não é um literal multi-linha passado ao parser');
  const fixture = previews.slice(open);
  const end = fixture.indexOf('""")');
  const md = fixture.slice(0, end === -1 ? undefined : end);
  assert(
    countOf(md, '\n## Unreleased') >= 2,
    'o fixture longo não tem duas `## Unreleased` — a colisão de id era real neste '
      + 'repo (linha 1 e linha 104) e o preview é onde o dedupe se vê num render'
  );
  const at135 = md.indexOf('## v1.35.0');
  const at136 = md.indexOf('## v1.36.0');
  assert(
    at135 !== -1 && at136 !== -1 && at135 < at136,
    'o fixture longo está em ordem decrescente — assim ele não distingue "janela em '
      + 'ordem de arquivo" de "janela ordenada", que é justo o Pitfall deste repo'
  );
  assert(
    previews.includes('previewLongReleases)))'),
    'o fixture longo existe mas nenhum preview o renderiza'
  );
});

// ------------------------------------------------------- bite-proof do bodyOf

check('bodyOf morde: um badge(for:) com .updates aninhado é pego', () => {
  const fake = [
    '    private func badge(for s: Section) -> Int? {',
    '        switch s {',
    '        case .now: return nil',
    '        case .updates: return UpdateStore.shared.updateAvailable ? 1 : nil',
    '        default: return nil',
    '        }',
    '    }',
  ].join('\n');
  let caught = false;
  try {
    assert(!bodyOf(fake, 'private func badge(for').includes('.updates'), 'x');
  } catch (e) {
    caught = true;
  }
  assert(caught, 'o guard da D27 não pegaria um caso .updates real — não prova nada');
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
