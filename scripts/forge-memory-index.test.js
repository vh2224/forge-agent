#!/usr/bin/env node
// forge-memory-index.test.js — standalone test suite for forge-memory-index.js
//
// Covers (T03 must-haves):
//   - Synthetic fixture store (mkdtempSync) with >= 3 fragments / >= 20 facts + fake
//     source-file tree — zero dependency on this repo's real .gsd/memory (1 fragment).
//   - Mandatory positive case: a citation the index MUST catch, asserted by mem_id
//     under the right file.
//   - One case per discard reason: not-found, ambiguous-basename, outside-root, dynamic.
//   - Sum invariant: citations_resolved + sum(coverage.unresolved counts) === citations_total.
//   - Empty store still renders `## Cobertura e descarte`.
//   - Determinism: two renderIndex calls over the same store are byte-identical, no
//     wallclock pattern in the markdown.
//   - Containment: a `../` citation is never resolved and nothing is read outside the
//     fixture root.
//   - CLI: --json exits 0 with one-line JSON on stdout; an unknown arg exits 2.
//
// Run: node scripts/forge-memory-index.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  extractCitations,
  CITATION_REGEXES,
  resolveCitation,
  buildFileIndex,
  renderIndex,
  writeIndex,
  queryIndex,
  renderQuery,
  DEFAULT_INDEX_PATH,
} = require('./forge-memory-index.js');

const { writeFragment } = require('./forge-memory.js');

// Derived, never a literal: the fixture must mean "one major AHEAD of this
// tooling". A hardcoded version stops being ahead the moment CURRENT_SCHEMA is
// bumped, and the test then silently asserts the wrong scenario — which is
// exactly how this case rotted when CURRENT_SCHEMA moved to 2.0.0. Same
// pattern as forge-schema-guard-wiring.test.js.
const { CURRENT_SCHEMA } = require('./forge-doctor.js');
const TOOLING_MAJOR = Number(String(CURRENT_SCHEMA).match(/@(\d+)\./)[1]);
const AHEAD_SCHEMA  = `fragment-store@${TOOLING_MAJOR + 1}.0.0`;

// ── Test runner boilerplate (mirrors forge-verifier.test.js) ───────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

const SCRIPT_PATH = path.join(__dirname, 'forge-memory-index.js');

// mkStore(facts, files, opts) — creates a fresh mkdtempSync root, writes each
// entry of `facts` (Array<{ unitId, milestoneId?, text, mem_id, category?, source_unit? }>)
// as a real fragment via writeFragment (guarantees byte-exact round trip with
// parseFragment — never hand-serialized), and materializes each path in `files`
// as an empty file under the fixture root. Returns the fixture root.
function mkStore(facts, files, opts) {
  opts = opts || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));

  for (const relFile of files || []) {
    const abs = path.join(root, relFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '// fixture file\n', 'utf8');
  }

  // Group facts by unit_id so multiple facts for the same unit merge into one
  // fragment (mirrors real writeFragment/mergeFacts usage).
  const byUnit = new Map();
  for (const f of facts || []) {
    if (!byUnit.has(f.unitId)) byUnit.set(f.unitId, []);
    byUnit.get(f.unitId).push(f);
  }

  for (const [unitId, group] of byUnit) {
    const factObjs = group.map((f, i) => ({
      mem_id: f.mem_id || `${unitId}-fact-${i}`,
      category: f.category || 'pattern',
      text: f.text,
      created_at: '2026-08-01T00:00:00Z',
      source_unit: f.source_unit || unitId,
    }));
    writeFragment(root, { unit_id: unitId, facts: factObjs }, { milestoneId: group[0].milestoneId });
  }

  if (!opts.skipSchemaVersion && opts.schemaVersion) {
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gsd', 'SCHEMA-VERSION'), opts.schemaVersion, 'utf8');
  }

  return root;
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (_) {
    // best-effort — a leftover temp dir is not a test failure
  }
}

// ── Section 1: extraction ────────────────────────────────────────────────────
console.log('\n=== forge-memory-index.test.js ===\n');
console.log('Section 1: extractCitations\n');

test('extractCitations: backticked path with line number', () => {
  const cites = extractCitations('See `scripts/forge-alpha.js:143` for the fix.');
  assert(cites.length === 1, 'expected exactly one citation');
  assertEq(cites[0].path, 'scripts/forge-alpha.js');
  assertEq(cites[0].line, 143);
  assertEq(cites[0].pattern, 'backticked-path');
});

test('extractCitations: bare path with slash outside backticks', () => {
  const cites = extractCitations('Documented in scripts/forge-beta.js for reference.');
  assert(cites.some((c) => c.path === 'scripts/forge-beta.js'), 'expected bare-path citation');
});

test('extractCitations: bare basename loose in prose', () => {
  const cites = extractCitations('Fixed inside forge-alpha.js earlier today.');
  assert(cites.some((c) => c.path === 'forge-alpha.js' && c.pattern === 'bare-basename'), 'expected bare-basename citation');
});

test('extractCitations: dedup by path, first occurrence wins, order preserved', () => {
  const cites = extractCitations('First scripts/forge-alpha.js:10, then scripts/forge-beta.js, then scripts/forge-alpha.js again.');
  assertEq(cites.map((c) => c.path), ['scripts/forge-alpha.js', 'scripts/forge-beta.js'], 'expected dedup preserving first occurrence and order');
  assertEq(cites[0].line, 10, 'first occurrence line must be kept');
});

// ── Section 1A: measured false negatives and locked pattern superset ────────
console.log('\nSection 1A: measured false negatives and locked pattern superset\n');

test('false negative: dotted TSX basename', () => {
  const cites = extractCitations('o arquivo _preview.tsx define o preview');
  assertEq(cites.length, 1);
  assertEq(cites[0].path, '_preview.tsx');
  assertEq(cites[0].pattern, 'bare-basename');
});

test('false negative: dotted HTML basename in backticks', () => {
  const cites = extractCitations('ver `template.html` no diretorio');
  assertEq(cites.length, 1);
  assertEq(cites[0].path, 'template.html');
  assertEq(cites[0].pattern, 'backticked-basename');
});

test('false negative: backticked versioned path keeps the full span and line', () => {
  const cites = extractCitations('ver `SERVICES/services@1.2.0/src/config/config.ts` linha 10');
  assertEq(cites.length, 1);
  assertEq(cites[0].path, 'SERVICES/services@1.2.0/src/config/config.ts');
  assertEq(cites[0].line, 10);
  assertEq(cites[0].pattern, 'backticked-path');
});

test('false negative: bare versioned path is not truncated at the version', () => {
  const cites = extractCitations('ver SERVICES/services@1.2.0/src/config/config.ts agora');
  assertEq(cites.length, 1);
  assertEq(cites[0].path, 'SERVICES/services@1.2.0/src/config/config.ts');
  assertEq(cites[0].pattern, 'bare-path');
});

test('false negative: dotted JavaScript basename outside backticks', () => {
  const cites = extractCitations('o teste forge-memory-index.test.js cobre isso');
  assertEq(cites.length, 1);
  assertEq(cites[0].path, 'forge-memory-index.test.js');
  assertEq(cites[0].pattern, 'bare-basename');
});

