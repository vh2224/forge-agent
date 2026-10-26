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
module.exports = { createPolicy, validatePolicy };
