#!/usr/bin/env node
'use strict';

// forge-exec-callsites.test.js — proves bite in both directions, the
// anti-silence floor, the call-site/prose separation, and the CLI exit-code
// contract for the in-process `codex exec` absence scanner.
//
// NOTE (deliberate, do not "fix" by adding a real-repo assert): this suite
// does NOT assert against the live repository tree. `scripts/forge-xllm.js`
// still has real `codex exec` call sites until T02 of this slice removes
// them — asserting cleanliness here would either fail today (before T02
// lands) or pass by accident of task ordering later. The live assertion,
// proving absence AND proving the predicate bites via a synthetic positive
// control, belongs to Section 96 (T04), which runs after both T02 (produces
// the absence) and T03/this file (builds the instrument) are done. Every
// fixture below is synthetic, isolated under os.tmpdir() or in-memory.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  SKIP_REASONS,
  CALL_SITE_FORMS,
  collectFiles,
  scanExecCallSites,
} = require('./forge-exec-callsites.js');

const CLI = path.join(__dirname, 'forge-exec-callsites.js');

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
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-exec-callsites-'));
  tmps.push(d);
  return fs.realpathSync(d);
}

function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

// A path guaranteed absent, inside a directory this run OWNS. A literal
// `/tmp/<fixed-name>` is a shared namespace: a concurrent run, a leftover from
// an interrupted one, or an unrelated tool can create that exact path and turn
// an "absent root" test into a silent no-op that still passes (S05 review R9).
// The parent is unique per call; the child is absent because nothing ever
// creates it inside a directory nobody else can name.
function absentPathUnder(prefix) {
  return path.join(mktmp(prefix), 'does-not-exist');
}

// Built from parts, same reasoning as forge-doc-claims.test.js's CLAIM_PARTS:
// this test file is walked by the real-repo scan the moment a fixture root
// happens to include it, and it is also explicitly self-excluded via
// SELF_FIXTURE_BASENAMES — but the literal argv forms below must not
// themselves read as a stray real call site if that exclusion ever
// regresses. Splitting avoids shipping the exact literal unnecessarily.
const EXEC_ARG_LINES = [
  "const codexBin = resolveCodexCommand();",
  "const args = [",
  "  " + JSON.stringify('exec') + ",",
  "  '--json',",
  "];",
  "spawnSync(codexBin, args);",
].join('\n');

// ── R1: reach — collectFiles walks .js and .md, skips the rest ─────────────

console.log('R1 — reach and extension filtering');

