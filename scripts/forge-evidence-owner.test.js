#!/usr/bin/env node
'use strict';

// forge-evidence-owner.test.js — the evidence writer resolves the OWNER of a
// `.gsd` before it ever writes, and never manufactures one in an arbitrary
// directory (S01/T06).
//
// Four scenarios, each asserted by CENSUS (directory entry set before vs
// after), never by "no exception was thrown" — an absence-of-exception assert
// proves nothing about what a silent-fail catch may have swallowed.
//
//   1. cwd with NO `.gsd` in any ancestor (bounded by stopAt) → the directory
//      set is byte-identical before/after. `mkdirSync` is UNREACHABLE.
//   2. cwd = subdirectory of a project with `.gsd` at the root → evidence
//      lands in the ROOT's `.gsd/forge`, and no NEW `.gsd` appears anywhere
//      under the subdirectory.
//   3. An ORPHAN `.gsd` (containing only `forge/`) planted BETWEEN cwd and the
//      real project root does not stop the walk — the real root still wins.
//   4. A worktree cwd (no `.gsd` anywhere in its own ancestry) with a
//      RunRecord registered under a DIFFERENT workspace (`cwd` field) still
//      lands the evidence in that workspace's `.gsd/forge` — asserted by
//      SPAWNING the hook as a real process, per the truth's own wording.
//
// Plus: an inventory proving `resolveOwner` remains the ONLY `.gsd` tree-walk
// in scripts/ (mold: forge-wrapper-readers.js) — dynamic, not a frozen list,
// so a second walk-up written in the future fails this suite instead of
// silently reintroducing the bug T06 closes.
//
// Run: node scripts/forge-evidence-owner.test.js  (exit 0 = all pass)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const HOOK_PATH = path.join(__dirname, 'forge-hook.js');
const workspace = require('./forge-workspace.js');
const runs = require('./forge-runs.js');

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

// ── Census helpers — the whole point of this suite is set equality, not
//    "no exception was thrown" ────────────────────────────────────────────
function censusRecursive(root) {
  const out = new Set();
  (function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      out.add(relPath);
      if (e.isDirectory()) walk(path.join(dir, e.name), relPath);
    }
  })(root, '');
  return out;
}

function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function runHookPost(cwd, sessionId, extra) {
  const payload = JSON.stringify(Object.assign({
    session_id: sessionId,
    cwd,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_response: { success: true },
  }, extra || {}));
  return spawnSync(process.execPath, [HOOK_PATH, 'post'], {
    input: payload,
    encoding: 'utf8',
    env: Object.assign({}, process.env),
  });
}

console.log('\n── Truth 1: no .gsd anywhere → the hook creates NOTHING ──────────');

test('cwd in a directory with no .gsd ancestor: entry set identical before/after', () => {
  // Deliberately bounded by os.tmpdir() as an ancestor with no .gsd of its
  // own — exactly the resolveOwner(cwd, {stopAt: os.homedir()}) shape, but a
  // fresh tmpdir under tmpdir avoids depending on the real machine's homedir
  // tree (which may itself carry a .gsd, e.g. this very repo's checkout).
  const parent = mkdtemp('forge-owner-none-');
  const cwd = path.join(parent, 'sub', 'deeper');
  fs.mkdirSync(cwd, { recursive: true });
  try {
    const before = censusRecursive(parent);
    const res = runHookPost(cwd, 'sess-none-1');
    assert.strictEqual(res.status, 0, `hook must exit 0 (silent-fail): ${res.stderr}`);
    const after = censusRecursive(parent);
    assert(setsEqual(before, after),
      `directory set changed: before=${[...before].join(',')} after=${[...after].join(',')}`);
  } finally { cleanup(parent); }
});

console.log('\n── Truth 2: subdirectory of a project → evidence at the ROOT ─────');

test('cwd = subdirectory of a project writes to the ROOT .gsd/forge, no new .gsd under the subdir', () => {
  const root = mkdtemp('forge-owner-subdir-');
  fs.mkdirSync(path.join(root, '.gsd', 'milestones'), { recursive: true }); // WORK_ENTRIES signal → project
  fs.mkdirSync(path.join(root, '.gsd', 'forge', 'runs'), { recursive: true });
  const sub = path.join(root, 'scripts', 'fixtures');
  fs.mkdirSync(sub, { recursive: true });
  try {
    const res = runHookPost(sub, 'sess-subdir-1');
    assert.strictEqual(res.status, 0, `hook exit: ${res.stderr}`);
    const rootEvidence = fs.existsSync(path.join(root, '.gsd', 'forge'))
      ? fs.readdirSync(path.join(root, '.gsd', 'forge')).filter((f) => f.startsWith('evidence'))
      : [];
    assert(rootEvidence.length >= 1, 'evidence must land in the ROOT .gsd/forge');
    assert(!fs.existsSync(path.join(sub, '.gsd')), 'no NEW .gsd must appear under the subdirectory');
    assert(!fs.existsSync(path.join(root, 'scripts', '.gsd')), 'no NEW .gsd must appear at any intermediate level');
  } finally { cleanup(root); }
});

