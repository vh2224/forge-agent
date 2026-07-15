#!/usr/bin/env node
// forge-routing.test.js — parser suite for readRoutingConfig (T01).
// Adversarial fixtures for the 3-level `routing:` block parser: broken
// indentation, tabs vs spaces, per-domain last-wins across the cascade,
// `fallback:` mid-tiers, block at END of file, inline `#` comments, and
// all-or-nothing degradation. Each scenario writes real prefs files into a
// fresh temp cascade (home > repo > local), invokes readRoutingConfig via
// require (in-process), asserts, and self-cleans. Exit 1 on any failure.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { readRoutingConfig } = require('./forge-routing');

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

// Build an isolated cascade. Sets $HOME so os.homedir() (and therefore the
// home prefs path) resolves inside the temp root — fully deterministic.
function withCascade({ home = null, repo = null, local = null }, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-routing-test-'));
  const homeDir = path.join(root, 'home');
  const repoDir = path.join(root, 'repo');
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, '.gsd'), { recursive: true });
  if (home !== null) fs.writeFileSync(path.join(homeDir, '.claude', 'forge-agent-prefs.md'), home);
  if (repo !== null) fs.writeFileSync(path.join(repoDir, '.gsd', 'claude-agent-prefs.md'), repo);
  if (local !== null) fs.writeFileSync(path.join(repoDir, '.gsd', 'prefs.local.md'), local);

  const savedHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    return fn(repoDir);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
}

console.log('\n=== forge-routing.js — readRoutingConfig parser suite ===\n');

// --- Scenario 1: no routing block anywhere → compat path ---
console.log('Scenario 1: no routing block in the cascade');
withCascade({ repo: '# just prefs\ntier_models:\n  standard: claude-sonnet-5\n' }, (cwd) => {
  const r = readRoutingConfig(cwd);
  test('present false', () => assertEq(r.present, false));
  test('ok true', () => assertEq(r.ok, true));
  test('routing empty', () => assertEq(r.routing, {}));
  test('error null', () => assertEq(r.error, null));
});

// --- Scenario 2: valid single domain (spaces) ---
console.log('\nScenario 2: valid single domain, space indentation');
withCascade({
  repo: 'routing:\n  backend:\n    executor:\n      standard: claude-sonnet-5\n      fallback: claude-sonnet-5\n    planner:\n      heavy: claude-opus-4-8\n',
}, (cwd) => {
  const r = readRoutingConfig(cwd);
  test('present true, ok true', () => assert(r.present && r.ok, JSON.stringify(r)));
  test('backend.executor.standard parsed as list', () =>
    assertEq(r.routing.backend.executor.standard, ['claude-sonnet-5']));
  test('backend.executor.fallback scalar', () =>
    assertEq(r.routing.backend.executor.fallback, 'claude-sonnet-5'));
  test('backend.planner.heavy parsed', () =>
    assertEq(r.routing.backend.planner.heavy, ['claude-opus-4-8']));
});

// --- Scenario 3: tab indentation parses identically ---
console.log('\nScenario 3: tab indentation');
withCascade({
  repo: 'routing:\n\tbackend:\n\t\texecutor:\n\t\t\tstandard: claude-sonnet-5\n',
}, (cwd) => {
  const r = readRoutingConfig(cwd);
  test('tabs parse ok', () => assert(r.ok && r.present, JSON.stringify(r)));
  test('tabbed value intact', () =>
    assertEq(r.routing.backend.executor.standard, ['claude-sonnet-5']));
});

// --- Scenario 4: broken nesting (dedent to unknown level) → all-or-nothing ---
console.log('\nScenario 4: broken indentation → routing-parse-error');
withCascade({
  repo: 'routing:\n  backend:\n    executor:\n      standard: claude-sonnet-5\n   planner:\n      heavy: claude-opus-4-8\n',
}, (cwd) => {
  const r = readRoutingConfig(cwd);
  test('present true', () => assertEq(r.present, true));
  test('ok false', () => assertEq(r.ok, false));
  test('routing emptied (never partial)', () => assertEq(r.routing, {}));
  test('error routing-parse-error', () => assertEq(r.error, 'routing-parse-error'));
});

// --- Scenario 5: domain duplicated across cascade → last-wins whole domain ---
console.log('\nScenario 5: duplicate domain across cascade (last-wins per domain)');
withCascade({
  repo: 'routing:\n  backend:\n    executor:\n      standard: claude-sonnet-5\n    planner:\n      heavy: claude-opus-4-8\n',
  local: 'routing:\n  backend:\n    executor:\n      standard: gpt-5\n',
}, (cwd) => {
  const r = readRoutingConfig(cwd);
  test('ok true', () => assert(r.ok, JSON.stringify(r)));
  test('local domain replaces repo domain entirely', () =>
    assertEq(r.routing.backend, { executor: { standard: ['gpt-5'] } }));
  test('repo planner NOT merged in (whole-domain replace)', () =>
    assertEq(r.routing.backend.planner, undefined));
});

