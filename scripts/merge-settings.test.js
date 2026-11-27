#!/usr/bin/env node
'use strict';

// merge-settings.test.js — the statusline points at a copy somebody maintains.
//
// Defect this suite pins: merge-settings.js wired `statusLine.command` to
// `~/.claude/forge-statusline.js`, a render target of NO source in
// forge-source-manifest.json. Nothing refreshed that copy (not `--update`,
// not `--migrate-legacy`), so it froze across releases — and once
// retireLegacyScripts removed `~/.claude/scripts/`, its `__dirname`
// companions (forge-runs.js, forge-accounts.js, forge-prefs.js,
// forge-usage-poll.js) vanished, silently degrading the account badge, the
// runs indicator and the usage poll. The fix points the statusline at the
// Forge home core (`~/.forge-agent/scripts/`), which the installer recopies
// wholesale on every install/update and where the companions exist as
// siblings. Section 106 of forge-smoke.js owns the static agreement between
// merge-settings.js and the maintained surfaces; THIS suite owns the
// behaviour — enable, migrate, remove — through the real CLI.
//
// R1  enable on empty settings wires the maintained path, and that path's
//     repo counterpart exists (the recopied core can only serve files the
//     repo actually has).
// R2  enable over settings carrying the OLD frozen path migrates it — the
//     unconditional assignment is the migration vehicle for existing
//     installs, asserted rather than narrated.
// R3  remove deletes a statusLine written with EITHER vintage of the path
//     (the basename `.includes('forge-statusline.js')` predicate), and does
//     NOT delete a foreign statusLine — the predicate is scoped, proven in
//     both directions.
// R4  enable is idempotent: a second run leaves settings byte-identical and
//     never duplicates hook entries.
// R5  a RELOCATED Forge home (#105) is followed instead of assumed: the tilde
//     form is emitted for the conventional home and only for it, so the fix
//     never absolutizes a settings.json that was portable before.
// R6  --remove still deletes a statusLine written in the relocated (absolute)
//     form — a third vintage of the path, and the basename predicate has to
//     cover it or a relocated operator cannot turn the statusline off.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'merge-settings.js');
const REPO_ROOT = path.resolve(__dirname, '..');
const MAINTAINED_COMMAND = 'node ~/.forge-agent/scripts/forge-statusline.js';
const FROZEN_COMMAND = 'node ~/.claude/forge-statusline.js';

// ── Runner ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

const tmps = [];
function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'merge-settings-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const RUN_HOME = mktmp('merge-settings-private-');

/** Run the real CLI against a settings file; return { status, settings }. */
function run(settingsFile, extraArgs, env) {
  const r = spawnSync(process.execPath, [MODULE, settingsFile, ...(extraArgs || [])],
    { encoding: 'utf8', stdio: 'pipe', windowsHide: true, timeout: 20000, env: { ...process.env, HOME: RUN_HOME, USERPROFILE: RUN_HOME, FORGE_HOME: '', CLAUDE_CONFIG_DIR: path.join(RUN_HOME, '.claude'), ...env } });
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { /* asserted by caller */ }
  return { status: r.status, settings, stderr: r.stderr };
}

function seed(dir, data) {
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return file;
}

// ── R1: enable wires the maintained path ────────────────────────────────────

test('R1: enable wires statusLine at the Forge home core, never the frozen flat path', () => {
  const file = seed(mktmp(), {});
  const { status, settings } = run(file);
  assertEqual(status, 0, 'enable exits 0');
  assert(settings && settings.statusLine, 'statusLine was written');
  assertEqual(settings.statusLine.command, MAINTAINED_COMMAND,
    'statusLine.command points at the installer-maintained copy');
  assert(settings.statusLine.command !== FROZEN_COMMAND,
    'the un-maintained ~/.claude flat path is gone from the enable path');
  assert(!Object.prototype.hasOwnProperty.call(settings.statusLine, 'refreshInterval'),
    'new settings use host event refresh without forcing an additional timer');
});