test('false negative: name@version is enumerated as package-ref', () => {
  const cites = extractCitations('o pacote acme@1.2.0 foi citado');
  assertEq(cites.length, 1);
  assertEq(cites[0].path, 'acme@1.2.0');
  assertEq(cites[0].pattern, 'package-ref');
  const resolved = resolveCitation(cites[0], process.cwd(), null);
  assertEq(resolved.reason, 'package-ref');
});

test('locked citation pattern names remain present', () => {
  const names = CITATION_REGEXES.map((entry) => entry.name);
  for (const name of ['backticked-path', 'bare-path', 'backticked-basename', 'bare-basename']) {
    assert(names.includes(name), `missing locked pattern ${name}`);
  }
});

test('legacy citation forms retain their path and pattern', () => {
  const cases = [
    ['See `scripts/forge-alpha.js`.', 'scripts/forge-alpha.js', 'backticked-path'],
    ['See scripts/forge-beta.js.', 'scripts/forge-beta.js', 'bare-path'],
    ['See `forge-gamma.js`.', 'forge-gamma.js', 'backticked-basename'],
    ['See forge-delta.js.', 'forge-delta.js', 'bare-basename'],
    ['See `scripts/forge-epsilon.js:27`.', 'scripts/forge-epsilon.js', 'backticked-path'],
  ];
  for (const [text, expectedPath, expectedPattern] of cases) {
    const hit = extractCitations(text)[0];
    assert(hit, `expected a citation for ${text}`);
    assertEq(hit.path, expectedPath);
    assertEq(hit.pattern, expectedPattern);
  }
});

test('traversal with @ is rejected before any filesystem probe', () => {
  const cites = extractCitations('SERVICES/services@1.2.0/../../../../etc/passwd');
  assertEq(cites.length, 1);
  assertEq(cites[0].path, 'SERVICES/services@1.2.0/../../../../etc/passwd');
  const realpath = fs.realpathSync;
  const exists = fs.existsSync;
  const stat = fs.statSync;
  let probes = 0;
  fs.realpathSync = function (...args) { probes++; return realpath.apply(fs, args); };
  fs.existsSync = function (...args) { probes++; return exists.apply(fs, args); };
  fs.statSync = function (...args) { probes++; return stat.apply(fs, args); };
  try {
    const resolved = resolveCitation(cites[0], process.cwd(), null);
    assertEq(resolved.reason, 'outside-root');
    assertEq(probes, 0, 'lexical containment must reject before disk access');
  } finally {
    fs.realpathSync = realpath;
    fs.existsSync = exists;
    fs.statSync = stat;
  }
});

test('absolute Unix and drive-letter paths never resolve as citations', () => {
  for (const text of ['/etc/passwd', 'C:\\Windows\\win.ini']) {
    const cites = extractCitations(text);
    assert(!cites.some((c) => c.path === text && resolveCitation(c, process.cwd(), null).state === 'RESOLVED'), `absolute path resolved: ${text}`);
  }
});

test('expanded extension scan remains linear on pathological input', () => {
  const started = Date.now();
  const cites = extractCitations('a'.repeat(5000) + '@');
  assert(Array.isArray(cites), 'pathological input must return an array');
  assert(Date.now() - started < 1000, 'expanded regex scan must remain trivial');
});

// S06 R11: the case above contains no `/`, so it never ENTERS the only new
// construct with backtracking ambiguity — `bare-path-traversal`'s nested
// alternation `(?:/(?:[\w.\-@]+|\.{1,2}))+`. A slash-dense input is what
// actually exercises the guard this section exists to provide.
test('expanded extension scan remains linear on slash-dense traversal input', () => {
  const started = Date.now();
  const cites = extractCitations('ver ' + '../'.repeat(3000) + ' agora');
  assert(Array.isArray(cites), 'slash-dense input must return an array');
  assert(Date.now() - started < 1000, 'nested traversal alternation must not backtrack catastrophically');
});

// ── Section 1B: extensionless prose must not be extracted (T01 repair) ──────
// Measured against the real reference store: an unfiltered `bare-path-traversal`
// plus an unanchored `package-ref` inflated citations_total 3.1x (311 -> 972)
// by matching ordinary prose. Each case below is real prose, not a citation.
console.log('\nSection 1B: extensionless prose must not be extracted\n');

test('prose "e/ou" is not extracted as a citation', () => {
  const cites = extractCitations('usar o modo e/ou combinar');
  assertEq(cites.length, 0, 'e/ou has a slash but no traversal segment — must not be a citation');
});

test('prose date "2026/08/04" is not extracted as a citation', () => {
  const cites = extractCitations('a data 2026/08/04 vale');
  assertEq(cites.length, 0, 'a slash-joined date is not a path');
});

test('prose "N/A" is not extracted as a citation', () => {
  const cites = extractCitations('ver N/A no campo');
  assertEq(cites.length, 0, 'N/A has a slash but no traversal segment — must not be a citation');
});

test('extensionless "SERVICES/services" without traversal is not extracted', () => {
  const cites = extractCitations('config em SERVICES/services e pronto');
  assertEq(cites.length, 0, 'a plain slash-joined pair without ".." or a known extension is not a citation');
});

test('prose "dev@empresa" is not extracted as package-ref (no digit-led version)', () => {
  const cites = extractCitations('contato dev@empresa e mais');
  assertEq(cites.length, 0, 'package-ref requires a digit-led version like acme@1.2.0');
});

test('guard: a small fixture of junk lines extracts nothing, citations_total must not inflate', () => {
  const junkLines = [
    'usar o modo e/ou combinar',
    'a data 2026/08/04 vale',
    'ver N/A no campo',
    'config em SERVICES/services e pronto',
    'contato dev@empresa e mais',
    'isso e/ou aquilo, tanto faz',
  ];
  let total = 0;
  for (const line of junkLines) total += extractCitations(line).length;
  assertEq(total, 0, 'extensionless prose fixture must contribute zero citations');
});

// ── Section 2: mandatory positive case ───────────────────────────────────────
console.log('\nSection 2: mandatory positive case — index MUST catch this citation\n');

test('buildFileIndex: MUST resolve a citation to scripts/forge-alpha.js under its mem_id', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed a bug in `scripts/forge-alpha.js` today.', mem_id: 'mem-positive-1' }],
    ['scripts/forge-alpha.js', 'scripts/forge-beta.js', 'lib/util.js', 'tools/util.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const entry = result.entries.find((e) => e.file === 'scripts/forge-alpha.js');
    assert(entry, 'expected an entry for scripts/forge-alpha.js — the index failed the mandatory positive case');
    assert(entry.facts.some((f) => f.mem_id === 'mem-positive-1'), 'expected mem-positive-1 under scripts/forge-alpha.js');
  } finally {
    cleanup(root);
  }
});

// ── Section 3: basename resolution ───────────────────────────────────────────
console.log('\nSection 3: basename resolution — unique vs ambiguous\n');

test('resolveCitation: unique basename resolves with how:"basename"', () => {
  const root = mkStore([], ['scripts/forge-alpha.js']);
  try {
    const result = buildFileIndex(root, {});
    const cites = extractCitations('See forge-alpha.js.');
    const res = resolveCitation(cites[0], root, { byBasename: new Map([['forge-alpha.js', ['scripts/forge-alpha.js']]]) });
    assertEq(res.state, 'RESOLVED');
    assertEq(res.how, 'basename');
    assertEq(res.file, 'scripts/forge-alpha.js');
    void result;
  } finally {
    cleanup(root);
  }
});

