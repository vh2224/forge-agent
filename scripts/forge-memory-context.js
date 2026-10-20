#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { queryRelevant, MEMORY_DIR } = require('./forge-memory.js');

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
  if (limit === 0 || maxTokens === 0) return { ...result, status: 'disabled', reason: 'zero-budget-or-limit' };
  if (!query.trim()) return result;
  // Reserve the whole heading, rounding upward; never round a caller's zero to two.
  const contentTokens = maxTokens - Math.ceil(MEMORY_HEADER.length / 4);
  if (contentTokens < 2) return { ...result, reason: 'insufficient-budget', truncated: true };
  try {
    if (!options.memoryProvider) {
      try {
        fs.statSync(path.join(cwd, MEMORY_DIR));
        result.source.availability = 'present';
      } catch (error) {
        if (error.code === 'ENOENT') return { ...result, reason: 'store-missing', source: { ...result.source, availability: 'missing' } };
        throw error;
      }
    }
    const found = (options.memoryProvider || queryRelevant)({
      cwd, query, unitType, unitId: options.unitId, milestoneId: options.milestoneId,
      sliceId: options.sliceId, taskId: options.taskId, limit, maxTokens: contentTokens, nowMs: options.nowMs,
    });
    if (!found || !Array.isArray(found.entries) || typeof found.markdown !== 'string') throw new Error('Invalid optional selection');
    result.schema_partial = found.schema_partial === true;
    result.warning = result.schema_partial ? 'schema-partial' : null;
    result.truncated = found.truncated === true;
    const entries = found.entries.filter(entry => Array.isArray(entry.matched_terms) && entry.matched_terms.length > 0).slice(0, limit);
    const lines = [];
    let chars = MEMORY_HEADER.length;
    for (const entry of entries) {
      const identity = memoryIdentifier(entry.identity);
      if (!identity || typeof entry.text !== 'string') continue;
      const prefix = `- [${identity}] `;
      const remaining = maxTokens * 4 - chars - (lines.length ? 1 : 0);
      if (remaining <= prefix.length) { result.truncated = true; break; }
      const text = entry.text.replace(/\s+/g, ' ').trim();
      const line = prefix + (text.length > remaining - prefix.length ? text.slice(0, remaining - prefix.length - 1) + '…' : text);
      if (line.length < prefix.length + text.length) result.truncated = true;
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
    return result;
  } catch {
    return { ...result, status: 'optional-error', reason: 'source-failed', warning: 'optional-source-failed' };
  }
}

module.exports = { selectMemoryContext, MEMORY_HEADER };
