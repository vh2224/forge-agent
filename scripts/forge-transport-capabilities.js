'use strict';

// Delivery contracts, shared by the resolver guard and the transport entrypoint.
// A model alias or an installed executable is not a delivery capability.
const ARTIFACT_UNITS = Object.freeze([
  'research-milestone', 'research-slice', 'discuss-milestone', 'discuss-slice',
  'plan-milestone', 'complete-slice', 'complete-milestone', 'plan-check',
]);
const UNIT_MODES = Object.freeze({
  ...Object.fromEntries(ARTIFACT_UNITS.map(unit => [unit, 'artifacts'])),
  'plan-slice': 'plan', 'execute-task': 'execute',
  'review-challenger': 'challenge', 'review-advocate': 'defend',
  'review-rebuttal': 'rebuttal',
});
function capability(engine, unitType) {
  const mode = UNIT_MODES[unitType];
  const supported = ['claude', 'codex'].includes(engine) && !!mode;
  return {
    supported, mode: supported ? mode : null,
    reason_code: supported ? 'transport-supported' : 'unsupported-sidecar-unit',
    hint: supported ? `Transport ${engine}/${unitType}: ${mode}.`
      : `No sidecar contract for ${engine}/${unitType || '(missing unit_type)'}. Update Forge or configure an explicitly supported route for this unit; no worker was substituted.`,
  };
}
module.exports = { ARTIFACT_UNITS, UNIT_MODES, capability };