test('collectFiles on a populated dir returns .js/.md, skips others with extension-not-scanned', () => {
  const dir = mktmp('reach-');
  fs.writeFileSync(path.join(dir, 'a.js'), '// nothing here\n');
  fs.writeFileSync(path.join(dir, 'b.md'), '# doc\n');
  fs.writeFileSync(path.join(dir, 'c.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'd.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const { files, skipped } = collectFiles(dir);
  assertEqual(files.length, 2, 'files.length (js+md only)');
  const jsonSkip = skipped.find((s) => s.path.endsWith('c.json'));
  const pngSkip = skipped.find((s) => s.path.endsWith('d.png'));
  assert(jsonSkip && jsonSkip.reason === SKIP_REASONS.EXTENSION_NOT_SCANNED, 'c.json skipped with extension-not-scanned');
  assert(pngSkip && pngSkip.reason === SKIP_REASONS.EXTENSION_NOT_SCANNED, 'd.png skipped with extension-not-scanned');
});

test('collectFiles on this scanner\'s own directory excludes its own fixture files with reason self-fixture', () => {
  const { files, skipped } = collectFiles(__dirname);
  const selfInFiles = files.some((f) => f.endsWith('forge-exec-callsites.js') || f.endsWith('forge-exec-callsites.test.js'));
  assert(!selfInFiles, 'the scanner\'s own files must never appear in the scanned set');
  const selfSkip = skipped.filter((s) => s.reason === SKIP_REASONS.SELF_FIXTURE);
  assert(selfSkip.length >= 2, 'expected both self-fixture files in skipped with reason self-fixture');
});

test('collectFiles on a nonexistent root returns [] and a root-not-found skip entry', () => {
  const missing = absentPathUnder('missing-root-');
  const { files, skipped } = collectFiles(missing);
  assertEqual(files.length, 0, 'files.length');
  assert(skipped.some((s) => s.reason === SKIP_REASONS.ROOT_NOT_FOUND), 'root-not-found reason present');
});

// ── R2: bite — call-site fixture is accused, naming file and line, both directions ─

console.log('R2 — bite (call-site fixture, both directions, file+line named)');

test('a fixture containing an exec-arg-array call site is flagged, naming file and line', () => {
  const result = scanExecCallSites(
    [{ path: '/fx/adapter.js', content: EXEC_ARG_LINES + '\n' }],
    { inMemory: true }
  );
  assertEqual(result.outcome, 'found', 'outcome');
  assert(result.scanned > 0, 'scanned > 0');
  assert(result.call_sites.length >= 1, 'expected >= 1 call site');
  const hit = result.call_sites.find((c) => c.form === CALL_SITE_FORMS.EXEC_ARG);
  assert(hit, 'expected a call site of form exec-arg-array');
  assertEqual(hit.file, '/fx/adapter.js', 'call site file');
  assert(Number.isInteger(hit.line) && hit.line > 0, 'call site line is a positive integer');
});

test('removing the call site from the SAME fixture reports clean (proves both directions)', () => {
  const clean = scanExecCallSites(
    [{ path: '/fx/adapter.js', content: 'function noop() { return 1; }\n' }],
    { inMemory: true }
  );
  assertEqual(clean.outcome, 'clean', 'outcome after removal');
  assertEqual(clean.call_sites.length, 0, 'call_sites.length after removal');
});

// One CALL-SITE-DIRECTION fixture per removed symbol. The previous single
// fixture named three symbols in its title but exercised only
// `invokeCodexDetached`: deleting `invokeCodex` from REMOVED_SYMBOLS_RE left
// the suite at 21 passed / 0 failed — the regression was invisible, and
// `codexSandboxArgs` only failed incidentally through the prose-direction test
// (S05 review R8). Table-driven, so deleting ANY ONE of the three turns the
// suite red in the direction that matters.
for (const symbol of ['invokeCodex', 'invokeCodexDetached', 'codexSandboxArgs']) {
  test(`a reference to the removed symbol ${symbol}( is a call site of form removed-symbol, at the right line`, () => {
    const content = [
      'function build(opts) {',
      `  return ${symbol}({ prompt: opts.prompt });`,
      '}',
      '',
    ].join('\n');
    const result = scanExecCallSites([{ path: `/fx/${symbol}.js`, content }], { inMemory: true });
    assertEqual(result.outcome, 'found', `outcome for ${symbol}`);
    assertEqual(result.call_sites.length, 1, `call_sites.length for ${symbol}`);
    const hit = result.call_sites[0];
    assertEqual(hit.form, CALL_SITE_FORMS.REMOVED_SYMBOL, `form for ${symbol}`);
    assertEqual(hit.file, `/fx/${symbol}.js`, `file for ${symbol}`);
    assertEqual(hit.line, 2, `line for ${symbol}`);
  });
}

test('the literal string "codex exec" on a non-comment code line is a call site', () => {
  const result = scanExecCallSites(
    [{ path: '/fx/y.js', content: "const cmd = `codex exec --json ${prompt}`;\n" }],
    { inMemory: true }
  );
  assertEqual(result.outcome, 'found', 'outcome');
  assertEqual(result.call_sites[0].form, CALL_SITE_FORMS.EXEC_STRING, 'form');
});

// ── R3: call site vs prose — the two classes never collapse ────────────────

console.log('R3 — call site vs prose separation');

test('a markdown file describing "codex exec" reports clean with prose_mentions >= 1, never a call site', () => {
  const result = scanExecCallSites(
    [{ path: '/fx/doc.md', content: '# Transport\n\nThe old adapter used `codex exec` for review turns.\n' }],
    { inMemory: true }
  );
  assertEqual(result.outcome, 'clean', 'outcome — markdown is documentation, never executable');
  assertEqual(result.call_sites.length, 0, 'call_sites.length');
  assert(result.prose_mentions.length >= 1, 'expected >= 1 prose mention');
});

test('a JS comment mentioning "codex exec" is prose, not a call site', () => {
  const result = scanExecCallSites(
    [{ path: '/fx/z.js', content: "// legacy note: this used to shell out to codex exec\nfunction noop() {}\n" }],
    { inMemory: true }
  );
  assertEqual(result.outcome, 'clean', 'outcome');
  assert(result.prose_mentions.length >= 1, 'comment counted as prose');
});

test('a JS comment referencing a removed symbol name is prose, not a call site', () => {
  const result = scanExecCallSites(
    [{ path: '/fx/z2.js', content: "// codexSandboxArgs( used to build the sandbox flags\nfunction noop() {}\n" }],
    { inMemory: true }
  );
  assertEqual(result.outcome, 'clean', 'outcome');
  assert(result.prose_mentions.length >= 1, 'commented symbol reference counted as prose');
});

// Pins the DOCUMENTED fail-closed posture (S05 review R6): a string literal
// that merely mentions the retired spelling is deliberately a call site, not
// prose. The docstring at the top of forge-exec-callsites.js now says exactly
// this; if someone "fixes" the classifier to treat quoted text as prose, this
// test goes red and forces the docstring to be revisited with it — the two
// cannot drift apart in silence again.
test('a string literal merely MENTIONING "codex exec" is deliberately a call site (documented fail-closed posture)', () => {
  const result = scanExecCallSites(
    [{ path: '/fx/msg.js', content: 'const help = "use codex exec for details";\n' }],
    { inMemory: true }
  );
  assertEqual(result.outcome, 'found', 'outcome — fail-closed: a quoted mention is accused, never excused');
  assertEqual(result.call_sites.length, 1, 'call_sites.length');
  assertEqual(result.call_sites[0].form, CALL_SITE_FORMS.EXEC_STRING, 'form');
  assertEqual(result.call_sites[0].line, 1, 'line — the accusation names the exact line a human must look at');
});

test('the docstring documents the fail-closed string-literal posture (docstring/code drift guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-exec-callsites.js'), 'utf8');
  const head = src.slice(0, src.indexOf("const fs = require('fs')"));
  assert(/FAIL-CLOSED/.test(head), 'the docstring names the fail-closed posture');
  assert(/COMMENT LINES/.test(head), 'the docstring restricts the prose class to comment lines');
  assert(!/message\s*\n?\s*\*?\s*strings that merely MENTION/.test(head),
    'the old false promise (message strings that merely MENTION => prose) must be gone');
});

