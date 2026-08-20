'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const memory = require('./forge-memory');
const ledger = require('./forge-ledger');
const distill = require('./forge-distill');
const { serializeGroup } = require('./forge-grouped-file');

const ID = 'M123';
const script = path.join(__dirname, 'forge-distill.js');

function fixture() {
  // realpath, never the raw mkdtemp: this cwd is handed to production, which resolves
  // it — on macOS os.tmpdir() is a symlink to /private/..., so an unresolved fixture
  // root makes every path comparison against production output fail. Do not "simplify".
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-distill-t02-')));
  const root = path.join(cwd, '.gsd', 'milestones', ID);
  fs.mkdirSync(path.join(root, 'slices', 'S02'), { recursive: true });
  ledger.writeFragment(cwd, { id: ID, title: 'fixture' });
  fs.writeFileSync(path.join(root, `${ID}-SUMMARY.md`), '---\nkey_decisions:\n  - "Prefer a stable boundary"\nprovides:\n  - "A testable distiller"\n---\n\n## Forward Intelligence\n- Keep the source order\n');
  fs.writeFileSync(path.join(root, `${ID}-CONTEXT.md`), '## Decisions from Session\n- Preserve audit information\n');
  fs.writeFileSync(path.join(root, 'slices', 'S02', 'S02-SUMMARY.md'), '---\npatterns_established:\n  - "Use the memory API"\n---\n');
  fs.writeFileSync(path.join(root, 'slices', 'S02', 'S02-REVIEW.md'), 'Review verdict: green\n');
  fs.writeFileSync(path.join(root, 'slices', 'S02', 'S02-MEASUREMENT.md'), 'Result: conceded\n');
  return cwd;
}

function candidate(cwd, needle = 'stable') {
  const plan = distill.planDistill(cwd, ID);
  assert.strictEqual(plan.eligibility.ok, true, JSON.stringify(plan));
  return plan.candidates.find(item => item.text.toLowerCase().includes(needle)) || plan.candidates[0];
}

function selectionFor(cwd, verdicts) { return { milestone: ID, verdicts }; }
function completeSelection(cwd, verdicts) { const judged = new Set(verdicts.map(item => item.candidate_id)); return selectionFor(cwd, [...verdicts, ...distill.planDistill(cwd, ID).candidates.filter(item => !judged.has(item.id)).map(reject)]); }
function keep(c, rank = 1, text = c.text, category = 'pattern') { return { candidate_id: c.id, keep: true, gate: { project_specific: true, non_obvious: true, durable: true }, category, text, rank }; }
function reject(c) { return { candidate_id: c.id, keep: false, reason: 'not durable enough' }; }
function writeSelection(selection) { const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'selection-')), 'selection.json'); fs.writeFileSync(file, JSON.stringify(selection)); return file; }
function digest(cwd) {
  const rows = [];
  function walk(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else rows.push([path.relative(cwd, file), fs.readFileSync(file).toString('hex')]); } }
  walk(cwd); return crypto.createHash('sha1').update(JSON.stringify(rows.sort())).digest('hex');
}
function expectFailure(fn, reason) { assert.throws(fn, error => error.reason === reason, `expected ${reason}`); }

// Schema and helper contract.
{
  const cwd = fixture(); const c = candidate(cwd);
  const file = writeSelection(selectionFor(cwd, [keep(c)]));
  assert.deepStrictEqual(distill.loadSelection(file).milestone, ID);
  assert.strictEqual(distill.dstMemId(ID, 'pattern', c.text).length, 16);
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [{ ...keep(c), gate: { project_specific: true, non_obvious: false, durable: true } }]))), 'gate-shape');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [{ ...keep(c), category: 'made-up' }]))), 'invalid-category');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [{ ...keep(c), text: 'two\nlines' }]))), 'multiline-text');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [{ ...keep(c), rank: 0 }, { ...keep(c, 0, 'other') }]))), 'selection-unreadable');
  assert.strictEqual(distill.loadSelection(writeSelection(selectionFor(cwd, [reject(c)]))).verdicts[0].keep, false);
}

// Successful apply writes the exact fact shape through forge-memory.
{
  const cwd = fixture(); const c = candidate(cwd); const selection = selectionFor(cwd, [keep(c)]);
  const result = distill.applyDistill(cwd, ID, completeSelection(cwd, selection.verdicts));
  assert.strictEqual(result.verdict, 'APPLIED'); assert.strictEqual(result.written, true);
  const stored = memory.readFragment(cwd, ID);
  assert.strictEqual(stored.unit_id, ID); assert.strictEqual(stored.facts.length, 1);
  assert.deepStrictEqual(Object.keys(stored.facts[0]).sort(), ['category', 'confidence_base', 'created_at', 'mem_id', 'source_unit', 'text'].sort());
  assert.strictEqual(stored.facts[0].source_unit, `distill/${ID}`);
  assert.strictEqual(memory.listFragments(cwd).some(item => item.unitId === ID), true);
}

// Re-execution is byte stable and uses the API, not raw store writes.
{
  const cwd = fixture(); const c = candidate(cwd); const selection = selectionFor(cwd, [keep(c)]);
  const complete = completeSelection(cwd, selection.verdicts); distill.applyDistill(cwd, ID, complete); const before = fs.readFileSync(memory.readFragment(cwd, ID) && memory.listFragments(cwd).find(e => e.unitId === ID).path);
  const second = distill.applyDistill(cwd, ID, complete); const after = fs.readFileSync(memory.listFragments(cwd).find(e => e.unitId === ID).path);
  assert.deepStrictEqual(after, before); assert.deepStrictEqual(second.already_present, [c.id]);
}

// Fresh-plan binding: unknown and unjudged candidates refuse without mutation.
{
  const cwd = fixture(); const c = candidate(cwd); const before = digest(cwd);
  expectFailure(() => distill.applyDistill(cwd, ID, selectionFor(cwd, [{ ...keep(c), candidate_id: 'c-nope' }])), 'unknown-candidate');
  assert.strictEqual(digest(cwd), before);
  const other = distill.planDistill(cwd, ID).candidates.find(item => item.id !== c.id);
  expectFailure(() => distill.applyDistill(cwd, ID, selectionFor(cwd, [keep(c)])), 'unjudged-candidates');
  assert.strictEqual(digest(cwd), before); assert(other);
}

// Wrapper citation is rejected, including the literal blocker fixture.
{
  const cwd = fixture(); const review = distill.planDistill(cwd, ID).candidates.find(c => c.source_file.includes('S02-REVIEW'));
  expectFailure(() => distill.applyDistill(cwd, ID, completeSelection(cwd, [keep(review, 1, 'See slices/S02/S02-REVIEW.md')])), 'wrapper-citation');
  assert.strictEqual(memory.readFragment(cwd, ID), null);
}