test('R1: explicit refresh intervals survive enable and a second merge', () => {
  for (const refreshInterval of [1, 5, 60, null]) {
    const file = seed(mktmp(), {
      statusLine: { type: 'command', command: FROZEN_COMMAND, refreshInterval },
    });
    const first = run(file);
    assertEqual(first.status, 0, 'enable succeeds');
    assertEqual(first.settings.statusLine.refreshInterval, refreshInterval,
      'an existing value is preserved without assuming ownership');
    const once = fs.readFileSync(file, 'utf8');
    assertEqual(run(file).status, 0, 'second enable succeeds');
    assertEqual(fs.readFileSync(file, 'utf8'), once, 'preserved interval is idempotent');
  }
});

test('R1: the wired path has a repo counterpart the core recopy can serve', () => {
  // The installer recopies the repo's `scripts/` tree verbatim into
  // `~/.forge-agent/scripts/` (forge-installer.js MANAGED_CORE). A wired path
  // with no repo counterpart would freeze exactly like the old one — so the
  // correspondence is asserted, not assumed.
  // The correspondence is forge-home-relative, not home-relative: `~/.forge-agent`
  // IS the copied core, so the repo counterpart of `~/.forge-agent/scripts/x.js`
  // is `<repo>/scripts/x.js`. Stripping only `node ~/` leaves the `.forge-agent`
  // segment in and looks for it inside the repo, where it never exists.
  const FORGE_HOME_PREFIX = 'node ~/.forge-agent/';
  assert(MAINTAINED_COMMAND.startsWith(FORGE_HOME_PREFIX),
    `wired path left the forge home — this check can no longer derive a repo counterpart: ${MAINTAINED_COMMAND}`);
  const rel = MAINTAINED_COMMAND.slice(FORGE_HOME_PREFIX.length).split('/');
  assert(fs.existsSync(path.join(REPO_ROOT, ...rel)),
    `repo counterpart missing for wired path: ${rel.join('/')}`);
  // Companion floor: the modules the statusline resolves as __dirname
  // siblings must live in the same repo directory, or the recopied core
  // reproduces the post-retireLegacyScripts degradation.
  for (const companion of ['forge-runs.js', 'forge-accounts.js', 'forge-prefs.js', 'forge-usage-poll.js']) {
    assert(fs.existsSync(path.join(REPO_ROOT, 'scripts', companion)),
      `companion module missing next to the statusline in the repo: ${companion}`);
  }
});

// ── R2: existing installs migrate on the next merge ─────────────────────────

test('R2: enable over the OLD frozen path migrates it to the maintained one', () => {
  const file = seed(mktmp(), {
    statusLine: { type: 'command', command: FROZEN_COMMAND, refreshInterval: 1 },
  });
  const { status, settings } = run(file);
  assertEqual(status, 0, 'enable exits 0 over pre-existing settings');
  assertEqual(settings.statusLine.command, MAINTAINED_COMMAND,
    'the unconditional assignment migrates a settings.json written before the fix');
});

// ── R3: remove matches both vintages, and only ours ─────────────────────────

test('R3: remove deletes a statusLine written with the NEW path', () => {
  const file = seed(mktmp(), {
    statusLine: { type: 'command', command: MAINTAINED_COMMAND, refreshInterval: 1 },
  });
  const { status, settings } = run(file, ['--remove']);
  assertEqual(status, 0, 'remove exits 0');
  assert(settings && !('statusLine' in settings), 'statusLine removed (new path vintage)');
});

test('R3: remove deletes a statusLine written with the OLD path (basename match)', () => {
  const file = seed(mktmp(), {
    statusLine: { type: 'command', command: FROZEN_COMMAND, refreshInterval: 1 },
  });
  const { status, settings } = run(file, ['--remove']);
  assertEqual(status, 0, 'remove exits 0');
  assert(settings && !('statusLine' in settings),
    'statusLine removed (old path vintage) — the .includes(basename) predicate covers both');
});

