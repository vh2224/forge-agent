#!/usr/bin/env node
// forge-personal-summary — bounded, read-only personal context for simple
// questions ("onde paramos?", entry, status). The full snapshot stays the
// explicit diagnostic; this view is built field by field from it, never by
// serializing the snapshot and removing private data afterwards.
//
// Library exports:
//   SUMMARY_LIMITS                → frozen { works, items, text, bytes }
//   buildPersonalSummary(options) → allowlisted summary object (never throws)
//   renderPersonalSummary(options)→ { json, exitCode }; json + '\n' ≤ SUMMARY_LIMITS.bytes
//   renderSummaryCommand(args)    → same, rejecting producer/selector/snapshot flags
//
// CLI (also reachable as forge-personal-context.js --summary):
//   node forge-personal-summary.js --cwd <dir> [--project <dir>] [--id <ID>] [--json]
// `--json` is accepted and ignored: the output is always one compact JSON line.

'use strict';

const path = require('path');
const os = require('os');
const { readPersonalSnapshot, effectiveAcceptances } = require('./forge-personal-context');
const ids = require('./forge-ids');

const SUMMARY_LIMITS = Object.freeze({ works: 5, items: 3, text: 240, bytes: 4096 });
const NON_MANDATORY_TEXT = 80;
const DIAGNOSTIC = 'forge-personal-context.js --snapshot';
const EMPTY_TEXT = '(vazio)';
const REASONS = Object.freeze(['snapshot', 'no-bindings', 'corrupt', 'unreadable', 'schema-unsupported', 'schema-invalid',
  'namespace-invalid', 'project-unresolved', 'project-changed', 'project-unanchored', 'invalid-id', 'summary-failed',
  'summary-limit-exceeded', 'summary-command-conflict', 'snapshot-error']);
const CONFLICTS = Object.freeze(['bind', 'checkpoint', 'select', 'snapshot']);
const WORK_STATUS = new Set(['pending', 'open', 'unknown', 'completed']);
const ACTIVITY = new Set(['active', 'inactive', 'unknown']);
const RELIABILITY = new Set(['current', 'needs-reconciliation', 'run-corrupt', 'run-unreadable', 'missing', 'unreadable',
  'state-invalid', 'state-changed', 'state-missing', 'state-unreadable']);