// Existing MEM facts do not consume budget; an existing divergent DST id collides.
{
  const cwd = fixture(); const c = candidate(cwd); memory.writeFragment(cwd, { unit_id: ID, facts: [{ mem_id: 'MEM001', category: 'pattern', text: 'old', created_at: '2026-01-01', source_unit: 'test' }] });
  const id = distill.dstMemId(ID, 'pattern', c.text); memory.writeFragment(cwd, { unit_id: ID, facts: [{ mem_id: id, category: 'gotcha', text: 'different', created_at: '2026-01-01', source_unit: 'test' }] });
  const before = digest(cwd); expectFailure(() => distill.applyDistill(cwd, ID, completeSelection(cwd, [keep(c)])), 'mem-id-collision'); assert.strictEqual(digest(cwd), before);
}

// Eleven unique keeps exceed the hard post-merge DST budget.
{
  const cwd = fixture(); const plan = distill.planDistill(cwd, ID); const base = plan.candidates[0];
  const verdicts = Array.from({ length: 11 }, (_, index) => keep(base, index + 1, `fact ${index + 1}`));
  // Give each synthetic verdict a known candidate id by adding corresponding source candidates.
  for (let i = 1; i < 11; i++) verdicts[i].candidate_id = plan.candidates[i % plan.candidates.length].id;
  const unique = new Map(verdicts.map((v, i) => [`${v.candidate_id}-${i}`, { ...v, candidate_id: plan.candidates[i % plan.candidates.length].id }]));
  // The production validator intentionally requires one verdict per fresh candidate; use a fresh fixture with 11 candidates.
  const many = fixture(); const root = path.join(many, '.gsd', 'milestones', ID); fs.writeFileSync(path.join(root, `${ID}-SUMMARY.md`), `---\nprovides:\n${Array.from({ length: 12 }, (_, i) => `  - "budget fact ${i}"`).join('\n')}\n---\n`);
  const manyPlan = distill.planDistill(many, ID); assert(manyPlan.candidates.length >= 11, `budget fixture candidates=${manyPlan.candidates.length}`);
  const all = manyPlan.candidates.slice(0, 11).map((item, i) => keep(item, i + 1, `budget ${i}`));
  const before = digest(many);
  const judged = new Set(all.map(item => item.candidate_id));
  const budgetSelection = selectionFor(many, [...all, ...manyPlan.candidates.filter(item => !judged.has(item.id)).map(reject)]);
  expectFailure(() => distill.applyDistill(many, ID, budgetSelection), 'budget-exceeded');
  assert.strictEqual(digest(many), before);
  assert(unique.size > 0);
}

// CLI boundaries: apply requires selection, and prints a preview before apply output.
{
  const cwd = fixture(); const noSelection = spawnSync(process.execPath, [script, '--milestone', ID, '--cwd', cwd, '--apply'], { encoding: 'utf8' });
  assert.strictEqual(noSelection.status, 2); assert(noSelection.stderr.includes('--apply exige --selection'));
  const c = candidate(cwd); const file = writeSelection(selectionFor(cwd, [keep(c), ...distill.planDistill(cwd, ID).candidates.filter(x => x.id !== c.id).map(reject)]));
  const applied = spawnSync(process.execPath, [script, '--milestone', ID, '--cwd', cwd, '--selection', file, '--apply'], { encoding: 'utf8' });
  assert.strictEqual(applied.status, 0, applied.stderr); assert(applied.stdout.indexOf('"preview":true') < applied.stdout.indexOf('"verdict":"APPLIED"'));
}

console.log('PASS: forge-distill T02 apply tests');

// Additional boundary assertions keep each named refusal independently observable.
{
  const cwd = fixture();
  const c = candidate(cwd);
  const before = digest(cwd);
  expectFailure(() => distill.applyDistill(cwd, ID, { milestone: ID, verdicts: [] }), 'unjudged-candidates');
  assert.strictEqual(digest(cwd), before);
  expectFailure(() => distill.applyDistill(cwd, ID, { milestone: 'M999', verdicts: [] }), 'selection-unreadable');
  assert.strictEqual(digest(cwd), before);
  assert(c.id.startsWith('c-'));
}

{
  const cwd = fixture();
  const c = candidate(cwd);
  const badGate = { candidate_id: c.id, keep: true, gate: { project_specific: true, non_obvious: true, durable: 1 }, category: 'pattern', text: 'x', rank: 1 };
  const badCategory = { candidate_id: c.id, keep: true, gate: { project_specific: true, non_obvious: true, durable: true }, category: 'unknown', text: 'x', rank: 1 };
  const badText = { candidate_id: c.id, keep: true, gate: { project_specific: true, non_obvious: true, durable: true }, category: 'pattern', text: 'x\rline', rank: 1 };
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [badGate]))), 'gate-shape');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [badCategory]))), 'invalid-category');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [badText]))), 'multiline-text');
}

{
  const cwd = fixture();
  const c = candidate(cwd);
  const noRank = { ...keep(c), rank: '1' };
  const duplicateRank = [keep(c, 1), { ...keep(c, 1, 'second'), candidate_id: 'other' }];
  const duplicateId = [keep(c), keep(c, 2, 'same id')];
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, [noRank]))), 'selection-unreadable');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, duplicateRank))), 'selection-unreadable');
  expectFailure(() => distill.loadSelection(writeSelection(selectionFor(cwd, duplicateId))), 'selection-unreadable');
}

{
  const cwd = fixture();
  const c = candidate(cwd);
  const citations = [
    '.gsd/milestones/M123/M123-SUMMARY.md',
    '.gsd\\tasks\\T02-PLAN.md',
    'slices/S02/S02-REVIEW.md',
    'tasks/T02/',
    'S02-REVIEW.md',
    'T02-SUMMARY.md',
  ];
  for (const text of citations) {
    const before = digest(cwd);
    expectFailure(() => distill.applyDistill(cwd, ID, completeSelection(cwd, [keep(c, 1, text)])), 'wrapper-citation');
    assert.strictEqual(digest(cwd), before);
  }
}

{
  const facts = Array.from({ length: 10 }, (_, i) => ({ mem_id: `DST-existing-${i}` }));
  const fresh = [{ candidate_id: 'new', rank: 4 }];
  try {
    distill._private.checkBudget(facts, fresh);
    assert.fail('budget must reject the eleventh DST fact');
  } catch (error) {
    assert.strictEqual(error.reason, 'budget-exceeded');
    assert(error.detail.includes('new'));
    assert(error.detail.includes('4'));
  }
  assert.strictEqual(distill._private.checkBudget(facts.slice(0, 9), fresh), 10);
}

{
  const cwd = fixture();
  const c = candidate(cwd);
  const selection = completeSelection(cwd, [keep(c)]);
  const preview = distill._private.previewText(distill.planDistill(cwd, ID), selection);
  const parsed = JSON.parse(preview);
  assert.strictEqual(parsed.preview, true);
  assert.strictEqual(parsed.milestone, ID);
  assert.strictEqual(parsed.verdicts, selection.verdicts.length);
  assert.strictEqual(parsed.keeps, 1);
}

