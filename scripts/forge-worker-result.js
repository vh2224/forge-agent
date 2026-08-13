#!/usr/bin/env node
// forge-worker-result.js — Classify a Claude worker's return, and recover a
// missing contract from what the worker itself already wrote to disk.
//
// WHY THIS EXISTS
// ---------------
// A subagent whose final message is cut off is, downstream, byte-for-byte
// indistinguishable from one that finished: both arrive as "the Agent() call
// returned". The `---GSD-WORKER-RESULT---` block is the only thing that tells
// them apart, and until now NO orchestrator skill had a branch for its absence
// — grep for "result block" across skills/forge-{auto,next,task} found parsing
// for `done`/`partial`/`blocked` and nothing for "no block at all". With no
// named branch, the model improvises: measured incidents show a session
// inventing an ad-hoc resume-by-agentId while a 300k-token executor's work sat
// finished on disk, unread.
//
// The recovery here is deliberately NOT a heuristic over the prose. It reads
// the artifacts the worker wrote before it was cut — its own events.jsonl line,
// its own T##-SUMMARY.md, its own `status: DONE` frontmatter edit. Those are
// the worker's writing, so using them is recovery, not fabrication. Same
// precedent as `shared/forge-review.md § Step 3 → Salvage before declaring
// unavailability`, which recovers advocate verdicts from DEFENSE_FILE.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
// It does not try to distinguish "the stream was cut" from "the agent forgot
// the block". Both have the same remedy, so a heuristic separating them would
// buy a label and no decision — and a prose-shape guess (unclosed fence, no
// terminal punctuation) would be exactly the kind of confident-but-unmeasured
// signal this codebase keeps having to delete.
//
// Exports:
//   classifyReturn(text) → { shape, status, fields, marker_count, chars, tail }
//     shape: 'empty' | 'absent' | 'status-missing' | 'complete'
//   salvageUnit(opts)    → { unit, probes[], basis[], recovered, reason }
//   formatResultBlock(fields) → string
//
// CLI (advisory — exit 0 on any classification/salvage outcome; exit 2 only on
// usage error, so "no evidence" is never confused with "the tool broke"):
//   node scripts/forge-worker-result.js --classify --file <path>
//   node scripts/forge-worker-result.js --classify --inline "<text>"
//   node scripts/forge-worker-result.js --salvage --unit execute-task/T05 \
//        [--plan <path>] [--summary <path>] [--events <path>]... \
//        [--code-dir <dir>] [--since <baseline>] [--vcs git|svn]
//
// Zero npm dependencies — Node built-ins only.

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

const RESULT_MARKER = '---GSD-WORKER-RESULT---';
const END_MARKER    = '---END-RESULT---';

// The status enum is closed. A block carrying anything else is `status-missing`,
// not a fifth silent state: an unrecognized status must not be laundered into a
// verdict the orchestrator then acts on.
const STATUS_VALUES = new Set(['done', 'partial', 'blocked']);

// Tail shown to the operator so they can see where the message stopped. Bounded
// because this lands in a JSON payload that gets echoed into a terminal.
const TAIL_CHARS = 240;

// ── classifyReturn ────────────────────────────────────────────────────────────

/**
 * Classify a worker's returned text against the result-block contract.
 *
 * The LAST marker wins. Agent instructions quote the literal marker in their own
 * prose, and a worker restating its instructions would otherwise hand us the
 * template's empty fields as if they were its verdict. "End your response with
 * this block" is the contract, so the last occurrence is the one that means it.
 *
 * @param {string} text  The worker's returned message
 * @returns {{shape:string,status:?string,fields:object,marker_count:number,chars:number,tail:string}}
 */
function classifyReturn(text) {
  const raw = typeof text === 'string' ? text : '';
  const chars = raw.length;
  const tail = raw.slice(-TAIL_CHARS);

  if (!raw.trim()) {
    return { shape: 'empty', status: null, fields: {}, marker_count: 0, chars, tail };
  }

  let markerCount = 0;
  let lastIndex = -1;
  for (let at = raw.indexOf(RESULT_MARKER); at !== -1; at = raw.indexOf(RESULT_MARKER, at + 1)) {
    markerCount++;
    lastIndex = at;
  }

  if (lastIndex === -1) {
    return { shape: 'absent', status: null, fields: {}, marker_count: 0, chars, tail };
  }

  const fields = parseBlockFields(raw.slice(lastIndex + RESULT_MARKER.length));
  const status = typeof fields.status === 'string' ? fields.status.trim().toLowerCase() : null;

  if (!status || !STATUS_VALUES.has(status)) {
    return { shape: 'status-missing', status: null, fields, marker_count: markerCount, chars, tail };
  }

  return { shape: 'complete', status, fields, marker_count: markerCount, chars, tail };
}