test('buildFileIndex: ambiguous basename (util.js in two dirs) → coverage.unresolved reason ambiguous-basename', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Touched util.js in two places.', mem_id: 'mem-ambig' }],
    ['lib/util.js', 'tools/util.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const hit = result.coverage.unresolved.find((u) => u.reason === 'ambiguous-basename');
    assert(hit, 'expected an ambiguous-basename entry in coverage.unresolved');
    assert(Array.isArray(hit.candidates) && hit.candidates.length === 2, 'expected 2 candidates for ambiguous basename');
    assert(hit.candidates.includes('lib/util.js') && hit.candidates.includes('tools/util.js'), 'expected both util.js candidates');
  } finally {
    cleanup(root);
  }
});

// ── Section 4: discard reasons — one dedicated case per motivo ──────────────
console.log('\nSection 4: discard reasons — not-found, ambiguous-basename, outside-root, dynamic\n');

test('discard reason: not-found (file cited but absent from fixture tree)', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Referenced scripts/nao-existe.js but it was never created.', mem_id: 'mem-notfound' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const hit = result.coverage.unresolved.find((u) => u.reason === 'not-found');
    assert(hit, 'expected a not-found entry in coverage.unresolved');
  } finally {
    cleanup(root);
  }
});

test('discard reason: ambiguous-basename (dedicated case, distinct from Section 3)', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Edited util.js again.', mem_id: 'mem-ambig-2' }],
    ['lib/util.js', 'tools/util.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const hit = result.coverage.unresolved.find((u) => u.reason === 'ambiguous-basename');
    assert(hit, 'expected ambiguous-basename in coverage.unresolved');
  } finally {
    cleanup(root);
  }
});

test('discard reason: outside-root (relative escape and absolute path)', () => {
  const root = mkStore(
    // S02 R4: the original fixture cited `scripts/../../etc/passwd`, whose
    // final segment matches NO extension in CODE_EXT — no citation was ever
    // extracted, so the asserted outside-root entry could not exist and this
    // "mandatory" case asserted nothing. The escaping path must be EXTRACTABLE
    // for the case to actually exercise containment.
    [{ unitId: 'T01', text: 'See scripts/../../etc/secret.js for the layout.', mem_id: 'mem-outside-rel' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const hit = result.coverage.unresolved.find((u) => u.reason === 'outside-root');
    assert(hit, 'expected an outside-root entry for a relative escape path');
  } finally {
    cleanup(root);
  }
});

test('discard reason: outside-root (absolute path input, direct resolveCitation)', () => {
  const absPath = process.platform === 'win32' ? 'C:\\Windows\\system32\\config.sys' : '/etc/passwd';
  const res = resolveCitation({ path: absPath, pattern: 'bare-path', raw: absPath, line: null }, process.cwd(), { byBasename: new Map() });
  assertEq(res.state, 'UNRESOLVED');
  assertEq(res.reason, 'outside-root');
});

test('discard reason: dynamic (template literal, wildcard, internal backtick)', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Any of scripts/forge-${name}.js could be the culprit.', mem_id: 'mem-dynamic' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const hit = result.coverage.unresolved.find((u) => u.reason === 'dynamic');
    assert(hit, 'expected a dynamic entry in coverage.unresolved');
  } finally {
    cleanup(root);
  }
});

// ── Section 5: facts without citation / unresolved-only ─────────────────────
console.log('\nSection 5: facts without citation vs unresolved-only\n');

test('fact with pure prose (no citation) → facts_without_citation, not facts_with_resolved', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'This fact talks only about architecture decisions, no file mentioned.', mem_id: 'mem-noref' }],
    [],
  );
  try {
    const result = buildFileIndex(root, {});
    const hit = result.coverage.facts_without_citation.find((f) => f.mem_id === 'mem-noref');
    assert(hit, 'expected mem-noref in facts_without_citation');
  } finally {
    cleanup(root);
  }
});

test('fact whose only citations all fail → facts_unresolved_only, never facts_with_resolved', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Only scripts/nunca-existiu.js is mentioned here.', mem_id: 'mem-unresolved-only' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const hitList = result.coverage.facts_unresolved_only;
    assert(hitList.some((f) => f.mem_id === 'mem-unresolved-only'), 'expected mem-unresolved-only in facts_unresolved_only');
    const inAnyEntry = result.entries.some((e) => e.facts.some((f) => f.mem_id === 'mem-unresolved-only'));
    assert(!inAnyEntry, 'mem-unresolved-only must never appear under facts_with_resolved (entries)');
  } finally {
    cleanup(root);
  }
});

// ── Section 6: sum invariant ─────────────────────────────────────────────────
console.log('\nSection 6: sum invariant — coverage cannot lose a citation along the way\n');