{
  assert.strictEqual(distill._private.parseArgs(['--milestone', ID]).apply, false);
  assert.strictEqual(distill._private.parseArgs(['--milestone', ID, '--selection', 'x', '--apply']).apply, true);
  assert.throws(() => distill._private.parseArgs(['--milestone', ID, '--apply']), /--apply exige --selection/);
  assert.throws(() => distill._private.parseArgs(['--milestone', ID, '--selection']), /exige um valor/);
  assert.throws(() => distill._private.parseArgs(['--milestone', ID, '--wat']), /argumento desconhecido/);
}

{
  const cwd = fixture();
  const c = candidate(cwd);
  const selection = completeSelection(cwd, [keep(c)]);
  const first = distill.applyDistill(cwd, ID, selection);
  const listed = memory.listFragments(cwd);
  const entry = listed.find(item => item.unitId === ID);
  assert(entry);
  assert.strictEqual(entry.milestoneId, null);
  assert.strictEqual(path.isAbsolute(entry.path), true);
  const read = memory.readFragment(cwd, ID);
  assert.strictEqual(read.facts.filter(fact => /^DST-/.test(fact.mem_id)).length, first.dst_facts_total);
  const second = distill.applyDistill(cwd, ID, selection);
  assert.strictEqual(second.written, false);
  assert.deepStrictEqual(second.already_present, [c.id]);
}

{
  const cwd = fixture();
  const c = candidate(cwd);
  const selection = completeSelection(cwd, [keep(c)]);
  memory.writeFragment(cwd, { unit_id: ID, facts: [] });
  const before = digest(cwd);
  const result = distill.applyDistill(cwd, ID, selection);
  assert.strictEqual(result.verdict, 'APPLIED');
  assert.notStrictEqual(digest(cwd), before);
  const facts = memory.readFragment(cwd, ID).facts;
  assert.strictEqual(facts[0].source_unit, `distill/${ID}`);
}

// A distilled fact that never reaches the projection the workers read is inert
// green: the milestone pays for the distillation and nobody reads the result.
// Defect this guards: `distill-facts-invisible-in-projection` (T03 dogfood, §7.2).
{
  const projection = require('./forge-projection');
  const cwd = fixture();
  const c = candidate(cwd);
  const selection = completeSelection(cwd, [keep(c)]);
  const applied = distill.applyDistill(cwd, ID, selection);
  assert.strictEqual(applied.verdict, 'APPLIED');

  // 1. The written fact carries the field the projection ranks on.
  const written = memory.readFragment(cwd, ID).facts.find(fact => /^DST-/.test(fact.mem_id));
  assert(written, 'expected a DST fact on disk');
  assert.strictEqual(Number(written.confidence_base), distill._private.DISTILL_CONFIDENCE_BASE);

  // 2. Synthetic store big enough that MEMORY_CAP=50 actually bites: 40 facts
  // above the distilled band and 30 below it, no ties with 0.80 on either side.
  // Ranked, the DST fact sits at position 41 — inside the cap. At the absent-field
  // default of 0.5 it would sit below all 70 fillers, at position 71 — outside.
  const created_at = String(written.created_at);
  const filler = (n, base) => Array.from({ length: n }, (_, i) => ({
    mem_id: `MEM${base * 1000 + i}`, category: 'pattern',
    text: `filler ${base} ${i}`, confidence_base: base, created_at,
  }));
  memory.writeFragment(cwd, { unit_id: 'M999', facts: [...filler(40, 0.9), ...filler(30, 0.6)] });

  const ranked = projection.projectMemoryEntries(cwd);
  const pos = ranked.findIndex(entry => entry.fact.mem_id === written.mem_id);
  assert(pos >= 0 && pos < 50, `DST fact ranked at ${pos} of ${ranked.length} — outside MEMORY_CAP`);

  // 3. The rendered artifact — the bytes a worker is handed — names it.
  const rendered = projection.renderMemory(cwd);
  assert(rendered.includes(written.mem_id), 'render memory omitted the distilled fact');
  assert.strictEqual((rendered.match(/gsd-auto-memory mem_id:/g) || []).length, 50, 'cap not exercised');
}

// R1 — the quality gate is not bypassable by calling applyDistill directly.
// loadSelection is the CLI door; applyDistill is exported and callable. Each
// malformed kept verdict below is refused BY NAME on the direct call, with the
// store left untouched. Reverting validateSelectionShape out of
// validateAgainstPlan makes all three of these accept and write.
{
  const cwd = fixture();
  const c = candidate(cwd);
  const cases = [
    ['gate-shape', { gate: { project_specific: true, non_obvious: false, durable: true } }],
    ['gate-shape', { gate: { project_specific: true, non_obvious: true, durable: 1 } }],
    ['invalid-category', { category: 'made-up' }],
    ['multiline-text', { text: 'two\nlines' }],
    ['multiline-text', { text: 'carriage\rreturn' }],
  ];
  for (const [reason, override] of cases) {
    const before = digest(cwd);
    const verdicts = completeSelection(cwd, [{ ...keep(c), ...override }]).verdicts;
    expectFailure(() => distill.applyDistill(cwd, ID, { milestone: ID, verdicts }), reason);
    assert.strictEqual(digest(cwd), before, `${reason}: store mutated by a refused apply`);
    assert.strictEqual(memory.readFragment(cwd, ID), null, `${reason}: fragment written`);
  }
  // Same fences, same reasons, through the other entry point — one validator.
  expectFailure(() => distill._private.validateSelectionShape({ milestone: ID, verdicts: [{ ...keep(c), category: 'made-up' }] }), 'invalid-category');
}

// R2 — batch origin is not store origin. `already_present` is a claim about the
// persisted store; a duplicate payload inside the same selection is reported
// separately as `deduped_in_batch`, so a first-ever apply never claims a fact
// pre-existed.
{
  const cwd = fixture();
  const plan = distill.planDistill(cwd, ID);
  const [a, b] = plan.candidates;
  assert(a && b && a.id !== b.id, 'fixture needs two distinct candidates');
  // Two distinct candidates judged into the SAME category+text ⇒ same DST id.
  const text = 'one payload judged twice in one batch';
  const first = distill.applyDistill(cwd, ID, completeSelection(cwd, [keep(a, 1, text), keep(b, 2, text)]));
  assert.strictEqual(first.verdict, 'APPLIED');
  assert.deepStrictEqual(first.already_present, [], 'first-ever apply must not claim a prior run');
  assert.strictEqual(first.deduped_in_batch.length, 1, JSON.stringify(first.deduped_in_batch));
  assert.strictEqual(first.deduped_in_batch[0].candidate_id, b.id);
  assert.strictEqual(first.deduped_in_batch[0].mem_id, distill.dstMemId(ID, 'pattern', text));
  assert.strictEqual(memory.readFragment(cwd, ID).facts.filter(f => /^DST-/.test(f.mem_id)).length, 1);

  // Re-running the same selection: now the fact IS persisted — store origin.
  const second = distill.applyDistill(cwd, ID, completeSelection(cwd, [keep(a, 1, text), keep(b, 2, text)]));
  assert.strictEqual(second.written, false);
  assert.deepStrictEqual(second.already_present.sort(), [a.id, b.id].sort(), 'second run must be store-origin for both');
  assert.deepStrictEqual(second.deduped_in_batch, [], 'nothing is fresh, so nothing dedupes in batch');
}

