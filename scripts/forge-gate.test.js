#!/usr/bin/env node
// forge-gate.test.js — contract test suite for forge-gate.js
//
// Covers the mailbox lifecycle (open → wait → answer), and the two properties
// the protocol actually stakes its safety on:
//   1. a gate NEVER blocks forever — it expires into its declared default
//   2. a human answer NEVER loses to an expiry race
//
// Run: node scripts/forge-gate.test.js   (exit 0 = all pass, 1 = any fail)

'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const gate = require('./forge-gate.js');

// Notifications are a side effect on the developer's desktop — never fire them
// from the suite.
process.env.FORGE_GATE_NO_NOTIFY = '1';

const ENGINE = path.join(__dirname, 'forge-gate.js');

// ── Harness ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gate-'));
  try {
    fn(cwd);
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch {}
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

function withGateEntropy(suffixes, fn) {
  const randomBytes = crypto.randomBytes;
  const clock = Date.now;
  let calls = 0;
  try {
    Date.now = () => Date.UTC(2026, 9, 20, 2, 52, 32);
    crypto.randomBytes = size => {
      assertEq(size, 2, 'gate suffix bytes');
      return Buffer.from(suffixes[Math.min(calls++, suffixes.length - 1)], 'hex');
    };
    fn(() => calls);
  } finally {
    crypto.randomBytes = randomBytes;
    Date.now = clock;
  }
}

const SPEC = {
  run_id: 'M008', unit_id: 'S02', origin: 'test',
  question: 'Seguir com o plano?',
  options: [
    { key: 'treat', label: 'Tratar agora', description: 'adiciona task' },
    { key: 'skip',  label: 'Seguir assim' },
  ],
};

function runCli(cwd, args) {
  return spawnSync(process.execPath, [ENGINE, ...args, '--cwd', cwd], {
    encoding: 'utf8',
    env: { ...process.env, FORGE_GATE_NO_NOTIFY: '1' },
  });
}

console.log('\n=== forge-gate.js — contract test suite ===\n');

// ── 1. Open ──────────────────────────────────────────────────────────────────
console.log('open');

test('openGate writes a pending gate to .gsd/forge/gates', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  assert(/^G-\d{14}-[0-9a-f]{4}$/.test(g.id), `unexpected id: ${g.id}`);
  assertEq(g.status, 'pending', 'status');
  assert(fs.existsSync(gate.gateFile(cwd, g.id)), 'gate file missing on disk');
  const onDisk = JSON.parse(fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
  assertEq(onDisk.question, SPEC.question, 'question round-trip');
});

test('default falls back to the LAST option when unspecified', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  assertEq(g.default, 'skip', 'conservative default');
});

test('explicit default wins', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, default: 'treat' });
  assertEq(g.default, 'treat', 'explicit default');
});

test('openGate rejects a spec with no question', (cwd) => {
  let threw = false;
  try { gate.openGate(cwd, { options: SPEC.options }); } catch { threw = true; }
  assert(threw, 'expected a throw for missing question');
});

test('openGate rejects a spec with no options', (cwd) => {
  let threw = false;
  try { gate.openGate(cwd, { question: 'x', options: [] }); } catch { threw = true; }
  assert(threw, 'expected a throw for empty options');
});

test('string options are normalized', (cwd) => {
  const g = gate.openGate(cwd, { question: 'q', options: ['a', 'b'] });
  assertEq(g.options.map(o => o.key), ['a', 'b'], 'normalized keys');
  assertEq(g.options[0].label, 'a', 'label defaults to key');
});

test('two gates opened back-to-back get distinct ids', (cwd) => {
  const a = gate.openGate(cwd, SPEC);
  const b = gate.openGate(cwd, SPEC);
  assert(a.id !== b.id, `collision: ${a.id}`);
});

