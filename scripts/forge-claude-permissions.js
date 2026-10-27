'use strict';

// Invocation permissions are derived from the owner's canonical verification
// seal, never prompt text. This is an integrity binding, not consent from JSON:
// the unit owner still validates authority/claims before calling the transport.
// Initial representable subset: node [--check] relative JS file. No shell
// operators, quoting, wildcard/prefix rules, extra arguments or extra roots.
const roots = require('./forge-code-roots');
const HEX = /^[a-f0-9]{64}$/;
function fail(code = 'claude-permission-policy-invalid') {
  throw Object.assign(new Error(code), { code, reason_code: code, provider_called: false, layer: 'caller' });
}
function createPolicy({ seal, contract, identity, cwd } = {}) {
  try {
    contract = roots.validateContract(contract, { revalidate: true });
    const { sha256, ...body } = seal || {};
    if (!HEX.test(sha256 || '') || sha256 !== roots.digest(body) || body.schema_version !== 1
        || body.execution_contract_sha256 !== roots.digest(contract)
        || !HEX.test(body.plan_sha256 || '') || roots.digest(body.identity) !== roots.digest(identity)
        || !HEX.test(identity?.fingerprint || '') || !identity?.dispatch_id
        || !Array.isArray(body.roots) || body.roots.length !== 1 || contract.code_roots.length !== 1) fail();
    const root = contract.code_roots[0], row = body.roots[0];
    if (roots.key(roots.realDirectory(cwd)) !== roots.key(root.path) || row.root_id !== root.id
        || !Array.isArray(row.commands) || !row.commands.length || row.commands.length > 64
        || !Array.isArray(row.origins) || row.origins.length !== row.commands.length
        || !Array.isArray(row.configuration_sources) || row.configuration_sources.length !== row.commands.length
        || [...row.origins, ...row.configuration_sources].some(v => typeof v !== 'string' || !v || v.length > 128)) fail();
    const rules = row.commands.map(command => {
      if (typeof command !== 'string' || command.length > 512) fail('claude-permission-command-unsupported');
      // ASCII spaces and portable unquoted paths only. Deliberately do not
      // normalize shell syntax: the rule must match the exact sealed command.
      const match = /^node (?:--check )?([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:js|cjs|mjs))$/.exec(command);
      if (!match) fail('claude-permission-command-unsupported');
      const file = roots.resolvePath(contract, { root_id: root.id, path: match[1] });
      if (file.path !== match[1]) fail('claude-permission-command-unsupported');
      return `Bash(${command})`;
    });
    // A canonical recovery gets a new dispatch/request fingerprint. Preserve
    // the exact permission scope across that transition, not the old request.
    const { identity: ignoredIdentity, ...resumeScope } = body;
    const session_sha256 = roots.digest(resumeScope);
    const policy = { schema_version: 1, seal, contract, identity, cwd: root.path, rules, session_sha256 };
    return { ...policy, sha256: roots.digest(policy) };
  } catch (error) {
    if (error?.code?.startsWith('claude-permission-')) throw error;
    fail();
  }
}
function validatePolicy(policy, { cwd, readOnly, identity } = {}) {
  if (policy === undefined || policy === null) return null; // legacy: no new permission
  if (readOnly || !identity) fail();
  const expected = createPolicy({ seal: policy.seal, contract: policy.contract, identity, cwd });
  if (roots.digest(expected) !== roots.digest(policy)) fail();
  return expected;
}
const unsupported = new WeakMap();
// A refusal observation, not authorization. Rebuild it from current physical
// inputs after restart; neither its serialized id nor a self-hashed seal works.
function inspectUnsupported({ request, seal, identity }) {
  const recovery = require('./forge-attempt-recovery');
  recovery.requestIdentity(request);
  require('./forge-unit-sidecar').validateRecoveryRequest(request);
  const contract = roots.validateContract(request.execution_contract, { revalidate: true });
  if (!request.workflowId || !request.resultFile) fail();
  for (const suffix of ['', '.receipt.json', '.returned.json']) {
    recovery.validateStateTarget(`${request.resultFile}${suffix}`, request, contract);
  }
  if (request.claudePermissions !== 'verification' || request.route?.worker_mode !== 'sidecar'
      || request.route?.resolved_worker_engine !== 'claude' || request.route?.dispatch_allowed !== true
      || !request.route?.effort || !(request.route?.model_resolved || request.route?.model)
      || !HEX.test(identity?.fingerprint || '') || identity?.dispatch_id !== request.dispatchId
      || !identity.dispatch_id || request.unitType !== 'execute-task' || request.phase !== 'execute'
      || roots.key(roots.realDirectory(request.contextRoot)) !== roots.key(contract.owner)
      || roots.key(roots.realDirectory(request.cwd)) !== roots.key(contract.code_roots.find(r => r.id === contract.primary_root_id)?.path)) fail();
  const plan = require('fs').readFileSync(request.planFile, 'utf8');
  roots.validatePlan(plan, contract);
  // Validate the complete generic command contract BEFORE categorizing a valid
  // request as outside this adapter's representable subset.
  const expected = require('./forge-verify').normalizeExecutionVerification(contract, plan, request.verification, {}, identity);
  if (roots.digest(expected) !== roots.digest(seal)) fail();
  if (contract.code_roots.length <= 1) fail('claude-permission-incompatibility-not-proven');
  return { reason_code: 'claude-permission-multiroot-unsupported', request_sha256: recovery.callerRequestHash(request),
    roots_sha256: roots.digest(contract), seal_sha256: expected.sha256, route_key: recovery.routeKey(request.route) };
}
function createUnsupportedPreflight(input) {
  const proof = inspectUnsupported(input), handle = Object.freeze({});
  unsupported.set(handle, { input, proof });
  return handle;
}
function assertUnsupportedPreflight(handle, request) {
  const saved = unsupported.get(handle);
  if (!saved || require('./forge-attempt-recovery').callerRequestHash(request) !== saved.proof.request_sha256) fail('claude-permission-preflight-required');
  const current = inspectUnsupported({ ...saved.input, request });
  if (roots.digest(current) !== roots.digest(saved.proof)) fail('claude-permission-preflight-changed');
  return Object.freeze(current);
}
module.exports = { createPolicy, validatePolicy, createUnsupportedPreflight, assertUnsupportedPreflight };
