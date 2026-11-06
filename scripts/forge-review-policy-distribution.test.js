#!/usr/bin/env node
'use strict';

// #341 (S01/T03) distribution suite: the canonical review spec, the review
// schemas, the native agents, the mandatory `review` procedure module and the
// CHANGELOG carry review-fix-policy-v1. The repository is only read; the
// documented CLI runs against a temporary synthetic owner removed in `finally`.
// No provider, network, real .gsd state or operator preference is touched.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const policy = require('./forge-review-policy');
const procedures = require('./forge-procedure-context');
const sourceGuard = require('./forge-dispatch-source-guard');

const ROOT = path.resolve(__dirname, '..');
const REVIEW = 'shared/forge-review.md';
const TRISTATE = ['yes', 'no', 'unknown'];
// Same line-ending normalization as the smoke readers: CRLF is not content.
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n?/g, '\n');
const count = (text, needle) => text.split(needle).length - 1;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n  ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n  ') : error}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}\n  ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n  ') : error}`); }
}
function note(text) { console.log(`note - ${text}`); }

// A `## ` section of a Markdown document, up to the next `## ` heading.
function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  assert(start !== -1, `heading present: ${heading}`);
  const next = text.indexOf('\n## ', start + heading.length + 2);
  return text.slice(start + 1, next === -1 ? text.length : next + 1);
}
function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert(match, 'frontmatter present');
  return match[1].split('\n');
}
// Tokens of one documented shell line: double-quoted words keep their spaces.
function shellWords(line) {
  const words = [];
  const expression = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = expression.exec(line))) words.push(match[1] !== undefined ? match[1] : match[2]);
  return words;
}
function documentedArgv(text, marker, values) {
  const lines = text.split('\n').filter(line => line.startsWith('node ') && line.includes(marker));
  assert.strictEqual(lines.length, 1, `exactly one documented invocation ${marker}`);
  return shellWords(lines[0]).map((word) => {
    let out = word;
    for (const [name, value] of Object.entries(values)) out = out.split(name).join(value);
    assert(!/\$[A-Z_]/.test(out), `unsubstituted placeholder in ${word}`);
    return out;
  });
}
function withOwner(fn) {
  const owner = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-distribution-')));
  fs.mkdirSync(path.join(owner, '.gsd', 'forge'), { recursive: true });
  try { return fn(owner); } finally { fs.rmSync(owner, { recursive: true, force: true }); }
}

const review = read(REVIEW);
const challengeFile = JSON.parse(read('shared/schemas/challenge.schema.json'));
const verdictFile = JSON.parse(read('shared/schemas/verdict.schema.json'));
const policySection = section(review, '## Política executável de review-fix');

// The same anchors Section 52 of forge-smoke.js uses (LF-normalized above).
function engineLiterals() {
  const engineStart = review.indexOf('export const meta = {');
  const engine = review.slice(engineStart, review.indexOf('**Return schema:**', engineStart));
  const challengeAt = engine.indexOf('const challengeSchema = {');
  const challengeEnd = engine.indexOf('\n\nlet challenge = null');
  const verdictAt = engine.indexOf('const verdictSchema = function (allowed) {');
  const verdictEnd = engine.indexOf('\n\nlet defense = null');
  assert(engineStart !== -1 && challengeAt !== -1 && challengeEnd !== -1 && verdictAt !== -1 && verdictEnd !== -1,
    'Section 52 anchors preserved');
  /* eslint-disable no-new-func */
  const challengeSchema = new Function(`${engine.slice(challengeAt, challengeEnd)}\nreturn challengeSchema;`)();
  const verdictSchema = new Function(`${engine.slice(verdictAt, verdictEnd)}\nreturn verdictSchema;`)();
  /* eslint-enable no-new-func */
  return { challengeSchema, verdictSchema };
}

