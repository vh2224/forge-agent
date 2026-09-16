#!/usr/bin/env node
'use strict';

// Host adapters provide identity/presentation only. They never spawn, select a
// worker, inspect provider homes, or implement fallback.
const loop = require('./forge-loop-controller.js');

function error(code, message) { const value = new Error(message); value.code = code; return value; }
function invoke(hostRuntime, mode, command, input = {}, snapshot, dependencies) {
  const host = String(hostRuntime || '').toLowerCase();
  if (!['claude', 'codex'].includes(host)) throw error('invalid-host', `host_runtime inválido: ${hostRuntime}`);
  const state = snapshot || loop.create({ mode, workflow_id: input.workflow_id || input.workflowId, host_runtime: host, max_steps: input.max_steps || input.maxSteps });
  const result = loop.advance(state, command, { ...input, host_runtime: host }, dependencies);
  return { adapter_runtime: host, result };
}
function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]; const value = argv[index + 1];
    if (['--host', '--mode', '--command', '--json', '--snapshot'].includes(flag) && value !== undefined) { args[flag.slice(2)] = value; index += 1; }
    else if (flag === '--help' || flag === '-h') args.help = true;
    else throw error('invalid-request', `opção desconhecida: ${flag}`);
  }
  return args;
}
function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), errorOutput = process.stderr.write.bind(process.stderr)) {
  try {
    const args = parseArgs(argv);
    if (args.help) { output('Usage: forge-long-workflow-adapter.js --host claude|codex --mode auto|task --command next|pause|resume|status|complete --json JSON [--snapshot JSON]\n'); return 0; }
    const input = JSON.parse(args.json || '{}'); const snapshot = args.snapshot ? JSON.parse(args.snapshot) : null;
    output(`${JSON.stringify(invoke(args.host, args.mode, args.command, input, snapshot))}\n`); return 0;
  } catch (cause) { errorOutput(`forge-long-workflow-adapter: ${cause.code || 'failed'}: ${cause.message}\n`); return 1; }
}
if (require.main === module) process.exitCode = main();
module.exports = { invoke, parseArgs, main };