test('citations_resolved + sum(unresolved[].count) === citations_total', () => {
  const root = mkStore(
    [
      { unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` and scripts/forge-nao-existe.js and lib/util.js.', mem_id: 'mem-sum-1' },
      { unitId: 'T02', text: 'Also scripts/forge-${dynamic}.js was flagged along with ../outside.js.', mem_id: 'mem-sum-2' },
    ],
    ['scripts/forge-alpha.js', 'lib/util.js', 'tools/util.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const { citations_total, citations_resolved, unresolved } = result.coverage;
    const unresolvedSum = unresolved.reduce((acc, u) => acc + u.count, 0);
    assert(citations_total > 0, 'expected at least one citation extracted');
    assertEq(citations_resolved + unresolvedSum, citations_total, 'citations_resolved + sum(unresolved counts) must equal citations_total');
  } finally {
    cleanup(root);
  }
});

test('facts_with_resolved + facts_unresolved_only.length + facts_without_citation.length === facts_total', () => {
  const root = mkStore(
    [
      { unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-fact-a' },
      { unitId: 'T01', text: 'Only scripts/nunca-existiu.js is mentioned.', mem_id: 'mem-fact-b' },
      { unitId: 'T01', text: 'Pure architecture prose, no file at all.', mem_id: 'mem-fact-c' },
    ],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const { facts_total, facts_with_resolved, facts_unresolved_only, facts_without_citation } = result.coverage;
    assertEq(facts_with_resolved + facts_unresolved_only.length + facts_without_citation.length, facts_total, 'fact bucket counts must sum to facts_total');
  } finally {
    cleanup(root);
  }
});

// ── Section 6b: three coverage buckets (IN-17) ─────────────────────────────
console.log('\nSection 6b: three labelled coverage buckets and identities\n');

test('IN-17: three buckets classify no-file, missed extractor, unresolved-only, and resolved facts', () => {
  const root = mkStore(
    [
      { unitId: 'T01', text: 'Only architecture prose; no file is mentioned.', mem_id: 'mem-a' },
      { unitId: 'T01', text: 'A token with only e.g and payload.side is ordinary prose.', mem_id: 'mem-eg' },
      { unitId: 'T01', text: 'The malformed file-shaped token .tsx was not captured.', mem_id: 'mem-b|pipe' },
      { unitId: 'T01', text: 'Only scripts/missing.js is mentioned.', mem_id: 'mem-c' },
      { unitId: 'T01', text: 'Resolved in scripts/forge-alpha.js.', mem_id: 'mem-resolved' },
    ],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const coverage = result.coverage;
    assert(coverage.facts_no_file_mention.some((f) => f.mem_id === 'mem-a'), 'expected bucket (a)');
    assert(coverage.facts_no_file_mention.some((f) => f.mem_id === 'mem-eg'), 'e.g/payload.side must be bucket (a)');
    assert(!coverage.facts_missed_by_extractor.some((f) => f.mem_id === 'mem-eg'), 'e.g/payload.side must not be bucket (b)');
    const missed = coverage.facts_missed_by_extractor.find((f) => f.mem_id === 'mem-b|pipe');
    assert(missed, 'expected bucket (b) enumeration');
    assertEq(missed.storage_key, 'T01', 'bucket (b) must enumerate storage_key');
    assertEq(missed.sample_token, '.tsx', 'bucket (b) must carry only a bounded sample token');
    assert(coverage.facts_unresolved_only.some((f) => f.mem_id === 'mem-c'), 'expected bucket (c)');

    assertEq(
      coverage.facts_total,
      coverage.facts_with_resolved + coverage.facts_no_file_mention.length + coverage.facts_missed_by_extractor.length + coverage.facts_unresolved_only.length,
      'the four fact classifications must reconstruct facts_total',
    );
    assertEq(
      coverage.facts_no_file_mention.length + coverage.facts_missed_by_extractor.length,
      coverage.facts_without_citation.length,
      'the split must reconstruct the additive legacy facts_without_citation bucket',
    );

    const md = renderIndex(result, {});
    assert(md.includes('(a) fatos sem menção reconhecida pelo vocabulário atual do extrator'), 'renderer must label bucket (a) and its reason');
    assert(md.includes('(b) fatos cuja citação de arquivo não foi capturada inteiramente pelo extrator'), 'renderer must label bucket (b) with the entirely-missed wording');
    assert(md.includes('captura PARCIAL'), 'renderer must caveat that partial capture is not counted in bucket (b)');
    assert(md.includes('(c) fatos com citações extraídas, mas nenhuma resolvida a um arquivo'), 'renderer must label bucket (c) with the resolved-to-a-file wording');
    assert(md.includes('por design não são arquivo'), 'renderer must caveat that bucket (c) mixes not-found with by-design-non-file citations');
    assert(md.includes('`mem-b\\|pipe`'), 'renderer must escape untrusted mem_id in the defect table');
    assert(md.includes('`T01`'), 'renderer must enumerate untrusted storage_key in the defect table');
    assert(md.includes('`.tsx`'), 'renderer must escape and render the sample token');
  } finally {
    cleanup(root);
  }
});

test('IN-17: empty store still renders all three labelled buckets at zero', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));
  try {
    const md = renderIndex(buildFileIndex(root, {}), {});
    assert(md.includes('(a) fatos sem menção reconhecida pelo vocabulário atual do extrator: 0'), 'bucket (a) must render at zero');
    assert(md.includes('(b) fatos cuja citação de arquivo não foi capturada inteiramente pelo extrator: 0'), 'bucket (b) must render at zero');
    assert(md.includes('(c) fatos com citações extraídas, mas nenhuma resolvida a um arquivo: 0'), 'bucket (c) must render at zero');
  } finally {
    cleanup(root);
  }
});

// ── Section 7: empty store ───────────────────────────────────────────────────
console.log('\nSection 7: empty store — coverage section still renders\n');

test('empty store (no .gsd/memory at all) → renderIndex still contains "## Cobertura e descarte"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));
  try {
    const result = buildFileIndex(root, {});
    assertEq(result.entries, [], 'expected zero entries for a store with no memory dir');
    assertEq(result.coverage.facts_total, 0);
    assertEq(result.coverage.citations_total, 0);
    const md = renderIndex(result, {});
    assert(md.includes('## Cobertura e descarte'), 'expected the coverage section unconditionally, even with an empty store');
  } finally {
    cleanup(root);
  }
});

test('empty store (.gsd/memory dir exists but has no fragments) → coverage still zeroed and section present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));
  try {
    fs.mkdirSync(path.join(root, '.gsd', 'memory'), { recursive: true });
    const result = buildFileIndex(root, {});
    assertEq(result.entries, []);
    assertEq(result.coverage.fragments_read, 0);
    const md = renderIndex(result, {});
    assert(md.includes('## Cobertura e descarte'), 'expected the coverage section for an empty-but-present memory dir');
  } finally {
    cleanup(root);
  }
});

// ── Section 8: determinism ───────────────────────────────────────────────────
console.log('\nSection 8: determinism — identical strings, no wallclock pattern\n');

test('renderIndex called twice over the same store produces byte-identical strings, no wallclock pattern', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` and scripts/nao-existe.js.', mem_id: 'mem-det-1' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const md1 = renderIndex(result, {});
    const md2 = renderIndex(result, {});
    assertEq(md1, md2, 'two renderIndex calls over the same result must be byte-identical');
    assert(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(md1), 'markdown must not contain any wallclock ISO timestamp pattern');
  } finally {
    cleanup(root);
  }
});

test('writeIndex called twice with no store change → second call reports changed:false', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-det-2' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const first = writeIndex(result, root, {});
    assertEq(first.changed, true, 'first write must report changed:true');
    const second = writeIndex(result, root, {});
    assertEq(second.changed, false, 'second write with identical content must report changed:false');
  } finally {
    cleanup(root);
  }
});

// ── Section 9: unreadable fragment ───────────────────────────────────────────
console.log('\nSection 9: unreadable fragment — degrades by report line, never crashes the run\n');

test('a fragment that cannot be read → unreadable_fragments, run does not throw', () => {
  const root = mkStore(
    [
      { unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-ok' },
      { unitId: 'T02', text: 'Another note about scripts/forge-beta.js.', mem_id: 'mem-broken' },
    ],
    ['scripts/forge-alpha.js', 'scripts/forge-beta.js'],
  );
  // parseFragment never throws on unparseable text (it falls back to body:text),
  // so the ONLY way to exercise the unreadable_fragments branch is a real
  // filesystem-level read error. The previous fixture renamed a DIRECTORY to
  // `T02.md` hoping for EISDIR — but listFragments filters on `entry.isFile()`,
  // so the directory was never enumerated and the branch never ran (2nd failure
  // found alongside S02 R4). Stubbing readFileSync for that one path is
  // deterministic and cross-platform.
  const realReadFileSync = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.replace(/\\/g, '/').includes('/.gsd/memory/') && /T02/.test(p)) {
      const err = new Error('EACCES: simulated unreadable fragment');
      throw err;
    }
    return realReadFileSync.call(fs, p, ...rest);
  };
  try {
    let result;
    assert((() => { result = buildFileIndex(root, {}); return true; })(), 'buildFileIndex must not throw on an unreadable fragment');
    assert(result.coverage.unreadable_fragments.length >= 1, 'expected at least one entry in unreadable_fragments');
    const ok = result.entries.find((e) => e.file === 'scripts/forge-alpha.js');
    assert(ok, 'the readable fragment (mem-ok) must still be indexed despite the broken sibling');
  } finally {
    fs.readFileSync = realReadFileSync;
    cleanup(root);
  }
});

// ── Section 10: schema ahead ─────────────────────────────────────────────────
console.log('\nSection 10: schema-ahead flag propagates to result.partial\n');

