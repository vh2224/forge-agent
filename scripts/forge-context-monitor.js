'use strict';

/**
 * forge-context-monitor.js — pure logic for context-window monitoring.
 *
 * Role: shared by forge-statusline.js (bridge writer) and forge-hook.js
 * (PostToolUse reader). Contains ZERO I/O except readContextMonitorPrefs().
 * Silent-fail is the CALLER's responsibility (MEM008).
 *
 * Exported shapes:
 *
 *   DEFAULT_THRESHOLDS: { warning: number, critical: number }
 *     Fractions of context REMAINING (0–1). E.g. 0.35 = 35% remaining.
 *
 *   DEBOUNCE_TOOLUSES: number
 *     How many tool-uses must pass before re-injecting at the same severity.
 *
 *   STALE_MS: number
 *     Max age (ms) of the bridge file before it is treated as stale.
 *
 *   severityFor(pctRemaining, thresholds?) → 'none' | 'warning' | 'critical'
 *     Maps fraction-remaining to severity bucket.
 *
 *   isStale(ts, now?, maxAgeMs?) → boolean
 *     Returns true if the bridge timestamp is absent or too old.
 *
 *   shouldInject(severity, debounceState) → { inject: boolean, nextState: DebounceState }
 *     Pure state machine for debounce-with-escalation. CALLER persists nextState.
 *     DebounceState = { lastSeverity: string, toolUsesSinceLast: number }
 *
 *   buildAdditionalContext(severity) → string
 *     Human-readable pt-BR instruction injected into the agent's additionalContext.
 *
 *   readContextMonitorPrefs(cwd) → { enabled: boolean, thresholds: { warning, critical } }
 *     Cascades user→repo→local prefs. Regex-only, zero YAML parser (MEM004).
 */

const { readPrefsCached } = require('./forge-prefs.js');

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = Object.freeze({ checkpoint: 0.40, warning: 0.35, critical: 0.25 });
const DEBOUNCE_TOOLUSES = 5;
const STALE_MS = 60_000;
const BRIDGE_VERSION = 2;
const HOST_SOURCES = Object.freeze({ claude: 'claude-statusline', codex: 'codex-app-server' });
let configuredDebounceToolUses = DEBOUNCE_TOOLUSES;

// Severity ranking (higher index = more severe)
const SEVERITY_RANK = { none: 0, checkpoint: 1, warning: 2, critical: 3 };

function normalizePercentage(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return value / 100;
}

function createContextSnapshot(input, now) {
  const source = input && typeof input.source === 'string' ? input.source : 'unknown';
  const requestedHost = input && input.host_runtime;
  const hostRuntime = requestedHost === 'claude' || requestedHost === 'codex' ? requestedHost : 'unknown';
  const recognizedContract = hostRuntime !== 'unknown' && source === HOST_SOURCES[hostRuntime];
  const sessionId = input && typeof input.session_id === 'string' ? input.session_id : null;
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const capability = recognizedContract && input && input.capability === true;
  const used = capability ? normalizePercentage(input.used_percentage) : null;
  const snapshot = {
    version: BRIDGE_VERSION, host_runtime: hostRuntime,
    source, capability, session_id: sessionId,
    timestamp, epoch: input && input.epoch != null ? String(input.epoch) : '0',
    measurement: used === null ? 'unknown' : 'measured',
  };
  if (used !== null) {
    snapshot.used_percentage = used;
    snapshot.remaining_percentage = 1 - used;
  }
  if (input && input.compaction_measurement === 'known' && Number.isInteger(input.compaction_count) && input.compaction_count >= 0) {
    snapshot.compaction_measurement = 'known';
    snapshot.compaction_count = input.compaction_count;
  } else snapshot.compaction_measurement = 'unknown';
  return snapshot;
}

function usableSnapshot(snapshot, now, maxAgeMs) {
  return !!snapshot && snapshot.version === BRIDGE_VERSION && snapshot.measurement === 'measured'
    && snapshot.capability === true && HOST_SOURCES[snapshot.host_runtime] === snapshot.source
    && !isStale(snapshot.timestamp, now, maxAgeMs)
    && Number.isFinite(snapshot.remaining_percentage);
}

// ── Pure functions ─────────────────────────────────────────────────────────────

