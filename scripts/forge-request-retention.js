'use strict';
// Durable exact request data for one artifact attempt (#382). This module is a
// storage boundary: what it returns is historical DATA, never an execution,
// dispatch, broker, linked-entry, claim or recovery capability. Runtime
// authority is always re-established by the live host through the existing APIs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fingerprintApi = require('./forge-request-fingerprint');

const VERSION = 1;
const KIND = 'forge-exact-request-data';
const SUFFIX = '.request.json';
// Capabilities/channels that never enter the archive. Their presence at capture
// is recorded as a usage restriction (runtime_requirements), never as permission.
const RUNTIME_KEYS = Object.freeze([...fingerprintApi.PROJECTION_EXCLUDED.filter(key => key !== 'resultFile'),
  'linkedEntryBinding', 'archived_inspection']);
// Credential-shaped top-level fields are refused before started: the archive
// copies no environment, provider credential or raw result.
const SECRET_FIELD = /^(?:env|environment|credentials?|api[_-]?key|access[_-]?token|token|secret|password|authorization)$/i;

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function fail(code) { throw Object.assign(new Error(code), { code }); }
function physical(directory) {
  if (typeof directory !== 'string' || !directory) fail('request-retention-identity-required');
  return fs.realpathSync.native(path.resolve(directory));
}
// Physical spelling of a file path through its real parent directory.
function physicalSibling(file) {
  if (typeof file !== 'string' || !file) fail('request-retention-binding-mismatch');
  let parent;
  try { parent = fs.realpathSync.native(path.dirname(path.resolve(file))); } catch { fail('request-retention-binding-mismatch'); }
  return pathKey(path.join(parent, path.basename(file)));
}
function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function omit(request, keys) {
  const copy = { ...request };
  for (const key of keys) delete copy[key];
  return copy;
}

