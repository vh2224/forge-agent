#!/usr/bin/env node
'use strict';

/**
 * Paired suite for forge-evidence-admit.js.
 *
 * Every guard here is proven in BOTH directions — a green assertion that would
 * stay green after the guard is deleted proves nothing. Concretely: each bite
 * test pairs a "clean input passes" case with a "mutated input fails, NAMING
 * the divergence" case, because naming is the whole difference between a
 * usable failure and an archaeology trip.
 *
 * Fixtures are written to os.tmpdir(), never process.cwd(): the real pin is
 * never edited to test drift (a test that mutates the artifact it audits can
 * leave the repo poisoned on failure), and stray fixtures in the repo would be
 * unioned into the run's touches by S07's `forge-touch --record`.
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const admit = require('./forge-evidence-admit');

const SCRIPT = path.join(__dirname, 'forge-evidence-admit.js');
const REAL_PIN = path.join(__dirname, '..', 'shared', 'schemas', 'codex-appserver-pin.json');

let assertions = 0;
function check(condition, message) {
  assertions += 1;
  assert(condition, message);
}
function equal(actual, expected, message) {
  assertions += 1;
  assert.deepStrictEqual(actual, expected, message);
}
function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `forge-evidence-admit-${label}-`));
}
function runCli(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

// ── Fixture builders ───────────────────────────────────────────────────────

function pinVariant(name) {
  return {
    title: `${name}ThreadItem`,
    type: 'object',
    required: ['type', 'id'],
    properties: { id: { type: 'string' }, type: { enum: [name], type: 'string' } },
  };
}
function pinWith(names) {
  // meta.variant_count deliberately tracks oneOf.length so the coverage
  // comparison is what fails — not the pin's internal-consistency check. The
  // inconsistency case is exercised separately below.
  return { meta: { codex_version: 'fixture', variant_count: names.length }, definitions: { ThreadItem: { oneOf: names.map(pinVariant) } } };
}
function writePin(dir, names) {
  const file = path.join(dir, 'pin.json');
  fs.writeFileSync(file, JSON.stringify(pinWith(names), null, 2));
  return file;
}
function realVariantNames() {
  return admit.pinVariantNames(JSON.parse(fs.readFileSync(REAL_PIN, 'utf8')));
}
function docTable(rows) {
  const lines = [
    '# fixture',
    '',
    admit.DOC_SECTION_HEADING,
    '',
    '| Variante | Veredito | Razão |',
    '|---|---|---|',
    ...rows.map((r) => `| \`${r.name}\` | ${r.verdict} | ${r.reason} |`),
    '',
    '## Outra seção',
    '',
    '| Variante | Veredito | Razão |',
    '|---|---|---|',
    '| `naoDeveSerLido` | admissível | ruído fora da seção |',
    '',
  ];
  return lines.join('\n');
}
function goodDocRows() {
  return Object.keys(admit.VARIANT_ADMISSIBILITY).map((name) => ({
    name,
    verdict: admit.VARIANT_ADMISSIBILITY[name].admissible ? 'admissível' : 'inadmissível',
    reason: `${admit.VARIANT_ADMISSIBILITY[name].reason} — ${admit.VARIANT_ADMISSIBILITY[name].note}`,
  }));
}

// ── 1. Classification by name, exact contract shapes ───────────────────────

function testClassification() {
  // Strict equality, not property spot-checks: the returned shape IS the
  // contract T02/T03 consume, so an extra key is a breaking change.
  equal(admit.classifyThreadItem({ type: 'agentMessage' }),
    { admissible: false, known: true, reason: 'model-authored' },
    'agentMessage is model-authored and inadmissible');
  equal(admit.classifyThreadItem({ type: 'commandExecution' }),
    { admissible: true, known: true },
    'commandExecution is admissible and carries no reason key');
  equal(admit.classifyThreadItem({ type: 'fileChange' }),
    { admissible: true, known: true },
    'fileChange is admissible');
  equal(admit.classifyThreadItem({ type: 'quantumThing' }),
    { admissible: false, known: false, reason: 'unknown-variant' },
    'an unclassified variant is REJECTED, never passed through');

  // Malformed items must not throw and must not be admitted by accident.
  for (const bad of [null, undefined, {}, { type: 42 }, 'agentMessage']) {
    equal(admit.classifyThreadItem(bad),
      { admissible: false, known: false, reason: 'unknown-variant' },
      `malformed item ${JSON.stringify(bad)} is unknown, not admitted`);
  }

  // Exactly 2 of 18 admissible — and by NAME, so a future edit that flips a
  // model-authored variant to admissible fails here rather than in production.
  equal(admit.ADMISSIBLE_TYPES.slice().sort(), ['commandExecution', 'fileChange'],
    'exactly commandExecution and fileChange are admissible');
  equal(Object.keys(admit.VARIANT_ADMISSIBILITY).length, 18, 'the map classifies 18 variants');
  for (const name of Object.keys(admit.VARIANT_ADMISSIBILITY)) {
    const entry = admit.VARIANT_ADMISSIBILITY[name];
    check(typeof entry.reason === 'string' && entry.reason.length > 0, `${name} has an explicit reason`);
    check(typeof entry.note === 'string' && entry.note.length > 0, `${name} has an explicit note`);
    check(Object.values(admit.REASONS).includes(entry.reason), `${name} uses the closed reason vocabulary`);
  }
}

// ── 2. The anti-silence floor: collected-and-empty ≠ not-collected ─────────

function testCollectedAndEmpty() {
  const onlyModelAuthored = [
    { type: 'agentMessage', text: 'I ran the tests and they all pass.' },
    { type: 'reasoning', summary: 'looks right' },
    { type: 'plan', text: 'step 1' },
  ];
  const result = admit.buildRuntimeEvidence(onlyModelAuthored, { unit: 'execute-task/T02', now: '2026-08-06T00:00:00.000Z' });

  equal(result.entries, [], 'model-authored items produce zero entries');
  equal(result.census.outcome, 'collected', 'the collector ran, so the outcome is collected');
  equal(result.census.admitted, 0, 'nothing was admitted');
  equal(result.census.items_received, 3, 'but three items WERE received — the census says so');
  equal(result.census.inadmissible, 3, 'all three counted as inadmissible');
  check(result.census.outcome !== 'not-collected', 'collected-and-empty must NEVER render as not-collected');
  check(result.census.outcome !== 'collector-failed', 'collected-and-empty must NEVER render as collector-failed');

  // The empty input is the sharpest form of the same floor.
  const empty = admit.buildRuntimeEvidence([], { unit: 'execute-task/T02' });
  equal(empty.census.outcome, 'collected', 'an empty stream is still COLLECTED, just empty');
  equal(empty.census.admitted, 0, 'admitted 0');
  equal(empty.census.items_received, 0, 'items_received 0');
  equal(empty.entries, [], 'no entries');

  // Bite in the other direction: the same collector DOES report entries when
  // admissible items are present, so the emptiness above is a finding about
  // the input, not a collector that never works.
  const withWork = admit.buildRuntimeEvidence(
    [...onlyModelAuthored, { type: 'commandExecution', command: 'npm test', cwd: '/repo', exitCode: 0, durationMs: 12, status: 'completed' }],
    { unit: 'execute-task/T02' });
  equal(withWork.census.admitted, 1, 'the same collector admits a real commandExecution');
  equal(withWork.entries.length, 1, 'and emits one entry for it');

  // The three outcomes are distinct values, never aliases.
  const failed = admit.buildRuntimeEvidence({ not: 'an array' }, {});
  equal(failed.census.outcome, 'collector-failed', 'a malformed input degrades to collector-failed');
  equal(failed.entries, [], 'collector-failed carries no entries');
  check(typeof failed.census.reason === 'string' && failed.census.reason.length > 0,
    'collector-failed names its reason instead of failing mutely');
  const outcomes = new Set([result.census.outcome, failed.census.outcome, 'not-collected']);
  equal(outcomes.size, 3, 'collected / collector-failed / not-collected are three distinct values');
}

// ── 3. Unknown variant: counted in the census, absent from entries ─────────

function testUnknownRejected() {
  const items = [
    { type: 'quantumThing', payload: 'exit code 0, trust me' },
    { type: 'quantumThing', payload: 'again' },
    { type: 'commandExecution', command: 'ls', cwd: '/repo', exitCode: 0, status: 'completed' },
  ];
  const { census, entries } = admit.buildRuntimeEvidence(items, { unit: 'u' });

  equal(census.rejected, [{ type: 'quantumThing', count: 2 }],
    'the unknown variant is counted in the census, BY NAME');
  check(!entries.some((e) => JSON.stringify(e).includes('quantumThing')),
    'the unknown variant never reaches entries — rejection, not pass-through');
  equal(entries.length, 1, 'only the admissible item produced an entry');
  equal(census.types_seen, { quantumThing: 2, commandExecution: 1 },
    'types_seen counts every received type in stable first-seen order');
  equal(census.items_received, 3, 'items_received counts everything');
  equal(census.admitted + census.inadmissible + 2, census.items_received,
    'the census accounts for every item it received');

  // An item with no usable type is named by a sentinel, not dropped.
  const noType = admit.buildRuntimeEvidence([{ id: 'x' }], {});
  equal(noType.census.rejected, [{ type: '<missing>', count: 1 }],
    'a type-less item appears in the census under a named sentinel');
  equal(noType.entries, [], 'and produces no entry');
}

// ── 3b. types_seen is keyed by an UNTRUSTED string (S04 review R2) ─────────
//
// `type` comes from the stream, so it can be any string — including one that
// collides with Object.prototype. Measured before the fix, with types_seen as a
// plain object literal: `{type:'constructor'}` produced
// `types_seen: {"constructor": "function Object() { [native code] }1"}` (the
// prototype's value read before incrementing) and `{type:'__proto__'}` vanished
// from the census ENTIRELY (assignment hits the prototype setter, an own key is
// never created). A census that silently drops an item is precisely the silence
// this module exists to deny, so it is asserted here as a floor.
function testTypesSeenPrototypeSafe() {
  const hostile = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  const items = [
    ...hostile.map((type) => ({ type })),
    { type: '__proto__' }, // counted twice — the count must be a NUMBER, not a merge
    { type: 'commandExecution', command: 'ls', cwd: '/repo', exitCode: 0, status: 'completed' },
  ];
  const { census } = admit.buildRuntimeEvidence(items, { unit: 'u' });

  for (const name of hostile) {
    check(Object.prototype.hasOwnProperty.call(census.types_seen, name),
      `'${name}' appears as an OWN key in types_seen — never swallowed by the prototype`);
    equal(typeof census.types_seen[name], 'number',
      `'${name}' counts to a number, not a value inherited from Object.prototype`);
  }
  equal(census.types_seen.__proto__, 2, 'a repeated prototype-colliding name increments like any other'); // eslint-disable-line no-proto
  equal(census.types_seen.constructor, 1, 'constructor counts from 1, not from the prototype\'s function');

  // The census must still add up, and must still survive JSON — the artefact a
  // human reads is the serialised form, not the object.
  const rejectedTotal = census.rejected.reduce((sum, r) => sum + r.count, 0);
  equal(census.admitted + census.inadmissible + rejectedTotal, census.items_received,
    'the identity holds over prototype-colliding names too');
  const roundTripped = JSON.parse(JSON.stringify(census.types_seen));
  for (const name of hostile) {
    check(Object.prototype.hasOwnProperty.call(roundTripped, name), `'${name}' survives JSON round-trip`);
  }
  equal(Object.keys(census.types_seen).length, hostile.length + 1, 'every distinct received type is keyed exactly once');

  // Bite proof for the fixture: a plain object literal — the shape this
  // replaced — genuinely mishandles the same input, so the assertions above
  // are measuring a real hazard rather than a hypothetical one.
  const naive = {};
  for (const item of items) naive[item.type] = (naive[item.type] || 0) + 1;
  check(!Object.prototype.hasOwnProperty.call(naive, '__proto__'),
    'the naive plain-object counter really does lose __proto__ — the defect is reproducible');
  check(typeof naive.constructor !== 'number',
    'and really does read the prototype for constructor');

  // The collector-failed path reports the partial census, with the same floor.
  const failed = admit.buildRuntimeEvidence('not-an-array', {});
  equal(failed.census.outcome, 'collector-failed', 'a non-array input degrades, never throws');
  equal(typeof failed.census.types_seen, 'object', 'and still carries a types_seen object');
}

// ── 4. Entry shape: source and ts, asserted by strict equality ─────────────

function testEntryShape() {
  const items = [
    { type: 'commandExecution', command: 'npm test', cwd: '/repo', exitCode: 0, durationMs: 812, status: 'completed' },
    { type: 'commandExecution', command: 'flaky', cwd: '/repo', exitCode: null, status: 'failed' },
    { type: 'fileChange', status: 'completed', changes: [
      { path: 'scripts/a.js', kind: 'update' },
      { path: 'scripts/b.js', kind: 'add' },
    ] },
  ];
  const { census, entries } = admit.buildRuntimeEvidence(items, { unit: 'execute-task/T02', now: '2026-08-06T12:00:00.000Z' });

  equal(census.admitted, 3, 'admitted counts ITEMS (3), not entries');
  equal(entries.length, 4, 'one entry per commandExecution, one per changes[] element');

  for (const entry of entries) {
    // Strict equality on source: the whole point of the new value is that a
    // filter can separate runtime-observed lines from the legacy synthesized
    // ones by `===`, so anything but this exact string breaks T03's contract.
    equal(entry.source, 'codex-runtime', 'every entry is marked codex-runtime');
    check(entry.source !== 'codex-sidecar', 'no entry may carry the synthesized-line marker');
    check(typeof entry.ts === 'string', 'ts is a string, not an epoch number like the hook writes');
    equal(entry.ts, new Date(entry.ts).toISOString(), 'ts is a round-trippable ISO timestamp');
    equal(entry.unit, 'execute-task/T02', 'the unit is carried through');
  }

  equal(entries[0], {
    ts: '2026-08-06T12:00:00.000Z', source: 'codex-runtime', kind: 'command', unit: 'execute-task/T02',
    cmd: 'npm test', cwd: '/repo', exit_code: 0, duration_ms: 812, status: 'completed',
  }, 'command entry shape is exactly the locked contract');

  // exit_code: null is an OBSERVED VALUE. If someone "helpfully" defaults it to
  // 0, this test turns red — which is the point, because that edit would
  // manufacture a success nothing measured.
  equal(entries[1].exit_code, null, 'a null exitCode stays null and is NEVER coerced to 0');
  check(entries[1].exit_code !== 0, 'null must not become a passing exit code');
  equal(entries[1].duration_ms, null, 'an absent durationMs is null, not 0');

  equal(entries[2], {
    ts: '2026-08-06T12:00:00.000Z', source: 'codex-runtime', kind: 'file', unit: 'execute-task/T02',
    file: 'scripts/a.js', change_kind: 'update', status: 'completed',
  }, 'file entry shape is exactly the locked contract');
  equal(entries[3].file, 'scripts/b.js', 'the second change gets its own entry');

  // Truncation at 200 chars for cmd/file (the 512B line cap belongs to T03).
  const long = admit.buildRuntimeEvidence(
    [{ type: 'commandExecution', command: 'x'.repeat(500), cwd: '/repo', exitCode: 0, status: 'completed' }], {});
  equal(long.entries[0].cmd.length, admit.MAX_FIELD_CHARS, 'cmd is truncated to 200 chars');

  // turn_status is recorded raw (S02 R15) and defaults to null, not to a
  // fabricated "completed".
  equal(admit.buildRuntimeEvidence([], {}).census.turn_status, null, 'no observed turn status is null');
  equal(admit.buildRuntimeEvidence([], { turnStatus: 'completed' }).census.turn_status, 'completed',
    'an observed turn status is recorded raw');
}

// ── 5. --check-schema against the real pin, and bite in both directions ────

function testCheckSchema() {
  const clean = runCli(['--check-schema', '--json']);
  equal(clean.status, 0, `--check-schema must pass against the real pin (stderr: ${clean.stderr})`);
  const payload = JSON.parse(clean.stdout);
  equal(payload.ok, true, 'ok:true against the real pin');
  equal(payload.variants, 18, 'the pin declares 18 variants');
  equal(payload.admissible, 2, 'exactly 2 are admissible');
  equal(payload.inadmissible, 16, 'the other 16 are inadmissible');
  equal(payload.meta_variant_count, 18, 'meta.variant_count agrees with oneOf.length');

  const names = realVariantNames();
  equal(names.length, 18, 'names are read from the pin, not hardcoded here');
  equal(names.slice().sort(), Object.keys(admit.VARIANT_ADMISSIBILITY).sort(),
    'the map covers exactly the pin\'s variant names');

  const dir = tempDir('pin');

  // Direction A — a variant REMOVED from the pin (17) must fail, naming it.
  const removed = names.filter((n) => n !== 'sleep');
  const shortPin = writePin(dir, removed);
  const shortRun = runCli(['--check-schema', '--json', '--pin', shortPin]);
  check(shortRun.status !== 0, 'a 17-variant pin must fail');
  const shortPayload = JSON.parse(shortRun.stdout);
  equal(shortPayload.ok, false, 'ok:false for the 17-variant pin');
  equal(shortPayload.missing_in_pin, ['sleep'], 'the failure NAMES the absent variant, not just a count');
  check(shortRun.stderr.includes('sleep'), 'stderr names the divergent variant too');

  // Direction B — a variant ADDED upstream (19) must fail, naming it. This is
  // the case that matters most: an unclassified variant must never slide in.
  const longPin = writePin(dir, [...names, 'quantumThing']);
  const longRun = runCli(['--check-schema', '--json', '--pin', longPin]);
  check(longRun.status !== 0, 'a 19-variant pin must fail');
  const longPayload = JSON.parse(longRun.stdout);
  equal(longPayload.missing_in_map, ['quantumThing'], 'the failure NAMES the unclassified variant');

  // Control: the fixture builder itself produces a PASSING pin when the names
  // match, proving the two failures above come from the mutation and not from
  // the fixture format being unreadable.
  const controlPin = writePin(tempDir('control'), names);
  equal(runCli(['--check-schema', '--pin', controlPin]).status, 0,
    'an unmutated fixture pin passes — the bite comes from the mutation, not the fixture');

  // A pin that disagrees with ITSELF is a pin defect and must surface.
  const inconsistent = path.join(dir, 'inconsistent.json');
  const body = pinWith(names);
  body.meta.variant_count = 19;
  fs.writeFileSync(inconsistent, JSON.stringify(body));
  const incRun = runCli(['--check-schema', '--pin', inconsistent]);
  check(incRun.status !== 0, 'meta.variant_count disagreeing with oneOf.length is a failure');
  check(/internally inconsistent/.test(incRun.stderr), 'and it says the pin is internally inconsistent');

  // Anti-silence: a pin with zero variants is a failure, never a clean pass.
  const emptyPin = writePin(tempDir('empty'), []);
  const emptyRun = runCli(['--check-schema', '--pin', emptyPin]);
  check(emptyRun.status !== 0, 'a pin yielding 0 variants must FAIL, not pass vacuously');
  check(/anti-silence/.test(emptyRun.stderr), 'and it says so by name');

  // A DUPLICATE discriminator is the pin contradicting itself too (S04 review
  // R3). It has to fail HERE, because every later comparison is set-based: all
  // 18 names plus a repeat passes coverage, and passes the count check as well
  // (pinWith derives variant_count from the same array — exactly as
  // forge-schema-pin does), while `variants` and the admissible/inadmissible
  // totals it reports overstate reality.
  const dupPin = writePin(tempDir('dup'), [...names, 'sleep']);
  const dupRun = runCli(['--check-schema', '--json', '--pin', dupPin]);
  check(dupRun.status !== 0, 'a pin with a duplicate discriminator must FAIL');
  const dupPayload = JSON.parse(dupRun.stdout);
  equal(dupPayload.ok, false, 'ok:false for the duplicated pin');
  equal(dupPayload.code, 'PIN_SHAPE_CHANGED', 'reported under the code the module already owns for pin-vs-itself');
  check(dupRun.stderr.includes('sleep'), 'the failure NAMES the duplicated discriminator, not just a count');
  // Bite proof for the fixture: the same builder without the repeat passes, so
  // the failure comes from the duplication and not from the 19-item shape.
  equal(runCli(['--check-schema', '--pin', writePin(tempDir('dup-control'), names)]).status, 0,
    'the same fixture without the repeat passes — the bite is the duplicate');

  // Arg guards: a malformed invocation exits 2, distinct from exit 1.
  equal(runCli(['--nope']).status, 2, 'an unknown flag exits 2');
  equal(runCli([]).status, 2, 'no mode exits 2');
  equal(runCli(['--check-doc']).status, 2, '--check-doc without a path exits 2');
  check(runCli(['--nope']).stderr.startsWith('forge-evidence-admit:'), 'CLI errors are prefixed');

  // Contradictory modes and mode-specific options are REJECTED (S04 review R4).
  // Before: `--check-schema --check-doc x` resolved by last-wins and `--pin` was
  // silently ignored in doc mode — the CLI answering a question nobody asked
  // while the exit code named neither. Both argv orders are asserted, because
  // order is the caller's choice and a one-sided guard is half a guard.
  const someDoc = path.join(tempDir('args'), 'd.md');
  fs.writeFileSync(someDoc, `${admit.DOC_SECTION_HEADING}\n`);
  equal(runCli(['--check-schema', '--check-doc', someDoc]).status, 2, 'mixed modes exit 2 (schema first)');
  equal(runCli(['--check-doc', someDoc, '--check-schema']).status, 2, 'mixed modes exit 2 (doc first)');
  equal(runCli(['--check-doc', someDoc, '--pin', controlPin]).status, 2, '--pin outside schema mode exits 2 (after)');
  equal(runCli(['--pin', controlPin, '--check-doc', someDoc]).status, 2, '--pin outside schema mode exits 2 (before)');
  check(/mutually exclusive/.test(runCli(['--check-schema', '--check-doc', someDoc]).stderr),
    'and the mixed-mode error says why');
  check(/only valid with --check-schema/.test(runCli(['--check-doc', someDoc, '--pin', controlPin]).stderr),
    'and the misplaced-option error names the mode it belongs to');
  // Reverse direction: the legitimate invocations are untouched.
  equal(runCli(['--check-schema', '--pin', controlPin]).status, 0, '--pin WITH --check-schema still works');
  equal(runCli(['--check-schema', '--json']).status, 0, 'plain --check-schema still works');
}

// ── 6. --check-doc: bite in both directions, plus the anti-silence floor ───

function testCheckDoc() {
  const dir = tempDir('doc');
  const goodFile = path.join(dir, 'good.md');
  fs.writeFileSync(goodFile, docTable(goodDocRows()));

  const good = runCli(['--check-doc', goodFile, '--json']);
  equal(good.status, 0, `a coherent 18-row table passes (stdout: ${good.stdout})`);
  const goodPayload = JSON.parse(good.stdout);
  equal(goodPayload.ok, true, 'ok:true for the coherent table');
  equal(goodPayload.parsed, 18, 'exactly the 18 in-section rows are parsed — the out-of-section table is ignored');

  // Direction A — mutate ONE verdict; must fail naming that variant.
  const mutatedRows = goodDocRows().map((r) => (r.name === 'fileChange' ? { ...r, verdict: 'inadmissível' } : r));
  const mutatedFile = path.join(dir, 'mutated.md');
  fs.writeFileSync(mutatedFile, docTable(mutatedRows));
  const mutated = runCli(['--check-doc', mutatedFile, '--json']);
  check(mutated.status !== 0, 'a mutated verdict must fail');
  const mutatedPayload = JSON.parse(mutated.stdout);
  equal(mutatedPayload.ok, false, 'ok:false for the mutated table');
  check(mutatedPayload.problems.some((p) => p.variant === 'fileChange' && p.kind === 'verdict-mismatch'),
    'the failure NAMES the divergent variant');
  check(!mutatedPayload.problems.some((p) => p.variant === 'commandExecution'),
    'and does not smear onto rows that are still correct');

  // Direction B — the same file, un-mutated, passes again. Without this the
  // test above could be green for any reason at all.
  equal(runCli(['--check-doc', goodFile]).status, 0, 'restoring the verdict makes it pass again');

  // A dropped row is a failure naming the missing variant.
  const droppedFile = path.join(dir, 'dropped.md');
  fs.writeFileSync(droppedFile, docTable(goodDocRows().filter((r) => r.name !== 'webSearch')));
  const dropped = JSON.parse(runCli(['--check-doc', droppedFile, '--json']).stdout);
  check(dropped.problems.some((p) => p.variant === 'webSearch' && p.kind === 'missing-row'),
    'an omitted row is named, never silently tolerated');

  // A renamed row must NOT vanish into silence: it is both unknown and missing.
  const renamedFile = path.join(dir, 'renamed.md');
  fs.writeFileSync(renamedFile, docTable(goodDocRows().map((r) => (r.name === 'sleep' ? { ...r, name: 'slumber' } : r))));
  const renamed = JSON.parse(runCli(['--check-doc', renamedFile, '--json']).stdout);
  check(renamed.problems.some((p) => p.variant === 'slumber' && p.kind === 'unknown-variant'),
    'a renamed row is reported as unknown');
  check(renamed.problems.some((p) => p.variant === 'sleep' && p.kind === 'missing-row'),
    'and the variant it displaced is reported as missing');

  // A verdict with no reason is an omission — exactly what D7 forbids.
  const noReasonFile = path.join(dir, 'no-reason.md');
  fs.writeFileSync(noReasonFile, docTable(goodDocRows().map((r) => (r.name === 'plan' ? { ...r, reason: '' } : r))));
  const noReason = JSON.parse(runCli(['--check-doc', noReasonFile, '--json']).stdout);
  check(noReason.problems.some((p) => p.variant === 'plan' && (p.kind === 'missing-reason' || p.kind === 'reason-mismatch')),
    'a row stating a verdict without a reason fails by name');

  // Anti-silence floor: a document with no such section parses 0 rows and must
  // FAIL. "Found no divergences" and "read nothing" must never coincide.
  const emptyFile = path.join(dir, 'empty.md');
  fs.writeFileSync(emptyFile, '# nothing here\n\nsome prose\n');
  const emptyRun = runCli(['--check-doc', emptyFile, '--json']);
  check(emptyRun.status !== 0, 'a document without the section FAILS, it does not pass clean');
  const emptyPayload = JSON.parse(emptyRun.stdout);
  equal(emptyPayload.parsed, 0, 'zero rows parsed');
  check(emptyPayload.problems.some((p) => p.kind === 'anti-silence'), 'and the reason is named anti-silence');

  // An unreadable file is an error, not a pass.
  check(runCli(['--check-doc', path.join(dir, 'nope.md')]).status !== 0, 'a missing doc file fails');
}

// ── S04 review R1: malformed-known variants are a census class ─────────────
//
// Admission used to be decided by the discriminator alone. These are the two
// measured consequences, and the two rejected repairs (silent admit / whole-
// census failure) are asserted against directly.
function testMalformedKnown() {
  const now = '2026-08-06T00:00:00.000Z';
  const opts = { unit: 'execute-task/T02', now };

  // (1) commandExecution with no command: used to become cmd:'' with null facts.
  const thinCommand = admit.buildRuntimeEvidence([{ type: 'commandExecution', exitCode: 1 }], opts);
  equal(thinCommand.census.outcome, 'collected', 'one thin item does NOT fail the whole collection');
  equal(thinCommand.entries, [], 'a command with no command string produces no entry');
  equal(thinCommand.census.admitted, 0, 'and is not counted as admitted');
  equal(thinCommand.census.malformed, 1, 'it is counted in its own class');
  equal(thinCommand.census.malformed_detail,
    [{ type: 'commandExecution', reason: 'empty-command', count: 1 }],
    'the census NAMES the variant and why it was unusable');
  check(!thinCommand.entries.some(e => e.cmd === ''),
    'no entry asserts a command ran while declining to say which');

  // (2) fileChange whose changes[] elements have no path.
  const badChanges = admit.buildRuntimeEvidence([
    { type: 'fileChange', status: 'completed', changes: [{ path: 'a.js', kind: 'modify' }, { kind: 'modify' }, null] },
  ], opts);
  equal(badChanges.entries.length, 1, 'the usable change still produces its entry');
  equal(badChanges.entries[0].file, 'a.js', 'and it is the real path');
  equal(badChanges.census.admitted, 1, 'a partially-usable item is still admitted (not destroyed)');
  equal(badChanges.census.malformed_changes, 2, 'the two unusable elements are counted, never discarded');
  check(!badChanges.entries.some(e => e.file === ''), 'no entry carries an empty path');

  // An item with NO usable change at all is malformed at the item level.
  const allBad = admit.buildRuntimeEvidence([{ type: 'fileChange', changes: [{ kind: 'modify' }] }], opts);
  equal(allBad.entries, [], 'an all-unusable fileChange produces no entries');
  equal(allBad.census.malformed, 1, 'and is counted as a malformed ITEM');
  equal(allBad.census.admitted, 0, 'never admitted-with-zero-entries');

  // The accounting identity still holds with the fourth disposition present.
  const mixed = admit.buildRuntimeEvidence([
    { type: 'commandExecution', command: 'npm test', exitCode: 0 }, // admitted
    { type: 'commandExecution', exitCode: 1 },                      // malformed
    { type: 'agentMessage', text: 'hi' },                           // inadmissible
    { type: 'quantumThing' },                                       // rejected (unknown)
  ], opts);
  const rejectedTotal = mixed.census.rejected.reduce((s, r) => s + r.count, 0);
  equal(mixed.census.outcome, 'collected', 'a mixed stream still collects');
  equal(mixed.census.admitted + mixed.census.inadmissible + mixed.census.malformed + rejectedTotal,
    mixed.census.items_received,
    'admitted + inadmissible + malformed + rejected === items_received');
  equal(mixed.census.malformed, 1, 'exactly one malformed');
  equal(mixed.entries.length, 1, 'and only the well-formed command became an entry');

  // Bite in the other direction: well-formed items are NOT swept into the new
  // class, so the counts above are a finding about the input, not a validator
  // that rejects everything.
  const clean = admit.buildRuntimeEvidence([
    { type: 'commandExecution', command: 'npm test', exitCode: 0 },
    { type: 'fileChange', changes: [{ path: 'b.js', kind: 'add' }] },
  ], opts);
  equal(clean.census.malformed, 0, 'control: well-formed items are never malformed');
  equal(clean.census.malformed_changes, 0, 'control: well-formed changes are never counted');
  equal(clean.entries.length, 2, 'control: both entries are emitted');

  // exitCode:null must stay an OBSERVED value — validation must not have turned
  // the most damaging edit in this file into a "malformed" rejection.
  const nullExit = admit.buildRuntimeEvidence([{ type: 'commandExecution', command: 'npm test', exitCode: null }], opts);
  equal(nullExit.census.malformed, 0, 'a null exit code is observed, not malformed');
  equal(nullExit.entries[0].exit_code, null, 'and it survives as null');
}

// ── Runner ─────────────────────────────────────────────────────────────────

const tests = [
  ['malformed-known variants (S04 R1)', testMalformedKnown],
  ['classification by name', testClassification],
  ['collected-and-empty floor', testCollectedAndEmpty],
  ['unknown variant rejected', testUnknownRejected],
  ['types_seen is prototype-safe (R2)', testTypesSeenPrototypeSafe],
  ['entry shape (source/ts/exit_code)', testEntryShape],
  ['--check-schema bite', testCheckSchema],
  ['--check-doc bite', testCheckDoc],
];

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}: ${error.message}`);
    if (error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
  }
}

// Anti-silence for the suite itself: a runner that executed nothing must not
// report success — the same floor the module under test enforces.
if (assertions === 0) {
  console.error('FAIL: the suite made zero assertions');
  process.exit(1);
}

console.log(`${tests.length - failures}/${tests.length} groups passed, ${assertions} assertions`);
process.exit(failures === 0 ? 0 : 1);