test('generated collisions preserve pending and answered mailboxes before retrying', (cwd) => {
  withGateEntropy(['aaaa', 'bbbb', 'aaaa', 'bbbb', 'cccc'], () => {
    const a = gate.openGate(cwd, SPEC);
    const b = gate.openGate(cwd, SPEC);
    gate.answerGate(cwd, b.id, 'treat');
    const original = [a, b].map(g => fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
    const c = gate.openGate(cwd, { ...SPEC, question: 'another question' });
    assert(c.id.endsWith('-cccc'), 'retry must reach the unused candidate');
    assertEq([a, b].map(g => fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8')), original, 'existing bytes preserved');
    assertEq(gate.listPending(cwd).map(g => g.id), [a.id, c.id], 'pending identities survive collisions');
    assertEq(fs.readdirSync(gate.gatesDir(cwd)).length, 3, 'no creation debris');
  });
});

test('repeated entropy collisions fail after a bounded number of attempts', (cwd) => {
  withGateEntropy(['aaaa'], calls => {
    const a = gate.openGate(cwd, SPEC);
    const original = fs.readFileSync(gate.gateFile(cwd, a.id), 'utf8');
    let error;
    try { gate.openGate(cwd, SPEC); } catch (caught) { error = caught; }
    assertEq(error && error.code, 'gate-id-collision-limit', 'bounded failure');
    assertEq(calls(), 33, 'one initial gate plus 32 creation attempts');
    assertEq(fs.readFileSync(gate.gateFile(cwd, a.id), 'utf8'), original, 'original gate unchanged');
    assertEq(fs.readdirSync(gate.gatesDir(cwd)), [`${a.id}.json`], 'failed attempts cleaned up');
  });
});

test('explicit duplicate ids refuse without resetting pending or answered gates', (cwd) => {
  for (const answered of [false, true]) {
    const id = `G-20261020025232-${answered ? 'bbbb' : 'aaaa'}`;
    gate.openGate(cwd, { ...SPEC, id });
    if (answered) gate.answerGate(cwd, id, 'treat');
    const original = fs.readFileSync(gate.gateFile(cwd, id), 'utf8');
    let error;
    try { gate.openGate(cwd, { ...SPEC, id, question: 'replacement' }); } catch (caught) { error = caught; }
    assertEq(error && error.code, 'EEXIST', 'explicit id collision');
    assertEq(fs.readFileSync(gate.gateFile(cwd, id), 'utf8'), original, 'explicit duplicate preserved');
  }
  assertEq(fs.readdirSync(gate.gatesDir(cwd)).length, 2, 'no duplicate creation debris');
});

test('failed temporary writes and publication leave no partial gate or creation debris', (cwd) => {
  const originalGate = gate.openGate(cwd, SPEC);
  const original = fs.readFileSync(gate.gateFile(cwd, originalGate.id), 'utf8');
  for (const operation of ['write', 'link']) {
    const write = fs.writeFileSync, link = fs.linkSync;
    let attempts = 0, error;
    try {
      if (operation === 'write') fs.writeFileSync = (file, ...args) => {
        if (String(file).includes('.create-')) {
          attempts++;
          write(file, '{partial', 'utf8');
          throw Object.assign(new Error('fixture write failure'), { code: 'EIO' });
        }
        return write(file, ...args);
      };
      else fs.linkSync = () => {
        attempts++;
        throw Object.assign(new Error('fixture publication failure'), { code: 'EACCES' });
      };
      try { gate.openGate(cwd, SPEC); } catch (caught) { error = caught; }
    } finally { fs.writeFileSync = write; fs.linkSync = link; }
    assertEq(error && error.code, operation === 'write' ? 'EIO' : 'EACCES', 'original IO failure retained');
    assertEq(attempts, 1, 'non-collision IO failure must not retry');
    assertEq(fs.readdirSync(gate.gatesDir(cwd)), [`${originalGate.id}.json`], 'temporary and unpublished gate cleaned');
    assertEq(fs.readFileSync(gate.gateFile(cwd, originalGate.id), 'utf8'), original, 'existing mailbox unchanged');
  }
});

test('concurrent creators sharing an id publish complete distinct mailboxes', (cwd) => {
  const worker = function () {
    const fs = require('fs'), path = require('path'), crypto = require('crypto');
    const [cwd, engine, index] = process.argv.slice(1);
    const gate = require(engine), link = fs.linkSync;
    let calls = 0, publications = 0;
    Date.now = () => Date.UTC(2026, 9, 20, 2, 52, 32);
    crypto.randomBytes = () => Buffer.from(calls++ === 0 ? 'aaaa' : index === '0' ? 'bbbb' : 'cccc', 'hex');
    fs.linkSync = (source, target) => {
      // Both processes reach their first publication before either may win.
      if (publications++ === 0) {
        fs.writeFileSync(path.join(cwd, `ready-${index}`), 'ready');
        const deadline = performance.now() + 5000;
        while (!fs.existsSync(path.join(cwd, `ready-${index === '0' ? '1' : '0'}`))) {
          if (performance.now() > deadline) throw new Error('fixture barrier timeout');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      }
      return link(source, target);
    };
    const result = gate.openGate(cwd, { question: `question-${index}`, options: ['yes', 'no'], notify: false, timeout_ms: 0 });
    console.log(JSON.stringify({ id: result.id, question: result.question }));
  };
  const coordinator = `
    const {spawn}=require('child_process');
    const children=[0,1].map(index=>spawn(process.execPath,['-e',${JSON.stringify(`(${worker.toString()})()`)},process.argv[1],process.argv[2],String(index)],{stdio:['ignore','pipe','pipe'],windowsHide:true}));
    for(const child of children){child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);child.on('exit',code=>{if(code!==0)process.exitCode=1;});}
  `;
  const run = spawnSync(process.execPath, ['-e', coordinator, cwd, ENGINE], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assertEq(run.status, 0, `concurrent creators: ${run.stderr}`);
  const rows = run.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assertEq(new Set(rows.map(g => g.id)).size, 2, 'both creators retain a distinct id');
  const listed = gate.listPending(cwd);
  assertEq(listed.length, 2, 'both complete mailboxes visible');
  assertEq(listed.map(g => g.question).sort(), ['question-0', 'question-1'], 'both questions preserved');
  assertEq(fs.readdirSync(gate.gatesDir(cwd)).length, 2, 'concurrent temporary files cleaned');
});

// ── 2. Answer ────────────────────────────────────────────────────────────────
console.log('\nanswer');

test('answerGate records the choice and flips status', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  const r = gate.answerGate(cwd, g.id, 'treat', { notes: 'porque sim' });
  assert(r.ok, `answer failed: ${r.reason}`);
  assertEq(r.gate.status, 'answered', 'status');
  assertEq(r.gate.answer.key, 'treat', 'choice');
  assertEq(r.gate.answer.label, 'Tratar agora', 'label resolved');
  assertEq(r.gate.answer.source, 'human', 'source');
  assertEq(r.gate.answer.notes, 'porque sim', 'notes');
});

test('choice matching is case-insensitive', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  const r = gate.answerGate(cwd, g.id, 'TREAT');
  assert(r.ok, 'expected case-insensitive match');
  assertEq(r.gate.answer.key, 'treat', 'canonical key stored');
});

test('an invalid choice is rejected and lists valid keys', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  const r = gate.answerGate(cwd, g.id, 'nope');
  assert(!r.ok, 'expected rejection');
  assert(/invalid-choice/.test(r.reason), `reason: ${r.reason}`);
  assert(/treat/.test(r.reason) && /skip/.test(r.reason), `should list valid keys: ${r.reason}`);
});

test('answering an unknown gate reports not-found', (cwd) => {
  const r = gate.answerGate(cwd, 'G-00000000000000-dead', 'treat');
  assert(!r.ok, 'expected failure');
  assertEq(r.reason, 'not-found', 'reason');
});

test('first writer wins — the second answer is refused', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  const a = gate.answerGate(cwd, g.id, 'treat');
  const b = gate.answerGate(cwd, g.id, 'skip');
  assert(a.ok, 'first answer should win');
  assert(!b.ok, 'second answer must be refused');
  assertEq(b.reason, 'already-answered', 'reason');
  assertEq(gate.readGate(cwd, g.id).answer.key, 'treat', 'stored choice unchanged');
});

test('cancelGate marks the gate cancelled', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  const r = gate.cancelGate(cwd, g.id);
  assert(r.ok, 'cancel failed');
  assertEq(r.gate.status, 'cancelled', 'status');
  assert(!gate.answerGate(cwd, g.id, 'treat').ok, 'cancelled gate must not accept answers');
});