/**
 * severityFor — map a fraction-remaining value to a severity string.
 *
 * @param {number} pctRemaining  Fraction 0–1 of context remaining.
 * @param {object} thresholds    Optional. Defaults to DEFAULT_THRESHOLDS.
 * @returns {'none'|'warning'|'critical'}
 */
function severityFor(pctRemaining, thresholds) {
  const t = thresholds || DEFAULT_THRESHOLDS;
  if (typeof pctRemaining !== 'number' || isNaN(pctRemaining)) return 'none';
  // Critical must be tested BEFORE warning (critical < warning threshold).
  if (pctRemaining <= t.critical) return 'critical';
  if (pctRemaining <= t.warning) return 'warning';
  if (pctRemaining <= t.checkpoint) return 'checkpoint';
  return 'none';
}

/**
 * isStale — decide if a bridge timestamp is too old to be trusted.
 *
 * @param {number|null|undefined} ts  Timestamp (ms since epoch) from bridge file.
 * @param {number} now                Current time. Defaults to Date.now().
 * @param {number} maxAgeMs           Max allowed age. Defaults to STALE_MS.
 * @returns {boolean}
 */
function isStale(ts, now, maxAgeMs) {
  const n = (now === undefined || now === null) ? Date.now() : now;
  const max = (maxAgeMs === undefined || maxAgeMs === null) ? STALE_MS : maxAgeMs;
  if (!ts) return true;
  return (n - ts) > max;
}

/**
 * shouldInject — decide whether to inject additionalContext and compute next state.
 *
 * Escalation rule (MEM007): if severity is more severe than lastSeverity,
 * inject immediately even if toolUsesSinceLast < DEBOUNCE_TOOLUSES.
 *
 * @param {'none'|'warning'|'critical'} severity
 * @param {{ lastSeverity?: string, toolUsesSinceLast?: number }|null} debounceState
 * @returns {{ inject: boolean, nextState: { lastSeverity: string, toolUsesSinceLast: number } }}
 */
function shouldInject(severity, debounceState, debounceToolUses) {
  const state = debounceState || {};
  const lastSeverity = state.lastSeverity || 'none';
  const toolUsesSinceLast = typeof state.toolUsesSinceLast === 'number'
    ? state.toolUsesSinceLast : 0;

  if (severity === 'none') {
    // No injection — but still increment counter so debounce clock keeps ticking
    return {
      inject: false,
      nextState: { lastSeverity, toolUsesSinceLast: toolUsesSinceLast + 1 },
    };
  }

  const currentRank = SEVERITY_RANK[severity] || 0;
  const lastRank = SEVERITY_RANK[lastSeverity] || 0;
  const isEscalation = currentRank > lastRank;

  if (isEscalation) {
    // Escalation always injects, resets counter
    return {
      inject: true,
      nextState: { lastSeverity: severity, toolUsesSinceLast: 0 },
    };
  }

  // Same or lower severity: respect debounce window
  const window = Number.isInteger(debounceToolUses) && debounceToolUses >= 0
    ? debounceToolUses : configuredDebounceToolUses;
  if (toolUsesSinceLast >= window) {
    return {
      inject: true,
      nextState: { lastSeverity: severity, toolUsesSinceLast: 0 },
    };
  }

  return {
    inject: false,
    nextState: { lastSeverity, toolUsesSinceLast: toolUsesSinceLast + 1 },
  };
}

/**
 * buildAdditionalContext — pt-BR instruction string for the agent's additionalContext.
 *
 * @param {'none'|'warning'|'critical'} severity
 * @param {{ warning: number, critical: number }} [thresholds]  Configured thresholds
 *        (fractions). Messages render the REAL configured value (S03 review R8) —
 *        defaults to DEFAULT_THRESHOLDS when omitted.
 * @returns {string}
 */
function buildAdditionalContext(severity, thresholds) {
  const t = thresholds || DEFAULT_THRESHOLDS;
  if (severity === 'checkpoint') {
    const pct = Math.round(t.checkpoint * 100);
    return `[FORGE CONTEXT MONITOR — CHECKPOINT] Contexto medido abaixo de ${pct}% restante. `
      + 'Conclua a unidade atual e crie ou atualize o checkpoint no próximo boundary seguro; não pause a run.';
  }
  if (severity === 'warning') {
    const pct = Math.round(t.warning * 100);
    return `[FORGE CONTEXT MONITOR — WARNING] Contexto do agente está abaixo de ${pct}% restante. `
      + 'Encerre a task atual, não inicie trabalho complexo novo. '
      + 'Conclua o que está em andamento e retorne o resultado.';
  }
  if (severity === 'critical') {
    const pct = Math.round(t.critical * 100);
    return `[FORGE CONTEXT MONITOR — CRITICAL] Contexto do agente está abaixo de ${pct}% restante. `
      + 'Pare imediatamente. Salve o estado atual em `continue.md` dentro do diretório da task '
      + 'e retorne `partial` com o trabalho concluído até agora. '
      + 'Não tente iniciar nem terminar nenhuma etapa adicional.';
  }
  return '';
}

