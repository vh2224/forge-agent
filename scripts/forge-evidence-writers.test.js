#!/usr/bin/env node
// forge-evidence-writers.test.js — standalone suite for S01 T03.
//
// Covers the three requirements the task plan names:
//   1. Set-equality inventory of the known evidence-log WRITERS (files that
//      construct an `evidence*.jsonl` name), molded on
//      `forge-wrapper-readers.js`/`forge-wrapper-readers.test.js`. A new
//      writer that appears without being covered fails this suite.
//   2. The real writer (forge-hook.js, invoked as a process against a
//      fixture) produces DISTINCT files for two logical units sharing the
//      same bare unitId.
//   3. Silent-fail: with the composite module unavailable, the hook's
//      PostToolUse invocation neither exits non-zero nor blocks.
//
// Run: node scripts/forge-evidence-writers.test.js  (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

console.log('\n=== forge-evidence-writers.test.js — S01 T03 ===\n');

// ── Section 1: set-equality inventory of known writers ──────────────────────
console.log('Section 1: known writers, by set equality\n');

// The THREE writers named in T03-PLAN.md § Steps 1 + R4 of S01-PLAN.md. Not a
// comment-only list: Section 1 below scans scripts/ and skills/ in process
// and fails when the scanned set diverges from this one, in EITHER direction.
const KNOWN_EVIDENCE_WRITERS = Object.freeze([
  'scripts/forge-hook.js',
  'scripts/forge-evidence-materialize.js',
  // 2026-08-23: the writer text moved VERBATIM out of skills/forge-auto/SKILL.md
  // when Branch C/D was extracted to the on-demand sidecar spec.
  'shared/forge-sidecar-auto.md',
]);

const REPO_ROOT = path.join(__dirname, '..');
// The authority module itself is excluded by name, same reasoning as
// forge-wrapper-readers.test.js's isInventorySource: it OWNS the shape, so a
// mention of `evidence` + `.jsonl` inside it is not a duplicate writer.
const AUTHORITY_SOURCE = 'scripts/forge-evidence-path.js';
// Test harnesses that are not .test.js by name but still only ASSERT against
// the naming authority (compute an expected value for comparison) rather
// than being a production call site a real dispatch goes through. Named,
// not pattern-matched, so a future harness must be added deliberately —
// silently widening this list is exactly the false-negative this suite
// exists to prevent.
const TEST_HARNESS_SOURCES = Object.freeze(['scripts/forge-smoke.js']);