test('a bare "exec" literal with no nearby codex resolution context is neither a call site nor prose (noise)', () => {
  const result = scanExecCallSites(
    [{ path: '/fx/unrelated.js', content: "const mode = 'exec';\nfunction run() { return mode; }\n" }],
    { inMemory: true }
  );
  assertEqual(result.outcome, 'clean', 'outcome');
  assertEqual(result.call_sites.length, 0, 'call_sites.length');
});

// ── R4: anti-silence — scanned === 0 is scan-failed, never clean ───────────

console.log('R4 — anti-silence floor');

test('scanning zero in-memory records => scanned === 0 => outcome scan-failed, never clean', () => {
  const result = scanExecCallSites([], { inMemory: true });
  assertEqual(result.scanned, 0, 'scanned');
  assertEqual(result.outcome, 'scan-failed', 'outcome — zero-scanned must never read as clean');
});

test('a nonexistent root directory => scanned === 0 => outcome scan-failed', () => {
  const missing = absentPathUnder('nowhere-root-');
  const result = scanExecCallSites([missing]);
  assertEqual(result.scanned, 0, 'scanned');
  assertEqual(result.outcome, 'scan-failed', 'outcome');
  assert(result.skipped.some((s) => s.reason === SKIP_REASONS.ROOT_NOT_FOUND), 'root-not-found recorded');
});

test('an existing but empty root directory => scanned === 0 => outcome scan-failed', () => {
  const dir = mktmp('empty-root-');
  const result = scanExecCallSites([dir]);
  assertEqual(result.scanned, 0, 'scanned');
  assertEqual(result.outcome, 'scan-failed', 'outcome');
});

// ── R5: unreadable file lands in skipped, not silently dropped ─────────────

console.log('R5 — unreadable files are reported, not dropped');