test('schemas: dual-verdict fields required with the closed yes/no/unknown enum; current fields and additionalProperties:false kept', () => {
  assert.strictEqual(challengeFile.additionalProperties, false);
  assert.strictEqual(verdictFile.additionalProperties, false);
  const objection = challengeFile.properties.objections.items;
  assert.strictEqual(objection.additionalProperties, false);
  assert.deepStrictEqual(objection.required, ['id', 'path_line', 'claim', 'suggested_fix', 'challenge', 'severity', 'reachable', 'reproduced', 'in_scope']);
  assert.deepStrictEqual(objection.properties.severity.enum, ['critical', 'high', 'medium', 'low']);
  for (const field of ['reachable', 'reproduced', 'in_scope']) {
    assert.strictEqual(objection.properties[field].type, 'string', field);
    assert.deepStrictEqual(objection.properties[field].enum, TRISTATE, field);
  }
  const verdict = verdictFile.properties.verdicts.items;
  assert.strictEqual(verdict.additionalProperties, false);
  assert.deepStrictEqual(verdict.required, ['id', 'verdict', 'rationale', 'reachable', 'in_scope']);
  assert.deepStrictEqual(verdict.properties.verdict.enum, [], 'the verdict enum stays injected per leg');
  for (const field of ['reachable', 'in_scope']) assert.deepStrictEqual(verdict.properties[field].enum, TRISTATE, field);
  assert(!Object.hasOwn(verdict.properties, 'reproduced'), 'only the challenger reports reproduction');
  assert.deepStrictEqual(policy.TRISTATE, TRISTATE, 'schema enum equals the policy enum');
});

test('Engine workflow: inline challengeSchema and verdictSchema equal the schema files in JSON shape', () => {
  const { challengeSchema, verdictSchema } = engineLiterals();
  assert.strictEqual(JSON.stringify(challengeSchema), JSON.stringify(challengeFile));
  assert.strictEqual(JSON.stringify(verdictSchema([])), JSON.stringify(verdictFile));
  assert.deepStrictEqual(verdictSchema(['open']).properties.verdicts.items.properties.verdict.enum, ['open']);
});

// Executes the real fenced Workflow script with a stubbed `agent`: the fields of
// the challenge and the contest of each leg must reach every returned item.
function workflowScript() {
  const open = '```js\nexport const meta = {';
  const start = review.indexOf(open);
  assert(start !== -1, 'Engine workflow script fence');
  const body = review.slice(start + 6, review.indexOf('\n```', start + 6));
  return body.replace(/^export const meta = /m, 'const meta = ');
}
async function runWorkflow(responses, rounds = 1) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction('args', 'agent', workflowScript());
  const calls = [];
  const agent = async (prompt, options) => {
    calls.push({ prompt, options });
    const value = responses[options.phase];
    if (value instanceof Error) throw value;
    return JSON.parse(JSON.stringify(value));
  };
  const result = await run({ wd: '/owner', unit: 'complete-slice/S01', diffCmd: 'git diff', defenseFile: '/owner/D.md', rounds }, agent);
  return { result, calls };
}
const OBJECTIONS = [
  { id: 'R1', path_line: 'src/a.js:10', claim: 'falha real', suggested_fix: 'validar', challenge: 'quebra no uso normal?',
    severity: 'high', reachable: 'yes', reproduced: 'no', in_scope: 'yes' },
  { id: 'R2', path_line: 'src/b.js:3', claim: 'corrida entre processos do próprio operador', suggested_fix: 'lock', challenge: 'acontece?',
    severity: 'critical', reachable: 'yes', reproduced: 'no', in_scope: 'yes' },
];

