#!/usr/bin/env node
// forge-capture.test.js — deterministic cutover guard for S02 (auto-capture at the
// three-plus-one existing junctions: review follow-up, plan-gate defer, blocked unit,
// memory boundary).
//
// Two halves:
//   1. Text invariants — fs.readFileSync assertions on the six edited files, proving
//      the § Item capture spec, its consumers and the memory boundary guard landed
//      and stayed consistent (byte-identical blocked-marker blocks in particular).
//   2. Live CLI round-trips — forge-items.js --add/--validate/--list exercised in a
//      temp dir (never the live .gsd/), proving the dedup-guard primitive the skills
//      rely on actually behaves.
//
// This is the in-place verification path for RISK blocker 3 (see S02-PLAN.md § Notes):
// repo text edits under shared/ and skills/ are inert until `./install.sh` re-installs
// them to ~/.claude/ — this test proves the source-of-truth text and CLI mechanics
// without requiring that reinstall.
//
// Run: node scripts/forge-capture.test.js  (exits 0 = all pass, 1 = any fail)
// Auto-discovered by run-tests.js via the *.test.js glob in scripts/ — same
// mechanism as forge-items.test.js, zero registration code.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const items = require('./forge-items.js');
const ITEMS_CLI = path.join(__dirname, 'forge-items.js');
const REPO_ROOT = path.resolve(__dirname, '..');

// ── Harness ───────────────────────────────────────────────────────────────────
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

function withTmpDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-capture-test-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args, opts) {
  opts = opts || {};
  return spawnSync(process.execPath, [ITEMS_CLI, ...args], { cwd: opts.cwd, encoding: 'utf8' });
}

function addViaCli(dir, payload) {
  return spawnSync(process.execPath, [ITEMS_CLI, '--add', '--cwd', dir], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });
}

