#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  buildReviewEvent,
  buildUnavailableEvent,
  appendEvents,
  familyOf,
} = require('./forge-review-emit.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-emit-'));
const CLI = path.join(__dirname, 'forge-review-emit.js');
// `authorEngine` is part of the base because it is REQUIRED: the emitter
// refuses a row whose intra_family_debate it cannot derive (asserted below).
const base = {
  milestone: 'M134', slice: 'S02', ts: '2026-08-05T01:06:45Z', authorEngine: 'claude',
};

// ── The canonical shape is complete, always ─────────────────────────────────
// The defect this emitter closes was field OMISSION, not field corruption:
// 265 hand-written events produced 151 key shapes. Every row must carry the
// full key set so aggregation across a history is possible at all.
// `author_engine` is carried, not merely consumed: a reader that cannot see the
// author cannot recompute intra_family_debate, and cannot separate "the two
// debaters agreed on a family that is not the author's" from "everyone,
// including the author, is in one family". Both collapse; the field says which.
const CANONICAL_KEYS = [
  'ts', 'event', 'milestone', 'slice', 'style', 'rounds', 'counts',
  'conceded_fixed', 'engine', 'author_engine', 'challenger', 'advocate',
  'intra_family_debate', 'intra_family_withdrawn',
];
const minimal = buildReviewEvent(base);
assert.strictEqual(minimal.errors.length, 0, 'minimal invocation is valid');
assert.deepStrictEqual(Object.keys(minimal.event), CANONICAL_KEYS, 'full key set, fixed order');
assert.deepStrictEqual(minimal.event.counts, { resolved: 0, conceded: 0, open: 0 });

// ── intra_family_debate is derived, not asserted ────────────────────────────
// The M134/S02 case: gpt author, challenger collapsed to claude, advocate
// collapsed to claude. Both debaters in one family, neither in the author's.
const s02 = buildReviewEvent({
  ...base, authorEngine: 'codex', challenger: 'claude', advocate: 'opus',
});
assert.strictEqual(s02.event.intra_family_debate, true, 'gpt author + two claude debaters');

// The S01 case: claude author, gpt challenger, claude advocate. Cross-family
// in the direction that matters — not intra-family.
const s01 = buildReviewEvent({
  ...base, authorEngine: 'claude', challenger: 'codex', advocate: 'fable',
});
assert.strictEqual(s01.event.intra_family_debate, false, 'cross-family challenger');

// A claude author, challenged by claude, defended by claude: one family holds
// all three roles. This is the SHIPPED default (`challenger: claude`,
// `advocate: claude`, and an explicit path that assumes a claude author), and
// it IS the collapse — the challenge carries the author's own family bias,
// which is the whole reason M006 wants the challenger cross-family. Excusing it
// as "the author is in that family too" would pin the flag at false on every
// review of every default-configured project: the same silence this emitter
// exists to end, re-entering through the derivation.
const allClaude = buildReviewEvent({
  ...base, authorEngine: 'claude', challenger: 'claude', advocate: 'fable',
});
assert.strictEqual(allClaude.event.intra_family_debate, true, 'shipped defaults collapse too');
assert.strictEqual(allClaude.event.author_engine, 'claude', 'author recorded, not just consumed');

// The same shape one family over — the flag is not Claude-specific.
const gptOnly = buildReviewEvent({
  ...base, authorEngine: 'codex', challenger: 'codex', advocate: 'gpt-5.6-sol',
});
assert.strictEqual(gptOnly.event.intra_family_debate, true, 'collapse is family-agnostic');

// Forward guard for --mode defend, on the exact case where the original bash
// inverted: a gpt author DEFENDED by gpt (the designed pairing) and challenged
// by claude is a genuine cross-family debate. `$ADVOCATE_FAMILY != $AUTHOR_ENGINE`
// read 'gpt' != 'codex' → true and would have condemned this healthy pairing as
// a collapse. Comparing family to family gets it right.
const gptDefend = buildReviewEvent({
  ...base, authorEngine: 'codex', challenger: 'claude', advocate: 'gpt-5.6-sol',
});
assert.strictEqual(
  gptDefend.event.intra_family_debate, false,
  'family-vs-family comparison survives a gpt advocate'
);
assert.strictEqual(familyOf('codex'), 'gpt');
assert.strictEqual(familyOf('gpt-5.6-sol'), 'gpt');
assert.strictEqual(familyOf('fable'), 'claude');
assert.strictEqual(familyOf(''), null);