test('.gsd/SCHEMA-VERSION ahead of tooling → result.partial true and markdown carries the partial marker', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-schema' }],
    ['scripts/forge-alpha.js'],
    { schemaVersion: AHEAD_SCHEMA },
  );
  try {
    const result = buildFileIndex(root, {});
    assertEq(result.partial, true, 'expected partial:true when data schema major is ahead of tooling');
    const md = renderIndex(result, {});
    assert(md.includes('Índice parcial'), 'expected the partial-index marker in rendered markdown');
  } finally {
    cleanup(root);
  }
});

test('no .gsd/SCHEMA-VERSION file → result.partial false (fail-open)', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-noschema' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    assertEq(result.partial, false, 'expected partial:false (fail-open) when no SCHEMA-VERSION is present');
  } finally {
    cleanup(root);
  }
});

// ── Section 11: containment ───────────────────────────────────────────────────
console.log('\nSection 11: containment — a `../` citation never resolves and nothing outside root is read\n');

test('resolveCitation: relative escape (../secret.js) is never RESOLVED regardless of disk contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));
  const outsideMarker = path.join(os.tmpdir(), 'forge-memory-index-outside-marker.js');
  fs.writeFileSync(outsideMarker, '// should never be read by resolution\n', 'utf8');
  try {
    const cites = extractCitations('See ../forge-memory-index-outside-marker.js for context.');
    assert(cites.length === 1, 'expected the escape path to be extracted as a candidate citation');
    const res = resolveCitation(cites[0], root, { byBasename: new Map() });
    assertEq(res.state, 'UNRESOLVED');
    assertEq(res.reason, 'outside-root', 'a `../` citation must be discarded as outside-root, never resolved');
  } finally {
    cleanup(root);
    try { fs.unlinkSync(outsideMarker); } catch (_) { /* best-effort */ }
  }
});

test('buildFileIndex: end-to-end containment — a fact citing "../secret.js" never appears as a resolved entry', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Do not touch ../secret.js under any circumstance.', mem_id: 'mem-contain' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const leaked = result.entries.some((e) => e.file.includes('..') || e.file.startsWith('/'));
    assert(!leaked, 'no entry must reference a path outside the fixture root');
    const hit = result.coverage.unresolved.find((u) => u.reason === 'outside-root');
    assert(hit, 'expected the ../secret.js citation to surface as outside-root in coverage.unresolved');
  } finally {
    cleanup(root);
  }
});

// ── Section 12: full fixture — >= 3 fragments, >= 20 facts, synthetic tree ──
console.log('\nSection 12: full synthetic fixture — >= 3 fragments, >= 20 facts\n');

test('a >= 3-fragment / >= 20-fact synthetic store builds a coherent index with no crash', () => {
  const facts = [];
  const fakeFiles = ['scripts/forge-alpha.js', 'scripts/forge-beta.js', 'lib/util.js', 'tools/util.js'];
  for (let i = 0; i < 8; i++) facts.push({ unitId: 'T01', mem_id: `mem-t01-${i}`, text: `Note ${i} about scripts/forge-alpha.js and general context.` });
  for (let i = 0; i < 8; i++) facts.push({ unitId: 'T02', mem_id: `mem-t02-${i}`, text: `Note ${i} touching scripts/forge-beta.js in passing.` });
  for (let i = 0; i < 6; i++) facts.push({ unitId: 'T03', mem_id: `mem-t03-${i}`, text: `Note ${i} with no file citation at all, just prose.` });
  assert(facts.length >= 20, 'fixture must have at least 20 facts');

  const root = mkStore(facts, fakeFiles);
  try {
    const result = buildFileIndex(root, {});
    assert(result.coverage.fragments_read >= 3, 'expected at least 3 fragments read');
    assert(result.coverage.facts_total >= 20, 'expected at least 20 facts total');
    const md = renderIndex(result, {});
    assert(md.includes('## Cobertura e descarte'), 'expected coverage section on the full fixture');
    assert(md.includes('scripts/forge-alpha.js'), 'expected the alpha entry rendered');
    assert(md.includes('scripts/forge-beta.js'), 'expected the beta entry rendered');
  } finally {
    cleanup(root);
  }
});

// ── Section 13: CLI ───────────────────────────────────────────────────────────
console.log('\nSection 13: CLI — --json exit 0, unknown flag exit 2\n');

test('CLI: --json --cwd <fixture> exits 0 with one-line parseable JSON on stdout', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-cli-1' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--json', '--cwd', root], { encoding: 'utf8' });
    assertEq(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
    const stdoutLines = res.stdout.split('\n').filter((l) => l.length > 0);
    assertEq(stdoutLines.length, 1, 'expected exactly one non-empty stdout line');
    let parsed;
    assert((() => { parsed = JSON.parse(stdoutLines[0]); return true; })(), 'stdout line must be valid JSON');
    assert(typeof parsed.coverage === 'object', 'expected a coverage object in the JSON envelope');
    assert(typeof parsed.counts.facts_no_file_mention === 'number', 'expected additive bucket (a) count in JSON');
    assert(typeof parsed.counts.facts_missed_by_extractor === 'number', 'expected additive bucket (b) count in JSON');
    assert(typeof parsed.counts.facts_unresolved_only === 'number', 'expected additive bucket (c) count in JSON');
  } finally {
    cleanup(root);
  }
});

test('CLI: unknown flag exits 2', () => {
  const res = spawnSync(process.execPath, [SCRIPT_PATH, '--flag-inexistente'], { encoding: 'utf8' });
  assertEq(res.status, 2, `expected exit 2 for unknown flag, got ${res.status}`);
});

test('CLI: --out without a value exits 2', () => {
  const res = spawnSync(process.execPath, [SCRIPT_PATH, '--out'], { encoding: 'utf8' });
  assertEq(res.status, 2, `expected exit 2 for --out missing a value, got ${res.status}`);
});

test('CLI: --write with no --json grants the default-write path and produces the artifact with the coverage section', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-cli-2' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--write', '--cwd', root], { encoding: 'utf8' });
    assertEq(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
    const artifactPath = path.join(root, DEFAULT_INDEX_PATH);
    assert(fs.existsSync(artifactPath), 'expected the default artifact to be written');
    const content = fs.readFileSync(artifactPath, 'utf8');
    assert(content.includes('## Cobertura e descarte'), 'expected coverage section in the written artifact');
  } finally {
    cleanup(root);
  }
});

// ── Section 14: S02 review regressions (R2, R3, R5, R6) ─────────────────────
console.log('\nSection 14: S02 review regressions — R2, R3, R5, R6\n');

test('R2: a WRAPPED template-literal citation is still enumerated as dynamic', () => {
  const cites = extractCitations('See `scripts/forge-${name}.js` for details.');
  assert(cites.length >= 1, 'a wrapped template-literal citation must never vanish from coverage');
  const hit = cites.find((c) => c.pattern === 'dynamic');
  assert(hit, 'expected the wrapped template literal to be enumerated as pattern:"dynamic"');
  assert(hit.raw.includes('${'), `raw must preserve the original token, got ${hit.raw}`);
});

test('R2: a WRAPPED wildcard path is still enumerated as dynamic', () => {
  const cites = extractCitations('Any of `scripts/*.js` could be the culprit.');
  const hit = cites.find((c) => c.pattern === 'dynamic');
  assert(hit, 'expected the wrapped wildcard path to be enumerated as pattern:"dynamic"');
  assert(hit.raw.includes('*'), `raw must preserve the original token, got ${hit.raw}`);
});

