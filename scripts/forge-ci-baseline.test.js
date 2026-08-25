#!/usr/bin/env node
'use strict';

// Standalone suite for the known-failures baseline in scripts/run-tests.js
// (--baseline). It exercises the PURE resolver functions (resolveBaseline,
// compareFailures) with synthetic sets and validates the versioned fixture
// against the suite files that actually exist on disk.
//
// Deliberately NEVER spawns the runner: requiring run-tests.js is safe (its
// main() is guarded by require.main), and discoverTests only does a readdir.
// Spawning the runner here would execute all 196 suites recursively.

const fs = require('fs');
const path = require('path');
const {
  baselineEntriesForSuites,
  compareFailures,
  discoverTests,
  parseArgs,
  resolveBaseline,
  suitesForShard,
  BASELINE_PLATFORMS,
} = require('./run-tests.js');

let passes = 0;
let fails = 0;

function pass(name) {
  passes += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

function fail(name, detail) {
  fails += 1;
  process.stdout.write(`  ✗ ${name}\n    ${detail || 'assertion failed'}\n`);
}

function assert(condition, name, detail) {
  if (condition) pass(name);
  else fail(name, detail);
}

function assertEqual(actual, expected, name) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    name,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

const AVAILABLE = ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js'];

function doc(win32Entries) {
  return JSON.stringify({ win32: win32Entries, darwin: [], linux: [] });
}

function entry(suite) {
  return { suite, item: 'I-0000', reason: 'synthetic' };
}

// --- Section 1: parseArgs stays additive -----------------------------------
process.stdout.write('Section 1: parseArgs (--baseline is additive)\n');
{
  const legacy = parseArgs([]);
  assertEqual(legacy.baseline, null, 'no flag -> options.baseline is null (legacy path untouched)');
  assertEqual(legacy.shardIndex, null, 'no flag -> options.shardIndex is null (legacy path untouched)');
  assertEqual(legacy.shardCount, null, 'no flag -> options.shardCount is null (legacy path untouched)');

  const withFlag = parseArgs(['--baseline', 'scripts/fixtures/ci-baseline/known-failures.json']);
  assertEqual(withFlag.baseline, 'scripts/fixtures/ci-baseline/known-failures.json', '--baseline captures its file path');

  let threw = false;
  try { parseArgs(['--baseline']); } catch { threw = true; }
  assert(threw, '--baseline without a value throws');

  threw = false;
  try { parseArgs(['--baseline', '--verbose']); } catch { threw = true; }
  assert(threw, '--baseline followed by another flag throws (no value)');

  // Legacy flags still parse exactly as before.
  const mixed = parseArgs(['--list', '--match', 'foo', '--fail-fast', '--verbose', '--inherit-home']);
  assert(
    mixed.list && mixed.failFast && mixed.verbose && mixed.inheritHome && mixed.matches[0] === 'foo',
    'legacy flags unaffected by the new option'
  );

  const sharded = parseArgs(['--shard-index', '1', '--shard-count', '3']);
  assertEqual(sharded.shardIndex, 1, '--shard-index captures a zero-based index');
  assertEqual(sharded.shardCount, 3, '--shard-count captures the partition count');

  for (const [argv, message] of [
    [['--shard-index', '0'], 'both shard flags are required (missing count)'],
    [['--shard-count', '2'], 'both shard flags are required (missing index)'],
    [['--shard-index', '-1', '--shard-count', '2'], 'negative shard index is rejected'],
    [['--shard-index', '0.5', '--shard-count', '2'], 'fractional shard index is rejected'],
    [['--shard-index', 'two', '--shard-count', '2'], 'non-numeric shard index is rejected'],
    [['--shard-index', '0', '--shard-count', '0'], 'zero shard count is rejected'],
    [['--shard-index', '2', '--shard-count', '2'], 'index equal to count is rejected'],
    [['--shard-index', '0', '--shard-index', '1', '--shard-count', '2'], 'duplicate shard flag is rejected'],
    [['--shard-index', '9007199254740992', '--shard-count', '9007199254740993'], 'unsafe integers are rejected'],
  ]) {
    let shardThrew = false;
    try { parseArgs(argv); } catch { shardThrew = true; }
    assert(shardThrew, message);
  }
}

// --- Section 2: resolveBaseline (named failures, never silent) --------------
process.stdout.write('Section 2: resolveBaseline validation\n');
{
  const ok = resolveBaseline({
    text: doc([entry('a.test.js'), entry('b.test.js')]),
    platform: 'win32',
    availableSuites: AVAILABLE,
  });
  assert(ok.ok === true, 'valid document resolves ok');
  assertEqual(ok.entries.map(e => e.suite), ['a.test.js', 'b.test.js'], 'entries preserved with suite/item/reason');
  assertEqual(ok.entries[0].item, 'I-0000', 'item field carried through');
  assertEqual(ok.entries[0].reason, 'synthetic', 'reason field carried through');

  const emptyPlatform = resolveBaseline({ text: doc([]), platform: 'darwin', availableSuites: AVAILABLE });
  assert(emptyPlatform.ok === true && emptyPlatform.entries.length === 0, 'explicitly empty platform set is valid (means: zero known failures)');

  const badJson = resolveBaseline({ text: '{not json', platform: 'win32', availableSuites: AVAILABLE });
  assert(badJson.ok === false && badJson.errors[0].includes('not valid JSON'), 'invalid JSON is a named failure');

  const notObject = resolveBaseline({ text: '["a"]', platform: 'win32', availableSuites: AVAILABLE });
  assert(notObject.ok === false && notObject.errors[0].includes('keyed by platform'), 'non-object document is a named failure');

  const typoKey = resolveBaseline({
    text: JSON.stringify({ windows: [], win32: [], darwin: [], linux: [] }),
    platform: 'win32',
    availableSuites: AVAILABLE,
  });
  assert(
    typoKey.ok === false && typoKey.errors.some(e => e.includes('"windows"')),
    'unknown top-level key (typo "windows") is a named failure, not silently ignored'
  );

  const commentKey = resolveBaseline({
    text: JSON.stringify({ _comment: 'hi', win32: [], darwin: [], linux: [] }),
    platform: 'win32',
    availableSuites: AVAILABLE,
  });
  assert(commentKey.ok === true, 'underscore-prefixed annotation keys are allowed');

  const missingPlatform = resolveBaseline({
    text: JSON.stringify({ win32: [] }),
    platform: 'linux',
    availableSuites: AVAILABLE,
  });
  assert(
    missingPlatform.ok === false && missingPlatform.errors.some(e => e.includes('no entry set for platform "linux"')),
    'missing platform key is a named failure (must be listed explicitly, even as [])'
  );

  const notArray = resolveBaseline({
    text: JSON.stringify({ win32: {}, darwin: [], linux: [] }),
    platform: 'win32',
    availableSuites: AVAILABLE,
  });
  assert(notArray.ok === false && notArray.errors.some(e => e.includes('must be an array')), 'non-array platform set is a named failure');

  const badSuiteName = resolveBaseline({
    text: doc([{ suite: 'a.js', item: 'I-1', reason: 'r' }]),
    platform: 'win32',
    availableSuites: AVAILABLE,
  });
  assert(badSuiteName.ok === false && badSuiteName.errors.some(e => e.includes('*.test.js')), 'suite not ending in .test.js is a named failure');

  const missingItem = resolveBaseline({
    text: doc([{ suite: 'a.test.js', reason: 'r' }]),
    platform: 'win32',
    availableSuites: AVAILABLE,
  });
  assert(missingItem.ok === false && missingItem.errors.some(e => e.includes('missing "item"')), 'entry without backlog item is a named failure');

  const missingReason = resolveBaseline({
    text: doc([{ suite: 'a.test.js', item: 'I-1', reason: '   ' }]),
    platform: 'win32',
    availableSuites: AVAILABLE,
  });
  assert(missingReason.ok === false && missingReason.errors.some(e => e.includes('missing "reason"')), 'entry with blank reason is a named failure');

  const duplicate = resolveBaseline({
    text: doc([entry('a.test.js'), entry('a.test.js')]),
    platform: 'win32',
    availableSuites: AVAILABLE,
  });
  assert(duplicate.ok === false && duplicate.errors.some(e => e.includes('twice')), 'duplicate suite entry is a named failure');

  const ghost = resolveBaseline({
    text: doc([entry('ghost.test.js')]),
    platform: 'win32',
    availableSuites: AVAILABLE,
  });
  assert(
    ghost.ok === false && ghost.errors.some(e => e.includes('ghost.test.js') && e.includes('does not exist')),
    'baseline pointing at a nonexistent suite file is a named failure (ghost entry)'
  );
}

// --- Section 3: compareFailures — both directions, always -------------------
process.stdout.write('Section 3: compareFailures set comparison (two-way)\n');
{
  const match = compareFailures({
    executedCount: 4,
    failedSuites: ['a.test.js', 'b.test.js'],
    baselineSuites: ['b.test.js', 'a.test.js'],
  });
  assert(match.ok === true && match.code === 'match', 'F == B -> ok (order-independent)');
  assertEqual(match.knownFailures, ['a.test.js', 'b.test.js'], 'known failures enumerated (census), sorted');
  assertEqual(match.newFailures, [], 'match: no new failures');
  assertEqual(match.staleEntries, [], 'match: no stale entries');

  const fresh = compareFailures({
    executedCount: 4,
    failedSuites: ['a.test.js', 'c.test.js'],
    baselineSuites: ['a.test.js'],
  });
  assert(fresh.ok === false && fresh.code === 'new-failures', 'F - B nonempty -> not ok (new red blocks)');
  assertEqual(fresh.newFailures, ['c.test.js'], 'new failure named individually');

  const stale = compareFailures({
    executedCount: 4,
    failedSuites: ['a.test.js'],
    baselineSuites: ['a.test.js', 'b.test.js'],
  });
  assert(stale.ok === false && stale.code === 'stale-entries', 'B - F nonempty -> not ok (cured suite left listed is an inert gate)');
  assertEqual(stale.staleEntries, ['b.test.js'], 'stale entry named individually');

  const both = compareFailures({
    executedCount: 4,
    failedSuites: ['c.test.js'],
    baselineSuites: ['b.test.js'],
  });
  assert(both.ok === false && both.code === 'new-and-stale', 'both directions can fail at once');
  assertEqual(both.newFailures, ['c.test.js'], 'new-and-stale: new failure still named');
  assertEqual(both.staleEntries, ['b.test.js'], 'new-and-stale: stale entry still named');

  const cleanRun = compareFailures({ executedCount: 4, failedSuites: [], baselineSuites: [] });
  assert(cleanRun.ok === true && cleanRun.code === 'match', 'zero failures against empty baseline -> clean pass');

  const allCured = compareFailures({ executedCount: 4, failedSuites: [], baselineSuites: ['a.test.js'] });
  assert(allCured.ok === false && allCured.code === 'stale-entries', 'zero failures with nonempty baseline is NOT a pass — remova da baseline');
}

// --- Section 4: anti-silence floor ------------------------------------------
process.stdout.write('Section 4: anti-silence floor\n');
{
  const zero = compareFailures({ executedCount: 0, failedSuites: [], baselineSuites: [] });
  assert(
    zero.ok === false && zero.code === 'no-suites-executed',
    '0 suites executed is a named failure even with both sets empty — never a clean pass'
  );

  const negative = compareFailures({ executedCount: -1, failedSuites: [], baselineSuites: [] });
  assert(negative.ok === false && negative.code === 'no-suites-executed', 'nonsensical executed count also trips the floor');

  const nonInteger = compareFailures({ executedCount: undefined, failedSuites: [], baselineSuites: [] });
  assert(nonInteger.ok === false && nonInteger.code === 'no-suites-executed', 'missing executed count trips the floor');
}

// --- Section 5: the versioned fixture is real -------------------------------
process.stdout.write('Section 5: fixture integrity against the suites on disk\n');
{
  const fixturePath = path.join(__dirname, 'fixtures', 'ci-baseline', 'known-failures.json');
  assert(fs.existsSync(fixturePath), 'fixture file exists at scripts/fixtures/ci-baseline/known-failures.json');

  const text = fs.readFileSync(fixturePath, 'utf8');
  // discoverTests only does a readdir of scripts/ — it never spawns anything.
  const realSuites = discoverTests([]);
  assert(realSuites.length > 0, 'suite discovery found real suites (floor for this very check)');

  for (const platform of BASELINE_PLATFORMS) {
    const resolved = resolveBaseline({ text, platform, availableSuites: realSuites });
    assert(resolved.ok === true, `fixture resolves cleanly for ${platform}`, (resolved.errors || []).join('; '));
  }

  // What is asserted about the live fixture is its SHAPE, never its contents.
  // An earlier version pinned "exactly the 11 chronic suites" and went red the
  // moment the same PR fixed eight of them — a test that has to be edited every
  // time the list legitimately shrinks teaches people to edit it, which is how a
  // baseline rots. The count is data; these are the invariants:
  const win32 = resolveBaseline({ text, platform: 'win32', availableSuites: realSuites });
  if (win32.ok) {
    assert(
      win32.entries.every(e => e.item && /^I-\d{14}$/.test(e.item)),
      'every entry names a backlog item — an entry with no owner is how a red becomes scenery'
    );
    assert(
      win32.entries.every(e => e.reason && e.reason.trim().length > 0),
      'every entry states a reason'
    );
    assert(
      win32.entries.every(e => realSuites.includes(e.suite)),
      'every win32 baseline suite exists on disk (no ghosts — a rename here must break this test)'
    );
  }

  // Exact-name matching, proven on the resolver instead of on the fixture: a
  // prefix match would swallow the `-runtime` sibling and silence a real red.
  const siblingProbe = resolveBaseline({
    text: JSON.stringify({ win32: [{ suite: 'forge-isolation.test.js', item: 'I-20260815014759', reason: 'probe' }], darwin: [], linux: [] }),
    platform: 'win32',
    availableSuites: ['forge-isolation.test.js', 'forge-isolation-runtime.test.js'],
  });
  assert(siblingProbe.ok === true, 'sibling probe fixture resolves');
  const siblingNames = siblingProbe.entries.map(e => e.suite);
  assert(
    siblingNames.includes('forge-isolation.test.js') && !siblingNames.includes('forge-isolation-runtime.test.js'),
    'an entry matches its suite exactly, never the -runtime sibling by prefix'
  );

  const darwin = resolveBaseline({ text, platform: 'darwin', availableSuites: realSuites });
  const linux = resolveBaseline({ text, platform: 'linux', availableSuites: realSuites });
  assert(darwin.ok && darwin.entries.length === 0, 'darwin baseline is explicitly empty');
  assert(linux.ok && linux.entries.length === 0, 'linux baseline is explicitly empty');
}

// --- Section 6: deterministic, complete, disjoint sharding -----------------
process.stdout.write('Section 6: deterministic suite sharding\n');
{
  const suites = Array.from({ length: 17 }, (_, index) => `suite-${String(index).padStart(2, '0')}.test.js`);
  const shards = Array.from({ length: 4 }, (_, index) => suitesForShard(suites, index, 4));

  assertEqual(shards[0], suitesForShard(suites, 0, 4), 'same input and shard coordinates produce the same selection');
  assertEqual(suites, Array.from({ length: 17 }, (_, index) => `suite-${String(index).padStart(2, '0')}.test.js`), 'sharding does not mutate the canonical suite list');

  const flattened = shards.flat();
  const membership = new Map(suites.map(suite => [suite, flattened.filter(candidate => candidate === suite).length]));
  assert(
    [...membership.values()].every(count => count === 1),
    'every suite belongs to exactly one shard (complete coverage without duplication)'
  );
  assertEqual([...new Set(flattened)].sort(), [...suites].sort(), 'union of all shards equals the complete suite universe');

  const sizes = shards.map(shard => shard.length);
  assert(Math.max(...sizes) - Math.min(...sizes) <= 1, 'shard suite counts differ by at most one');
  assertEqual(suitesForShard(['only.test.js'], 1, 3), [], 'a valid shard may be empty when count exceeds suite count');
}

// --- Section 7: shard-aware bidirectional baseline -------------------------
process.stdout.write('Section 7: shard-aware baseline comparison\n');
{
  const entries = AVAILABLE.map(entry);
  const shardZeroSuites = suitesForShard(AVAILABLE, 0, 2);
  const shardOneSuites = suitesForShard(AVAILABLE, 1, 2);
  const shardZeroBaseline = baselineEntriesForSuites(entries, shardZeroSuites);
  const shardOneBaseline = baselineEntriesForSuites(entries, shardOneSuites);

  assertEqual(shardZeroBaseline.map(item => item.suite), ['a.test.js', 'c.test.js'], 'shard 0 keeps only baseline entries for suites it executes');
  assertEqual(shardOneBaseline.map(item => item.suite), ['b.test.js', 'd.test.js'], 'shard 1 keeps only baseline entries for suites it executes');

  const zeroVerdict = compareFailures({
    executedCount: shardZeroSuites.length,
    failedSuites: shardZeroSuites,
    baselineSuites: shardZeroBaseline.map(item => item.suite),
  });
  assert(zeroVerdict.ok === true, 'entries owned by another shard are not reported stale in shard 0');

  const oneVerdict = compareFailures({
    executedCount: shardOneSuites.length,
    failedSuites: shardOneSuites,
    baselineSuites: shardOneBaseline.map(item => item.suite),
  });
  assert(oneVerdict.ok === true, 'entries owned by another shard are not reported stale in shard 1');

  const staleWithinShard = compareFailures({
    executedCount: shardZeroSuites.length,
    failedSuites: ['a.test.js'],
    baselineSuites: shardZeroBaseline.map(item => item.suite),
  });
  assertEqual(staleWithinShard.staleEntries, ['c.test.js'], 'a cured entry still blocks in the shard that owns it');

  const resolvedWithCrossShardEntries = resolveBaseline({
    text: doc(entries),
    platform: 'win32',
    availableSuites: AVAILABLE,
  });
  assert(resolvedWithCrossShardEntries.ok === true, 'baseline is validated against the full universe before shard filtering');

  const ghostOutsideShard = resolveBaseline({
    text: doc([...entries, entry('ghost.test.js')]),
    platform: 'win32',
    availableSuites: AVAILABLE,
  });
  assert(
    ghostOutsideShard.ok === false && ghostOutsideShard.errors.some(error => error.includes('ghost.test.js')),
    'a ghost entry is rejected even when it would not belong to the current shard'
  );
}

process.stdout.write(`\n${passes} passed, ${fails} failed\n`);
process.exitCode = fails === 0 ? 0 : 1;