// R3 — the accepted single-operator race is narrowed by a re-read: facts that
// landed between the first budget check and the write are refused by name
// (`budget-exceeded-on-recheck`) instead of silently overflowing the budget.
{
  const cwd = fixture();
  const c = candidate(cwd);
  const selection = completeSelection(cwd, [keep(c)]);
  // The competing apply must land INSIDE the window — after the first snapshot,
  // before the write. Nothing else can express that, so the store read is driven
  // directly: the first read is empty (budget passes, as it did before this fix),
  // the second read carries the ten DST facts the competitor just merged.
  const realRead = memory.readFragment;
  const raced = Array.from({ length: 10 }, (_, i) => ({ mem_id: `DST-race${String(i).padStart(6, '0')}`, category: 'pattern', text: `raced ${i}`, created_at: '2026-01-01', source_unit: 'other-operator' }));
  let reads = 0;
  memory.readFragment = function (...args) {
    reads++;
    return reads === 1 ? realRead.apply(this, args) : { unit_id: ID, facts: raced };
  };
  const before = digest(cwd);
  try {
    expectFailure(() => distill.applyDistill(cwd, ID, selection), 'budget-exceeded-on-recheck');
  } finally {
    memory.readFragment = realRead;
  }
  assert(reads >= 2, 'applyDistill must re-read the store before writing');
  assert.strictEqual(digest(cwd), before, 'a refused apply must not write');

  // Without a competitor the same path applies normally — the narrowing does not
  // refuse honest work.
  const clean = fixture();
  const cc = candidate(clean);
  assert.strictEqual(distill.applyDistill(clean, ID, completeSelection(clean, [keep(cc)])).verdict, 'APPLIED');
}

// R4 — the dead `merged` computation is gone from the collision result.
{
  const checked = distill._private.checkCollisions([], [{ candidate_id: 'x', category: 'pattern', text: 'y', rank: 1 }], ID);
  assert.deepStrictEqual(Object.keys(checked).sort(), ['already', 'dedupedInBatch', 'fresh']);
  assert.strictEqual('merged' in checked, false, 'merged had no consumer and was removed');
}

console.log('PASS: forge-distill review-fix/S03 (R1-R4)');

// ---------------------------------------------------------------------------
// S01/T02 — wrapper root resolution (IN-01) and suffix location under the D5
// two-layer ambiguity rule (IN-02). Every fixture lives in a fresh tmp dir; the
// live `.gsd/` of this repo is never read.
// ---------------------------------------------------------------------------

const TASK_ID = 'T-20260101010101-demo';
const MS_ID = 'M-20260811134201-controle-contexto-gsd';
const SUMMARY_BODY = '---\nkey_decisions:\n  - "Resolve the wrapper where it lives"\n---\n';

// realpath, never the raw mkdtemp: this cwd is handed to production (planDistill /
// checkEligibility), which resolves it — on macOS os.tmpdir() is a symlink to
// /private/..., so an unresolved fixture root breaks path comparison. Do not "simplify".
function tmpCwd() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-distill-t02-in-'))); }

// Builds a wrapper under `.gsd/<bucket>/<id>` with an explicit file name list, so a
// test can express "two files match the suffix" without depending on the id shape.
function wrapperFixture(bucket, id, files) {
  const cwd = tmpCwd();
  const root = path.join(cwd, '.gsd', bucket, id);
  fs.mkdirSync(root, { recursive: true });
  ledger.writeFragment(cwd, { id, title: 'fixture' });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
  return { cwd, root };
}

// IN-01 positive — a task wrapper is eligible and yields candidates. Before this
// change `checkEligibility` built the milestones path unconditionally and this
// exact shape returned `wrapper-not-found`, so the plan never reached extraction.
{
  const { cwd } = wrapperFixture('tasks', TASK_ID, { [`${TASK_ID}-SUMMARY.md`]: SUMMARY_BODY });
  const plan = distill.planDistill(cwd, TASK_ID);
  assert.strictEqual(plan.eligibility.ok, true, JSON.stringify(plan.eligibility));
  assert(plan.candidates.length >= 1, 'a task wrapper must produce at least one candidate');
  assert(plan.candidates.some(c => c.text.includes('Resolve the wrapper where it lives')), JSON.stringify(plan.candidates));
}

// IN-01 negative — neither root exists: the original refusal survives verbatim,
// and the detail still names the milestones path (not the tasks one).
{
  const cwd = tmpCwd();
  const eligibility = distill.checkEligibility(cwd, TASK_ID);
  assert.strictEqual(eligibility.ok, false);
  assert.strictEqual(eligibility.reason, 'wrapper-not-found');
  assert(eligibility.detail.includes(path.join('.gsd', 'milestones', TASK_ID)), eligibility.detail);
}

// IN-02 case 1 — zero suffix matches: the exact-name fallback keeps the current
// `absent` skip, unchanged.
{
  const { cwd } = wrapperFixture('milestones', MS_ID, { 'NOTES.md': 'no summary here\n' });
  const plan = distill.planDistill(cwd, MS_ID);
  assert.strictEqual(plan.eligibility.ok, true);
  assert(plan.skipped.some(s => s.file.endsWith(`${MS_ID}-SUMMARY.md`) && s.reason === 'absent'), JSON.stringify(plan.skipped));
  assert.deepStrictEqual(plan.notes, []);
}

// IN-02 case 2 — a single non-canonical match (SUMMARY stored without the slug)
// is read. The exact name never matched, so this file used to be `absent`.
{
  const shortName = 'M-20260811134201-SUMMARY.md';
  const { cwd } = wrapperFixture('milestones', MS_ID, { [shortName]: SUMMARY_BODY });
  const plan = distill.planDistill(cwd, MS_ID);
  assert(plan.candidates.some(c => c.source_file.endsWith(shortName)), JSON.stringify(plan));
  assert.strictEqual(plan.skipped.some(s => s.reason.startsWith('ambiguous-suffix')), false);
}