test('R2: a plain backticked path is NOT misclassified as dynamic', () => {
  const cites = extractCitations('See `scripts/forge-alpha.js` for the fix.');
  assert(!cites.some((c) => c.pattern === 'dynamic'), 'a plain backticked path must stay backticked-path, never dynamic');
});

test('R3: a listFragments failure is distinguishable from an empty store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));
  const realReaddirSync = fs.readdirSync;
  fs.readdirSync = function (p, ...rest) {
    if (typeof p === 'string' && p.replace(/\\/g, '/').endsWith('/.gsd/memory')) {
      throw new Error('EIO: simulated enumeration failure');
    }
    return realReaddirSync.call(fs, p, ...rest);
  };
  try {
    fs.mkdirSync(path.join(root, '.gsd', 'memory'), { recursive: true });
    const result = buildFileIndex(root, {});
    assert(result.coverage.fragment_listing_failed, 'expected coverage.fragment_listing_failed to record the enumeration failure');
    assert(/simulated enumeration failure/.test(result.coverage.fragment_listing_failed), 'expected the failure reason to be carried, got: ' + result.coverage.fragment_listing_failed);
    assertEq(result.partial, true, 'an unreadable store must mark the result partial');
    const md = renderIndex(result, {});
    assert(md.includes('fragment_listing_failed'), 'expected a prominent warning inside the coverage section');
    assert(md.includes('não porque o store esteja vazio'), 'the warning must distinguish "could not read" from "empty"');
  } finally {
    fs.readdirSync = realReaddirSync;
    cleanup(root);
  }
});

test('R3: a genuinely empty store does NOT claim a listing failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));
  try {
    fs.mkdirSync(path.join(root, '.gsd', 'memory'), { recursive: true });
    const result = buildFileIndex(root, {});
    assertEq(result.coverage.fragment_listing_failed, null, 'an empty store must report no listing failure');
    const md = renderIndex(result, {});
    assert(!md.includes('fragment_listing_failed'), 'an empty store must not render the read-failure warning');
  } finally {
    cleanup(root);
  }
});