// ── An author it cannot resolve is refused, never defaulted to `false` ───────
// `false` reads as "measured, no collapse". Deriving it from an author the
// emitter could not identify would publish that claim without the measurement —
// the failure this file exists to make impossible, aimed at the flag itself.
const noAuthor = buildReviewEvent({
  milestone: 'M134', slice: 'S02', challenger: 'claude', advocate: 'fable',
});
assert.ok(
  noAuthor.errors.some((e) => /--author-engine is required/.test(e)),
  'a missing author is an error, not a silent false'
);
const unknownAuthor = buildReviewEvent({ ...base, authorEngine: 'banana' });
assert.ok(
  unknownAuthor.errors.some((e) => /did not resolve to a known family/.test(e)),
  'an unrecognized author is an error, not a silent false'
);
// And the refusal reaches the process: exit 2, nothing appended.
const refusedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-emit-refuse-'));
let refusedStatus = 0;
try {
  execFileSync(process.execPath, [CLI, '--cwd', refusedDir, '--milestone', 'M1', '--slice', 'S1'], {
    stdio: 'pipe',
  });
} catch (err) {
  refusedStatus = err.status;
}
assert.strictEqual(refusedStatus, 2, 'CLI exits 2 without an author engine');
assert.strictEqual(
  fs.existsSync(path.join(refusedDir, '.gsd', 'forge', 'events.jsonl')), false,
  'a refused invocation writes no row at all'
);

// ── The withdrawn count cannot contradict the flag ──────────────────────────
const clamped = buildReviewEvent({
  ...base, authorEngine: 'claude', challenger: 'codex', advocate: 'fable',
  intraFamilyWithdrawn: 4,
});
assert.strictEqual(clamped.event.intra_family_withdrawn, 0, 'clamped when not intra-family');
const kept = buildReviewEvent({
  ...base, authorEngine: 'codex', challenger: 'claude', advocate: 'opus',
  intraFamilyWithdrawn: 4,
});
assert.strictEqual(kept.event.intra_family_withdrawn, 4, 'kept when intra-family');

// ── Prose in the advocate field is refused ──────────────────────────────────
// Real rows found in production: "not-invoked-orchestrator-verified-by-direct-reading"
// and "claude-main-context". Those describe what the orchestrator did INSTEAD of
// running the advocate. An advocate that did not run is null; it is never a story.
const prose = buildReviewEvent({
  ...base, advocate: 'not-invoked orchestrator verified by direct reading',
});
assert.ok(prose.errors.length > 0, 'prose advocate rejected');
assert.strictEqual(buildReviewEvent({ ...base, advocate: '' }).event.advocate, null);
assert.strictEqual(buildReviewEvent({ ...base, advocate: 'null' }).event.advocate, null);
assert.strictEqual(buildReviewEvent({ ...base, advocate: 'fable' }).event.advocate, 'fable');

// ── Caller mistakes fail loudly ─────────────────────────────────────────────
assert.ok(buildReviewEvent({ slice: 'S02' }).errors.length > 0, 'milestone required');
assert.ok(buildReviewEvent({ milestone: 'M134' }).errors.length > 0, 'slice required');
assert.ok(buildReviewEvent({ ...base, style: 'freeform' }).errors.length > 0, 'style enum');
assert.ok(buildReviewEvent({ ...base, engine: 'inline' }).errors.length > 0, 'engine enum');
assert.ok(buildReviewEvent({ ...base, challenger: 'opus' }).errors.length > 0, 'challenger enum');
assert.ok(buildReviewEvent({ ...base, rounds: 9 }).errors.length > 0, 'rounds clamped range');
assert.ok(buildReviewEvent({ ...base, open: -1 }).errors.length > 0, 'counts non-negative');
assert.ok(
  buildReviewEvent({ ...base, conceded: 2, concededFixed: 5 }).errors.length > 0,
  'cannot fix more than were conceded'
);

// ── Companion unavailable event ─────────────────────────────────────────────
const un = buildUnavailableEvent({ ...base, unavailableReason: 'review-advocate-unavailable', attempts: 2 });
assert.strictEqual(un.errors.length, 0);
assert.strictEqual(un.event.event, 'review-agent-unavailable');
assert.strictEqual(un.event.attempts, 2);
assert.ok(buildUnavailableEvent({ ...base, unavailableReason: 'nope' }).errors.length > 0);

// ── Append is real JSONL a reader can parse back ────────────────────────────
const f = path.join(dir, 'events.jsonl');
appendEvents(f, [minimal.event, s02.event]);
const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.strictEqual(rows.length, 2);
assert.strictEqual(rows[1].intra_family_debate, true);

