'use strict';

// This is an injected host-adapter seam, not a claim that any native host exposes
// observation, cancellation or reattachment APIs. A policy cutoff cannot kill a writer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const liveness = require('./forge-sidecar-liveness');
const { ceilingFromRoute } = require('./forge-worker-timeout');
const { writeJsonAtomic } = require('./forge-surgical-reset');
const { key } = require('./forge-code-roots');
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }
const systemClock = { wall: Date.now, monotonic: () => performance.now(), setTimeout, clearTimeout };

function journalStore(journal, identity) {
  if (!journal) return null;
  const root = path.resolve(journal.root || ''), file = path.resolve(journal.file || '');
  if (typeof journal.authorize !== 'function' || journal.authorize({ root, file, identity }) !== true) fail('native-journal-authority-required');
  // A host explicitly selects an already validated external evidence directory.
  // Recheck physical containment on every operation; never create its parent.
  const validate = () => {
    if (!journal.root || !journal.file || key(path.dirname(file)) !== key(root)
        || key(fs.realpathSync.native(root)) !== key(root) || fs.lstatSync(root).isSymbolicLink()) fail('native-journal-path');
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink()
        || !fs.statSync(file).isFile() || key(fs.realpathSync.native(file)) !== key(file))) fail('native-journal-path');
  };
  validate();
  return {
    reference: digest(identity + '\0' + file),
    read() { validate(); if (!fs.existsSync(file)) return null;
      if (fs.statSync(file).size > 32768) fail('native-journal-size');
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('native-journal-invalid'); } },
    create(state) { validate(); try { fs.writeFileSync(file, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); }
      catch { fail('native-journal-collision'); } },
    save(state) { validate();
      if (fs.existsSync(path.join(root, `.${path.basename(file)}.${process.pid}.tmp`))) fail('native-journal-temp-collision');
      writeJsonAtomic(file, state); },
  };
}

