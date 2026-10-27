'use strict';

// Safety ceiling per sidecar attempt. Liveness (forge-sidecar-liveness.js) is
// the primary authority: a dead start or dead silence ends the attempt early.
// The ceiling only acts while the worker is still alive, bounding a healthy but
// overlong run. It is resolved from the unit tier (single table TIER_CEILING_MS)
// or from an explicit workers.timeout, always with a traceable source.

const { TIER_CEILING_MS, ceilingForTier } = require('./forge-sidecar-liveness');

// Detection marker for the inherited default (present in real operator prefs).
// Configuration without explicit CLI provenance keeps this compatibility rule.
// An intentional --timeout 300 is a supported ceiling, just like 299 or 301.
const LEGACY_WORKER_TIMEOUT_SECS = 300;
// setTimeout overflows above 2^31-1 ms and fires after ~1 ms; 86400 s stays safely below.
const MAX_EXPLICIT_TIMEOUT_SECS = 86400;
const CEILING_SOURCES = Object.freeze(['tier-default', 'explicit', 'legacy-300-ignored']);
const FALLBACK_TIER = 'standard';
const PROTECTED_WINDOW_GRACE_MS = 60000;
const MAX_PROTECTED_WINDOW_MS = Math.max(...Object.values(TIER_CEILING_MS)) + PROTECTED_WINDOW_GRACE_MS;

function isValidExplicit(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_EXPLICIT_TIMEOUT_SECS;
}

function ceiling(seconds, source, tier, tierFallback, warning) {
  return Object.freeze({ seconds, ms: seconds * 1000, source, tier, tier_fallback: tierFallback, warning });
}

function warning(code, message) {
  return Object.freeze({ code, message });
}

/** Resolve the safety ceiling; explicitSource 'cli' distinguishes a flag from legacy configuration. */
function resolveWorkerCeiling({ tier, explicit, explicitSource } = {}) {
  const tierMs = ceilingForTier(tier);
  const tierFallback = tierMs === null;
  const effectiveTier = tierFallback ? FALLBACK_TIER : tier;
  const tierSecs = (tierFallback ? TIER_CEILING_MS[FALLBACK_TIER] : tierMs) / 1000;

  if (explicit === undefined || explicit === null) {
    return ceiling(tierSecs, 'tier-default', effectiveTier, tierFallback, null);
  }
  if (explicit === LEGACY_WORKER_TIMEOUT_SECS && explicitSource !== 'cli') {
    return ceiling(tierSecs, 'legacy-300-ignored', effectiveTier, tierFallback, warning('legacy-300-ignored',
      `workers.timeout=${LEGACY_WORKER_TIMEOUT_SECS} (default antigo) ignorado: usando o teto do tier `
      + `${effectiveTier} (${tierSecs}s). Defina outro valor explícito para sobrescrever.`));
  }
  if (isValidExplicit(explicit)) {
    return ceiling(explicit, 'explicit', effectiveTier, tierFallback, null);
  }
  return ceiling(tierSecs, 'tier-default', effectiveTier, tierFallback, warning('workers-timeout-invalid',
    `workers.timeout=${String(explicit)} inválido (esperado inteiro entre 1 e ${MAX_EXPLICIT_TIMEOUT_SECS}): `
    + `usando o teto do tier ${effectiveTier} (${tierSecs}s).`));
}

/** Trust an already-resolved route; otherwise (legacy route) resolve by the same rule. */
function ceilingFromRoute(route) {
  const r = route && typeof route === 'object' ? route : {};
  const value = r.workers_timeout;
  if (CEILING_SOURCES.includes(r.workers_timeout_source) && isValidExplicit(value)) {
    // Non-explicit sources always equal the tier ceiling; a different value is a historical
    // cumulative-clock remainder written over the source, never a real setting.
    if (r.workers_timeout_source !== 'explicit') {
      const tierResolved = resolveWorkerCeiling({ tier: r.tier,
        explicit: r.workers_timeout_source === 'legacy-300-ignored' ? LEGACY_WORKER_TIMEOUT_SECS : undefined });
      if (value !== tierResolved.seconds) return tierResolved;
    }
    const tierFallback = ceilingForTier(r.tier) === null;
    return ceiling(value, r.workers_timeout_source, tierFallback ? FALLBACK_TIER : r.tier, tierFallback,
      r.workers_timeout_warning && typeof r.workers_timeout_warning === 'object'
        ? warning(r.workers_timeout_warning.code, r.workers_timeout_warning.message) : null);
  }
  return resolveWorkerCeiling({ tier: r.tier, explicit: value });
}

/** Owner protected-window duration covering a ceiling, bounded by MAX_PROTECTED_WINDOW_MS. */
function protectedWindowMs(ceilingMs) {
  const wanted = ceilingMs + PROTECTED_WINDOW_GRACE_MS;
  return Object.freeze({ duration_ms: Math.min(wanted, MAX_PROTECTED_WINDOW_MS),
    covers: wanted <= MAX_PROTECTED_WINDOW_MS });
}

module.exports = {
  LEGACY_WORKER_TIMEOUT_SECS,
  MAX_EXPLICIT_TIMEOUT_SECS,
  CEILING_SOURCES,
  PROTECTED_WINDOW_GRACE_MS,
  MAX_PROTECTED_WINDOW_MS,
  resolveWorkerCeiling,
  ceilingFromRoute,
  protectedWindowMs,
};