// ── 3. Expiry — the safety property ──────────────────────────────────────────
console.log('\nexpiry (never blocks forever)');

test('a lapsed gate reads as expired without anyone watching', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 1 });
  const raw = JSON.parse(fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
  assertEq(raw.status, 'pending', 'not eagerly persisted');
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)']); // ~ms of wall clock
  const seen = gate.readGate(cwd, g.id);
  assertEq(seen.status, 'expired', 'computed on read');
});

test('waitForAnswerSync resolves an expired gate to its default', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 1, default: 'skip' });
  const res = gate.waitForAnswerSync(cwd, g.id, { poll_ms: 5 });
  assertEq(res.status, 'expired', 'status');
  assertEq(res.choice, 'skip', 'resolved to declared default');
  assertEq(res.source, 'timeout-default', 'source');
});

test('expiry is persisted so the resolution is auditable afterwards', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 1 });
  gate.waitForAnswerSync(cwd, g.id, { poll_ms: 5 });
  const after = JSON.parse(fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
  assertEq(after.status, 'expired', 'persisted');
  assertEq(after.answer.source, 'timeout-default', 'persisted source');
});

test('an expired gate REFUSES a late answer — the run already moved on', (cwd) => {
  // Deliberate semantics: once the run has taken the default and continued,
  // accepting a late answer would report a decision that never happened.
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 1 });
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)']);
  const r = gate.answerGate(cwd, g.id, 'treat');
  assert(!r.ok, 'late answer must be refused');
  assertEq(r.reason, 'already-expired', 'reason names the lapse');
});