function read(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

function extractBlockedMarkerBlock(content) {
  const m = content.match(/<!-- item-capture:blocked:start -->([\s\S]*?)<!-- item-capture:blocked:end -->/);
  return m ? m[1] : null;
}

console.log('\n=== forge-capture.test.js — S02 cutover guard ===\n');

// ── 1. Text invariants ───────────────────────────────────────────────────────
console.log('1. Text invariants — six edited files');

const forgeReview = read('shared/forge-review.md');
const forgePlanGate = read('shared/forge-plan-gate.md');
const forgeAutoSkill = read('skills/forge-auto/SKILL.md');
const forgeNextSkill = read('skills/forge-next/SKILL.md');
const forgeTaskSkill = read('skills/forge-task/SKILL.md');
const forgeMemoryAgent = read('agents/forge-memory.md');

test('(a) forge-review.md has § Item capture section with the --add invocation and all five source formats', () => {
  assert(forgeReview.includes('## Item capture'), 'missing "## Item capture" heading');
  assert(/forge-items\.js.*--add|--add.*forge-items\.js/.test(forgeReview.replace(/\n/g, ' ')) ||
    forgeReview.includes('forge-items.js') && forgeReview.includes('--add'),
    'missing forge-items.js --add invocation reference');
  const sourceFormats = [
    'review/{S##}/{R#}',
    'review/{TASK_ID}/{R#}',
    'plan-gate/{S##}',
    'plan-gate/{TASK_ID}',
    'blocked/{unit_type}/{unit_id}',
  ];
  for (const fmt of sourceFormats) {
    assert(forgeReview.includes(fmt), `missing source format "${fmt}" in forge-review.md`);
  }
});

test('(a) forge-review.md has the pointer-line format', () => {
  assert(forgeReview.includes('Pointer-line format'), 'missing "Pointer-line format" label');
  assert(forgeReview.includes('{I-id} — {title}') || forgeReview.includes('{I-id} — {title}'),
    'missing pointer-line shape "{I-id} — {title}"');
});

test('(b) old gate option text "Registra em KNOWLEDGE.md e segue" is gone from forge-review.md', () => {
  assert(!forgeReview.includes('Registra em KNOWLEDGE.md e segue'),
    'old gate option text must be removed — cutover leaves item capture as single destination');
});

test('(c) forge-plan-gate.md Deferir references item creation + marker pointer', () => {
  assert(forgePlanGate.includes('Deferir'), 'missing "Deferir" option text');
  assert(/create an item/i.test(forgePlanGate), 'Deferir resolution must reference item creation');
  assert(forgePlanGate.includes('§ Item capture'), 'must cross-reference shared/forge-review.md § Item capture');
  assert(/marker/i.test(forgePlanGate), 'must reference recording in the marker (pointer)');
});

test('(d) forge-auto/SKILL.md and forge-next/SKILL.md both contain the item-capture:blocked marker pair', () => {
  for (const [name, content] of [['forge-auto', forgeAutoSkill], ['forge-next', forgeNextSkill]]) {
    assert(content.includes('<!-- item-capture:blocked:start -->'),
      `${name}/SKILL.md missing item-capture:blocked:start marker`);
    assert(content.includes('<!-- item-capture:blocked:end -->'),
      `${name}/SKILL.md missing item-capture:blocked:end marker`);
  }
});

test('(d) the two blocked-marker blocks are byte-identical across forge-auto and forge-next', () => {
  const autoBlock = extractBlockedMarkerBlock(forgeAutoSkill);
  const nextBlock = extractBlockedMarkerBlock(forgeNextSkill);
  assert(autoBlock !== null, 'could not extract blocked block from forge-auto/SKILL.md');
  assert(nextBlock !== null, 'could not extract blocked block from forge-next/SKILL.md');
  assertEq(autoBlock, nextBlock, 'blocked-marker blocks must be byte-identical (RISK warning 2 guard)');
});

test('(e) forge-task keeps review capture and binds the shared plan-gate capture', () => {
  assert(forgeTaskSkill.includes('review/{TASK_ID}/{R#}'),
    'forge-task/SKILL.md missing source review/{TASK_ID}/{R#} reference (Step 7b)');
  const gate = forgeTaskSkill.slice(forgeTaskSkill.indexOf('### Step 4.5'), forgeTaskSkill.indexOf('### Step 5 '));
  assert(gate.includes('read and execute') && gate.includes('shared/forge-plan-gate.md') && gate.includes('task/{TASK_ID}'),
    'forge-task must execute the shared gate with its task binding');
  assert(forgePlanGate.includes('plan-gate/{TASK_ID}') && forgePlanGate.includes('shared/forge-review.md § Item capture'),
    'the delegated gate must preserve task item capture');
});

test('(f) forge-memory.md contains the 4th gate question and both worked examples', () => {
  assert(/4\.\s*\*\*Fact, not pending action\?\*\*/.test(forgeMemoryAgent),
    'missing 4th quality-gate question "Fact, not pending action?"');
  assert(forgeMemoryAgent.includes('Pendência é item'),
    'missing the pendência-é-item boundary phrase');
  assert(forgeMemoryAgent.includes('Worked examples (question 4)'),
    'missing "Worked examples (question 4)" heading');
  assert(forgeMemoryAgent.includes('PASSES:'), 'missing PASSES worked example');
  assert(forgeMemoryAgent.includes('REJECTED:'), 'missing REJECTED worked example');
});

test('(g) no junction instructs writing full follow-up CONTENT to KNOWLEDGE.md § Review follow-ups (pointer-only invariant)', () => {
  const filesToCheck = [
    ['shared/forge-review.md', forgeReview],
    ['shared/forge-plan-gate.md', forgePlanGate],
    ['skills/forge-auto/SKILL.md', forgeAutoSkill],
    ['skills/forge-next/SKILL.md', forgeNextSkill],
    ['skills/forge-task/SKILL.md', forgeTaskSkill],
  ];
  for (const [name, content] of filesToCheck) {
    if (!content.includes('KNOWLEDGE.md')) continue;
    // Every mention of KNOWLEDGE.md § Review follow-ups near "append"/"pointer" must
    // be scoped to the pointer line only — never "full content".
    assert(!/append.{0,80}full (content|body)/is.test(content),
      `${name}: found a phrase instructing to append full content to KNOWLEDGE.md`);
  }
});

// ── 2. Live CLI round-trips ──────────────────────────────────────────────────
console.log('\n2. Live CLI round-trips (temp dirs only)');

test('auto item with source review/S99/R1, status inbox — validates OK', () => {
  withTmpDir(dir => {
    const add = addViaCli(dir, { title: 'Review follow-up test', origin: 'auto', source: 'review/S99/R1', status: 'inbox' });
    assertEq(add.status, 0, `--add should exit 0: ${add.stderr}`);
    const created = JSON.parse(add.stdout);
    const validate = runCli(['--validate', created.id, '--cwd', dir]);
    assertEq(validate.status, 0, `--validate should exit 0: ${validate.stderr}`);
    const result = JSON.parse(validate.stdout);
    assertEq(result.valid, true, `item should be valid: ${JSON.stringify(result)}`);
  });
});

test('auto item WITHOUT source fails validation (exit 1)', () => {
  withTmpDir(dir => {
    const dirItems = items.itemsDir(dir);
    fs.mkdirSync(dirItems, { recursive: true });
    const id = 'I-20260729120000-auto-nosource';
    fs.writeFileSync(path.join(dirItems, `${id}.md`), items.serializeItem({
      id, title: 'Auto without source', status: 'inbox', origin: 'auto',
      created: new Date().toISOString(), updated: new Date().toISOString(),
    }));
    const validate = runCli(['--validate', id, '--cwd', dir]);
    assertEq(validate.status, 1, `--validate should exit 1 for auto item without source`);
  });
});

test('blocked-shaped item (source blocked/T99, status triaged) is created and listed', () => {
  withTmpDir(dir => {
    const add = addViaCli(dir, {
      title: '[context_overflow] execute-task/T99 bloqueado — resumo',
      origin: 'auto',
      source: 'blocked/T99',
      status: 'triaged',
    });
    assertEq(add.status, 0, `--add should exit 0: ${add.stderr}`);
    const created = JSON.parse(add.stdout);
    const list = runCli(['--list', '--json', '--cwd', dir]);
    assertEq(list.status, 0, `--list should exit 0: ${list.stderr}`);
    const listed = JSON.parse(list.stdout);
    const found = listed.find(it => it.id === created.id);
    assert(found, `created blocked item ${created.id} must appear in --list --json`);
    assertEq(found.source, 'blocked/T99', 'source must be preserved');
    assertEq(found.status, 'triaged', 'status must be preserved');
  });
});

test('dedup-guard primitive — a second --add with the same source is detectable via --list --json', () => {
  withTmpDir(dir => {
    const first = addViaCli(dir, { title: 'First block', origin: 'auto', source: 'blocked/T42', status: 'triaged' });
    assertEq(first.status, 0, `first --add should exit 0: ${first.stderr}`);
    const firstCreated = JSON.parse(first.stdout);

    // Simulate the dedup-guard check the skills perform before a second --add:
    // list, filter by source, filter out done/dropped.
    const list = runCli(['--list', '--json', '--cwd', dir]);
    assertEq(list.status, 0, `--list should exit 0: ${list.stderr}`);
    const listed = JSON.parse(list.stdout);
    const existingOpen = listed.filter(it => it.source === 'blocked/T42' && it.status !== 'done' && it.status !== 'dropped');
    assert(existingOpen.length === 1, `dedup check must find exactly one open item with source blocked/T42, found ${existingOpen.length}`);
    assertEq(existingOpen[0].id, firstCreated.id, 'the found open item must be the one just created');
  });
});

// Note: this suite deliberately does NOT spawn `node scripts/run-tests.js` on
// itself — run-tests.js auto-discovers every scripts/*.test.js file (including
// this one), so shelling out to it here would recurse infinitely. The truth
// "run-tests.js passes end-to-end" is verified by running run-tests.js directly
// (see T06-PLAN.md Step 5 and the verification gate below), which in turn
// executes this file as one of its suites.

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ✗ ${f.name}`);
    console.log(`      ${f.error}`);
  }
  process.exit(1);
}
process.exit(0);
