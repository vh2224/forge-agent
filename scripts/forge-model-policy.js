#!/usr/bin/env node
'use strict';

// Versioned model policy: the single owner of the effort clamp, the thinking
// header guard and the per-transport delivery limits consumed by the resolver,
// the Claude CLI sidecar, the native adapter and the review-effort helper.
//
// Two kinds of entries live here and must not be confused:
//   - `documented`: capability taken from the official sources listed in the
//     entry, consulted on `consulted_at`. It describes what the provider API
//     documents, never what a provider actually applied on a given turn.
//   - `legacy-preserved`: Forge's historical behavior, reproduced byte for byte.
//     `documented_efforts` records what the documentation says separately, so a
//     deliberate legacy clamp is never presented as a provider limitation.
// An id with no entry keeps the literal legacy rule and is diagnosed as
// `model-policy-unknown`; no unknown model is claimed to have verified support.
// No function here selects, rewrites or substitutes a model.

const POLICY_VERSION = '2026-09-30.1';
const CONSULTED_AT = '2026-09-30';
const EFFORT_SCALE = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_RANK = Object.freeze({ low: 0, medium: 1, high: 2, xhigh: 3, max: 4 });
const TRANSPORTS = Object.freeze(['api', 'claude-cli', 'claude-native', 'app-server', 'agy-cli']);
const CLAUDE_TRANSPORTS = Object.freeze(['claude-cli', 'claude-native']);