test('an answer already on disk survives the waiter, even past expires_at', (cwd) => {
  // The real race: the human answers in the instant the waiter is stamping the
  // expiry. The answer is durable, so status must never regress to expired.
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 60_000 });
  gate.answerGate(cwd, g.id, 'treat');
  // Rewind the deadline: the gate is now answered AND past its expiry.
  const raw = JSON.parse(fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
  raw.expires_at = Date.now() - 1000;
  fs.writeFileSync(gate.gateFile(cwd, g.id), JSON.stringify(raw, null, 2), 'utf8');

  const res = gate.waitForAnswerSync(cwd, g.id, { poll_ms: 5 });
  assertEq(res.status, 'answered', 'human answer must survive');
  assertEq(res.choice, 'treat', 'choice');
  assertEq(res.source, 'human', 'source');
});

test('timeout_ms: 0 means wait indefinitely (no expiry stamped)', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 0 });
  assertEq(g.expires_at, null, 'no expiry');
  assertEq(gate.readGate(cwd, g.id).status, 'pending', 'stays pending');
});

test('waitForAnswerSync honours max_wait_ms and returns without resolving', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 0 });
  const res = gate.waitForAnswerSync(cwd, g.id, { poll_ms: 5, max_wait_ms: 30 });
  assertEq(res.status, 'pending', 'still pending');
  assertEq(res.source, 'wait-timeout', 'caller-side give-up is distinguishable');
});

test('waitForAnswerSync throws when the gate vanishes', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  fs.unlinkSync(gate.gateFile(cwd, g.id));
  let threw = false;
  try { gate.waitForAnswerSync(cwd, g.id, { poll_ms: 5 }); } catch { threw = true; }
  assert(threw, 'expected a throw for a missing gate');
});

// ── 4. Listing ───────────────────────────────────────────────────────────────
console.log('\nlisting');

test('listPending excludes answered and expired gates', (cwd) => {
  const a = gate.openGate(cwd, SPEC);
  const b = gate.openGate(cwd, SPEC);
  const c = gate.openGate(cwd, { ...SPEC, timeout_ms: 1 });
  gate.answerGate(cwd, b.id, 'skip');
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)']);
  const pending = gate.listPending(cwd).map(g => g.id);
  assertEq(pending, [a.id], 'only the open gate is pending');
  assertEq(gate.listGates(cwd).length, 3, 'listGates returns all');
});

test('listGates is empty (not a throw) when no gate ever existed', (cwd) => {
  assertEq(gate.listGates(cwd), [], 'empty workspace');
  assertEq(gate.listPending(cwd), [], 'empty workspace pending');
});

