#!/usr/bin/env node
/**
 * forge-context-bundle.js — assemble informational Forge context for the Codex sidecar.
 *
 * Codex runs in a workspace-write sandbox scoped to CODE_DIR, while Forge metadata lives
 * under WORKING_DIR/.gsd. Supplying those paths would therefore be inert: their content
 * must be read by the orchestrator and inlined in the sidecar prompt. This module keeps
 * that extraction in one testable place instead of duplicating it across dispatch mirrors.
 *
 * Security deliberately is not part of this bundle. It is a must-have, non-truncatable
 * checklist with imperative semantics; the bundle is informational and is wrapped by the
 * adapter's anti-injection markers.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { selectMemoryContext } = require('./forge-memory-context.js');

/**
 * Extract a level-two markdown section, including its heading, up to the next level-two
 * heading. A missing heading or whitespace-only body yields an empty string.
 *
 * @param {string} markdown
 * @param {string} heading
 * @returns {string}
 */
function extractSection(markdown, heading) {
  if (typeof markdown !== 'string' || typeof heading !== 'string' || !heading) return '';
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = markdown.match(new RegExp(`^${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'm'));
  if (!match || !match[0].trim() || !match[1].trim()) return '';
  return match[0].trim();
}

function readFileOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Build the three informational sections in canonical order. Missing sources are normal:
 * this is intentionally best-effort so absent context never blocks a sidecar dispatch.
 *
 * @param {{cwd?: string, sliceContext?: string}} opts
 * @returns {string}
 */
function buildContextBundleResult(opts) {
  opts = opts || {};
  const cwd = path.resolve(opts.owner || opts.cwd || process.cwd());
  const sections = [];

  const standards = readFileOrEmpty(path.join(cwd, '.gsd', 'CODING-STANDARDS.md'));
  const lint = extractSection(standards, '## Lint & Format Commands');
  if (lint) sections.push(lint);

  if (opts.sliceContext) {
    const decisions = extractSection(readFileOrEmpty(opts.sliceContext), '## Decisions');
    if (decisions) sections.push(decisions.replace(/^## Decisions/m, '## Slice Decisions'));
  }

  const memory = selectMemoryContext({ ...opts, cwd, limit: opts.limit !== undefined ? opts.limit : opts.memoryLimit !== undefined ? opts.memoryLimit : 10, maxTokens: opts.maxTokens !== undefined ? opts.maxTokens : opts.memoryMaxTokens !== undefined ? opts.memoryMaxTokens : 2000 });
  if (memory.markdown) sections.push(memory.markdown);
  const { markdown, ...selection } = memory;
  return { markdown: sections.join('\n\n'), selection };
}

function buildContextBundle(opts) {
  return buildContextBundleResult(opts).markdown;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const known = ['cwd', 'owner', 'slice-context', 'out', 'query', 'query-file', 'description', 'unit-type', 'phase', 'unit-id', 'milestone-id', 'slice-id', 'task-id', 'limit', 'max-tokens', 'selection-report'];
    if (!argv[i].startsWith('--') || !known.includes(argv[i].slice(2)) || i + 1 >= argv.length) throw new Error('Invalid bundle arguments');
    args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch { process.stderr.write('forge-context-bundle: invalid arguments\n'); process.exitCode = 2; return; }
  if (!args.out) {
    process.stderr.write('forge-context-bundle: --out <file> is required\n');
    process.exitCode = 2;
    return;
  }
  try {
    const out = path.resolve(args.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (args.query !== undefined && args['query-file'] !== undefined) throw new Error('Ambiguous query');
    const query = args['query-file'] ? fs.readFileSync(path.resolve(args['query-file']), 'utf8') : args.query;
    const result = buildContextBundleResult({ cwd: args.cwd, owner: args.owner, sliceContext: args['slice-context'],
      query, description: args.description, unitType: args['unit-type'], phase: args.phase,
      unitId: args['unit-id'], milestoneId: args['milestone-id'], sliceId: args['slice-id'], taskId: args['task-id'],
      limit: args.limit, maxTokens: args['max-tokens'] });
    fs.writeFileSync(out, result.markdown, 'utf8');
    if (args['selection-report']) fs.writeFileSync(path.resolve(args['selection-report']), JSON.stringify(result.selection, null, 2) + '\n', 'utf8');
  } catch (error) {
    process.stderr.write('forge-context-bundle: invalid input or unreadable source\n');
    process.exitCode = 2;
  }
}

module.exports = { buildContextBundle, buildContextBundleResult, extractSection };

if (require.main === module) main();
