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

// S03/T07 — text distribution only. These assertions prove which commands and
// ordering rules the skills carry; they do not prove that a parent actually calls
// the CLIs, that a host opens a native thread or renders rows (owner demo / UAT).
const config = read('skills/forge-config/SKILL.md');
const flat = value => value.replace(/\s+/g, ' ');
// forge-task names the review-fix window without the literal flag: its first
// `--prepare-native` must stay the executable preparation (forge-review-fix.test.js).
const WINDOWS = ['entre `forge-task-preparation --start` e `--accept-native`',
  ['entre `forge-review-fix --prepare-native` e `--accept-native`', 'entre a preparação nativa do `forge-review-fix` e o seu `--accept-native`'],
  'numa sessão de entrega nativa entre start e publish',
  'enquanto uma publicação de memória protegida', 'ainda não foi unida',
  'só mostre a identidade na conversa e registre depois da aceitação ou da publicação, com `--receipt` quando o fluxo tem receipt'];
const NO_INFERENCE = ['Sem retorno do host, nada é registrado e a identidade fica `desconhecido`',
  'Nunca componha o ID a partir de `task_name`, de `/root/` mais nome, de hook ou de prosa',
  '(`/root/<nome>` só entra quando é o valor que a ferramenta devolveu)',
  'não infira atividade a partir de timers locais', 'não apresente sidecar como thread nativa'];
function emitterCall(text) {
  const start = text.indexOf('forge-dispatch-event.js');
  assert(start >= 0, 'dispatch emitter missing from flow');
  return text.slice(start, text.indexOf('--events', start));
}
function recordCount(text) { return count(text, 'forge-agent-identity.js" --record'); }
function assertNativeFlow(label, text, { id, invoke, name, agentId, unit, receipt = null, after = null, rules = true }) {
  const generated = text.indexOf(`${id}=`) >= 0 ? text.indexOf(`${id}=`) : text.indexOf(`${id}["$ENTRY_ID"]=`);
  assert(generated >= 0, `${label}: ${id} is not generated`);
  assert(generated < text.indexOf(invoke), `${label}: ${id} must be generated before the invocation`);
  assert(/randomBytes\(8\)\.toString\('hex'\)/.test(text.slice(generated, generated + 220)), `${label}: per-attempt dispatch id is not random`);
  if (name) {
    const taskName = text.indexOf('forge-agent-identity.js" --task-name');
    assert(taskName > generated && taskName < text.indexOf(invoke), `${label}: --task-name must follow the id and precede the invocation`);
    const call = text.slice(taskName, text.indexOf('2>/dev/null || true)', taskName));
    assert(call.includes('--unit ') && call.includes('--plan ') && call.includes(`--attempt "${name.attempt}"`), `${label}: --task-name lacks unit, plan or this attempt`);
    assert(/= "codex" \]/.test(text.slice(generated, taskName)), `${label}: task name is not Codex-only`);
  }
  assert(emitterCall(text).includes(`--dispatch-id "${name ? name.emitter : `$${id}`}"`), `${label}: emitter does not receive the same dispatch id`);
  assert.strictEqual(recordCount(text), 1, `${label}: identity must be recorded once per native flow`);
  const record = text.indexOf('forge-agent-identity.js" --record');
  const call = text.slice(record, text.indexOf('--events', record) + 60);
  assert(call.includes(`--agent-id "${agentId}" --agent-id-source host-tool-return`), `${label}: agent id must come only from the host tool return`);
  assert(call.includes(`--unit "${unit}"`), `${label}: record unit differs`);
  assert(text.slice(Math.max(0, record - 120), record).includes(`[ -n "${agentId}" ]`), `${label}: record must be skipped without a host return`);
  if (receipt) assert(call.includes(`--receipt "${receipt}"`), `${label}: closed receipt missing`);
  else assert(!call.includes('--receipt'), `${label}: this flow has no closed receipt`);
  if (after) assert(record > text.indexOf(after), `${label}: identity must be recorded only after ${after}`);
  if (rules) {
    for (const piece of [...WINDOWS, ...NO_INFERENCE]) {
      const options = Array.isArray(piece) ? piece : [piece];
      assert(options.some(option => flat(text).includes(option)), `${label}: rule missing: ${options[0]}`);
    }
  }
}