// Binding = what the live host can know independently of the lost caller:
// unit coordinates, workflow/dispatch and the physical owner/cwd/code roots.
function binding(request) {
  if (!isObject(request) || typeof request.unitType !== 'string' || !request.unitType
      || typeof request.workflowId !== 'string' || !request.workflowId
      || typeof request.dispatchId !== 'string' || !request.dispatchId) fail('request-retention-identity-required');
  const contract = request.execution_contract;
  const codeRoots = (isObject(contract) && Array.isArray(contract.code_roots) ? contract.code_roots : [])
    .map(root => ({ id: root.id, path: pathKey(physical(root.path)) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { unit_type: request.unitType, milestone_id: request.milestoneId ?? null, slice_id: request.sliceId ?? null,
    task_id: request.taskId ?? null, workflow_id: request.workflowId, dispatch_id: request.dispatchId,
    owner: pathKey(physical(request.contextRoot || request.cwd)), cwd: pathKey(physical(request.cwd)), code_roots: codeRoots };
}
// The single allowed sibling of the actual result file, validated against
// every physical root (outside each, regular, never a symlink/junction target).
function locate(request) {
  const xllm = require('./forge-xllm');
  const bound = binding(request);
  if (typeof request.resultFile !== 'string' || !request.resultFile) fail('request-retention-identity-required');
  // Same root set as unit-sidecar artifactAttemptFiles (cwd, context root, code roots).
  const roots = [request.cwd, request.contextRoot || request.cwd,
    ...(request.execution_contract?.code_roots || []).map(root => root.path)];
  let result;
  try {
    result = path.resolve(request.resultFile);
    for (const root of roots) result = xllm.validateResultFileTarget(result, root);
    for (const root of roots) {
      xllm.validateResultFileTarget(result + SUFFIX, root);
      xllm.validateResultFileTarget(result + '.receipt.json', root);
    }
  } catch (error) { if (error.code) throw error; fail('request-retention-path-invalid'); }
  return { result, file: result + SUFFIX, receipt: result + '.receipt.json', bound };
}
// Regular, single-link, non-symlink file whose opened inode equals both path
// observations; a replacement during the read is refused rather than accepted.
function readStable(file) {
  const fields = ['dev', 'ino', 'size', 'mtimeNs', 'nlink'];
  let before;
  try { before = fs.lstatSync(file, { bigint: true }); } catch { fail('request-retention-unavailable'); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) fail('request-retention-path-invalid');
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const bytes = fs.readFileSync(fd);
    const after = fs.lstatSync(file, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink()) fail('request-retention-path-invalid');
    for (const field of fields) if (before[field] !== opened[field] || opened[field] !== after[field]) fail('request-retention-file-changed');
    if (BigInt(bytes.length) !== opened.size) fail('request-retention-file-changed');
    return bytes;
  } finally { fs.closeSync(fd); }
}
function linkedIdentity(request) {
  if (!request.linked_begin_key) return undefined;
  // Capture happens at the live boundary: the request must carry its own live binding.
  const recovery = require('./forge-attempt-recovery');
  return recovery.requestIdentity(recovery.canonicalRequest(request)).linked_entry;
}
function assertNoSecrets(value) {
  for (const key of Object.keys(value)) if (SECRET_FIELD.test(key)) fail('request-retention-secret-field');
}
function preparationCapture(request, preimage) {
  if (request.preparationRequestFingerprint === undefined) return { preparation_input: 'not-applicable', preparation_json: null };
  if (preimage === undefined) return { preparation_input: 'not-supplied', preparation_json: null };
  if (typeof preimage !== 'string' || sha(preimage) !== request.preparationRequestFingerprint) fail('request-retention-preparation-mismatch');
  let caller; try { caller = JSON.parse(preimage); } catch { fail('request-retention-preparation-mismatch'); }
  if (!isObject(caller) || RUNTIME_KEYS.some(key => Object.hasOwn(caller, key))) fail('request-retention-preparation-runtime-data');
  assertNoSecrets(caller);
  return { preparation_input: 'captured', preparation_json: preimage };
}
function envelope(request, preimage) {
  const loc = locate(request);
  assertNoSecrets(request);
  const input = omit(request, RUNTIME_KEYS);
  const deliveryJson = JSON.stringify(fingerprintApi.projectRequestData(request, linkedIdentity(request)));
  const inputJson = JSON.stringify(input);
  const callerHashOf = value => { try { return require('./forge-attempt-recovery').callerRequestHash(value); } catch { return null; } };
  const callerHash = callerHashOf(request);
  const prep = preparationCapture(request, preimage);
  const data = { schema_version: VERSION, kind: KIND, binding: loc.bound, result_file: loc.result,
    delivery_fingerprint: sha(deliveryJson), delivery_json: deliveryJson, delivery_input_json: inputJson,
    preparation_fingerprint: request.preparationRequestFingerprint ?? null, ...prep,
    // The caller hash is reproducible only when the archived wire bytes alone
    // produce it; otherwise a resume needing it is refused, never substituted.
    caller_request_sha256: callerHash,
    caller_request_reproducible: callerHash !== null && callerHashOf(JSON.parse(inputJson)) === callerHash,
    runtime_requirements: { linked_entry: !!request.linked_begin_key, owner_broker: !!request.ownerBroker },
    runtime_fields: RUNTIME_KEYS.filter(key => Object.hasOwn(request, key)).sort() };
  return { loc, data, bytes: Buffer.from(JSON.stringify(data) + '\n') };
}
function reference(loc, bytes, data) {
  return { schema_version: VERSION, file: path.basename(loc.file), sha256: sha(bytes),
    delivery_fingerprint: data.delivery_fingerprint, preparation_fingerprint: data.preparation_fingerprint,
    preparation_input: data.preparation_input, runtime_requirements: data.runtime_requirements };
}
function decode(bytes, loc) {
  let data;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { fail('request-retention-data-invalid'); }
  if (!isObject(data) || data.schema_version !== VERSION || data.kind !== KIND || data.result_file !== loc.result
      || !same(data.binding, loc.bound) || typeof data.delivery_json !== 'string' || typeof data.delivery_input_json !== 'string'
      || !(data.preparation_json === null || typeof data.preparation_json === 'string')
      || !['captured', 'not-supplied', 'not-applicable'].includes(data.preparation_input)
      || !isObject(data.runtime_requirements) || typeof data.runtime_requirements.owner_broker !== 'boolean'
      || !(data.caller_request_sha256 === null || typeof data.caller_request_sha256 === 'string')
      || typeof data.caller_request_reproducible !== 'boolean' || !Array.isArray(data.runtime_fields)) fail('request-retention-binding-mismatch');
  let input;
  try { input = JSON.parse(data.delivery_input_json); } catch { fail('request-retention-data-invalid'); }
  if (!isObject(input) || RUNTIME_KEYS.some(key => Object.hasOwn(input, key))) fail('request-retention-runtime-data-invalid');
  if (!same(binding(input), loc.bound) || locate(input).result !== loc.result) fail('request-retention-binding-mismatch');
  if (sha(data.delivery_json) !== data.delivery_fingerprint
      || (input.preparationRequestFingerprint ?? null) !== data.preparation_fingerprint
      || (data.preparation_input === 'captured') !== (data.preparation_json !== null)
      || data.preparation_json !== null && sha(data.preparation_json) !== data.preparation_fingerprint
      || data.runtime_requirements.linked_entry !== !!input.linked_begin_key) fail('request-retention-fingerprint-mismatch');
  // The archived wire data must reproduce the archived preimage byte for byte.
  // A linked identity is taken from the preimage here only to compare order and
  // fields; its authenticity is proven separately against the actual begin.
  let preimage;
  try { preimage = JSON.parse(data.delivery_json); } catch { fail('request-retention-data-invalid'); }
  if (JSON.stringify(fingerprintApi.projectRequestData(input, input.linked_begin_key ? preimage.linked_entry_identity : undefined))
      !== data.delivery_json) fail('request-retention-fingerprint-mismatch');
  return data;
}
function writeExclusive(file, bytes) {
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return true;
}

// Capture BEFORE the started receipt/provider. Deterministic bytes: an orphan
// left by an earlier crash is reused only when byte-identical (or, for a
// delivery without the caller preimage, when the preparation owner captured
// the same delivery with it). Different/partial bytes are never overwritten.
function retain(request, options = {}) {
  const { loc, data, bytes } = envelope(request, options.preparationPreimage);
  if (!writeExclusive(loc.file, bytes)) {
    const existing = readStable(loc.file);
    if (!existing.equals(bytes)) {
      if (options.preparationPreimage !== undefined || data.preparation_input !== 'not-supplied') fail('request-retention-conflict');
      let saved;
      try { saved = decode(existing, loc); } catch { fail('request-retention-conflict'); }
      const comparable = value => omit(value, ['preparation_input', 'preparation_json']);
      if (saved.preparation_input !== 'captured' || !same(comparable(saved), comparable(data))) fail('request-retention-conflict');
      return reference(loc, existing, saved);
    }
  }
  const written = readStable(loc.file);
  if (!written.equals(bytes)) fail('request-retention-file-changed');
  return reference(loc, written, decode(written, loc));
}

// Reader: the receipt locator never selects a file. The only allowed sibling
// is derived from the live expected result path and physical roots.
function read(receipt, expected, options = {}) {
  if (!isObject(receipt) || !isObject(receipt.retained_request)) fail('request-retention-unavailable');
  const loc = locate(expected), ref = receipt.retained_request;
  if (options.receiptPath !== undefined && physicalSibling(options.receiptPath) !== pathKey(loc.receipt)) fail('request-retention-binding-mismatch');
  if (ref.schema_version !== VERSION || ref.file !== path.basename(loc.file) || receipt.dispatch_id !== expected.dispatchId) fail('request-retention-binding-mismatch');
  const bytes = readStable(loc.file);
  if (sha(bytes) !== ref.sha256) fail('request-retention-hash-mismatch');
  const data = decode(bytes, loc);
  if (!same(reference(loc, bytes, data), ref) || data.delivery_fingerprint !== receipt.fingerprint
      || (receipt.request_fingerprint || null) !== (data.preparation_fingerprint || null)) fail('request-retention-fingerprint-mismatch');
  return Object.freeze({ kind: 'retained-request-data-only', archive_sha256: ref.sha256, result_file: loc.result,
    receipt_file: loc.receipt, delivery_fingerprint: data.delivery_fingerprint, delivery_json: data.delivery_json,
    delivery_input_json: data.delivery_input_json, preparation_fingerprint: data.preparation_fingerprint,
    preparation_input: data.preparation_input, preparation_json: data.preparation_json,
    caller_request_sha256: data.caller_request_reproducible === true ? data.caller_request_sha256 : null,
    runtime_requirements: Object.freeze({ ...data.runtime_requirements }), runtime_fields: Object.freeze([...data.runtime_fields || []]),
    binding: data.binding, runtime_authority_restored: false,
    // A fresh plain-data object for every caller: no handle, broker or binding.
    restore: () => JSON.parse(data.delivery_input_json) });
}

// Live boundary check for a receipt that already exists. Legacy receipts keep
// their original external-request policy (no backfill). A retained archive
// must match the live request exactly, and a recorded runtime requirement
// cannot silently disappear: missing broker/linked capability refuses.
function assertForReceipt(request, receipt) {
  if (!receipt?.retained_request) return { legacy: true, retained: false };
  const data = read(receipt, request);
  // Saved-response publication needs the same real capabilities the attempt
  // had. (A started attempt keeps its existing acceptance/drift policy.)
  if (['ready', 'executed'].includes(receipt.phase)) {
    if (data.runtime_requirements.owner_broker && !request.ownerBroker) fail('request-retention-broker-required');
    if (data.runtime_requirements.linked_entry && !request.linkedEntryBinding) fail('request-retention-linked-binding-required');
  }
  if (JSON.stringify(fingerprintApi.projectRequestData(request, linkedIdentity(request))) !== data.delivery_json) fail('request-retention-fingerprint-mismatch');
  // A live broker used for replay must be the attempt's original one; a new
  // S0/startBroker or imported manifest is not a reattachment.
  if (request.ownerBroker && ['ready', 'executed'].includes(receipt.phase)) {
    const broker = require('./forge-artifact-reconciliation').assertBroker(request.ownerBroker);
    if (broker.manifest.request_sha256 !== data.delivery_fingerprint
        || receipt.broker_manifest_sha256 && broker.manifest_sha256 !== receipt.broker_manifest_sha256) fail('broker-attempt-binding');
  }
  return data;
}

module.exports = { VERSION, SUFFIX, RUNTIME_KEYS, retain, read, assertForReceipt, readStable, locate, physicalSibling };
