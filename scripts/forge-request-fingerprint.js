'use strict';
const crypto = require('crypto');

// Pure historical-data projection, never a binding or dispatch capability.
// Callers must obtain linked identity through their own enforcing boundary.
function projectFingerprint(request, linkedIdentity) {
  const copy = { ...request };
  if (request.linked_begin_key) {
    if (!linkedIdentity) throw new Error('linked-entry-identity-required');
    copy.linked_entry_identity = linkedIdentity;
    delete copy.linkedEntryBinding;
  }
  for (const key of ['rawResult', 'invocationTelemetry', 'providerCalled', 'resultFile',
    'signal', 'publicationSafe', 'publicationBoundary', 'waitForPublicationBoundary', 'ownerBroker']) delete copy[key];
  return crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex');
}

module.exports = { projectFingerprint };
