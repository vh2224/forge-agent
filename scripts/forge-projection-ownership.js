#!/usr/bin/env node
// forge-projection-ownership.js — one formulation of "is this destination ours?"
//
// WHY THIS EXISTS
// ---------------
// A projection is only managed if the installer can prove the file on disk is
// its own output. That proof used to be a single mechanism — an origin marker
// embedded in the content — and a mechanism embedded in content cannot exist for
// a format without comments. JSON is that format, so every JSON projection
// (`forge-prefs.schema.json`, the Codex `capabilities.json`) became a permanent
// `user_owned` conflict the first time it diverged: frozen at the bytes of
// whichever release created it, while each `--update` preserved it and reported
// success. The same defect took `.js` projections until scripts learned a `//`
// marker, which fixed the symptom for one more format and left the shape intact.
//
// The durable fix is a proof that does not live in the file: record the digest of
// what we wrote, and on the next run ask whether the bytes on disk are still that.
// It works for every format, including the ones that can never carry a marker.
//
// STRICTLY ADDITIVE, AND THAT IS A DECISION
// -----------------------------------------
// The digest is consulted only when the marker is absent — it can grant ownership,
// never revoke it. A hash-FIRST rule would be defensible and slightly stronger
// (it would also stop the installer from overwriting an operator's edits to a
// marked file, which today it happily does), but it would turn files that are
// currently updated into conflicts, which is a behavior change well beyond
// closing the freeze. Recorded here as a deliberate non-change rather than an
// oversight; flipping it is a separate decision with its own migration.
//
// Exports:
//   digest(content) → sha256 hex of the normalized bytes
//   decide({ current, recordedDigest, markerPresent, migrateLegacy }) → { ours, basis }
//     basis: 'absent' | 'marker' | 'digest' | 'migrate-legacy' | null
//   recordOf(entries) → { [resolved destination]: digest }
//   keyFor(destination) → resolved absolute path used as the record key
//
// Zero npm dependencies — Node built-ins only.

'use strict';

const crypto = require('crypto');
const path = require('path');

// Line endings are not content. A checkout with core.autocrlf=true hands back
// CRLF for a file we wrote as LF; digesting the raw bytes would report every
// such destination as operator-edited and re-freeze exactly what this closes.
function normalize(content) {
  return String(content).replace(/\r\n/g, '\n');
}

function digest(content) {
  return crypto.createHash('sha256').update(normalize(content), 'utf8').digest('hex');
}

function keyFor(destination) {
  return path.resolve(String(destination));
}

/**
 * Decide whether a destination is the installer's to overwrite.
 *
 * Order is the contract, not an implementation detail:
 *  1. nothing on disk        → ours (a fresh install always projects)
 *  2. --migrate-legacy       → ours (the explicit operator escape, unchanged)
 *  3. marker present         → ours (pre-existing behavior, never narrowed)
 *  4. digest matches record  → ours (NEW — the only rung a marker-less format can reach)
 *  5. otherwise              → not ours
 *
 * @param {object} input
 * @param {?string} input.current          bytes on disk, or null when absent
 * @param {?string} input.recordedDigest   digest we recorded when we last wrote it
 * @param {boolean} input.markerPresent    result of the renderer's marker probe
 * @param {boolean} [input.migrateLegacy]  operator asked to adopt unmarked files
 * @returns {{ours: boolean, basis: ?string}}
 */
function decide(input = {}) {
  const { current, recordedDigest, markerPresent, migrateLegacy } = input;

  if (current === null || current === undefined) return { ours: true, basis: 'absent' };
  if (migrateLegacy) return { ours: true, basis: 'migrate-legacy' };
  if (markerPresent) return { ours: true, basis: 'marker' };
  if (recordedDigest && digest(current) === recordedDigest) return { ours: true, basis: 'digest' };
  return { ours: false, basis: null };
}

/**
 * Build the record to persist from everything this run wrote or already owned.
 *
 * A dry run contributes nothing: recording a digest for bytes never written
 * would make the NEXT run believe it owns a file it never touched.
 *
 * @param {Array<{destination: string, content: string, dry_run?: boolean}>} entries
 * @returns {object}
 */
function recordOf(entries) {
  const record = {};
  for (const entry of entries || []) {
    if (!entry || !entry.destination || entry.dry_run) continue;
    if (typeof entry.content !== 'string') continue;
    record[keyFor(entry.destination)] = digest(entry.content);
  }
  return record;
}

module.exports = { digest, decide, recordOf, keyFor, normalize };