async function workflowCases() {
  await testAsync('Engine workflow script carries challenger fields and the defense and rebuttal contest for every item', async () => {
    const { result, calls } = await runWorkflow({
      Challenge: { objections: OBJECTIONS },
      Defense: { verdicts: [{ id: 'R1', verdict: 'conceded', rationale: 'real', reachable: 'yes', in_scope: 'yes' },
        { id: 'R2', verdict: 'conceded', rationale: 'real mas teórico', reachable: 'no', in_scope: 'yes' }] },
      Rebuttal: { verdicts: [{ id: 'R1', verdict: 'conceded', rationale: 'ok', reachable: 'yes', in_scope: 'yes' },
        { id: 'R2', verdict: 'conceded', rationale: 'ok', reachable: 'unknown', in_scope: 'yes' }] },
    });
    assert.strictEqual(result.outcome, 'ok');
    assert.strictEqual(calls[0].options.agentType, 'forge-reviewer');
    assert.strictEqual(JSON.stringify(calls[0].options.schema), JSON.stringify(challengeFile), 'challenge leg uses the file shape');
    assert.deepStrictEqual(calls[1].options.schema.properties.verdicts.items.required, verdictFile.properties.verdicts.items.required);
    assert(calls[1].prompt.includes('reachable: yes — reproduced: no — in_scope: yes'), 'advocate sees the challenger fields');
    const [r1, r2] = result.items;
    assert.deepStrictEqual([r1.reachable, r1.reproduced, r1.in_scope], ['yes', 'no', 'yes']);
    assert.deepStrictEqual(r1.defense, { verdict: 'conceded', rationale: 'real', reachable: 'yes', in_scope: 'yes' });
    assert.deepStrictEqual(r2.rebuttal, { verdict: 'conceded', rationale: 'ok', reachable: 'unknown', in_scope: 'yes' });
    // The documented verdict mapping feeds the deterministic classification.
    const verdictOf = item => ({ resolution: item.resolution, severity: item.severity, reachable: item.reachable,
      reproduced: item.reproduced, in_scope: item.in_scope,
      contest: { advocate: { reachable: item.defense.reachable, in_scope: item.defense.in_scope },
        rebuttal: { reachable: item.rebuttal.reachable, in_scope: item.rebuttal.in_scope } } });
    const c1 = policy.classifyFinding(verdictOf(r1), 'dual-verdict');
    const c2 = policy.classifyFinding(verdictOf(r2), 'dual-verdict');
    assert.strictEqual(c1.fix_now, true);
    assert.strictEqual(c2.fix_now, false, 'the advocate contest downgrades a theoretical critical finding');
    assert.deepStrictEqual(c2.reasons, ['not-reachable']);
  });
  await testAsync('Engine workflow placeholder legs carry no contest; a legacy challenger stays unknown in the policy', async () => {
    const legacy = OBJECTIONS.map(({ reachable, reproduced, in_scope, ...rest }) => rest);
    const { result } = await runWorkflow({ Challenge: { objections: legacy }, Defense: new Error('advocate down'), Rebuttal: new Error('down') });
    for (const item of result.items) {
      assert.strictEqual(item.defense.verdict, 'open');
      assert.strictEqual(item.defense.reachable, undefined, 'a placeholder leg did not report');
      assert.strictEqual(item.rebuttal.in_scope, undefined);
      assert.strictEqual(item.reachable, undefined);
      const classified = policy.classifyFinding({ resolution: 'conceded', severity: item.severity, reachable: item.reachable,
        in_scope: item.in_scope }, 'dual-verdict');
      assert.strictEqual(classified.fix_now, false);
      assert.deepStrictEqual(classified.reasons, ['reachable-unknown', 'scope-unknown']);
    }
  });
}

test('Return schema and render text document the dual-verdict fields', () => {
  const at = review.indexOf('**Return schema:**');
  const block = review.slice(at, review.indexOf('**Render by the orchestrator**', at));
  assert(block.includes("reachable, reproduced, in_scope,   // challenger: 'yes'|'no'|'unknown'"));
  assert(block.includes("rationale, reachable?, in_scope? }"));
  assert(block.includes('§ Política executável de\nreview-fix'));
});

