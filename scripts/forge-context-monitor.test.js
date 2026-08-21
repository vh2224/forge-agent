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
  createContextSnapshot,
  usableSnapshot,
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
  assertEq(DEFAULT_THRESHOLDS, { checkpoint: 0.4, warning: 0.35, critical: 0.25 }, 'DEFAULT_THRESHOLDS');
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

test('0.36 → checkpoint', () => {
  assertEq(severityFor(0.36), 'checkpoint');
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
  writeTmp('disabled-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "enabled": false }
}`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.enabled, false, 'should read enabled: false');
});

test('percent threshold 40 → 0.40', () => {
  const fakeCwd = path.join(ROOT, 'percent-project');
  writeTmp('percent-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "checkpoint_threshold": 50, "warning_threshold": 40, "critical_threshold": 20 }
}`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.thresholds.warning, 0.40, 'percent 40 → 0.40');
  assertEq(prefs.thresholds.critical, 0.20, 'percent 20 → 0.20');
});

test('fraction threshold 0.45 stays as-is', () => {
  const fakeCwd = path.join(ROOT, 'fraction-project');
  writeTmp('fraction-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "checkpoint_threshold": 0.50, "warning_threshold": 0.45 }
}`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.thresholds.warning, 0.45, 'fraction 0.45 stays 0.45');
});

test('S03-R3: numeric-string-with-suffix threshold (85% → 0.85)', () => {
  const fakeCwd = path.join(ROOT, 'suffix-project');
  writeTmp('suffix-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "checkpoint_threshold": "90%", "warning_threshold": "85%", "critical_threshold": "70abc" }
}`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.thresholds.warning, 0.85, '"85%" → 0.85 (parseFloat + percent normalize)');
  assertEq(prefs.thresholds.critical, 0.70, '"70abc" → 0.70 (leading numeric prefix)');
});

test('S03-R3: clean fraction/number strings still behave', () => {
  const fakeCwd = path.join(ROOT, 'suffix-clean-project');
  writeTmp('suffix-clean-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "checkpoint_threshold": "0.90", "warning_threshold": "0.85", "critical_threshold": "70" }
}`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.thresholds.warning, 0.85, '"0.85" string → 0.85');
  assertEq(prefs.thresholds.critical, 0.70, '"70" string → 0.70');
});

test('S03-R3: non-numeric string still falls back to default', () => {
  const fakeCwd = path.join(ROOT, 'suffix-invalid-project');
  writeTmp('suffix-invalid-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "warning_threshold": "abc" }
}`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.thresholds.warning, 0.35, '"abc" → default 0.35');
});

test('invalid enabled and thresholds preserve defaults', () => {
  const fakeCwd = path.join(ROOT, 'invalid-project');
  writeTmp('invalid-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "enabled": "maybe", "warning_threshold": "abc", "critical_threshold": null }
}`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs, { enabled: true, alertsEnabled: true, debounceToolUses: 5, thresholds: { checkpoint: 0.4, warning: 0.35, critical: 0.25 } },
    'invalid values must fall back to defaults');
});

test('snapshot preserves real zero and complement', () => {
  const snapshot = createContextSnapshot({ host_runtime: 'codex', source: 'codex-app-server', capability: true, used_percentage: 0 }, 1000);
  assertEq(snapshot.measurement, 'measured');
  assertEq(snapshot.used_percentage, 0);
  assertEq(snapshot.remaining_percentage, 1);
});

test('percentage requires explicit capability and recognized host/source', () => {
  for (const input of [
    { host_runtime: 'codex', source: 'codex-app-server', capability: false, used_percentage: 50 },
    { host_runtime: 'codex', source: 'wrong', capability: true, used_percentage: 50 },
    { host_runtime: 'claude', source: 'codex-app-server', capability: true, used_percentage: 50 },
  ]) {
    const snapshot = createContextSnapshot(input, 1000);
    assertEq(snapshot.measurement, 'unknown');
    assert(!Object.prototype.hasOwnProperty.call(snapshot, 'used_percentage'), 'fail-closed snapshot omits percentages');
  }
});

test('unknown, missing, typo and future hosts never coerce to Claude', () => {
  for (const host_runtime of [undefined, 'claud', 'future-host']) {
    const snapshot = createContextSnapshot({ host_runtime, source: 'claude-statusline', capability: true, used_percentage: 50 }, 1000);
    assertEq(snapshot.host_runtime, 'unknown');
    assertEq(snapshot.measurement, 'unknown');
  }
});

test('missing or invalid telemetry is unknown without percentages', () => {
  for (const value of [undefined, null, NaN, Infinity, -1, 101, '0']) {
    const snapshot = createContextSnapshot({ host_runtime: 'codex', source: 'codex-app-server', capability: true, used_percentage: value }, 1000);
    assertEq(snapshot.measurement, 'unknown');
    assert(!Object.prototype.hasOwnProperty.call(snapshot, 'used_percentage'), 'unknown must omit used_percentage');
  }
});

test('stale measured snapshot is not usable', () => {
  const snapshot = createContextSnapshot({ host_runtime: 'codex', source: 'codex-app-server', capability: true, used_percentage: 50 }, 1000);
  assert(usableSnapshot(snapshot, 62_000) === false, 'stale bridge must not alert');
});

test('invalid threshold ordering rejects the whole block', () => {
  const fakeCwd = path.join(ROOT, 'invalid-order-project');
  writeTmp('invalid-order-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "checkpoint_threshold": 0.3, "warning_threshold": 0.35, "critical_threshold": 0.2 }
}`);
  let threw = false;
  try { readContextMonitorPrefs(fakeCwd); } catch (error) { threw = error.code === 'FORGE_PREFS_INVALID_CONTEXT_MONITOR'; }
  assert(threw, 'invalid relational block must be rejected observably');
});

