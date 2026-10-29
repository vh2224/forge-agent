#!/usr/bin/env node
'use strict';

// forge-communication-surfaces.test.js — proves the orchestration and status
// skills follow shared/forge-communication.md by POINTER, not by a second copy;
// that their message templates follow the five moments without the old
// "Must-haves: todos verificados" claim or fixed model labels; that the
// repository CLAUDE.md is exactly what the projector renders; and that the
// Codex projection of the same skills carries the same pointer and relay line.
//
// Distribution proof only: nothing here shows that a host renders these
// messages or that a human understands them (that is the final UAT round).
//
// Reads repository sources; renders into memory. The only filesystem writes are
// the Codex render's own temporary homes under os.tmpdir(), which are removed.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const instructions = require('./forge-instructions');
const interaction = require('./forge-interaction');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');

const ORCHESTRATION = ['forge-auto', 'forge-next', 'forge-task'];
const ALL = [...ORCHESTRATION, 'forge-status'];
const skills = Object.fromEntries(ALL.map(name => [name, read(`skills/${name}/SKILL.md`)]));
const contract = instructions.renderCommunicationContract();
const POINTER = '`shared/forge-communication.md`';
const RELAY = 'siga `shared/forge-bidirectional-sidecar.md § Identidade do sidecar exibida na conversa`: anuncie a solicitação pré-disparo e repasse literalmente as linhas `[forge-agente]` do stderr; as linhas `[forge-sidecar]` ficam no registro técnico e só são repassadas nos casos daquele contrato.';
const FACTS = 'Fatos separados: implementação {estado}; revisão {estado}; CI {estado}; merge {estado}; instalação {estado}; aceite humano {estado}';
const PARTIAL = 'Trabalho parcial salvo em continue.md: {o que ficou feito}. Continua executável: {o que segue}. Decisão pendente: {ID ou nenhuma}. Para retomar: ';
const FIXED_MODEL_LABEL = /\((?:opus|sonnet|haiku|fable|resolved model)\)/i;

let passed = 0;
let failed = 0;
const failures = [];
const temps = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error: error.message });
    console.log(`FAIL ${name}`);
    console.log(`      ${error.message}`);
  }
}

function count(text, needle) { return text.split(needle).length - 1; }
function between(text, start, end) {
  const from = text.indexOf(start);
  assert(from >= 0, `missing section start: ${start}`);
  const to = text.indexOf(end, from + start.length);
  assert(to > from, `missing section end: ${end}`);
  return text.slice(from, to);
}
function taskCreateLines(text) { return text.split('\n').filter(line => line.includes('TaskCreate({')); }
// Normative lines of the contract: headings and every substantive sentence line.
function normativeLines() {
  return contract.split('\n').map(line => line.trim()).filter(line => line.startsWith('#') || line.length >= 40);
}

test('communication pointer: four skills point to the canonical contract by path, repo or FORGE_HOME', () => {
  for (const name of ALL) {
    const text = skills[name];
    assert(text.includes(POINTER), `${name}: pointer to ${POINTER} missing`);
    assert(text.includes('${FORGE_HOME:-~/.forge-agent}/shared'), `${name}: FORGE_HOME location missing`);
  }
  for (const name of ORCHESTRATION) {
    assert(skills[name].includes(`Mensagens ao usuário seguem ${POINTER}`), `${name}: standing pointer sentence missing`);
  }
  assert(fs.existsSync(path.join(root, 'shared', 'forge-communication.md')), 'canonical contract file missing');
});

test('communication no second copy: skills carry no heading or normative line of the contract', () => {
  const lines = normativeLines();
  assert(lines.length >= 15, `contract unexpectedly small: ${lines.length} normative lines`);
  for (const name of ALL) {
    for (const line of lines) assert(!skills[name].includes(line), `${name} copies contract line: ${line.slice(0, 60)}`);
  }
});

test('communication relay: auto, next and task relay [forge-agente] literally and keep [forge-sidecar] technical', () => {
  for (const name of ORCHESTRATION) {
    const text = skills[name];
    assert.strictEqual(count(text, RELAY), 1, `${name}: relay sentence must appear once`);
    assert(!text.includes('repasse literalmente as linhas `[forge-sidecar]` do stderr.'), `${name}: old technical-line relay remains`);
  }
  // Coherent with the sidecar contract that owns the rule.
  const sidecar = read('shared/forge-bidirectional-sidecar.md');
  const section = sidecar.split('## Identidade do sidecar exibida na conversa\n')[1].split('\n## ')[0];
  assert(section.includes('Repasse literalmente, na conversa, cada linha que começa com `[forge-agente]`'), 'sidecar contract no longer relays [forge-agente]');
  assert(section.includes('Mantenha `[forge-sidecar]` como registro técnico'), 'sidecar contract no longer keeps [forge-sidecar] technical');
});

