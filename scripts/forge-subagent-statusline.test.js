#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const line = require('./forge-subagent-statusline');
const { AGENT_ROLES } = require('./forge-agent-view');
const { plainText } = require('./forge-sidecar-identity');
const { resolveUserHome, resolveForgeHome } = require('./forge-home');
const check = (name, action) => { action(); console.log(`PASS S03/T05 ${name}`); };
const temp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'forge-subagent-'));
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['HOME', 'USERPROFILE', 'FORGE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PATH'].includes(key.toUpperCase())));
const env = { ...inherited, HOME: temp, USERPROFILE: temp, FORGE_HOME: path.join(temp, '.forge-agent'),
  CODEX_HOME: path.join(temp, '.codex'), CLAUDE_CONFIG_DIR: path.join(temp, '.claude'), PATH: path.dirname(process.execPath) };
const cli = path.join(__dirname, 'forge-subagent-statusline.js');
const options = { env, claudeVersion: '2.1.312' };
const command = line.commandFor(options);
const own = { type: 'command', command };
const now = Date.parse('2026-10-30T12:00:00Z');
const task = { id: 'task-opaque-1', agentType: 'forge-executor', status: 'running', label: 'Conferir entrega',
  model: 'claude-sonnet-5', effort: 'high', startTime: now - 65000 };