test('a file that cannot be read (missing by the time it is opened) reports unreadable in skipped', () => {
  const dir = mktmp('unreadable-');
  const ghost = path.join(dir, 'ghost.js');
  // A record with no `content` key falls back to fs.readFileSync(path),
  // which fails for a path that never existed on disk — proving the
  // unreadable path without relying on chmod semantics (unreliable across
  // platforms/CI as root).
  const result = scanExecCallSites([{ path: ghost }], { inMemory: true });
  assertEqual(result.scanned, 0, 'scanned — unreadable file is not counted');
  assert(result.skipped.some((s) => s.path === ghost && s.reason === SKIP_REASONS.UNREADABLE), 'ghost.js recorded as unreadable');
});

// An unreadable DIRECTORY is a whole unscanned subtree — it can hold the very
// call site this scanner exists to prove absent. Before the fix, walk() caught
// the readdir failure and returned with no record: a root with a readable
// ok.js plus a chmod-000 subdir holding a real call site produced
// {"outcome":"clean","scanned":1,"call_sites":[],"skipped":[]} and exit 0 —
// false evidence of absence, indistinguishable from a genuine clean scan
// (S05 review R5).
//
// chmod 000 blocks neither Windows nor root, so a test that ran there would
// silently fail to bite — which IS the defect under repair. Named skip, never
// a silent return.
const CHMOD_BITES = process.platform !== 'win32'
  && !(typeof process.getuid === 'function' && process.getuid() === 0);

if (!CHMOD_BITES) {
  console.log('  ⊘ SKIPPED (unreadable-directory tests): chmod 000 does not block on '
    + (process.platform === 'win32' ? 'win32' : 'root') + ' — a test that cannot bite is the defect being fixed');
} else {
  test('an unreadable in-scope directory is recorded in skipped with reason unreadable', () => {
    const dir = mktmp('unreadable-dir-');
    fs.writeFileSync(path.join(dir, 'ok.js'), 'function noop() { return 1; }\n');
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'hidden.js'), EXEC_ARG_LINES + '\n');
    fs.chmodSync(locked, 0o000);
    try {
      const result = scanExecCallSites([dir]);
      assert(result.skipped.some((s) => s.path === locked && s.reason === SKIP_REASONS.UNREADABLE),
        `expected the locked dir in skipped with reason unreadable, got ${JSON.stringify(result.skipped)}`);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  test('an unreadable in-scope directory forces scan-failed, never clean (absence is not established)', () => {
    const dir = mktmp('unreadable-dir-outcome-');
    fs.writeFileSync(path.join(dir, 'ok.js'), 'function noop() { return 1; }\n');
    const locked = path.join(dir, 'locked');
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, 'hidden.js'), EXEC_ARG_LINES + '\n');
    fs.chmodSync(locked, 0o000);
    try {
      const result = scanExecCallSites([dir]);
      assert(result.scanned >= 1, 'the readable file was still scanned');
      assertEqual(result.outcome, 'scan-failed', 'outcome — a subtree was never opened, so "clean" would be a lie');
      const res = runCli(['--check', '--json', '--root', dir]);
      assertEqual(res.status, 2, 'CLI exit code — --check must not pass silently');
      assertEqual(JSON.parse(res.stdout).outcome, 'scan-failed', 'CLI outcome');
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });

  test('CONTROL: the same tree with the directory readable reaches clean and exit 0', () => {
    const dir = mktmp('unreadable-dir-control-');
    fs.writeFileSync(path.join(dir, 'ok.js'), 'function noop() { return 1; }\n');
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'also-ok.js'), 'function noop2() { return 2; }\n');
    const result = scanExecCallSites([dir]);
    assertEqual(result.outcome, 'clean', 'outcome — a fully readable tree with no call site is still clean');
    assertEqual(result.skipped.filter((s) => s.reason === SKIP_REASONS.UNREADABLE).length, 0, 'no unreadable skips');
    const res = runCli(['--check', '--json', '--root', dir]);
    assertEqual(res.status, 0, 'CLI exit code');
  });
}

// ── R6: CLI contract — exit codes, --json census, --root ───────────────────

console.log('R6 — CLI exit-code and --json contract');

test('CLI: fixture with a call site exits 2 and --json reports outcome found with file+line', () => {
  const dir = mktmp('cli-found-');
  fs.writeFileSync(path.join(dir, 'adapter.js'), EXEC_ARG_LINES + '\n');
  const res = runCli(['--check', '--json', '--root', dir]);
  assertEqual(res.status, 2, 'exit code');
  const parsed = JSON.parse(res.stdout);
  assertEqual(parsed.outcome, 'found', 'outcome');
  assert(parsed.call_sites.length >= 1, 'call_sites present');
  assert(parsed.call_sites[0].file.endsWith('adapter.js'), 'call site names the file');
  assert(Number.isInteger(parsed.call_sites[0].line), 'call site names a line');
});