// IN-02 case 3 — two matches, exactly one in the strong form: D5 resolves to the
// canonical file AND names the ignored one. This is the shape of the single real
// occurrence measured in T01's census (a wrapper holding both the canonical
// SUMMARY and `review-fix-triage-SUMMARY.md`).
{
  const canonical = `${MS_ID}-SUMMARY.md`;
  const other = 'review-fix-triage-SUMMARY.md';
  const { cwd } = wrapperFixture('milestones', MS_ID, {
    [canonical]: SUMMARY_BODY,
    [other]: '---\nkey_decisions:\n  - "Triage leftovers"\n---\n',
  });
  const plan = distill.planDistill(cwd, MS_ID);
  assert(plan.candidates.some(c => c.source_file.endsWith(canonical)), 'canonical summary must be read');
  assert.strictEqual(plan.candidates.some(c => c.source_file.endsWith(other)), false, 'the ignored file must not be a source');
  const note = plan.notes.find(n => n.note.startsWith('ambiguous-suffix-resolved:'));
  assert(note, JSON.stringify(plan.notes));
  assert(note.note.includes(canonical) && note.note.includes(other), note.note);
}

// IN-02 case 4 — two matches, none in the strong form: refusal naming BOTH, and
// neither file is read as a source. The refusal is data in an exit-0 plan.
{
  const a = 'alpha-SUMMARY.md';
  const b = 'beta-SUMMARY.md';
  const { cwd } = wrapperFixture('milestones', MS_ID, { [a]: SUMMARY_BODY, [b]: SUMMARY_BODY });
  const plan = distill.planDistill(cwd, MS_ID);
  const refusal = plan.skipped.find(s => s.reason.startsWith('ambiguous-suffix:'));
  assert(refusal, JSON.stringify(plan.skipped));
  assert(refusal.reason.includes(a) && refusal.reason.includes(b), refusal.reason);
  assert.strictEqual(plan.candidates.some(c => c.source_file.endsWith(a) || c.source_file.endsWith(b)), false, 'a refused ambiguity reads nothing');
}

// IN-02 case 5 — three matches with TWO in the strong form: the strong form does
// not disambiguate, so the refusal names every candidate.
{
  const one = `${MS_ID}-SUMMARY.md`;
  const two = `${MS_ID}-extra-SUMMARY.md`;
  const three = 'review-fix-triage-SUMMARY.md';
  const { cwd } = wrapperFixture('milestones', MS_ID, { [one]: SUMMARY_BODY, [two]: SUMMARY_BODY, [three]: SUMMARY_BODY });
  const plan = distill.planDistill(cwd, MS_ID);
  const refusal = plan.skipped.find(s => s.reason.startsWith('ambiguous-suffix:'));
  assert(refusal, JSON.stringify(plan.skipped));
  for (const name of [one, two, three]) assert(refusal.reason.includes(name), `${name} missing from ${refusal.reason}`);
  assert.strictEqual(plan.candidates.length, 0, 'no candidate may come from a refused ambiguity');
}

// R1 (review-fix) — the ONLY suffix match is an unrelated auxiliary summary. The
// single-match branch used to read it as THE unit summary; cardinality is not
// provenance. Refusal is NAMED data in an exit-0 plan, and nothing is read.
{
  const other = 'review-fix-triage-SUMMARY.md';
  const { cwd } = wrapperFixture('milestones', MS_ID, {
    [other]: '---\nkey_decisions:\n  - "Triage leftovers"\n---\n',
  });
  const plan = distill.planDistill(cwd, MS_ID);
  assert.strictEqual(plan.eligibility.ok, true, JSON.stringify(plan.eligibility));
  assert.strictEqual(plan.candidates.some(c => c.source_file.endsWith(other)), false, 'an unrelated summary must never become a source');
  assert.strictEqual(plan.candidates.some(c => c.text.includes('Triage leftovers')), false, JSON.stringify(plan.candidates));
  const refusal = plan.skipped.find(s => s.reason.startsWith('unrelated-suffix-match:'));
  assert(refusal, JSON.stringify(plan.skipped));
  assert(refusal.reason.includes(other) && refusal.reason.includes(MS_ID), refusal.reason);
}

// R1 unit-level — the prefix rule accepts the canonical and the shortened WDMA
// form, and refuses an unrelated stem, at the single-match branch.
{
  const short = 'M-20260811134201-SUMMARY.md';
  const { root } = wrapperFixture('milestones', MS_ID, { [short]: SUMMARY_BODY });
  assert(distill._private.findBySuffix(root, '-SUMMARY.md', MS_ID).file.endsWith(short), 'shortened WDMA form must still be accepted');
  const bad = wrapperFixture('milestones', MS_ID, { 'review-fix-triage-SUMMARY.md': SUMMARY_BODY });
  const refused = distill._private.findBySuffix(bad.root, '-SUMMARY.md', MS_ID);
  assert.strictEqual(refused.file, null);
  assert(refused.refusal.startsWith('unrelated-suffix-match:'), refused.refusal);
}

// Unit-level contract of findBySuffix, exercised directly through _private so the
// four branches are pinned independently of the plan shape.
{
  const { cwd, root } = wrapperFixture('milestones', MS_ID, { [`${MS_ID}-SUMMARY.md`]: SUMMARY_BODY });
  const found = distill._private.findBySuffix(root, '-SUMMARY.md', MS_ID);
  assert(found.file.endsWith(`${MS_ID}-SUMMARY.md`));
  assert.strictEqual(found.refusal, undefined);
  assert.deepStrictEqual(distill._private.findBySuffix(path.join(cwd, 'nope'), '-SUMMARY.md', MS_ID), { file: null });
  assert.strictEqual(distill._private.wrapperRoot(cwd, MS_ID), root);
}

console.log('PASS: forge-distill S01/T02 (IN-01 wrapper root, IN-02 D5 suffix rule)');

// ---------------------------------------------------------------------------
// S02/T02 — closed-scope widening of the extractor: inline `key: [...]` (IN-03),
// bullets under the two NAMED bold labels, the pt-BR / suffixed section titles
// matched by PREFIX (IN-06), and id uniqueness in `plan.candidates`. Every case
// below extracted ZERO (or duplicated) before this task; each is a positive
// control by reversion, recorded in T02-SUMMARY.
// ---------------------------------------------------------------------------

// One SUMMARY file in a milestone wrapper, nothing else: the CONTEXT is `absent`
// and there are no slices, so `plan.candidates` is exactly what the SUMMARY body
// yields. That exactness is what lets the counts below be assertions instead of
// "at least one".
function summaryOnly(body) {
  const { cwd } = wrapperFixture('milestones', MS_ID, { [`${MS_ID}-SUMMARY.md`]: body });
  const plan = distill.planDistill(cwd, MS_ID);
  assert.strictEqual(plan.eligibility.ok, true, JSON.stringify(plan.eligibility));
  return plan;
}
function texts(plan) { return plan.candidates.map(c => c.text); }
function kindsOf(plan, kind) { return plan.candidates.filter(c => c.source_kind === kind).map(c => c.text); }

// IN-03 — inline YAML. The bracket content is ONE item and the comma inside the
// item survives byte for byte; splitting on it would cut the fact in half.
{
  const INLINE = 'payload whitelisted {reason, status?} antes do write';
  const plan = summaryOnly(`---\nkey_decisions: [${INLINE}]\n---\n`);
  const hits = plan.candidates.filter(c => c.source_kind === 'frontmatter:key_decisions');
  assert.strictEqual(hits.length, 1, `inline form must yield exactly one candidate: ${JSON.stringify(texts(plan))}`);
  assert.strictEqual(hits[0].text, INLINE, hits[0].text);
  assert(hits[0].text.includes(', status?}'), 'the comma inside the item must survive');
}

