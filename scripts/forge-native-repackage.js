'use strict';
// Evidence validation only. Only the transition's live host adapter can authorize
// replacement; a journal, an absent process or imported JSON cannot do so.
const fs = require('fs');
const { digest, key } = require('./forge-code-roots');
const fail = () => { throw Object.assign(new Error('native-repackage-evidence-invalid'), { code: 'native-repackage-evidence-invalid', provider_called: false }); };
// Wire evidence never carries an opaque process-local capability. Comparing
// these data projections grants no authority; callers must reattest live entry.
function wireRequest(request) {
  const { linkedEntryBinding: ignored, ...wire } = request;
  return wire;
}
function preserveRequest(current, retained) {
  // Runtime maintenance changes the resolver's source observation, not the
  // historical request seal. Every other route/request field must still match;
  // the current resolver and native adapter remain the dispatch authority.
  const { route: currentRoute, ...currentRequest } = wireRequest(current);
  const { route: retainedRoute, ...retainedRequest } = wireRequest(retained);
  const { resolution_sources: currentSources, ...currentPolicy } = currentRoute;
  const { resolution_sources: retainedSources, ...retainedPolicy } = retainedRoute;
  const equal = require('util').isDeepStrictEqual;
  if (!Array.isArray(currentSources) || !Array.isArray(retainedSources)
      || !equal(currentRequest, retainedRequest) || !equal(currentPolicy, retainedPolicy)) fail();
  return { ...structuredClone(wireRequest(retained)),
    ...(current.linkedEntryBinding ? { linkedEntryBinding: current.linkedEntryBinding } : {}) };
}
function inspect(options, state, request, resumePrepared = false) {
  const retained = state.continuation?.repackage_evidence;
  const input = resumePrepared ? { invocationFile: retained?.invocation_file, journalFile: retained?.journal_file,
    nextJournalFile: options.nativeJournalFile } : options.nativeRepackage;
  const old = resumePrepared ? state.continuation_history?.find(row => row.reservation_sha256 === state.continuation.reservation_sha256) : state.continuation;
  if (!input || old?.status !== 'dispatch-possible' || !old.delivery
      || resumePrepared && (state.continuation.status !== 'prepared' || !retained)
      || !resumePrepared && state.continuation_history?.some(row => row.reservation_sha256 === old.reservation_sha256)) fail();
  const recovery = require('./forge-attempt-recovery');
  if (!input.nextJournalFile || key(input.nextJournalFile) === key(input.journalFile)
      || fs.existsSync(input.nextJournalFile)) fail();
  recovery.validateStateTarget(input.nextJournalFile, request, request.execution_contract || options.executionContract);
  const files = [input.invocationFile, input.journalFile, old.delivery.manifest_file];
  for (const file of files) recovery.validateStateTarget(file, request, request.execution_contract || options.executionContract);
  const bytes = files.map(file => fs.readFileSync(file));
  const [ipc, journal, manifest] = bytes.map(value => JSON.parse(value));
  if (digest(bytes[2]) !== old.delivery.manifest_sha256 || ipc.manifest_file !== old.delivery.manifest_file
      || digest(wireRequest(ipc.request)) !== digest(wireRequest(manifest.request)) || digest(ipc.args) !== old.final_request_sha256
      || digest(ipc.args?.message) !== old.prompt_sha256
      || old.delivery.manifest_file !== manifest.request.resultFile + '.manifest.json'
      || old.delivery.receipt_file !== manifest.request.resultFile + '.receipt.json'
      || journal.schema_version !== 1 || !['started', 'interrupted'].includes(journal.phase)
      || journal.sequence !== -1 || journal.first_remote_ms !== null || journal.last_remote_ms !== null
      || journal.handle_sha256 !== null || journal.open_tools !== false || journal.late_terminal !== false
      || journal.provider_called === true) fail();
  const absent = [manifest.request.resultFile, old.delivery.receipt_file, manifest.request.resultFile + '.returned.json'];
  const hashes = bytes.map(digest);
  let consumed = false;
  const assertUnchanged = () => {
    if (files.some((file, i) => digest(fs.readFileSync(file)) !== hashes[i]) || !consumed && absent.some(file => fs.existsSync(file))) fail();
  };
  assertUnchanged();
  const evidence = { continuation_sha256: digest(old), invocation_file: input.invocationFile, journal_file: input.journalFile, invocation_file_sha256: hashes[0],
    journal_file_sha256: hashes[1], manifest_sha256: hashes[2], full_prompt_sha256: old.prompt_sha256 };
  if (resumePrepared && digest(evidence) !== digest(retained)) fail();
  return { evidence, manifest, old: structuredClone(old), assertUnchanged,
    consumed() { if (consumed) fail(); assertUnchanged(); consumed = true; },
    validateInvocation(invocation) {
      assertUnchanged();
      const rebuilt = { ...invocation, args: ipc.args };
      if (digest(rebuilt) !== old.invocation_sha256
          // The original journal was sealed over the original IPC identity,
          // which can contain a serialized empty handle. Keep those historical
          // bytes; wire equivalence above never rewrites that identity/hash.
          || require('./forge-native-supervision').digest(JSON.stringify({ invocation: rebuilt, identity: ipc.request })) !== journal.identity
          || digest({ ...invocation.args, message: ipc.args.message }) !== digest(ipc.args)) fail();
      const mapped = require('./forge-native-prompt-file').prepare({
        file: manifest.request.resultFile + '.native-prompt.txt', prompt: ipc.args.message,
        contract: manifest.request.execution_contract, deferWrite: true });
      if (invocation.args.message !== mapped.message) fail();
      mapped.materialize();
      mapped.assertUnchanged();
    }, journalFile: input.journalFile };
}
module.exports = { inspect, preserveRequest };
