#!/usr/bin/env node
'use strict';

// Fixed S03/T01 verification cohort. Exactly the eight original T01 checks run
// sequentially through the canonical process verification
// (runRootVerification -> runVerificationGate), with fixed argv and no shell
// text built from input; no command is added, omitted or replaced. Each child
// keeps its own exit code, duration, skip/timeout status and actual stdout
// (bounded by the canonical 10 KiB view); the named assertion lines declared
// below are requested as observed witnesses and are forwarded verbatim. A
// failed, skipped, timed-out, stopped or missing child, or a declared line that
// was not actually printed, fails the cohort; no global summary replaces an
// individual result and the cohort line is printed only after all eight passed.
// The parity baseline is never regenerated here. Resource events go to an
// in-memory sink. Deliberately not named *.test.js: full discovery must not run
// the cohort twice.
const path = require('path');

const COMMANDS = Object.freeze([
  'node --check scripts/forge-milestone-time.js',
  'node --check scripts/forge-milestone-time-selection.js',
  'node --check scripts/forge-linked-task.js',
  'node scripts/forge-linked-task.test.js',
  'node scripts/forge-linked-task-parity.test.js',
  'node scripts/forge-milestone-time.test.js',
  'node scripts/forge-milestone-time-selection.test.js',
  'node scripts/forge-milestone-time-admission.test.js',
]);
// Named assertion lines each child must actually print (declared contract and the
// unchanged S01/S02 suite summaries of the owner's pre-change baseline).
const REQUIRED_LINES = Object.freeze({
  'node scripts/forge-linked-task.test.js': Object.freeze([
    'ok - T01 owner-records: allowlist immutable publication bounded readers and journal invariants',
    'ok - T01 compatibility: inactive contract reads remain unchanged and owner records require activation',
    'ok - T01 module: inert imports deterministic framing and public link readers',
    'ok - T01 authority: creation requires live scoped decision and refusals leave zero writes',
    'ok - T01 creation: every failpoint resumes in a fresh process without duplicates or overwrite',
    'ok - T01 brief: deterministic provenance and moved scope remain framed public evidence',
    'ok - T01 personal: pending inactive link is never selectable and malformed links fail closed',
    'ok - T01 selection: embedded decide creates once and legacy output stays byte identical',
    'ok - T01 fixtures: temporary roots real helpers and cleanup preserve real state',
  ]),
  'node scripts/forge-linked-task-parity.test.js': Object.freeze([
    'ok - T01 capture: initializer guards base provenance and never overwrites',
    'ok - T01 parity: four phases both hosts and standalone boundaries match the owner baseline',
  ]),
  'node scripts/forge-milestone-time.test.js': Object.freeze(['PASS milestone-time 39 named checks']),
  'node scripts/forge-milestone-time-selection.test.js': Object.freeze(['29 passed']),
  'node scripts/forge-milestone-time-admission.test.js': Object.freeze(['PASS admission-suite 21 checks']),
});
const COHORT_LINE = 'ok - T01 cohort: exact eight scoped checks preserve exits and named assertions';
// Per-child ceiling inside the 900000 ms outer policy of this sealed command; the
// largest measured child (selection) took 198150 ms. A timeout is reported, never hidden.
const CHILD_TIMEOUT_MS = 600000;

function observedLines(check) {
  if (check.stdout_truncated) return new Set(check.observed_stdout_lines || []);
  return new Set(String(check.stdout || '').split(/\r?\n/));
}
function run(options = {}) {
  const root = path.resolve(__dirname, '..');
  const roots = require('./forge-code-roots'), verify = require('./forge-verify');
  const contract = roots.singleContract(root, root), rootId = contract.code_roots[0].id;
  const events = [];
  const requests = Object.fromEntries(Object.entries(REQUIRED_LINES).map(([command, lines]) => [command, [...lines]]));
  const gate = verify.runRootVerification(contract, { preferenceCommands: [...COMMANDS], commandTimeoutMs: CHILD_TIMEOUT_MS,
    unit: 'S03/T01/forge-linked-task-verify', resourceEventSink: line => events.push(line), evidenceRequests: { [rootId]: requests }, ...options });
  const envelope = gate.roots[0], result = envelope.result, checks = result.checks || [];
  const children = COMMANDS.map((command, index) => {
    const check = checks.find(item => item.command === command);
    if (!check) return { index: index + 1, command, status: 'not-run', exit_code: null, duration_ms: null, missing_lines: [...(REQUIRED_LINES[command] || [])] };
    const seen = observedLines(check), missing = (REQUIRED_LINES[command] || []).filter(line => !seen.has(line));
    const status = check.skipped === 'timeout' || check.exitCode === 124 ? 'timeout' : check.skipped ? 'skipped'
      : check.exitCode !== 0 ? 'failed' : missing.length ? 'assertion-missing' : 'passed';
    return { index: index + 1, command, status, exit_code: check.exitCode, duration_ms: check.durationMs, stdout: check.stdout, stderr: check.stderr,
      missing_lines: missing, ...(check.stdout_truncated ? { stdout_truncated: true, observed_stdout_lines: check.observed_stdout_lines || [] } : {}),
      ...(check.cleanup ? { cleanup: check.cleanup } : {}) };
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
    if (child.stdout_truncated) for (const line of child.observed_stdout_lines) io.stdout.write(line + '\n');
    for (const line of child.missing_lines || []) io.stdout.write('missing: ' + line + '\n');
    if (child.status !== 'passed' && child.stderr) io.stdout.write('stderr: ' + String(child.stderr).replace(/\s+$/, '') + '\n');
  }
  io.stdout.write(`discovery: ${output.discovery_source}; revision: ${output.revision}; environment: ${output.environment}\n`);
  if (output.stopped) io.stdout.write(`stopped: ${JSON.stringify(output.stopped)}\n`);
  const counts = output.children.reduce((all, child) => ({ ...all, [child.status]: (all[child.status] || 0) + 1 }), {});
  if (output.passed) io.stdout.write(COHORT_LINE + '\n');
  io.stdout.write(`forge-linked-task-verify: ${output.passed ? 'PASS' : 'FAIL'} ${JSON.stringify(counts)}\n`);
  return output.passed ? 0 : 1;
}

if (require.main === module) process.exitCode = main();
module.exports = { COMMANDS, REQUIRED_LINES, COHORT_LINE, CHILD_TIMEOUT_MS, run, main };