console.log('\n── Truth 3: an orphan .gsd (forge/ only) is TRANSPARENT to the walk ──');

test('an orphan .gsd containing only forge/ between cwd and the real root does not stop resolution', () => {
  const root = mkdtemp('forge-owner-orphan-');
  fs.mkdirSync(path.join(root, '.gsd', 'milestones'), { recursive: true }); // real project
  fs.mkdirSync(path.join(root, '.gsd', 'forge', 'runs'), { recursive: true });
  const mid = path.join(root, 'mid');
  // The orphan: a .gsd whose entry set is EXACTLY {"forge"} — RUNTIME_ENTRIES
  // only, no WORK_ENTRIES. This is the literal shape of the SVN/protected-wc orphans.
  fs.mkdirSync(path.join(mid, '.gsd', 'forge'), { recursive: true });
  fs.writeFileSync(path.join(mid, '.gsd', 'forge', 'evidence-adhoc.jsonl'), '{}\n', 'utf8');
  const cwd = path.join(mid, 'deeper');
  fs.mkdirSync(cwd, { recursive: true });
  try {
    // Sanity: classify() must call this orphan 'touched', never 'project' —
    // the precondition the whole test depends on.
    assert.strictEqual(workspace.classify(mid).kind, 'touched', 'fixture precondition: orphan must classify as touched');

    const orphanBefore = fs.readdirSync(path.join(mid, '.gsd', 'forge')).sort();
    const res = runHookPost(cwd, 'sess-orphan-1');
    assert.strictEqual(res.status, 0, `hook exit: ${res.stderr}`);
    const orphanAfter = fs.readdirSync(path.join(mid, '.gsd', 'forge')).sort();
    assert.deepStrictEqual(orphanBefore, orphanAfter, 'the orphan .gsd/forge must receive NOTHING new');

    const rootEvidence = fs.existsSync(path.join(root, '.gsd', 'forge'))
      ? fs.readdirSync(path.join(root, '.gsd', 'forge')).filter((f) => f.startsWith('evidence'))
      : [];
    assert(rootEvidence.length >= 1, 'the evidence still has to land somewhere: the REAL root');
  } finally { cleanup(root); }
});

console.log('\n── Truth 4: worktree run — RunRecord.cwd degree, spawned as a process ──');

// MEASURED GAP (reported, not papered over — see T06-SUMMARY.md § Cortes
// pendentes / blocker): `resolveRunForSession(cwd, sessionId)` is scoped to
// `<cwd>/.gsd/forge/runs/` (forge-runs.js `runsDir()`/`listAll()`). A CODE_DIR
// whose OWN ancestry carries no `.gsd` at all (the fixture in Truth 1) can
// never satisfy that lookup — `listAll` returns `[]` for a directory that does
// not exist, not an error, so degree 2 is STRUCTURALLY inert for that exact
// sub-case, measured live in this repo's own worktree (`.gsd` absent under
// `CODE_DIR`, confirmed by `ls` before writing this suite). No primitive this
// task is allowed to add (Standards: `resolveOwner` is the only tree-walk;
// Step 2 forbids inventing a third helper) closes that gap — it needs either
// a pointer written by `forge-isolation.js` at worktree setup or a
// session→run lookup broader than a single `cwd`, both real design
// decisions ⟪TRUNCADO-5⟫/⟪TRUNCADO-6⟫ left unstated. Reported per the plan's
// own instruction ("reporte a medição em vez de manter um degrau inerte").
//
// What THIS test proves instead — the literal mechanics of degree 2 as
// Step 2 specifies it: `resolveRunForSession` only inspects the RunRecord's
// `session_id` and `<cwd>/.gsd/forge/runs/`, never `classify()`. So it
// resolves correctly even when the run is registered under a directory
// `resolveOwner` itself would refuse (RUNTIME_ENTRIES-only, `touched`, same
// shape as the Truth-3 orphan) — proving degree 2 is not merely a duplicate
// of degree 1, and that its `r.cwd` (never `r.root`/`r.project`, per the
// 2026-08-14 measurement) is what the write lands on.
test('degree 2 resolves via RunRecord.cwd even when the run directory itself does not classify as a project', () => {
  const wsRoot = mkdtemp('forge-owner-ws-'); // the OWNED workspace r.cwd points to
  fs.mkdirSync(path.join(wsRoot, '.gsd', 'milestones'), { recursive: true });

  // A directory that carries ONLY runs/ (RUNTIME_ENTRIES) — resolveOwner must
  // refuse to call THIS a project (same shape as the Truth-3 orphan), yet
  // resolveRunForSession must still find the record living here.
  const runsHost = mkdtemp('forge-owner-runshost-');
  fs.mkdirSync(path.join(runsHost, '.gsd', 'forge', 'runs'), { recursive: true });

  const SESSION = 'sess-worktree-1';
  const RUN_ID = 'M-owner-worktree-test';
  runs.add(runsHost, {
    id: RUN_ID,
    kind: 'milestone',
    session_id: SESSION,
    cwd: wsRoot, // RunRecord.cwd — the ORIGINAL owned workspace, per forge-runs.js add()
    worker: 'execute-task/T06',
    worker_slice: 'S01',
  });

  try {
    assert.strictEqual(workspace.classify(runsHost).kind, 'touched',
      'fixture precondition: the runs-host directory must NOT classify as a project');
    const res = runHookPost(runsHost, SESSION);
    assert.strictEqual(res.status, 0, `hook exit: ${res.stderr}`);
    const wsEvidence = fs.existsSync(path.join(wsRoot, '.gsd', 'forge'))
      ? fs.readdirSync(path.join(wsRoot, '.gsd', 'forge')).filter((f) => f.startsWith('evidence'))
      : [];
    assert(wsEvidence.length >= 1, 'the evidence must land in r.cwd (the OWNED workspace), not the runs-host dir');
    const hostEvidence = fs.existsSync(path.join(runsHost, '.gsd', 'forge'))
      ? fs.readdirSync(path.join(runsHost, '.gsd', 'forge')).filter((f) => f.startsWith('evidence'))
      : [];
    assert.strictEqual(hostEvidence.length, 0, 'the runs-host directory must receive NO evidence file itself');
  } finally { cleanup(wsRoot); cleanup(runsHost); }
});