// IN-03 negative control — the BLOCK form keeps extracting one candidate per
// item, unchanged. The inline branch must not swallow the list it did not touch.
{
  const plan = summaryOnly('---\nkey_decisions:\n  - "Primeiro, com vírgula"\n  - "Segundo"\n---\n');
  assert.deepStrictEqual(kindsOf(plan, 'frontmatter:key_decisions'), ['Primeiro, com vírgula', 'Segundo']);
}

// IN-03 edge — an empty inline list yields no candidate and does not fall through
// to the block branch (which would then eat unrelated indented lines below it).
{
  const plan = summaryOnly('---\nkey_decisions: []\nprovides:\n  - "Um extrator testável"\n---\n');
  assert.deepStrictEqual(kindsOf(plan, 'frontmatter:key_decisions'), []);
  assert.deepStrictEqual(kindsOf(plan, 'frontmatter:provides'), ['Um extrator testável']);
}

// Patch 4 — the two NAMED bold labels are read, each under its own stable kind.
// The capture stops at the next heading or the next bold label, so the prose and
// the bullets that follow the section never enter as deliveries.
{
  const plan = summaryOnly([
    '# Resumo',
    '',
    '**Entregas:**',
    '- scripts/forge-distill.js — ramo inline do YAML',
    '- scripts/forge-distill.test.js — controle por reversão',
    '',
    '**Notas soltas:**',
    '- este bullet pertence a outro rótulo',
    '',
    '## Prosa',
    '',
    'Um parágrafo qualquer que não é bullet.',
    '',
    '- bullet de prosa que NÃO é entrega',
    '',
    '**Key Deliverables:**',
    '- forge-distill exports labelledBullets',
    '',
  ].join('\n'));
  assert.deepStrictEqual(kindsOf(plan, 'label:entregas'), [
    'scripts/forge-distill.js — ramo inline do YAML',
    'scripts/forge-distill.test.js — controle por reversão',
  ]);
  assert.deepStrictEqual(kindsOf(plan, 'label:key-deliverables'), ['forge-distill exports labelledBullets']);
  // The boundary is the point of the test: no bullet outside the two named labels
  // may be attributed to a NAMED label. (S02/T03 shipped the ANY path, so the
  // bullet under `**Notas soltas:**` is now a candidate — under `label-any:`,
  // never under `label:entregas`. The two strays that sit under no label at all
  // stay out entirely.)
  const named = plan.candidates.filter(c => String(c.source_kind).startsWith('label:')).map(c => c.text);
  assert.strictEqual(named.includes('este bullet pertence a outro rótulo'), false, JSON.stringify(named));
  for (const stray of ['bullet de prosa que NÃO é entrega', 'Um parágrafo qualquer que não é bullet.']) {
    assert.strictEqual(texts(plan).includes(stray), false, `${stray} must not be extracted`);
  }
}

// Patch 4 unit level — `labelledBullets` returns plain strings and stops at the
// next bold label, exercised directly so the boundary is pinned independently of
// the plan shape.
{
  const body = '**Entregas:**\n- um\n- dois\n\n**Outro:**\n- três\n';
  assert.deepStrictEqual(distill._private.labelledBullets(body, 'Entregas'), ['um', 'dois']);
  assert.deepStrictEqual(distill._private.labelledBullets(body, 'Key Deliverables'), []);
}

// IN-06 — pt-BR and suffixed titles match by PREFIX. Both headings below carry a
// parenthetical suffix that the previous `\s*$` anchor could never match, so both
// sections extracted zero.
{
  const plan = summaryOnly([
    '## Decisões-chave do milestone (acumuladas)',
    '- D1: o extrator amplia, a arbitragem filtra',
    '',
    '## Key Decisions (acumulado)',
    '- D2: candidato não é fato',
    '',
  ].join('\n'));
  assert(texts(plan).includes('D1: o extrator amplia, a arbitragem filtra'), JSON.stringify(texts(plan)));
  assert(texts(plan).includes('D2: candidato não é fato'), JSON.stringify(texts(plan)));
  assert.strictEqual(plan.candidates.length, 2, JSON.stringify(plan.candidates));
}

// IN-06 / anti-duplication — `## Decisões-chave do milestone` is matched by TWO
// entries of HEADINGS (the full title and the `Decisões-chave` prefix), so the
// same section is extracted twice with different kinds. The candidate id is
// sha1(source \x00 text) WITHOUT the kind, so both copies carry the same id.
// Uniqueness is the assertion; which of the two kinds survives is not.
{
  const plan = summaryOnly('## Decisões-chave do milestone\n- D3: um bullet, uma vez só\n');
  assert.strictEqual(plan.candidates.length, 1, `duplicate section extraction must be deduped: ${JSON.stringify(plan.candidates)}`);
  assert.strictEqual(plan.candidates[0].text, 'D3: um bullet, uma vez só');
  assert.strictEqual(plan.candidates_total, 1, 'candidates_total must not double-count');
  const ids = plan.candidates.map(c => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'ids must be unique');
}

// Anti-duplication, wider — a wrapper mixing every widened path at once still
// carries no repeated id, and the reported total equals the array length.
{
  const plan = summaryOnly([
    '---',
    'key_decisions: [inline com, vírgula]',
    'provides:',
    '  - "Um extrator ampliado"',
    '---',
    '',
    '## Decisões-chave do milestone (acumuladas)',
    '- D4: dedupe por id',
    '',
    '## Decisões travadas',
    '- D5: patch 5 não embarca aqui',
    '',
    '**Entregas:**',
    '- um arquivo tocado',
    '',
  ].join('\n'));
  const ids = plan.candidates.map(c => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, `repeated id: ${JSON.stringify(ids)}`);
  assert.strictEqual(plan.candidates_total, plan.candidates.length);
  assert.strictEqual(plan.candidates.length, 5, JSON.stringify(texts(plan)));
}

console.log('PASS: forge-distill S02/T02 (IN-03 inline, named labels, IN-06 prefix, id dedupe)');

// ---------------------------------------------------------------------------
// S02/T03 — the generalisation to ANY bold label (`anyLabelledBullets`) shipped
// WITH containment, because the measurement fired the explosion ruler: on this
// repo's population of 17 local units the total went 468 -> 533 raw candidates
// (1.14x, far from the 3x clause) but TWO units crossed from under 100 verdicts
// to over it (87 -> 113 and 93 -> 120), which is the second clause of the rule.
// The T02 scope fence asserting the ABSENCE of `anyLabelledBullets` is therefore
// gone: it recorded a decision that this task measured and reversed.
// ---------------------------------------------------------------------------

