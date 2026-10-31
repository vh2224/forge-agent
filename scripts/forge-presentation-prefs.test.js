'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const prefs = require('./forge-presentation-prefs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-presentation-'));
const codexHome = path.join(root, 'codex');
const claudeHome = path.join(root, 'claude');
const config = path.join(codexHome, 'config.toml');
const settings = path.join(claudeHome, 'settings.json');
const options = { codexHome, claudeHome, userHome: root, env: {} };
function test(name, fn) { fn(); console.log(`PASS presentation ${name}`); }
function write(codex, claude) {
  fs.rmSync(config, { recursive: true, force: true });
  fs.rmSync(settings, { recursive: true, force: true });
  if (codex !== null) fs.writeFileSync(config, codex);
  if (claude !== null) fs.writeFileSync(settings, typeof claude === 'string' ? claude : JSON.stringify(claude));
}
function snapshot(file) { return { bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs }; }
try {
  fs.mkdirSync(codexHome); fs.mkdirSync(claudeHome);
  test('states: absent, unreadable, invalid UTF-8 or JSON and oversize stay distinct through bounded reads', () => {
    write(null, null);
    let report = prefs.inspectPresentationPrefs(options);
    assert.strictEqual(report.codex.state, 'absent'); assert.strictEqual(report.claude.state, 'absent');
    fs.mkdirSync(config); fs.mkdirSync(settings);
    report = prefs.inspectPresentationPrefs(options);
    assert.strictEqual(report.codex.state, 'unreadable'); assert.strictEqual(report.claude.state, 'unreadable');
    write(Buffer.from([0xff]), '{broken SECRET-parser-value');
    report = prefs.inspectPresentationPrefs(options);
    assert.strictEqual(report.codex.state, 'invalid'); assert.strictEqual(report.claude.state, 'invalid');
    assert(!JSON.stringify(report).includes('SECRET'));
    write('x'.repeat(1024 * 1024 + 1), 'x'.repeat(1024 * 1024 + 1));
    report = prefs.inspectPresentationPrefs(options);
    assert.strictEqual(report.codex.state, 'oversize'); assert.strictEqual(report.claude.state, 'oversize');
    const open = fs.openSync;
    try {
      fs.openSync = () => { throw new Error('SECRET filesystem path'); };
      assert.strictEqual(prefs.inspectPresentationPrefs(options).codex.state, 'unreadable');
    } finally { fs.openSync = open; }
    assert(!JSON.stringify(report).includes(root));
  });
  test('values: typed closed vocabularies remain public, valid custom strings redact and invalid types remain invalid', () => {
    write('personality = "pragmatic"\nmodel_verbosity = "low"\n[tui]\nstatus_line = ["context-used"]', { outputStyle: 'Explanatory', statusLine: { type: 'command', command: 'node forge-statusline.js' } });
    let report = prefs.inspectPresentationPrefs(options);
    assert.deepStrictEqual(report.codex.personality, { state: 'present', value: 'pragmatic' });
    assert.deepStrictEqual(report.codex.model_verbosity, { state: 'present', value: 'low' });
    assert.deepStrictEqual(report.claude.outputStyle, { state: 'present', value: 'Explanatory' });
    assert.deepStrictEqual(report.claude.statusLine, { state: 'present', owner: 'forge' });
    for (const hostile of ['SECRET-token', 'C:/Users/SECRET/name', 'echo SECRET', '\u001b]0;SECRET\u0007', 'line\nSECRET', 'x'.repeat(300)]) {
      write(`personality = ${JSON.stringify(hostile)}\nmodel_verbosity = ${JSON.stringify(hostile)}\ntui.status_line = ${JSON.stringify([hostile, 'usage-limit'])}`, { outputStyle: hostile, statusLine: { type: 'command', command: hostile } });
      report = prefs.inspectPresentationPrefs(options);
      for (const item of [report.codex.personality, report.codex.model_verbosity, report.claude.outputStyle]) {
        assert.strictEqual(item.state, 'present'); assert.strictEqual(item.redacted, true);
      }
      assert.deepStrictEqual(report.codex.status_line.items, ['[redigido]', 'usage-limit']);
      assert.strictEqual(report.claude.statusLine.owner, 'user');
      const output = JSON.stringify(report);
      for (const unsafe of ['SECRET', 'C:/Users', 'echo ', '\\u001b', '\\u0007', root]) assert(!output.includes(unsafe));
    }
    for (const value of ['false', '[]', '{}', '42']) {
      write(`personality = ${value}\nmodel_verbosity = ${value}\ntui.status_line = ${value}`, { outputStyle: JSON.parse(value), statusLine: JSON.parse(value) });
      report = prefs.inspectPresentationPrefs(options);
      assert.strictEqual(report.codex.personality.state, 'invalid');
      assert.strictEqual(report.codex.model_verbosity.state, 'invalid');
      assert.strictEqual(report.claude.outputStyle.state, 'invalid');
      assert.strictEqual(report.claude.statusLine.state, 'invalid');
    }
    write(`personality = "${'x'.repeat(4097)}"`, { outputStyle: 'x'.repeat(4097) });
    report = prefs.inspectPresentationPrefs(options);
    assert.strictEqual(report.codex.personality.state, 'invalid'); assert.strictEqual(report.claude.outputStyle.state, 'invalid');
    for (const value of [null, [], { command: ['SECRET'] }, { type: 'command', command: 42 }, { type: 'command', command: 'x'.repeat(8193) }]) {
      write('', { statusLine: value });
      assert.strictEqual(prefs.inspectPresentationPrefs(options).claude.statusLine.state, 'invalid');
    }
    for (const toml of ['personality.private = "SECRET"', '[personality]\nprivate = "SECRET"', 'model_verbosity.private = "SECRET"', '[model_verbosity]\nprivate = "SECRET"']) {
      write(toml, {});
      const key = toml.includes('personality') ? 'personality' : 'model_verbosity';
      assert.strictEqual(prefs.inspectPresentationPrefs(options).codex[key].state, 'invalid');
    }
  });
  test('selection: explicit limits, absent and manual-merge produce only the safe optional pt-BR suggestion', () => {
    for (const selection of ['', 'tui.status_line = ["usage-limit", "secondary-usage-limit"]', 'tui.status_line = ["context-used"]', '[tui]\n[tui]\n']) {
      write(selection, {});
      const report = prefs.inspectPresentationPrefs(options);
      const expected = selection.includes('context-used');
      assert.strictEqual(report.suggestions.length, expected ? 1 : 0);
      if (expected) {
        assert.strictEqual(report.suggestions[0].id, 'codex-status-line-limits');
        assert.strictEqual(report.suggestions[0].applied, false);
        assert.match(report.suggestions[0].text, /\/statusline/); assert.match(report.suggestions[0].text, /[Nn]ada foi alterado/);
      }
      if (selection.includes('[tui]')) assert.strictEqual(report.codex.status_line.selection, 'manual-merge');
      assert.strictEqual(report.codex.source, '<codex-home>/config.toml');
      assert.strictEqual(report.claude.source, '<claude-home>/settings.json');
      assert.strictEqual(report.writes, 0);
    }
    write('tui.status_line = [["SECRET"]]', {});
    assert.strictEqual(prefs.inspectPresentationPrefs(options).codex.status_line.state, 'invalid');
  });
  test('privacy: unrelated tokens providers MCP commands and parser or filesystem messages never enter JSON or text', () => {
    write('personality = "friendly"\nmodel_verbosity = "high"\ntoken = "SECRET"\n[model_providers.private]\napi_key = "SECRET"\n[mcp_servers.private]\ncommand = "SECRET"', { outputStyle: 'Default', statusLine: { type: 'command', command: 'echo SECRET' }, tokens: 'SECRET', mcpServers: { private: 'SECRET' } });
    const report = prefs.inspectPresentationPrefs(options);
    for (const output of [JSON.stringify(report), prefs.render(report)]) {
      for (const unsafe of ['SECRET', root, 'api_key', 'mcpServers', 'model_providers', 'echo ']) assert(!output.includes(unsafe));
    }
  });
  test('preservation: inspection and both real renderers preserve diagnosis, explicit config lines, settings bytes and mtimes in temporary homes', () => {
    const operator = 'personality = "pragmatic"\r\nmodel_verbosity = "low"\r\n[tui]\r\nstatus_line = ["context-used"]\r\n';
    write(operator, '{\n "outputStyle": "Learning", "statusLine": {"type":"command", "command":"echo operator"}\n}\n');
    const initialConfig = snapshot(config), initialSettings = snapshot(settings);
    const before = prefs.inspectPresentationPrefs(options);
    assert.deepStrictEqual(snapshot(config), initialConfig); assert.deepStrictEqual(snapshot(settings), initialSettings);
    const common = { repo: path.resolve(__dirname, '..'), ...options, projectRoot: path.join(root, 'project'), forgeHome: path.join(root, 'forge'), provenance: null };
    const codexRenderer = require('./forge-codex-renderer');
    codexRenderer.write({ ...common, ...codexRenderer.PRODUCTION_DISPATCH_DIALECT, codexQuestionBinary: 'fixture-codex', questionSpawnSync: () => ({ status: 0, stdout: 'default_mode_request_user_input stable false\n' }) });
    require('./forge-claude-renderer').write(common);
    assert.deepStrictEqual(prefs.inspectPresentationPrefs(options), before);
    const finalConfig = fs.readFileSync(config, 'utf8');
    for (const line of operator.trimEnd().split('\r\n')) assert(finalConfig.split('\r\n').includes(line));
    assert.deepStrictEqual(snapshot(settings), initialSettings);
    const afterRender = snapshot(config);
    prefs.inspectPresentationPrefs(options);
    assert.deepStrictEqual(snapshot(config), afterRender); assert.deepStrictEqual(snapshot(settings), initialSettings);
  });
  test('CLI: process.execPath inspects only temporary homes with static safe usage errors and no writes', () => {
    write('personality = "pragmatic"\ntui.status_line = ["context-used"]', { outputStyle: 'Default' });
    const a = snapshot(config), b = snapshot(settings);
    const file = path.join(__dirname, 'forge-presentation-prefs.js');
    const args = [file, '--codex-home', codexHome, '--claude-home', claudeHome];
    const result = spawnSync(process.execPath, [...args, '--json'], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(JSON.parse(result.stdout), prefs.inspectPresentationPrefs(options));
    const text = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.strictEqual(text.status, 0); assert.match(text.stdout, /\/statusline/); assert(!text.stdout.includes(root));
    for (const invalid of [['--SECRET'], ['--codex-home'], ['--claude-home', '--json']]) {
      const bad = spawnSync(process.execPath, [file, ...invalid], { encoding: 'utf8' });
      assert.strictEqual(bad.status, 2); assert(!`${bad.stdout}${bad.stderr}`.includes('SECRET'));
    }
    assert.deepStrictEqual(snapshot(config), a); assert.deepStrictEqual(snapshot(settings), b);
  });
  test('CLI errors: whitespace homes and resolver failures exit2 with only static usage, no paths stack or private values', () => {
    const file = path.join(__dirname, 'forge-presentation-prefs.js');
    const usage = 'Uso: forge-presentation-prefs.js [--json] [--codex-home DIR] [--claude-home DIR]\n';
    const beforeConfig = snapshot(config), beforeSettings = snapshot(settings);
    const env = { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: claudeHome, FORGE_HOME: path.join(root, 'forge') };
    const args = ['--json', '--codex-home', codexHome, '--claude-home', claudeHome];
    for (const flag of ['--codex-home', '--claude-home']) for (const value of [' ', '\t', ' \r\n ']) {
      const invalid = args.slice();
      invalid[invalid.indexOf(flag) + 1] = value;
      const bad = spawnSync(process.execPath, [file, ...invalid], { encoding: 'utf8', env });
      assert.strictEqual(bad.status, 2);
      assert.strictEqual(bad.stdout, '');
      assert.strictEqual(bad.stderr, usage);
    }
    // A child-only preload forces the resolver error path without touching real
    // homes or changing the resolver used by this test process.
    const preload = path.join(root, 'resolver-error.cjs');
    fs.writeFileSync(preload, 'const home = require(' + JSON.stringify(require.resolve('./forge-home'))
      + '); home.resolveForgePaths = () => { throw new Error("PRIVATE-HOME-RESOLUTION-MARKER"); };\n');
    const failed = spawnSync(process.execPath, ['--require', preload, file, ...args], { encoding: 'utf8', env });
    assert.strictEqual(failed.status, 2);
    assert.strictEqual(failed.stdout, '');
    assert.strictEqual(failed.stderr, usage);
    assert(!failed.stderr.includes(root) && !failed.stderr.includes('PRIVATE-HOME-RESOLUTION-MARKER'));
    assert.deepStrictEqual(snapshot(config), beforeConfig);
    assert.deepStrictEqual(snapshot(settings), beforeSettings);
  });
} finally { fs.rmSync(root, { recursive: true, force: true }); }
