#!/usr/bin/env node
// Suite for T03: the resource clamp indicator on the statusline.
//
// Spawns `forge-statusline.js` as a real process with JSON on stdin — the
// same idiom forge-smoke.js already uses for the statusline (see
// `runScript`/prefs-cutover section around line 5953) — because the render
// path's zero-spawn requirement and the MEM008 silent-fail posture are both
// process-boundary properties: they only mean something proved against the
// actual child process output, not against an in-process require.
//
// Run in isolation only (Standards § Proibido): never invoked from
// forge-smoke.js / run-tests.js.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = __dirname;
const STATUSLINE = path.join(SCRIPTS, 'forge-statusline.js');

let passed = 0;
let failed = 0;

function assert(cond, label, detail) {
  if (cond) {
    passed += 1;
    process.stdout.write(`  ok - ${label}\n`);
  } else {
    failed += 1;
    process.stdout.write(`  FAIL - ${label}${detail ? `\n    ${detail}` : ''}\n`);
  }
}

function mkTmp(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `forge-statusline-res-${label}-`));
  fs.mkdirSync(path.join(dir, '.gsd', 'forge'), { recursive: true });
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// Injects a per-test pool root (FORGE_RESOURCE_POOL_DIR) so the suite never
// touches the real machine-wide pool (Standards § Proibido: "tocar o pool
// real").
function runStatusline(cwd, poolDir, extraEnv) {
  const input = JSON.stringify({
    cwd,
    model: { display_name: 'test-model' },
    context_window: { used_percentage: 1 },
  });
  const env = {
    ...process.env,
    FORGE_RESOURCE_POOL_DIR: poolDir,
    ...(extraEnv || {}),
  };
  const r = spawnSync(process.platform === 'win32' ? 'node.exe' : 'node', [STATUSLINE], {
    input,
    encoding: 'utf8',
    env,
    cwd: SCRIPTS,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

function appendEvent(gsdDir, obj) {
  const file = path.join(gsdDir, 'forge', 'events.jsonl');
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

// Grants a held slot in a fresh pool root via the real pool module — the
// same code path production uses, not a hand-authored lease file.
function grantHeldSlot(poolDir) {
  const { acquireSlots } = require('./forge-resource-pool.js');
  return acquireSlots(1, { poolDir, ncpu: 4, commandTimeoutMs: 120000, ownerToken: 'test-owner' });
}

process.stdout.write('forge-statusline-resources.test.js\n');

// ── Case A: pool with a held slot → indicator present with occupancy ───────
(() => {
  const dir = mkTmp('case-a');
  const poolDir = mkTmp('case-a-pool');
  try {
    const granted = grantHeldSlot(poolDir);
    assert(granted && granted.ok, '(A) setup: pool grant succeeds', JSON.stringify(granted));
    const r = runStatusline(dir, poolDir);
    assert(r.status === 0, '(A) statusline exits 0', JSON.stringify(r));
    assert(r.stdout.includes('🧮'), '(A) indicator glyph present with pool held', r.stdout);
    assert(/🧮\s+1\/\d+/.test(r.stdout), '(A) indicator shows held/ceiling occupancy', r.stdout);
  } finally {
    cleanup(dir);
    cleanup(poolDir);
  }
})();

// ── Case B: empty pool, no degradation event → indicator absent ────────────
(() => {
  const dir = mkTmp('case-b');
  const poolDir = mkTmp('case-b-pool');
  try {
    const r = runStatusline(dir, poolDir);
    assert(r.status === 0, '(B) statusline exits 0', JSON.stringify(r));
    assert(!r.stdout.includes('🧮'), '(B) indicator glyph absent when pool free and no degradation', r.stdout);
  } finally {
    cleanup(dir);
    cleanup(poolDir);
  }
})();

// ── Case C: corrupted events.jsonl + unreadable pool → render survives ─────
(() => {
  const dir = mkTmp('case-c');
  // Pool dir intentionally NOT created — poolStatus() must fail-open, never throw.
  const poolDir = path.join(os.tmpdir(), `forge-statusline-res-case-c-pool-missing-${Date.now()}`);
  try {
    const eventsFile = path.join(dir, '.gsd', 'forge', 'events.jsonl');
    fs.writeFileSync(eventsFile, 'this is not { valid json\n{"also":"broken"\n', 'utf8');
    const r = runStatusline(dir, poolDir);
    assert(r.status === 0, '(C) statusline exits 0 with corrupted log + missing pool root', JSON.stringify(r));
    assert(r.stdout.trim().length > 0, '(C) statusline still prints a line (render did not die)', JSON.stringify(r));
    assert(!r.stdout.includes('🧮'), '(C) no indicator emitted from unreadable inputs', r.stdout);
  } finally {
    cleanup(dir);
  }
})();

// ── Case C2: pool held + corrupted events.jsonl → indicator still shows occupancy, MEM008 on the reason half ──
(() => {
  const dir = mkTmp('case-c2');
  const poolDir = mkTmp('case-c2-pool');
  try {
    const granted = grantHeldSlot(poolDir);
    assert(granted && granted.ok, '(C2) setup: pool grant succeeds', JSON.stringify(granted));
    const eventsFile = path.join(dir, '.gsd', 'forge', 'events.jsonl');
    fs.writeFileSync(eventsFile, 'not json at all\n', 'utf8');
    const r = runStatusline(dir, poolDir);
    assert(r.status === 0, '(C2) statusline exits 0', JSON.stringify(r));
    assert(r.stdout.includes('🧮'), '(C2) indicator still shows occupancy despite unreadable event log', r.stdout);
  } finally {
    cleanup(dir);
    cleanup(poolDir);
  }
})();

// ── Case D: no-spawn proof, with a positive control ─────────────────────────
(() => {
  const src = fs.readFileSync(STATUSLINE, 'utf8');
  const startMarker = '// --- Resource clamp indicator (🧮) ---';
  const endMarker = '// --- Model segment: only when NOT auto';
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker);
  assert(startIdx !== -1 && endIdx !== -1 && endIdx > startIdx,
    '(D) setup: indicator block markers found in source');
  const block = src.slice(startIdx, endIdx);

  const FORBIDDEN = [/spawnSync/, /\bspawn\(/, /execSync/, /execFileSync/, /readPressureSignal/, /resolveResourceBudget/];

  function blockIsClean(text) {
    return !FORBIDDEN.some((re) => re.test(text));
  }

  assert(blockIsClean(block), '(D) indicator block contains no spawn primitives or forbidden resource calls', block);

  // Positive control: the SAME predicate applied to a fixture that DOES
  // contain a forbidden call must be caught — proves the predicate bites
  // rather than being vacuously true (the defect class this milestone keeps
  // finding, per the dispatch prompt).
  const dirtyFixture = `${block}\n  require('child_process').spawnSync('true');\n`;
  assert(!blockIsClean(dirtyFixture), '(D) positive control: predicate DOES flag a fixture with spawnSync', dirtyFixture.slice(-120));
})();

// ── Case E: census module physically absent → statusline renders normally ──
(() => {
  const dir = mkTmp('case-e');
  const poolDir = mkTmp('case-e-pool');
  const scriptsCopy = mkTmp('case-e-scripts');
  try {
    // Copy scripts/ to a tmpdir and remove the census module ONLY on the
    // copy — never touch the real checkout (precedent R10 of S04).
    for (const f of fs.readdirSync(SCRIPTS)) {
      const srcPath = path.join(SCRIPTS, f);
      if (fs.statSync(srcPath).isFile()) {
        fs.copyFileSync(srcPath, path.join(scriptsCopy, f));
      }
    }
    fs.unlinkSync(path.join(scriptsCopy, 'forge-resources-census.js'));
    assert(!fs.existsSync(path.join(scriptsCopy, 'forge-resources-census.js')),
      '(E) setup: census module removed from the COPY only');
    assert(fs.existsSync(path.join(SCRIPTS, 'forge-resources-census.js')),
      '(E) setup: census module still present in the real checkout');

    const granted = grantHeldSlot(poolDir); // pool held, but census module is gone
    assert(granted && granted.ok, '(E) setup: pool grant succeeds', JSON.stringify(granted));

    const input = JSON.stringify({
      cwd: dir,
      model: { display_name: 'test-model' },
      context_window: { used_percentage: 1 },
    });
    const r = spawnSync(process.platform === 'win32' ? 'node.exe' : 'node',
      [path.join(scriptsCopy, 'forge-statusline.js')], {
        input,
        encoding: 'utf8',
        env: { ...process.env, FORGE_RESOURCE_POOL_DIR: poolDir },
        cwd: scriptsCopy,
      });
    assert(r.status === 0, '(E) statusline (from copy, census absent) exits 0', JSON.stringify(r));
    assert(r.stdout.trim().length > 0, '(E) statusline still renders a line', JSON.stringify(r));
    assert(!r.stdout.includes('🧮'), '(E) no indicator when census module cannot be required', r.stdout);
  } finally {
    cleanup(dir);
    cleanup(poolDir);
    cleanup(scriptsCopy);
  }
})();

// ── Case F (R4): free pool + trailing NORMAL event → indicator absent ──────
// A completed healthy cycle's last event carries a non-degradation reason
// (pool-released / pressure-normal). Before the fix, `degradedReason` took
// ANY last event's reason and lit 🧮 for this exact case.
(() => {
  const dir = mkTmp('case-f');
  const poolDir = mkTmp('case-f-pool');
  try {
    appendEvent(path.join(dir, '.gsd'), { ts: new Date().toISOString(), kind: 'resource-pool-released', reason: 'pool-released', granted: 1 });
    const r = runStatusline(dir, poolDir);
    assert(r.status === 0, '(F) statusline exits 0', JSON.stringify(r));
    assert(!r.stdout.includes('🧮'), '(F) no indicator for a free pool + trailing normal event', r.stdout);
  } finally {
    cleanup(dir);
    cleanup(poolDir);
  }
})();

// ── Case F2 (R4 positive control): a real degradation reason DOES light the indicator ──
(() => {
  const dir = mkTmp('case-f2');
  const poolDir = mkTmp('case-f2-pool');
  try {
    appendEvent(path.join(dir, '.gsd'), { ts: new Date().toISOString(), kind: 'resource-degradation', reason: 'pool-unavailable-fail-open' });
    const r = runStatusline(dir, poolDir);
    assert(r.status === 0, '(F2) statusline exits 0', JSON.stringify(r));
    assert(r.stdout.includes('🧮'), '(F2) positive control: a real degradation reason DOES light the indicator', r.stdout);
  } finally {
    cleanup(dir);
    cleanup(poolDir);
  }
})();

// ── Case G (R3): oversized ceiling in pool-config.json is a named invalid config, never a stall ──
(() => {
  const dir = mkTmp('case-g');
  const poolDir = mkTmp('case-g-pool');
  try {
    fs.writeFileSync(path.join(poolDir, 'pool-config.json'), JSON.stringify({ protocol: 1, ceiling: 1e15, written_at: Date.now() }));
    const start = Date.now();
    const r = runStatusline(dir, poolDir);
    const elapsedMs = Date.now() - start;
    assert(r.status === 0, '(G) statusline exits 0 with oversized ceiling', JSON.stringify(r));
    assert(elapsedMs < 10000, '(G) render does not stall on an absurd ceiling', `elapsed=${elapsedMs}ms`);
    assert(!r.stdout.includes('🧮'), '(G) no indicator when the pool config is rejected as invalid', r.stdout);
  } finally {
    cleanup(dir);
    cleanup(poolDir);
  }
})();

// Exercise phase glyphs through the real stdin renderer and dashboard formatter.
(() => {
  const dir = mkTmp('estimate');
  const poolDir = mkTmp('estimate-pool');
  const profile = mkTmp('estimate-profile');
  try {
    fs.writeFileSync(path.join(dir, '.gsd', 'STATE.md'), '**Active Milestone:** M999\n');
    const env = { HOME: profile, USERPROFILE: profile, FORGE_HOME: path.join(profile, '.forge-agent') };
    const { formatActivityLine } = require('./forge-dashboard');
    for (const [phase, icon, dashboardIcon] of [
      ['estimate-milestone', '\u{1f525}', '\u{1f525}'],
      ['plan-milestone', '\u{1f525}', '\u{1f525}'],
      ['execute-task', '\u26a1', '\u26a1'],
      ['unknown-estimate', '\u2022', '\u00b7'],
    ]) {
      const worker = `${phase}/M999`;
      fs.writeFileSync(path.join(dir, '.gsd', 'forge', 'auto-mode.json'), JSON.stringify({
        active: true, started_at: Date.now(), worker, worker_started: Date.now(),
      }));
      const result = runStatusline(dir, poolDir, env);
      assert(result.status === 0 && result.stdout.includes(`${icon}M999`),
        `statusline ${phase} real JSON stdin renders ${icon}`, result.stdout + result.stderr);
      const line = formatActivityLine({ unit: worker, ts: '2026-11-01T00:00:00Z' }, 'M999');
      assert(line.startsWith(`- ${dashboardIcon} `),
        `dashboard ${phase} without status renders ${dashboardIcon}`, line);
    }
  } finally { cleanup(dir); cleanup(poolDir); cleanup(profile); }
})();

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
