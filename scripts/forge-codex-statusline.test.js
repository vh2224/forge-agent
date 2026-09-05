'use strict';
const assert = require('assert');
const { addDefaultStatusLine } = require('./forge-codex-statusline');

for (const original of [
  '', 'model = "my-model"\n[windows]\nsandbox = "elevated"\n',
  '\uFEFF# operator config\r\nmodel = "my-model"',
  '[tui]\nnotifications = false\n[windows]\nsandbox = "elevated"\n',
  '["tui"] # custom table\r\nnotifications = false\r\n',
  "['tui']", '[tui]',
  '[tui]\nnotifications = false # configure status_line later\n',
  'developer_instructions = "Explain status_line before changing it"\n',
  '[mcp_servers.example.env]\nstatus_line = "verbose"\n',
  'developer_instructions = "Explain tui.status_line and # comments"\n',
  'status_line = "root setting"\n[other]\nstatus_line = []\n',
  '\uFEFF[tui] # status_line\r\nnotifications = false\r\n',
  '[mcp_servers.example]\nargs = [\n "status_line",\n ["tui"],\n]\n',
  '# """ status_line is only a comment\n[tui]\nnotifications = false\n',
  '"tui.status_line" = []\n',
  '[tui]\n"custom=key" = "status_line"\n',
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
  '"tui" . \'status_line\' = []\n',
  "['tui']\n'status_line' = []\n",
  '\uFEFF[tui]\r\nstatus_line = [] # custom\r\n',
  '[other]\nstatus_line = "unrelated"\n[tui]\nstatus_line = []\n',
  'tui.notifications = false\ntui.status_line = []\n',
]) {
  assert.deepStrictEqual(addDefaultStatusLine(original), { content: original, reason: 'status-line-preserved' });
}
for (const original of [
  'tui = { notifications = false }\n',
  'tui.notifications = false\n', '[tui.theme]\nname = "a"\n',
  'instructions = """\n[tui]\n"""\n',
  '["\\u0074ui"]\nnotifications = false\n',
  '[tui]\n[tui]\n',
  'developer_instructions = """\n[tui]\nstatus_line = []\n"""\n',
  "developer_instructions = '''\ntui.status_line = []\n'''\n",
  '[tui]\n"\\u0073tatus_line" = []\n',
  '[tui]\nstatus_line = []\n[tui]\n',
  'tui = { status_line = [] }\n',
  '"tui.status_line" = []\n[tui.theme]\nname = "a"\n',
  '[tui]\nstatus_line.custom = true\n',
]) {
  assert.deepStrictEqual(addDefaultStatusLine(original), { content: original, conflict: true, reason: 'status-line-manual-merge' });
}
console.log('PASS Codex status-line additive merge, preservation, CRLF/BOM, idempotence and ambiguous TOML.');