// ── CLI contract: exit 2 on malformed, 0 on valid, and --dry-run writes nothing
const run = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};
const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-emit-cli-'));
assert.strictEqual(run(['--cwd', cliDir, '--slice', 'S02']).code, 2, 'missing milestone → exit 2');
assert.strictEqual(
  fs.existsSync(path.join(cliDir, '.gsd', 'forge', 'events.jsonl')), false,
  'a refused invocation writes no row'
);
const dry = run([
  '--cwd', cliDir, '--milestone', 'M134', '--slice', 'S02',
  '--author-engine', 'claude', '--dry-run', '--json',
]);
assert.strictEqual(dry.code, 0);
assert.strictEqual(fs.existsSync(path.join(cliDir, '.gsd', 'forge', 'events.jsonl')), false, 'dry-run writes nothing');
const wrote = run([
  '--cwd', cliDir, '--milestone', 'M134', '--slice', 'S02',
  '--author-engine', 'codex', '--challenger', 'claude', '--advocate', 'opus',
  '--conceded', '4', '--conceded-fixed', '4', '--open', '1', '--json',
]);
assert.strictEqual(wrote.code, 0);
const cliRow = JSON.parse(
  fs.readFileSync(path.join(cliDir, '.gsd', 'forge', 'events.jsonl'), 'utf8').trim()
);
assert.deepStrictEqual(Object.keys(cliRow), CANONICAL_KEYS, 'CLI writes the canonical shape');
assert.strictEqual(cliRow.intra_family_debate, true, 'CLI derives the flag too');

// The emitter's rows must satisfy the audit's own reader without special-casing.
const { audit } = require('./forge-review-audit.js');
assert.ok(Array.isArray(audit(path.join(cliDir, '.gsd', 'forge', 'events.jsonl'), cliDir).drifts));

// ── --efforts-json: optional, closed, never a claim of applied effort ───────
// Absent flag → the row is byte-identical to the historical one.
const effortsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-emit-efforts-'));
const rowArgs = ['--milestone', 'M134', '--slice', 'S02', '--author-engine', 'codex', '--challenger', 'claude',
  '--advocate', 'opus', '--ts', '2026-09-30T00:00:00Z'];
const eventsOf = (cwd) => path.join(cwd, '.gsd', 'forge', 'events.jsonl');
const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-emit-legacy-'));
assert.strictEqual(run(['--cwd', legacyDir, ...rowArgs]).code, 0);
const legacyBytes = fs.readFileSync(eventsOf(legacyDir), 'utf8');
assert.deepStrictEqual(Object.keys(JSON.parse(legacyBytes)), CANONICAL_KEYS, 'no efforts key without the flag');
const legacyAgainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-emit-legacy2-'));
assert.strictEqual(run(['--cwd', legacyAgainDir, ...rowArgs]).code, 0);
assert.strictEqual(fs.readFileSync(eventsOf(legacyAgainDir), 'utf8'), legacyBytes, 'absent flag keeps the row byte-identical');

const efforts = {
  challenge: { requested: 'high', resolved: 'high', sent: 'high', applied: null, reason: 'review.challenge_effort', diagnostics: [] },
  defense: { requested: 'high', resolved: 'medium', sent: 'agent-frontmatter:medium', applied: null,
    reason: 'review.defense_effort', diagnostics: [{ code: 'effort-clamped-by-policy' }] },
  fix: { requested: 'medium', resolved: 'medium', sent: 'medium', applied: null, reason: 'unit-type:review-fix', diagnostics: [] },
};
assert.strictEqual(run(['--cwd', effortsDir, ...rowArgs, '--efforts-json', JSON.stringify(efforts)]).code, 0);
const effortsRow = JSON.parse(fs.readFileSync(eventsOf(effortsDir), 'utf8').trim());
assert.deepStrictEqual(Object.keys(effortsRow), [...CANONICAL_KEYS, 'efforts'], 'efforts is appended, never reorders');
assert.deepStrictEqual(effortsRow.efforts, efforts);
for (const key of CANONICAL_KEYS.filter((key) => key !== 'ts')) {
  assert.deepStrictEqual(effortsRow[key], JSON.parse(legacyBytes)[key], `efforts leaves ${key} untouched`);
}

// Malformed payloads exit 2 and write nothing.
const malformedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-emit-malformed-'));
for (const payload of [
  '{not json',
  JSON.stringify({ judge: efforts.challenge }),
  JSON.stringify({ challenge: { ...efforts.challenge, applied: 'high' } }),
  JSON.stringify({ challenge: { ...efforts.challenge, extra: 1 } }),
  JSON.stringify({ challenge: { requested: 'high' } }),
  JSON.stringify({ challenge: { ...efforts.challenge, requested: 'ultra' } }),
  JSON.stringify({ challenge: { ...efforts.challenge, diagnostics: ['free text'] } }),
]) {
  const refused = run(['--cwd', malformedDir, ...rowArgs, '--efforts-json', payload]);
  assert.strictEqual(refused.code, 2, `malformed efforts must exit 2: ${payload}`);
  assert.strictEqual(fs.existsSync(eventsOf(malformedDir)), false, `malformed efforts wrote a row: ${payload}`);
}

console.log('forge-review-emit tests passed');