/**
 * Parse the `key: value` body of a result block into a plain object.
 *
 * Scalars and simple `- item` lists only. This is not a YAML engine and must not
 * become one: the block is a handful of flat fields, and a real parser here
 * would invite nested payloads the orchestrator has no contract for.
 *
 * @param {string} body  Text following the result marker
 * @returns {object}
 */
function parseBlockFields(body) {
  const fields = {};
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  let listKey = null;

  for (const line of lines) {
    if (line.trim() === END_MARKER) break;

    // A `- item` continuation belongs to the key that opened the list.
    const listItem = /^[ \t]*-[ \t]+(.*)$/.exec(line);
    if (listItem && listKey) {
      fields[listKey].push(stripQuotes(listItem[1].trim()));
      continue;
    }

    const pair = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!pair) continue;

    const key = pair[1];
    const value = pair[2].trim();
    if (value === '') {
      // `key:` with nothing after it opens a list. If no items follow it stays
      // an empty array, which is a real value — not a missing key.
      fields[key] = [];
      listKey = key;
    } else {
      fields[key] = stripQuotes(value);
      listKey = null;
    }
  }

  return fields;
}

function stripQuotes(value) {
  const m = /^(['"])([\s\S]*)\1$/.exec(value);
  return m ? m[2] : value;
}

/**
 * Render a result block from fields. Used to hand the orchestrator a block it
 * can process on the normal path after a salvage.
 *
 * @param {object} fields
 * @returns {string}
 */
function formatResultBlock(fields) {
  const lines = [RESULT_MARKER];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push(END_MARKER);
  return lines.join('\n');
}

// ── salvageUnit ───────────────────────────────────────────────────────────────

/**
 * Look for the worker's own terminal writes on disk.
 *
 * Every probe is reported, always, including the ones that found nothing —
 * `outcome: 'miss'` and `outcome: 'unavailable'` are distinct, and neither is
 * omission. A salvage report that lists only its hits is indistinguishable from
 * one whose probes never ran, which is the exact defect class this file exists
 * to close.
 *
 * @param {object} opts
 * @param {string} opts.unit        e.g. "execute-task/T05" — matched against event lines
 * @param {string} [opts.planPath]  T##-PLAN.md
 * @param {string} [opts.summaryPath] T##-SUMMARY.md
 * @param {string[]} [opts.eventsPaths] per-milestone events.jsonl, then legacy
 * @param {string} [opts.codeDir]   working copy for the VCS delta probe
 * @param {string} [opts.since]     baseline revision for the VCS delta probe
 * @param {string} [opts.vcs]       'git' | 'svn'
 * @returns {{unit:string,probes:object[],basis:string[],recovered:?object,reason:?string}}
 */
function salvageUnit(opts = {}) {
  const unit = String(opts.unit || '').trim();
  const probes = [];

  probes.push(probeWorkerEvent(unit, opts.eventsPaths || []));
  probes.push(probeSummaryFile(opts.summaryPath));
  probes.push(probePlanStatus(opts.planPath));
  probes.push(probeVcsDelta(opts.codeDir, opts.since, opts.vcs));

  const byName = Object.fromEntries(probes.map((p) => [p.name, p]));
  const event   = byName['worker-event'];
  const summary = byName['summary-file'];
  const plan    = byName['plan-status'];
  const delta   = byName['vcs-delta'];

  // Rung 1 — the worker's own event line. `agents/forge-executor.md` appends it
  // immediately BEFORE returning the block, so a worker cut during the block has
  // very likely already recorded its verdict, in its own words.
  if (event.outcome === 'hit' && event.status) {
    return {
      unit,
      probes,
      basis: ['worker-event'],
      recovered: buildRecovered({
        status: event.status,
        summary: event.summary,
        files: event.files_changed,
        basis: ['worker-event'],
      }),
      reason: null,
    };
  }

  // Rung 2 — both terminal artifacts. Writing T##-SUMMARY.md and stamping the
  // plan `status: DONE` are the last two steps the executor performs on its own
  // (steps 12 and 13); a worker that did both reached its conclusion. Requiring
  // BOTH is the point: either one alone is a worker mid-flight.
  if (summary.outcome === 'hit' && plan.outcome === 'hit' && plan.status === 'DONE') {
    return {
      unit,
      probes,
      basis: ['summary-file', 'plan-status'],
      recovered: buildRecovered({
        status: 'done',
        summary: null,
        files: null,
        basis: ['summary-file', 'plan-status'],
      }),
      reason: null,
    };
  }

  // No rung carried a verdict. Name which shape of nothing this is — the three
  // reasons lead to different operator decisions, so collapsing them into one
  // "not found" would throw away the only actionable part of the report.
  let reason = 'no-evidence';
  if (summary.outcome === 'hit' || (plan.outcome === 'hit' && plan.status)) {
    reason = 'partial-terminal';
  } else if (delta.outcome === 'hit') {
    reason = 'work-without-conclusion';
  }

  return { unit, probes, basis: [], recovered: null, reason };
}

/**
 * A recovered block is marked as recovered, in the block itself.
 *
 * `must_haves_status` is NEVER synthesized. It is the worker's measured claim
 * about its own must-haves; absent, it must stay absent so the verifier and the
 * repair gate run against real evidence instead of a value this function made up.
 */
function buildRecovered({ status, summary, files, basis }) {
  const fields = { status };
  if (summary) fields.summary = summary;
  if (Array.isArray(files) && files.length) fields.files_written = files;
  fields.salvaged = 'true';
  fields.salvage_basis = basis.join(',');
  return { fields, block: formatResultBlock(fields), status };
}

// ── Probes ────────────────────────────────────────────────────────────────────

/**
 * Last event line matching this unit, across the given files in order.
 *
 * Reads every file and keeps the LAST match overall: a unit re-dispatched after
 * a repair appends a second line, and the older one is not the current verdict.
 */
function probeWorkerEvent(unit, eventsPaths) {
  const probe = { name: 'worker-event', outcome: 'miss', detail: null, status: null, summary: null, files_changed: null };

  if (!unit) {
    probe.outcome = 'unavailable';
    probe.detail = 'no unit id supplied';
    return probe;
  }
  if (!eventsPaths.length) {
    probe.outcome = 'unavailable';
    probe.detail = 'no events file supplied';
    return probe;
  }

  let found = null;
  let foundIn = null;
  let readable = 0;

  for (const file of eventsPaths) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // absent or unreadable file is a miss for THIS file, not an error
    }
    readable++;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!row || row.unit !== unit) continue;
      if (!STATUS_VALUES.has(String(row.status || '').toLowerCase())) continue;
      found = row;
      foundIn = file;
    }
  }

  if (!readable) {
    probe.outcome = 'unavailable';
    probe.detail = `none of ${eventsPaths.length} events file(s) readable`;
    return probe;
  }
  if (!found) {
    probe.detail = `no line for unit "${unit}" in ${readable} readable events file(s)`;
    return probe;
  }

  probe.outcome = 'hit';
  probe.detail = `${path.basename(foundIn)}`;
  probe.status = String(found.status).toLowerCase();
  probe.summary = typeof found.summary === 'string' ? found.summary : null;
  probe.files_changed = Array.isArray(found.files_changed) ? found.files_changed : null;
  return probe;
}

