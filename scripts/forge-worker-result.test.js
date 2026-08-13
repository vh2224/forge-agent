#!/usr/bin/env node
'use strict';

// Contract tests for the truncated-worker classifier + disk salvage.
//
// The defect being guarded: a worker cut mid-message is indistinguishable
// downstream from one that finished. Every assert below is about keeping those
// two apart, and about the salvage never inventing a verdict it did not read
// off something the worker itself wrote.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  classifyReturn,
  salvageUnit,
  formatResultBlock,
  parseBlockFields,
} = require('./forge-worker-result');

const scriptPath = path.join(__dirname, 'forge-worker-result.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-worker-result-'));
let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  process.stdout.write(`  ✓ ${name}\n`);
}

function write(rel, content) {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

const OUTCOMES = new Set(['hit', 'miss', 'unavailable']);

try {
  // ── classifyReturn ──────────────────────────────────────────────────────────

  test('empty return is `empty`, not `absent`', () => {
    for (const value of ['', '   \n\t ', null, undefined]) {
      assert.strictEqual(classifyReturn(value).shape, 'empty');
    }
  });

  test('prose without the marker is `absent`', () => {
    const r = classifyReturn('Implemented T05 and ran the gate. Files touched: src/a.ts, src/b');
    assert.strictEqual(r.shape, 'absent');
    assert.strictEqual(r.status, null);
    assert.strictEqual(r.marker_count, 0);
  });

  test('a well-formed block is `complete` for every enum member', () => {
    for (const status of ['done', 'partial', 'blocked']) {
      const r = classifyReturn(`work\n\n---GSD-WORKER-RESULT---\nstatus: ${status}\nsummary: x\n`);
      assert.strictEqual(r.shape, 'complete', status);
      assert.strictEqual(r.status, status);
    }
  });

  test('marker present but no status is `status-missing` — a cut block is not a verdict', () => {
    const r = classifyReturn('narration…\n\n---GSD-WORKER-RESULT---\nunit_type: execute-task\nunit_i');
    assert.strictEqual(r.shape, 'status-missing');
    assert.strictEqual(r.status, null);
    assert.strictEqual(r.fields.unit_type, 'execute-task');
  });

  test('an off-enum status is `status-missing`, never a fifth silent state', () => {
    for (const bad of ['finished', 'DONE-ish', 'ok', '']) {
      const r = classifyReturn(`---GSD-WORKER-RESULT---\nstatus: ${bad}\n`);
      assert.strictEqual(r.shape, 'status-missing', `"${bad}" leaked through`);
    }
  });

  test('an uppercase status still resolves — case is not content', () => {
    assert.strictEqual(classifyReturn('---GSD-WORKER-RESULT---\nstatus: DONE\n').status, 'done');
  });

  test('the LAST marker wins — an echoed template leaks no field into the real verdict', () => {
    // The discriminating part is `blocker`: it exists ONLY in the quoted
    // template. If parsing starts at the first marker, the placeholder survives
    // into the verdict and the orchestrator reads a blocker the worker never
    // reported. Asserting on `status` alone does NOT catch this — later keys
    // overwrite earlier ones, so both marker choices agree on it.
    const echoed = [
      'I will finish by returning:',
      '```',
      '---GSD-WORKER-RESULT---',
      'status: blocked',
      'blocker: <description if status=blocked>',
      '```',
      'Now the real one:',
      '---GSD-WORKER-RESULT---',
      'status: done',
      'summary: shipped the adapter',
    ].join('\n');
    const r = classifyReturn(echoed);
    assert.strictEqual(r.marker_count, 2);
    assert.strictEqual(r.status, 'done');
    assert.strictEqual(r.fields.summary, 'shipped the adapter');
    assert.ok(!('blocker' in r.fields), 'a placeholder from the quoted template leaked into the verdict');
  });

  test('CRLF returns classify identically to LF', () => {
    const lf = classifyReturn('---GSD-WORKER-RESULT---\nstatus: done\nsummary: shipped\n');
    const crlf = classifyReturn('---GSD-WORKER-RESULT---\r\nstatus: done\r\nsummary: shipped\r\n');
    assert.strictEqual(crlf.shape, lf.shape);
    assert.strictEqual(crlf.status, lf.status);
    assert.strictEqual(crlf.fields.summary, 'shipped');
  });

  test('the tail is carried and bounded so the operator can see where it stopped', () => {
    const r = classifyReturn('x'.repeat(5000));
    assert.strictEqual(r.chars, 5000);
    assert.strictEqual(r.tail.length, 240);
  });

  // ── field parsing ───────────────────────────────────────────────────────────

  test('lists, quotes and the END marker parse as specified', () => {
    const fields = parseBlockFields([
      '',
      'status: done',
      'summary: "wired the adapter"',
      'files_written:',
      '  - src/a.ts',
      '  - src/b.ts',
      '---END-RESULT---',
      'status: blocked',
    ].join('\n'));
    assert.strictEqual(fields.summary, 'wired the adapter');
    assert.deepStrictEqual(fields.files_written, ['src/a.ts', 'src/b.ts']);
    assert.strictEqual(fields.status, 'done', 'parsing must stop at the END marker');
  });

  test('a key with nothing after it is an empty list, not a missing key', () => {
    const fields = parseBlockFields('\nstatus: done\nfiles_written:\n');
    assert.deepStrictEqual(fields.files_written, []);
    assert.ok('files_written' in fields);
  });

  test('formatResultBlock round-trips through classifyReturn', () => {
    const block = formatResultBlock({ status: 'done', summary: 'x', files_written: ['a', 'b'] });
    const r = classifyReturn(block);
    assert.strictEqual(r.status, 'done');
    assert.deepStrictEqual(r.fields.files_written, ['a', 'b']);
  });

  // ── salvageUnit: the anti-silence floor ─────────────────────────────────────

  test('every salvage reports all four probes with a closed-set outcome', () => {
    const report = salvageUnit({ unit: 'execute-task/T05' });
    assert.strictEqual(report.probes.length, 4);
    assert.deepStrictEqual(
      report.probes.map((p) => p.name),
      ['worker-event', 'summary-file', 'plan-status', 'vcs-delta'],
    );
    for (const p of report.probes) {
      assert.ok(OUTCOMES.has(p.outcome), `${p.name} outcome "${p.outcome}" outside the closed set`);
      assert.ok(p.detail, `${p.name} reported no detail — silence is not a probe result`);
    }
  });

  test('a probe with nothing supplied is `unavailable`, never `miss`', () => {
    const report = salvageUnit({ unit: 'execute-task/T05' });
    for (const p of report.probes) {
      assert.strictEqual(p.outcome, 'unavailable', `${p.name} claimed to have looked`);
    }
    assert.strictEqual(report.recovered, null);
    assert.strictEqual(report.reason, 'no-evidence');
  });

  // ── salvageUnit: rung 1 — the worker's own event line ───────────────────────

  test('rung 1 recovers the worker\'s own status and summary from events.jsonl', () => {
    const events = write('m1/events.jsonl', [
      JSON.stringify({ unit: 'execute-task/T04', status: 'done', summary: 'other task' }),
      JSON.stringify({ unit: 'execute-task/T05', status: 'partial', summary: 'gate failed on typecheck', files_changed: ['src/a.ts'] }),
      '',
    ].join('\n'));

    const report = salvageUnit({ unit: 'execute-task/T05', eventsPaths: [events] });
    assert.deepStrictEqual(report.basis, ['worker-event']);
    assert.strictEqual(report.recovered.status, 'partial');
    assert.strictEqual(report.recovered.fields.summary, 'gate failed on typecheck');
    assert.deepStrictEqual(report.recovered.fields.files_written, ['src/a.ts']);
    assert.strictEqual(report.recovered.fields.salvaged, 'true');
    assert.strictEqual(report.recovered.fields.salvage_basis, 'worker-event');
    assert.strictEqual(report.reason, null);
  });

  test('a recovered block is recognisable as recovered by the normal parser', () => {
    const events = write('m2/events.jsonl', JSON.stringify({ unit: 'execute-task/T05', status: 'done', summary: 's' }));
    const { recovered } = salvageUnit({ unit: 'execute-task/T05', eventsPaths: [events] });
    const parsed = classifyReturn(recovered.block);
    assert.strictEqual(parsed.shape, 'complete');
    assert.strictEqual(parsed.status, 'done');
    assert.strictEqual(parsed.fields.salvaged, 'true');
  });

  test('the LAST matching event line wins — a re-dispatch supersedes its predecessor', () => {
    const events = write('m3/events.jsonl', [
      JSON.stringify({ unit: 'execute-task/T05', status: 'blocked', summary: 'first attempt' }),
      JSON.stringify({ unit: 'execute-task/T05', status: 'done', summary: 'after repair' }),
    ].join('\n'));
    const { recovered } = salvageUnit({ unit: 'execute-task/T05', eventsPaths: [events] });
    assert.strictEqual(recovered.status, 'done');
    assert.strictEqual(recovered.fields.summary, 'after repair');
  });

  test('malformed and off-unit event lines are skipped without aborting the probe', () => {
    const events = write('m4/events.jsonl', [
      '{not json at all',
      JSON.stringify({ unit: 'execute-task/T09', status: 'done' }),
      JSON.stringify({ unit: 'execute-task/T05', status: 'nonsense' }),
      JSON.stringify({ unit: 'execute-task/T05', status: 'done', summary: 'real' }),
    ].join('\n'));
    const { recovered } = salvageUnit({ unit: 'execute-task/T05', eventsPaths: [events] });
    assert.strictEqual(recovered.fields.summary, 'real');
  });

  test('an events path that does not exist is `unavailable`, not a false miss', () => {
    const report = salvageUnit({ unit: 'execute-task/T05', eventsPaths: [path.join(tmp, 'nope.jsonl')] });
    const probe = report.probes.find((p) => p.name === 'worker-event');
    assert.strictEqual(probe.outcome, 'unavailable');
    assert.match(probe.detail, /readable/);
  });

  test('a readable events file with no line for the unit is a real `miss`', () => {
    const events = write('m5/events.jsonl', JSON.stringify({ unit: 'execute-task/T01', status: 'done' }));
    const report = salvageUnit({ unit: 'execute-task/T05', eventsPaths: [events] });
    const probe = report.probes.find((p) => p.name === 'worker-event');
    assert.strictEqual(probe.outcome, 'miss');
  });

  test('must_haves_status is never synthesized, even when the event line carries one', () => {
    const events = write('m6/events.jsonl', JSON.stringify({
      unit: 'execute-task/T05', status: 'done', summary: 's',
      must_haves_status: { satisfied: ['a'], dropped: [] },
    }));
    const { recovered } = salvageUnit({ unit: 'execute-task/T05', eventsPaths: [events] });
    assert.ok(!('must_haves_status' in recovered.fields), 'the worker\'s must-have claim was fabricated');
    assert.ok(!/must_haves_status/.test(recovered.block));
  });

  // ── salvageUnit: rung 2 — both terminal artifacts ───────────────────────────

  test('rung 2 recovers `done` only when SUMMARY exists AND the plan says DONE', () => {
    const summary = write('r2/T05-SUMMARY.md', '---\nid: T05\n---\n\nDid the thing.\n');
    const plan = write('r2/T05-PLAN.md', '---\nid: T05\nstatus: DONE\n---\n\nSteps\n');
    const report = salvageUnit({ unit: 'execute-task/T05', summaryPath: summary, planPath: plan });
    assert.deepStrictEqual(report.basis, ['summary-file', 'plan-status']);
    assert.strictEqual(report.recovered.status, 'done');
    assert.strictEqual(report.recovered.fields.salvage_basis, 'summary-file,plan-status');
  });

  test('SUMMARY alone does not recover — a worker mid-flight is not a verdict', () => {
    const summary = write('r3/T05-SUMMARY.md', 'content\n');
    const plan = write('r3/T05-PLAN.md', '---\nid: T05\nstatus: RUNNING\n---\n');
    const report = salvageUnit({ unit: 'execute-task/T05', summaryPath: summary, planPath: plan });
    assert.strictEqual(report.recovered, null);
    assert.strictEqual(report.reason, 'partial-terminal');
  });

  test('a DONE plan alone does not recover either', () => {
    const plan = write('r4/T05-PLAN.md', '---\nid: T05\nstatus: DONE\n---\n');
    const report = salvageUnit({
      unit: 'execute-task/T05',
      planPath: plan,
      summaryPath: path.join(tmp, 'r4', 'T05-SUMMARY.md'),
    });
    assert.strictEqual(report.recovered, null);
    assert.strictEqual(report.reason, 'partial-terminal');
  });

  test('an empty SUMMARY file is a miss, not a hit', () => {
    const summary = write('r5/T05-SUMMARY.md', '   \n');
    const plan = write('r5/T05-PLAN.md', '---\nstatus: DONE\n---\n');
    const report = salvageUnit({ unit: 'execute-task/T05', summaryPath: summary, planPath: plan });
    assert.strictEqual(report.probes.find((p) => p.name === 'summary-file').outcome, 'miss');
    assert.strictEqual(report.recovered, null);
  });

  test('a plan in CRLF + BOM still yields its status — line endings are not content', () => {
    const plan = write('r6/T05-PLAN.md', '﻿---\r\nid: T05\r\nstatus: DONE\r\n---\r\n');
    const summary = write('r6/T05-SUMMARY.md', 'done\n');
    const report = salvageUnit({ unit: 'execute-task/T05', planPath: plan, summaryPath: summary });
    assert.strictEqual(report.recovered && report.recovered.status, 'done');
  });

  test('a plan without frontmatter is a miss with a named detail', () => {
    const plan = write('r7/T05-PLAN.md', '# Just a heading\n');
    const probe = salvageUnit({ unit: 'execute-task/T05', planPath: plan })
      .probes.find((p) => p.name === 'plan-status');
    assert.strictEqual(probe.outcome, 'miss');
    assert.match(probe.detail, /frontmatter/);
  });

  test('an unreadable plan is `unavailable` and names the errno', () => {
    const dirAsPlan = path.join(tmp, 'r8', 'T05-PLAN.md');
    fs.mkdirSync(dirAsPlan, { recursive: true });
    const probe = salvageUnit({ unit: 'execute-task/T05', planPath: dirAsPlan })
      .probes.find((p) => p.name === 'plan-status');
    assert.strictEqual(probe.outcome, 'unavailable');
    assert.match(probe.detail, /unreadable \(E/);
  });

  // ── salvageUnit: the reason enum separates three different nothings ─────────

  test('reason `work-without-conclusion` fires when only the VCS delta hit', () => {
    const repo = path.join(tmp, 'gitrepo');
    fs.mkdirSync(repo, { recursive: true });
    const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
    if (git('init', '-q').status !== 0) {
      process.stdout.write('  ~ skipped (git unavailable)\n');
      return;
    }
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD').stdout.trim();
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two\n');
    git('add', '-A');
    git('commit', '-qm', 'work');

    const report = salvageUnit({ unit: 'execute-task/T05', codeDir: repo, since: base, vcs: 'git' });
    const delta = report.probes.find((p) => p.name === 'vcs-delta');
    assert.strictEqual(delta.outcome, 'hit');
    assert.strictEqual(report.recovered, null, 'a VCS delta must never carry a verdict alone');
    assert.strictEqual(report.reason, 'work-without-conclusion');
  });

  // ── CLI ─────────────────────────────────────────────────────────────────────

  test('CLI --classify prints JSON and exits 0', () => {
    const res = spawnSync(process.execPath, [scriptPath, '--classify', '--inline', 'no block here'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0);
    assert.strictEqual(JSON.parse(res.stdout).shape, 'absent');
  });

  test('CLI --salvage exits 0 even with zero evidence — advisory, never a broken-tool signal', () => {
    const res = spawnSync(process.execPath, [scriptPath, '--salvage', '--unit', 'execute-task/T05'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0);
    const out = JSON.parse(res.stdout);
    assert.strictEqual(out.recovered, null);
    assert.strictEqual(out.reason, 'no-evidence');
    assert.strictEqual(out.probes.length, 4);
  });

  test('CLI usage errors exit 2 — distinguishable from an empty finding', () => {
    for (const argv of [[], ['--classify'], ['--salvage']]) {
      const res = spawnSync(process.execPath, [scriptPath, ...argv], { encoding: 'utf8' });
      assert.strictEqual(res.status, 2, `argv ${JSON.stringify(argv)} did not exit 2`);
    }
  });

  process.stdout.write(`\nforge-worker-result: ${passed} passed\n`);
} catch (err) {
  process.stderr.write(`\nFAIL after ${passed} passing assertions\n${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