test('R3: remove does NOT delete a foreign statusLine — the predicate is scoped', () => {
  const foreign = { type: 'command', command: 'node ~/my-own-statusline.js', refreshInterval: 5 };
  const file = seed(mktmp(), { statusLine: foreign });
  const { status, settings } = run(file, ['--remove']);
  assertEqual(status, 0, 'remove exits 0 with a foreign statusLine present');
  assert(settings && settings.statusLine
    && settings.statusLine.command === foreign.command,
  'a statusLine that is not ours survives --remove untouched');
});

// ── R4: idempotence ─────────────────────────────────────────────────────────

test('R4: enable twice is byte-identical and never duplicates hook entries', () => {
  const file = seed(mktmp(), {});
  run(file);
  const once = fs.readFileSync(file, 'utf8');
  const { status, settings } = run(file);
  assertEqual(status, 0, 'second enable exits 0');
  assertEqual(fs.readFileSync(file, 'utf8'), once, 'second enable changes nothing');
  const postAgent = (settings.hooks.PostToolUse || []).find((e) => e.matcher === 'Agent');
  assert(postAgent && postAgent.hooks.filter((h) => (h.command || '').includes('forge-hook.js')).length === 1,
    'exactly one forge hook per matcher entry after two enables');
});

// ── R5: a relocated Forge home is followed, not assumed ─────────────────────
//
// The path was hardcoded. `resolveForgeHome` reads FORGE_HOME from the
// environment, so an operator who relocated the home got a statusline aimed at
// `~/.forge-agent`, which for them may not exist. Note the asymmetry that scopes
// this fix: the CLAUDE home has NO environment variable — `resolveRuntimeHome`
// takes it as a caller option only — so the hook commands cannot be resolved the
// same way from a standalone CLI, and are deliberately left alone here.

test('R5: a relocated FORGE_HOME is followed — absolute, forward-slashed, quoted', () => {
  const home = path.join(mktmp(), 'forge home relocado');   // space on purpose
  const file = seed(mktmp(), {});
  const { status, settings } = run(file, [], { FORGE_HOME: home });
  assertEqual(status, 0, 'enable exits 0 with a relocated home');
  const command = settings.statusLine.command;
  assert(command !== MAINTAINED_COMMAND,
    'the relocated home still got the conventional path — the defect #105 describes');
  assert(command.includes(path.basename(home)),
    `the command does not name the relocated home: ${command}`);
  assert(command.endsWith('/forge-statusline.js"'),
    `the command must end at the quoted script, forward-slashed: ${command}`);
  // String.fromCharCode(92) instead of a literal: this assertion is about the
  // backslash itself, and writing one here would put the reader in the same
  // escaping layer the assertion exists to police.
  assert(!command.includes(String.fromCharCode(92)),
    `no backslash may reach the shell (escape on sh, separator on cmd): ${command}`);
  assert(/^node "/.test(command),
    `a home containing a space must be quoted or the command splits: ${command}`);
});

test('R5b control: FORGE_HOME pointing AT the conventional home keeps the tilde', () => {
  // The rule is "relocated", not "always absolute". Without this control the
  // implementation could satisfy R5 by absolutizing everyone — silently
  // destroying the portability of every settings.json that syncs across
  // machines, which is the whole reason the tilde is there.
  // run() supplies RUN_HOME as both HOME and USERPROFILE to the child.
  // Its canonical conventional home is not the parent process os.homedir().
  const conventional = path.join(RUN_HOME, '.forge-agent');
  const file = seed(mktmp(), {});
  const { status, settings } = run(file, [], { FORGE_HOME: conventional });
  assertEqual(status, 0, 'enable exits 0');
  assertEqual(settings.statusLine.command, MAINTAINED_COMMAND,
    'an explicitly-conventional FORGE_HOME must collapse back to the portable tilde form');
});

