#!/usr/bin/env node
'use strict';

// Resolve input only. Ranking, filters and budgets belong to selectMemoryContext.
const fs = require('fs');
const path = require('path');
const { TextDecoder } = require('util');
const ids = require('./forge-ids');
const MAX_QUERY_BYTES = 512 * 1024;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function identifier(value, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) fail('memory-query-identity-invalid');
  return value;
}

/** Select only pre-result, unit-scoped inputs; never search other runs. */
function resolveMemoryQuery(options = {}) {
  const root = fs.realpathSync(options.cwd || process.cwd());
  const unit = options.unitType;
  const milestone = options.milestoneId;
  if (!ids.isValid(milestone) || ids.entityKind(milestone) !== 'milestone') fail('memory-query-identity-invalid');
  const base = `.gsd/milestones/${milestone}`;
  const slice = options.sliceId ? identifier(options.sliceId, /^S\d{2,}$/) : null;
  const task = options.taskId ? identifier(options.taskId, /^T\d{2,}$/) : null;
  const sliceBase = slice && `${base}/slices/${slice}`;
  let candidates;
  if (unit === 'execute-task') {
    if (!slice || !task) fail('memory-query-identity-invalid');
    candidates = [`${sliceBase}/tasks/${task}/${task}-PLAN.md`, `${sliceBase}/tasks/${task}-PLAN.md`];
  } else if (['plan-slice', 'research-slice', 'discuss-slice', 'plan-check', 'complete-slice'].includes(unit)) {
    if (!slice) fail('memory-query-identity-invalid');
    candidates = unit === 'complete-slice' || unit === 'plan-check'
      ? [`${sliceBase}/${slice}-PLAN.md`]
      : unit === 'plan-slice'
        ? [`${sliceBase}/${slice}-RESEARCH.md`, `${sliceBase}/${slice}-CONTEXT.md`, `${base}/${milestone}-ROADMAP.md`]
        : unit === 'research-slice'
          ? [`${sliceBase}/${slice}-CONTEXT.md`, `${base}/${milestone}-ROADMAP.md`]
          : [`${base}/${milestone}-ROADMAP.md`];
  } else if (['plan-milestone', 'research-milestone', 'discuss-milestone', 'complete-milestone'].includes(unit)) {
    candidates = unit === 'plan-milestone' || unit === 'complete-milestone'
      ? [`${base}/${milestone}-RESEARCH.md`, `${base}/${milestone}-CONTEXT.md`, `${base}/${milestone}-SCOPE.md`]
      : unit === 'research-milestone'
        ? [`${base}/${milestone}-CONTEXT.md`, `${base}/${milestone}-SCOPE.md`]
        : [`${base}/${milestone}-SCOPE.md`];
  } else fail('memory-query-unit-unsupported');
  for (const relative of candidates) {
    const lexical = path.join(root, relative);
    let actual;
    try { actual = fs.realpathSync(lexical); }
    catch (error) { if (error.code === 'ENOENT' && !fs.existsSync(path.dirname(lexical))) continue;
      if (error.code === 'ENOENT') { try { fs.lstatSync(lexical); } catch (missing) { if (missing.code === 'ENOENT') continue; } }
      fail('memory-query-source-unreadable'); }
    // Both containment and exact basename prevent an eligible symlink to SUMMARY.
    const inside = path.relative(root, actual);
    if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)
      || path.normalize(actual) !== path.normalize(lexical)) fail('memory-query-source-escape');
    const stat = fs.statSync(actual);
    if (!stat.isFile() || stat.size > MAX_QUERY_BYTES) fail('memory-query-source-invalid');
    const bytes = fs.readFileSync(actual);
    if (bytes.length > MAX_QUERY_BYTES) fail('memory-query-source-invalid');
    let query;
    try { query = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('memory-query-source-invalid'); }
    if (!query.trim() || query.includes('\0')) fail('memory-query-source-invalid');
    return { status: 'available', query_file: actual, source: relative, unit_type: unit };
  }
  return { status: 'unavailable', reason: 'eligible-input-missing', query_file: null, unit_type: unit };
}

module.exports = { resolveMemoryQuery, MAX_QUERY_BYTES };
if (require.main === module) {
  try {
    const options = {}, args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      const key = { '--cwd': 'cwd', '--unit-type': 'unitType', '--milestone': 'milestoneId', '--slice': 'sliceId', '--task': 'taskId' }[args[i]];
      if (!key || options[key] !== undefined || args[i + 1] === undefined || args[i + 1].startsWith('--')) fail('memory-query-cli-invalid');
      options[key] = args[++i];
    }
    const result = resolveMemoryQuery(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'available') process.exitCode = 2;
  } catch (error) { process.stderr.write(`${JSON.stringify({ status: 'unavailable', reason: error.code || 'memory-query-source-failed' })}\n`); process.exitCode = 1; }
}