test('R5: a fact citing both the path and its unique basename yields ONE row, not two', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js`; note that forge-alpha.js is the only copy.', mem_id: 'mem-dupe' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const entry = result.entries.find((e) => e.file === 'scripts/forge-alpha.js');
    assert(entry, 'expected an entry for scripts/forge-alpha.js');
    const rows = entry.facts.filter((f) => f.mem_id === 'mem-dupe');
    assertEq(rows.length, 1, 'a fact must appear ONCE per resolved target file, not once per citation');
    assert(rows[0].line === null || typeof rows[0].line === 'number', 'the first citation line must be kept');
  } finally {
    cleanup(root);
  }
});

test('R6: pipe-bearing raw citation and mem_id keep the coverage table at 4 columns', () => {
  // Reachability first: findDynamicCandidates scans `\S+`, so a pipe lands in raw.
  const cites = extractCitations('Veja a|b*.js ali.');
  const dyn = cites.find((c) => c.raw.includes('|'));
  assert(dyn, 'expected a pipe-bearing raw citation to be reachable from prose');

  const result = {
    entries: [],
    partial: false,
    coverage: {
      fragments_read: 1,
      facts_total: 1,
      facts_with_resolved: 0,
      citations_total: 1,
      citations_resolved: 0,
      files_indexed: 0,
      facts_unresolved_only: [],
      facts_without_citation: [],
      unreadable_fragments: [],
      unresolved: [{ raw: dyn.raw, reason: 'dynamic', count: 1, example_mem_id: 'mem-x|y' }],
      fragment_listing_failed: null,
    },
  };
  const md = renderIndex(result, {});
  const tableRows = md.split('\n').filter((l) => l.startsWith('|') && !/^\|-+/.test(l.replace(/\|/g, '|')));
  assert(tableRows.length >= 2, 'expected a header row and at least one data row');
  for (const row of tableRows) {
    if (/^\|[-|]+\|$/.test(row.replace(/\s/g, ''))) continue; // separator
    // Split on UNESCAPED pipes only — an escaped `\|` is a literal, not a column break.
    const cols = row.split(/(?<!\\)\|/);
    assertEq(cols.length, 6, `expected a 4-column row (6 split parts), got ${cols.length} for: ${row}`);
  }
});

// ── Section 7: real-path containment (review-triage R1) ───────────────────────
// Lexical containment is not enough: existsSync/statSync FOLLOW symlinks, so a
// link inside the repo pointing outside would get stat'd and resolved.
console.log('\nSection 7: real-path containment against symlink escape\n');

test('a symlink escaping the root is classified outside-root, not resolved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mi-realpath-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mi-realpath-out-'));
  try {
    const secret = path.join(outside, 'secret.md');
    fs.writeFileSync(secret, '# outside the root\n', 'utf8');
    const link = path.join(root, 'secret.md');
    try {
      fs.symlinkSync(secret, link, 'file');
    } catch (e) {
      // symlinkSync returns EPERM on Windows without the privilege. Skip LOUDLY —
      // a silently skipped test is the failure class this milestone fights.
      console.log(`      ⚠ SKIPPED: cannot create a symlink here (${e.code || e.message}) — real-symlink escape not exercised on this machine`);
      return;
    }

    // Sanity: the link really does resolve outside, so the test has teeth.
    assert(fs.existsSync(link), 'fixture symlink should be followable');

    const res = resolveCitation({ path: 'secret.md', raw: 'secret.md', pattern: 'path' }, root, null);
    assertEq(res.state, 'UNRESOLVED', 'a symlink escaping the root must not resolve');
    assertEq(res.reason, 'outside-root', 'escape must be reported as outside-root');
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test('a symlink pointing INSIDE the root still resolves (linked layouts must not break)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mi-realpath-in-'));
  try {
    const real = path.join(root, 'lib', 'real.js');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, '// real\n', 'utf8');
    const link = path.join(root, 'alias.js');
    try {
      fs.symlinkSync(real, link, 'file');
    } catch (e) {
      console.log(`      ⚠ SKIPPED: cannot create a symlink here (${e.code || e.message}) — inside-root link not exercised on this machine`);
      return;
    }
    const res = resolveCitation({ path: 'alias.js', raw: 'alias.js', pattern: 'path' }, root, null);
    assertEq(res.state, 'RESOLVED', 'an inside-root symlink must still resolve');
    assertEq(res.file, 'alias.js', 'resolution reports the cited path, not the link target');
  } finally {
    cleanup(root);
  }
});

test('a nonexistent citation is still not-found, never a realpath ENOENT throw', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mi-realpath-enoent-'));
  try {
    for (const p of ['scripts/nao-existe.js', 'a/b/c/deep/missing.md', 'missing.md']) {
      const res = resolveCitation({ path: p, raw: p, pattern: 'path' }, root, null);
      assertEq(res.state, 'UNRESOLVED', `${p} should stay unresolved`);
      assertEq(res.reason, 'not-found', `${p} should keep its not-found reason`);
    }
  } finally {
    cleanup(root);
  }
});

// ── Section N: fragments the store drops (dogfood defect) ────────────────────
// Measured on a real store: 144 `.md` files on disk, listFragments returned 116,
// and the 28 dropped files were mentioned NOWHERE in the artifact. The synthetic
// fixtures never caught it because they only ever build well-formed unit IDs.
console.log('\nSection N: fragments skipped by the store\n');

test('a .md file the store drops is enumerated in coverage AND in the artifact', () => {
  const root = mkStore(
    [{ unitId: 'TASK-001', text: 'Ver `scripts/forge-alpha.js` para o fix.', mem_id: 'MEM-SK1' }],
    ['scripts/forge-alpha.js']
  );
  try {
    // Filenames observed verbatim in the real store — not parseable as storage keys.
    const dropped = ['S02-T01.md', 'S01-T01.md'];
    for (const name of dropped) {
      fs.writeFileSync(path.join(root, '.gsd', 'memory', name), '# orphan fragment\n', 'utf8');
    }

    const result = buildFileIndex(root, {});
    assertEq(
      result.coverage.fragments_skipped_by_store,
      ['S01-T01.md', 'S02-T01.md'],
      'dropped files must be enumerated, sorted (determinism)'
    );

    const md = renderIndex(result, {});
    assert(md.includes('### Fragmentos descartados pelo store'), 'expected the skipped-fragments section');
    for (const name of dropped) {
      assert(md.includes('`' + name + '`'), `expected ${name} rendered in the artifact`);
    }
    assert(md.includes('AUSENTES deste índice'), 'expected the consequence to be legible in the artifact');

    // The well-formed fragment still indexed — the report never suppresses coverage.
    assert(
      result.entries.some((e) => e.file === 'scripts/forge-alpha.js'),
      'the well-formed fragment must still be indexed'
    );

    // Citation sum invariant untouched by the new field.
    const sumUnresolved = result.coverage.unresolved.reduce((n, u) => n + u.count, 0);
    assertEq(
      result.coverage.citations_resolved + sumUnresolved,
      result.coverage.citations_total,
      'sum invariant must survive the new fragment-level field'
    );
  } finally {
    cleanup(root);
  }
});

test('a clean store still renders the skipped section explicitly (empty, never omitted)', () => {
  const root = mkStore(
    [{ unitId: 'TASK-001', text: 'Ver `scripts/forge-alpha.js`.', mem_id: 'MEM-SK2' }],
    ['scripts/forge-alpha.js']
  );
  try {
    const result = buildFileIndex(root, {});
    assertEq(result.coverage.fragments_skipped_by_store, [], 'a clean store skips nothing');
    const md = renderIndex(result, {});
    assert(md.includes('### Fragmentos descartados pelo store'), 'section is unconditional');
    assert(md.includes('_Nenhum arquivo de `.gsd/memory/` foi descartado pelo store._'), 'empty state must be stated, not omitted');
  } finally {
    cleanup(root);
  }
});

test('absent .gsd/memory keeps working — the report never becomes a crash path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-mi-skip-absent-'));
  try {
    const result = buildFileIndex(root, {});
    assertEq(result.coverage.fragments_skipped_by_store, [], 'no memory dir → empty list, no throw');
    const md = renderIndex(result, {});
    assert(md.includes('### Fragmentos descartados pelo store'), 'section still rendered without a memory dir');
  } finally {
    cleanup(root);
  }
});

// ── Section 15: --file query mode (T01) ──────────────────────────────────────
console.log('\nSection 15: --file query mode\n');

test('queryIndex: repeated --file returns only the requested files', () => {
  const root = mkStore(
    [
      { unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-q-1' },
      { unitId: 'T02', text: 'Fixed `scripts/forge-beta.js` today.', mem_id: 'mem-q-2' },
      { unitId: 'T03', text: 'Fixed `scripts/forge-gamma.js` today.', mem_id: 'mem-q-3' },
    ],
    ['scripts/forge-alpha.js', 'scripts/forge-beta.js', 'scripts/forge-gamma.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const query = queryIndex(result, ['scripts/forge-alpha.js', 'scripts/forge-beta.js']);
    assertEq(query.matched.length, 2, 'expected two matched requests');
    const matchedFiles = query.matched.flatMap((m) => m.entries.map((e) => e.file)).sort();
    assertEq(matchedFiles, ['scripts/forge-alpha.js', 'scripts/forge-beta.js']);
    assert(!matchedFiles.includes('scripts/forge-gamma.js'), 'gamma was not requested and must not leak into the result');
    assertEq(query.unmatched.length, 0);
  } finally {
    cleanup(root);
  }
});

test('queryIndex: matches by basename when the exact relative path was not requested', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-q-4' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const query = queryIndex(result, ['forge-alpha.js']);
    assertEq(query.matched.length, 1, 'expected one matched request via basename');
    assertEq(query.matched[0].entries[0].file, 'scripts/forge-alpha.js');
    assertEq(query.unmatched.length, 0);
  } finally {
    cleanup(root);
  }
});

test('queryIndex: normalizes backslash separators and a leading ./ the same way on both sides', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-q-5' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const query = queryIndex(result, ['./scripts\\forge-alpha.js']);
    assertEq(query.matched.length, 1, 'expected the normalized request to match the normalized entry');
    assertEq(query.unmatched.length, 0);
  } finally {
    cleanup(root);
  }
});

test('queryIndex: a requested file with no fact is enumerated in unmatched with a named reason, never silently dropped', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-q-6' }],
    ['scripts/forge-alpha.js', 'scripts/forge-nobody-cites-this.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    const query = queryIndex(result, ['scripts/forge-alpha.js', 'scripts/forge-nobody-cites-this.js']);
    assertEq(query.matched.length, 1);
    assertEq(query.unmatched.length, 1);
    assertEq(query.unmatched[0].requested, 'scripts/forge-nobody-cites-this.js');
    assertEq(query.unmatched[0].reason, 'no-facts-for-file');

    const md = renderQuery(result, query);
    assert(md.includes('## Arquivos sem fato'), 'expected the unconditional "sem fato" section');
    assert(md.includes('scripts/forge-nobody-cites-this.js'), 'the unmatched file must be enumerated in the markdown, never omitted');
  } finally {
    cleanup(root);
  }
});

test('renderQuery: an unmatched-only request still renders the section (never omitted)', () => {
  const root = mkStore([], []);
  try {
    const result = buildFileIndex(root, {});
    const query = queryIndex(result, ['scripts/never-existed.js']);
    const md = renderQuery(result, query);
    assert(md.includes('## Arquivos sem fato'), 'section must be unconditional even with zero matches');
    assert(md.includes('scripts/never-existed.js'));
  } finally {
    cleanup(root);
  }
});

test('renderQuery: a store that could not be read shows a read-failure warning, never "sem fato" as if it were confirmed-empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));
  const realReaddirSync = fs.readdirSync;
  fs.readdirSync = function (p, ...rest) {
    if (typeof p === 'string' && p.replace(/\\/g, '/').endsWith('/.gsd/memory')) {
      throw new Error('EIO: simulated enumeration failure');
    }
    return realReaddirSync.call(fs, p, ...rest);
  };
  try {
    fs.mkdirSync(path.join(root, '.gsd', 'memory'), { recursive: true });
    const result = buildFileIndex(root, {});
    assert(result.coverage.fragment_listing_failed, 'fixture must actually trigger the read failure');
    const query = queryIndex(result, ['scripts/whatever.js']);
    const md = renderQuery(result, query);
    assert(/N[ãa]o foi poss[íi]vel LER/.test(md), 'expected the read-failure warning at the top of the query output');
    assert(md.includes('NÃO foram confirmados como "sem fato"'), 'must not assert absence of facts when the store could not be read');
  } finally {
    fs.readdirSync = realReaddirSync;
    cleanup(root);
  }
});

// ── Section 15 mutation control (T01 step 9) ─────────────────────────────────
// A test that passes both with AND without the filter proves nothing about the
// filter. This case calls queryIndex with a filter that DOES exclude entries
// (via the real implementation) and independently re-derives the expected
// "everything, unfiltered" shape to prove the two are NOT the same set — a
// mechanical guard that a future edit collapsing the filter to a no-op (e.g.
// `matched = entries.map(...)` regardless of `requested`) would turn red here.
test('mutation control: querying a strict subset yields fewer matched files than the full index — the filter is not a no-op', () => {
  const root = mkStore(
    [
      { unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-q-7' },
      { unitId: 'T02', text: 'Fixed `scripts/forge-beta.js` today.', mem_id: 'mem-q-8' },
      { unitId: 'T03', text: 'Fixed `scripts/forge-gamma.js` today.', mem_id: 'mem-q-9' },
    ],
    ['scripts/forge-alpha.js', 'scripts/forge-beta.js', 'scripts/forge-gamma.js'],
  );
  try {
    const result = buildFileIndex(root, {});
    assertEq(result.entries.length, 3, 'fixture sanity: three files must be indexed');

    const query = queryIndex(result, ['scripts/forge-alpha.js']);
    const matchedFiles = query.matched.flatMap((m) => m.entries.map((e) => e.file));

    assertEq(matchedFiles.length, 1, 'a real filter over a strict subset must return fewer files than the full index');
    assert(matchedFiles.length < result.entries.length, 'matched set must be a strict subset of the full index — a filter that returns everything is not measuring anything');
    assertEq(matchedFiles, ['scripts/forge-alpha.js']);
  } finally {
    cleanup(root);
  }
});

// ── Section 16: CLI --file (T01) ──────────────────────────────────────────────
console.log('\nSection 16: CLI --file\n');

test('CLI: --file --write exits 2 with {error} in stderr (never overwrites the full artifact with a filtered one)', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-cli-3' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--file', 'scripts/forge-alpha.js', '--write', '--cwd', root], { encoding: 'utf8' });
    assertEq(res.status, 2, `expected exit 2 for --file + --write, got ${res.status}`);
    let parsed;
    assert((() => { parsed = JSON.parse(res.stderr.trim()); return true; })(), 'stderr must be valid JSON with an {error} field');
    assert(typeof parsed.error === 'string' && parsed.error.length > 0, 'expected a non-empty {error} message');
  } finally {
    cleanup(root);
  }
});

test('CLI: --file alone does NOT write the artifact, even though a bare run without flags would', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-cli-4' }],
    ['scripts/forge-alpha.js'],
  );
  try {
    const artifactPath = path.join(root, DEFAULT_INDEX_PATH);
    assert(!fs.existsSync(artifactPath), 'fixture sanity: artifact must not pre-exist');

    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--file', 'scripts/forge-alpha.js', '--cwd', root], { encoding: 'utf8' });
    assertEq(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
    assert(!fs.existsSync(artifactPath), 'query mode with --file must NEVER write .gsd/MEMORY-INDEX-BY-FILE.md');
    assert(res.stdout.includes('scripts/forge-alpha.js'), 'expected the queried file in stdout');
  } finally {
    cleanup(root);
  }
});

test('CLI: --file repeated on the command line accumulates, unmatched files are still enumerated', () => {
  const root = mkStore(
    [{ unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-cli-5' }],
    ['scripts/forge-alpha.js', 'scripts/forge-nothing.js'],
  );
  try {
    const res = spawnSync(process.execPath, [
      SCRIPT_PATH, '--file', 'scripts/forge-alpha.js', '--file', 'scripts/forge-nothing.js', '--cwd', root,
    ], { encoding: 'utf8' });
    assertEq(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
    assert(res.stdout.includes('scripts/forge-alpha.js'), 'expected the matched file');
    assert(res.stdout.includes('## Arquivos sem fato'), 'expected the unmatched section');
    assert(res.stdout.includes('scripts/forge-nothing.js'), 'the unmatched file must be enumerated, not silently dropped');
  } finally {
    cleanup(root);
  }
});

test('CLI: --file missing a value exits 2', () => {
  const res = spawnSync(process.execPath, [SCRIPT_PATH, '--file'], { encoding: 'utf8' });
  assertEq(res.status, 2, `expected exit 2 for --file missing a value, got ${res.status}`);
});

test('CLI: --file --json prints an additive envelope with query.requested/matched/unmatched, existing keys intact', () => {
  const root = mkStore(
    [
      { unitId: 'T01', text: 'Fixed `scripts/forge-alpha.js` today.', mem_id: 'mem-cli-6' },
    ],
    ['scripts/forge-alpha.js', 'scripts/forge-missing.js'],
  );
  try {
    const res = spawnSync(process.execPath, [
      SCRIPT_PATH, '--file', 'scripts/forge-alpha.js', '--file', 'scripts/forge-missing.js', '--json', '--cwd', root,
    ], { encoding: 'utf8' });
    assertEq(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
    const stdoutLines = res.stdout.split('\n').filter((l) => l.length > 0);
    assertEq(stdoutLines.length, 1, 'expected exactly one non-empty stdout line');
    const parsed = JSON.parse(stdoutLines[0]);

    // Existing envelope keys stay intact (additive convention, T01 must-have).
    assert(typeof parsed.coverage === 'object', 'expected the existing coverage object');
    assert(typeof parsed.counts === 'object', 'expected the existing counts object');
    assertEq(parsed.out, null, 'query mode never writes, out must be null');

    // New, additive key.
    assert(typeof parsed.query === 'object', 'expected the additive query key');
    assertEq(parsed.query.requested, ['scripts/forge-alpha.js', 'scripts/forge-missing.js']);
    assertEq(parsed.query.matched.length, 1);
    assertEq(parsed.query.unmatched.length, 1);
    assertEq(parsed.query.unmatched[0].requested, 'scripts/forge-missing.js');
    assertEq(parsed.query.unmatched[0].reason, 'no-facts-for-file');
  } finally {
    cleanup(root);
  }
});

test('CLI: an unreadable store queried with --file reports a read-failure, distinct from "no facts"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-index-test-'));
  try {
    // Same fixture shape used across this suite for an EISDIR-style unreadable
    // store: a memory dir that exists but is not a real directory forces the
    // guard/listing path to fail without relying on platform-specific perms.
    fs.writeFileSync(path.join(root, '.gsd-memory-marker'), '', 'utf8'); // fixture sanity anchor, unused by the CLI
    fs.mkdirSync(path.join(root, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gsd', 'memory'), '', 'utf8'); // FILE where a DIR is expected → readdirSync throws ENOTDIR/EISDIR-shaped

    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--file', 'scripts/whatever.js', '--json', '--cwd', root], { encoding: 'utf8' });
    assertEq(res.status, 0, `expected exit 0 (a read failure is reported, not a crash), got ${res.status}; stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert(parsed.coverage.fragment_listing_failed, 'expected fragment_listing_failed to be set for a store that cannot be enumerated');
    assertEq(parsed.partial, true, 'an unreadable store must mark the result partial');
  } finally {
    cleanup(root);
  }
});

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failed ? 1 : 0);
