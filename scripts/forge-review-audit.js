#!/usr/bin/env node
/**
 * Post-hoc advisory review model audit.
 *
 * The audit intentionally trusts recorded review events, not actual agent
 * dispatches. It therefore detects orchestrator drift (a literal or stale
 * advocate alias recorded against preferences), but cannot prove what a model
 * actually ran. That limitation is material: this is an accountability report,
 * not a sandbox or a gate. It always exits zero after a successful scan.
 *
 * The comparison target is always TODAY's advocate_model preference, not a
 * historical snapshot. There is no preference history to compare against, so
 * events that were fully compliant when they ran can be reported as "drift"
 * after the preference itself changes. Treat this report as "does history
 * match current config", not "was this event a violation at the time".
 * Rows missing the `advocate` field entirely (pre-instrumentation events, or
 * `style: flags` reviews with no advocate) are skipped, not flagged — only an
 * explicit mismatch (including an explicit `advocate: null`) counts as drift.
 *
 * CLI: --events <events.jsonl> --cwd <workspace> [--json]
 * Exit 2 is reserved for invalid arguments. Missing events are a clean empty
 * audit because new workspaces have no review history yet.
 */
'use strict';
const fs = require('fs');
const { readPrefsCached } = require('./forge-prefs.js');
const { modelToAlias } = require('./forge-model-alias.js');

// Report shape is deliberately compact and stable:
// {
//   expected: string|null,
//   drifts: [{ milestone, slice, advocate, expected }]
// }
//
// A null advocate is valid only when the configured ID has no alias. The same
// modelToAlias call used by dispatch computes that expectation, preventing a
// second mapping table from silently diverging. Malformed JSONL lines are
// ignored: an advisory auditor must preserve visibility into later valid rows
// rather than crash on one historical bad line. Missing files similarly mean
// no history, not a configuration failure. The doctor owns presentation and
// marks this report advisory, so this module never changes an allOk outcome.
//
// The event predicate is intentionally narrow. Dispatch events, pairing
// fallbacks, and review-config-inert diagnostics have no advocate contract and
// must not count as drift. Conversely every `event: review` row is checked,
// including workflow reviews, because their recorded advocate field is the
// compatibility boundary consumed by the audit.
//
// JSON output is suitable for tests and tools. Human output is one line so a
// doctor run remains scannable. Neither mode prints preferences themselves.
// This avoids leaking wider configuration into event inspection.
//
// Operational notes:
// - run after a milestone to quantify historical drift;
// - run through forge-doctor for a standard project report;
// - retain events.jsonl as the source evidence for each drift;
// - correct mirror prose rather than editing old event rows;
// - do not use this result to block complete-slice;
// - do not infer the actual external model from this report;
// - do not compare challenger fields here (they have separate semantics);
// - do not resolve aliases with a hand-maintained lookup;
// - do not treat unknown aliases as an error;
// - do not throw for an absent forge directory;
// - do not write event files while scanning them;
// - do not retry parsing after malformed historical rows;
// - do not change the event schema to satisfy this auditor;
// - do preserve null as a meaningful no-alias value;
// - do include milestone and slice when the event supplied them;
// - do keep exit status zero for a completed scan with drift;
// - do reserve exit status two for omitted required CLI arguments;
// - do make the resolved prefs layer the sole configuration input;
// - do keep this module require-able without invoking the CLI;
// - do make output machine-readable with --json.
function expectedAlias(cwd) {
  const r = readPrefsCached(cwd);
  const id = r && r.prefs && r.prefs.review && r.prefs.review.advocate_model;
  return modelToAlias(id || '').alias || null;
}
function audit(events, cwd) {
  const expected = expectedAlias(cwd); let rows = [];
  try { rows = fs.readFileSync(events, 'utf8').split(/\r?\n/).filter(Boolean).map(x => { try { return JSON.parse(x); } catch { return null; } }); } catch { return { expected, drifts: [] }; }
  return { expected, drifts: rows.filter(e => e && e.event === 'review' && 'advocate' in e && e.advocate !== expected).map(e => ({ ...(typeof e.unit === 'string' ? { unit: e.unit } : {}), milestone: e.milestone, slice: e.slice, advocate: e.advocate, expected })) };
}
function parse(args) {
  const o = {};
  for (let i = 0; i < args.length; i += 1) { if (args[i] === '--events' || args[i] === '--cwd') o[args[i].slice(2)] = args[++i]; else if (args[i] === '--json') o.json = true; }
  return o;
}
function runCli(args) {
  const o = parse(args); if (!o.events || !o.cwd) return 2;
  const result = audit(o.events, o.cwd);
  if (o.json) process.stdout.write(JSON.stringify(result) + '\n');
  else process.stdout.write(`review-model-drift: ${result.drifts.length} drift(s) (expected ${result.expected || 'frontmatter'})\n`);
  return 0;
}
module.exports = { audit, expectedAlias, parse, runCli };
if (require.main === module) process.exit(runCli(process.argv.slice(2)));