test('canonical policy section sits immediately before Step 7a and states the contract', () => {
  const at = review.indexOf('\n## Política executável de review-fix\n');
  assert.strictEqual(review.indexOf('\n## ', at + 1), review.indexOf('\n## Step 7a — Conceded fix dispatch (both modes)\n'));
  for (const phrase of [
    '`review-fix-policy-v1`', 'node "$FORGE_SCRIPTS_DIR/forge-review-policy.js" --classify --input "$RF_VERDICTS_FILE"',
    'node "$FORGE_SCRIPTS_DIR/forge-review-fix.js" --defer "$RF_DEFER_REQUEST"', 'forge-review-policy.js --admit --request',
    'node "$FORGE_SCRIPTS_DIR/forge-review-policy.js" --status --cwd "$WORKING_DIR"',
    '**um único despacho agrupado**', '`dispatchId`', '`basis: operator-decision`', '`basis: dual-verdict`',
    'crítica conta como alta', '`reproduced` é registrado', 'adulteração manual de arquivo local',
    'corrida entre processos\n  do próprio operador', 'FIFO', 'entrada impossível', '`no` < `unknown` < `yes`',
    '**Correção:** não aplicada — deferida para triagem final (<motivo>)', '`review-fix-admission-required`',
    '`nativePreparation.admission`', '`reviewFixRecoveryOf`', '`counted:false`', 'Desconhecido nunca vira zero',
    '⚖ Review <S##|TASK_ID>: ciclo <n>/2 · review-fix <X> / execute <Y> (<Z>% | desconhecido)',
    '### Verificação dirigida, sem nova revisão', '`verify_paths`', 'regressão dirigida',
    'Não há\nnova revisão dialética', 'review/{TASK_ID}/{R#}', '**§ Item capture**',
    'review.milestone_task_review: true', '`complete-slice/S##`', 'código 2 e `provider_called:false`',
    'sem retry, sem\nfallback para outro revisor ou família', 'o Engine workflow e a réplica por `SendMessage`',
    'sem correção inline pelo orquestrador e sem outro worker',
  ]) assert(policySection.includes(phrase), `policy section states: ${phrase}`);
  for (const code of [...policy.REFUSAL_CODES, ...policy.REVIEW_LEG_CODES, policy.ADMISSION_EVENT, policy.LEG_REFUSAL_EVENT]) {
    assert(policySection.includes(`\`${code}\``), `policy section names ${code}`);
  }
  for (const reason of policy.ITEM_REASONS) assert(policySection.includes(`\`${reason}\``), `closed reason ${reason}`);
  // The new text launches nothing: no registered dispatch token lives in it.
  for (const token of [/forge-dispatch-resolve\.js/, /Agent\(/, /forge-xllm\.js/, /\b(?:buildNativeInvocation|invokeNative)\b/,
    /forge-task-preparation\.js/, /forge-unit-sidecar\.js"?\s+--request\b/, /forge-dispatch-event\.js/]) {
    assert(!token.test(policySection), `no registered token ${token}`);
  }
});

test('point adjustments: Step 6 lines, native dispatchId, sidecar refusals, directed verification, grouped Step 7b and Step 9 collection', () => {
  // The Step 6 template holds `## ` headings inside its fence: slice up to the next real section.
  const step6 = review.slice(review.indexOf('\n## Step 6 — Write `{S##}-REVIEW.md`\n'), review.indexOf('\n## Política executável de review-fix\n'));
  assert.strictEqual(count(step6, '- **Veredito duplo:** severidade <s> · alcançável <sim|não|desconhecido> · reproduzido <sim|não|desconhecido> · escopo <sim|não|desconhecido> → <corrigir agora | triagem final (<motivo>)>'), 2);
  assert(step6.includes('`não aplicada — deferida para triagem final (<motivo>)`'));
  const step7a = section(review, '## Step 7a — Conceded fix dispatch (both modes)');
  assert(step7a.includes("the cycle's single `dispatchId` (required)"));
  assert(step7a.includes("optional `verify_paths`, `verdict` and `basis`"));
  assert(step7a.includes('4. An admission refusal (`review-fix-cycle-limit`, `review-fix-budget-exhausted`, `review-fix-not-fix-now`,'));
  assert(step7a.includes('- **Verificação dirigida, sem nova revisão.** The fix is verified, never reviewed again'));
  assert(!review.includes('**No re-review.**'), 'the old re-review bullet is gone');
  assert(!review.includes('NOT re-run through the reviewer'), 'replaced, not duplicated');
  const step7b = section(review, '## Step 7b — Posture (handle OPEN items)');
  assert(step7b.includes('Ask these questions **before** the Step 7a cycle is dispatched'));
  assert(step7b.includes("never a per-item dispatch"));
  assert(!step7b.includes('dispatch a `review-fix` unit for that item'), 'the gate fix no longer dispatches per item');
  assert(!step7b.includes('dispatch a `review-fix` unit (same shape as Step 7a) for the accepted items'));
  assert(step7b.includes('--option "fix:Refatorar agora:Inclui o item no review-fix agrupado do ciclo"'));
  const step9 = section(review, '## Step 9 — Milestone-final triage (before `complete-milestone`)');
  const collect = step9.slice(step9.indexOf('1. **Collect.**'), step9.indexOf('2. **If zero pending items**'));
  assert(collect.includes('`**Correção:** não aplicada — deferida para triagem final (<motivo>)`'), 'Step 9 collects the new marker');
  assert(collect.includes('`**Correção:** falhou — deferida para triagem final`'), 'older markers are still collected');
  assert(step9.includes('stays outside the fix-now filter and the per-slice cycle cap, is admitted with `counted:false`'));
  assert(step9.includes('ONE `review-fix` dispatch'));
});

test('agents: reviewer and advocate carry the dual-verdict fields; frontmatter and DEFENSE_FILE rules intact', () => {
  const reviewer = read('agents/forge-reviewer.md');
  assert.deepStrictEqual(frontmatter(reviewer), ['name: forge-reviewer',
    'description: Adversarial code reviewer. Scans a git diff as a senior reviewer and returns structured findings. Read-only; findings are advisory and never block.',
    'model: claude-sonnet-5', 'thinking: disabled', 'effort: medium', 'maxTurns: 20', 'tools: Read, Bash, Grep, Glob']);
  assert(reviewer.includes('- R1 `path:line` — issue — suggested fix — challenge: <the question that decides whether this is real> — reachable: <yes|no|unknown> — reproduced: <yes|no|unknown> — in_scope: <yes|no|unknown>'));
  assert.strictEqual(count(reviewer, '— reachable: <…> — reproduced: <…> — in_scope: <…>'), 3, 'every bucket line');
  const rebuttal = reviewer.slice(reviewer.indexOf('## Rebuttal mode'));
  assert(rebuttal.includes('- R2: maintained — <why the defense fails> — reachable: <…> — in_scope: <…>'));
  assert(!/^- R\d: .*reproduced/m.test(rebuttal), 'the rebuttal does not restate reproduction');
  for (const phrase of ['**normal use**', 'manual tampering with a local file', "a race between the operator's own processes",
    'a FIFO or other special file', 'an impossible input', 'never a condition for fixing']) assert(reviewer.includes(phrase), phrase);
  for (const rule of ['NO_FLAGS', '## Rebuttal mode', 'Never return `status: blocked`']) assert(reviewer.includes(rule), rule);

  const advocate = read('agents/forge-advocate.md');
  const fields = frontmatter(advocate);
  for (const line of ['name: forge-advocate', 'model: claude-fable-5', 'thinking: adaptive', 'maxTurns: 48',
    'tools: Read, Bash, Grep, Glob, Write']) assert(fields.includes(line), line);
  assert(advocate.includes('- R2: conceded — `path:line` — <what is actually wrong and what should happen> — reachable: <…> — in_scope: <…>'));
  assert(advocate.includes('Conceding "it is real" is not conceding "fix it now"'));
  assert(advocate.includes('contesting can only downgrade'));
  for (const rule of ['Never write to any path other than `DEFENSE_FILE`.', 'Your ONLY write target is',
    'append its one line to `DEFENSE_FILE`', 'same line format as the `### Defense` block below']) assert(advocate.includes(rule), rule);
});

test('mandatory review module: directed verification without new review, cap and grouped dispatch; canonical sha256 equals the manifest', () => {
  const file = path.join(ROOT, 'shared', 'forge-procedure-review.md');
  const text = procedures.canonicalProcedureBytes(fs.readFileSync(file)).toString('utf8');
  assert(!/subsequent review/i.test(text), 'no subsequent review');
  for (const phrase of ['one grouped dispatch', 'review-fix-policy-v1', 'at most 2 cycles per boundary',
    'never retried,\nrerouted or fixed inline', 'directed verification of the\nfixed items, without a new review', 'final triage']) {
    assert(text.includes(phrase), phrase);
  }
  const actual = sha256(procedures.canonicalProcedureBytes(fs.readFileSync(file)));
  const manifest = JSON.parse(read('shared/forge-procedures.json'));
  const entry = manifest.modules.find(module => module.id === 'review');
  assert.strictEqual(entry.path, 'shared/forge-procedure-review.md');
  assert.strictEqual(entry.sha256, actual, `manifest review sha256 must be the canonical digest ${actual}`);
  for (const phase of ['review-challenger', 'review-advocate', 'review-rebuttal', 'review-fix']) {
    const loaded = procedures.loadProcedureContext({ cwd: ROOT, phase });
    assert(loaded.modules.some(module => module.id === 'review' && module.sha256 === actual), phase);
    assert(loaded.content.includes('without a new review'), phase);
  }
});

test('smoke-pinned counts and literals of the touched texts are unchanged', () => {
  const skills = ['skills/forge-auto/SKILL.md', 'skills/forge-next/SKILL.md', 'skills/forge-task/SKILL.md'].map(read);
  assert.strictEqual(count(review, '"${BUDGET_ARGS[@]}"'), 7);
  assert.strictEqual([review, ...skills].reduce((sum, text) => sum + count(text, '--unit-type review-fix'), 0), 4);
  assert.strictEqual(count(review, 'Engine Fallback Discipline'), 2);
  for (const [needle, expected] of [['review-agent-unavailable', 11], ['review-advocate-unavailable', 9],
    ['review-challenger-unavailable', 5], ['review-rebuttal-unavailable', 3]]) {
    assert.strictEqual(count(review, needle), expected, needle);
  }
  assert.strictEqual(count(review, 'NUNCA produz veredito de review no lugar de um agente indisponível'), 1);
  assert.strictEqual(count(review, 'ausência de review não é aprovação'), 2);
  assert(/PROIBIDO.*NO_FLAGS/s.test(review));
  assert(/Step 4 \(rebuttal\) é PULADO/.test(review));
  assert(review.includes('<!-- forge:linked-task:review-budget:start -->') && review.includes('<!-- forge:linked-task:review-budget:end -->'));
});

test('registered calls of forge-review.md keep the same count per kind; measured drift is reported for T05', () => {
  const registry = sourceGuard.SOURCE_REGISTRY.filter(row => row.path === REVIEW);
  const found = sourceGuard.discover(ROOT).candidates.filter(candidate => candidate.path === REVIEW);
  const byKind = list => list.reduce((acc, item) => { acc[item.kind] = (acc[item.kind] || 0) + 1; return acc; }, {});
  assert.deepStrictEqual(byKind(found), byKind(registry), 'no registered call was added or removed');
  const current = new Set(found.map(candidate => `${candidate.kind}\u0000${candidate.fingerprint}`));
  const drift = registry.filter(row => !current.has(`${row.kind}\u0000${row.fingerprint}`)).map(row => row.id);
  const unchanged = registry.length - drift.length;
  assert(unchanged >= 4, `at least four registered calls keep their exact fingerprint (got ${unchanged})`);
  note(`${REVIEW} registered calls: ${registry.length}; unchanged fingerprints: ${unchanged}; drift ids: ${drift.length ? drift.join(', ') : 'none'}`);
});

test('documented --status argv prints the visible line for a temporary owner; documented --classify runs', () => withOwner((owner) => {
  const minute = 60000, start = Date.parse('2026-11-06T10:00:00.000Z');
  const rows = [
    { ts: new Date(start).toISOString(), event: 'dispatch', unit: 'review-fix/S01', milestone: 'M001', slice: 'S01', dispatch_id: 'legacy-1' },
    { ts: new Date(start).toISOString(), event: 'sidecar-unit', workflow_id: 'wf', dispatch_id: 'legacy-1', unit: 'review-fix/S01', status: 'started', provider_called: false },
    { ts: new Date(start + 20 * minute).toISOString(), event: 'sidecar-unit', workflow_id: 'wf', dispatch_id: 'legacy-1', unit: 'review-fix/S01', status: 'done', provider_called: true },
  ];
  const events = path.join(owner, '.gsd', 'forge', 'events.jsonl');
  fs.writeFileSync(events, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const before = fs.readFileSync(events);
  const values = { '$FORGE_SCRIPTS_DIR': __dirname, '$WORKING_DIR': owner, '$RF_MILESTONE_ID': 'M001', '$RF_UNIT_ID': 'S01',
    '$RF_VERDICTS_FILE': path.join(owner, 'verdicts.json') };
  const argv = documentedArgv(policySection, 'forge-review-policy.js" --status', values);
  assert.strictEqual(argv[0], 'node');
  const status = spawnSync(process.execPath, argv.slice(1), { cwd: owner, encoding: 'utf8' });
  assert.strictEqual(status.status, 0, status.stderr);
  assert.strictEqual(status.stdout, '⚖ Review S01: ciclo 1/2 · review-fix 20 min / execute desconhecido (desconhecido)\n');
  assert(before.equals(fs.readFileSync(events)), '--status is read-only');

  fs.writeFileSync(values.$RF_VERDICTS_FILE, JSON.stringify({ items: [
    { r: 'R1', path: 'src/a.js', verdict: { resolution: 'conceded', severity: 'critical', reachable: 'yes', reproduced: 'no', in_scope: 'yes' } },
    { r: 'R2', path: 'src/b.js', verdict: { resolution: 'conceded', severity: 'high', reachable: 'yes', reproduced: 'yes', in_scope: 'yes',
      contest: { advocate: { reachable: 'no', in_scope: 'yes' } } } },
    { r: 'R3', path: 'src/c.js', basis: 'operator-decision', verdict: { resolution: 'open', severity: 'medium' } },
  ] }));
  const classifyArgv = documentedArgv(policySection, 'forge-review-policy.js" --classify', values);
  const classified = spawnSync(process.execPath, classifyArgv.slice(1), { cwd: owner, encoding: 'utf8' });
  assert.strictEqual(classified.status, 0, classified.stderr);
  const out = JSON.parse(classified.stdout);
  assert.deepStrictEqual(out.items.map(item => [item.r, item.fix_now, item.admissible, item.reasons]),
    [['R1', true, true, []], ['R2', false, false, ['not-reachable']],
      ['R3', false, true, ['not-conceded', 'severity-below-high', 'reachable-unknown', 'scope-unknown']]]);
}));

test('CHANGELOG: #341 entry right after the first entry under Não lançado, without CI/merge/release/installation/UAT claims', () => {
  const lines = read('CHANGELOG.md').split('\n');
  assert.strictEqual(lines[0], '## Não lançado');
  assert(lines[2].startsWith('- Prazos de milestone (M-20261101111759-opcoes-prazo-milestones):'), 'the first entry stays first');
  const entry = lines[3];
  assert(entry.startsWith('- Review-fix com limites executáveis (#341, M-20261106040502-review-fix-limites):'), entry.slice(0, 80));
  for (const topic of ['`review-fix-policy-v1`', 'uma revisão dialética por slice', '2 ciclos', '50%', 'veredito duplo',
    'verificação dirigida', 'triagem final', '`review.milestone_task_review`', '`shared/forge-review.md`']) {
    assert(entry.includes(topic), topic);
  }
  assert(entry.includes('CI, merge, release e instalação não estão demonstrados, e o UAT humano não foi realizado.'));
  assert.strictEqual(lines.filter(line => line.includes('(#341')).length, 1, 'one entry');
});

(async () => {
  await workflowCases();
  console.log(`\nforge-review-policy-distribution: ${passed}/${passed + failed} checks passed`);
  if (failed) process.exitCode = 1;
})();