function seed(text) {
  const directory = fs.mkdtempSync(path.join(temp, 'settings-'));
  const file = path.join(directory, 'settings.json');
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
  return file;
}
function snapshot(file) { return { bytes: fs.readFileSync(file), mtime: fs.statSync(file).mtimeMs }; }
function cliRun(args = [], input = '') {
  const result = spawnSync(process.execPath, [cli, ...args], { env, input, encoding: 'utf8', timeout: 10000, maxBuffer: 128 * 1024 });
  assert.ifError(result.error); assert.strictEqual(result.status, 0, result.stderr); return result;
}
try {
  check('exports and lazy module load read only JavaScript modules', () => {
    for (const name of ['formatRows', 'planSetup', 'setup', 'remove', 'commandFor', 'observeClaudeVersion']) assert.strictEqual(typeof line[name], 'function');
    const probe = `const fs=require('fs');const read=fs.readFileSync;fs.readFileSync=function(p,...a){if(typeof p!=='string'||!p.endsWith('.js'))throw Error('non-module read');return read.call(this,p,...a)};for(const k of ['openSync','statSync','lstatSync','readdirSync','writeFileSync','appendFileSync'])fs[k]=()=>{throw Error('unexpected I/O')};require(${JSON.stringify(cli)});`;
    const loaded = spawnSync(process.execPath, ['-e', probe], { env, encoding: 'utf8', timeout: 10000 });
    assert.strictEqual(loaded.status, 0, loaded.stderr);
    const source = fs.readFileSync(cli, 'utf8');
    for (const dependency of ['forge-capabilities', 'forge-host-baseline', 'forge-autonomy-sources']) {
      assert(source.indexOf(`require('./${dependency}')`) > source.indexOf('function '));
    }
  });
  check('pure rows role status resolved model configured effort elapsed and shared sanitizer', () => {
    const input = { tasks: [task] }, before = JSON.stringify(input);
    const rows = line.formatRows(input, { now });
    assert.deepStrictEqual(rows, line.formatRows(input, { now })); assert.strictEqual(JSON.stringify(input), before);
    assert.deepStrictEqual(Object.keys(rows[0]), ['id', 'content']); assert.strictEqual(rows[0].id, task.id);
    for (const expected of [AGENT_ROLES[task.agentType].label, 'executor nativo Claude', 'em execução', task.label,
      'modelo resolvido claude-sonnet-5', 'esforço configurado high', '1m 5s']) assert(rows[0].content.includes(expected), expected);
    for (const [status, label] of [['completed', 'concluído'], ['failed', 'falhou'], ['killed', 'interrompido'], ['alien', 'desconhecido']]) {
      assert(line.formatRows({ tasks: [{ ...task, status }] }, { now })[0].content.includes(label));
    }
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 5, -1]) {
      assert(line.formatRows({ tasks: [{ ...task, effort }] }, { now })[0].content.includes(`esforço configurado ${effort}`));
    }
    for (const effort of ['ultra', {}, 1.5]) assert(!line.formatRows({ tasks: [{ ...task, effort }] }, { now })[0].content.includes('esforço configurado'));
    const hostile = '\x1b[31mConferir\x1b[0m\x1b]8;;https://secret\x07 entrega\x1b]8;;\x07\u202e\u2028fim';
    const safe = line.formatRows({ tasks: [{ ...task, label: hostile, cwd: 'C:\\SECRET', transcript: 'SECRET', tool_name: 'SECRET' }] }, { now })[0].content;
    assert(safe.includes(plainText(hostile, { limit: 80 }))); assert(!/SECRET|\x1b|\u202e|https:/.test(safe));
    for (const model of ['C:\\SECRET', 'model with spaces', '\x1b[31mmodel']) assert(!line.formatRows({ tasks: [{ ...task, model }] }, { now })[0].content.includes('modelo resolvido'));
    for (const label of ['C:\\SECRET\\file', '/tmp/SECRET', 'https://SECRET', `${task.id} SECRET`, 'Bash SECRET']) {
      assert(!line.formatRows({ tasks: [{ ...task, label }] }, { now })[0].content.includes('SECRET'));
    }
    for (const columns of [1, 10, 64, 240, 500]) {
      const content = line.formatRows({ tasks: [{ ...task, label: 'x'.repeat(1000) }], columns }, { now })[0].content;
      assert(content.length > 0); assert(Array.from(content).length <= Math.min(columns, 240));
      assert.strictEqual(content, plainText(content, { limit: 240 }));
      assert(!content.includes(task.id));
    }
  });
  check('Forge scope invalid IDs 64-row bound and never-empty fallback', () => {
    const invalid = [{ ...task, agentType: undefined }, { ...task, agentType: 'third-party' }, { ...task, agentType: '__proto__' },
      ...['', 1, 'a'.repeat(129), 'a\n', 'a\x1b', 'a\u202e'].map(id => ({ ...task, id }))];
    assert.deepStrictEqual(line.formatRows({ tasks: invalid }, { now }), []);
    assert.strictEqual(line.formatRows({ tasks: Array.from({ length: 100 }, (_, i) => ({ ...task, id: `agent-${i}` })) }, { now }).length, 64);
    const row = line.formatRows({ tasks: [{ id: 'task-opaque', agentType: 'forge-reviewer', label: '\x1b]8;;SECRET', description: '\u202e', status: 'running' }] }, { now })[0];
    assert(row.content.includes(AGENT_ROLES['forge-reviewer'].label)); assert(row.content.includes('em execução')); assert(row.content.length);
    assert.deepStrictEqual(line.formatRows({ tasks: null }), []);
  });
  check('stdin JSON lines one-MiB input total-output bound and silent invalid JSON', () => {
    assert.strictEqual(cliRun([], '{').stdout, '');
    assert.strictEqual(cliRun([], ' '.repeat(1024 * 1024 + 1)).stdout, '');
    const data = JSON.stringify({ tasks: [task, { ...task, agentType: 'foreign' }] });
    const rows = cliRun([], data).stdout.trim().split('\n').map(JSON.parse);
    assert.strictEqual(rows.length, 1); assert.strictEqual(rows[0].id, task.id); assert(rows[0].content);
    const output = cliRun([], JSON.stringify({ tasks: Array.from({ length: 500 }, (_, i) => ({ ...task, id: `task-${i}`, label: 'x'.repeat(400) })) })).stdout;
    assert(output.length > 0); assert(Buffer.byteLength(output) <= 128 * 1024); assert.strictEqual(output.trim().split('\n').length, 64);
    assert.strictEqual(cliRun([], JSON.stringify({ tasks: [] }) + ' '.repeat(1024 * 1024 - JSON.stringify({ tasks: [] }).length)).stdout, '');
  });
  check('terminal fake PATH version current older prerelease garbage exit timeout bounded without shell option', () => {
    const bin = path.join(temp, 'bin'); fs.mkdirSync(bin);
    const fake = path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    const fakeEnv = { ...env, PATH: bin };
    const cases = [['2.1.293', 'supported'], ['2.1.312', 'supported'], ['2.1.292', 'version-unsupported'],
      ['2.1.293-beta.1', 'version-unsupported'], ['garbage', 'version-unknown']];
    const script = (text, exit = 0, loop = false) => process.platform === 'win32'
      ? `@echo off\r\nif not "%~1"=="--version" exit /b 2\r\n${loop ? ':again\r\ngoto again' : `echo ${text}\r\nexit /b ${exit}`}\r\n`
      : `#!/bin/sh\n[ "$1" = --version ] || exit 2\n${loop ? 'while :; do :; done' : `printf '%s\\n' '${text}'\nexit ${exit}`}\n`;
    for (const [version, expected] of cases) {
      fs.writeFileSync(fake, script(version)); fs.chmodSync(fake, 0o755);
      const result = line.observeClaudeVersion({ env: fakeEnv, timeout: 5000, extensionVersion: '9.9.9' });
      assert.strictEqual(result.reason_code, expected, JSON.stringify(result)); assert.strictEqual(result.source, 'terminal-cli --version');
      if (version !== 'garbage') assert.strictEqual(result.version, version);
    }
    fs.writeFileSync(fake, script('2.1.312', 1)); assert.strictEqual(line.observeClaudeVersion({ env: fakeEnv }).reason_code, 'version-unknown');
    fs.writeFileSync(fake, script('', 0, true)); assert.strictEqual(line.observeClaudeVersion({ env: fakeEnv, timeout: 100 }).reason_code, 'version-unknown');
    assert.strictEqual(line.observeClaudeVersion({ env: { ...env, PATH: path.join(temp, 'absent') }, extensionVersion: '9.9.9' }).reason_code, 'version-unknown');
    fs.writeFileSync(fake, script('2.1.312')); assert.strictEqual(JSON.parse(spawnSync(process.execPath, [cli, '--observe'], { env: fakeEnv, encoding: 'utf8', timeout: 10000 }).stdout).version, '2.1.312');
    const capabilities = require('./forge-capabilities'), original = capabilities.invoke;
    capabilities.invoke = (executable, args, opts) => { assert.strictEqual(executable, path.resolve(fake)); assert.deepStrictEqual(args, ['--version']); assert(opts.timeout > 0); return { status: 0, stdout: 'x'.repeat(5000), stderr: '', error: null }; };
    try { assert.strictEqual(line.observeClaudeVersion({ env: fakeEnv }).reason_code, 'version-unknown'); } finally { capabilities.invoke = original; }
    const capabilitiesSource = fs.readFileSync(path.join(__dirname, 'forge-capabilities.js'), 'utf8');
    assert(capabilitiesSource.includes('shell: false')); // The real bounded adapter exercised above owns spawn policy.
  });
  check('setup refusals versions gates ownership invalid oversize and CLI explicit evidence', () => {
    for (const [settings, extra, reason] of [[{}, { claudeVersion: undefined }, 'version-unknown'], [{}, { claudeVersion: 'bad' }, 'version-unknown'],
      [{}, { claudeVersion: '2.1.292' }, 'version-unsupported'], [{}, { claudeVersion: '2.1.293-beta.1' }, 'version-unsupported'],
      [{ disableAllHooks: true }, {}, 'gated'], [{ allowManagedHooksOnly: true }, {}, 'gated'],
      [{ subagentStatusLine: { type: 'command', command: 'echo operator' } }, {}, 'operator-owned'], [[], {}, 'settings-invalid'], ['{', {}, 'settings-invalid'],
      [' '.repeat(1024 * 1024 + 1), {}, 'settings-oversize']]) {
      const file = seed(settings), before = snapshot(file), result = line.setup(file, { ...options, ...extra });
      assert.strictEqual(result.reason_code, reason); assert.deepStrictEqual(snapshot(file), before); assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['settings.json']);
    }
    const file = seed('{}'); const before = snapshot(file);
    assert.strictEqual(JSON.parse(cliRun(['--setup', file]).stdout).reason_code, 'version-unknown'); assert.deepStrictEqual(snapshot(file), before);
    const result = JSON.parse(cliRun(['--setup', file, '--claude-version', '2.1.312']).stdout);
    assert.strictEqual(result.reason_code, 'added'); assert(result.reserialized); assert.strictEqual(result.availability, 'conditional');
    const nearLimit = seed(JSON.stringify({ x: 'x'.repeat(1024 * 1024 - 16) })), nearBefore = snapshot(nearLimit);
    assert.strictEqual(line.setup(nearLimit, options).reason_code, 'settings-oversize');
    assert.deepStrictEqual(snapshot(nearLimit), nearBefore); assert.deepStrictEqual(fs.readdirSync(path.dirname(nearLimit)), ['settings.json']);
  });
  check('setup exclusive original backup semantic equality reserialization atomic rename and current byte-mtime noop', () => {
    const original = '{ "disableAllHooks": false, "allowManagedHooksOnly": false, "theme":"operator", "nested":{"a":[1,true,null]} }\r\n';
    const file = seed(original), calls = [];
    const io = Object.create(fs);
    io.writeFileSync = (target, bytes, opts) => { calls.push(['write', target, opts?.flag]); return fs.writeFileSync(target, bytes, opts); };
    io.renameSync = (from, to) => { calls.push(['rename', from, to]); assert.strictEqual(path.dirname(from), path.dirname(to)); assert(fs.existsSync(calls[0][1])); return fs.renameSync(from, to); };
    const result = line.setup(file, { ...options, fs: io });
    assert.strictEqual(result.reason_code, 'added'); assert.strictEqual(result.reserialized, true); assert.strictEqual(result.semantic_equal, true);
    assert.strictEqual(calls[0][0], 'write'); assert.strictEqual(calls[0][2], 'wx'); assert.notStrictEqual(calls[0][1], file);
    assert.strictEqual(fs.readFileSync(result.backup, 'utf8'), original);
    const candidate = { ...JSON.parse(original), subagentStatusLine: own };
    assert.strictEqual(fs.readFileSync(file, 'utf8'), JSON.stringify(candidate, null, 2) + '\n');
    const before = snapshot(file), names = fs.readdirSync(path.dirname(file));
    assert.strictEqual(line.setup(file, options).reason_code, 'current-noop'); assert.deepStrictEqual(snapshot(file), before); assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), names);
    assert.deepStrictEqual(line.planSetup(JSON.parse(original), { claudeVersion: options.claudeVersion, command }).settings, candidate);
    console.log('EXAMPLE S03/T05 setup: added; backup exact; reserialized true; availability conditional; renderização não validada');
  });
  check('CAS changed and post-rename raced preserve concurrent writer and original backup', () => {
    for (const stage of ['cas', 'post']) {
      const file = seed('{}'), io = Object.create(fs), concurrent = '{"operator":"concurrent"}\n';
      if (stage === 'cas') io.writeFileSync = (target, bytes, opts) => { fs.writeFileSync(target, bytes, opts); if (typeof target === 'string' && target !== file && !target.endsWith('.tmp')) fs.writeFileSync(file, concurrent); };
      else io.linkSync = (from, to) => { fs.linkSync(from, to); if (to === file && String(from).endsWith('.tmp')) fs.writeFileSync(to, concurrent); };
      const result = line.setup(file, { ...options, fs: io });
      assert.strictEqual(result.reason_code, stage === 'cas' ? 'settings-changed' : 'settings-raced');
      assert.strictEqual(fs.readFileSync(file, 'utf8'), concurrent); assert.strictEqual(fs.readFileSync(result.backup, 'utf8'), '{}');
      assert(!fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')));
    }
  });
  check('R6 every boundary preserves operator bytes for setup and removal', () => {
    for (const remove of [false, true]) for (const stage of ['before-backup', 'after-temporary', 'before-retire-inplace', 'before-retire-rename', 'after-retire', 'after-place-retired', 'before-final']) {
      const original = JSON.stringify(remove ? { subagentStatusLine: own, theme: 'initial' } : { theme: 'initial' });
      const file = seed(original), io = Object.create(fs), concurrent = '{"operator":"concurrent"}\n';
      let retired, placed = false, injected = false;
      const edit = () => { injected = true; fs.writeFileSync(file, concurrent); };
      io.writeFileSync = (target, bytes, opts) => {
        if (stage === 'before-backup' && String(target).endsWith('.bak') && !injected) edit();
        fs.writeFileSync(target, bytes, opts);
        if (stage === 'after-temporary' && typeof target === 'number' && !injected) edit();
      };
      io.renameSync = (from, to) => {
        if (from === file) {
          if (stage === 'before-retire-inplace') edit();
          if (stage === 'before-retire-rename') { const operator = file + '.operator'; fs.writeFileSync(operator, concurrent); fs.renameSync(operator, file); injected = true; }
          fs.renameSync(from, to); retired = to;
          if (stage === 'after-retire') edit();
        } else fs.renameSync(from, to);
      };
      io.linkSync = (from, to) => {
        fs.linkSync(from, to);
        if (to === file && String(from).endsWith('.tmp')) {
          placed = true;
          if (stage === 'after-place-retired') { fs.writeFileSync(retired, concurrent); injected = true; }
          if (stage === 'before-final') edit();
        }
      };
      const result = (remove ? line.remove : line.setup)(file, { ...options, fs: io });
      const expected = ['before-backup', 'after-temporary'].includes(stage) ? 'settings-changed' : stage === 'before-final' ? 'settings-raced' : 'settings-conflict';
      assert(injected, stage); assert.strictEqual(result.reason_code, expected, stage); assert.strictEqual(result.changed, false, stage);
      assert.strictEqual(fs.readFileSync(result.backup, 'utf8'), original, stage);
      if (stage === 'after-place-retired') { assert(placed); assert.strictEqual(fs.readFileSync(result.retired, 'utf8'), concurrent); assert.notStrictEqual(fs.readFileSync(file, 'utf8'), concurrent); }
      else assert.strictEqual(fs.readFileSync(file, 'utf8'), concurrent, stage);
      if (retired) { assert.strictEqual(result.retired, retired); assert(fs.existsSync(retired)); assert(/reconcilia/i.test(result.message), result.message); }
      assert(!fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')));
    }
  });
  check('R6 unsupported atomic publication refuses before retirement and cannot lose a mid-copy edit', () => {
    for (const remove of [false, true]) for (const code of ['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS']) for (const conflict of [false, true]) {
      const original = JSON.stringify(remove ? { subagentStatusLine: own, theme: 'initial' } : { theme: 'initial' });
      const file = seed(original), before = snapshot(file), io = Object.create(fs), concurrent = '{"operator":"copy-race"}'; let copies = 0, retirements = 0;
      io.linkSync = () => { throw Object.assign(new Error('unsupported'), { code }); };
      io.renameSync = (from, to) => { if (from === file) retirements++; return fs.renameSync(from, to); };
      io.copyFileSync = (from, to, flags) => {
        copies++; assert.strictEqual(flags, fs.constants.COPYFILE_EXCL);
        // Model exclusive creation followed by separate content transfer. An
        // editor can write between those two stages even with COPYFILE_EXCL.
        fs.writeFileSync(to, '', { flag: 'wx' });
        if (conflict) fs.writeFileSync(to, concurrent);
        return fs.copyFileSync(from, to);
      };
      const result = (remove ? line.remove : line.setup)(file, { ...options, fs: io });
      assert.strictEqual(copies, 0, 'a non-atomic live-path copy can lose an intervening edit');
      assert.strictEqual(retirements, 0); assert.strictEqual(result.changed, false); assert.strictEqual(result.reason_code, 'settings-write-failed');
      assert.strictEqual(result.publication_capability, 'unavailable'); assert.deepStrictEqual(snapshot(file), before);
      assert.strictEqual(fs.readFileSync(result.backup, 'utf8'), original);
    }
  });
  check('R6 failed placement restores exclusively and keeps retired original inode', () => {
    for (const occupied of [false, true]) for (const code of ['EACCES', 'EPERM', 'ENOTSUP']) {
      const file = seed('{}'), io = Object.create(fs), concurrent = '{"operator":"placement"}'; let first = true;
      io.linkSync = (from, to) => { if (to === file && first) { first = false; if (occupied) fs.writeFileSync(file, concurrent); throw Object.assign(new Error('placement'), { code }); } return fs.linkSync(from, to); };
      const result = line.setup(file, { ...options, fs: io });
      assert.strictEqual(result.reason_code, occupied ? 'settings-conflict' : 'settings-write-failed'); assert.strictEqual(result.changed, false);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), occupied ? concurrent : '{}'); assert.strictEqual(fs.readFileSync(result.retired, 'utf8'), '{}');
    }
  });
  check('R6 unrelated private-probe errors preserve settings without claiming unsupported capability', () => {
    for (const code of ['EACCES', 'EIO', 'ENOSPC', 'EEXIST', undefined]) {
      const file = seed('{"operator":"preserved"}'), before = snapshot(file), io = Object.create(fs);
      io.linkSync = () => { throw Object.assign(new Error('private failure detail'), { code }); };
      const result = line.setup(file, { ...options, fs: io });
      assert.strictEqual(result.changed, false); assert.strictEqual(result.reason_code, 'settings-write-failed');
      assert.strictEqual(result.publication_capability, 'unknown'); assert.deepStrictEqual(snapshot(file), before);
      assert(!JSON.stringify(result).includes('private failure detail'));
    }
  });
  check('R6 retained original descriptor remains recoverable after last reread and return', () => {
    for (const afterReturn of [false, true]) for (const remove of [false, true]) {
      const original = JSON.stringify(remove ? { subagentStatusLine: own, theme: 'initial' } : { theme: 'initial' });
      const file = seed(original), descriptor = fs.openSync(file, 'r+'), io = Object.create(fs), late = '{"operator":"late-descriptor-write"}';
      let retired, reads = 0; const descriptors = new Map();
      const writeLate = () => { fs.ftruncateSync(descriptor, 0); fs.writeSync(descriptor, late, 0, 'utf8'); };
      io.renameSync = (from, to) => { fs.renameSync(from, to); if (from === file) retired = to; };
      io.openSync = (target, ...args) => { const fd = fs.openSync(target, ...args); if (target === retired) descriptors.set(fd, ++reads); return fd; };
      io.closeSync = fd => { fs.closeSync(fd); if (!afterReturn && descriptors.get(fd) === 2) { descriptors.delete(fd); writeLate(); } };
      try {
        const result = (remove ? line.remove : line.setup)(file, { ...options, fs: io });
        assert.strictEqual(result.changed, true); assert.strictEqual(result.retired, retired); if (afterReturn) writeLate();
        assert.strictEqual(fs.readFileSync(result.retired, 'utf8'), late); assert.strictEqual(fs.statSync(result.retired).ino, fs.fstatSync(descriptor).ino);
        const live = JSON.parse(fs.readFileSync(file, 'utf8')); assert.strictEqual(live.theme, 'initial'); assert.strictEqual(Object.hasOwn(live, 'subagentStatusLine'), !remove);
        assert.strictEqual(fs.readFileSync(result.backup, 'utf8'), original);
      } finally { fs.closeSync(descriptor); }
    }
  });
  check('rename EPERM EBUSY EACCES keep original backup remove own temporary and expose unknown external gates', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const file = seed('{}'), before = snapshot(file), io = Object.create(fs);
      io.renameSync = () => { throw Object.assign(new Error('fixture'), { code }); };
      const result = line.setup(file, { ...options, fs: io });
      assert.strictEqual(result.reason_code, 'settings-write-failed'); assert.deepStrictEqual(snapshot(file), before);
      assert.strictEqual(fs.readFileSync(result.backup, 'utf8'), '{}'); assert(!fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')));
      assert.deepStrictEqual(result.external_gates, { workspace_trust: 'unknown', managed_policy: 'unknown', project_settings: 'unknown' });
      assert.strictEqual(result.availability, 'conditional'); assert.strictEqual(result.rendering, 'unknown');
    }
    const file = seed('{}'), before = snapshot(file), io = Object.create(fs);
    io.writeFileSync = (target, bytes, opts) => {
      if (typeof target === 'number') { fs.writeSync(target, bytes.subarray(0, 1)); throw new Error('partial temporary write'); }
      return fs.writeFileSync(target, bytes, opts);
    };
    const result = line.setup(file, { ...options, fs: io });
    assert.strictEqual(result.reason_code, 'settings-write-failed'); assert.deepStrictEqual(snapshot(file), before);
    assert.strictEqual(fs.readFileSync(result.backup, 'utf8'), '{}'); assert(!fs.readdirSync(path.dirname(file)).some(name => name.endsWith('.tmp')));
  });
  check('remove only Forge value same safeguards absent and operator byte-mtime noop', () => {
    const file = seed({ subagentStatusLine: own, theme: 'operator' }); const original = fs.readFileSync(file);
    const removed = line.remove(file, options); assert.strictEqual(removed.reason_code, 'removed'); assert.strictEqual(removed.reserialized, true);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file)), { theme: 'operator' }); assert.deepStrictEqual(fs.readFileSync(removed.backup), original);
    for (const settings of [{}, { subagentStatusLine: { type: 'command', command: 'echo operator' } }]) {
      const other = seed(settings), before = snapshot(other); assert.strictEqual(line.remove(other, options).reason_code, 'absent-noop'); assert.deepStrictEqual(snapshot(other), before);
    }
    const gated = seed({ subagentStatusLine: own, disableAllHooks: true }), before = snapshot(gated);
    assert.strictEqual(line.remove(gated, options).reason_code, 'gated'); assert.deepStrictEqual(snapshot(gated), before);
    const failed = seed({ subagentStatusLine: own }), io = Object.create(fs);
    io.renameSync = () => { throw Object.assign(new Error('fixture'), { code: 'EPERM' }); };
    assert.strictEqual(line.remove(failed, { ...options, fs: io }).reason_code, 'settings-write-failed'); assert.deepStrictEqual(JSON.parse(fs.readFileSync(failed)), { subagentStatusLine: own });
  });
  check('command home resolver merge-settings parity managed-core distribution', () => {
    assert.strictEqual(resolveUserHome({ env }), temp); assert.strictEqual(resolveForgeHome({ env }), path.join(temp, '.forge-agent'));
    for (const forgeHome of [path.join(temp, '.forge-agent'), path.join(temp, 'relocated forge')]) {
      const fixtureEnv = { ...env, FORGE_HOME: forgeHome }, file = seed('{}');
      const merged = spawnSync(process.execPath, [path.join(__dirname, 'merge-settings.js'), file], { env: fixtureEnv, encoding: 'utf8', timeout: 10000 });
      assert.strictEqual(merged.status, 0, merged.stderr);
      const mainCommand = JSON.parse(fs.readFileSync(file)).statusLine.command;
      assert.strictEqual(line.commandFor({ env: fixtureEnv }), mainCommand.replace('forge-statusline.js', 'forge-subagent-statusline.js'));
      assert(!line.commandFor({ env: fixtureEnv }).includes('\\'));
    }
    assert.strictEqual(line.commandFor({ env }), 'node ~/.forge-agent/scripts/forge-subagent-statusline.js');
    assert(fs.existsSync(cli)); assert(require('./forge-installer').MANAGED_CORE.includes('scripts'));
    const mergeSource = fs.readFileSync(path.join(__dirname, 'merge-settings.js'), 'utf8'); assert(!mergeSource.includes('node ~/.forge-agent/scripts/forge-subagent-statusline.js'));
  });
  check('Claude renderer temporary home settings bytes mtime and optional setting unchanged', () => {
    const claude = path.join(temp, 'renderer-claude'), forge = path.join(temp, 'renderer-forge'), project = path.join(temp, 'renderer-project');
    fs.mkdirSync(claude); fs.mkdirSync(project); const file = path.join(claude, 'settings.json');
    fs.writeFileSync(file, '{ "outputStyle":"Learning", "statusLine":{"command":"echo operator"} }\r\n');
    const before = snapshot(file);
    require('./forge-claude-renderer').write({ repo: path.resolve(__dirname, '..'), projectRoot: project, forgeHome: forge, claudeHome: claude, provenance: null });
    assert.deepStrictEqual(snapshot(file), before); assert(!Object.hasOwn(JSON.parse(fs.readFileSync(file)), 'subagentStatusLine'));
  });
  check('review R2 R7 exact managed ownership preserves operator command bytes', () => {
    const options = { env, claudeVersion: '2.1.312' };
    const managed = line.commandFor(options);
    for (const command of ['echo forge-subagent-statusline.js; node company-rows.js',
      'node /operator/tools/custom-forge-subagent-statusline.js --custom',
      `${managed} --extra`, `${managed}; echo operator`, 'python ~/.forge-agent/scripts/forge-subagent-statusline.js',
      'node "/other/scripts/forge-subagent-statusline.js"']) {
      const file = seed(JSON.stringify({ subagentStatusLine: { type: 'command', command }, operator: 'preserve' }));
      const before = snapshot(file);
      assert.strictEqual(line.setup(file, options).reason_code, 'operator-owned');
      assert.strictEqual(line.remove(file, options).reason_code, 'absent-noop');
      assert.deepStrictEqual(snapshot(file), before);
      const result = spawnSync(process.execPath, [path.join(__dirname, 'merge-settings.js'), file, '--remove'], { env, encoding: 'utf8', timeout: 10000 });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(JSON.parse(fs.readFileSync(file)).subagentStatusLine.command, command);
    }
    for (const forgeHome of [path.join(temp, '.forge-agent'), path.join(temp, 'relocated forge')]) {
      const opts = { ...options, env: { ...env, FORGE_HOME: forgeHome } };
      const command = line.commandFor(opts), file = seed(JSON.stringify({ subagentStatusLine: { type: 'command', command } }));
      assert(line.isManagedCommand(command, opts));
      assert.strictEqual(line.remove(file, opts).reason_code, 'removed');
      assert(!Object.hasOwn(JSON.parse(fs.readFileSync(file)), 'subagentStatusLine'));
    }
  });
  console.log(`EXAMPLE S03/T05 row: ${line.formatRows({ tasks: [task] }, { now })[0].content}`);
  console.log('EXAMPLE S03/T05 observe fake terminal: 2.1.312; supported; terminal-cli --version');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
