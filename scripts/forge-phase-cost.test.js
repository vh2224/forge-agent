'use strict';
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { analyzeEvents, measurePhaseCost, MAX_BYTES } = require('./forge-phase-cost');
const row = (event, unit, seconds, id) => ({ event, unit, milestone: 'M-fixture', host_runtime: 'codex',
  action: event === 'unit-began' ? 'begin' : 'complete',
  ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString(), ...(id ? { idempotency_key: id } : {}) });
const analyze = rows => analyzeEvents(Buffer.from(rows.map(JSON.stringify).join('\n') + '\n'));
{
  const result = analyze([row('unit-began', 'research-milestone/M-fixture', 0), row('unit-began', 'execute-task/T01', 5),
    row('unit-transition', 'research-milestone/M-fixture', 10), row('unit-transition', 'execute-task/T01', 20),
    { agent: 'legacy', status: 'done', summary: 'PRIVATE-SENTINEL' }]);
  assert.equal(result.aggregate_unit_ms, 25000); assert.equal(result.observed_active_wall_ms, 20000);
  assert.equal(result.observed_span_ms, 20000); assert.equal(result.completed_pairs, 2);
  assert.equal(result.diagnostics.ignored_records, 1); assert(!JSON.stringify(result).includes('PRIVATE-SENTINEL'));
  assert.equal(result.fixed_overhead.status, 'unknown'); assert.equal(result.actual_token_attribution, 'unknown');
}
{
  const first = row('unit-began', 'execute-task/T01', 1, 'same');
  const duplicated = analyze([first, first, row('unit-transition', 'execute-task/T01', 3)]);
  assert.equal(duplicated.completed_pairs, 1); assert.equal(duplicated.diagnostics.duplicate_records, 1);
  assert.throws(() => analyze([first, { ...first, ts: row('unit-began', 'x/x', 2).ts }, row('unit-transition', 'execute-task/T01', 3)]), { code: 'phase-cost-conflicting-id' });
  const invalid = { ...first, ts: 'invalid' }, end = row('unit-transition', 'execute-task/T01', 3);
  assert.throws(() => analyze([invalid, first, end]), { code: 'phase-cost-lifecycle-invalid' });
  assert.throws(() => analyze([first, end, invalid]), { code: 'phase-cost-conflicting-id' });
  const ambiguous = analyze([first, row('unit-began', 'execute-task/T01', 2), row('unit-transition', 'execute-task/T01', 4)]);
  assert.equal(ambiguous.completed_pairs, 0); assert.equal(ambiguous.diagnostics.ambiguous_begins, 1);
}
{
  const result = analyze([row('unit-transition', 'execute-task/T02', 1), row('unit-began', 'execute-task/T01', 2),
    row('unit-transition', 'execute-task/T01', 1), row('unit-began', 'plan-slice/S01', 3),
    ]);
  assert.equal(result.completed_pairs, 0); assert.equal(result.observed_span_ms, null);
  assert.equal(result.diagnostics.unmatched_transitions, 1); assert.equal(result.diagnostics.unmatched_begins, 1);
  assert.equal(result.diagnostics.negative_intervals, 1); assert.equal(result.diagnostics.invalid_records, 0);
  const sequential = analyze([row('unit-began', 'execute-task/T01', 1), row('unit-transition', 'execute-task/T01', 2),
    row('unit-began', 'execute-task/T01', 4), row('unit-transition', 'execute-task/T01', 7)]);
  assert.equal(sequential.completed_pairs, 2); assert.equal(sequential.aggregate_unit_ms, 4000); assert.equal(sequential.observed_span_ms, 6000);
}
for (const bytes of [Buffer.from('malformed'), Buffer.from('[]'), Buffer.from([0xff]), Buffer.alloc(MAX_BYTES + 1)]) assert.throws(() => analyzeEvents(bytes));
{
  const running = analyze([row('unit-began', 'execute-task/T01', 0),
    { ...row('unit-transition', 'execute-task/T01', 1), action: 'running', outcome: 'running' },
    row('unit-transition', 'execute-task/T01', 60)]);
  assert.equal(running.aggregate_unit_ms, 60000); assert.equal(running.completed_pairs, 1);
  assert.equal(running.diagnostics.nonterminal_transitions, 1); assert.equal(running.diagnostics.unmatched_transitions, 0);
}
{
  for (const ts of ['2026-02-30T00:00:00Z', '2026-03-02T00:00:00', '2026-01-01T24:00:00Z', '2026-01-01T00:00:00+25:00']) {
    assert.throws(() => analyze([{ ...row('unit-began', 'execute-task/T01', 0), ts }, row('unit-transition', 'execute-task/T01', 1)]), { code: 'phase-cost-lifecycle-invalid' });
  }
  const offset = analyze([{ ...row('unit-began', 'execute-task/T01', 0), ts: '2026-11-01T01:30:00-04:00' },
    { ...row('unit-transition', 'execute-task/T01', 0), ts: '2026-11-01T01:30:00-05:00' }]);
  assert.equal(offset.aggregate_unit_ms, 3600000, 'explicit DST offsets are independent of host timezone');
  const first = row('unit-began', 'execute-task/T01', 0, 'reordered');
  const reordered = Object.fromEntries(Object.entries(first).reverse());
  assert.equal(analyze([first, reordered, row('unit-transition', 'execute-task/T01', 1)]).diagnostics.duplicate_records, 1);
  const unusual = analyze([row('unit-began', 'constructor/T01', 0), row('unit-transition', 'constructor/T01', 1)]);
  assert.equal(unusual.aggregate_unit_ms, 1000); assert.equal(unusual.by_phase.constructor.count, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(Object, 'duration_ms'), false);
  assert.throws(() => analyze([row('unit-began', 'execute-task/T01', 0), { ...row('unit-began', 'execute-task/T01', 1), ts: 'invalid' },
    row('unit-transition', 'execute-task/T01', 15)]), { code: 'phase-cost-lifecycle-invalid' });
  const recovered = analyze([row('unit-began', 'execute-task/T01', 0), row('unit-began', 'execute-task/T01', 1),
    row('unit-transition', 'execute-task/T01', 2), row('unit-transition', 'execute-task/T01', 3),
    row('unit-began', 'execute-task/T01', 10), row('unit-transition', 'execute-task/T01', 15)]);
  assert.equal(recovered.completed_pairs, 1); assert.equal(recovered.aggregate_unit_ms, 5000);
  assert.equal(recovered.diagnostics.excluded_ambiguous_intervals, 2); assert.equal(recovered.diagnostics.unmatched_begins, 0);
  for (const changed of [{ milestone: '' }, { unit: 'execute-task/' }, { unit: 'execute-task/T01/foreign' },
    { host_runtime: {} }, { host_runtime: '' }, { host: 'claude' }, { idempotency_key: {} }, { action: 'foreign' }]) {
    assert.throws(() => analyze([{ ...row('unit-began', 'execute-task/T01', 0), ...changed }, row('unit-transition', 'execute-task/T01', 1)]), { code: 'phase-cost-lifecycle-invalid' });
  }
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-phase-cost-'));
try {
  const file = path.join(temp, 'events.jsonl'); fs.writeFileSync(file, JSON.stringify(row('unit-began', 'execute-task/T01', 0)) + '\n');
  const before = fs.readFileSync(file); assert.equal(measurePhaseCost(file).diagnostics.unmatched_begins, 1);
  assert.deepEqual(fs.readFileSync(file), before);
  const link = path.join(temp, 'linked.jsonl');
  try { fs.symlinkSync(file, link); assert.throws(() => measurePhaseCost(link)); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
console.log('PASS phase cost: measured overlap and gaps, repeated IDs, ambiguity, corruption, private-text exclusion, immutable input and unknown attribution');
