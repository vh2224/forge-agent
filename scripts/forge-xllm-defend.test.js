#!/usr/bin/env node
'use strict';
/**
 * --mode defend: the surface whose absence made `advocate: auto` a no-op for
 * GPT/Gemini authors. Coverage here is the contract Steps 3–7a of
 * shared/forge-review.md consume, not the model's judgment quality.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  buildDefendPrompt,
  normalizeDefense,
  validateVerdicts,
  verdictSchema,
  DEFEND_VERDICT_ENUM,
  runDefend,
} = require('./forge-xllm.js');

const CLI = path.join(__dirname, 'forge-xllm.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-xllm-defend-'));

// ── Enum is the advocate's, not the rebuttal's ──────────────────────────────
assert.deepStrictEqual(DEFEND_VERDICT_ENUM, ['refuted', 'conceded', 'open']);
assert.strictEqual(
  verdictSchema(DEFEND_VERDICT_ENUM).properties.verdicts.items.properties.verdict.enum[1],
  'conceded'
);

// ── validateVerdicts is enum-parameterized without breaking its old callers ──
const defenseObj = { verdicts: [{ id: 'R1', verdict: 'conceded', rationale: 'real bug' }] };
const rebuttalObj = { verdicts: [{ id: 'R1', verdict: 'withdrawn', rationale: 'defense holds' }] };
assert.ok(validateVerdicts(defenseObj, DEFEND_VERDICT_ENUM), 'defense verdicts accepted');
assert.ok(validateVerdicts(rebuttalObj), 'default enum still the rebuttal one');
assert.ok(!validateVerdicts(defenseObj), 'defense verdicts rejected under the default enum');
assert.ok(!validateVerdicts(rebuttalObj, DEFEND_VERDICT_ENUM), 'rebuttal verdicts rejected as defense');
assert.ok(
  !validateVerdicts({ verdicts: [{ id: 'R1', verdict: 'maybe', rationale: 'x' }] }, DEFEND_VERDICT_ENUM),
  'invented verdict rejected'
);
assert.ok(
  !validateVerdicts({ verdicts: [{ id: '', verdict: 'open', rationale: 'x' }] }, DEFEND_VERDICT_ENUM),
  'empty id rejected — Step 5 pairs verdicts to objections by id'
);

// ── normalizeDefense keeps `rationale` (Steps 5/7a read defense.rationale) ───
const normalized = normalizeDefense(defenseObj);
assert.deepStrictEqual(normalized, {
  verdicts: [{ id: 'R1', verdict: 'conceded', rationale: 'real bug' }],
});
assert.ok(!('reason' in normalized.verdicts[0]), 'defense does not rename to `reason` as rebuttal does');

// ── The prompt frames the AUTHOR, and forbids both degenerate postures ───────
const prompt = buildDefendPrompt('R1 — src/a.js:10 — claim');
assert.ok(/who wrote the code/i.test(prompt), 'author framing present');
assert.ok(/refuted/.test(prompt) && /conceded/.test(prompt) && /open/.test(prompt));
assert.ok(/both failure modes/i.test(prompt), 'agree-with-everything is called out');
assert.ok(/verify claims against the actual code/i.test(prompt), 'told to check the code');
assert.ok(prompt.includes('R1 — src/a.js:10 — claim'), 'objections embedded verbatim');

// ── Missing --input is a caller error, not a silent empty defense ────────────
// runDefend became async in M018 S05 (codex moved to the app-server transport), so
// an argument error arrives as a REJECTION, not a synchronous throw. The assertion
// is not loosened — the same two messages are still demanded; only the channel that
// carries them changed. Awaited at the end of the file so a regression fails the run.
const argGuards = Promise.all([
  assert.rejects(() => runDefend({ cwd: dir }), /requires --input/),
  assert.rejects(() => runDefend({ cwd: dir, inputFile: path.join(dir, 'nope') }), /failed to read --input/),
]);

// ── CLI wiring ──────────────────────────────────────────────────────────────
const run = (args, env) => {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [CLI, ...args], {
        encoding: 'utf8', env: { ...process.env, ...(env || {}) },
      }),
    };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
};

// defend is a recognized mode (the usage line lists it)
const usage = run(['--mode', 'bogus']);
assert.strictEqual(usage.code, 2);
assert.ok(/challenge\|defend\|rebuttal\|execute\|plan/.test(usage.err), 'usage advertises defend');

// stdout is the result channel — --result-file belongs to execute/plan only
const rf = run(['--mode', 'defend', '--input', 'x', '--result-file', path.join(dir, 'r.json')]);
assert.strictEqual(rf.code, 2);
assert.ok(/--result-file is not supported in --mode defend/.test(rf.err));
assert.ok(/challenge\/defend\/rebuttal/.test(rf.err), 'error message lists defend with its peers');

// agy (Gemini) is allowed to defend — the execute/plan-only guard must not catch it
const agyGuard = run(['--mode', 'defend', '--input', path.join(dir, 'missing-input')], {});
assert.strictEqual(agyGuard.code, 2);
assert.ok(
  !/supports only challenge\|rebuttal/.test(agyGuard.err || ''),
  'defend is not rejected by the engine-capability guard'
);
const agyExplicit = run(['--mode', 'defend', '--engine', 'agy', '--input', path.join(dir, 'missing-input')]);
assert.ok(
  !/--engine agy supports only/.test(agyExplicit.err || ''),
  'agy may defend (only execute/plan are codex-only)'
);

// ── End-to-end through a mocked engine ──────────────────────────────────────
// The codex mock is a Node program speaking the app-server JSONL dialect, launched
// via FORGE_XLLM_CODEX_BIN (a `.js` value is run with the current Node binary).
// It USED to be a POSIX sh script writing the `-o` last-message file — the shape of
// `codex exec`. Since M018 S05 the three review modes open `codex app-server`
// instead, and an exec-shaped mock does not merely fail there: it HANGS, because
// the adapter waits forever for a handshake that never arrives. Being a Node program
// (the molde of writeMockAppServer in forge-smoke.js) also removes the win32 skip
// this block used to carry — the protocol fixture is now cross-platform.
const inputFile = path.join(dir, 'objections.txt');
fs.writeFileSync(inputFile, 'R1 ...\nR2 ...\nR3 ...\n');
const writeCodexMock = (file, payload) => {
  const source = String.raw`'use strict';
const PAYLOAD = ${JSON.stringify(String(payload))};
// A mock that hangs erases the signal the suite exists to carry (measured: >600s,
// 0 bytes of output, M018 S02 T02). Fail loud instead of hanging quietly.
const WATCHDOG_MS = Number(process.env.FORGE_MOCK_APPSERVER_TIMEOUT_MS || 30000);
const watchdog = setTimeout(() => {
  process.stderr.write('mock app-server: watchdog ' + WATCHDOG_MS + 'ms without a completed turn\n');
  process.exit(89);
}, WATCHDOG_MS);
let initialized = false;
const send = (v) => process.stdout.write(JSON.stringify(v) + '\n');
let pending = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  pending += chunk;
  let end;
  while ((end = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, end); pending = pending.slice(end + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { process.stderr.write('mock: unparseable client line\n'); process.exit(90); }
    // The app-server dialect OMITS the jsonrpc member (M018/T01/MEM001). Exiting
    // loud here keeps forge-appserver-client honest: re-adding the member fails,
    // it does not quietly work because a lenient mock tolerated it.
    if (Object.prototype.hasOwnProperty.call(msg, 'jsonrpc')) { process.stderr.write('mock: jsonrpc member present\n'); process.exit(91); }
    if (msg.method === 'initialize') send({ id: msg.id, result: { serverInfo: { name: 'defend-mock' } } });
    else if (msg.method === 'initialized') initialized = true;
    else if (msg.method === 'thread/start') {
      if (!initialized) { process.stderr.write('mock: thread/start before initialized\n'); process.exit(92); }
      send({ id: msg.id, result: { thread: { id: 'thread-defend' } } });
    } else if (msg.method === 'turn/start') {
      if (!initialized) { process.stderr.write('mock: turn/start before initialized\n'); process.exit(93); }
      const params = msg.params || {};
      // The defense prompt must actually reach the turn, and the turn must be
      // read-only: a mock that answers regardless would pass while the adapter
      // sent an empty (or write-capable) turn.
      const text = Array.isArray(params.input) && params.input[0] ? String(params.input[0].text || '') : '';
      if (!text.includes('R1 ...')) { process.stderr.write('mock: objections missing from turn input\n'); process.exit(94); }
      if (!params.sandboxPolicy || params.sandboxPolicy.type !== 'readOnly') {
        process.stderr.write('mock: turn/start sandboxPolicy is not readOnly\n'); process.exit(95);
      }
      clearTimeout(watchdog);
      send({ id: msg.id, result: { turn: { id: 'turn-defend' } } });
      if (PAYLOAD) send({ method: 'item/completed', params: { item: { type: 'agentMessage', phase: 'final_answer', text: PAYLOAD } } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn-defend', status: 'completed' } } });
      setTimeout(() => process.exit(0), 50);
    }
  }
});
setInterval(() => {}, 1000);
`;
  fs.writeFileSync(file, source, 'utf8');
};

{
  const mock = path.join(dir, 'mock-codex.js');
  writeCodexMock(
    mock,
    JSON.stringify({
      verdicts: [
        { id: 'R1', verdict: 'conceded', rationale: 'the null check is genuinely missing' },
        { id: 'R2', verdict: 'refuted', rationale: 'callers already normalize this input' },
        { id: 'R3', verdict: 'open', rationale: 'deliberate tradeoff for readability' },
      ],
    })
  );
  const e2e = run(['--mode', 'defend', '--input', inputFile, '--cwd', dir], {
    FORGE_XLLM_CODEX_BIN: mock,
  });
  assert.strictEqual(e2e.code, 0, `defend e2e exited ${e2e.code}: ${e2e.err || ''}`);
  const parsed = JSON.parse(e2e.out);
  assert.strictEqual(parsed.verdicts.length, 3);
  assert.deepStrictEqual(parsed.verdicts.map((v) => v.verdict), ['conceded', 'refuted', 'open']);
  assert.ok(parsed.verdicts.every((v) => typeof v.rationale === 'string'), 'rationale survives');
  assert.ok(parsed.verdicts.every((v) => !('reason' in v)), 'no rebuttal-shaped rename');

  // A defender that returns rebuttal verdicts must fail validation, not be
  // silently accepted — that is how a mis-wired mode would go unnoticed.
  const wrong = path.join(dir, 'mock-codex-wrong.js');
  writeCodexMock(wrong, JSON.stringify({ verdicts: [{ id: 'R1', verdict: 'withdrawn', rationale: 'x' }] }));
  const bad = run(['--mode', 'defend', '--input', inputFile, '--cwd', dir], {
    FORGE_XLLM_CODEX_BIN: wrong,
  });
  assert.strictEqual(bad.code, 2, 'wrong-enum defense rejected');
  assert.ok(/defense verdicts validation/.test(bad.err || ''), 'rejection names the defense contract');

  // A turn that completes without ever emitting an agent message is a FAILURE, not
  // an empty defense accepted in silence. Under `codex exec` the empty `-o` file
  // carried this floor; the app-server transport has to keep it.
  const silent = path.join(dir, 'mock-codex-silent.js');
  writeCodexMock(silent, '');
  const empty = run(['--mode', 'defend', '--input', inputFile, '--cwd', dir], {
    FORGE_XLLM_CODEX_BIN: silent,
  });
  assert.strictEqual(empty.code, 2, 'silent turn rejected');
  assert.strictEqual(empty.out, '', 'silent turn writes nothing to the result channel');
  assert.ok(/empty output/.test(empty.err || ''), 'silent turn names the empty-output cause');
}

// The async argument guards are the LAST thing awaited: a regression there must
// fail the process, never be swallowed as an unhandled rejection after a green line.
argGuards.then(
  () => { console.log('forge-xllm-defend tests passed'); },
  (e) => { console.error(e); process.exit(1); }
);
