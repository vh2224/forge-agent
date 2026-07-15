#!/usr/bin/env node
/**
 * forge-review-pairing.js
 *
 * Resolves review author, challenger, and advocate from the canonical dispatch
 * event stream at `.gsd/forge/events.jsonl` beneath `--cwd`. `--events <file>`
 * overrides that path for fixtures and other explicitly selected streams.
 *
 * Only `dispatch` events whose unit begins with `execute-task/` contribute to
 * authorship. When `--slice` is supplied, events that contain a `slice` field
 * must match it; legacy events without that field remain eligible because the
 * caller may already have supplied a slice-scoped stream. `--milestone`
 * applies the same lenient-when-absent match against an event's `milestone`
 * field, guarding against slice-ID recurrence across milestones.
 *
 * The CLI emits one newline-terminated JSON object with this fixed contract:
 *   { author, author_engine, challenger, advocate, reason, counts, policy,
 *     fallbacks, requested }
 * Readers degrade silently for missing files and malformed JSONL records.
 * Pairing degradation is represented in `policy` and `fallbacks`, never by a
 * non-zero exit status.
 *
 * Exports:
 *   aggregateAuthor(events, opts) -> authorship result
 *   resolvePairing(author, opts) -> pairing result
 *   readEvents(file) -> parsed event objects
 *
 * CLI usage:
 *   node forge-review-pairing.js --slice S02 --milestone M006 --cwd <dir>
 *   node forge-review-pairing.js --events <fixture.jsonl> [--json]
 *     [--challenger auto|claude|codex] [--advocate auto|claude|codex]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { engineFamily } = require('./forge-model-alias');

const VALID_REQUESTS = ['auto', 'claude', 'codex'];

// Event readers are intentionally silent-fail. Telemetry writers have a
// different contract; this module only consumes an append-only event stream.
function readEvents(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const events = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const event = JSON.parse(line);
      if (event && typeof event === 'object' && !Array.isArray(event)) {
        events.push(event);
      }
    } catch {
      // Corrupt and partially appended records carry no authorship signal.
      continue;
    }
  }
  return events;
}

function isAuthorshipEvent(event, slice, milestone) {
  if (!event || event.event !== 'dispatch') return false;
  if (typeof event.unit !== 'string') return false;
  if (!event.unit.startsWith('execute-task/')) return false;
  if (
    slice !== undefined &&
    slice !== null &&
    Object.prototype.hasOwnProperty.call(event, 'slice') &&
    event.slice !== slice
  ) {
    return false;
  }
  if (
    milestone !== undefined &&
    milestone !== null &&
    Object.prototype.hasOwnProperty.call(event, 'milestone') &&
    event.milestone !== milestone
  ) {
    return false;
  }
  return true;
}

// Missing or invalid additive engine data defaults to Claude without a
// fallback marker. This differs deliberately from having no task events.
function eventEngine(event) {
  return event.engine === 'codex' || event.engine === 'claude'
    ? event.engine
    : 'claude';
}

function aggregateAuthor(events, opts) {
  const options = opts || {};
  const usePolicy = options.policy === 'last' ? 'last' : 'majority';
  const counts = { claude: 0, codex: 0 };
  let lastEngine = null;

  for (const event of Array.isArray(events) ? events : []) {
    if (!isAuthorshipEvent(event, options.slice, options.milestone)) continue;
    const engine = eventEngine(event);
    counts[engine] += 1;
    lastEngine = engine;
  }

  if (lastEngine === null) {
    return {
      author: 'claude',
      author_engine: 'claude',
      counts,
      policy: 'no-authorship-data',
      fallbacks: ['no-authorship-data'],
    };
  }

  let winnerEngine;
  let policy;
  if (usePolicy === 'last') {
    winnerEngine = lastEngine;
    policy = 'last-dispatch';
  } else if (counts.claude === counts.codex) {
    winnerEngine = lastEngine;
    policy = 'tie-last';
  } else {
    winnerEngine = counts.codex > counts.claude ? 'codex' : 'claude';
    policy = 'majority';
  }

  return {
    author: engineFamily(winnerEngine) || 'claude',
    author_engine: winnerEngine,
    counts,
    policy,
    fallbacks: [],
  };
}

function normalizeRequest(value) {
  return VALID_REQUESTS.includes(value) ? value : 'auto';
}

function resolvePairing(author, opts) {
  const options = opts || {};
  const family = author === 'gpt' ? 'gpt' : 'claude';
  const challengerReq = normalizeRequest(options.challengerReq);
  const advocateReq = normalizeRequest(options.advocateReq);
  const fallbacks = Array.isArray(options.fallbacks)
    ? options.fallbacks.slice()
    : [];

  const challengerExplicit = challengerReq !== 'auto';
  const advocateExplicit = advocateReq !== 'auto';
  const challenger = challengerExplicit
    ? challengerReq
    : (family === 'claude' ? 'codex' : 'claude');

  let advocate;
  if (advocateExplicit) {
    advocate = advocateReq;
  } else if (family === 'claude') {
    advocate = 'claude';
  } else {
    advocate = 'claude';
    if (!fallbacks.includes('defend-mode-unavailable')) {
      fallbacks.push('defend-mode-unavailable');
    }
  }

  return {
    challenger,
    advocate,
    challengerPolicy: challengerExplicit ? 'explicit' : 'opposite',
    advocatePolicy: advocateExplicit
      ? 'explicit'
      : (family === 'gpt' ? 'defend-mode-unavailable' : 'same-family'),
    fallbacks,
    requested: { challenger: challengerReq, advocate: advocateReq },
  };
}

function buildReason(authorship, pairing) {
  const counts = `${authorship.counts.codex} codex / ${authorship.counts.claude} claude`;
  const challenger = pairing.challengerPolicy === 'explicit'
    ? `explicit(${pairing.challenger})`
    : `opposite(${pairing.challenger})`;
  const advocate = pairing.advocatePolicy === 'explicit'
    ? `explicit(${pairing.advocate})`
    : pairing.advocatePolicy === 'defend-mode-unavailable'
      ? 'defend-mode-unavailable→claude'
      : `same-family(${pairing.advocate})`;
  const fallbackSuffix = pairing.fallbacks.length > 0
    ? `; fallbacks=${pairing.fallbacks.join(',')}`
    : '';
  return `${authorship.policy} ${counts} → author ${authorship.author}; ` +
    `challenger=${challenger}; advocate=${advocate}${fallbackSuffix}`;
}

function parseArgs(args) {
  const parsed = {
    milestone: null,
    slice: null,
    cwd: process.cwd(),
    challengerReq: 'auto',
    advocateReq: 'auto',
    eventsFile: null,
    asJson: false,
    policy: 'majority',
  };

  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === '--milestone' && value !== undefined) {
      parsed.milestone = value;
      i += 1;
    } else if (args[i] === '--slice' && value !== undefined) {
      parsed.slice = value;
      i += 1;
    } else if (args[i] === '--cwd' && value !== undefined) {
      parsed.cwd = value;
      i += 1;
    } else if (args[i] === '--challenger' && value !== undefined) {
      parsed.challengerReq = normalizeRequest(value);
      i += 1;
    } else if (args[i] === '--advocate' && value !== undefined) {
      parsed.advocateReq = normalizeRequest(value);
      i += 1;
    } else if (args[i] === '--events' && value !== undefined) {
      parsed.eventsFile = value;
      i += 1;
    } else if (args[i] === '--json') {
      parsed.asJson = true;
    } else if (args[i] === '--policy' && value !== undefined) {
      parsed.policy = value === 'last' ? 'last' : 'majority';
      i += 1;
    }
  }
  return parsed;
}

function runCli(args) {
  const options = parseArgs(args);
  const file = options.eventsFile || path.join(
    options.cwd,
    '.gsd',
    'forge',
    'events.jsonl'
  );
  const events = readEvents(file);
  const authorship = aggregateAuthor(events, {
    slice: options.slice,
    milestone: options.milestone,
    policy: options.policy,
  });
  const pairing = resolvePairing(authorship.author, {
    challengerReq: options.challengerReq,
    advocateReq: options.advocateReq,
    fallbacks: authorship.fallbacks,
  });

  const result = {
    author: authorship.author,
    author_engine: authorship.author_engine,
    challenger: pairing.challenger,
    advocate: pairing.advocate,
    reason: buildReason(authorship, pairing),
    counts: authorship.counts,
    policy: authorship.policy,
    fallbacks: pairing.fallbacks,
    requested: pairing.requested,
  };
  process.stdout.write(JSON.stringify(result) + '\n');
}

module.exports = { aggregateAuthor, resolvePairing, readEvents };

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch {
    // Last-resort degradation keeps the CLI non-blocking even on unexpected
    // local runtime failures. Preserve the same ordered output contract.
    const authorship = aggregateAuthor([], {});
    const pairing = resolvePairing(authorship.author, {
      challengerReq: 'auto',
      advocateReq: 'auto',
      fallbacks: authorship.fallbacks,
    });
    const result = {
      author: authorship.author,
      author_engine: authorship.author_engine,
      challenger: pairing.challenger,
      advocate: pairing.advocate,
      reason: buildReason(authorship, pairing),
      counts: authorship.counts,
      policy: authorship.policy,
      fallbacks: pairing.fallbacks,
      requested: pairing.requested,
    };
    process.stdout.write(JSON.stringify(result) + '\n');
  }
  process.exit(0);
}