test('S03/T07 native identity: one attempt id before invocation, same emitter id, host-returned agent id ordered by protected windows', () => {
  const auto = skills['forge-auto'];
  const single = between(auto, '**Single-task native flow', '#### 4-P.');
  assertNativeFlow('forge-auto single', single, { id: 'NATIVE_DISPATCH_ID', invoke: '**Native invocation adaptation**',
    name: { attempt: '$NATIVE_DISPATCH_ID', emitter: '$NATIVE_DISPATCH_ID' }, agentId: '$NATIVE_AGENT_ID', unit: '${unitType}/${unitId}' });
  assert(flat(single).includes('Logo depois desse retorno, se nenhuma janela protegida do owner está aberta, registre'), 'forge-auto: immediate record outside windows missing');
  assert(flat(single).includes('reconhecimento do spawn no Codex ou conclusão no Claude'), 'forge-auto: host return moments missing');
  assert(flat(single).includes('Saída vazia de `--task-name` mantém o `taskName` atual'), 'forge-auto: empty task name rule missing');
  assert(between(auto, '{icon} {unit_id} · {one-liner}', '`🧠 S01 · extract memories`'), 'forge-auto: Claude description format changed');

  const batch = between(auto, '#### 4-P.', '**k) Re-enter the dispatch loop**');
  assertNativeFlow('forge-auto batch', batch, { id: 'NATIVE_DISPATCH_ID_BY_TASK', invoke: 'invoke(NATIVE_INVOCATION_BY_TASK',
    name: { attempt: '${NATIVE_DISPATCH_ID_BY_TASK[$ENTRY_ID]}', emitter: '${NATIVE_DISPATCH_ID_BY_TASK[$ENTRY_ID]}' },
    agentId: '${NATIVE_AGENT_ID_BY_TASK[$ENTRY_ID]}', unit: 'execute-task/${ENTRY_ID}', rules: false });
  assert(flat(batch).includes('mesmas regras de ordem, de janelas protegidas e de não inferência do fluxo de tarefa única'), 'forge-auto batch: shared rules pointer missing');
  assert.strictEqual(recordCount(auto), 2, 'forge-auto: one record per native flow');

  const next = skills['forge-next'];
  const nextFlow = between(next, '**Native dispatch (`WORKER_MODE == native`)**', '### 5. Process result');
  assertNativeFlow('forge-next', nextFlow, { id: 'NATIVE_DISPATCH_ID', invoke: '**Native invocation adaptation**',
    name: { attempt: '$NATIVE_DISPATCH_ID', emitter: '$NATIVE_DISPATCH_ID' }, agentId: '$NATIVE_AGENT_ID', unit: '${unitType}/${unitId}' });
  assert.strictEqual(recordCount(next), 1, 'forge-next: one record per native flow');

  const task = skills['forge-task'];
  const loose = between(task, '**Native dispatch** (canonical host form', '**Contract miss gate (Layer 0)');
  assertNativeFlow('forge-task execute-loose-task', loose, { id: 'NATIVE_DISPATCH_ID', invoke: 'native = buildNativeInvocation({',
    name: { attempt: '$NATIVE_DISPATCH_ID', emitter: '$NATIVE_DISPATCH_ID' }, agentId: '$NATIVE_AGENT_ID', unit: 'execute-task/{TASK_ID}' });
  assert(loose.includes("taskName: NATIVE_TASK_NAME || 'execute-loose-task',"), 'execute-loose-task: empty name must keep the current taskName');

  const fix = between(task, '- **CONCEDED items → fix now (Step 7a):**', '- **OPEN items (Step 7b):**');
  assertNativeFlow('forge-task review-fix', fix, { id: 'RF_NATIVE_DISPATCH_ID', invoke: 'fixer = buildNativeInvocation({',
    name: { attempt: '$RF_NATIVE_DISPATCH_ID', emitter: '$RF_NATIVE_DISPATCH_ID' }, agentId: '$RF_NATIVE_AGENT_ID',
    unit: 'review-fix/{TASK_ID}', after: '`forge-review-fix.js --accept-native` as prescribed', rules: false });
  assert(fix.includes("taskName: RF_NATIVE_TASK_NAME || 'review-fix',"), 'review-fix: empty name must keep the current taskName');
  assert(flat(fix).includes('entre `--prepare-native` e `--accept-native` a janela protegida do owner está aberta'), 'review-fix: protected window missing');

  const preparation = between(task, '### Canonical preparation caller', '### Step 1 — Brainstorm');
  assert.strictEqual(recordCount(preparation), 1, 'preparation: one record per native phase flow');
  const prepRecord = preparation.indexOf('forge-agent-identity.js" --record');
  assert(prepRecord > preparation.indexOf('forge-task-preparation.js" --accept-native'), 'preparation: record must follow --accept-native');
  const prepCall = preparation.slice(prepRecord, preparation.indexOf('fi\n', prepRecord));
  for (const piece of ['--dispatch-id "$NATIVE_DISPATCH_ID"', '--agent-id "$NATIVE_AGENT_ID" --agent-id-source host-tool-return',
    '--receipt "$PREPARATION_RESULT_FILE.receipt.json"']) assert(prepCall.includes(piece), `preparation record lacks ${piece}`);
  assert(flat(preparation).includes('Entre `--start` e `--accept-native` a janela protegida do owner está aberta: só mostre na conversa'), 'preparation: protected window missing');
  for (const piece of NO_INFERENCE) assert(flat(preparation).includes(piece), `preparation: rule missing: ${piece}`);
  assert.strictEqual(recordCount(task), 3, 'forge-task: execute-loose-task, review-fix and preparation records');
  assert(!/--agent-id "\$\{?[A-Z_]*TASK_NAME|--agent-id "\/root\//.test(Object.values(skills).join('\n')), 'agent id composed from a task name or /root/');
});

test('S03/T07 Codex read-only guard: full plan-checker with exact permissions, code-only plan/research/discuss and preparation, exit 3/4 stops', () => {
  for (const name of ['forge-auto', 'forge-next']) {
    const text = skills[name];
    const gate = between(text, '**Plan-check gate (between plan-slice and first execute-task):**', '7. **Parse the worker result**');
    const capture = gate.indexOf('forge-native-readonly-guard.js" --capture');
    assert(capture >= 0 && capture < gate.indexOf("Agent({ subagent_type: 'forge-plan-checker'"), `${name}: plan-checker capture must precede the spawn`);
    for (const piece of ['No host Codex', '--mode full', '--allow-publication ".gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN-CHECK.md"',
      '--allow-append .gsd/forge/events.jsonl', '${OWN_LEASE_UNIT:+--own-lease "$OWN_LEASE_UNIT"}', '${OWN_RUN_ID:+--own-run "$OWN_RUN_ID"}',
      '--verify "$PLAN_CHECK_BASELINE" --writer-stopped', 'falha na captura impede o spawn', 'Saída 3 ou 4 para antes do próximo writer']) {
      assert(flat(gate).includes(piece), `${name}: plan-checker guard lacks ${piece}`);
    }
    assert(/nada (?:é revertido|é revertido até)/.test(flat(gate)), `${name}: plan-checker guard must not revert`);
    assert(flat(text).includes('No host Codex, esta re-execução usa o mesmo guard `full` do passo 5'), `${name}: re-run plan-checker guard missing`);

    const flow = name === 'forge-auto' ? between(text, '**Single-task native flow', '#### 4-P.')
      : between(text, '**Native dispatch (`WORKER_MODE == native`)**', '### 5. Process result');
    const readonly = flow.indexOf('forge-native-readonly-guard.js" --capture');
    assert(readonly >= 0 && readonly < flow.indexOf('**Native invocation adaptation**'), `${name}: code-only capture must precede the invocation`);
    const block = flow.slice(flow.lastIndexOf('if [ "$HOST_RUNTIME" = "codex" ]', readonly), readonly + 260);
    assert(block.includes('plan-milestone|plan-slice|research-*|discuss-*)') && block.includes('--mode code-only'), `${name}: read-only native units are not code-only`);
    const verify = flow.indexOf('--verify "$READONLY_BASELINE" --writer-stopped');
    assert(verify > readonly && verify < flow.indexOf('forge-dispatch-event.js'), `${name}: code-only verify must follow the return and precede the emitter`);
    assert(flat(flow).includes('Saída 3 ou 4 para antes do próximo writer'), `${name}: read-only exit 3/4 rule missing`);
    assert(flat(flow).includes('não sandbox do SO'), `${name}: detection limit missing`);
  }
  const preparation = between(skills['forge-task'], '### Canonical preparation caller', '### Step 1 — Brainstorm');
  for (const piece of ['No host Codex, cada fase nativa de preparação também roda dentro de `forge-native-readonly-guard.js` em modo `code-only`',
    'falha na captura impede a chamada', 'Depois do retorno terminal e antes do `--accept-native`, rode `--verify <baseline> --writer-stopped`',
    'Saída 3 ou 4 não vira `rawResult`', 'não reverta nada e não inicie outro writer antes da reconciliação do owner']) {
    assert(flat(preparation).includes(piece), `forge-task preparation guard lacks ${piece}`);
  }
});

test('S03/T07 status: forge-status.js line stays and the personal agent view is relayed verbatim without other work', () => {
  const status = skills['forge-status'];
  const block = between(status, '```bash\n', '```\n');
  const lines = block.split('\n').filter(Boolean);
  assert.deepStrictEqual(lines.slice(-2), ['node "$FORGE_SCRIPTS_DIR/forge-status.js" $ARGUMENTS',
    'node "$FORGE_SCRIPTS_DIR/forge-agent-view.js" --personal'], 'status block must end with status then the personal view');
  assert(status.indexOf('Repasse a saída verbatim.') > status.indexOf('forge-agent-view.js" --personal'), 'verbatim relay must cover the personal view');
  for (const piece of ['só os agentes do seu próprio trabalho, pelo seletor pessoal canônico', '`empty_reason`', '`no-bindings`',
    'nunca liste agentes de outro trabalho']) assert(flat(status).includes(piece), `status lacks ${piece}`);
  assert(!/forge-agent-view\.js"? (?:--milestone|--workflow|--unit)/.test(status), 'status must not select agents outside the personal scope');
});

test('S03/T07 config: explicit subagents on/off call setup/remove with --observe and keep statusline routes', () => {
  for (const piece of ['**If $ARGUMENTS is "subagents on"**', '**If $ARGUMENTS is "subagents off"**',
    '/forge-config subagents on|off', 'node "$FORGE_SCRIPTS_DIR/forge-subagent-statusline.js" --observe\n',
    'node "$FORGE_SCRIPTS_DIR/forge-subagent-statusline.js" --setup ~/.claude/settings.json --observe',
    'node "$FORGE_SCRIPTS_DIR/forge-subagent-statusline.js" --remove ~/.claude/settings.json --observe',
    'FORGE_SCRIPTS_DIR=$([ -f scripts/forge-subagent-statusline.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")']) {
    assert(config.includes(piece), `forge-config lacks ${piece}`);
  }
  const route = between(config, '## Subagents — "subagents on" / "subagents off"', '## MCP Management');
  for (const piece of ['`version`', '`relation`', '`source`', '`backup`', '`reserialized`', 'reserializa o arquivo com 2 espaços',
    '`external_gates`', 'recusa nomeada pelo `reason_code`', 'renderização no host não foi validada', 'sempre esta ação explícita do operador']) {
    assert(flat(route).includes(piece), `subagents route lacks ${piece}`);
  }
  // statusline on/off unchanged.
  assert(config.includes('## Enable — "statusline on"\n\n```bash\nnode ~/.claude/forge-settings.js ~/.claude/settings.json\n```'), 'statusline on changed');
  assert(config.includes('## Disable — "statusline off"\n\n```bash\nnode ~/.claude/forge-settings.js ~/.claude/settings.json --remove\n```'), 'statusline off changed');
  for (const line of normativeLines()) assert(!config.includes(line), `forge-config copies contract line: ${line.slice(0, 60)}`);
});

test('S03/T07 Codex projection: identity record, personal view and read-only guard reach the projected skills', () => {
  const renderer = require('./forge-codex-renderer');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-communication-surfaces-t07-'));
  temps.push(temp);
  const report = renderer.render({ repo: root, projectRoot: temp, codexHome: path.join(temp, 'host'),
    forgeHome: path.join(temp, 'forge'), ...renderer.PRODUCTION_DISPATCH_DIALECT });
  const projected = name => report.artifacts.find(item => item.source_id === 'skills' && item.source === `skills/${name}/SKILL.md`).content;
  for (const name of ORCHESTRATION) {
    const content = projected(name);
    assert(content.includes('--agent-id-source host-tool-return'), `${name}: projected identity record missing`);
    assert(content.includes('forge-native-readonly-guard.js') && content.includes('`code-only`'), `${name}: projected read-only guard missing`);
  }
  assert(projected('forge-status').includes('forge-agent-view.js" --personal'), 'forge-status: projected personal view missing');
});

for (const temp of temps) fs.rmSync(temp, { recursive: true, force: true });

console.log('');
console.log(`forge-communication-surfaces: ${passed} passed, ${failed} failed`);
console.log('Distribution proof only: host rendering, comprehension and human acceptance remain pending for the final round.');
if (failed > 0) {
  for (const f of failures) console.log(`  FAIL ${f.name}: ${f.error}`);
  process.exit(1);
}