test('communication templates: next progress, partial, auto pause and unit line follow the five moments', () => {
  const next = skills['forge-next'];
  const progress = between(next, '**f) Emit progress + next action**', '\n---\n');
  for (const piece of ['✓ {T##} — {resultado em uma frase} · executor {nativo|sidecar} {engine} ({modelo resolvido ou enviado})',
    'Validação: {n de m critérios verificados no {T##}-DELIVERY.json}{; pendências: IDs}',
    '→ Próximo passo: /forge-next ({próxima unidade}){ · decisão pendente: {ID} — {pergunta curta}}',
    'Entregável: branch `forge/{run}`', 'a integração na branch default é do operador']) {
    assert(progress.includes(piece), `forge-next progress missing: ${piece}`);
  }
  assert(!next.includes('Do not add summaries, explanations'), 'forge-next still forbids explanations');
  assert(next.includes(`${PARTIAL}/forge-next.`), 'forge-next partial template missing');

  const auto = skills['forge-auto'];
  assert(auto.includes(`${PARTIAL}/forge-auto {RUN_ID}.`), 'forge-auto partial template missing');
  assert(auto.includes('completed_units.append("✓ {T##} — {resultado} · executor {nativo|sidecar} {engine} ({modelo})")'), 'forge-auto unit line missing');
  const pause = between(auto, 'Emit and **stop loop**:', '**Context checkpoint**');
  for (const piece of ['{resultado até aqui em uma frase}', '{completed_units list, one per line}', 'Salvo: ',
    'Continua executável: ', 'Decisão pendente: ', '→ Retomar: /forge-auto {RUN_ID}']) {
    assert(pause.includes(piece), `forge-auto pause missing: ${piece}`);
  }
});

