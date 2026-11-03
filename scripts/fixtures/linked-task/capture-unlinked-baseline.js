#!/usr/bin/env node
'use strict';

// Single guarded initialization of scripts/fixtures/linked-task/unlinked-baseline.json
// (S03/T01). It calls the parity suite's capture API directly: no shell, no
// subprocess and no arguments. Before the first capture every one of the nine
// tracked parity sources and both pre-change sources of the task
// (forge-milestone-time.js, forge-milestone-time-selection.js) must still have
// the owner-provided base worktree sha256; otherwise it fails closed and writes
// nothing. When the fixture already exists it is only validated (provenance and
// integrity) and never rewritten, so later legitimate edits of the tracked
// sources do not matter here: the parity suite itself compares the trace.
// Import is inert: nothing runs unless this file is the entry point.
const path = require('path');

const PARITY = path.join(__dirname, '..', '..', 'forge-linked-task-parity.test.js');

async function initialize(options = {}) {
  const parity = require(PARITY);
  const result = await parity.captureBaseline(options);
  const stored = parity.readDocument(result.file);
  // Success is reported only after the stored bytes are read back and validated.
  if (stored.status !== 'valid' || stored.document.trace_sha256 !== result.trace_sha256) {
    throw Object.assign(new Error('parity-baseline-readback-invalid'), { code: 'parity-baseline-readback-invalid' });
  }
  return { status: result.status, trace_sha256: result.trace_sha256, revision: stored.document.provenance.revision,
    sources: stored.document.provenance.sources.length, guards: stored.document.provenance.capture_source_guards.length };
}

async function main(argv = process.argv.slice(2), io = process) {
  if (argv.length) { io.stdout.write('Uso: node scripts/fixtures/linked-task/capture-unlinked-baseline.js (sem argumentos)\n'); return 2; }
  try {
    const result = await initialize();
    io.stdout.write((result.status === 'captured' ? 'Baseline sem vínculo capturado' : 'Baseline sem vínculo existente validado, sem reescrita')
      + ': revisão ' + result.revision + ', ' + result.sources + ' fontes e ' + result.guards + ' guardas, traço ' + result.trace_sha256 + '.\n');
    io.stdout.write('ok - T01 capture initializer: ' + result.status + ' baseline with base provenance\n');
    return 0;
  } catch (error) {
    io.stdout.write('not ok - T01 capture initializer: ' + (error.code || 'parity-capture-failed') + ' — ' + error.message + '\n');
    return 3;
  }
}

module.exports = { PARITY, initialize, main };
if (require.main === module) main().then(code => { process.exitCode = code; });