function probeSummaryFile(summaryPath) {
  const probe = { name: 'summary-file', outcome: 'miss', detail: null, lines: 0 };

  if (!summaryPath) {
    probe.outcome = 'unavailable';
    probe.detail = 'no summary path supplied';
    return probe;
  }

  let text;
  try {
    text = fs.readFileSync(summaryPath, 'utf8');
  } catch (err) {
    // ENOENT is a genuine miss (the worker never got there). Any other errno is
    // a file we could not inspect, which is not evidence in either direction.
    if (err && err.code === 'ENOENT') {
      probe.detail = 'summary file absent';
      return probe;
    }
    probe.outcome = 'unavailable';
    probe.detail = `unreadable (${err && err.code ? err.code : 'unknown errno'})`;
    return probe;
  }

  probe.lines = text.split('\n').length;
  if (!text.trim()) {
    probe.detail = 'summary file present but empty';
    return probe;
  }

  probe.outcome = 'hit';
  probe.detail = `${probe.lines} lines`;
  return probe;
}

function probePlanStatus(planPath) {
  const probe = { name: 'plan-status', outcome: 'miss', detail: null, status: null };

  if (!planPath) {
    probe.outcome = 'unavailable';
    probe.detail = 'no plan path supplied';
    return probe;
  }

  let text;
  try {
    text = fs.readFileSync(planPath, 'utf8');
  } catch (err) {
    probe.outcome = 'unavailable';
    probe.detail = `unreadable (${err && err.code ? err.code : 'unknown errno'})`;
    return probe;
  }

  // BOM + CRLF tolerated on purpose: a plan in either form silently disabling a
  // gate is a failure this repo has already paid for once (PR #85).
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---/.exec(normalized);
  if (!fm) {
    probe.detail = 'plan has no frontmatter';
    return probe;
  }

  const m = /^status[ \t]*:[ \t]*(\S+)/m.exec(fm[1]);
  if (!m) {
    probe.detail = 'frontmatter carries no status field';
    return probe;
  }

  probe.outcome = 'hit';
  probe.status = m[1].toUpperCase();
  probe.detail = `status: ${probe.status}`;
  return probe;
}

