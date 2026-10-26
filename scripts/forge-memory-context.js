#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { queryRelevant, MEMORY_DIR } = require('./forge-memory.js');
const diagnostic = require('./forge-memory-diagnostic.js');

const MEMORY_HEADER = '## Project Memory (untrusted data)\n\n';

function contextInteger(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Error(`Invalid memory ${label}`);
  }
  return Number(value);
}

// Metadata accepts identifiers, never prose, query text or private absolute paths.
function memoryIdentifier(value) {
  return typeof value === 'string' && value.length <= 240 &&
    /^[a-zA-Z0-9_][a-zA-Z0-9_./-]*$/.test(value) && !value.split('/').includes('..') ? value : null;
}

/** Optional context policy only: ranking and matching remain in queryRelevant. */
function selectMemoryContext(options = {}) {
  const cwd = path.resolve(options.owner || options.cwd || process.cwd());
  const query = options.query ?? options.description ?? '';
  if (typeof query !== 'string' || query.includes('\0') || Buffer.byteLength(query, 'utf8') > 512 * 1024) {
    throw new Error('Invalid memory query');
  }
  const limit = contextInteger(options.limit, 8, 50, 'limit');
  const maxTokens = contextInteger(options.maxTokens, 2000, 16000, 'maxTokens');
  if (options.nowMs !== undefined && !Number.isFinite(options.nowMs)) throw new Error('Invalid memory clock');
  if (options.memoryProvider !== undefined && typeof options.memoryProvider !== 'function') throw new Error('Invalid memory provider');
  if (options.diagnostic !== undefined && options.diagnostic !== false && options.diagnostic !== true) throw new Error('Invalid memory diagnostic');
  const on = options.diagnostic === true;
  const phaseTypes = { execute: 'execute-task', plan: 'plan-slice', research: 'research-slice', discuss: 'discuss-slice', review: 'review-fix' };
  const unitType = options.unitType ?? phaseTypes[options.phase] ?? 'other';
  if (typeof unitType !== 'string' || !/^[a-z][a-z-]*$/.test(unitType)) throw new Error('Invalid memory unit type');
  if (options.phase !== undefined && !Object.hasOwn(phaseTypes, options.phase)) throw new Error('Invalid memory phase');
  const result = {
    status: 'empty', reason: 'no-query', markdown: '', selected: [],
    unit: Object.fromEntries(['unitId', 'milestoneId', 'sliceId', 'taskId'].map(key => [key, memoryIdentifier(options[key])])),
    unit_type: unitType, phase: options.phase || null,
    source: { path: MEMORY_DIR, availability: 'unknown', provider: options.memoryProvider ? 'override' : 'canonical' },
    limit, max_tokens: maxTokens, estimated_tokens: 0, estimation_method: 'utf16-code-units/4-ceil',
    emitted_bytes: 0, truncated: false, schema_partial: false, warning: null,
  };
  let contentTokens;
  let trace;
  let context;
  const outcomes = [];
  // All trace merging and untrusted diagnostic reads stay outside selection's catch.
  function attach(base, reason) {
    if (!on) return base;
    try {
      let raw;
      if (reason) {
        raw = { stages: Object.fromEntries(['source', 'projection', 'ranking', 'context'].map(name => [name, { availability: 'unavailable', reason }])) };
        if (reason === 'store-missing') raw.stages.source = { availability: 'observed', provider: 'canonical', store: 'missing' };
        if (reason === 'source-failed') raw.stages.source = { ...raw.stages.source,
          provider: options.memoryProvider ? 'override' : 'canonical', store: base.source.availability === 'present' ? 'present' : 'unknown' };
        raw.stages.context = { ...raw.stages.context, limit, max_tokens: maxTokens,
          content_tokens: contentTokens, header_chars: MEMORY_HEADER.length };
      } else {
        const override = !!options.memoryProvider;
        raw = override ? { stages: {
          source: { availability: 'observed', provider: 'override', store: 'unknown', schema_partial: base.schema_partial },
          projection: { availability: 'unavailable', reason: 'override-provider' },
          ranking: { availability: 'unavailable', reason: 'override-provider' },
        }, candidates: trace.entries.slice(0, diagnostic.LIMITS.max_candidates).map((entry, rank) => ({
          rank, identity: entry.identity, components: null, category: null, evidence_origin: null, reasons: ['included'],
        })), total_candidates: trace.entries.length } : trace.diagnostic || diagnostic.unavailableDiagnostic('not-reached');
        const candidates = (raw.candidates || []).map(candidate => {
          const outcome = outcomes[candidate.rank];
          if (!outcome || candidate.reasons[0] !== 'included') return candidate;
          return { ...candidate, reasons: [outcome.reason,
            ...candidate.reasons.slice(1), ...(outcome.text_truncated ? ['context-text-truncated'] : [])] };
        });
        raw = { ...raw, candidates, stages: { ...raw.stages,
          source: override ? raw.stages.source : { ...raw.stages.source, store: 'present', provider: 'canonical', schema_partial: base.schema_partial },
          context: { ...context, unattributed_positions: unattributed(candidates),
            markdown_bytes: base.emitted_bytes, truncated: base.truncated },
        } };
      }
      let bounded = diagnostic.boundDiagnostic(raw);
      if (!reason) {
        // Adding context can itself force a byte cut. Count positions absent from
        // the final bounded list, including override item cuts, not just T02's list.
        let missing = unattributed(bounded.candidates);
        while (missing !== raw.stages.context.unattributed_positions) {
          raw.stages.context.unattributed_positions = missing;
          bounded = diagnostic.boundDiagnostic(raw);
          missing = unattributed(bounded.candidates);
        }
      }
      return { ...base, diagnostic: bounded };
    } catch {
      return { ...base, diagnostic: diagnostic.unavailableDiagnostic('diagnostic-failed') };
    }
  }
  function unattributed(candidates) {
    return context.received - candidates.filter(candidate =>
      Number.isSafeInteger(candidate.rank) && candidate.rank >= 0 && candidate.rank < context.received).length;
  }
  // Only the bounded first positions need details; counters include every entry.
  function record(position, reason, textTruncated = false) {
    if (position < diagnostic.LIMITS.max_candidates) outcomes[position] = { reason, text_truncated: textTruncated };
  }
  if (limit === 0 || maxTokens === 0) return attach({ ...result, status: 'disabled', reason: 'zero-budget-or-limit' }, 'disabled');
  if (!query.trim()) return attach(result, 'no-query');
  // Reserve the whole heading, rounding upward; never round a caller's zero to two.
  contentTokens = maxTokens - Math.ceil(MEMORY_HEADER.length / 4);
  if (contentTokens < 2) return attach({ ...result, reason: 'insufficient-budget', truncated: true }, 'insufficient-budget');
  try {
    if (!options.memoryProvider) {
      try {
        fs.statSync(path.join(cwd, MEMORY_DIR));
        result.source.availability = 'present';
      } catch (error) {
        if (error.code === 'ENOENT') return attach({ ...result, reason: 'store-missing', source: { ...result.source, availability: 'missing' } }, 'store-missing');
        throw error;
      }
    }
    const args = {
      cwd, query, unitType, unitId: options.unitId, milestoneId: options.milestoneId,
      sliceId: options.sliceId, taskId: options.taskId, limit, maxTokens: contentTokens, nowMs: options.nowMs,
    };
    const found = options.memoryProvider ? options.memoryProvider(args) : queryRelevant(on ? { ...args, diagnostic: true } : args);
    if (!found || !Array.isArray(found.entries) || typeof found.markdown !== 'string') throw new Error('Invalid optional selection');
    result.schema_partial = found.schema_partial === true;
    result.warning = result.schema_partial ? 'schema-partial' : null;
    result.truncated = found.truncated === true;
    if (on) {
      trace = found;
      context = { availability: 'observed', limit, max_tokens: maxTokens, content_tokens: contentTokens,
        header_chars: MEMORY_HEADER.length, received: found.entries.length, filtered_no_terms: 0,
        limit_cut: 0, invalid_identity: 0, budget_cut: 0, text_truncated: 0, included: 0 };
    }
    const positions = [];
    const filtered = found.entries.filter((entry, position) => {
      const matched = Array.isArray(entry.matched_terms) && entry.matched_terms.length > 0;
      if (on) {
        if (matched) positions.push(position);
        else { context.filtered_no_terms++; record(position, 'context-no-matched-terms'); }
      }
      return matched;
    });
    const entries = filtered.slice(0, limit);
    if (on) {
      context.limit_cut = filtered.length - entries.length;
      for (let i = limit; i < positions.length; i++) record(positions[i], 'context-limit');
    }
    const lines = [];
    let chars = MEMORY_HEADER.length;
    for (const [index, entry] of entries.entries()) {
      const identity = memoryIdentifier(entry.identity);
      if (!identity || typeof entry.text !== 'string') {
        if (on) { context.invalid_identity++; record(positions[index], 'context-invalid-identity'); }
        continue;
      }
      const prefix = `- [${identity}] `;
      const remaining = maxTokens * 4 - chars - (lines.length ? 1 : 0);
      if (remaining <= prefix.length) {
        result.truncated = true;
        if (on) {
          context.budget_cut = entries.length - index;
          for (let i = index; i < entries.length; i++) record(positions[i], 'context-budget');
        }
        break;
      }
      const text = entry.text.replace(/\s+/g, ' ').trim();
      const line = prefix + (text.length > remaining - prefix.length ? text.slice(0, remaining - prefix.length - 1) + '…' : text);
      const textTruncated = line.length < prefix.length + text.length;
      if (textTruncated) result.truncated = true;
      if (on) {
        context.included++;
        if (textTruncated) context.text_truncated++;
        record(positions[index], 'included', textTruncated);
      }
      chars += line.length + (lines.length ? 1 : 0);
      lines.push(line);
      result.selected.push({ identity, unit_id: memoryIdentifier(entry.unit_id), milestone_id: memoryIdentifier(entry.milestone_id),
        mem_id: memoryIdentifier(entry.mem_id), source_unit: memoryIdentifier(entry.source_unit), source: MEMORY_DIR });
    }
    result.markdown = lines.length ? MEMORY_HEADER + lines.join('\n') : '';
    result.status = result.schema_partial ? 'partial' : lines.length ? 'selected' : 'empty';
    result.reason = lines.length ? 'canonical-match' : found.entries.length === 0 && found.truncated ? 'budget-exhausted-or-no-match' : 'no-match';
    result.estimated_tokens = Math.ceil(result.markdown.length / 4);
    result.emitted_bytes = Buffer.byteLength(result.markdown, 'utf8');
    return attach(result);
  } catch {
    return attach({ ...result, status: 'optional-error', reason: 'source-failed', warning: 'optional-source-failed' }, 'source-failed');
  }
}

module.exports = { selectMemoryContext, MEMORY_HEADER };