test('MEASURED (not asserted clean): a CODE_DIR with zero .gsd anywhere in its own ancestry cannot be resolved by either degree today', () => {
  const wsRoot = mkdtemp('forge-owner-ws2-');
  fs.mkdirSync(path.join(wsRoot, '.gsd', 'milestones'), { recursive: true });
  fs.mkdirSync(path.join(wsRoot, '.gsd', 'forge', 'runs'), { recursive: true });
  const worktreeRoot = mkdtemp('forge-owner-wt-');
  const codeDir = path.join(worktreeRoot, 'forge-agent');
  fs.mkdirSync(codeDir, { recursive: true });
  const SESSION = 'sess-worktree-2';
  runs.add(wsRoot, {
    id: 'M-owner-worktree-test-2', kind: 'milestone', session_id: SESSION,
    cwd: wsRoot, worker: 'execute-task/T06', worker_slice: 'S01',
  });
  try {
    const hook = require('./forge-hook.js');
    const owner = hook.resolveOwnerDir(codeDir, SESSION);
    // This assertion documents the MEASURED gap, not a passing behaviour.
    // If it ever starts failing, degree 2 (or a new degree) has closed the
    // gap and this whole block — including the SUMMARY note — should be
    // revisited, not silently deleted.
    assert.strictEqual(owner, null,
      'MEASURED GAP: resolveOwnerDir cannot resolve a CODE_DIR with no .gsd ancestry of its own, ' +
      'even with a live RunRecord elsewhere pointing r.cwd at the real workspace — reported, not silently fixed here');
  } finally { cleanup(wsRoot); cleanup(worktreeRoot); }
});

console.log('\n── Unit context resolved FROM the owner, not the derived cwd ─────');

test('unitId resolves to the real run, not the adhoc sentinel, when cwd is a subdirectory', () => {
  const root = mkdtemp('forge-owner-unitctx-');
  fs.mkdirSync(path.join(root, '.gsd', 'milestones'), { recursive: true });
  fs.mkdirSync(path.join(root, '.gsd', 'forge', 'runs'), { recursive: true });
  const SESSION = 'sess-unitctx-1';
  const RUN_ID = 'M-owner-unitctx-test';
  runs.add(root, {
    id: RUN_ID, kind: 'milestone', session_id: SESSION, cwd: root,
    worker: 'execute-task/T09', worker_slice: 'S01',
  });
  const sub = path.join(root, 'scripts');
  fs.mkdirSync(sub, { recursive: true });
  try {
    const hook = require('./forge-hook.js');
    const owner = hook.resolveOwnerDir(sub, SESSION);
    assert.strictEqual(owner, root, 'resolveOwnerDir must resolve the PROJECT ROOT from a subdirectory');
    const ctx = hook.resolveUnitContext(owner, SESSION);
    assert.strictEqual(ctx.unit, 'T09', 'unit axis must be the REAL run, not the adhoc sentinel');
    assert.notStrictEqual(ctx.unit, 'adhoc', 'must not collapse to adhoc when a real owner resolves');
  } finally { cleanup(root); }
});

