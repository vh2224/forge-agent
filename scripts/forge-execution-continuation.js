'use strict';
// Retained incomplete code is neither a completed delivery nor reset material.
const fs = require('fs');
const roots = require('./forge-code-roots');
const capabilities = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code, provider_called: false }); };
function incomplete(record) {
  return record?.phase === 'executed' && !!record.execution && record.delivery_capture?.passed === false
    && ['partial', 'blocked'].includes(record.result?.status);
}
function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) fail('continuation-parent-invalid');
  const bytes = fs.readFileSync(file);
  return { record: JSON.parse(bytes), sha256: roots.digest(bytes) };
}
function create({ request, paths, processProbe }) {
  if (request?.scope !== 'standalone-task' || request.phase !== 'execute' || request.memberHandle) fail('continuation-scope-invalid');
  if (typeof processProbe !== 'function' || !Array.isArray(paths) || !paths.length) fail('continuation-proof-required');
  const parentFile = request.resultFile + '.receipt.json', parent = read(parentFile);
  if (!incomplete(parent.record) || parent.record.fingerprint !== require('./forge-unit-sidecar').artifactFingerprint(request)) fail('continuation-parent-invalid');
  if (parent.record.result.pending_questions?.length || request.pending_questions?.some(q => q.status !== 'resolved')) fail('continuation-pending-questions');
  const filters = [{ type: 'unit', id: 'execute-task/' + request.taskId },
    ...(request.workflowId ? [{ type: 'workflow', id: request.workflowId }] : [])];
  for (const filter of filters) {
    const pending = require('./forge-pending-questions').listPendingQuestions({ cwd: request.contextRoot || request.cwd, filter });
    if (pending.questions.some(q => q.status === 'pending')) fail('continuation-pending-questions');
  }
  const contract = roots.validateContract(parent.record.execution.execution_contract, { revalidate: true });
  const declarations = require('./forge-code-roots').validatePlan(fs.readFileSync(request.planFile, 'utf8'), contract).writes;
  const residual = paths.map(p => roots.resolvePath(contract, p)).sort((a,b) => roots.qualified(a) < roots.qualified(b) ? -1 : roots.qualified(a) > roots.qualified(b) ? 1 : 0);
  for (const entry of residual) {
    // Exact leaves only. A continuation cannot smuggle a directory/glob as a
    // narrowed scope. Deletions remain valid exact paths.
    if (/[*?\[\]{}]/.test(entry.path) || fs.existsSync(entry.absolute) && !fs.lstatSync(entry.absolute).isFile()
        || !declarations.some(claim => roots.covers(claim, entry))) fail('continuation-path-outside-plan');
  }
  if (new Set(residual.map(roots.qualified)).size !== residual.length) fail('continuation-path-duplicate');
  const suffix = roots.digest({ parent: parent.sha256, paths: residual.map(roots.qualified).sort() }).slice(0,16);
  const info = { kind: 'retained-partial-continuation', parent_dispatch_id: request.dispatchId,
    parent_receipt_sha256: parent.sha256, paths: residual.map(roots.qualified) };
  const child = { ...request, dispatchId: request.dispatchId + '-continue-' + suffix,
    resultFile: request.resultFile + '.continue-' + suffix, partialContinuation: info,
    ...(request.nativePromptFile ? { nativePromptFile: request.nativePromptFile + '.continue-' + suffix } : {}) };
  const cap = Object.freeze({});
  const state = { request, parentFile, parentSha: parent.sha256, processProbe, residual: residual.map(roots.wire),
    childSha: roots.digest(child), info };
  capabilities.set(cap, state);
  // Idempotent creation may point at an already retained child, whose own
  // canonical replay checks run before preparation. Never overwrite either.
  if (!fs.existsSync(child.resultFile + '.receipt.json')) assertParent(state);
  return { request: child, capability: cap, info: structuredClone(state.info) };
}
function assertParent(state) {
  const parent = read(state.parentFile);
  if (parent.sha256 !== state.parentSha) fail('continuation-parent-changed');
  const inspection = require('./forge-attempt-recovery').inspectReceipt(state.parentFile,
    { request: state.request, processProbe: state.processProbe });
  if (!inspection.process_stopped) fail('continuation-process-not-joined');
  require('./forge-task-execution').assertReplay(state.request, parent.record);
}
function validate(cap, request) {
  const state = capabilities.get(cap);
  if (!state || roots.digest(request) !== state.childSha) fail('continuation-capability-required');
  return state;
}
function apply(cap, request, prepared) {
  const state = validate(cap, request);
  assertParent(state);
  for (const entry of state.residual) if (!prepared.claims.some(claim => roots.covers(claim, entry))) fail('continuation-path-outside-plan');
  prepared.claims = structuredClone(state.residual);
  prepared.continuation_paths = [...state.info.paths];
  prepared.contextText = 'Bounded continuation: preserve existing partial implementation. Only these exact paths may change: '
    + JSON.stringify(state.info.paths) + '\n' + prepared.contextText;
  return structuredClone(state.info);
}
module.exports = { incomplete, create, apply, validate };