async function supervise(options, invoke) {
  const { identity, terminal, adapter = null } = options;
  if (!/^[a-f0-9]{64}$/.test(identity || '') || typeof terminal !== 'function') fail('native-lifecycle-contract-required');
  const clock = options.clock || systemClock, wall = clock.wall(), mono = clock.monotonic();
  if (!Number.isSafeInteger(wall) || wall < 0 || !Number.isFinite(mono) || mono < 0) fail('native-clock-inconsistent');
  const ceiling = ceilingFromRoute(options.route), policy = liveness.normalizePolicy(options.policy);
  const store = journalStore(options.journal, identity), previous = store?.read();
  const caps = Object.fromEntries(['result', 'remote_events', 'open_tools', 'cancel', 'resume', 'stop_proof']
    .map(key => [key, adapter?.capabilities?.[key] === true ? 'available' : 'unknown']));
  let state = { schema_version: 1, identity, start_wall_ms: wall, last_wall_ms: wall,
    deadline_wall_ms: wall + ceiling.ms, ceiling_ms: ceiling.ms, tier: ceiling.tier,
    policy, capabilities: caps, phase: 'started', sequence: -1, first_remote_ms: null,
    last_remote_ms: null, open_tools: false, activity: 'unknown', possible_writer: true,
    stopped: 'unknown', cancel_requested: false, handle_sha256: null, late_terminal: false };
  if (previous) {
    if (previous.schema_version !== 1 || previous.identity !== identity || previous.phase === 'terminal'
        || !Number.isSafeInteger(previous.start_wall_ms) || !Number.isSafeInteger(previous.deadline_wall_ms)
        || !Number.isSafeInteger(previous.last_wall_ms) || wall < previous.last_wall_ms
        || previous.deadline_wall_ms - previous.start_wall_ms !== previous.ceiling_ms
        || !Number.isSafeInteger(previous.ceiling_ms) || previous.ceiling_ms <= 0 || previous.tier !== ceiling.tier
        || previous.ceiling_ms > ceiling.ms || previous.start_wall_ms > wall
        || !Number.isSafeInteger(previous.sequence) || previous.sequence < -1
        || typeof previous.open_tools !== 'boolean' || typeof previous.possible_writer !== 'boolean'
        || previous.stopped !== 'unknown' || typeof previous.cancel_requested !== 'boolean'
        || !['started', 'acknowledged', 'interrupted'].includes(previous.phase)
        || JSON.stringify(liveness.normalizePolicy(previous.policy)) !== JSON.stringify(previous.policy)
        || ![previous.first_remote_ms, previous.last_remote_ms].every(value => value === null
          || Number.isSafeInteger(value) && value >= 0 && value <= wall - previous.start_wall_ms)
        || previous.handle_sha256 !== null && !/^[a-f0-9]{64}$/.test(previous.handle_sha256 || '')) fail('native-journal-identity-or-clock');
    // A saved record grants no right to reattach, and can never start a new writer.
    if (caps.resume !== 'available' || typeof adapter?.resume !== 'function') fail('native-journal-reattach-required');
    state = Object.fromEntries(Object.keys(state).map(key => [key, previous[key] ?? state[key]]));
    state.capabilities = caps;
  } else if (options.resume) fail('native-journal-required');
  else store?.create(state);
  const initialElapsed = Math.max(0, wall - state.start_wall_ms);
  let timer = null, dispose = null, handle = null, finished = false;
  let lastMonotonic = mono;
  let resolveOutcome;
  const outcome = new Promise(resolve => { resolveOutcome = resolve; });
  const elapsed = () => Math.floor(initialElapsed + Math.max(0, clock.monotonic() - mono));
  // Never lower the high-water mark; tick() rejects a rollback before any observation is saved.
  const save = () => { state.last_wall_ms = Math.max(state.last_wall_ms, clock.wall()); store?.save(state); };
  const snapshot = () => ({ ...state, journal_reference: store?.reference || null,
    persistence: store ? 'external-journal' : 'unavailable' });
  const clean = () => { if (timer !== null) clock.clearTimeout(timer); timer = null;
    if (dispose) { try { dispose(); } catch { /* no host text in evidence */ } dispose = null; } };
  const finish = (ok, reason, result) => {
    if (finished) return;
    finished = true; clean(); state.phase = ok ? 'terminal' : 'interrupted';
    state.reason_code = reason; if (ok) { state.possible_writer = false; state.stopped = 'terminal'; }
    try { save(); } catch { ok = false; reason = 'native-journal-write-failed'; }
    resolveOutcome({ ok, reason_code: reason, provider_called: ok ? true : state.provider_called ?? 'unknown',
      ...(ok ? { result } : {}), lifecycle: snapshot() });
  };
  const terminalResult = value => { try { return terminal(value) === true; } catch { return false; } };
  const receiveTerminal = value => {
    if (!terminalResult(value)) return false;
    // Validate clocks and startup/silence/ceiling limits against existing timestamps first.
    if (!finished) tick();
    if (!finished) finish(true, 'native-terminal', value);
    else {
      state.late_terminal = true;
      // Capture through the consumer's canonical writer, never publish here.
      if (typeof options.captureLateResult === 'function') {
        Promise.resolve().then(() => options.captureLateResult(value)).then(() => {
          state.late_capture = 'saved'; try { save(); } catch { /* original cutoff remains */ }
        }, () => { state.late_capture = 'failed'; try { save(); } catch {} });
      } else state.late_capture = 'unavailable';
      try { save(); } catch { /* preserve primary outcome */ }
    }
    return true;
  };
  const event = observation => {
    if (finished || !observation || observation.identity !== identity
        || !Number.isSafeInteger(observation.sequence) || observation.sequence <= state.sequence) return;
    if (observation.kind === 'terminal' && caps.result === 'available') {
      if (terminalResult(observation.result)) { state.sequence = observation.sequence; receiveTerminal(observation.result); }
      return;
    }
    const work = observation.kind === 'work' && caps.remote_events === 'available'
      && typeof observation.text === 'string' && observation.text.trim().length > 0;
    const tool = observation.kind === 'tool' && caps.open_tools === 'available' && typeof observation.open === 'boolean';
    if (!work && !tool) return; // Administrative heartbeat/wait/running is not work.
    tick(); // expired liveness or a clock rollback must win over this activity
    if (finished) return;
    state.sequence = observation.sequence;
    if (work || tool) { state.first_remote_ms ??= elapsed(); state.last_remote_ms = elapsed(); }
    if (tool) state.open_tools = observation.open;
    try { save(); } catch { finish(false, 'native-journal-write-failed'); }
  };
  const tick = () => {
    if (finished) return;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    const age = elapsed();
    const nowWall = clock.wall(), nowMono = clock.monotonic();
    if (!Number.isSafeInteger(nowWall) || nowWall < state.last_wall_ms
        || !Number.isFinite(nowMono) || nowMono < lastMonotonic) { finish(false, 'native-clock-inconsistent'); return; }
    lastMonotonic = nowMono;
    const remainingWall = state.deadline_wall_ms - clock.wall();
    const observed = caps.remote_events === 'available';
    const decision = observed ? liveness.evaluate({ elapsed_ms: age, first_remote_ms: state.first_remote_ms,
      remote_silence_ms: state.last_remote_ms === null ? null : age - state.last_remote_ms,
      gap_suspended: caps.open_tools === 'available' && state.open_tools }, {}, state.policy, state.ceiling_ms) : null;
    state.activity = decision?.state || 'unknown';
    if (remainingWall <= 0 || age >= state.ceiling_ms || decision?.kill) {
      if (caps.cancel === 'available' && typeof adapter?.cancel === 'function') {
        state.cancel_requested = true;
        // Deliberately do not await cancellation or confuse its acknowledgment with stop proof.
        Promise.resolve().then(() => adapter.cancel(handle, { identity })).catch(() => {});
      }
      finish(false, decision?.termination || 'native-safety-ceiling'); return;
    }
    try { save(); } catch { finish(false, 'native-journal-write-failed'); return; }
    timer = clock.setTimeout(tick, Math.max(1, Math.min(1000, remainingWall, state.ceiling_ms - age,
      state.policy.startMs + 1, state.policy.deadMs + 1)));
  };
  const accept = value => {
    if (receiveTerminal(value)) return;
    if (finished) return;
    if (caps.result !== 'available' || typeof adapter?.acknowledge !== 'function'
        || typeof adapter?.subscribe !== 'function') { finish(false, 'native-terminal-unobserved'); return; }
    handle = adapter.acknowledge(value, { identity });
    if (typeof handle !== 'string' || !handle || handle.length > 1024) { finish(false, 'native-handle-invalid'); return; }
    if (previous?.handle_sha256 && digest(handle) !== previous.handle_sha256) { finish(false, 'native-handle-identity'); return; }
    state.handle_sha256 = digest(handle); state.phase = 'acknowledged'; save();
    const cleanup = adapter.subscribe(handle, event, { identity });
    if (typeof cleanup !== 'function') { finish(false, 'native-observer-cleanup-required'); return; }
    if (finished) cleanup(); else dispose = cleanup;
  };
  tick();
  if (!finished) Promise.resolve().then(() => {
    // Scheduling is not launch authority: a timer or elapsed wall deadline can
    // win before this microtask runs. Recheck at the actual callback boundary.
    if (finished) return;
    if (elapsed() >= state.ceiling_ms || clock.wall() >= state.deadline_wall_ms) tick();
    if (finished) return;
    return previous ? adapter.resume(snapshot()) : invoke();
  })
    .then(accept).catch(error => {
      state.provider_called = typeof error?.provider_called === 'boolean' ? error.provider_called : 'unknown';
      finish(false, /^[a-z0-9-]{1,100}$/.test(error?.code || '') ? error.code : 'native-invocation-failed');
    });
  return outcome;
}

module.exports = { supervise, journalStore, digest };