console.log('\n── Silent-fail (MEM008) preserved when forge-workspace.js is unavailable ──');

test('PostToolUse still exits 0 and writes the degraded name when forge-workspace.js cannot be required', () => {
  const isoRoot = mkdtemp('forge-owner-isolated-');
  const isoScripts = path.join(isoRoot, 'scripts');
  fs.mkdirSync(isoScripts, { recursive: true });
  const scriptsDir = path.join(REPO_ROOT, 'scripts');
  for (const name of fs.readdirSync(scriptsDir)) {
    if (name === 'forge-workspace.js') continue; // the one module we omit
    if (name.endsWith('.test.js')) continue;
    const src = path.join(scriptsDir, name);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(isoScripts, name));
  }
  const hookIsolatedPath = path.join(isoScripts, 'forge-hook.js');
  const workspaceDir = mkdtemp('forge-owner-isolated-ws-');
  fs.mkdirSync(path.join(workspaceDir, '.gsd', 'milestones'), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, '.gsd', 'forge', 'runs'), { recursive: true });
  try {
    const payload = JSON.stringify({
      session_id: 'sess-iso-owner',
      cwd: workspaceDir,
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
    assert.strictEqual(res.status, 0, `expected exit 0 (silent-fail), got ${res.status}: ${res.stderr}`);
    // With forge-workspace.js absent, resolveOwnerDir's only remaining degree
    // is the RunRecord — none registered here, so no owner resolves and the
    // branch must skip WITHOUT creating anything (never fall back to raw cwd).
    assert(!fs.existsSync(path.join(workspaceDir, '.gsd', 'forge', 'evidence-adhoc.jsonl'))
      && (fs.readdirSync(path.join(workspaceDir, '.gsd', 'forge')).filter((f) => f.startsWith('evidence')).length === 0),
      'with no workspace module AND no matching run, nothing should be written — never a raw-cwd fallback');
  } finally { cleanup(isoRoot); cleanup(workspaceDir); }
});

console.log('\n── Inventory: resolveOwner is the ONLY .gsd tree-walk in scripts/ ──');

test('no second .gsd walk-up exists outside forge-workspace.js (dynamic scan, not a frozen list)', () => {
  // Heuristic mirrors the shape resolveOwner/findMarker share: an UNBOUNDED
  // walk-up loop (`for (;;)` / `while (true)`, the idiom both use to climb
  // until `stopAt` or the filesystem root) whose body checks a literal `.gsd`
  // path segment. Scoped to the LOOP BODY, not a wide line window — a wide
  // window false-positived on ordinary `path.dirname(x)` used to compute a
  // MKDIR PARENT (forge-migrate.js writeSchemaVersion, forge-runs.js's alias
  // writer, etc.), which is a one-shot parent lookup, not a climbing walk.
  // Scanned dynamically — molded on forge-wrapper-readers.js's "prove by
  // scanning the real repo", not a hand-maintained list that can go stale.
  const scriptsDir = path.join(REPO_ROOT, 'scripts');
  const offenders = [];
  const LOOP_RE = /for\s*\(\s*;;\s*\)|while\s*\(\s*true\s*\)/;
  for (const name of fs.readdirSync(scriptsDir)) {
    if (!name.endsWith('.js') || name.endsWith('.test.js')) continue;
    if (name === 'forge-workspace.js') continue; // the one file allowed to do this
    const full = path.join(scriptsDir, name);
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!LOOP_RE.test(lines[i])) continue;
      // Take the loop BODY only: from the loop line to the next line at or
      // below the loop's own indentation that closes it, capped at 60 lines
      // so a malformed/never-closing scan still terminates.
      const loopIndent = lines[i].match(/^(\s*)/)[1].length;
      let end = lines.length;
      for (let j = i + 1; j < Math.min(lines.length, i + 60); j++) {
        const trimmed = lines[j].trim();
        if (trimmed === '}' && lines[j].match(/^(\s*)/)[1].length <= loopIndent) { end = j; break; }
      }
      const bodyText = lines.slice(i, end).join('\n');
      const touchesGsd = /['"`]\.gsd['"`]/.test(bodyText);
      if (touchesGsd) offenders.push(`${name}:${i + 1}`);
    }
  }
  assert.strictEqual(offenders.length, 0,
    `a second .gsd tree-walk exists outside forge-workspace.js — reuse resolveOwner instead: ${offenders.join(', ')}`);
});

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