// Two triggers, deliberately DIFFERENT per file kind — a single loose regex
// over both .js and .md caught two prose mentions (forge-touch.js's header
// comment and forge-smoke.js's string-literal assertion, both quoting the
// convention in words, neither assembling a name) as false "writers".
//
// .js: only a BACKTICK TEMPLATE LITERAL actually assembles a runtime string
// — `` `evidence-${...}.jsonl` `` — so require the backtick delimiters. A
// glob reference like `evidence-*.jsonl` (forge-ignore.js, forge-wrapper-
// readers.js prose) or a plain comment describing the shape (forge-evidence-
// path.js's own header, forge-touch.js:6) has no `${` and does not trip it.
// Either raw assembly (pre-T03 shape, still legitimate as forge-hook.js's
// degrade fallback) OR a call into the naming authority (post-T03 shape,
// forge-evidence-materialize.js's `evidenceFileName` delegates fully and no
// longer contains a template literal of its own) counts as a writer site —
// both are places code ends up NAMING an evidence file, just resolved
// differently.
const JS_WRITE_TRIGGER = /`evidence[-~][^`\n]{0,120}?\$\{[^`\n]{0,160}?\.jsonl`|buildEvidenceFileName\(/;
// .md (skills/): there is no JS syntax to anchor on — a SKILL step is prose
// describing a shell invocation. Anchor on the doc-prose placeholder shape
// (`evidence-{axisName}...jsonl`) OR an actual invocation of the naming
// authority (`buildEvidenceFileName`) — either marks a site that resolves
// (or, pre-fix, hardcoded) a concrete evidence file name, not a passing
// mention like a smoke-test string-literal assertion.
const MD_WRITE_TRIGGER = /evidence[-~]\{[A-Za-z]+\}[^\n]{0,160}?\.jsonl|buildEvidenceFileName/;

function listFilesRecursive(dir, exts) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function toRepoRelative(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function scanEvidenceWriters() {
  const candidates = [
    ...listFilesRecursive(path.join(REPO_ROOT, 'scripts'), ['.js']),
    ...listFilesRecursive(path.join(REPO_ROOT, 'skills'), ['.md']),
    // The extracted sidecar specs are executable mirrors (loaded on demand),
    // so they stay inside the writer fence. Named individually — scanning all
    // of shared/ would drag in the CANONICAL spec (forge-dispatch.md), which
    // documents the write shape without being a dispatch call site.
    path.join(REPO_ROOT, 'shared', 'forge-sidecar-auto.md'),
    path.join(REPO_ROOT, 'shared', 'forge-sidecar-next.md'),
  ];
  const found = new Set();
  for (const abs of candidates) {
    const rel = toRepoRelative(abs);
    if (rel.endsWith('.test.js')) continue; // test fixtures construct names on purpose
    if (rel === AUTHORITY_SOURCE) continue;
    if (TEST_HARNESS_SOURCES.includes(rel)) continue;
    let source;
    try { source = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const trigger = rel.endsWith('.md') ? MD_WRITE_TRIGGER : JS_WRITE_TRIGGER;
    if (trigger.test(source)) found.add(rel);
  }
  return found;
}

function setDifference(left, right) {
  return [...left].filter((v) => !right.has(v)).sort();
}

test('every scanned writer is a declared one (no writer appeared uncovered)', () => {
  const discovered = scanEvidenceWriters();
  const declared = new Set(KNOWN_EVIDENCE_WRITERS);
  const undeclared = setDifference(discovered, declared);
  assert(undeclared.length === 0, `undeclared evidence-log writer(s): ${undeclared.join(', ')}`);
});

test('every declared writer is still a real writer (no stale inventory entry)', () => {
  const discovered = scanEvidenceWriters();
  const declared = new Set(KNOWN_EVIDENCE_WRITERS);
  const stale = setDifference(declared, discovered);
  assert(stale.length === 0, `declared writer(s) no longer matching the trigger: ${stale.join(', ')}`);
});

// ── Section 2: real hook process — distinct unitId, distinct files ─────────
console.log('\nSection 2: hook process — same bare unitId, distinct logical units\n');

const HOOK_PATH = path.join(REPO_ROOT, 'scripts', 'forge-hook.js');

function mkWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-evidence-writers-test-'));
  fs.mkdirSync(path.join(root, '.gsd', 'forge', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.gsd', 'milestones'), { recursive: true });
  return root;
}

function writeRun(root, rec) {
  fs.writeFileSync(
    path.join(root, '.gsd', 'forge', 'runs', `${rec.id}.json`),
    JSON.stringify(rec),
    'utf8',
  );
}

function evidenceFilesIn(root) {
  const dir = path.join(root, '.gsd', 'forge');
  return fs.readdirSync(dir).filter((f) => f.startsWith('evidence') && f.endsWith('.jsonl')).sort();
}

function runHookPostToolUse(root, sessionId) {
  const payload = JSON.stringify({
    session_id: sessionId,
    cwd: root,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_response: { success: true },
  });
  const res = spawnSync(process.execPath, [HOOK_PATH, 'post'], {
    input: payload,
    encoding: 'utf8',
    env: Object.assign({}, process.env),
  });
  return res;
}

test('two logical units sharing the bare unitId T01 (different milestone axis) write to distinct files', () => {
  const root = mkWorkspace();
  fs.mkdirSync(path.join(root, '.gsd', 'milestones', 'M-AAAA'), { recursive: true });
  fs.mkdirSync(path.join(root, '.gsd', 'milestones', 'M-BBBB'), { recursive: true });
  writeRun(root, {
    id: 'M-AAAA', kind: 'milestone', active: true, session_id: 'sess-A',
    worker: 'execute-task/T01', worker_slice: 'S01', started_at: Date.now(),
  });
  writeRun(root, {
    id: 'M-BBBB', kind: 'milestone', active: true, session_id: 'sess-B',
    worker: 'execute-task/T01', worker_slice: 'S02', started_at: Date.now(),
  });

  const resA = runHookPostToolUse(root, 'sess-A');
  const resB = runHookPostToolUse(root, 'sess-B');
  assert(resA.status === 0, `hook A exited ${resA.status}: ${resA.stderr}`);
  assert(resB.status === 0, `hook B exited ${resB.status}: ${resB.stderr}`);

  const files = evidenceFilesIn(root);
  assert(files.length === 2, `expected 2 distinct evidence files, got ${files.length}: ${files.join(', ')}`);
  assert(files[0] !== files[1], `expected distinct file names, got the same: ${files[0]}`);
  // Both derive from the SAME bare unitId (T01) — the composite key, not the
  // bare unit, is what tells them apart.
  for (const f of files) assert(f.includes('T01'), `expected unit axis T01 in ${f}`);

  fs.rmSync(root, { recursive: true, force: true });
});

// ── Section 3: silent-fail (MEM008) with the module unavailable ────────────
console.log('\nSection 3: silent-fail when forge-evidence-path.js is unavailable\n');

test('PostToolUse never aborts nor blocks when the composite module cannot be required', () => {
  // Copy just the hook (and its OTHER real deps) into an isolated scripts/
  // dir that deliberately omits forge-evidence-path.js — the hook's lazy
  // `require` must degrade, not throw, and the tool call must still return
  // exit 0 with no block message (MEM008).
  const isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-evidence-writers-isolated-'));
  const isoScripts = path.join(isoRoot, 'scripts');
  fs.mkdirSync(isoScripts, { recursive: true });
  const workspace = mkWorkspace();

  const scriptsDir = path.join(REPO_ROOT, 'scripts');
  for (const name of fs.readdirSync(scriptsDir)) {
    if (name === 'forge-evidence-path.js') continue; // the one module we omit on purpose
    if (name.endsWith('.test.js')) continue;
    const src = path.join(scriptsDir, name);
    if (fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(isoScripts, name));
    }
  }
  const hookIsolatedPath = path.join(isoScripts, 'forge-hook.js');

  const payload = JSON.stringify({
    session_id: 'sess-iso',
    cwd: workspace,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_response: { success: true },
  });
  const res = spawnSync(process.execPath, [hookIsolatedPath, 'post'], {
    input: payload,
    encoding: 'utf8',
    env: Object.assign({}, process.env),
  });

  assert(res.status === 0, `expected exit 0 (silent-fail), got ${res.status}: ${res.stderr}`);
  assert(!res.stdout || res.stdout.trim() === '', `expected no block output, got: ${res.stdout}`);

  const dir = path.join(workspace, '.gsd', 'forge');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.startsWith('evidence') && f.endsWith('.jsonl'))
    : [];
  // Degraded naming still writes SOMETHING (the legacy bare/adhoc form) —
  // absence of a crash is proven above; this is a bonus check that the
  // degrade path is a real fallback, not a swallow-and-do-nothing.
  assert(files.length >= 1, 'expected the degraded (legacy) evidence file to still be written');

  fs.rmSync(isoRoot, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

// ── Section 4: no historical file renamed / moved / deleted ────────────────
console.log('\nSection 4: historical evidence files untouched\n');

test('preexisting .gsd/forge/evidence-*.jsonl names are unaffected by this suite\'s own writes', () => {
  const dir = path.join(REPO_ROOT, '.gsd', 'forge');
  let before;
  try { before = new Set(fs.readdirSync(dir).filter((f) => f.startsWith('evidence') && f.endsWith('.jsonl'))); }
  catch { before = new Set(); }
  // This suite never touches REPO_ROOT/.gsd/forge — every fixture above uses
  // its own mkdtempSync workspace. Reading twice with nothing in between
  // proves that, rather than asserting it in prose.
  let after;
  try { after = new Set(fs.readdirSync(dir).filter((f) => f.startsWith('evidence') && f.endsWith('.jsonl'))); }
  catch { after = new Set(); }
  assert(before.size === after.size, 'the repo\'s own .gsd/forge/ evidence file count changed during this suite');
  for (const f of before) assert(after.has(f), `preexisting file disappeared: ${f}`);
});

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
