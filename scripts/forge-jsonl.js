#!/usr/bin/env node
/**
 * forge-jsonl.js
 *
 * Shared tolerant JSONL reader for the two in-process consumers that used to
 * carry their own copy: scripts/forge-tokens.js (readJsonlLines) and
 * scripts/forge-dashboard.js (readEventsTail). Promotes the tokens
 * implementation (the one that already runs in production) and hardens it
 * per the widest-of-both-readers decision measured during discuss:
 *   - CRLF and lone CR (classic Mac line ending) both normalize to LF. Lone
 *     CR was the one real behavioural gap between the two prior readers
 *     (tokens read 0 records off a lone-CR fixture, dashboard read 2); the
 *     wider (dashboard) semantics wins, so this is always a widening, never
 *     a narrowing, of what tokens used to accept.
 *   - A leading BOM (U+FEFF) is stripped explicitly. `.trim()` per line
 *     already absorbs a BOM wherever it lands, which is why tokens never
 *     visibly broke on it; forge-dashboard's old code split first and parsed
 *     second, so the BOM landed inside the first JSON.parse and dropped that
 *     record. Stripping it up front fixes the dashboard path without
 *     changing the tokens path (both already tolerate it).
 *   - `maxLines`, when given, slices the RAW (pre-parse) line array, in the
 *     exact position forge-dashboard.js used: normalize -> trimEnd() ->
 *     split('\n') -> slice(-maxLines) -> parse. Slicing after parsing would
 *     silently change the tail window callers see (measured: 1 entry vs 3
 *     on the same fixture) — a behaviour change disguised as a refactor.
 *   - Every line that is not parsed is counted, never silently dropped within
 *     the scanned window: the return carries a census (`total`,
 *     `skipped_empty`, `skipped_malformed`, `truncated_tail`) in addition to
 *     `lines`, so a caller that only reads `.lines` gets byte-identical
 *     behaviour to the two prior readers, and a caller that wants to diagnose
 *     discard (I-20260814142227) has the data. A `maxLines` cut is an
 *     explicit window choice by the caller, not silent discard — lines
 *     outside that window are outside the census by design (see the `total`
 *     doc below).
 *   - Missing files and I/O errors return an empty result. Never throws.
 *
 * Zero npm dependencies. CommonJS (matches scripts/ convention). Library-only
 * — no CLI: both consumers are `require()`d in-process, so a CLI surface
 * would add argument/exit-code contract with no caller.
 *
 * Exports:
 *   readJsonl(absPath, opts?) -> {
 *     lines: object[],
 *     total: number,
 *     skipped_empty: number,
 *     skipped_malformed: number,
 *     truncated_tail: boolean,
 *   }
 *     opts.maxLines: number — keep only the last N raw lines before parsing.
 *       Omitted (or non-number) means read everything (prior tokens.js
 *       contract).
 *
 *     `total` is the count of raw lines in the SCANNED WINDOW (i.e. after any
 *     `maxLines` slice has already been applied), not the whole file. Lines
 *     dropped by the `maxLines` cut live outside the census entirely — they
 *     are neither counted in `total` nor in `skipped_*`, because the window
 *     itself is an explicit, caller-requested boundary, not something the
 *     reader silently discarded. Within the scanned window the additive
 *     invariant `lines.length + skipped_empty + skipped_malformed === total`
 *     always holds.
 */

'use strict';

const fs = require('fs');

function emptyResult() {
  return { lines: [], total: 0, skipped_empty: 0, skipped_malformed: 0, truncated_tail: false };
}

/**
 * Read a JSONL file tolerantly. Malformed/truncated lines and blank lines are
 * dropped but counted; missing files or I/O errors yield an empty result.
 * Never throws.
 *
 * @param {string} absPath
 * @param {{ maxLines?: number }} [opts]
 * @returns {{ lines: object[], total: number, skipped_empty: number, skipped_malformed: number, truncated_tail: boolean }}
 */
function readJsonl(absPath, opts) {
  opts = opts || {};
  const maxLines = typeof opts.maxLines === 'number' && opts.maxLines >= 0 ? opts.maxLines : null;

  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    return emptyResult();
  }

  // Form A-funnel: normalize both CRLF and lone CR to LF at the read. The
  // rest of this module (and both former call sites) only ever deals with
  // LF-terminated lines from this point on.
  raw = raw.replace(/\r\n?/g, '\n');

  // Strip a leading BOM before splitting, so it never lands inside the first
  // line's JSON.parse.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  raw = raw.trimEnd();
  if (!raw) return emptyResult();

  // Defensive form-A: split tolerant of a stray \r even though the earlier
  // replace() already collapsed CRLF/CR to LF — keeps this split correct on
  // its own if it is ever reached without going through that normalize step.
  let rawLines = raw.split(/\r?\n/);
  let truncated_tail = false;
  if (maxLines !== null && rawLines.length > maxLines) {
    rawLines = rawLines.slice(-maxLines);
    truncated_tail = true;
  }

  const lines = [];
  let skipped_empty = 0;
  let skipped_malformed = 0;
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (!line) {
      skipped_empty++;
      continue;
    }
    try {
      lines.push(JSON.parse(line));
    } catch (e) {
      // malformed/truncated line — counted, never silently dropped
      skipped_malformed++;
    }
  }

  return {
    lines,
    total: rawLines.length,
    skipped_empty,
    skipped_malformed,
    truncated_tail,
  };
}

module.exports = { readJsonl };