// The fence of T02 inverted — a bullet under an arbitrary bold label is now a
// candidate, and it carries the `label-any:` kind so the containment (and any
// reader) can tell the generalised path from every other source.
{
  const plan = summaryOnly('**Files touched (9):**\n- scripts/forge-distill.js\n');
  assert.strictEqual('anyLabelledBullets' in distill._private, true, 'patch 5 shipped in T03');
  assert.deepStrictEqual(texts(plan), ['scripts/forge-distill.js'], JSON.stringify(texts(plan)));
  assert.deepStrictEqual(plan.candidates.map(c => c.source_kind), ['label-any:files-touched-9-']);
}

// The two NAMED labels are NOT extracted twice by the ANY path: `alreadyCovered`
// excludes them by case-insensitive name, so `label:entregas` has no `label-any:`
// twin and the id-uniqueness assertion of T02 stays green.
{
  const plan = summaryOnly('**Entregas:**\n- um arquivo tocado\n\n**Decisões registradas:**\n- D9: rótulo arbitrário entra\n');
  assert.deepStrictEqual(kindsOf(plan, 'label:entregas'), ['um arquivo tocado']);
  assert.deepStrictEqual(kindsOf(plan, 'label-any:decisões-registradas'), ['D9: rótulo arbitrário entra']);
  assert.strictEqual(plan.candidates.filter(c => c.text === 'um arquivo tocado').length, 1, JSON.stringify(plan.candidates));
  const ids = plan.candidates.map(c => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, `repeated id: ${JSON.stringify(ids)}`);
  assert.strictEqual(plan.candidates_total, plan.candidates.length);
}

// Unit level — `anyLabelledBullets` stops at the next heading or the next bold
// label and returns `{label, text}` pairs, exercised directly.
{
  const body = '**Files touched (9):**\n- um\n- dois\n\n**Entregas:**\n- três\n\n# Fim\n- quatro\n';
  assert.deepStrictEqual(distill._private.anyLabelledBullets(body, ['Entregas']), [
    { label: 'Files touched (9)', text: 'um' },
    { label: 'Files touched (9)', text: 'dois' },
  ]);
  // Case-insensitive exclusion: the caller passes the NAMED list as written.
  assert.deepStrictEqual(distill._private.anyLabelledBullets(body, ['entregas', 'files touched (9)']), []);
}

// Containment — the discard is enumerated BY NAME and reason, never a silent
// truncation, and the identity that IN-05 demands holds exactly:
//   len(discarded) == candidates_before_containment - candidates_total
{
  const CAP = distill._private.ANY_LABEL_UNIT_CAP;
  assert.strictEqual(CAP, 100);
  const gathered = [];
  for (let i = 0; i < CAP; i++) gathered.push({ id: `c-fm${i}`, source_file: 'a.md', source_kind: 'frontmatter:provides', text: `fato ${i}` });
  for (let i = 0; i < 7; i++) gathered.push({ id: `c-any${i}`, source_file: 'a.md', source_kind: 'label-any:files-touched', text: `bullet ${i}` });
  const contained = distill._private.containAnyLabels(gathered);
  assert.strictEqual(contained.accepted.length, CAP, 'the unit is already at the cap, so no ANY candidate is admitted');
  assert.strictEqual(contained.discarded.length, gathered.length - contained.accepted.length, 'IN-05 identity');
  assert.strictEqual(contained.discarded.length, 7);
  for (const item of contained.discarded) {
    assert.strictEqual(item.kind, 'label-any:files-touched');
    assert.strictEqual(item.label, 'files-touched');
    assert(item.id && item.text && item.source_file, JSON.stringify(item));
    assert(/^any-label-cap: /.test(item.reason), item.reason);
  }
  // Nothing outside the ANY path is ever discarded, even far above the cap.
  const onlyOwn = [];
  for (let i = 0; i < CAP + 50; i++) onlyOwn.push({ id: `c-x${i}`, source_file: 'a.md', source_kind: 'frontmatter:provides', text: `fato ${i}` });
  const wide = distill._private.containAnyLabels(onlyOwn);
  assert.strictEqual(wide.discarded.length, 0, 'the cap rations the widened path, it does not ration what already worked');
  assert.strictEqual(wide.accepted.length, CAP + 50);
}

// Containment is order-independent: an ANY candidate read BEFORE the unit's other
// sources must not get in ahead of them and leave the unit above the cap anyway.
{
  const CAP = distill._private.ANY_LABEL_UNIT_CAP;
  const gathered = [{ id: 'c-any-first', source_file: 'a.md', source_kind: 'label-any:files-touched', text: 'primeiro lido' }];
  for (let i = 0; i < CAP; i++) gathered.push({ id: `c-fm${i}`, source_file: 'b.md', source_kind: 'frontmatter:provides', text: `fato ${i}` });
  const contained = distill._private.containAnyLabels(gathered);
  assert.strictEqual(contained.accepted.length, CAP, JSON.stringify(contained.accepted.length));
  assert.deepStrictEqual(contained.discarded.map(d => d.id), ['c-any-first']);
}

// The plan carries the containment as ADDITIVE fields, and under the cap nothing
// is discarded — the identity holds trivially (0 == n - n), which is the shape the
// IN-05 demo reports with the real numbers in S02-MEASUREMENT.md.
{
  const plan = summaryOnly('**Files touched (9):**\n- scripts/forge-distill.js\n- scripts/forge-distill.test.js\n');
  assert.strictEqual(plan.candidates_before_containment, 2);
  assert.strictEqual(plan.candidates_total, 2);
  assert.deepStrictEqual(plan.discarded, []);
  assert.strictEqual(plan.discarded.length, plan.candidates_before_containment - plan.candidates_total);
}

console.log('PASS: forge-distill S02/T03 (ANY labels shipped with enumerated containment)');

// ---------------------------------------------------------------------------
// review-fix/S02 — R1 (quote-aware inline flow) and R2 (dedupe on the full
// digest). Each assertion below was verified biting by reverting the single line
// it pins: the suite aborts at the first failed assert, so a wholesale revert
// would prove one group and hide the rest.
// ---------------------------------------------------------------------------