/**
 * Did the working copy actually change since the dispatch baseline?
 *
 * This probe NEVER carries a verdict on its own — changed files mean work
 * happened, not that the task concluded. It exists to separate "the worker did
 * nothing" from "the worker did a lot and we lost the report", which is the
 * difference between re-dispatching cheaply and re-dispatching over live work.
 */
function probeVcsDelta(codeDir, since, vcs) {
  const probe = { name: 'vcs-delta', outcome: 'miss', detail: null, changed: 0 };

  if (!codeDir || !since) {
    probe.outcome = 'unavailable';
    probe.detail = 'no code dir / baseline supplied';
    return probe;
  }

  let postChanges;
  try {
    ({ postChanges } = require('./forge-vcs'));
  } catch {
    probe.outcome = 'unavailable';
    probe.detail = 'forge-vcs unavailable';
    return probe;
  }

  let result;
  try {
    result = postChanges(codeDir, since, vcs ? { vcs } : {});
  } catch (err) {
    probe.outcome = 'unavailable';
    probe.detail = `vcs query failed: ${err && err.message ? err.message : 'unknown'}`;
    return probe;
  }

  if (!result || result.ok !== true) {
    probe.outcome = 'unavailable';
    probe.detail = `vcs query failed: ${(result && result.error) || 'unknown'}`;
    return probe;
  }

  probe.changed = result.entries.length;
  if (!probe.changed) {
    probe.detail = 'no change since baseline';
    return probe;
  }

  probe.outcome = 'hit';
  probe.detail = `${probe.changed} path(s) changed since baseline`;
  return probe;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  classifyReturn,
  salvageUnit,
  formatResultBlock,
  parseBlockFields,
  RESULT_MARKER,
  END_MARKER,
  STATUS_VALUES,
};

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { events: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--classify':  out.classify = true; break;
      case '--salvage':   out.salvage = true; break;
      case '--file':      out.file = next(); break;
      case '--inline':    out.inline = next(); break;
      case '--unit':      out.unit = next(); break;
      case '--plan':      out.plan = next(); break;
      case '--summary':   out.summary = next(); break;
      case '--events':    out.events.push(next()); break;
      case '--code-dir':  out.codeDir = next(); break;
      case '--since':     out.since = next(); break;
      case '--vcs':       out.vcs = next(); break;
      case '--help':      out.help = true; break;
      default: break;
    }
  }
  return out;
}

const USAGE = [
  'Usage:',
  '  forge-worker-result.js --classify (--file <path> | --inline <text>)',
  '  forge-worker-result.js --salvage --unit <type/id> [--plan <p>] [--summary <p>]',
  '                          [--events <p>]... [--code-dir <d>] [--since <rev>] [--vcs git|svn]',
].join('\n');

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || (!args.classify && !args.salvage)) {
    process.stderr.write(USAGE + '\n');
    process.exit(args.help ? 0 : 2);
  }

  try {
    if (args.classify) {
      let text = args.inline;
      if (text === undefined) {
        if (!args.file) {
          process.stderr.write(JSON.stringify({ error: '--classify requires --file or --inline' }) + '\n');
          process.exit(2);
        }
        text = fs.readFileSync(args.file, 'utf8');
      }
      process.stdout.write(JSON.stringify(classifyReturn(text)) + '\n');
      process.exit(0);
    }

    if (!args.unit) {
      process.stderr.write(JSON.stringify({ error: '--salvage requires --unit' }) + '\n');
      process.exit(2);
    }

    const report = salvageUnit({
      unit: args.unit,
      planPath: args.plan,
      summaryPath: args.summary,
      eventsPaths: args.events,
      codeDir: args.codeDir,
      since: args.since,
      vcs: args.vcs,
    });
    process.stdout.write(JSON.stringify(report) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: String(err && err.message ? err.message : err) }) + '\n');
    process.exit(2);
  }
}