test('a corrupt gate file is skipped, not fatal', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  fs.writeFileSync(path.join(gate.gatesDir(cwd), 'broken.json'), '{not json', 'utf8');
  const all = gate.listGates(cwd);
  assertEq(all.length, 1, 'corrupt entry skipped');
  assertEq(all[0].id, g.id, 'valid entry survives');
});

test('gates sort chronologically', (cwd) => {
  const a = gate.openGate(cwd, SPEC);
  const b = gate.openGate(cwd, SPEC);
  // openGate can stamp both in the same millisecond; separate them explicitly
  // so this asserts ordering rather than clock resolution.
  const raw = JSON.parse(fs.readFileSync(gate.gateFile(cwd, b.id), 'utf8'));
  raw.created_at = a.created_at + 1000;
  fs.writeFileSync(gate.gateFile(cwd, b.id), JSON.stringify(raw, null, 2), 'utf8');
  assertEq(gate.listGates(cwd).map(g => g.id), [a.id, b.id], 'chronological');
});

test('same-millisecond gates still list deterministically', (cwd) => {
  gate.openGate(cwd, SPEC);
  gate.openGate(cwd, SPEC);
  gate.openGate(cwd, SPEC);
  const first = gate.listGates(cwd).map(g => g.id);
  for (let i = 0; i < 5; i++) {
    assertEq(gate.listGates(cwd).map(g => g.id), first, `listing ${i} must not reorder`);
  }
});

// ── 5. Cleanup ───────────────────────────────────────────────────────────────
console.log('\ncleanup');

test('cleanupResolved removes old resolved gates and keeps pending ones', (cwd) => {
  const keep = gate.openGate(cwd, SPEC);
  const old  = gate.openGate(cwd, SPEC);
  gate.answerGate(cwd, old.id, 'skip');
  const r = gate.cleanupResolved(cwd, { max_age_ms: -1 }); // everything resolved is "old"
  assertEq(r.removed, 1, 'one removed');
  assert(fs.existsSync(gate.gateFile(cwd, keep.id)), 'pending gate must survive');
  assert(!fs.existsSync(gate.gateFile(cwd, old.id)), 'resolved gate removed');
});

test('cleanupResolved spares recently resolved gates', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  gate.answerGate(cwd, g.id, 'skip');
  assertEq(gate.cleanupResolved(cwd).removed, 0, 'fresh answer retained');
});

// ── 6. Notification ──────────────────────────────────────────────────────────
console.log('\nnotification');

test('notify is suppressed by FORGE_GATE_NO_NOTIFY', (cwd) => {
  const g = gate.openGate(cwd, SPEC);
  assertEq(gate.notify(g), false, 'must not fire when opted out');
});

test('notify never throws on a hostile question string', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, question: 'aspas " e barra \\ e $(rm -rf /)' });
  gate.notify(g, { dryRun: true }); // must not throw
  assert(true);
});

// ── 7. CLI ───────────────────────────────────────────────────────────────────
console.log('\ncli');

