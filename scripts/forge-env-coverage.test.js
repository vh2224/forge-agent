#!/usr/bin/env node
'use strict';

// Standalone contract suite for the per-reason coverage map (M018 S06 / IN-14).
//
// Every guard is proven in BOTH directions: a passing assertion alone cannot
// distinguish a working checker from an inert one, which is the defect class
// this milestone exists to close.

const {
  COVERAGE_VERDICTS,
  REASON_COVERAGE,
  promotableReasons,
  coverageCounts,
  assertReasonCoverage,
  checkDocTable,
  DOC_SECTION_HEADING,
} = require('./forge-env-coverage.js');
const { ENV_REASON_ENUM } = require('./forge-xllm.js');

let passes = 0;
let fails = 0;

function assert(value, name, detail) {
  if (value) { passes += 1; process.stdout.write(`  ✓ ${name}\n`); }
  else { fails += 1; process.stdout.write(`  ✗ ${name}${detail ? `: ${detail}` : ''}\n`); }
}

function throwsWith(fn, needle) {
  try { fn(); return { threw: false, message: '' }; }
  catch (error) { return { threw: true, message: String(error.message), code: error.code, named: String(error.message).includes(needle) }; }
}

// ── The table is built HERE, not read from disk ────────────────────────────
// checkDocTable takes markdown as a string precisely so bite can be proven
// without `.gsd/` — the CODE_DIR worktree has none (measured: ENOENT).
function buildTable(overrides = {}) {
  const rows = Object.keys(REASON_COVERAGE).map((reason) => {
    const entry = REASON_COVERAGE[reason];
    const retestable = entry.retestable_on_upgrade === null ? 'n/a (coberto)' : String(entry.retestable_on_upgrade);
    const cells = {
      reason: `\`${reason}\``,
      verdict: `\`${entry.verdict}\``,
      runtime_source: entry.runtime_source,
      retestable,
      rationale: entry.rationale,
      ...(overrides[reason] || {}),
    };
    return `| ${cells.reason} | ${cells.verdict} | ${cells.runtime_source} | ${cells.retestable} | ${cells.rationale} |`;
  });
  return [
    '# fixture',
    '',
    DOC_SECTION_HEADING,
    '',
    '| reason | veredito | fonte runtime | re-testável num upgrade | razão |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

// ── 1. Enum confrontation, both directions ─────────────────────────────────

const real = assertReasonCoverage();
assert(real.ok === true && real.reasons === ENV_REASON_ENUM.length && real.enum_size === ENV_REASON_ENUM.length,
  'assertReasonCoverage passes against the real ENV_REASON_ENUM (5 of 5)',
  JSON.stringify(real));

const sixth = throwsWith(() => assertReasonCoverage([...ENV_REASON_ENUM, 'quantum-blocked']), 'quantum-blocked');
assert(sixth.threw && sixth.named && sixth.code === 'REASON_COVERAGE_DIVERGED',
  'a reason in the enum but absent from the map FAILS, naming it',
  sixth.message);

const extraMap = { ...REASON_COVERAGE, 'invented-reason': { verdict: COVERAGE_VERDICTS.CATEGORICAL, runtime_source: 'nenhuma', retestable_on_upgrade: false, rationale: 'x' } };
const extra = throwsWith(() => assertReasonCoverage(ENV_REASON_ENUM, extraMap), 'invented-reason');
assert(extra.threw && extra.named && extra.code === 'REASON_COVERAGE_DIVERGED',
  'an extra key in the map FAILS, naming it',
  extra.message);

// S06 review R2: set-based comparison is blind to repetition, so a duplicated
// member used to pass coverage in both directions while `enum_size` (6) and
// `reasons` (5) silently disagreed. The failure must NAME the repeat.
const dupEnum = [...ENV_REASON_ENUM, 'network-required'];
const dup = throwsWith(() => assertReasonCoverage(dupEnum), 'network-required');
assert(dup.threw && dup.named && dup.code === 'REASON_ENUM_DUPLICATE',
  'a duplicated enum member FAILS, naming it (never a set-blind pass)',
  dup.message);
// Contra-case: the duplicate is invisible to the set comparison this replaces,
// so without the explicit check the very same input reports a clean 6-of-5.
const dupSet = new Set(dupEnum);
assert(dupSet.size === Object.keys(REASON_COVERAGE).length && dupEnum.length !== dupSet.size,
  'and the duplicate is provably invisible to set comparison (the reason the check exists)',
  `${dupEnum.length} raw vs ${dupSet.size} unique`);

const empty = throwsWith(() => assertReasonCoverage([]), 'anti-silence');
assert(empty.threw && empty.code === 'REASON_ENUM_EMPTY',
  'an empty enum FAILS the anti-silence floor (never a vacuous 0-of-0 pass)',
  empty.message);

// ── 2. The three classes never collapse (DP5) ──────────────────────────────

const gaps = Object.keys(REASON_COVERAGE).filter((r) => REASON_COVERAGE[r].verdict === COVERAGE_VERDICTS.MEASURED_GAP);
const categoricals = Object.keys(REASON_COVERAGE).filter((r) => REASON_COVERAGE[r].verdict === COVERAGE_VERDICTS.CATEGORICAL);
assert(gaps.length > 0 && gaps.every((r) => REASON_COVERAGE[r].retestable_on_upgrade === true),
  'every measured-gap reason is retestable_on_upgrade === true', gaps.join(','));
assert(categoricals.length > 0 && categoricals.every((r) => REASON_COVERAGE[r].retestable_on_upgrade === false),
  'every categorical reason is retestable_on_upgrade === false', categoricals.join(','));
assert(gaps.every((r) => !categoricals.includes(r)),
  'the measured-gap and categorical sets are disjoint');

// The distinction is EXECUTABLE, not prose: flipping it throws by name.
const collapsed = { ...REASON_COVERAGE, 'sandbox-exec-blocked': { ...REASON_COVERAGE['sandbox-exec-blocked'], retestable_on_upgrade: false } };
const collapse = throwsWith(() => assertReasonCoverage(ENV_REASON_ENUM, collapsed), 'sandbox-exec-blocked');
assert(collapse.threw && collapse.named && collapse.code === 'CLASS_COLLAPSE',
  'collapsing measured-gap into categorical FAILS, naming the reason',
  collapse.message);

const counts = coverageCounts();
assert(counts[COVERAGE_VERDICTS.PROMOTABLE] === 2
  && counts[COVERAGE_VERDICTS.MEASURED_GAP] === 1
  && counts[COVERAGE_VERDICTS.CATEGORICAL] === 2,
  'coverageCounts() reads {promotable:2, measured-gap:1, categorical:2} from the map',
  JSON.stringify(counts));

const total = Object.values(counts).reduce((a, b) => a + b, 0);
assert(total === ENV_REASON_ENUM.length,
  'the three counts sum to ENV_REASON_ENUM.length (never a trusted literal 5)',
  `${total} vs ${ENV_REASON_ENUM.length}`);

assert(promotableReasons().length === 2
  && promotableReasons().includes('out-of-scope-test-failure')
  && promotableReasons().includes('network-required'),
  'promotableReasons() is derived from the map (DP1: T02 consumes this, not a second literal list)',
  promotableReasons().join(','));

// ── 3. checkDocTable, both directions ──────────────────────────────────────

const intact = checkDocTable(buildTable());
assert(intact.ok === true && intact.parsed === 5,
  'the intact table passes with parsed:5',
  JSON.stringify(intact.problems));

const erased = checkDocTable(buildTable({ 'network-required': { verdict: '' } }));
const erasedDetail = erased.problems.map((p) => `${p.kind}:${p.detail}`).join(' | ');
assert(erased.ok === false
  && erased.problems.some((p) => p.kind === 'missing-verdict' && p.reason === 'network-required')
  && erasedDetail.includes('network-required'),
  'an erased verdict cell FAILS, naming the affected reason',
  erasedDetail);

const silent = checkDocTable('# nothing here\n\nsome prose without a table.\n');
assert(silent.ok === false && silent.parsed === 0 && silent.problems.some((p) => p.kind === 'anti-silence'),
  'zero parseable rows FAILS with anti-silence — never a clean pass',
  JSON.stringify(silent));

const unknownVerdict = checkDocTable(buildTable({ 'git-commit-required': { verdict: 'covered' } }));
assert(unknownVerdict.ok === false
  && unknownVerdict.problems.some((p) => p.kind === 'unknown-verdict' && p.reason === 'git-commit-required'),
  "a verdict outside the enum ('covered') FAILS as unknown-verdict",
  JSON.stringify(unknownVerdict.problems));

const mismatch = checkDocTable(buildTable({ 'sandbox-exec-blocked': { verdict: 'categorical' } }));
assert(mismatch.ok === false
  && mismatch.problems.some((p) => p.kind === 'verdict-mismatch' && p.reason === 'sandbox-exec-blocked'),
  'a doc verdict diverging from the map FAILS as verdict-mismatch, naming the reason',
  JSON.stringify(mismatch.problems));

const docCollapse = checkDocTable(buildTable({ 'sandbox-exec-blocked': { retestable: 'false' } }));
assert(docCollapse.ok === false
  && docCollapse.problems.some((p) => p.kind === 'retestable-mismatch' && p.reason === 'sandbox-exec-blocked'),
  'collapsing the classes IN THE DOC fails too (retestable-mismatch)',
  JSON.stringify(docCollapse.problems));

const missingRow = checkDocTable(buildTable().split('\n').filter((l) => !l.includes('gsd-write-refused')).join('\n'));
assert(missingRow.ok === false
  && missingRow.problems.some((p) => p.kind === 'missing-row' && p.reason === 'gsd-write-refused'),
  'a reason missing from the table FAILS, naming it',
  JSON.stringify(missingRow.problems));

const noRationale = checkDocTable(buildTable({ 'out-of-scope-test-failure': { rationale: '' } }));
assert(noRationale.ok === false
  && noRationale.problems.some((p) => p.kind === 'missing-rationale' && p.reason === 'out-of-scope-test-failure'),
  'an empty rationale cell FAILS (DP6: nenhuma célula vazia)',
  JSON.stringify(noRationale.problems));

// ── 4. Anti-inert floor on the suite itself ────────────────────────────────
// A suite that runs zero assertions reports "0 failed" and is indistinguishable
// from a broken one. Same floor the module enforces on its own inputs.
if (passes + fails === 0) {
  process.stdout.write('  ✗ anti-inert floor: 0 assertions ran\n');
  fails += 1;
}

process.stdout.write(`Results: ${passes} passed, ${fails} failed\n`);
process.exitCode = fails ? 1 : 0;