test('R5b isolation control: another private home is relocated for the child', () => {
  // Model the old parent/child mismatch entirely with fresh private paths.
  const parentHome = mktmp('merge-settings-parent-home-');
  assert(path.resolve(parentHome) !== path.resolve(RUN_HOME), 'parent fixture and child private home differ');
  const configured = path.join(parentHome, '.forge-agent');
  const file = seed(mktmp(), {});
  const { status, settings } = run(file, [], { FORGE_HOME: configured });
  assertEqual(status, 0, 'enable exits 0 for an explicitly different home');
  const expected = 'node "' + path.join(configured, 'scripts', 'forge-statusline.js').split(path.sep).join('/') + '"';
  assertEqual(settings.statusLine.command, expected, 'a conventional home belonging to another parent is an exact absolute relocation for this child');
  assert(settings.statusLine.command !== MAINTAINED_COMMAND, 'a different home must not collapse to the child tilde');
});

test('R5c control: with no FORGE_HOME the emitted command is byte-identical to before', () => {
  const file = seed(mktmp(), {});
  const { status, settings } = run(file, [], { FORGE_HOME: '' });
  assertEqual(status, 0, 'enable exits 0');
  assertEqual(settings.statusLine.command, MAINTAINED_COMMAND,
    'the default path changed — this fix must be invisible to everyone who did not relocate');
});

// ── R6: remove covers the third vintage of the path ─────────────────────────

test('R6: --remove deletes a statusLine written in the relocated absolute form', () => {
  const home = path.join(mktmp(), 'forge home relocado');
  const dir = mktmp();
  const file = seed(dir, {});
  run(file, [], { FORGE_HOME: home });
  const relocated = JSON.parse(fs.readFileSync(file, 'utf8')).statusLine.command;
  assert(relocated.includes('forge-statusline.js'), 'precondition: the relocated command was written');

  const { status, settings } = run(file, ['--remove'], { FORGE_HOME: home });
  assertEqual(status, 0, 'remove exits 0');
  assert(!settings.statusLine,
    'a relocated operator could not turn the statusline off — the basename predicate missed the third vintage');
});

// ── evidence matchers (2026-08-24) ──────────────────────────────────────────
// The evidence branch (forge-hook.js post, Bash|Write|Edit) shipped in M003
// S02 with matchers that were never registered — zero evidence files across
// the whole dogfood. This pin makes de-registration loud.
test('PostToolUse registers the evidence matchers (Agent + Bash + Write + Edit)', () => {
  const dir = mktmp();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{}');
  const { settings } = run(file);
  const matchers = (settings.hooks.PostToolUse || []).map((e) => e.matcher).sort();
  const expected = ['*', 'Agent', 'Bash', 'Edit', 'Write'];
  if (JSON.stringify(matchers) !== JSON.stringify(expected)) {
    throw new Error(`PostToolUse matchers drifted: ${JSON.stringify(matchers)} (expected ${JSON.stringify(expected)})`);
  }
});

test('S03/T05 remove optional Forge subagent row and preserve third-party value', () => {
  const home = path.join(mktmp(), 'forge home relocado');
  const managed = 'node "' + path.join(home, 'scripts', 'forge-subagent-statusline.js').split(path.sep).join('/') + '"';
  for (const [command, forgeHome] of [[ 'node ~/.forge-agent/scripts/forge-subagent-statusline.js', '' ], [ managed, home ]]) {
    const file = seed(mktmp(), { subagentStatusLine: { type: 'command', command }, outputStyle: 'Learning' });
    const result = run(file, ['--remove'], { FORGE_HOME: forgeHome });
    assertEqual(result.status, 0); assert(!Object.hasOwn(result.settings, 'subagentStatusLine'));
    assertEqual(result.settings.outputStyle, 'Learning');
  }
  const foreignHome = path.join(mktmp(), 'other forge home');
  const foreign = 'node "' + path.join(foreignHome, 'scripts', 'forge-subagent-statusline.js').split(path.sep).join('/') + '"';
  for (const command of ['echo operator', foreign, managed + ' --custom', 'echo forge-subagent-statusline.js; node company-rows.js']) {
    const custom = { type: 'command', command, extra: true };
    const file = seed(mktmp(), { subagentStatusLine: custom, outputStyle: 'Learning' });
    const result = run(file, ['--remove'], { FORGE_HOME: home });
    assertEqual(result.status, 0);
    assertEqual(JSON.stringify(result.settings.subagentStatusLine), JSON.stringify(custom));
    assertEqual(result.settings.outputStyle, 'Learning');
  }
  console.log('PASS S03/T05 merge remove Forge subagent row preserves third-party settings');
});

