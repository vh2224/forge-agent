#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const guard = require('./forge-scripts-callsites.js');
let passed = 0;
let skipped = 0;
function test(name, fn) {
  const result = fn();
  if (result && result.skip) { skipped++; process.stdout.write(`  - ${name} (skipped: ${result.skip})\n`); return; }
  passed++;
  process.stdout.write(`  [PASS] ${name}\n`);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-scripts-callsites-'));
  for (const dir of ['agents', 'commands', 'skills', 'shared', 'bin']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'commands', 'one.md'), 'FORGE_SCRIPTS_DIR=$([ -f scripts/a.js ] && echo scripts || echo "${FORGE_HOME:-$HOME/.forge-agent}/scripts")\n');
  fs.writeFileSync(path.join(root, 'skills', 'bare.md'), 'FORGE_SCRIPTS_DIR="${FORGE_HOME:-$HOME/.forge-agent}/scripts"\nTOOL="$FORGE_SCRIPTS_DIR/a.js"\n');
  fs.writeFileSync(path.join(root, 'shared', 'shared.md'), 'FORGE_SHARED_DIR="${FORGE_HOME:-$HOME/.forge-agent}/shared"\n');
  fs.writeFileSync(path.join(root, 'bin', 'run'), '#!/usr/bin/env bash\nENGINE="${FORGE_HOME:-$HOME/.forge-agent}/scripts/a.js"\nPREFS="${FORGE_HOME:-$HOME/.forge-agent}/forge-agent-prefs.jsonc"\n');
  fs.writeFileSync(path.join(root, 'bin', 'run.cmd'), 'set "FORGE_ROOT=%FORGE_HOME%"\r\nif not defined FORGE_ROOT set "FORGE_ROOT=%USERPROFILE%\\.forge-agent"\r\nset "ENGINE=%FORGE_ROOT%\\scripts\\a.js"\r\n');
  fs.writeFileSync(path.join(root, 'agents', 'prose.md'), 'The canonical chain uses Forge home.\n');
  return root;
}
const familyFile = { 'one-liner': ['commands/one.md', 'FORGE_SCRIPTS_DIR=$([ -f scripts/a.js ] && echo scripts || echo "~/.claude/scripts")'], 'bare-assign': ['skills/bare.md', 'FORGE_SCRIPTS_DIR="$HOME/.claude/scripts"'], 'aliased-var': ['skills/bare.md', 'TOOL="$HOME/.claude/scripts/a.js"'], 'shared-dir': ['shared/shared.md', 'FORGE_SHARED_DIR="$HOME/.claude"'], 'bin-bash': ['bin/run', 'ENGINE="$HOME/.claude/scripts/a.js"'], 'bin-cmd': ['bin/run.cmd', 'set "ENGINE=%USERPROFILE%\\.claude\\scripts\\a.js"'], prose: ['agents/prose.md', 'The destination was ~/.claude/scripts.'], 'prefs-path': ['bin/run', 'PREFS="${FORGE_HOME:-$HOME/.forge-agent}/shared/forge-agent-prefs.jsonc"'] };
for (const [family, [relative, bad]] of Object.entries(familyFile)) test(`rejects ${family} with file and line`, () => {
  const root = fixture(); try { const file = path.join(root, relative); fs.appendFileSync(file, `\n${bad}\n`); const report = guard.scan({ root }); assert.strictEqual(report.outcome, 'findings'); const hit = report.findings.find((x) => x.family === family); assert(hit && hit.path === relative && hit.line > 0); fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(`\n${bad}\n`, '\n')); assert.strictEqual(guard.scan({ root }).outcome, 'clean'); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
// R3: the prose family used to have no pattern of its own — it was only the
// fallback label for a literal `.claude/scripts` hit, so prose describing the
// retired resolution chain in any other wording was invisible.  Bite is proved
// in both directions: each shape below is a finding, and the legitimate
// `~/.claude` mentions (runtime home of agents/skills/settings/prefs, layout
// tables) stay clean — a pattern that flagged those would kill the guard by noise.
const PROSE_BAD = [
  'Use the template from `~/.claude/forge-dispatch.md` only as reference material.',
  'The installer flattens shared/*.md into ~/.claude/, so a bare path is dead.',
  '# ~/.claude first, then falls back to the repo (repo_path in prefs).',
  '# Installed by install.sh. Resolves the engine in ~/.claude for dev/dogfood.',
  'This file lands in `~/.claude/shared/` on the next install run.',
];
const PROSE_OK = [
  'node ~/.claude/forge-settings.js ~/.claude/settings.json --mcp-list',
  '| `~/.claude/forge-agent-prefs.jsonc` | Global | Modelos por fase |',
  'ls ~/.claude/skills/ 2>/dev/null',
  '`forge-agent-prefs.jsonc` ficam no Forge home; `~/.claude` e `~/.codex` são projeções.',
  '| macOS | `$HOME/.forge-agent` | `$HOME/.claude` | `$HOME/.codex` |',
];
test('prose family detects the resolution chain and spares legitimate ~/.claude mentions', () => {
  const root = fixture();
  try {
    const file = path.join(root, 'agents', 'prose.md');
    const base = fs.readFileSync(file, 'utf8');
    for (const bad of PROSE_BAD) {
      fs.writeFileSync(file, `${base}${bad}\n`);
      const report = guard.scan({ root });
      assert.strictEqual(report.outcome, 'findings', `prose must be detected: ${bad}`);
      const hit = report.findings.find((x) => x.family === 'prose');
      assert(hit && hit.path === 'agents/prose.md', `prose finding must be classified as prose: ${bad}`);
    }
    fs.writeFileSync(file, `${base}${PROSE_OK.join('\n')}\n`);
    const clean = guard.scan({ root });
    assert.strictEqual(clean.outcome, 'clean', `legitimate mentions must not be findings: ${JSON.stringify(clean.findings)}`);
    assert.strictEqual(clean.counts_by_family.prose, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('prose in bin/ is classified as prose, not bin-bash', () => {
  const root = fixture();
  try {
    fs.appendFileSync(path.join(root, 'bin', 'run'), '\n# ~/.claude first, then falls back to the repo.\n');
    const report = guard.scan({ root });
    assert.strictEqual(report.outcome, 'findings');
    assert.strictEqual(report.findings.length, 1);
    assert.strictEqual(report.findings[0].family, 'prose');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('prefs-path in bin is classified positively, not as bin-bash', () => {
  const root = fixture();
  try {
    fs.appendFileSync(path.join(root, 'bin', 'run'), '\nPREFS="${FORGE_HOME:-$HOME/.forge-agent}/shared/forge-agent-prefs.jsonc"\n');
    const report = guard.scan({ root });
    assert.strictEqual(report.outcome, 'findings');
    assert.strictEqual(report.findings[0].family, 'prefs-path');
    assert.strictEqual(report.findings[0].directory, '.forge-agent/shared');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('prefs-path spares prose and the legitimate legacy fallback', () => {
  const root = fixture();
  try {
    fs.appendFileSync(path.join(root, 'agents', 'prose.md'), '\n| `~/.claude/forge-agent-prefs.jsonc` | Global |\nPREFS="$HOME/.claude/forge-agent-prefs.jsonc"\n');
    const report = guard.scan({ root });
    assert.strictEqual(report.outcome, 'clean');
    assert.strictEqual(report.counts_by_family['prefs-path'], 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('unmeasured prefs shape is named, censused, and not a finding', () => {
  const root = fixture();
  try {
    fs.appendFileSync(path.join(root, 'agents', 'prose.md'), '\nPREFS="$XDG_CONFIG_HOME/forge-agent-prefs.jsonc"\n');
    const report = guard.scan({ root });
    assert.strictEqual(report.outcome, 'clean');
    assert.strictEqual(report.scanned_by_family['prefs-path'], 2);
    assert.deepStrictEqual(report.unmeasured, [{ path: 'agents/prose.md', line: 3, reason: 'prefs-shape-unmeasured', executable: false }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
/*
 * R1: every fixture above writes the destination as a BARE assignment, but three
 * of the four rungs the wrappers actually write are conditional one-liners, and
 * the old trigger required the line to start with the variable name.  Poisoning
 * rung 2 — the conditional form — is therefore the case the family exists for
 * and the case it could not see: 15 of the 20 real assignment sites went
 * unevaluated, and they did not even reach `unmeasured`.
 */
const RUNGS = [
  '  PREFS="${FORGE_HOME:-$HOME/.forge-agent}/forge-agent-prefs.jsonc"',
  '  [ -f "$PREFS" ] || PREFS="${FORGE_HOME:-$HOME/.forge-agent}/forge-agent-prefs.json"',
  '  [ -f "$PREFS" ] || PREFS="$HOME/.claude/forge-agent-prefs.jsonc"',
  '  [ -f "$PREFS" ] || PREFS="$HOME/.claude/forge-agent-prefs.json"',
];
function chainFixture(rungs) {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'bin', 'run'), `#!/usr/bin/env bash\nENGINE="\${FORGE_HOME:-$HOME/.forge-agent}/scripts/a.js"\n${rungs.join('\n')}\n`);
  return root;
}
test('the real four-rung conditional chain is measured on every rung', () => {
  const root = chainFixture(RUNGS);
  try {
    const report = guard.scan({ root });
    assert.strictEqual(report.outcome, 'clean', JSON.stringify(report.findings));
    assert.strictEqual(report.scanned_by_family['prefs-path'], 4, 'each rung must be counted, not the file');
    assert.deepStrictEqual(report.unmeasured, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('a poisoned conditional rung is a finding that names the directory', () => {
  const poisoned = RUNGS.slice();
  poisoned[1] = '  [ -f "$PREFS" ] || PREFS="${FORGE_HOME:-$HOME/.forge-agent}/shared/forge-agent-prefs.json"';
  const root = chainFixture(poisoned);
  try {
    const report = guard.scan({ root });
    assert.strictEqual(report.outcome, 'findings', 'rung 2 is the shape the old trigger could not see');
    const hit = report.findings.find((x) => x.family === 'prefs-path');
    assert(hit, 'poisoned rung must produce a prefs-path finding');
    assert.strictEqual(hit.directory, '.forge-agent/shared');
    assert.strictEqual(hit.path, 'bin/run');
    assert.strictEqual(hit.line, 4);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('a conditional rung outside the measured prefix table is unmeasured, never judged', () => {
  const root = chainFixture(RUNGS);
  try {
    fs.appendFileSync(path.join(root, 'agents', 'prose.md'), '\n  [ -f "$PREFS" ] || PREFS="$XDG_CONFIG_HOME/forge/forge-agent-prefs.json"\n');
    const report = guard.scan({ root });
    assert.strictEqual(report.outcome, 'clean', JSON.stringify(report.findings));
    assert.strictEqual(report.counts_by_family['prefs-path'], 0);
    assert.strictEqual(report.scanned_by_family['prefs-path'], 5);
    assert.deepStrictEqual(report.unmeasured, [{ path: 'agents/prose.md', line: 3, reason: 'prefs-shape-unmeasured', executable: false }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('authority loss is scan-failed, never clean', () => {
  const home = require('./forge-home.js'); const original = home.resolvePreferencePaths;
  home.resolvePreferencePaths = () => { throw new Error('authority unavailable for test'); };
  const root = fixture();
  try { const report = guard.scan({ root }); assert.strictEqual(report.outcome, 'scan-failed'); assert.strictEqual(report.reason, 'authority-unavailable'); } finally { home.resolvePreferencePaths = original; fs.rmSync(root, { recursive: true, force: true }); }
});
test('prefs-path bite is proved by spawned CLI in both directions', () => {
  const root = fixture(); const CLI = path.join(__dirname, 'forge-scripts-callsites.js');
  const runCli = () => spawnSync(process.execPath, [CLI, '--root', root], { encoding: 'utf8' });
  try {
    let out = runCli(); assert.strictEqual(out.status, 0); assert.strictEqual(JSON.parse(out.stdout).outcome, 'clean');
    const file = path.join(root, 'bin', 'run'); const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, good.replace('/forge-agent-prefs.jsonc', '/shared/forge-agent-prefs.jsonc'));
    out = runCli(); const poisoned = JSON.parse(out.stdout); assert.strictEqual(out.status, 2); assert.strictEqual(poisoned.outcome, 'findings'); assert.strictEqual(poisoned.findings[0].family, 'prefs-path'); assert.strictEqual(poisoned.findings[0].directory, '.forge-agent/shared');
    fs.writeFileSync(file, good); out = runCli(); assert.strictEqual(out.status, 0); assert.strictEqual(JSON.parse(out.stdout).outcome, 'clean');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
// Forms 3-6 from lines 3-6 of the PR #84 maintainer review table: four
// unmeasured shapes means this test must exercise four forms, not one as proof.
const UNMEASURED_SHAPES = Object.freeze([
  { name: 'unquoted', lines: ['PREFS=${FORGE_HOME:-$HOME/.forge-agent}/shared/forge-agent-prefs.jsonc'] },
  { name: 'single-quoted', lines: ["PREFS='${FORGE_HOME:-$HOME/.forge-agent}/shared/forge-agent-prefs.jsonc'"] },
  { name: 'hoisted-prefix', lines: ['D="${FORGE_HOME:-$HOME/.forge-agent}/shared"', 'PREFS="$D/forge-agent-prefs.jsonc"'] },
  { name: 'variable-basename', lines: ['D="${FORGE_HOME:-$HOME/.forge-agent}/shared"', 'NAME="forge-agent-prefs.jsonc"', 'PREFS="$D/$NAME"'] },
]);
function cliReport(cli, root) {
  const result = spawnSync(process.execPath, [cli, '--root', root], { encoding: 'utf8' });
  return { result, report: JSON.parse(result.stdout) };
}
test('unmeasured executable prefs shapes fail the spawned CLI as a complete class', () => {
  assert.strictEqual(UNMEASURED_SHAPES.length, 4, 'the four known unmeasured forms must all be exercised');
  const root = fixture(); const CLI = path.join(__dirname, 'forge-scripts-callsites.js'); const file = path.join(root, 'bin', 'run');
  try {
    for (const shape of UNMEASURED_SHAPES) {
      const good = fs.readFileSync(file, 'utf8');
      try {
        fs.appendFileSync(file, `\n${shape.lines.join('\n')}\n`);
        const { result, report } = cliReport(CLI, root);
        assert.strictEqual(result.status, 2, `${shape.name} must fail the CLI process`);
        assert.strictEqual(report.outcome, 'scan-failed');
        assert.strictEqual(report.reason, 'prefs-shape-unmeasured-executable');
        assert.strictEqual(report.findings.length, 0);
        const entries = report.unmeasured.filter((entry) => entry.executable && entry.path.startsWith('bin/'));
        assert.strictEqual(entries.length, 1, `${shape.name} must produce one executable unmeasured entry`);
      } finally { fs.writeFileSync(file, good); }
      const { result, report } = cliReport(CLI, root);
      assert.strictEqual(result.status, 0, `${shape.name} restoration must pass the CLI process`);
      assert.strictEqual(report.outcome, 'clean');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('unmeasured prefs shapes in prose remain clean', () => {
  const root = fixture(); const CLI = path.join(__dirname, 'forge-scripts-callsites.js');
  try {
    fs.appendFileSync(path.join(root, 'agents', 'prose.md'), `\n${UNMEASURED_SHAPES.flatMap((shape) => shape.lines).join('\n')}\n`);
    const { result, report } = cliReport(CLI, root);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(report.outcome, 'clean');
    assert.strictEqual(report.unmeasured.length, 4);
    assert(report.unmeasured.every((entry) => entry.path === 'agents/prose.md' && entry.executable === false));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('never says clean for an empty or incomplete census', () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-scripts-empty-')); try { assert.strictEqual(guard.scan({ root }).outcome, 'scan-failed'); fs.mkdirSync(path.join(root, 'agents')); fs.writeFileSync(path.join(root, 'agents', 'a.md'), 'x\n'); const report = guard.scan({ root }); assert.strictEqual(report.outcome, 'scan-failed'); assert(report.missing_families.includes('bin-cmd')); } finally { fs.rmSync(root, { recursive: true, force: true }); } });
test('real markdown snippets resolve scripts and shared without legacy poison', () => {
  const scriptSource = fs.readFileSync(path.join(__dirname, '..', 'commands', 'forge-init.md'), 'utf8');
  const scriptMatch = scriptSource.match(/FORGE_SCRIPTS_DIR=\$\([^\n]+\)/); assert(scriptMatch, 'real scripts snippet');
  const sharedSource = fs.readFileSync(path.join(__dirname, '..', 'skills', 'forge-next', 'SKILL.md'), 'utf8');
  const sharedMatch = sharedSource.match(/FORGE_SHARED_DIR="\$\{FORGE_HOME:-\$HOME\/.forge-agent\}\/shared"/); assert(sharedMatch, 'real shared snippet');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-scripts-consumer-'));
  const home = path.join(root, 'home'); const override = path.join(root, 'override'); const marker = path.join(root, 'legacy-executed');
  // Without execute permission POSIX returns status 126, making each "must not execute"
  // assertion vacuous; NTFS ignores this bit, so Windows cannot verify the fix.
  const writeProbe = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }); fs.chmodSync(file, 0o755); };
  const run = (code, forgeHome) => spawnSync('bash', ['-c', code], { cwd: root, env: { ...process.env, HOME: home, FORGE_HOME: forgeHome, FORGE_POISON_MARKER: marker }, encoding: 'utf8' });
  try {
    for (const base of [path.join(home, '.forge-agent'), override]) {
      writeProbe(path.join(base, 'scripts', 'probe'), ':');
      writeProbe(path.join(base, 'shared', 'probe'), ':');
    }
    writeProbe(path.join(home, '.claude', 'scripts', 'probe'), 'printf legacy > "$FORGE_POISON_MARKER"');
    writeProbe(path.join(home, '.claude', 'probe'), 'printf legacy > "$FORGE_POISON_MARKER"');
    const scriptCode = `${scriptMatch[0]}; "$FORGE_SCRIPTS_DIR/probe"; printf '%s' "$FORGE_SCRIPTS_DIR"`;
    const sharedCode = `${sharedMatch[0]}; "$FORGE_SHARED_DIR/probe"; printf '%s' "$FORGE_SHARED_DIR"`;
    let out = run(scriptCode, '');
    if (out.error && out.error.code === 'ENOENT') return { skip: 'bash unavailable (ENOENT)' };
    assert.match(out.stdout, /[\\/]home[\\/]\.forge-agent[\\/]scripts$/);
    assert.strictEqual(fs.existsSync(marker), false, 'legacy scripts poison must not execute');
    out = run(sharedCode, '');
    assert.match(out.stdout, /[\\/]home[\\/]\.forge-agent[\\/]shared$/);
    assert.strictEqual(fs.existsSync(marker), false, 'legacy shared poison must not execute');
    out = run(scriptCode, override); assert.match(out.stdout, /[\\/]override[\\/]scripts$/);
    out = run(sharedCode, override); assert.match(out.stdout, /[\\/]override[\\/]shared$/);
    assert.strictEqual(fs.existsSync(marker), false, 'FORGE_HOME override must not execute legacy poison');
    const legacyScriptCode = `${scriptMatch[0].replace('${FORGE_HOME:-$HOME/.forge-agent}/scripts', '$HOME/.claude/scripts')}; "$FORGE_SCRIPTS_DIR/probe"`;
    run(legacyScriptCode, ''); assert.strictEqual(fs.existsSync(marker), true, 'scripts control must execute legacy poison');
    fs.rmSync(marker);
    const legacySharedCode = `${sharedMatch[0].replace('${FORGE_HOME:-$HOME/.forge-agent}/shared', '$HOME/.claude')}; "$FORGE_SHARED_DIR/probe"`;
    run(legacySharedCode, ''); assert.strictEqual(fs.existsSync(marker), true, 'shared control must execute legacy poison');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
process.stdout.write(`[RESULT] ${passed} passed, ${skipped} skipped\n`);