test('--open --json emits a machine-readable gate', (cwd) => {
  const r = runCli(cwd, ['--open', '--question', 'q?', '--option', 'a:A:desc', '--option', 'b:B', '--json']);
  assertEq(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const g = JSON.parse(r.stdout);
  assertEq(g.status, 'pending', 'status');
  assertEq(g.options.map(o => o.key), ['a', 'b'], 'options parsed from key:Label:Desc');
  assertEq(g.options[0].description, 'desc', 'description parsed');
});

test('--open without --option exits 2', (cwd) => {
  const r = runCli(cwd, ['--open', '--question', 'q?']);
  assertEq(r.status, 2, 'usage error');
});

test('--list --json round-trips a pending gate', (cwd) => {
  runCli(cwd, ['--open', '--question', 'q?', '--option', 'a:A', '--json']);
  const r = runCli(cwd, ['--list', '--json']);
  assertEq(r.status, 0, `exit ${r.status}`);
  const list = JSON.parse(r.stdout);
  assertEq(list.length, 1, 'one pending');
});

test('--answer resolves the gate and --show reflects it', (cwd) => {
  const g = JSON.parse(runCli(cwd, ['--open', '--question', 'q?', '--option', 'a:A', '--option', 'b:B', '--json']).stdout);
  const r = runCli(cwd, ['--answer', g.id, '--choice', 'a', '--json']);
  assertEq(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const shown = JSON.parse(runCli(cwd, ['--show', g.id, '--json']).stdout);
  assertEq(shown.status, 'answered', 'status');
  assertEq(shown.answer.key, 'a', 'choice');
});

test('--answer with a bad choice exits 1', (cwd) => {
  const g = JSON.parse(runCli(cwd, ['--open', '--question', 'q?', '--option', 'a:A', '--json']).stdout);
  const r = runCli(cwd, ['--answer', g.id, '--choice', 'zzz']);
  assertEq(r.status, 1, 'should fail');
  assert(/invalid-choice/.test(r.stderr), `stderr: ${r.stderr}`);
});

test('--show on an unknown id exits 1', (cwd) => {
  assertEq(runCli(cwd, ['--show', 'G-00000000000000-dead']).status, 1, 'not found');
});

test('--help exits 0 and documents the mailbox', (cwd) => {
  const r = runCli(cwd, ['--help']);
  assertEq(r.status, 0, 'exit');
  assert(/--open/.test(r.stdout) && /--answer/.test(r.stdout), 'usage lists core verbs');
});

test('end-to-end: --open --wait blocks, then an --answer from "the app" releases it', (cwd) => {
  // The real loop: orchestrator opens and parks; a separate process answers.
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 30_000 });
  const child = spawnSync(process.execPath, ['-e', `
    const { spawnSync } = require('child_process');
    setTimeout(() => {}, 0);
    spawnSync(process.execPath, [${JSON.stringify(ENGINE)}, '--answer', ${JSON.stringify(g.id)}, '--choice', 'treat', '--cwd', ${JSON.stringify(cwd)}]);
  `], { encoding: 'utf8' });
  assertEq(child.status, 0, `responder failed: ${child.stderr}`);
  const res = gate.waitForAnswerSync(cwd, g.id, { poll_ms: 10 });
  assertEq(res.status, 'answered', 'released by the responder');
  assertEq(res.choice, 'treat', 'choice propagated');
});

// ── Lapse resolution without a surviving waiter (I-20260814111723) ───────────
// The reported defect was read as "gates are born expired". The surviving
// artifact refutes that: `expires_at - created_at` was the requested 1800000ms
// to the millisecond. What actually failed is that NOTHING resolved the lapse,
// because the only resolver was a waiter process that cannot outlive its own
// caller's budget. These tests pin the property that fixes it: resolution is a
// function of the file, reachable by any later process.

test('a gate opened with a timeout is NEVER born expired — the reported premise, refuted', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 1_800_000 });
  assertEq(g.status, 'pending', 'status at birth');
  assertEq(g.expires_at - g.created_at, 1_800_000, 'expiry is exactly the requested timeout');
  assert(g.expires_at > Date.now(), 'expires_at must be in the future at birth');
  assertEq(gate.readGate(cwd, g.id).status, 'pending', 'and it reads pending');
});

test('a lapsed gate abandoned by its waiter is resolved by a LATER process', (cwd) => {
  // Reproduces the artifact: pending, unanswered, already past expires_at —
  // the state a killed `--open --wait` leaves behind.
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 1, default: 'skip' });
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)']);
  const abandoned = JSON.parse(fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
  assertEq(abandoned.status, 'pending', 'nobody persisted the lapse');
  assertEq(abandoned.answer, null, 'and no resolution exists');

  const r = gate.resolveLapsed(cwd);
  assertEq(r.resolved.length, 1, 'the sweep resolves it');
  assertEq(r.skipped.length, 0, 'nothing skipped');
  const after = JSON.parse(fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
  assertEq(after.answer.source, 'timeout-default', 'declared default persisted');
  assertEq(after.answer.key, 'skip', 'the declared default, not the first option');
});