// --- Scenario 6: fallback in the middle of tiers → still valid ---
console.log('\nScenario 6: fallback: between tier keys');
withCascade({
  repo: 'routing:\n  backend:\n    executor:\n      standard: claude-sonnet-5\n      fallback: claude-sonnet-5\n      heavy: claude-opus-4-8\n',
}, (cwd) => {
  const r = readRoutingConfig(cwd);
  test('ok true', () => assert(r.ok, JSON.stringify(r)));
  test('fallback captured mid-tiers', () =>
    assertEq(r.routing.backend.executor.fallback, 'claude-sonnet-5'));
  test('tiers around fallback intact', () => {
    assertEq(r.routing.backend.executor.standard, ['claude-sonnet-5']);
    assertEq(r.routing.backend.executor.heavy, ['claude-opus-4-8']);
  });
});

// --- Scenario 7: routing block at END of file, no trailing newline ---
console.log('\nScenario 7: block at end of file (\\Z-class regression)');
withCascade({
  repo: 'tier_models:\n  standard: claude-sonnet-5\n\nrouting:\n  default:\n    executor:\n      standard: claude-sonnet-5',
}, (cwd) => {
  const r = readRoutingConfig(cwd);
  test('trailing block captured', () => assert(r.ok && r.present, JSON.stringify(r)));
  test('default domain parsed', () =>
    assertEq(r.routing.default.executor.standard, ['claude-sonnet-5']));
});

// --- Scenario 8: inline # comments + inline list value ---
console.log('\nScenario 8: inline comments and inline list values');
withCascade({
  repo: 'routing:\n  backend:  # backend domain\n    executor:\n      standard: [claude-sonnet-5, gpt-5]  # mixed cell\n      fallback: claude-sonnet-5 # net\n',
}, (cwd) => {
  const r = readRoutingConfig(cwd);
  test('ok true', () => assert(r.ok, JSON.stringify(r)));
  test('inline list → array, comment stripped', () =>
    assertEq(r.routing.backend.executor.standard, ['claude-sonnet-5', 'gpt-5']));
  test('scalar comment stripped', () =>
    assertEq(r.routing.backend.executor.fallback, 'claude-sonnet-5'));
});

// --- Scenario 9: all-or-nothing — one malformed file poisons the cascade ---
console.log('\nScenario 9: malformed file in cascade poisons whole cascade');
withCascade({
  repo: 'routing:\n  backend:\n    executor:\n      standard: claude-sonnet-5\n',
  local: 'routing:\n  frontend:\n      standard: gpt-5\n', // phase level skipped
}, (cwd) => {
  const r = readRoutingConfig(cwd);
  test('present true', () => assertEq(r.present, true));
  test('ok false (never partial across files)', () => assertEq(r.ok, false));
  test('routing empty', () => assertEq(r.routing, {}));
  test('error routing-parse-error', () => assertEq(r.error, 'routing-parse-error'));
});

// --- Scenario 10: cascade merge of DIFFERENT domains (home + repo) ---
console.log('\nScenario 10: different domains merge across cascade');
withCascade({
  home: 'routing:\n  default:\n    executor:\n      standard: claude-sonnet-5\n',
  repo: 'routing:\n  backend:\n    planner:\n      heavy: claude-opus-4-8\n',
}, (cwd) => {
  const r = readRoutingConfig(cwd);
  test('ok true', () => assert(r.ok, JSON.stringify(r)));
  test('home default domain present', () =>
    assertEq(r.routing.default.executor.standard, ['claude-sonnet-5']));
  test('repo backend domain present', () =>
    assertEq(r.routing.backend.planner.heavy, ['claude-opus-4-8']));
});

// --- Scenario 11: nesting too deep (level 4) → malformed ---
console.log('\nScenario 11: excessive nesting depth');
withCascade({
  repo: 'routing:\n  backend:\n    executor:\n      standard:\n        extra: claude-sonnet-5\n',
}, (cwd) => {
  const r = readRoutingConfig(cwd);
  test('depth>3 → ok false', () => assertEq(r.ok, false));
  test('error routing-parse-error', () => assertEq(r.error, 'routing-parse-error'));
});

// --- Summary ---
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