test('legacy warning/critical layer without the new checkpoint knob completes to a valid block', () => {
  const fakeCwd = path.join(ROOT, 'legacy-cutover-project');
  writeTmp('legacy-cutover-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "enabled": false, "warning_threshold": 40, "critical_threshold": 0.2 }
}`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.thresholds.warning, 0.4);
  assertEq(prefs.thresholds.critical, 0.2);
  assertEq(prefs.thresholds.checkpoint, 0.45, 'absent new checkpoint completes above the legacy warning');
});

test('explicit checkpoint collision still rejects atomically during cutover', () => {
  const fakeCwd = path.join(ROOT, 'explicit-cutover-invalid-project');
  writeTmp('explicit-cutover-invalid-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "checkpoint_threshold": 0.4, "warning_threshold": 40, "critical_threshold": 0.2 }
}`);
  let code = '';
  try { readContextMonitorPrefs(fakeCwd); } catch (error) { code = error.code; }
  assertEq(code, 'FORGE_PREFS_INVALID_CONTEXT_MONITOR');
});

test('explicit partial relational override still rejects atomically', () => {
  const fakeCwd = path.join(ROOT, 'explicit-partial-invalid-project');
  writeTmp('explicit-partial-invalid-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "warning_threshold": 0.2 }
}`);
  let code = '';
  try { readContextMonitorPrefs(fakeCwd); } catch (error) { code = error.code; }
  assertEq(code, 'FORGE_PREFS_INVALID_CONTEXT_MONITOR');
});

test('alerts disabled makes the production enabled gate false', () => {
  const fakeCwd = path.join(ROOT, 'alerts-off-project');
  writeTmp('alerts-off-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "alerts_enabled": false }
}`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.alertsEnabled, false);
  assertEq(prefs.enabled, false);
});

test('configured debounce is used when caller omits the third argument', () => {
  const fakeCwd = path.join(ROOT, 'debounce-project');
  writeTmp('debounce-project/.gsd/forge-prefs.jsonc', `{
  "context_monitor": { "debounce_tool_uses": 1 }
}`);
  readContextMonitorPrefs(fakeCwd);
  const result = shouldInject('warning', { lastSeverity: 'warning', toolUsesSinceLast: 1 });
  assert(result.inject === true, 'production two-argument caller must honor configured debounce');
});

// ── S03 review fixes: R6 block scoping + R8 threshold-aware messages ──────────

console.log('\nreview fixes (R6 scoping / R8 thresholds):');

test('R6: enabled: false em bloco IRMÃO não desliga o monitor', () => {
  const fakeCwd = path.join(ROOT, 'sibling-project');
  writeTmp('sibling-project/.gsd/forge-prefs.jsonc', `{
  "evidence": { "enabled": false },
  "context_monitor": { "warning_threshold": 0.35 }
}`);
  const prefs = readContextMonitorPrefs(fakeCwd);
  assertEq(prefs.enabled, true, 'sibling-block enabled must NOT leak into context_monitor');
});

test('R6: arquivo sem bloco context_monitor → defaults intactos', () => {
  const fakeCwd = path.join(ROOT, 'noblock-project');
  writeTmp('noblock-project/.gsd/forge-prefs.jsonc', `{
  "repair": { "enabled": false, "warning_threshold": 0.99 }
}`);
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
