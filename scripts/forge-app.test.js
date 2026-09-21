#!/usr/bin/env node
// forge-app.test.js — runs the macOS app's Swift suite from the JS test gate.
//
// The app is not a second-class citizen: `node scripts/run-tests.js` should
// cover it too. But it is macOS + Swift only, so this suite SKIPS (exit 0)
// wherever it cannot run rather than failing a Linux/Windows checkout.
//
// The Swift side uses the same harness shape as the JS suites (asserts, exit
// 0/1) because XCTest ships with full Xcode, not with the Command Line Tools.
//
// NOT RUN ON CI, DELIBERATELY
// ---------------------------
// This Node wrapper still skips Swift in the cross-platform matrix. App changes
// are now built and tested separately by .github/workflows/app.yml on macOS 26,
// including real PTY regressions; that job does not use this opt-out wrapper.
//
// `swift run` resolves and compiles the whole package, and the app depends on
// SwiftTerm — a VT emulator that takes many minutes to build from cold. On a
// hosted macOS runner with no SPM cache that turned a one-minute CI job into a
// ten-minute-plus one, on every pull request, to exercise code that only ships
// to macOS users who build the app themselves.
//
// The trade is explicit: these tests run locally, before every commit that
// touches app/, which is where they have actually caught things — a shadowed
// ProjectDiscovery, a bar scaled against the wrong denominator, a status model
// silently decoding to nil. Set FORGE_RUN_APP_TESTS=1 to force them anywhere.

'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const appDir = path.join(repoRoot, 'app');

function skip(reason) {
  console.log(`\n=== forge app (Swift) ===\n`);
  console.log(`  ⊘ pulado — ${reason}`);
  console.log('');
  process.exit(0);
}

if (process.platform !== 'darwin') skip('o app é macOS-only');
if (!fs.existsSync(path.join(appDir, 'Package.swift'))) skip('app/Package.swift ausente');

const which = spawnSync('which', ['swift'], { encoding: 'utf8' });
if (which.status !== 0) skip('swift não encontrado (instale as Command Line Tools)');

if (process.env.FORGE_SKIP_APP_TESTS === '1') skip('FORGE_SKIP_APP_TESTS=1');

// Opt out on CI unless explicitly asked for. See the header: building SwiftTerm
// from cold dominates the job.
const onCI = process.env.CI === 'true' || !!process.env.GITHUB_ACTIONS;
if (onCI && process.env.FORGE_RUN_APP_TESTS !== '1') {
  skip('CI — compilar o app domina o job (FORGE_RUN_APP_TESTS=1 força)');
}

console.log('\n=== forge app (Swift) ===\n');

const res = spawnSync('swift', ['run', '--package-path', appDir, 'ForgeKitTests'], {
  encoding: 'utf8',
  stdio: 'inherit',
  timeout: 15 * 60 * 1000,
});

if (res.error) {
  console.log(`  ✗ falhou ao invocar swift: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status === 0 ? 0 : 1);
