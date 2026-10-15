'use strict';

// Delivery contracts, shared by the resolver guard and the transport entrypoint.
// A model alias or an installed executable is not a delivery capability.
const ARTIFACT_UNITS = Object.freeze([
  'research-milestone', 'research-slice', 'discuss-milestone', 'discuss-slice',
  'plan-milestone', 'complete-slice', 'complete-milestone', 'plan-check',
]);
const UNIT_MODES = Object.freeze({
  ...Object.fromEntries(ARTIFACT_UNITS.map(unit => [unit, 'artifacts'])),
  'memory-extract': 'memory',
  'plan-slice': 'plan', 'execute-task': 'execute',
  // Scoped writing contract (forge-xllm runFix + forge-review-fix), delivered and
  // published by forge-unit-sidecar. Never an alias of execute: no plan, SUMMARY
  // or checkbox exists for a review fix.
  'review-fix': 'fix',
  'review-challenger': 'challenge', 'review-advocate': 'defend',
  'review-rebuttal': 'rebuttal',
});
function capability(engine, unitType, delivery = {}) {
  let standalone = false;
  let standaloneExecute = false;
  if (delivery && delivery.scope === 'standalone-task') {
    if (unitType === 'execute-task' && delivery.phase === 'execute') standaloneExecute = true;
    else try {
      const contract = require('./forge-task-preparation').phaseContract(delivery.phase);
      standalone = !!contract && contract.unitType === unitType;
    } catch { standalone = false; }
  }
  const mode = standalone ? 'artifacts' : UNIT_MODES[unitType];
  const validScope = (!delivery.scope && delivery.phase === undefined)
    || delivery.scope === 'standalone-task' && (standalone || standaloneExecute);
  const supported = ['claude', 'codex'].includes(engine) && !!mode && validScope;
  return {
    supported, mode: supported ? mode : null,
    reason_code: supported ? 'transport-supported' : 'unsupported-sidecar-unit',
    hint: supported ? `Transport ${engine}/${unitType}: ${mode}.`
      : `No sidecar contract for ${engine}/${unitType || '(missing unit_type)'}. Update Forge or configure an explicitly supported route for this unit; no worker was substituted.`,
  };
}
// Composed delivery proof, independent of the planner's dispatch permission.
// Directory access is not preventive per-file containment; deltas are verified.
function executionCapability(route, contract, options = {}) {
  const engine = route?.resolved_worker_engine || route?.engine;
  const supported = ['claude', 'codex'].includes(engine) && route?.dispatch_allowed === true
    && ['native', 'sidecar'].includes(route.worker_mode) && contract?.schema_version === 2
    && (route.worker_mode !== 'native' || options.nativeInvocation?.ok === true);
  return { supported, reason_code: supported ? 'execution-contract-supported' : 'execution-route-incompatible',
    engine: engine || null, host: route?.host_runtime || null, worker_mode: route?.worker_mode || null,
    transport: route?.worker_mode === 'native' ? 'native' : engine === 'claude' ? 'claude-cli' : 'codex-appserver',
    schema_version: 2, sandbox: 'directory-access-and-post-write-verification',
    additional_roots: true, result: 2, replay: 2, delivery: 2, vcs: ['git', 'svn'] };
}
module.exports = { ARTIFACT_UNITS, UNIT_MODES, capability, executionCapability };