test('S03/T05 enable never activates or changes optional subagent row', () => {
  for (const optional of [undefined, { type: 'command', command: 'echo operator' }, { type: 'command', command: 'node fixture/forge-subagent-statusline.js' }]) {
    const file = seed(mktmp(), optional === undefined ? {} : { subagentStatusLine: optional });
    const result = run(file);
    assertEqual(result.status, 0); assertEqual(JSON.stringify(result.settings.subagentStatusLine), JSON.stringify(optional));
    assertEqual(Object.hasOwn(result.settings, 'subagentStatusLine'), optional !== undefined);
  }
  console.log('PASS S03/T05 merge enable keeps optional subagent setting untouched and evidence matchers unchanged');
});

test('R7: mixed lifecycle entries preserve foreign hooks and group metadata', () => {
  for (const [event, phase] of [
    ['SessionStart', 'session-start'], ['SubagentStart', 'subagent-start'],
    ['SubagentStop', 'subagent-stop'], ['PreCompact', 'pre-compact'],
    ['PostCompact', 'post-compact'], ['Stop', 'stop'],
  ]) {
    const foreignBefore = { type: 'command', command: 'echo operator-before', timeout: 17 };
    const foreignAfter = { type: 'command', command: 'echo operator-after', timeout: 29 };
    const seedData = { hooks: { [event]: [
      { timeout: 91, hooks: [foreignBefore, { type: 'command', command: 'node ~/.claude/forge-hook.js ' + phase }, foreignAfter] },
      { matcher: 'operator', hooks: [{ type: 'command', command: 'echo independent-entry' }] },
    ] }, operatorSetting: 'preserved' };
    // Removal from the original mixed entry must be safe even without enable.
    for (const enableFirst of [false, true]) {
      const file = seed(mktmp(), seedData);
      if (enableFirst) {
        const enabled = run(file);
        assertEqual(enabled.status, 0);
        const mixed = enabled.settings.hooks[event][0];
        assertEqual(mixed.timeout, 91, event + ' group metadata preserved');
        assertEqual(JSON.stringify(mixed.hooks[0]), JSON.stringify(foreignBefore));
        assertEqual(JSON.stringify(mixed.hooks[2]), JSON.stringify(foreignAfter));
        const once = fs.readFileSync(file, 'utf8');
        assertEqual(run(file).status, 0);
        assertEqual(fs.readFileSync(file, 'utf8'), once, event + ' enable idempotent');
      }
      const removed = run(file, ['--remove']);
      assertEqual(removed.status, 0);
      assertEqual(JSON.stringify(removed.settings.hooks[event]), JSON.stringify([
        { timeout: 91, hooks: [foreignBefore, foreignAfter] }, seedData.hooks[event][1],
      ]), event + ' removal preserves both foreign hooks and independent entry');
      assertEqual(removed.settings.operatorSetting, 'preserved');
    }
    const managedOnly = seed(mktmp(), { hooks: { [event]: [{ hooks: [{ type: 'command', command: 'node ~/.claude/forge-hook.js ' + phase }] }] } });
    const removedOnly = run(managedOnly, ['--remove']);
    assertEqual(removedOnly.status, 0);
    assert(!removedOnly.settings.hooks, event + ' empty managed group removed');
  }
});

