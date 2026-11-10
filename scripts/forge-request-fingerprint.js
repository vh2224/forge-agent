'use strict';
const crypto = require('crypto');

// Runtime-only request fields. They are capabilities or transport channels,
// never part of the historical artifact preimage.
const PROJECTION_EXCLUDED = Object.freeze(['rawResult', 'invocationTelemetry', 'providerCalled', 'resultFile',
  'signal', 'publicationSafe', 'publicationBoundary', 'waitForPublicationBoundary', 'ownerBroker']);

// Pure historical-data projection, never a binding or dispatch capability.
// Callers must obtain linked identity through their own enforcing boundary.
// Property order is the caller's insertion order; a linked identity keeps an
// existing position or is appended, exactly as the original fingerprint did.
function projectRequestData(request, linkedIdentity) {
  const copy = { ...request };
  if (request.linked_begin_key) {
    if (!linkedIdentity) throw new Error('linked-entry-identity-required');
    copy.linked_entry_identity = linkedIdentity;
    delete copy.linkedEntryBinding;
  }
  for (const key of PROJECTION_EXCLUDED) delete copy[key];
  return copy;
}

function projectFingerprint(request, linkedIdentity) {
  return crypto.createHash('sha256').update(JSON.stringify(projectRequestData(request, linkedIdentity))).digest('hex');
}

module.exports = { projectFingerprint, projectRequestData, PROJECTION_EXCLUDED };
