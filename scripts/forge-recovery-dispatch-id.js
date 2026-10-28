'use strict';

const crypto = require('crypto');
const MAX_DISPATCH_ID = 128;

function recoveryDispatchId(parent, continuation = crypto.randomUUID()) {
  if (typeof parent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parent)
    || typeof continuation !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(continuation)) {
    throw Object.assign(new Error('recovery-dispatch-id-invalid'), { code: 'recovery-dispatch-id-invalid' });
  }
  const suffix = '-recovery-' + continuation;
  if (parent.length + suffix.length <= MAX_DISPATCH_ID) return parent + suffix;
  // Keep a readable prefix and bind the entire parent, not just its truncation.
  const digest = crypto.createHash('sha256').update(parent).digest('hex').slice(0, 16);
  return parent.slice(0, MAX_DISPATCH_ID - suffix.length - digest.length - 1) + '-' + digest + suffix;
}

module.exports = { recoveryDispatchId, MAX_DISPATCH_ID };