test('R8: native hooks retain exact ordinary matchers, foreign siblings and idempotence', () => {
  const runtimeHome = path.join(mktmp(), "private Claude home ' with spaces");
  const foreign = { type: 'command', command: 'echo forge-hook.js documentation only', timeout: 37 };
  const customScope = { matcher: 'operator-only', hooks: [{ type: 'command', command: 'node ~/.claude/forge-hook.js pre', if: 'Read(seed)' }] };
  const file = seed(mktmp(), { hooks: { PreToolUse: [{ matcher: '*', timeout: 73, hooks: [foreign] }, customScope] }, custom: { keep: true } });
  const env = { CLAUDE_CONFIG_DIR: runtimeHome };
  const first = run(file, [], env); assertEqual(first.status, 0);
  const once = fs.readFileSync(file, 'utf8'); assertEqual(run(file, [], env).status, 0);
  assertEqual(fs.readFileSync(file, 'utf8'), once, 'repeat is byte-identical');
  for (const [event, matchers] of [['PreToolUse', ['Agent', 'Write']], ['PostToolUse', ['Agent', 'Bash', 'Write', 'Edit']]]) {
    for (const matcher of matchers) {
      const rows = first.settings.hooks[event].filter(row => row.matcher === matcher);
      assertEqual(rows.flatMap(row => row.hooks).filter(h => h.command === 'node ~/.claude/forge-hook.js ' + (event === 'PreToolUse' ? 'pre' : 'post')).length, 1, event + '/' + matcher);
    }
  }
  const events = [
    ['PreToolUse','pre','*'], ['PostToolUse','post','*'], ['PostToolUseFailure','post-failure','*'], ['PermissionDenied','permission-denied','*'],
    ['SubagentStart','subagent-start'], ['SubagentStop','subagent-stop'], ['Stop','stop'], ['SessionEnd','session-end'],
    ['ConfigChange','config-change'], ['PreModelSwitch','pre-model-switch'], ['PostModelSwitch','post-model-switch'],
  ];
  for (const [event, phase, matcher] of events) {
    const hooks = first.settings.hooks[event].filter(row => row.matcher === matcher).flatMap(row => row.hooks).filter(h => h.args?.[1] === 'native-live');
    assertEqual(hooks.length, 1, event + ' exactly once');
    assertEqual(hooks[0].command, fs.realpathSync.native(process.execPath));
    assertEqual(JSON.stringify(hooks[0].args), JSON.stringify([path.join(runtimeHome, 'forge-hook.js'), 'native-live', phase]));
    assertEqual(hooks[0].onFailure, 'block'); assert(!Object.hasOwn(hooks[0], 'async'));
  }
  assert(!first.settings.hooks.PermissionRequest, 'permission request is not a permission denial');
  const bootstrap = first.settings.hooks.SessionStart.flatMap(row => row.hooks).filter(h => h.args?.[1] === 'session-start');
  assertEqual(bootstrap.length, 1); assertEqual(bootstrap[0].command, fs.realpathSync.native(process.execPath));
  assertEqual(JSON.stringify(bootstrap[0].args), JSON.stringify([path.join(runtimeHome, 'forge-hook.js'), 'session-start']));
  const removed = run(file, ['--remove'], env); assertEqual(removed.status, 0);
  assertEqual(JSON.stringify(removed.settings.hooks), JSON.stringify({ PreToolUse: [{ matcher: '*', timeout: 73, hooks: [foreign] }, customScope] }));
  assertEqual(JSON.stringify(removed.settings.custom), JSON.stringify({ keep: true }));
});