test('CLI: clean fixture (>=1 scanned file, no call site) exits 0 with outcome clean', () => {
  const dir = mktmp('cli-clean-');
  fs.writeFileSync(path.join(dir, 'noop.js'), 'function noop() { return 1; }\n');
  const res = runCli(['--check', '--json', '--root', dir]);
  assertEqual(res.status, 0, 'exit code');
  const parsed = JSON.parse(res.stdout);
  assertEqual(parsed.outcome, 'clean', 'outcome');
  assert(parsed.scanned >= 1, 'scanned >= 1');
});

test('CLI: empty/nonexistent root exits 2 with outcome scan-failed — the anti-silence floor', () => {
  const missing = absentPathUnder('cli-nowhere-root-');
  const res = runCli(['--check', '--json', '--root', missing]);
  assertEqual(res.status, 2, 'exit code');
  const parsed = JSON.parse(res.stdout);
  assertEqual(parsed.outcome, 'scan-failed', 'outcome');
  assertEqual(parsed.scanned, 0, 'scanned');
});

test('CLI: prose-only markdown fixture exits 0, outcome clean, with prose_mentions >= 1', () => {
  const dir = mktmp('cli-prose-');
  fs.writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nThe legacy path called `codex exec` directly.\n');
  const res = runCli(['--check', '--json', '--root', dir]);
  assertEqual(res.status, 0, 'exit code');
  const parsed = JSON.parse(res.stdout);
  assertEqual(parsed.outcome, 'clean', 'outcome');
  assert(parsed.prose_mentions.length >= 1, 'prose_mentions present');
});

test('CLI: without --check, exits 2 with a usage message on stderr (no accidental scan)', () => {
  const res = runCli(['--json']);
  assertEqual(res.status, 2, 'exit code');
  assert(/usage/i.test(res.stderr), 'usage message on stderr');
});

test('CLI: a mixed-extension root reports skipped entries with named reasons in --json', () => {
  const dir = mktmp('cli-skipped-');
  fs.writeFileSync(path.join(dir, 'keep.js'), 'function noop() {}\n');
  fs.writeFileSync(path.join(dir, 'ignore.txt'), 'not scanned\n');
  const res = runCli(['--check', '--json', '--root', dir]);
  assertEqual(res.status, 0, 'exit code');
  const parsed = JSON.parse(res.stdout);
  const skip = parsed.skipped.find((s) => s.path.endsWith('ignore.txt'));
  assert(skip && skip.reason === 'extension-not-scanned', 'ignore.txt named with extension-not-scanned');
});

// ── R7: SCOPE — the widened reach, and the verdict that used to lie ────────
//
// Before the widening (S05 review R4) this was MEASURED: a `.sh` holding a
// literal `codex exec` produced `outcome: 'clean'` and exit 0. The skip was
// named in the census, but the top-line verdict a caller acts on still said
// clean — a census entry cannot rescue a false verdict. Each test below pairs
// the accusation with a control in the same shape, so a future narrowing of
// SCANNED_EXTENSIONS turns this red instead of turning it silent.

console.log('R7 — scope: shell/batch scripts, shebang files, top-level pass');

