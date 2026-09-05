'use strict';
const assert = require('assert');
const { addDefaultStatusLine } = require('./forge-codex-statusline');

for (const original of [
  '', 'model = "my-model"\n[windows]\nsandbox = "elevated"\n',
  '\uFEFF# operator config\r\nmodel = "my-model"',
  '[tui]\nnotifications = false\n[windows]\nsandbox = "elevated"\n',
  '["tui"] # custom table\r\nnotifications = false\r\n',
  "['tui']", '[tui]',
]) {
  const result = addDefaultStatusLine(original);
  assert.strictEqual(result.reason, 'status-line-added');
  assert(result.content.includes('context-used'));
  assert.strictEqual(addDefaultStatusLine(result.content).content, result.content);
  assert.strictEqual(result.content.replace(/(?:tui\.)?status_line = [^\r\n]+\r?\n/, '').trimEnd(), original.trimEnd());
  if (original.includes('\r\n')) assert(!/(?<!\r)\n/.test(result.content));
}
for (const original of [
  '[tui]\nstatus_line = []\n',
  'tui.status_line = ["git-branch"]\n',
  '[tui]\n"status_line" = [\n "context-remaining",\n]\n',
  '# forge-source:codex-config version=old\n[tui]\nstatus_line = ["codex-version"]\n',
]) {
  assert.deepStrictEqual(addDefaultStatusLine(original), { content: original, reason: 'status-line-preserved' });
}
for (const original of [
  'tui = { notifications = false }\n',
  'tui.notifications = false\n', '[tui.theme]\nname = "a"\n',
  'instructions = """\n[tui]\n"""\n',
  '["\\u0074ui"]\nnotifications = false\n',
  '[tui]\n[tui]\n',
]) {
  assert.deepStrictEqual(addDefaultStatusLine(original), { content: original, conflict: true, reason: 'status-line-manual-merge' });
}
console.log('PASS Codex status-line additive merge, preservation, CRLF/BOM, idempotence and ambiguous TOML.');