// Delivery correction: exercise the actual restricted CLI, not an enable replay.
function migrationFixture(conventional = false) {
  const root = mktmp('merge-statusline migration-'), home = path.join(root, conventional ? '.forge-agent' : 'Relocated Core');
  fs.mkdirSync(path.join(home, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'forge-statusline.js'), path.join(home, 'scripts', 'forge-statusline.js'));
  const file = path.join(root, 'settings.json'), backup = path.join(home, 'backups', 'migration', 'settings.json');
  const original = '{\r\n\t"statusLine": {"type":"command", "command":"node ~/.claude/forge-statusline.js", "refreshInterval":1, "extra":{"keep":"Ω"}},\r\n "permissions":{"defaultMode":"default"},"hooks":{"Custom":[{"command":"keep-custom"}]},"operator":true\r\n}\r\n';
  fs.writeFileSync(file, original);
  const invoke = (args = [], extraEnv = {}) => {
    const result = spawnSync(process.execPath, [MODULE, file, '--migrate-statusline-command-only', ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
      env: { ...process.env, HOME: root, USERPROFILE: root, FORGE_HOME: home, ...extraEnv },
    });
    let report; try { report = JSON.parse(result.stdout); } catch (_) {}
    return { ...result, report };
  };
  return { root, home, file, backup, original, invoke };
}

test('migration-only changes one legacy token, preserves bytes and backs up; second run is a noop', () => {
  for (const conventional of [true, false]) {
    const f = migrationFixture(conventional), preview = f.invoke(['--dry-run']);
    assertEqual(preview.status, 0); assert(preview.report.changed);
    assertEqual(fs.readFileSync(f.file, 'utf8'), f.original); assert(!fs.existsSync(path.dirname(f.backup)));
    const expected = conventional ? MAINTAINED_COMMAND : `node "${path.join(f.home, 'scripts', 'forge-statusline.js').split(path.sep).join('/')}"`;
    assertEqual(preview.report.command, expected);
    const applied = f.invoke(['--backup', f.backup, '--expected-sha256', preview.report.before_sha256]);
    assertEqual(applied.status, 0); assert(applied.report.changed && applied.report.active_entrypoint_sha256);
    assertEqual(fs.readFileSync(f.file, 'utf8'), f.original.replace(JSON.stringify(FROZEN_COMMAND), JSON.stringify(expected)));
    assertEqual(fs.readFileSync(f.backup, 'utf8'), f.original);
    const again = f.invoke(['--backup', f.backup, '--expected-sha256', preview.report.before_sha256]);
    assertEqual(again.status, 0); assertEqual(again.report.changed, false);
  }
});

test('migration-only conservatively preserves custom, ambiguous, duplicate, escaped and invalid settings', () => {
  const f = migrationFixture();
  const cases = [
    '{"statusLine":{"type":"command","command":"node custom.js"}}',
    '{"statusLine":{"type":"prompt","command":"node ~/.claude/forge-statusline.js"}}',
    '{"statusLine":{"type":"command","command":"node ~/.claude/forge-statusline.js"},"note":"node ~/.claude/forge-statusline.js"}',
    '{"statusLine":{"type":"command","command":"custom","command":"node ~/.claude/forge-statusline.js"}}',
    String.raw`{"statusLine":{"type":"command","command":"custom","comm\u0061nd":"node ~/.claude/forge-statusline.js"}}`,
    String.raw`{"statusLine":{"type":"command","command":"node ~\/.claude/forge-statusline.js"}}`,
    String.raw`{"status\u004cine":{"type":"command","command":"node ~/.claude/forge-statusline.js"}}`,
    '{"statusLine":{"type":"command","command":"custom"},"statusLine":{"type":"command","command":"node ~/.claude/forge-statusline.js"}}',
    '{"statusLine":',
  ];
  for (const bytes of cases) {
    fs.writeFileSync(f.file, bytes); const result = f.invoke(['--dry-run']);
    assertEqual(result.status, 0); assertEqual(result.report.changed, false); assertEqual(fs.readFileSync(f.file, 'utf8'), bytes);
  }
});

