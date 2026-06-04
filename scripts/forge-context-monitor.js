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

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = { warning: 0.35, critical: 0.25 };
const DEBOUNCE_TOOLUSES = 5;
const STALE_MS = 60_000;

// Severity ranking (higher index = more severe)
const SEVERITY_RANK = { none: 0, warning: 1, critical: 2 };

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
function shouldInject(severity, debounceState) {
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
  if (toolUsesSinceLast >= DEBOUNCE_TOOLUSES) {
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
 * readContextMonitorPrefs — cascade user→repo→local, regex-only (MEM004).
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
  const files = [
    path.join(os.homedir(), '.claude', 'forge-agent-prefs.md'),
    path.join(cwd, '.gsd', 'claude-agent-prefs.md'),
    path.join(cwd, '.gsd', 'prefs.local.md'),
  ];

  let enabled = true;
  let warning = DEFAULT_THRESHOLDS.warning;
  let critical = DEFAULT_THRESHOLDS.critical;

  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8');

      // Scope sub-key reads to the context_monitor: block ONLY (S03 review R6 —
      // an indented `enabled:` in a SIBLING block must not leak in here).
      // Block = the contiguous indented lines right after `context_monitor:`.
      const block = raw.match(/^context_monitor:[ \t]*\n((?:[ \t]+\S.*(?:\n|$))*)/m);
      if (!block) continue;
      const body = block[1];

      const mEnabled = body.match(/^[ \t]+enabled:[ \t]*(true|false)/m);
      if (mEnabled) enabled = mEnabled[1] === 'true';

      const mWarning = body.match(/^[ \t]+warning_threshold:[ \t]*([0-9]*\.?[0-9]+)/m);
      if (mWarning) {
        let v = parseFloat(mWarning[1]);
        if (v > 1) v = v / 100; // percent → fraction
        warning = v;
      }

      const mCritical = body.match(/^[ \t]+critical_threshold:[ \t]*([0-9]*\.?[0-9]+)/m);
      if (mCritical) {
        let v = parseFloat(mCritical[1]);
        if (v > 1) v = v / 100; // percent → fraction
        critical = v;
      }
    } catch { /* missing file — skip */ }
  }

  return { enabled, thresholds: { warning, critical } };
}

// ── Module exports ─────────────────────────────────────────────────────────────

module.exports = {
  DEFAULT_THRESHOLDS,
  DEBOUNCE_TOOLUSES,
  STALE_MS,
  severityFor,
  isStale,
  shouldInject,
  buildAdditionalContext,
  readContextMonitorPrefs,
};