// R1 — a fully quoted two-item flow is TWO candidates, and neither carries a
// quote artifact. Before the fix this produced the single corrupted candidate
// `first", "second` — YAML residue presented as fact text.
{
  const plan = summaryOnly('---\nkey_decisions: ["primeiro item", "segundo item"]\n---\n');
  assert.deepStrictEqual(kindsOf(plan, 'frontmatter:key_decisions'), ['primeiro item', 'segundo item'], JSON.stringify(texts(plan)));
  for (const text of texts(plan)) assert.strictEqual(/["']/.test(text), false, `quote artifact in candidate text: ${text}`);
}

// R1 — single-quoted single item: the quotes are consumed by the parser, not by
// a strip-first-and-last regex, and a comma inside the quotes survives.
{
  const plan = summaryOnly("---\nprovides: ['um item, com vírgula']\n---\n");
  assert.deepStrictEqual(kindsOf(plan, 'frontmatter:provides'), ['um item, com vírgula'], JSON.stringify(texts(plan)));
}

// R1 — a flow that is neither a bare scalar nor fully quoted is REFUSED BY NAME:
// zero candidates for that key, and the reason lands in the exit-0 plan. The
// point is that nothing is emitted, not that something better is guessed.
{
  const plan = summaryOnly('---\nkey_decisions: [bare, "quoted"]\nprovides:\n  - "intacto"\n---\n');
  assert.deepStrictEqual(kindsOf(plan, 'frontmatter:key_decisions'), [], JSON.stringify(texts(plan)));
  const named = plan.skipped.filter(s => /inline-flow-unparsed/.test(s.reason));
  assert.strictEqual(named.length, 1, `refusal must be named in the plan: ${JSON.stringify(plan.skipped)}`);
  assert(/key_decisions/.test(named[0].reason), named[0].reason);
  // The refusal is local to the offending key; the rest of the file still reads.
  assert.deepStrictEqual(kindsOf(plan, 'frontmatter:provides'), ['intacto']);
  assert.strictEqual(plan.eligibility.ok, true);
}

// R1 unit level — the three closed cases and the three refusal shapes, pinned
// independently of the plan.
{
  const parse = distill._private.parseInlineFlow;
  assert.deepStrictEqual(parse('payload whitelisted {reason, status?}'), { values: ['payload whitelisted {reason, status?}'] });
  assert.deepStrictEqual(parse('"a", "b, ainda a mesma", "c"'), { values: ['a', 'b, ainda a mesma', 'c'] });
  assert.deepStrictEqual(parse('   '), { values: [] });
  // A trailing comma is tolerated, and that is a decision, not an oversight: it
  // drops no item and emits no artifact, so refusing it would cost a candidate
  // for nothing. `["a", ]` is one item.
  assert.deepStrictEqual(parse('"a", '), { values: ['a'] });
  for (const bad of ['bare, "quoted"', '"unterminated', '"a" lixo', '"a", "b']) {
    const out = parse(bad);
    assert.strictEqual(out.values, undefined, `${bad} must not yield values`);
    assert(/^inline-flow-unparsed: /.test(out.refusal), `${bad} -> ${out.refusal}`);
  }
}

// R2 — the display id is 8 hex, but the dedupe key is the FULL digest. Two
// DIFFERENT (source, text) pairs sharing an 8-hex prefix both survive: the second
// is kept under a longer id and the event is named in `id_collisions`. Keyed on
// the truncated id (the previous behaviour) the second was dropped in silence.
{
  const assigner = distill._private.createIdAssigner();
  const a = 'deadbeef' + '0'.repeat(32);
  const b = 'deadbeef' + '1'.repeat(32);
  const idA = assigner.displayId(a, 'f.md', 'texto A');
  const idB = assigner.displayId(b, 'f.md', 'texto B');
  assert.strictEqual(idA, 'c-deadbeef');
  assert.notStrictEqual(idB, idA, 'a colliding prefix must not reuse the id');
  assert.strictEqual(idB, 'c-' + b.slice(0, 16));
  assert.strictEqual(assigner.collisions.length, 1, JSON.stringify(assigner.collisions));
  assert(/candidate-id-collision/.test(assigner.collisions[0].reason), assigner.collisions[0].reason);
  assert.strictEqual(assigner.collisions[0].collided_with, idA);
  assert.strictEqual(assigner.collisions[0].text, 'texto B');
  // Same digest twice is the genuine duplicate: same id, nothing reported.
  assert.strictEqual(assigner.displayId(a, 'f.md', 'texto A'), idA);
  assert.strictEqual(assigner.collisions.length, 1);
}

// R2 — the plan always carries the field, so "no collisions" is a reported
// outcome rather than an absent one, and real duplicates still collapse to one.
{
  const plan = summaryOnly('## Decisões-chave do milestone\n- D3: um bullet, uma vez só\n');
  assert.deepStrictEqual(plan.id_collisions, []);
  assert.strictEqual(plan.candidates.length, 1, JSON.stringify(plan.candidates));
}

// A1 (review PR #125) — a write REFUSED by the grouped-member quarantine is not
// an APPLIED one. Real fixture, not a monkeypatch: the milestone's own envelope is
// moved into a container (the mould from forge-memory-quarantine.test.js) and the
// loose file removed, so writeFragment takes the refusal branch for real.
// Before the fix this returned verdict APPLIED with `fragment_path` naming the
// quarantine sidecar, and `written: false` could not tell it apart from the
// idempotent no-op, which returns the very same value.
{
  const cwd = fixture(); const c = candidate(cwd);
  // Seed the milestone fragment, group it, drop the loose file.
  memory.writeFragment(cwd, { unit_id: ID, facts: [{ mem_id: 'MEM001', category: 'test', text: 'sealed fact', source: 'a1-test' }], stats: [] }, {});
  const loose = memory.fragmentPath(cwd, ID, {});
  const units = [{ id: memory.qualifiedStorageKey(ID, null), content: fs.readFileSync(loose) }];
  const container = path.join(memory.memoryDir(cwd), 'sweep-project-01.md');
  fs.writeFileSync(container, serializeGroup({ epoch: 'sweep-project-01', units }).buffer);
  fs.unlinkSync(loose);

  const originalWrite = process.stderr.write; // the refusal narrates on stderr by design
  let result;
  try { process.stderr.write = () => true; result = distill.applyDistill(cwd, ID, completeSelection(cwd, [keep(c)])); }
  finally { process.stderr.write = originalWrite; }

  assert.strictEqual(result.verdict, 'QUARANTINED', JSON.stringify(result));
  assert.strictEqual(result.fragment_path, null, 'the quarantine sidecar is NOT the fragment');
  assert.strictEqual(result.written, false);
  assert.strictEqual(result.reason, 'grouped-member');
  assert.strictEqual(result.container, container);
  assert(typeof result.remedy === 'string' && result.remedy.length > 0, 'the remedy must reach the consumer');
  assert(typeof result.quarantine_path === 'string' && result.quarantine_path.length > 0, JSON.stringify(result));
  assert(fs.existsSync(result.quarantine_path), 'the quarantine record must exist on disk');
  assert.strictEqual(path.basename(path.dirname(result.quarantine_path)), 'quarantine');
  assert.strictEqual(path.dirname(path.dirname(result.quarantine_path)), memory.memoryDir(cwd));
  // No key the APPLIED path emitted may go missing: no --json consumer loses a field.
  for (const key of ['verdict', 'written', 'already_present', 'deduped_in_batch', 'fragment_path', 'dst_facts_total', 'preview']) {
    assert(key in result, `QUARANTINED dropped the key ${key}`);
  }
  // And nothing landed in the store.
  assert.strictEqual(fs.existsSync(loose), false, 'a refused write must not create the loose fragment');
}

console.log('PASS: forge-distill review-fix/S02 (R1 inline flow, R2 full-digest dedupe)');