for (const [name, ext] of [['a shell script', '.sh'], ['a bash script', '.bash'], ['a PowerShell script', '.ps1'], ['a batch script', '.cmd']]) {
  test(`${name} (${ext}) containing "codex exec" is a CALL SITE, not a clean pass`, () => {
    const dir = mktmp(`scope-${ext.slice(1)}-`);
    const file = path.join(dir, `run${ext}`);
    fs.writeFileSync(file, `set -e\n${'codex'} exec --json "$PROMPT"\n`);
    const result = scanExecCallSites([dir]);
    assertEqual(result.outcome, 'found', `outcome for ${ext} — this returned 'clean' before the widening`);
    assertEqual(result.call_sites.length, 1, `call_sites.length for ${ext}`);
    assertEqual(result.call_sites[0].form, CALL_SITE_FORMS.EXEC_STRING, `form for ${ext}`);
    assertEqual(result.call_sites[0].line, 2, `line for ${ext} — the accusation names the line a human must open`);
    const res = runCli(['--check', '--json', '--root', dir]);
    assertEqual(res.status, 2, `CLI exit code for ${ext}`);
  });

  test(`CONTROL: the same ${ext} script without the retired spelling is clean and exits 0`, () => {
    const dir = mktmp(`scope-ctl-${ext.slice(1)}-`);
    fs.writeFileSync(path.join(dir, `run${ext}`), 'set -e\necho hello\n');
    const result = scanExecCallSites([dir]);
    assertEqual(result.outcome, 'clean', `outcome for clean ${ext}`);
    const res = runCli(['--check', '--json', '--root', dir]);
    assertEqual(res.status, 0, `CLI exit code for clean ${ext}`);
  });
}

test('an EXTENSION-LESS file with a #! shebang is scanned (this is how bin/* is spelled)', () => {
  const dir = mktmp('scope-shebang-');
  fs.writeFileSync(path.join(dir, 'forge-thing'), `#!/usr/bin/env bash\n${'codex'} exec --json\n`);
  const result = scanExecCallSites([dir]);
  assertEqual(result.outcome, 'found', 'outcome — a shebang script is executable scope');
  assertEqual(result.call_sites[0].form, CALL_SITE_FORMS.EXEC_STRING, 'form');
});

test('a comment line in a shell script is prose, not a call site (# is a comment opener there)', () => {
  const dir = mktmp('scope-sh-comment-');
  fs.writeFileSync(path.join(dir, 'run.sh'), `# legacy: this used to call ${'codex'} exec\necho hi\n`);
  const result = scanExecCallSites([dir]);
  assertEqual(result.outcome, 'clean', 'outcome');
  assert(result.prose_mentions.length >= 1, 'shell comment counted as prose');
});

test('an EXTENSION-LESS file with no shebang is skipped with the named reason not-a-script', () => {
  const dir = mktmp('scope-notscript-');
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT\n');
  fs.writeFileSync(path.join(dir, 'keep.js'), 'function noop() {}\n');
  const { files, skipped } = collectFiles(dir);
  assertEqual(files.length, 1, 'only keep.js is scanned');
  const skip = skipped.find((s) => s.path.endsWith('LICENSE'));
  assert(skip && skip.reason === SKIP_REASONS.NOT_A_SCRIPT, `LICENSE named with not-a-script, got ${JSON.stringify(skip)}`);
});

test('the shallow top-level pass reads root files and NAMES every subdirectory it did not descend into', () => {
  const dir = mktmp('scope-shallow-');
  fs.writeFileSync(path.join(dir, 'install.sh'), `${'codex'} exec --json\n`);
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dir, 'app', 'deep.js'), 'function noop() {}\n');
  const { files, skipped } = collectFiles(dir, { shallow: true });
  assertEqual(files.length, 1, 'only the top-level file is collected');
  assert(files[0].endsWith('install.sh'), 'the top-level script is the one collected');
  const dirSkip = skipped.find((s) => s.path.endsWith('app'));
  assert(dirSkip && dirSkip.reason === SKIP_REASONS.OUT_OF_SCOPE_DIR,
    `the undescended subdir is NAMED, never dropped, got ${JSON.stringify(skipped)}`);
});

test('the default CLI scope covers the repository top level (a root-level script is inside the census)', () => {
  const res = runCli(['--check', '--json', '--cwd', path.dirname(__dirname)]);
  const parsed = JSON.parse(res.stdout);
  const sawRootFile = parsed.skipped.some((s) => /forge-prefs\.schema\.json$/.test(s.path))
    || parsed.prose_mentions.some((m) => /\/(README|CLAUDE|CHANGELOG)\.md$/.test(m.file));
  assert(sawRootFile, 'the default scope must reach the repository top level, not only DEFAULT_ROOTS subtrees');
  assert(parsed.scanned > 0, 'scanned > 0');
});

test('the docstring advertises the widened scope (docstring/code drift guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'forge-exec-callsites.js'), 'utf8');
  const head = src.slice(0, src.indexOf("const fs = require('fs')"));
  assert(/SCOPE — WHAT THIS SCANNER LOOKS AT/.test(head), 'the docstring names its scope explicitly');
  assert(/shebang/.test(head), 'the docstring names the shebang rule');
});