test('migration-only refuses an existing backup and observed target drift without changing the current target', () => {
  const f = migrationFixture(), preview = f.invoke(['--dry-run']);
  fs.mkdirSync(path.dirname(f.backup), { recursive: true }); fs.writeFileSync(f.backup, 'foreign-backup');
  const refused = f.invoke(['--backup', f.backup, '--expected-sha256', preview.report.before_sha256]);
  assertEqual(refused.status, 1); assertEqual(refused.report.reason, 'statusline-migration-backup-failed');
  assertEqual(fs.readFileSync(f.file, 'utf8'), f.original); assertEqual(fs.readFileSync(f.backup, 'utf8'), 'foreign-backup');
  const g = migrationFixture(), before = g.invoke(['--dry-run']), drift = g.original + ' ';
  fs.writeFileSync(g.file, drift);
  const changed = g.invoke(['--backup', g.backup, '--expected-sha256', before.report.before_sha256]);
  assertEqual(changed.status, 1); assertEqual(changed.report.reason, 'statusline-migration-file-changed');
  assertEqual(fs.readFileSync(g.file, 'utf8'), drift); assert(!fs.existsSync(g.backup));
});

test('migration-only rejects file links and does not enter the full enable/remove paths', () => {
  const f = migrationFixture(), other = path.join(f.root, 'other-settings.json'); fs.linkSync(f.file, other);
  const linked = f.invoke(['--dry-run']); assertEqual(linked.status, 1); assertEqual(linked.report.reason, 'statusline-migration-untrusted-file');
  assertEqual(fs.readFileSync(f.file, 'utf8'), f.original);
  const g = migrationFixture(), mixed = g.invoke(['--remove']); assertEqual(mixed.status, 1);
  assertEqual(fs.readFileSync(g.file, 'utf8'), g.original);
  const h = migrationFixture(), target = path.join(h.root, 'target.json'); fs.renameSync(h.file, target);
  try { fs.symlinkSync(target, h.file, 'file'); }
  catch (error) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error; return; }
  const symlink = h.invoke(['--dry-run']); assertEqual(symlink.status, 1); assertEqual(symlink.report.reason, 'statusline-migration-untrusted-file');
  assertEqual(fs.readFileSync(target, 'utf8'), h.original);
});

test('migration-only qualifies Windows path-device zero but keeps descriptor identity strict', () => {
  for (const mode of ['windows-zero', 'nonzero-mismatch', 'posix-zero', 'descriptor-drift']) {
    const f = migrationFixture(), preload = path.join(f.root, 'fs-identity.cjs');
    const source = `'use strict';const fs=require('fs');const target=${JSON.stringify(f.file)};const l=fs.lstatSync,f=fs.fstatSync,o=fs.openSync;let descriptor=null,calls=0;Object.defineProperty(process,'platform',{value:${JSON.stringify(mode === 'posix-zero' ? 'linux' : 'win32')}});fs.openSync=function(p,...a){const fd=o.call(this,p,...a);if(p===target)descriptor=fd;return fd;};fs.lstatSync=function(p,...a){const s=l.call(this,p,...a);if(p===target){const copy=Object.assign(Object.create(Object.getPrototypeOf(s)),s);copy.dev=${mode === 'nonzero-mismatch' ? 's.dev+1n' : '0n'};return copy;}return s;};fs.fstatSync=function(fd,...a){const s=f.call(this,fd,...a);if(fd===descriptor&&++calls>1&&${JSON.stringify(mode)}==='descriptor-drift')return {...s,dev:s.dev+1n};return s;};`;
    fs.writeFileSync(preload, source);
    const option = '--require ' + JSON.stringify(preload.split(path.sep).join('/'));
    const result = f.invoke(['--dry-run'], { NODE_OPTIONS: [process.env.NODE_OPTIONS || '', option].filter(Boolean).join(' ') });
    if (mode === 'windows-zero') { assertEqual(result.status, 0); assertEqual(result.report.changed, true); }
    else { assertEqual(result.status, 1); assertEqual(result.report.reason, 'statusline-migration-file-changed'); }
    assertEqual(fs.readFileSync(f.file, 'utf8'), f.original);
  }
});


// ── summary ─────────────────────────────────────────────────────────────────
cleanup();
console.log(`\nmerge-settings.test.js: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const f of failures) console.log(`  FAILED: ${f.name} — ${f.error}`);
  process.exit(1);
}
