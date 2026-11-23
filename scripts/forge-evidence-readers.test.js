#!/usr/bin/env node
// forge-evidence-readers.test.js — standalone suite for the S01/T04 readers
// (forge-dashboard.js freshness, forge-statusline.js pre-scan).
//
// Covers: presence/absence per evidence-file FORM (composite + 3 legacy
// forms) for both readers, an unrecognized name never being read as a
// freshness signal (no silent-crash / no silent false-positive), and a
// freshness regression guard — a run is found via the NEW composite name
// AND via the OLD legacy milestone-qualified name.
//
// Run: node scripts/forge-evidence-readers.test.js  (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildEvidenceFileName } = require('./forge-evidence-path.js');
const { effectiveHeartbeatAge } = require('./forge-dashboard.js');

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

function mkWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-evidence-readers-test-'));
  fs.mkdirSync(path.join(root, '.gsd', 'forge'), { recursive: true });
  fs.mkdirSync(path.join(root, '.gsd', 'forge', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.gsd', 'milestones'), { recursive: true });
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

// Writes an evidence file NOW (fresh mtime) and returns its age via a stat.
function writeFreshEvidence(root, name) {
  fs.writeFileSync(path.join(root, '.gsd', 'forge', name), '{"cmd":"x"}\n', 'utf8');
}

function writeRun(root, run) {
  fs.writeFileSync(
    path.join(root, '.gsd', 'forge', 'runs', `${run.id}.json`),
    JSON.stringify(run),
    'utf8'
  );
}

// ── forge-dashboard.js: effectiveHeartbeatAge ────────────────────────────────

test('dashboard: presence — composite (new) form found as freshness signal', () => {
  const root = mkWorkspace();
  const name = buildEvidenceFileName({ milestone: 'M-abc', slice: 'S01', unit: 'T04' });
  writeFreshEvidence(root, name);
  const staleHeartbeat = Date.now() - 60 * 60 * 1000; // 1h ago — old signal
  const age = effectiveHeartbeatAge({ id: 'M-abc', last_heartbeat: staleHeartbeat }, Date.now(), root);
  assert(age < 5000, `expected a fresh age from the composite file, got ${age}ms`);
  cleanup(root);
});

test('dashboard: presence — legacy milestone-qualified form found as freshness signal (regression guard)', () => {
  const root = mkWorkspace();
  fs.mkdirSync(path.join(root, '.gsd', 'milestones', 'M-abc'), { recursive: true }); // known-ids resolution needs the milestone registered
  writeFreshEvidence(root, 'evidence-M-abc-T04.jsonl');
  const staleHeartbeat = Date.now() - 60 * 60 * 1000;
  const age = effectiveHeartbeatAge({ id: 'M-abc', last_heartbeat: staleHeartbeat }, Date.now(), root);
  assert(age < 5000, `expected a fresh age from the legacy milestone-qualified file, got ${age}ms`);
  cleanup(root);
});

test('dashboard: absence — bare form never matches the milestone axis (no milestone to key on)', () => {
  const root = mkWorkspace();
  writeFreshEvidence(root, 'evidence-T04.jsonl');
  const staleHeartbeat = Date.now() - 60 * 60 * 1000;
  const age = effectiveHeartbeatAge({ id: 'M-abc', last_heartbeat: staleHeartbeat }, Date.now(), root);
  assert(age >= 59 * 60 * 1000, `bare form must not leak into a milestone-scoped freshness signal, got ${age}ms`);
  cleanup(root);
});

test('dashboard: unrecognized-form file is never treated as a freshness signal, never crashes', () => {
  const root = mkWorkspace();
  writeFreshEvidence(root, 'evidence-.jsonl'); // empty body — unrecognized per parseEvidenceFileName
  const staleHeartbeat = Date.now() - 60 * 60 * 1000;
  const age = effectiveHeartbeatAge({ id: 'M-abc', last_heartbeat: staleHeartbeat }, Date.now(), root);
  assert(age >= 59 * 60 * 1000, `unrecognized form must not be read as fresh, got ${age}ms`);
  cleanup(root);
});

test('dashboard: dir-unreadable degrades to the heartbeat-only age, never throws', () => {
  const root = mkWorkspace();
  fs.rmSync(path.join(root, '.gsd', 'forge'), { recursive: true, force: true });
  const staleHeartbeat = Date.now() - 1000;
  const age = effectiveHeartbeatAge({ id: 'M-abc', last_heartbeat: staleHeartbeat }, Date.now(), root);
  assert(age >= 900 && age <= 1500, `expected heartbeat-only age, got ${age}ms`);
  cleanup(root);
});

// ── forge-statusline.js: multi-run pre-scan (end-to-end CLI) ─────────────────

function runStatusline(root, sessionId) {
  const res = spawnSync(process.execPath, [path.join(__dirname, 'forge-statusline.js')], {
    input: JSON.stringify({
      cwd: root,
      model: { id: 'test-model' },
      session_id: sessionId,
      context_window: { used_percentage: 0 },
      cost: { total_cost_usd: 0 },
    }),
    encoding: 'utf8',
  });
  return res.stdout;
}

function activeRun(id, staleAgoMs) {
  return { id, active: true, kind: 'auto', worker: 'execute-task/T01', started_at: Date.now() - staleAgoMs - 1000, last_heartbeat: Date.now() - staleAgoMs };
}

test('statusline: two runs stale by heartbeat, both revived fresh by composite-form evidence', () => {
  const root = mkWorkspace();
  const oneHour = 60 * 60 * 1000;
  writeRun(root, activeRun('M-one', oneHour));
  writeRun(root, activeRun('M-two', oneHour));
  writeFreshEvidence(root, buildEvidenceFileName({ milestone: 'M-one', slice: 'S01', unit: 'T01' }));
  writeFreshEvidence(root, buildEvidenceFileName({ milestone: 'M-two', slice: 'S01', unit: 'T01' }));
  const out = runStatusline(root, 'sess-composite');
  assert(out.includes('RUNS ATIVOS ×2'), `expected multi-run mode with both runs revived fresh, got: ${out}`);
  cleanup(root);
});

test('statusline: two runs stale by heartbeat, both revived fresh by LEGACY milestone-qualified evidence', () => {
  const root = mkWorkspace();
  const oneHour = 60 * 60 * 1000;
  writeRun(root, activeRun('M-one', oneHour));
  writeRun(root, activeRun('M-two', oneHour));
  fs.mkdirSync(path.join(root, '.gsd', 'milestones', 'M-one'), { recursive: true });
  fs.mkdirSync(path.join(root, '.gsd', 'milestones', 'M-two'), { recursive: true });
  writeFreshEvidence(root, 'evidence-M-one-T01.jsonl');
  writeFreshEvidence(root, 'evidence-M-two-T01.jsonl');
  const out = runStatusline(root, 'sess-legacy');
  assert(out.includes('RUNS ATIVOS ×2'), `expected multi-run mode revived by legacy names, got: ${out}`);
  cleanup(root);
});

test('statusline: unrecognized-form evidence file never revives a stale run (both drop out of multi-run mode)', () => {
  const root = mkWorkspace();
  const oneHour = 60 * 60 * 1000;
  writeRun(root, activeRun('M-one', oneHour));
  writeRun(root, activeRun('M-two', oneHour));
  writeFreshEvidence(root, 'evidence-.jsonl'); // unrecognized — empty body
  const out = runStatusline(root, 'sess-unrecognized');
  assert(!out.includes('RUNS ATIVOS ×2'), `unrecognized-form file must not count as a freshness signal, got: ${out}`);
  cleanup(root);
});

// ── Result ─────────────────────────────────────────────────────────────────────
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