test('the sweep reports a census — examined and skipped are never silent', (cwd) => {
  const lapsed  = gate.openGate(cwd, { ...SPEC, timeout_ms: 1 });
  const pending = gate.openGate(cwd, { ...SPEC, timeout_ms: 600_000 });
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)']);

  const first = gate.resolveLapsed(cwd);
  assertEq(first.examined, 2, 'both gates examined');
  assertEq(first.resolved.length, 1, 'only the lapsed one resolved');
  assert(first.resolved[0].id === lapsed.id, 'the lapsed gate is the one resolved');
  assert(pending.id !== lapsed.id, 'distinct ids');

  // Idempotent: a second sweep resolves nothing and NAMES why it skipped.
  const second = gate.resolveLapsed(cwd);
  assertEq(second.resolved.length, 0, 'nothing left to resolve');
  assertEq(second.skipped.length, 1, 'the already-resolved gate is reported, not dropped');
  assertEq(second.skipped[0].reason, 'already-resolved', 'skip reason is named');
});

test('the sweep NEVER clobbers a human answer', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 60_000 });
  gate.answerGate(cwd, g.id, 'treat');
  const r = gate.resolveLapsed(cwd);
  assertEq(r.resolved.length, 0, 'an answered gate is not swept');
  const after = JSON.parse(fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
  assertEq(after.answer.source, 'human', 'the human answer survives');
});

test('positive control: the sweep bites only lapsed gates', (cwd) => {
  // Without this, a sweep that resolved NOTHING would look identical to a
  // sweep whose selector is broken.
  const fresh = gate.openGate(cwd, { ...SPEC, timeout_ms: 600_000 });
  const none = gate.resolveLapsed(cwd);
  assertEq(none.resolved.length, 0, 'a live gate must not be resolved');
  assertEq(none.examined, 1, 'but it WAS examined — silence would be a broken selector');

  const r = gate.resolveLapsedGate(cwd, fresh.id);
  assert(!r.ok, 'resolving a live gate directly is refused');
  assertEq(r.reason, 'not-lapsed', 'refusal is named');
});

test('--max-wait bounds the block so a waiter cannot outlive its caller', (cwd) => {
  // The mechanism behind the incident: the gate timeout is far longer than the
  // caller's budget. Bounded, the waiter returns promptly and says so.
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 600_000 });
  const started = Date.now();
  const res = gate.waitForAnswerSync(cwd, g.id, { poll_ms: 5, max_wait_ms: 60 });
  const elapsed = Date.now() - started;
  assertEq(res.status, 'pending', 'gate is still open — nothing was decided');
  assertEq(res.source, 'wait-timeout', 'the caller is told the WAIT lapsed, not the gate');
  assert(elapsed < 30_000, `bounded wait must return promptly, took ${elapsed}ms`);
});

test('CLI --open --wait --max-wait returns instead of blocking to the gate timeout', (cwd) => {
  // Covers the WIRING, not just the library: an unwired flag would leave the
  // CLI blocking for the full timeout and be invisible to a library-level test.
  const started = Date.now();
  const r = spawnSync(process.execPath, [
    ENGINE, '--open', '--cwd', cwd, '--json', '--no-notify',
    '--question', 'q', '--option', 'treat:Treat', '--option', 'skip:Skip',
    '--timeout', '600000', '--wait', '--max-wait', '200',
  ], { encoding: 'utf8', timeout: 60_000 });
  const elapsed = Date.now() - started;
  assertEq(r.status, 0, `CLI must exit 0: ${r.stderr}`);
  assert(elapsed < 30_000, `--max-wait must bound the CLI block, took ${elapsed}ms`);
  const parsed = JSON.parse(r.stdout);
  assertEq(parsed.source, 'wait-timeout', 'the CLI reports the wait lapsed, not the gate');
  assertEq(parsed.status, 'pending', 'the gate is left open for a later responder');
});

test('CLI --resolve-lapsed closes an abandoned gate and exits 0', (cwd) => {
  const g = gate.openGate(cwd, { ...SPEC, timeout_ms: 1, default: 'skip' });
  spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},20)']);
  const r = spawnSync(process.execPath, [ENGINE, '--resolve-lapsed', '--cwd', cwd, '--json'], { encoding: 'utf8' });
  assertEq(r.status, 0, `CLI must exit 0: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assertEq(parsed.resolved.length, 1, 'CLI resolved the abandoned gate');
  const after = JSON.parse(fs.readFileSync(gate.gateFile(cwd, g.id), 'utf8'));
  assertEq(after.answer.source, 'timeout-default', 'persisted through the CLI path');
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.error}`);
}
console.log('');
process.exit(failed ? 1 : 0);
