#!/usr/bin/env node
// forge-context-monitor.test.js — standalone test suite for forge-context-monitor.js
//
// Covers:
//   - severityFor: none/warning/critical boundaries + invalid input
//   - isStale: 61s → true, 30s → false, absent ts → true
//   - shouldInject: none, escalation (fura debounce), same-severity within window,
//     debounce expired, escalation warning→critical
//   - buildAdditionalContext: 'continue.md' and 'partial' in critical; non-empty warning; empty none
//   - readContextMonitorPrefs: defaults, enabled:false override, percent threshold
//
// Run: node scripts/forge-context-monitor.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DEFAULT_THRESHOLDS,
  DEBOUNCE_TOOLUSES,
  STALE_MS,
  severityFor,
  isStale,
  shouldInject,
  buildAdditionalContext,
  readContextMonitorPrefs,
} = require('./forge-context-monitor.js');

// ── Test runner boilerplate ────────────────────────────────────────────────────

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

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

// Temp dir for prefs fixture files
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ctx-monitor-test-'));

function writeTmp(relPath, content) {
  const p = path.join(ROOT, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

// ── Constants ──────────────────────────────────────────────────────────────────

test('DEFAULT_THRESHOLDS has correct values', () => {
  assertEq(DEFAULT_THRESHOLDS, { warning: 0.35, critical: 0.25 }, 'DEFAULT_THRESHOLDS');
});

test('DEBOUNCE_TOOLUSES is 5', () => {
  assertEq(DEBOUNCE_TOOLUSES, 5, 'DEBOUNCE_TOOLUSES');
});

test('STALE_MS is 60000', () => {
  assertEq(STALE_MS, 60_000, 'STALE_MS');
});

// ── severityFor ───────────────────────────────────────────────────────────────

console.log('\nseverityFor:');

test('0.50 → none (above warning threshold)', () => {
  assertEq(severityFor(0.50), 'none');
});

test('0.36 → none (just above 0.35)', () => {
  assertEq(severityFor(0.36), 'none');
});

test('0.35 → warning (boundary inclusive)', () => {
  assertEq(severityFor(0.35), 'warning');
});

test('0.30 → warning (between warning and critical)', () => {
  assertEq(severityFor(0.30), 'warning');
});

test('0.25 → critical (boundary inclusive)', () => {
  assertEq(severityFor(0.25), 'critical');
});

test('0.20 → critical (below critical threshold)', () => {
  assertEq(severityFor(0.20), 'critical');
});

test('undefined → none (coerce non-number)', () => {
  assertEq(severityFor(undefined), 'none');
});

test('NaN → none (coerce NaN)', () => {
  assertEq(severityFor(NaN), 'none');
});

test('custom thresholds: 0.30 with {warning:0.40, critical:0.20} → warning', () => {
  assertEq(severityFor(0.30, { warning: 0.40, critical: 0.20 }), 'warning');
});

// ── isStale ───────────────────────────────────────────────────────────────────

console.log('\nisStale:');

test('ts 61s ago → true', () => {
  const now = Date.now();
  assert(isStale(now - 61_000, now, 60_000) === true, 'should be stale at 61s');
});

test('ts 30s ago → false', () => {
  const now = Date.now();
  assert(isStale(now - 30_000, now, 60_000) === false, 'should not be stale at 30s');
});

test('ts exactly 60s → false (not strictly greater)', () => {
  const now = Date.now();
  assert(isStale(now - 60_000, now, 60_000) === false, '60s == maxAge → not stale');
});

test('ts absent (null) → true', () => {
  assert(isStale(null) === true, 'null ts should be stale');
});

test('ts absent (undefined) → true', () => {
  assert(isStale(undefined) === true, 'undefined ts should be stale');
});

test('ts=0 → true (falsy)', () => {
  assert(isStale(0) === true, 'ts=0 is falsy → stale');
});

// ── shouldInject ──────────────────────────────────────────────────────────────

console.log('\nshouldInject:');

test('severity none → inject false', () => {
  const r = shouldInject('none', {});
  assert(r.inject === false, 'none should not inject');
});

test('warning from none lastSeverity with toolUsesSinceLast:0 → inject true (escalation)', () => {
  // none < warning → escalation fura debounce
  const r = shouldInject('warning', { lastSeverity: 'none', toolUsesSinceLast: 0 });
  assert(r.inject === true, 'escalation warning from none should inject');
  assertEq(r.nextState.lastSeverity, 'warning', 'nextState.lastSeverity');
  assertEq(r.nextState.toolUsesSinceLast, 0, 'nextState.toolUsesSinceLast reset to 0');
});

test('warning repeated with toolUsesSinceLast:2, lastSeverity warning → inject false (debounce)', () => {
  const r = shouldInject('warning', { lastSeverity: 'warning', toolUsesSinceLast: 2 });
  assert(r.inject === false, 'same severity within debounce window → no inject');
  assertEq(r.nextState.toolUsesSinceLast, 3, 'counter incremented');
});

test('warning with toolUsesSinceLast:5, lastSeverity warning → inject true (debounce expired)', () => {
  const r = shouldInject('warning', { lastSeverity: 'warning', toolUsesSinceLast: 5 });
  assert(r.inject === true, 'debounce expired → inject');
  assertEq(r.nextState.toolUsesSinceLast, 0, 'counter reset');
});

test('escalation warning→critical with toolUsesSinceLast:1 → inject true (fura debounce)', () => {
  const r = shouldInject('critical', { lastSeverity: 'warning', toolUsesSinceLast: 1 });
  assert(r.inject === true, 'escalation critical from warning should inject regardless of debounce');
  assertEq(r.nextState.lastSeverity, 'critical', 'nextState updated to critical');
  assertEq(r.nextState.toolUsesSinceLast, 0, 'counter reset');
});

test('null debounceState → treated as empty (no crash)', () => {
  const r = shouldInject('warning', null);
  assert(r.inject === true, 'null state = none lastSeverity → escalation from none to warning');
});

// ── buildAdditionalContext ────────────────────────────────────────────────────

console.log('\nbuildAdditionalContext:');

test("critical contains 'continue.md'", () => {
  const msg = buildAdditionalContext('critical');
  assert(msg.includes('continue.md'), "critical message should mention 'continue.md'");
});

test("critical contains 'partial'", () => {
  const msg = buildAdditionalContext('critical');
  assert(msg.includes('partial'), "critical message should mention 'partial'");
});

test('warning is non-empty', () => {
  const msg = buildAdditionalContext('warning');
  assert(msg.length > 0, 'warning message should not be empty');
});

test('none returns empty string', () => {
  assertEq(buildAdditionalContext('none'), '');
});

// ── readContextMonitorPrefs ───────────────────────────────────────────────────

console.log('\nreadContextMonitorPrefs:');

test('cwd without prefs → defaults (enabled:true, 0.35/0.25)', () => {
  const fakeCwd = path.join(ROOT, 'empty-project');
  fs.mkdirSync(path.join(fakeCwd, '.gsd'), { recursive: true });
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.enabled, true, 'default enabled');
  assertEq(prefs.thresholds.warning, 0.35, 'default warning');
  assertEq(prefs.thresholds.critical, 0.25, 'default critical');
});

test('prefs.local.md with enabled: false → disabled', () => {
  const fakeCwd = path.join(ROOT, 'disabled-project');
  writeTmp('disabled-project/.gsd/prefs.local.md', `
context_monitor:
  enabled: false
`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.enabled, false, 'should read enabled: false');
});

test('percent threshold 40 → 0.40', () => {
  const fakeCwd = path.join(ROOT, 'percent-project');
  writeTmp('percent-project/.gsd/prefs.local.md', `
context_monitor:
  warning_threshold: 40
  critical_threshold: 20
`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.thresholds.warning, 0.40, 'percent 40 → 0.40');
  assertEq(prefs.thresholds.critical, 0.20, 'percent 20 → 0.20');
});

test('fraction threshold 0.45 stays as-is', () => {
  const fakeCwd = path.join(ROOT, 'fraction-project');
  writeTmp('fraction-project/.gsd/prefs.local.md', `
context_monitor:
  warning_threshold: 0.45
`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.thresholds.warning, 0.45, 'fraction 0.45 stays 0.45');
});

// ── S03 review fixes: R6 block scoping + R8 threshold-aware messages ──────────

console.log('\nreview fixes (R6 scoping / R8 thresholds):');

test('R6: enabled: false em bloco IRMÃO não desliga o monitor', () => {
  const fakeCwd = path.join(ROOT, 'sibling-project');
  writeTmp('sibling-project/.gsd/prefs.local.md', `
evidence:
  enabled: false

context_monitor:
  warning_threshold: 0.35
`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.enabled, true, 'sibling-block enabled must NOT leak into context_monitor');
});

test('R6: arquivo sem bloco context_monitor → defaults intactos', () => {
  const fakeCwd = path.join(ROOT, 'noblock-project');
  writeTmp('noblock-project/.gsd/prefs.local.md', `
repair:
  enabled: false
  warning_threshold: 0.99
`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.enabled, true, 'no context_monitor block → default enabled');
  assertEq(prefs.thresholds.warning, 0.35, 'no block → default warning');
});

test('R8: warning message renders configured threshold (0.50 → 50%)', () => {
  const msg = buildAdditionalContext('warning', { warning: 0.5, critical: 0.25 });
  assert(msg.includes('50%'), 'message must render the configured warning threshold');
  assert(!msg.includes('35%'), 'message must not hard-code the default');
});

test('R8: critical message renders configured threshold (0.10 → 10%)', () => {
  const msg = buildAdditionalContext('critical', { warning: 0.35, critical: 0.10 });
  assert(msg.includes('10%'), 'message must render the configured critical threshold');
});

test('R8: omitted thresholds → defaults (35%/25%) preserved', () => {
  assert(buildAdditionalContext('warning').includes('35%'), 'default warning 35%');
  assert(buildAdditionalContext('critical').includes('25%'), 'default critical 25%');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailed tests:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}
process.exit(failed ? 1 : 0);
