'use strict';
const assert = require('assert');
const { probe, addDefaultQuestions, FEATURE } = require('./forge-codex-questions');
const supported = { supported: true, reason: 'questions-probe-supported' };
let calls = [];
const options = { codexQuestionBinary: 'fixture-codex', questionSpawnSync: (...args) => { calls.push(args); return { status: 0, stdout: `${FEATURE} under development false\n` }; } };
assert.deepStrictEqual(probe(options), supported);
assert.deepStrictEqual(calls[0].slice(0, 2), ['fixture-codex', ['features', 'list']]);
assert.strictEqual(calls[0][2].shell, false);
assert.strictEqual(calls[0][2].timeout, 3000);
assert.strictEqual(calls[0][2].windowsHide, true);
calls = [];
assert.strictEqual(probe({ ...options, dryRun: true }).reason, 'questions-probe-dry-run');
assert.strictEqual(calls.length, 0);
for (const [result, reason] of [
  [{ status: 0, stdout: 'other stable false' }, 'questions-probe-unsupported'],
  [{ status: 0, stdout: `warning: ${FEATURE} under development false` }, 'questions-probe-unsupported'],
  [{ status: 1, stdout: `${FEATURE} stable true` }, 'questions-probe-failed'],
  [{ status: null, error: { code: 'ETIMEDOUT' } }, 'questions-probe-timeout'],
]) {
  const capability = probe({ ...options, questionSpawnSync: () => result });
  assert.strictEqual(capability.reason, reason);
  assert.strictEqual(addDefaultQuestions('model = "keep"\n', capability).content, 'model = "keep"\n');
}
assert.strictEqual(probe({ ...options, questionSpawnSync: () => { throw new Error('offline'); } }).reason, 'questions-probe-failed');
for (const original of [
  '', '# user comment\nmodel = "keep"\n', '\uFEFFmodel = "keep"',
  '[features]\nother = true\n[model]\nx = "keep"\n',
  '["features"]\r\n# preserve me\r\nother = false\r\n',
]) {
  const result = addDefaultQuestions(original, supported);
  assert.strictEqual(result.reason, 'questions-added');
  assert(result.content.includes(`${FEATURE} = true`));
  assert.strictEqual(addDefaultQuestions(result.content, supported).content, result.content);
  // Removing exactly the added line restores every operator byte.
  assert.strictEqual(result.content.replace(new RegExp(`(?:features\\.)?${FEATURE} = true\\r?\\n`), ''), original);
  if (original.includes('\r\n')) assert(!/(?<!\r)\n/.test(result.content));
}
for (const original of [
  `[features]\n${FEATURE} = false # explicit\n`,
  `[features]\n${FEATURE} = true\n`,
  `features.${FEATURE} = false\n`,
  `"features".'${FEATURE}' = false\n`,
  `['features']\n"${FEATURE}" = false\n`,
]) {
  const result = addDefaultQuestions(original, supported);
  assert.strictEqual(result.content, original);
  assert.strictEqual(result.reason, 'questions-preserved');
}
for (const original of [
  'features = {}\n', 'features = { other = true }\n',
  '[features.child]\nx = true\n', '[[features]]\nx = true\n',
  '[features]\n[features]\n', 'features.other = true\n',
  'model = """multiline\nvalue"""\n', '[features\n',
]) {
  const result = addDefaultQuestions(original, supported);
  assert.strictEqual(result.content, original);
  assert.strictEqual(result.reason, 'questions-manual-merge');
  assert.strictEqual(result.conflict, true);
}
console.log('forge-codex-questions tests passed (probe and conservative config cases)');
