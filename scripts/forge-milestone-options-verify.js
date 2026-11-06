#!/usr/bin/env node
'use strict';

// Fixed S02/T06 verification cohort (R13). All thirteen original T06 checks (the
// twelve retained checks plus the public options-flow suite) and the existing
// time-clock regression run sequentially through the canonical process
// verification (runRootVerification -> runVerificationGate), exactly as sealed
// below: no shell text is built from input, no command is added or replaced.
// Each child keeps its own name, exit code, duration, skip/timeout status and
// actual stdout (bounded by the canonical 10 KiB view). Any failed, skipped,
// timed-out, stopped or missing child fails the cohort; no global summary
// replaces an individual result. Resource events go to an in-memory sink, so
// nothing is written to the source tree or the owner's .gsd/.
// Deliberately not named *.test.js: full discovery must not run the cohort twice.
const path = require('path');

const COMMANDS = Object.freeze([
  'node --check scripts/forge-unit-controller.js',
  'node --check scripts/forge-orchestrate.js',
  'node --check scripts/forge-loop-controller.js',
  'node --check scripts/forge-long-workflow-adapter.js',
  'node scripts/forge-unit-controller.test.js',
  'node scripts/forge-orchestrate.test.js',
  'node scripts/forge-loop-controller.test.js',
  'node scripts/forge-long-workflow-adapter.test.js',
  'node scripts/forge-milestone-time-flow.test.js',
  'node scripts/forge-milestone-time-reentry.test.js',
  'node scripts/forge-loop-failure.test.js',
  'node scripts/forge-milestone-time-selection.test.js',
  'node scripts/forge-milestone-options-flow.test.js',
  'node scripts/forge-milestone-time-clock.test.js',
]);
// Per-child ceiling inside the single 1800000 ms outer policy; the measured
// maximum child (reentry) took 139359-293437 ms. A timeout is reported, never hidden.
const CHILD_TIMEOUT_MS = 600000;

function run(options = {}) {
  const root = path.resolve(__dirname, '..');
  const roots = require('./forge-code-roots'), verify = require('./forge-verify');
  const contract = roots.singleContract(root, root);
  const events = [];
  const gate = verify.runRootVerification(contract, { preferenceCommands: [...COMMANDS], commandTimeoutMs: CHILD_TIMEOUT_MS,
    unit: 'S02/T06/forge-milestone-options-verify', resourceEventSink: line => events.push(line), ...options });
  const envelope = gate.roots[0], result = envelope.result, checks = result.checks || [];
  const children = COMMANDS.map((command, index) => {
    const check = checks.find(item => item.command === command);
    if (!check) return { index: index + 1, command, status: 'not-run', exit_code: null, duration_ms: null };
    const status = check.skipped === 'timeout' || check.exitCode === 124 ? 'timeout' : check.skipped ? 'skipped' : check.exitCode === 0 ? 'passed' : 'failed';
    return { index: index + 1, command, status, exit_code: check.exitCode, duration_ms: check.durationMs, stdout: check.stdout, stderr: check.stderr,
      ...(check.stdout_truncated ? { stdout_truncated: true } : {}), ...(check.cleanup ? { cleanup: check.cleanup } : {}) };
  });
  const ordered = checks.length === COMMANDS.length && checks.every((check, index) => check.command === COMMANDS[index]);
  const passed = gate.passed && !result.skipped && !result.stopped && ordered && children.every(child => child.status === 'passed');
  return { passed, discovery_source: result.discoverySource, skipped: result.skipped || null, stopped: result.stopped || null,
    revision: envelope.revision, workspace: envelope.workspace, environment: envelope.environment, children, resource_events: events.length };
}

function main(io = process) {
  const output = run();
  for (const child of output.children) {
    io.stdout.write(`[${child.index}/${COMMANDS.length}] ${child.command} => ${child.status} (exit ${child.exit_code}, ${child.duration_ms} ms)\n`);
    if (child.stdout) io.stdout.write(child.stdout.replace(/\s+$/, '') + '\n');
    if (child.status !== 'passed' && child.stderr) io.stdout.write('stderr: ' + String(child.stderr).replace(/\s+$/, '') + '\n');
  }
  io.stdout.write(`discovery: ${output.discovery_source}; revision: ${output.revision}; environment: ${output.environment}\n`);
  if (output.stopped) io.stdout.write(`stopped: ${JSON.stringify(output.stopped)}\n`);
  const counts = output.children.reduce((all, child) => ({ ...all, [child.status]: (all[child.status] || 0) + 1 }), {});
  io.stdout.write(`forge-milestone-options-verify: ${output.passed ? 'PASS' : 'FAIL'} ${JSON.stringify(counts)}\n`);
  return output.passed ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
module.exports = { COMMANDS, CHILD_TIMEOUT_MS, run, main };