const SOURCES = Object.freeze({
  sonnet55Overview: 'https://platform.claude.com/docs/en/models/sonnet-5-5/overview',
  sonnet55Migration: 'https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide',
  effort: 'https://platform.claude.com/docs/en/build-with-claude/effort',
  modelConfig: 'https://code.claude.com/docs/en/model-config',
  cliReference: 'https://code.claude.com/docs/en/cli-reference',
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const MODEL_POLICY = deepFreeze({
  'claude-sonnet-5-5': {
    status: 'documented',
    family: 'sonnet',
    sources: [SOURCES.sonnet55Overview, SOURCES.sonnet55Migration, SOURCES.effort, SOURCES.modelConfig, SOURCES.cliReference],
    consulted_at: CONSULTED_AT,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    documented_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    effort_cap: 'max',
    thinking: {
      default: 'adaptive',
      header: 'adaptive',
      supported: ['adaptive', 'between_tools'],
      incompatible: ['enabled', 'disabled'],
      between_tools: { efforts: ['low', 'medium', 'high'], extra_fields: false },
    },
    transports: {
      'claude-cli': {
        model_argument: 'full-id', effort_argument: '--effort', default_effort: 'medium',
        thinking_disable: false, between_tools_argument: null, min_version: '2.1.284',
      },
      // The Agent tool documents full ids besides aliases; the adapter sends the
      // full id only when the ACTIVE tool capabilities list it (`model_ids`).
      // On the alias path the alias proves no version. Thinking has no
      // per-subagent control (inherited from the session).
      'claude-native': {
        model_argument: 'full-id-when-listed-else-alias', version_proof: false,
        effort_transport: 'agent-frontmatter', thinking_transport: null,
      },
    },
  },
  // Sonnet 5 and 4.6 are documented on the effort page. The historical Forge
  // family clamp to medium was a conservative rule, not a provider limit, so it
  // no longer applies to them. An effort outside `efforts` is refused by name
  // (`effort-unsupported-by-model`) instead of being clamped or promised.
  'claude-sonnet-5': {
    status: 'documented',
    family: 'sonnet',
    sources: [SOURCES.effort, SOURCES.modelConfig],
    consulted_at: CONSULTED_AT,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    documented_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    effort_cap: 'max',
    legacy_note: 'Até a política 2026-09-30.1 o Forge limitava Sonnet 5 a medium por regex de família; a documentação de effort registra a escala completa.',
  },
  'claude-sonnet-4-6': {
    status: 'documented',
    family: 'sonnet',
    sources: [SOURCES.effort],
    consulted_at: CONSULTED_AT,
    efforts: ['low', 'medium', 'high', 'max'],
    documented_efforts: ['low', 'medium', 'high', 'max'],
    effort_cap: 'max',
    legacy_note: 'Sonnet 4.6 documenta low/medium/high/max (sem xhigh): xhigh explícito é recusado, nunca rebaixado em silêncio.',
  },
  'claude-haiku-4-5': {
    status: 'legacy-preserved',
    family: 'haiku',
    sources: [],
    consulted_at: CONSULTED_AT,
    documented_efforts: null,
    effort_cap: 'medium',
    legacy_note: 'Teto medium histórico do Forge para Haiku, preservado.',
  },
  'claude-opus-5': {
    status: 'legacy-preserved',
    family: 'opus',
    sources: [],
    consulted_at: CONSULTED_AT,
    documented_efforts: null,
    effort_cap: 'max',
    thinking: { header_by_effort: { xhigh: 'adaptive', max: 'adaptive' } },
    legacy_note: 'Opus 5 aceita thinking disabled só com effort high ou menor; o guard força adaptive em xhigh/max.',
  },
  'claude-fable-5': {
    status: 'legacy-preserved',
    family: 'fable',
    sources: [],
    consulted_at: CONSULTED_AT,
    documented_efforts: null,
    effort_cap: 'max',
    thinking: { header: 'adaptive' },
    legacy_note: 'Fable 5 recusa thinking disabled em qualquer effort; o guard força adaptive.',
  },
});

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function diagnostic(code, fields) {
  return { code, ...(fields || {}) };
}

// Exact id, id + `-YYYYMMDD`, id + `[1m]` (and the dated `[1m]` form). The
// longest matching key wins, so `claude-sonnet-5-5` and its dated variants never
// fall into `claude-sonnet-5`: the `-5` suffix is not a date.
function matchPolicy(id) {
  const model = text(id);
  if (!model) return null;
  let best = null;
  for (const key of Object.keys(MODEL_POLICY)) {
    if (!model.startsWith(key)) continue;
    const rest = model.slice(key.length);
    if (!/^(?:-\d{8})?(?:\[1m\])?$/.test(rest)) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best ? { id: best, entry: MODEL_POLICY[best] } : null;
}

function unknownDiagnostics(model) {
  return model ? [diagnostic('model-policy-unknown', { model })] : [];
}

// Legacy literal rules, kept verbatim for ids without an entry.
function legacyCap(model) {
  return /^claude-(haiku|sonnet)/.test(model) ? 'medium' : 'max';
}

function legacyHeader(model, effort) {
  if (model.startsWith('claude-fable-5')) return 'adaptive';
  if (model.startsWith('claude-opus-5') && (effort === 'xhigh' || effort === 'max')) return 'adaptive';
  return '';
}

/**
 * Clamp a requested effort by the model policy. The model is never changed.
 * @returns {{effort:string, requested:string, clamped:boolean, cap:string, entry:string|null, diagnostics:object[]}}
 */
function applyEffortPolicy(input) {
  const options = input || {};
  const model = text(options.model);
  const requested = text(options.effort);
  const matched = matchPolicy(model);
  const cap = matched ? matched.entry.effort_cap : legacyCap(model);
  const diagnostics = matched ? [] : unknownDiagnostics(model);
  let effort = requested;
  let clamped = false;
  // A documented entry that lists its efforts refuses a value it does not
  // document; the requested value is preserved and the caller refuses.
  if (matched && Array.isArray(matched.entry.efforts) && Object.prototype.hasOwnProperty.call(EFFORT_RANK, requested)
      && !matched.entry.efforts.includes(requested)) {
    diagnostics.push(diagnostic('effort-unsupported-by-model', {
      requested, supported: [...matched.entry.efforts], entry: matched.id, layer: 'model-policy',
    }));
    return { effort, requested, clamped, unsupported: true, cap, entry: matched.id, diagnostics };
  }
  if (Object.prototype.hasOwnProperty.call(EFFORT_RANK, requested) && EFFORT_RANK[requested] > EFFORT_RANK[cap]) {
    effort = cap;
    clamped = true;
    diagnostics.push(diagnostic('effort-clamped-by-policy', {
      requested, applied: cap, cap, entry: matched ? matched.id : null,
    }));
  }
  return { effort, requested, clamped, unsupported: false, cap, entry: matched ? matched.id : null, diagnostics };
}

/**
 * Header override for the phase thinking pref. Empty string = no override.
 * @returns {{header:string, entry:string|null, diagnostics:object[]}}
 */
function thinkingHeader(input) {
  const options = input || {};
  const model = text(options.model);
  const effort = text(options.effort);
  const matched = matchPolicy(model);
  if (!matched) return { header: legacyHeader(model, effort), entry: null, diagnostics: unknownDiagnostics(model) };
  const thinking = matched.entry.thinking || {};
  const byEffort = thinking.header_by_effort || {};
  const header = thinking.header || byEffort[effort] || '';
  return { header, entry: matched.id, diagnostics: [] };
}

/**
 * Evaluate an explicitly requested thinking mode against the model policy and
 * the transport that would carry it. Absent mode is legal and keeps the model
 * default. An explicit incompatible mode is refused, never rewritten.
 * @returns {{ok:boolean, reason_code:string|null, mode_requested:string|null, mode_effective:string|null, entry:string|null, diagnostics:object[]}}
 */
function evaluateThinking(input) {
  const options = input || {};
  const model = text(options.model);
  const effort = text(options.effort);
  const requested = text(options.mode) || null;
  const transport = text(options.transport) || null;
  const extraFields = Array.isArray(options.extraFields) ? options.extraFields.filter(Boolean) : [];
  const matched = matchPolicy(model);
  const thinking = matched && matched.entry.thinking && matched.entry.thinking.supported ? matched.entry.thinking : null;
  const base = { mode_requested: requested, entry: matched ? matched.id : null };
  const refuse = (reasonCode, fields) => ({
    ...base, ok: false, reason_code: reasonCode, mode_effective: null,
    diagnostics: [diagnostic(reasonCode, { model, requested, transport, layer: 'model-policy', ...(fields || {}) })],
  });
  if (!requested) {
    return { ...base, ok: true, reason_code: null, mode_effective: thinking ? thinking.default : null, diagnostics: [] };
  }
  // between_tools is an API thinking mode. No Claude CLI argument and no native
  // agent field carries it, so a Claude transport cannot deliver it for any model.
  if (requested === 'between_tools' && transport && CLAUDE_TRANSPORTS.includes(transport)) {
    return refuse('thinking-transport-unsupported');
  }
  if (!thinking) {
    // Legacy and unknown models keep the historical guard (header override);
    // between_tools is not a documented value for them on any transport.
    if (requested === 'between_tools') return refuse('thinking-mode-undocumented');
    return { ...base, ok: true, reason_code: null, mode_effective: requested, diagnostics: matched ? [] : unknownDiagnostics(model) };
  }
  if (requested === 'disabled') return refuse('thinking-disabled-incompatible', { applied: null });
  if (requested === 'enabled') return refuse('thinking-enabled-incompatible', { applied: null });
  if (requested === 'between_tools') {
    const rule = thinking.between_tools;
    if (!rule.efforts.includes(effort)) return refuse('thinking-between-tools-incompatible', { effort, allowed: rule.efforts });
    if (!rule.extra_fields && extraFields.length) return refuse('thinking-between-tools-incompatible', { extra_fields: extraFields });
    return { ...base, ok: true, reason_code: null, mode_effective: 'between_tools', diagnostics: [] };
  }
  if (!thinking.supported.includes(requested)) return refuse('thinking-mode-unknown');
  return { ...base, ok: true, reason_code: null, mode_effective: requested, diagnostics: [] };
}

function parseVersion(value) {
  const match = text(value).match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * Delivery limits of one transport for one model. `cliVersion` is the parsed
 * `claude --version` output or null when it could not be verified.
 */
function transportSupport(input) {
  const options = input || {};
  const model = text(options.model);
  const transport = text(options.transport);
  const matched = matchPolicy(model);
  const rule = matched && matched.entry.transports ? matched.entry.transports[transport] || null : null;
  const result = {
    supported: true, reason_code: null, entry: matched ? matched.id : null, transport,
    min_version: rule && rule.min_version ? rule.min_version : null,
    cli_version: null, version_proof: null, model_argument: rule ? rule.model_argument || null : null,
    diagnostics: matched ? [] : unknownDiagnostics(model),
  };
  if (!rule) return result;
  if (rule.min_version) {
    const parsed = parseVersion(options.cliVersion);
    result.cli_version = parsed ? parsed.join('.') : null;
    if (!parsed) {
      result.diagnostics.push(diagnostic('transport-version-unverified', { transport, min_version: rule.min_version }));
    } else if (compareVersions(result.cli_version, rule.min_version) < 0) {
      result.supported = false;
      result.reason_code = 'claude-cli-version-unsupported';
      result.diagnostics.push(diagnostic('claude-cli-version-unsupported', {
        transport, model, cli_version: result.cli_version, min_version: rule.min_version, layer: 'model-policy',
      }));
    }
  }
  if (rule.version_proof === false) {
    result.version_proof = 'alias-only';
    result.diagnostics.push(diagnostic('native-alias-not-version-proof', { transport, model }));
  }
  return result;
}

// Which phase thinking pref applies to a resolved Claude model.
function thinkingPrefKey(model) {
  const id = text(model).toLowerCase();
  if (id.includes('opus') || id.includes('fable')) return 'opus_phases';
  if (id.includes('sonnet') || id.includes('haiku')) return 'sonnet_phases';
  return null;
}

function parseArgs(argv) {
  const parsed = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--json') parsed.json = true;
    else if (['--model', '--effort', '--thinking', '--transport', '--cli-version'].includes(flag) && value !== undefined) {
      parsed[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      index += 1;
    } else {
      const error = new Error(`argumento desconhecido: ${flag}`);
      error.code = 'invalid-arguments';
      throw error;
    }
  }
  if (!text(parsed.model)) {
    const error = new Error('--model é obrigatório');
    error.code = 'invalid-arguments';
    throw error;
  }
  return parsed;
}

function evaluate(options) {
  const effort = applyEffortPolicy({ model: options.model, effort: options.effort || 'medium' });
  const header = thinkingHeader({ model: options.model, effort: effort.effort });
  const thinking = evaluateThinking({ model: options.model, effort: effort.effort,
    mode: options.thinking, transport: options.transport });
  const transport = options.transport
    ? transportSupport({ model: options.model, transport: options.transport, cliVersion: options.cliVersion })
    : null;
  return { policy_version: POLICY_VERSION, model: text(options.model), entry: effort.entry,
    effort, thinking_header: header.header, thinking, transport };
}

module.exports = {
  POLICY_VERSION, MODEL_POLICY, EFFORT_SCALE, EFFORT_RANK, TRANSPORTS, SOURCES,
  matchPolicy, applyEffortPolicy, thinkingHeader, evaluateThinking, transportSupport,
  compareVersions, parseVersion, thinkingPrefKey, evaluate, parseArgs,
};

if (require.main === module) {
  try {
    const result = evaluate(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`forge-model-policy: ${error.code || 'failed'}: ${error.message}\n`);
    process.exitCode = 2;
  }
}