// ── R8: the exec-arg predicate is FILE-SCOPED, not line-windowed ───────────
//
// Both failure modes of the old ±4-line window were reproduced live (S05
// review R7) and both are pinned here. The false negative is the dangerous
// half: a genuine call site reported clean is exactly the lie this scanner
// exists to make impossible.

console.log('R8 — file-scoped codex context (the ±4-line window, both directions)');

// The fixture is built so that NOTHING inside the old ±4-line window around the
// argv line vouches for codex — not the resolution, not the spawn, not even the
// word. A first attempt at this test put `spawnSync(codexBin, …)` one line below
// the argv line and stayed GREEN under a faithful revert of the old predicate,
// because the old window's own spawn tier caught it: the fixture proved the gate
// existed, not that distance had stopped mattering. Measured and corrected.
test('FALSE NEGATIVE, now bitten: a genuine call site whose window holds NO codex evidence at all is found', () => {
  const content = [
    'function build(prompt) {',                        // 1
    '  const bin = resolveCodexCommand();',            // 2  ← the only resolution
    '  const flags = [];',                             // 3
    '  if (prompt.json) flags.push("--json");',        // 4
    '  if (prompt.color) flags.push("--color");',      // 5
    '  if (prompt.quiet) flags.push("--quiet");',      // 6
    '  if (prompt.verbose) flags.push("--verbose");',  // 7
    '  const args = [' + JSON.stringify('exec') + '].concat(flags);', // 8 ← the call site
    '  const opts = { encoding: "utf8" };',            // 9
    '  const extra = prompt.extra || [];',             // 10
    '  const all = args.concat(extra);',               // 11
    '  const timeout = prompt.timeout || 0;',          // 12
    '  return runProcess(bin, all, opts, timeout);',   // 13
    '}',
    '',
  ].join('\n');
  const result = scanExecCallSites([{ path: '/fx/far.js', content }], { inMemory: true });
  assertEqual(result.outcome, 'found', 'outcome — distance from the resolution must not excuse a call site');
  assertEqual(result.call_sites.length, 1, 'call_sites.length');
  assertEqual(result.call_sites[0].form, CALL_SITE_FORMS.EXEC_ARG, 'form');
  assertEqual(result.call_sites[0].line, 8, 'line — the exact argv line, not the resolution line');
});

test('FALSE POSITIVE, now excused: an unrelated \'exec\' beside spawn(), with codex only in a COMMENT, is clean', () => {
  const content = [
    "const mode = 'exec';",
    '// nothing to do with codex here — historical note only',
    "spawnSync('ls', []);",
    '',
  ].join('\n');
  const result = scanExecCallSites([{ path: '/fx/fp.js', content }], { inMemory: true });
  assertEqual(result.outcome, 'clean', 'outcome — a COMMENT can no longer vouch for executable codex context');
  assertEqual(result.call_sites.length, 0, 'call_sites.length');
});

test('codex context via the (codex word + spawn) tier still bites, both on non-comment lines', () => {
  const content = [
    "const bin = process.env.MY_CODEX_BIN;",
    "const args = [" + JSON.stringify('exec') + "];",
    'spawnSync(bin, args);',
    '',
  ].join('\n');
  const result = scanExecCallSites([{ path: '/fx/tier2.js', content }], { inMemory: true });
  assertEqual(result.outcome, 'found', 'outcome');
  assertEqual(result.call_sites[0].form, CALL_SITE_FORMS.EXEC_ARG, 'form');
});

test('hasCodexContext is exported and reports the two tiers and their absence', () => {
  const { hasCodexContext } = require('./forge-exec-callsites.js');
  assertEqual(hasCodexContext(['const b = resolveCodexCommand();']), true, 'tier (i): resolution');
  assertEqual(hasCodexContext(['const b = codexBin;', 'spawn(b, []);']), true, 'tier (ii): codex word + spawn');
  assertEqual(hasCodexContext(['// codex lived here', "spawn('ls', []);"]), false, 'a comment never establishes context');
  assertEqual(hasCodexContext(["spawn('ls', []);"]), false, 'spawn alone is not codex context');
});

// ── Cleanup + report ──────────────────────────────────────────────────────

cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
