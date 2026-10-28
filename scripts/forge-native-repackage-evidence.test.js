'use strict';
const assert = require('node:assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const roots = require('./forge-code-roots'), api = require('./forge-native-repackage');
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-repackage-evidence-')));
try {
  const owner = path.join(dir, 'owner'), code = path.join(dir, 'code'); fs.mkdirSync(owner); fs.mkdirSync(code);
  require('child_process').execFileSync('git', ['init', '--quiet', code], { stdio: 'pipe' });
  const contract = roots.singleContract(owner, code), request = { cwd: code, contextRoot: owner, execution_contract: contract };
  const next = { ...request, resultFile: path.join(dir, 'result.json') };
  const manifestFile = next.resultFile + '.manifest.json', ipcFile = path.join(dir, 'ipc.json'), journalFile = path.join(dir, 'journal.json');
  const manifest = JSON.stringify({ request: next }), args = { message: 'Full original context', model: 'fixture' };
  fs.writeFileSync(manifestFile, manifest);
  fs.writeFileSync(ipcFile, JSON.stringify({ request: next, args, manifest_file: manifestFile }));
  const journal = { schema_version: 1, phase: 'started', sequence: -1, first_remote_ms: null,
    last_remote_ms: null, handle_sha256: null, open_tools: false, late_terminal: false };
  fs.writeFileSync(journalFile, JSON.stringify(journal));
  const old = { status: 'dispatch-possible', reservation_sha256: 'a'.repeat(64),
    delivery: { manifest_file: manifestFile, manifest_sha256: roots.digest(manifest), receipt_file: next.resultFile + '.receipt.json' },
    final_request_sha256: roots.digest(args), prompt_sha256: roots.digest(args.message) };
  const state = { continuation: old }, options = { executionContract: contract,
    nativeRepackage: { invocationFile: ipcFile, journalFile, nextJournalFile: path.join(dir, 'fresh.json') } };
  const evidence = api.inspect(options, state, request); evidence.assertUnchanged();
  for (const provider_called of [false, 'unknown']) {
    fs.writeFileSync(journalFile, JSON.stringify({ ...journal, provider_called }));
    api.inspect(options, state, request);
  }
  fs.writeFileSync(journalFile, JSON.stringify({ ...journal, provider_called: true }));
  assert.throws(() => api.inspect(options, state, request), /native-repackage-evidence-invalid/);
  fs.writeFileSync(journalFile, JSON.stringify(journal));
  const prepared = { continuation: { ...old, status: 'prepared', repackage_evidence: evidence.evidence }, continuation_history: [old] };
  const resume = { ...options, nativeJournalFile: options.nativeRepackage.nextJournalFile };
  api.inspect(resume, prepared, request, true).assertUnchanged();
  fs.appendFileSync(ipcFile, ' ');
  assert.throws(() => api.inspect(resume, prepared, request, true), /native-repackage-evidence-invalid/);
  console.log('PASS retained evidence: unknown contact is not false, observed contact refuses, prepared restart pins original IPC bytes');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
