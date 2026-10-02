'use strict';

// One absolute deadline per sidecar attempt. Heartbeats never extend it.
const DEFAULT_WORKER_TIMEOUT_SECS = 300;

module.exports = { DEFAULT_WORKER_TIMEOUT_SECS };
