'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const api = require('./forge-question-channel');
const fixtures = require('./fixtures/question-channel/sessions.json');
for (const name of ['selectChannel', 'normalizeDecision', 'presentDecision', 'presentationId', 'waitPolicy', 'afterPresentation', 'inspectQuestionPreference', 'main']) assert.strictEqual(typeof api[name], 'function');
const pureImport = spawnSync(process.execPath, ['-e', `const fs=require('fs'),read=fs.readFileSync;fs.readFileSync=function(file,...args){if(typeof file==='string'&&file.endsWith('.js'))return read.call(this,file,...args);throw Error('unexpected-data-read')};require(${JSON.stringify(path.join(__dirname, 'forge-question-channel.js'))})`], { encoding: 'utf8', windowsHide: true });
assert.strictEqual(pureImport.status, 0, pureImport.stderr);
console.log('PASS channel public exports and module import perform no data reads');
const sync = 'codex-request-user-input', asyncChannel = 'codex-request-user-input-async';
const decision = { id: 'root-choice', header: 'Raiz', question: 'Qual raiz usar?', recommended: 'B', options: [
  { label: 'A', description: 'Mantém a primeira raiz.' }, { label: 'B', description: 'Usa a segunda raiz.' }
] };
for (const row of fixtures) {
  const result = api.selectChannel(row.input);
  assert.strictEqual(result.channel, row.channel, row.name);
  assert(result.reason && result.wait_policy);
  console.log(`PASS channel fixture ${row.name}`);
}
assert.strictEqual(fixtures.length, 14);
assert.deepStrictEqual(api.selectChannel({ host: 'codex', mode: 'default', tools: ['invented', 'request_user_input'] }).ignored_tools, ['invented']);
assert.strictEqual(api.selectChannel({ host: 'codex', mode: 'alien', tools: ['request_user_input'] }).channel, 'text-fallback');
assert.strictEqual(api.selectChannel({ host: 'claude', mode: 'default', tools: ['request_user_input'] }).channel, 'text-fallback');
console.log('PASS selection ignores probes and foreign tools and rejects unknown mode');
const normal = api.normalizeDecision(decision, sync);
assert.strictEqual(normal.options[0].label, 'B (Recomendado)');
assert(!JSON.stringify(normal).includes('selected'));
assert(!JSON.stringify(normal).includes('default'));
assert.strictEqual(api.presentationId.decode(api.presentationId(decision.id)), decision.id);
assert(/^[a-z][a-z0-9_]*$/.test(api.presentationId('Root:one/two')));
const payload = api.presentDecision(decision, sync).payload;
assert.deepStrictEqual(Object.keys(payload), ['questions']);
assert.strictEqual(payload.questions.length, 1);
assert.strictEqual(payload.questions[0].id, api.presentationId(decision.id));
assert.deepStrictEqual(Object.keys(payload.questions[0]), ['id', 'header', 'question', 'options']);
assert.deepStrictEqual(Object.keys(payload.questions[0].options[0]), ['label', 'description']);
assert.strictEqual(api.presentDecision(decision, 'claude-ask-user-question').payload.questions[0].multiSelect, false);
const asyncResult = api.presentDecision(decision, asyncChannel);
assert.strictEqual(asyncResult.handle_is_answer, false);
assert.strictEqual(asyncResult.schema, 'host-exposed');
assert.strictEqual(asyncResult.payload, undefined);
const text = api.presentDecision(decision, 'text-fallback').message;
assert(text.includes(decision.id) && text.includes('1.') && text.includes('Sem resposta explícita'));
assert.strictEqual(api.normalizeDecision({ id: 'open', header: 'Livre', question: 'Explique.' }, 'text-fallback').options.length, 0);
for (const channel of [sync, asyncChannel, 'claude-ask-user-question']) {
  assert.throws(() => api.normalizeDecision({ id: 'open', header: 'Livre', question: 'Explique.' }, channel), /options-required/);
}
assert.throws(() => api.normalizeDecision({ ...decision, multiSelect: true }, sync), /multiselect-sequential-required/);
assert.throws(() => api.normalizeDecision({ ...decision, options: [...decision.options, { label: 'C', description: 'C' }, { label: 'D', description: 'D' }] }, sync), /options-regroup-required/);
assert.strictEqual(api.normalizeDecision({ ...decision, options: [...decision.options, { label: 'C', description: 'C' }, { label: 'D', description: 'D' }] }, 'claude-ask-user-question').options.length, 4);
assert.throws(() => api.normalizeDecision({ ...decision, options: [decision.options[0], decision.options[0]] }, sync), /options-invalid/);
assert.throws(() => api.normalizeDecision({ ...decision, header: 'x'.repeat(13) }, sync), /text-invalid/);
assert.throws(() => api.normalizeDecision({ ...decision, question: 'x'.repeat(241) }, sync), /text-invalid/);
const hostile = api.normalizeDecision({ ...decision, question: '\x1b]0;hidden\x07\x1b[31mQual\u202e raiz?\x00' }, sync);
assert.strictEqual(hostile.question, 'Qual raiz?');
console.log('PASS decision formatting, reversible presentation IDs, one question, regrouping and terminal sanitization');
for (const channel of api.CHANNELS) {
  const policy = api.waitPolicy(channel);
  assert(!/poll|sleep|resume/.test(JSON.stringify(policy)));
  assert.strictEqual(api.afterPresentation(channel, { outcome: 'answered', answer: 'Sim', explicit: true }).action, 'record-answer');
  for (const outcome of ['handle-accepted', 'closed', 'cancelled', 'empty', 'timeout', 'unknown']) {
    const next = api.afterPresentation(channel, { outcome });
    assert.strictEqual(next.action, 'close-round'); assert.strictEqual(next.pending, true);
  }
  assert.strictEqual(api.waitPolicy(channel, { marker: 'present' }).preference_source, 'personal');
}
console.log('PASS economic wait never schedules model work and nonanswers stay pending');
const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-question-channel-'));
try {
  const codex = path.join(root, 'codex'), claude = path.join(root, 'claude');
  fs.mkdirSync(codex); fs.mkdirSync(claude);
  const file = path.join(codex, 'AGENTS.md');
  fs.writeFileSync(file, '<!-- user:async-question-lifetime:start -->\nprivate preference\n<!-- user:async-question-lifetime:end -->\n');
  const before = fs.readFileSync(file), mtime = fs.statSync(file).mtimeMs;
  const options = { codexHome: codex, claudeHome: claude, runtimes: ['codex'] };
  const report = api.inspectQuestionPreference(options);
  assert.strictEqual(report.codex.marker, 'present'); assert(/^[a-f0-9]{64}$/.test(report.codex.sha256));
  assert.strictEqual(report.claude, undefined); assert(!JSON.stringify(report).includes('private preference'));
  assert.deepStrictEqual(fs.readFileSync(file), before); assert.strictEqual(fs.statSync(file).mtimeMs, mtime);
  fs.writeFileSync(file, '<!-- user:async-question-lifetime:start -->\nmissing end');
  assert.strictEqual(api.inspectQuestionPreference(options).codex.marker, 'malformed');
  fs.writeFileSync(file, Buffer.from([255])); assert.strictEqual(api.inspectQuestionPreference(options).codex.state, 'invalid');
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1)); assert.strictEqual(api.inspectQuestionPreference(options).codex.state, 'oversize');
  fs.unlinkSync(file); assert.strictEqual(api.inspectQuestionPreference(options).codex.state, 'absent');
  const junction = path.join(root, 'codex-junction');
  try {
    fs.symlinkSync(codex, junction, 'junction'); fs.writeFileSync(file, 'preference');
    assert.strictEqual(api.inspectQuestionPreference({ ...options, codexHome: junction }).codex.state, 'unreadable');
    fs.unlinkSync(file); console.log('PASS preference ancestor junction refused');
  } catch (error) { if (error.code !== 'EPERM') throw error; console.log('SKIP preference junction negative: Windows EPERM'); }
  try {
    fs.symlinkSync(path.join(claude, 'CLAUDE.md'), file);
    assert.strictEqual(api.inspectQuestionPreference(options).codex.state, 'unreadable');
  } catch (error) { if (error.code !== 'EPERM') throw error; console.log('SKIP symlink preference negative: Windows EPERM'); }
  const cli = spawnSync(process.execPath, [path.join(__dirname, 'forge-question-channel.js'), '--select', '--host', 'codex', '--mode', 'default', '--tool', 'request_user_input', '--json'], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(cli.status, 0, cli.stderr); assert.strictEqual(JSON.parse(cli.stdout).channel, sync);
  console.log('PASS preference marker/hash only, bounded read without mutation and CLI');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