const VALIDITY = Object.freeze({ current: 'current', stale: 'historical', missing: 'missing' });
const RANK = Object.freeze({ open: 1, unknown: 2, completed: 3 });
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// C0/C1 controls, line/paragraph separators and bidi controls could forge
// terminal output or reorder what the operator reads. Built from code points so
// the source itself carries no invisible characters.
const UNSAFE = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x200e, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069]]
  .map(([from, to]) => `\\u${from.toString(16).padStart(4, '0')}-\\u${to.toString(16).padStart(4, '0')}`).join('')}]`, 'g');
const REPLACEMENT = String.fromCodePoint(0xfffd);
const ELLIPSIS = String.fromCodePoint(0x2026);

function cleanText(value, max) {
  const text = (typeof value === 'string' ? value : '').replace(LONE_SURROGATE, REPLACEMENT).replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ').trim() || EMPTY_TEXT;
  const points = Array.from(text);
  if (points.length <= max) return { text, truncated: false };
  return { text: points.slice(0, max - 1).join('') + ELLIPSIS, truncated: true };
}

// The operator's own prose may quote the project root; keep it out of stdout.
function redactProject(text, project, placeholder = '<projeto>') {
  if (typeof text !== 'string' || typeof project !== 'string' || project.length < 2) return text;
  const pattern = project.split(/[\\/]+/).filter(Boolean).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+');
  return pattern ? text.replace(new RegExp(`${/^[\\/]/.test(project) ? '[\\\\/]' : ''}${pattern}`, 'gi'), placeholder) : text;
}

// Captures store canonical absolute sources; only a path strictly inside the
// snapshot's project leaves as a relative POSIX reference.
function relativeSource(project, source, max) {
  if (typeof source !== 'string' || !source) return { source: null };
  if (typeof project !== 'string' || !path.isAbsolute(project) || !path.isAbsolute(source)) return { source: null, sourceOutside: true };
  const relative = path.relative(project, source);
  if (!relative || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.split(/[\\/]/).includes('..')) {
    return { source: null, sourceOutside: true };
  }
  const cleaned = cleanText(relative.replace(/\\/g, '/'), max);
  return { source: cleaned.text, truncated: cleaned.truncated };
}

function mapValidity(value) { return VALIDITY[value] || 'uncertain'; }

// Text may quote a profile/store or another absolute location. Sanitize before
// truncation, including quoted paths containing spaces and escaped separators.
// Relative references, HTTPS links and public /forge-* commands remain useful.
function redactAbsolutePaths(value, privateRoots) {
  if (typeof value !== 'string') return value;
  // Also mask known private roots embedded inside other prose or a URL, where
  // a generic path tokenizer intentionally preserves the surrounding link.
  let text = value;
  for (const root of privateRoots) text = redactProject(text, root, '<caminho>');
  return text
    .replace(/(["'`])(?:[a-z]:[\\/]+|[\\/])[^"'`\r\n]*\1/gi, (match, quote) =>
      /^\/forge(?:-[a-z0-9-]+)?(?:[.:]?$|\s)/i.test(match.slice(1, -1)) ? match : quote + '<caminho>' + quote)
    .replace(/\b[a-z]:[\\/]+[^\s<>"'`|,;!?()[\]{}]*/gi, '<caminho>')
    .replace(/(^|[\s"'`(=\[{;,:<>\u2018-\u201f])[\\/]+[^\s<>"'`|,;!?()[\]{}\u2018-\u201f]*/g, (match, prefix, offset, original) => {
      const candidate = match.slice(prefix.length);
      // A scheme:// URL is a link, while label:/absolute is a path. Known
      // private roots inside either form were already removed above.
      if (prefix === ':' && candidate.startsWith('//')
        && /[a-z][a-z0-9+.-]*:$/i.test(original.slice(0, offset + prefix.length))) return match;
      return /^\/forge(?:-[a-z0-9-]+)?[.:]?$/i.test(candidate) ? match : prefix + '<caminho>';
    });
}

function summarizeItem(capture, project, max, privateRoots) {
  const text = cleanText(redactAbsolutePaths(redactProject(capture.text, project), privateRoots), max);
  const where = relativeSource(project, capture.source, max);
  const item = { text: text.text, source: where.source, validity: mapValidity(capture.validity) };
  if (text.truncated || where.truncated) item.truncated = true;
  if (where.sourceOutside) item.sourceOutside = true;
  if (capture.validity === 'reconciliation-required') item.reason = 'reconciliation-required';
  return item;
}

function rank(entry) {
  if (entry.workStatus === 'pending' || entry.reliability === 'needs-reconciliation') return 0;
  return RANK[entry.workStatus] || RANK.unknown;
}

// Closed copy of what the summary may know about one work; nothing else from
// the snapshot (checkpoint history, hashes, capture times, state, terminal
// evidence or raw diagnostics) is reachable from here on.
function prepareWork(work) {
  const checkpoint = work.checkpoint && typeof work.checkpoint === 'object' ? work.checkpoint : {};
  const list = value => (Array.isArray(value) ? value : []);
  const entry = {
    id: work.id,
    kind: work.kind === 'milestone' ? 'milestone' : 'task',
    workStatus: WORK_STATUS.has(work.workStatus) ? work.workStatus : 'unknown',
    reliability: RELIABILITY.has(work.reliability) ? work.reliability : 'uncertain',
    activity: ACTIVITY.has(work.activity) ? work.activity : 'unknown',
    nextAction: null,
    lastResult: work.lastResult || null,
    pending: list(checkpoint.pending).filter(capture => capture.resolved === false),
    acceptances: effectiveAcceptances(list(checkpoint.acceptances)).filter(capture => capture.resolved === false),
  };
  // Completed work never becomes actionable through historical next-action prose.
  if (entry.workStatus !== 'completed') entry.nextAction = work.nextAction || null;
  entry.protected = entry.pending.length > 0 || entry.acceptances.length > 0 || entry.reliability !== 'current';
  return entry;
}

function workDiagnostic(id) {
  return typeof id === 'string' && ids.isValid(id) ? `${DIAGNOSTIC} --id ${id}` : null;
}

function compose(prepared, plan) {
  const tally = { nextAction: 0, lastResult: 0, pending: 0, acceptances: 0, truncated: 0 };
  const works = plan.listed.map(entry => {
    const work = { id: entry.id, kind: entry.kind, workStatus: entry.workStatus, reliability: entry.reliability,
      activity: entry.activity, nextAction: null, lastResult: null };
    for (const field of ['nextAction', 'lastResult']) {
      if (!entry[field]) continue;
      if (plan.optionalText) work[field] = summarizeItem(entry[field], prepared.project, plan.optionalText, prepared.privateRoots);
      else tally[field]++;
    }
    let affected = false;
    for (const field of ['pending', 'acceptances']) {
      const items = entry[field].slice(0, plan.mandatoryItems).map(capture => summarizeItem(capture, prepared.project, plan.mandatoryText, prepared.privateRoots));
      const hidden = entry[field].length - items.length;
      const truncated = items.filter(item => item.truncated).length;
      tally[field] += hidden;
      tally.truncated += truncated;
      if (hidden || truncated) affected = true;
      work[field] = { total: entry[field].length, items };
    }
    const diagnostic = (affected || entry.reliability !== 'current') && workDiagnostic(entry.id);
    if (diagnostic) work.diagnostic = diagnostic;
    return work;
  });
  const listed = new Set(plan.listed);
  let hiddenProtected = 0;
  for (const entry of prepared.entries) {
    if (listed.has(entry)) continue;
    tally.pending += entry.pending.length;
    tally.acceptances += entry.acceptances.length;
    if (entry.protected) hiddenProtected++;
  }
  const attention = hiddenProtected || tally.pending || tally.acceptances || tally.truncated
    ? { reason: 'attention-required', works: hiddenProtected, pending: tally.pending, acceptances: tally.acceptances,
      truncated: tally.truncated, diagnostic: DIAGNOSTIC }
    : null;
  return { status: 'ok', reason: prepared.reason, scope: 'summary', limits: { ...SUMMARY_LIMITS }, totals: prepared.totals,
    works, omitted: { works: prepared.entries.length - works.length, nextAction: tally.nextAction, lastResult: tally.lastResult },
    attention };
}

function failureSummary(reason) {
  // Unknown counts stay null: an error is never reported as "nothing pending".
  return { status: 'error', reason: REASONS.includes(reason) ? reason : 'snapshot-error', scope: 'summary',
    limits: { ...SUMMARY_LIMITS }, totals: null, works: [], omitted: null,
    attention: { reason: 'attention-required', works: null, pending: null, acceptances: null, truncated: null, diagnostic: DIAGNOSTIC } };
}

function fits(summary) {
  // One byte is reserved for the CLI's trailing newline.
  return Buffer.byteLength(JSON.stringify(summary), 'utf8') + 1 <= SUMMARY_LIMITS.bytes;
}

// Deterministic ladder: non-mandatory text and works go first; mandatory
// decisions are shortened, then counted, never silently dropped.
function bound(prepared) {
  const plan = { listed: prepared.entries.slice(0, SUMMARY_LIMITS.works), optionalText: SUMMARY_LIMITS.text,
    mandatoryText: SUMMARY_LIMITS.text, mandatoryItems: SUMMARY_LIMITS.items };
  let candidate = compose(prepared, plan);
  const attempt = change => { Object.assign(plan, change); candidate = compose(prepared, plan); return fits(candidate); };
  if (fits(candidate)) return candidate;
  if (attempt({ optionalText: NON_MANDATORY_TEXT })) return candidate;
  for (let index = plan.listed.length - 1; index >= 0; index--) {
    if (!plan.listed[index].protected && attempt({ listed: plan.listed.filter((_, other) => other !== index) })) return candidate;
  }
  if (attempt({ optionalText: 0 })) return candidate;
  if (attempt({ mandatoryText: NON_MANDATORY_TEXT })) return candidate;
  if (attempt({ mandatoryItems: 1 })) return candidate;
  while (plan.listed.length > 1) if (attempt({ listed: plan.listed.slice(0, -1) })) return candidate;
  if (attempt({ listed: [] })) return candidate;
  return failureSummary('summary-limit-exceeded');
}

function buildPersonalSummary(options = {}) {
  try {
    if (options.id != null && (typeof options.id !== 'string' || !ids.isValid(options.id))) return failureSummary('invalid-id');
    // Closed option set: no caller-supplied field can enable inspection or raise a limit.
    const snapshot = readPersonalSnapshot({ project: options.project, cwd: options.cwd, id: options.id,
      userHome: options.userHome, env: options.env });
    if (!snapshot || snapshot.status !== 'ok') return failureSummary(snapshot && snapshot.reason);
    const entries = (Array.isArray(snapshot.works) ? snapshot.works : []).map(prepareWork)
      .sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const totals = { works: entries.length, pending: 0, acceptances: 0 };
    for (const entry of entries) { totals.pending += entry.pending.length; totals.acceptances += entry.acceptances.length; }
    const home = options.userHome || os.homedir();
    const privateRoots = [home, typeof home === 'string' ? path.dirname(home) : null,
      options.env && options.env.FORGE_HOME || process.env.FORGE_HOME, path.resolve(__dirname, '..')].filter(root => typeof root === 'string' && root.length > 1 && path.isAbsolute(root));
    return bound({ reason: entries.length ? 'snapshot' : 'no-bindings', project: snapshot.project, entries, totals, privateRoots });
  } catch {
    return failureSummary('summary-failed');
  }
}

function render(summary) {
  return { json: JSON.stringify(summary), exitCode: summary.status === 'ok' ? 0 : 1 };
}

function renderPersonalSummary(options = {}) {
  return render(buildPersonalSummary(options));
}

function renderSummaryCommand(args = {}) {
  if (CONFLICTS.some(flag => args[flag])) return render(failureSummary('summary-command-conflict'));
  return renderPersonalSummary({ project: args.project, cwd: args.cwd, id: args.id });
}

module.exports = { SUMMARY_LIMITS, buildPersonalSummary, renderPersonalSummary, renderSummaryCommand };

if (require.main === module) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (!flag.startsWith('--')) continue;
    args[flag.slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
  }
  const rendered = renderSummaryCommand(args);
  process.stdout.write(rendered.json + '\n');
  process.exitCode = rendered.exitCode;
}