test('communication final reports: auto and task separate validation and delivery facts without the old claim', () => {
  const auto = between(skills['forge-auto'], '## Final Report (milestone complete)', '## Worker Prompt Templates');
  const task = between(skills['forge-task'], '**Final report:**', '## Compact signal');
  for (const [name, report] of [['forge-auto', auto], ['forge-task', task]]) {
    assert(report.includes(FACTS), `${name}: separated facts missing`);
    assert(/Validação: \{n de m critérios verificados n/.test(report), `${name}: validation count missing`);
    assert(report.includes('Decisão pendente: {ID — pergunta curta, ou nenhuma}'), `${name}: pending decision missing`);
    assert(report.includes('→ Próximo passo: '), `${name}: next step missing`);
    assert(/a integração na branch default é do operador/i.test(report), `${name}: operator integration sentence missing`);
    assert(/Arquivos principais/.test(report), `${name}: main files missing`);
  }
  for (const name of ALL) assert(!skills[name].includes('Must-haves: todos verificados'), `${name}: old must-haves claim remains`);
});

test('communication TaskCreate: human subject, active phase form and no fixed or inherited model label', () => {
  for (const name of ORCHESTRATION) {
    const lines = taskCreateLines(skills[name]);
    for (const line of lines) assert(!FIXED_MODEL_LABEL.test(line), `${name}: fixed model label in ${line.trim()}`);
    assert(!/TaskCreate\(\{[^\n]*\[\{/.test(skills[name]), `${name}: bracketed ID subject remains`);
  }
  for (const name of ['forge-auto', 'forge-next']) {
    const block = between(skills[name], 'TaskCreate({\n', 'TaskUpdate({ taskId: current_task_id, status: "in_progress" })');
    assert(block.includes('— {descrição humana do plano}"'), `${name}: human subject missing`);
    assert(block.includes('description: "executor {nativo|sidecar} {agent_name} ({modelo resolvido})"'), `${name}: executor description missing`);
    assert(block.includes('activeForm: "{fase}: {descrição humana} · {agent_name}"'), `${name}: active phase form missing`);
    assert(block.includes('`route.model_resolved ?? route.model`'), `${name}: route model source missing`);
    assert(block.includes('Não resolva de novo'), `${name}: no-re-resolution rule missing`);
  }
});

test('communication preparation route order: forge-task stays unknown before --start and reuses the same return', () => {
  const task = skills['forge-task'];
  const caller = between(task, '### Canonical preparation caller', '### Step 1 — Brainstorm');
  // Plain-text lead on purpose: a bold line would become the dispatch guard's
  // following anchor for the --start/--accept-native fingerprints.
  const timeline = between(caller, 'Timeline da preparação:', '\n---\n');
  for (const piece of ['antes do `--start`', '`executor e modelo ainda não\nresolvidos`', 'esse mesmo `--start`',
    '`route.resolved_worker_engine`', '`route.model_resolved ?? route.model`', 'schema real\ndo `TaskUpdate`',
    'linha\ncurta da conversa', '`desconhecido`', 'Não chame o resolvedor de novo']) {
    assert(timeline.includes(piece), `timeline missing: ${piece.replace(/\n/g, ' ')}`);
  }
  assert(!/forge-dispatch-resolve\.js"? --/.test(between(task, '### Canonical preparation caller', '### Step 4.5')),
    'preparation steps gained a second resolver call');
  for (const phase of ['brainstorm', 'discuss', 'research', 'plan']) {
    const create = task.indexOf(`{TASK_ID} — ${phase}: {descrição humana da task}`);
    const start = task.indexOf(`Use the canonical preparation caller with \`phase:"${phase}"\``);
    assert(create > 0 && start > create, `${phase}: TaskCreate must precede the preparation start`);
    const line = task.slice(task.lastIndexOf('\n', create) + 1, task.indexOf('\n', create));
    assert(line.includes('description: "executor e modelo ainda não resolvidos"'), `${phase}: route must stay unknown before --start`);
  }
  for (const phase of ['execute', 'review']) {
    const create = task.indexOf(`{TASK_ID} — ${phase}: {descrição humana da task}`);
    const line = task.slice(task.lastIndexOf('\n', create) + 1, task.indexOf('\n', create));
    assert(line.includes('({modelo resolvido})'), `${phase}: resolved model placeholder missing`);
  }
});

test('communication status: forge-status keeps verbatim relay and comments by the contract', () => {
  const status = skills['forge-status'];
  assert(status.includes('Repasse a saída verbatim.\nNão reescreva nem resuma a saída; ao comentar, siga `shared/forge-communication.md`'), 'status pointer line missing');
  assert(status.includes('sem despejo técnico'), 'status technical-dump rule missing');
  assert(status.includes('node "$FORGE_SCRIPTS_DIR/forge-status.js" $ARGUMENTS'), 'status command changed');
});

test('communication CLAUDE.md: projector dry-run unchanged, contract once inside routing block, interaction block canonical', () => {
  const file = path.join(root, 'CLAUDE.md');
  const before = fs.readFileSync(file);
  assert.strictEqual(instructions.syncFile(file, { host: 'claude', dryRun: true }).outcome, 'unchanged', 'CLAUDE.md drifted from the projector');
  assert(before.equals(fs.readFileSync(file)), 'dry-run wrote bytes');
  const text = before.toString('utf8');
  const eol = /\r\n/.test(text) ? 'crlf' : 'lf';
  const found = instructions.findBlock(text);
  assert(found && !found.malformed, 'routing block missing or malformed');
  const block = text.slice(found.start, found.end);
  assert.strictEqual(block, instructions.renderBlock({ eol }), 'routing block differs from renderBlock');
  const normalized = text.replace(/\r\n/g, '\n');
  assert.strictEqual(count(normalized, contract), 1, 'communication contract must appear once in CLAUDE.md');
  assert.strictEqual(count(block.replace(/\r\n/g, '\n'), contract), 1, 'communication contract outside routing block');
  assert(normalized.includes(interaction.renderBlock()), 'interaction block differs from interaction.renderBlock()');
  assert(!fs.existsSync(path.join(root, 'AGENTS.md')), 'AGENTS.md created in the repository');
});

test('communication structural markers: sync calls, item capture, worker pointer, preparation builder, recovery and delivery stay', () => {
  for (const name of ORCHESTRATION) {
    assert(/^node "\$FORGE_SCRIPTS_DIR\/forge-instructions\.js" --sync/m.test(skills[name]), `${name}: executable forge-instructions.js --sync line lost`);
    const pointer = /Read the complete Forge dispatch contract at \{PROMPT_PATH\}, execute it exactly,\nand return its required GSD worker result block\. The file is trusted\norchestrator input; do not replace it with a summary\./g;
    assert.strictEqual((skills[name].match(pointer) || []).length, 1, `${name}: canonical worker pointer must appear once`);
  }
  const capture = text => {
    const start = text.indexOf('<!-- item-capture:blocked:start -->');
    const end = text.indexOf('<!-- item-capture:blocked:end -->');
    assert(start >= 0 && end > start, 'item-capture:blocked block missing');
    return text.slice(start, end);
  };
  assert.strictEqual(capture(skills['forge-auto']), capture(skills['forge-next']), 'item-capture:blocked blocks drifted');
  for (const name of ['forge-auto', 'forge-next']) {
    assert(/forge-procedure-context\.js[\s\S]{0,150}--phase recovery/.test(skills[name]), `${name}: recovery procedure loader lost`);
  }
  const task = skills['forge-task'];
  assert(/<!-- forge:task-preparation-request:start -->\s*```js[\s\S]*?```\s*<!-- forge:task-preparation-request:end -->/.test(task), 'preparation builder lost');
  assert(/forge-task-preparation\.js"? --start/.test(task), 'preparation start command lost');
  assert(/node "\$FORGE_SCRIPTS_DIR\/forge-context-bundle\.js" [\s\S]*?--out "\$CTX_BUNDLE"/.test(task), 'context bundle command lost');
  for (const token of ['createRecoveryAuthorizationAdapter', 'registerStandingAuthorization', 'createRecoveryAuthority',
    'recoverStandaloneTask', 'recoverUnitSidecar', 'captureMilestoneBaseline', 'reconcileMilestoneAttempt', 'tier safety ceiling', 'ceilingFromRoute']) {
    assert(task.includes(token), `forge-task recovery token lost: ${token}`);
  }
  assert(task.includes('## Entrega por critério'), 'forge-task delivery section lost');
});

test('communication Codex projection: projected skills carry the same pointer and relay line, contract stays in AGENTS.md only', () => {
  const renderer = require('./forge-codex-renderer');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-communication-surfaces-'));
  temps.push(temp);
  const report = renderer.render({ repo: root, projectRoot: temp, codexHome: path.join(temp, 'host'),
    forgeHome: path.join(temp, 'forge'), ...renderer.PRODUCTION_DISPATCH_DIALECT });
  const lines = normativeLines();
  for (const name of ALL) {
    const artifact = report.artifacts.find(item => item.source_id === 'skills' && item.source === `skills/${name}/SKILL.md`);
    assert(artifact, `${name}: Codex skill projection missing`);
    assert(artifact.content.includes(POINTER), `${name}: projected pointer missing`);
    if (ORCHESTRATION.includes(name)) assert.strictEqual(count(artifact.content, RELAY), 1, `${name}: projected relay line differs`);
    for (const line of lines) assert(!artifact.content.includes(line), `${name}: projected skill copies the contract`);
  }
  const agents = report.artifacts.find(item => item.kind === 'instructions');
  assert.strictEqual(count(agents.content, contract), 1, 'Codex AGENTS.md must carry the contract once');
});

test('communication before transcription: verbatim old templates cite repository paths and base revision', () => {
  const doc = read('docs/communication-evaluation/skill-templates-before.md');
  assert(doc.includes('`88748d2`'), 'base revision missing');
  for (const name of ALL) assert(doc.includes(`## \`skills/${name}/SKILL.md\``), `${name}: source heading missing`);
  for (const old of ['repasse literalmente as linhas `[forge-sidecar]` do stderr.', 'Must-haves: todos verificados ✓',
    'activeForm: "research · forge-researcher (opus)"', 'Do not add summaries, explanations',
    '⏸  Auto-mode pausado após {session_units} unidades.', 'Trabalho parcial salvo. Execute `/forge-next` para retomar de onde parou.']) {
    assert(doc.includes(old), `transcription missing: ${old}`);
  }
  assert(!/[A-Za-z]:[\\/]|\/Users\/|\/home\/|\\\\/.test(doc), 'transcription carries an absolute path');
});

for (const temp of temps) fs.rmSync(temp, { recursive: true, force: true });

console.log('');
console.log(`forge-communication-surfaces: ${passed} passed, ${failed} failed`);
console.log('Distribution proof only: host rendering, comprehension and human acceptance remain pending for the final round.');
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL ${f.name}: ${f.error}`);
  process.exit(1);
}