// ── Prefs reader ───────────────────────────────────────────────────────────────

/**
 * readContextMonitorPrefs — read the merged preference engine result.
 *
 * Reads context_monitor.* keys:
 *   enabled: true|false            (default true)
 *   warning_threshold: 0.35|35     (fraction or percent)
 *   critical_threshold: 0.25|25    (fraction or percent)
 *
 * @param {string} cwd  Project working directory (WORKING_DIR).
 * @returns {{ enabled: boolean, thresholds: { warning: number, critical: number } }}
 */
function readContextMonitorPrefs(cwd) {
  let enabled = true;
  let alertsEnabled = true;
  let debounceToolUses = DEBOUNCE_TOOLUSES;
  let checkpoint = DEFAULT_THRESHOLDS.checkpoint;
  let warning = DEFAULT_THRESHOLDS.warning;
  let critical = DEFAULT_THRESHOLDS.critical;
  const monitor = readPrefsCached(cwd).prefs.context_monitor;
  if (!monitor || typeof monitor !== 'object' || Array.isArray(monitor)) {
    configuredDebounceToolUses = debounceToolUses;
    return { enabled, alertsEnabled, debounceToolUses, thresholds: { checkpoint, warning, critical } };
  }

  if (typeof monitor.enabled === 'boolean') enabled = monitor.enabled;
  if (typeof monitor.alerts_enabled === 'boolean') alertsEnabled = monitor.alerts_enabled;
  if (Number.isInteger(monitor.debounce_tool_uses) && monitor.debounce_tool_uses >= 0) debounceToolUses = monitor.debounce_tool_uses;
  const normalize = (value, fallback) => {
    let n = value;
    // Tolerate numeric-string-with-suffix (e.g. "85%", "85abc") — parse the
    // leading numeric prefix so the old reader's tolerance is preserved.
    if (typeof n === 'string' && /^-?[0-9]*\.?[0-9]+/.test(n)) {
      n = parseFloat(n);
    }
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
    n = n > 1 ? n / 100 : n;
    return n >= 0 && n <= 1 ? n : NaN;
  };
  const checkpointExplicit = Object.prototype.hasOwnProperty.call(monitor, 'checkpoint_threshold');
  checkpoint = normalize(monitor.checkpoint_threshold, checkpoint);
  warning = normalize(monitor.warning_threshold, warning);
  critical = normalize(monitor.critical_threshold, critical);
  // Backward-compatible cutover: warning/critical predate checkpoint_threshold.
  // A legacy layer may validly set warning to the old 40% boundary while omitting
  // the new key; complete only that absent field so the resolved block remains
  // ordered. Once checkpoint_threshold is explicitly present, never repair the
  // relation — an invalid explicit/partial override must reject atomically below.
  if (!checkpointExplicit && Number.isFinite(warning) && checkpoint <= warning && warning < 1) {
    checkpoint = Math.min(1, warning + 0.05);
  }
  if (![checkpoint, warning, critical].every(Number.isFinite) || !(checkpoint > warning && warning > critical)) {
    const error = new Error('context_monitor thresholds must be finite, in 0..1, and checkpoint > warning > critical');
    error.code = 'FORGE_PREFS_INVALID_CONTEXT_MONITOR';
    throw error;
  }
  configuredDebounceToolUses = debounceToolUses;
  return { enabled: enabled && alertsEnabled, alertsEnabled, debounceToolUses, thresholds: { checkpoint, warning, critical } };
}

// ── Module exports ─────────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_THRESHOLDS,
  DEBOUNCE_TOOLUSES,
  STALE_MS,
  BRIDGE_VERSION,
  HOST_SOURCES,
  createContextSnapshot,
  usableSnapshot,
  severityFor,
  isStale,
  shouldInject,
  buildAdditionalContext,
  readContextMonitorPrefs,
};
