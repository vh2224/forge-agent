#!/usr/bin/env node
// Forge Hook — fires on PreToolUse / PostToolUse (Agent + Write matchers)
//              and on SessionStart / SubagentStart / SubagentStop / PreCompact / PostCompact events
// Writes dispatch progress to a temp file that forge-statusline.js reads.
// Session-aware after M004: resolves run via data.session_id → .gsd/forge/runs/*.json
//
// Called by Claude Code hooks (configured in ~/.claude/settings.json):
//   SessionStart    → node ~/.claude/forge-hook.js session-start
//   PreToolUse      → node ~/.claude/forge-hook.js pre
//   PostToolUse     → node ~/.claude/forge-hook.js post
//   SubagentStart   → node ~/.claude/forge-hook.js subagent-start
//   SubagentStop    → node ~/.claude/forge-hook.js subagent-stop
//   PreCompact      → node ~/.claude/forge-hook.js pre-compact
//   PostCompact     → node ~/.claude/forge-hook.js post-compact

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const phase = process.argv[2] || 'post'; // 'pre', 'post', 'subagent-start', 'subagent-stop', 'pre-compact', 'post-compact'

// ── Resolve scripts dir — works both in dev (sibling) and installed (~/.claude/scripts/) ──
// Installed: this file lives at ~/.claude/forge-hook.js, scripts at ~/.claude/scripts/
// Dev: this file lives at scripts/forge-hook.js, runs.js at scripts/forge-runs.js (sibling)
let runs = null;
let filelock = null;
try {
  runs     = require(path.join(__dirname, 'scripts', 'forge-runs.js'));
  filelock = require(path.join(__dirname, 'scripts', 'forge-filelock.js'));
} catch {
  try {
    runs     = require(path.join(__dirname, 'forge-runs.js'));
    filelock = require(path.join(__dirname, 'forge-filelock.js'));
  } catch { runs = null; filelock = null; }
}

// ── Evidence-path module (S01/T01) — same dev/installed dual-path resolution ──
// Owner of the evidence file-name shape and of the NAMED axis sentinels. A
// partial install must stay fail-open (MEM008): a null module falls back to the
// literal sentinel values at the single call site that needs them, so the hook
// never throws on a user's tool-call path.
let evidencePath = null;
try { evidencePath = require(path.join(__dirname, 'scripts', 'forge-evidence-path.js')); }
catch {
  try { evidencePath = require(path.join(__dirname, 'forge-evidence-path.js')); }
  catch { evidencePath = null; }
}

// ── Workspace module (S01/T06) — same dev/installed dual-path resolution ──
// `resolveOwner` is the ONLY tree-walk for `.gsd` this repo allows (Standards).
// Loader is narrowed like the schema-guard precedent (forge-decisions.js /
// forge-ledger.js / forge-memory.js / forge-projection.js): a MODULE_NOT_FOUND
// naming this module itself is a legitimate "not colocated in this install
// layout" fail-open; anything else (a real init fault) is a fault this hook
// still must never crash on (MEM008), so it is swallowed too but never mistaken
// for "the module tried and lied" — resolveOwnerDir() below treats a null
// workspaceMod as "no owner resolvable", same as resolveOwner() returning null.
let workspaceMod = null;
try { workspaceMod = require(path.join(__dirname, 'scripts', 'forge-workspace.js')); }
catch (err1) {
  try { workspaceMod = require(path.join(__dirname, 'forge-workspace.js')); }
  catch (err2) { workspaceMod = null; }
}

// ── Resolve context-monitor module — same dev/installed pattern ──
let ctxMonitor = null;
try {
  ctxMonitor = require(path.join(__dirname, 'scripts', 'forge-context-monitor.js'));
} catch {
  try {
    ctxMonitor = require(path.join(__dirname, 'forge-context-monitor.js'));
  } catch { ctxMonitor = null; }
}

// Preferences engine — same installed/dev dual-path resolution as runs above.
// A partial install must stay fail-open: hooks are on the user's tool-call path.
let prefsEngine = null;
try { prefsEngine = require(path.join(__dirname, 'scripts', 'forge-prefs.js')); }
catch { try { prefsEngine = require(path.join(__dirname, 'forge-prefs.js')); } catch {} }

// Passive consumer error signal shared with doctor/viewer (S06).  Do not create
// .gsd/forge in arbitrary repositories: when Forge is not initialized, skip it.
const updatePrefsErrorFlag = (cwd, error) => {
  try {
    const forgeDir = path.join(cwd, '.gsd', 'forge');
    if (!fs.existsSync(forgeDir)) return;
    const flag = path.join(forgeDir, 'prefs-error.json');
    if (error) {
      fs.writeFileSync(flag, JSON.stringify({
        file: error.file || cwd,
        line: error.line == null ? null : error.line,
        message: String(error.message || 'prefs-read-error'),
        ts: Date.now(),
      }), 'utf8');
    } else {
      try { fs.unlinkSync(flag); } catch {}
    }
  } catch { /* passive error reporting itself must never abort a tool call */ }
};

// MEM022/S03: hooks keep the inert fallback, plus one best-effort diagnostic
// event per process.  Never create .gsd/forge in an arbitrary repository.
let _prefsBlockedEventLogged = false;
const appendPrefsBlockedEvent = (cwd, error) => {
  try {
    if (_prefsBlockedEventLogged || !error) return;
    const forgeDir = path.join(cwd, '.gsd', 'forge');
    if (!fs.existsSync(forgeDir)) return;
    const event = {
      ts: new Date().toISOString(),
      event: 'prefs-blocked',
      code: error.code || 'prefs-read-error',
      file: error.file || cwd,
    };
    fs.appendFileSync(path.join(forgeDir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8');
    _prefsBlockedEventLogged = true;
  } catch { /* diagnostic telemetry must never abort a tool call (MEM008) */ }
};

// Engine calls are deliberately contained here.  This keeps every hook prefs
// consumer fail-open, while making malformed config visible to passive tooling.
const resolvePrefsSafe = (cwd) => {
  if (!prefsEngine || typeof prefsEngine.readPrefsCached !== 'function') {
    return { prefs: {}, hadError: false };
  }
  try {
    const result = prefsEngine.readPrefsCached(cwd) || {};
    const error = Array.isArray(result.errors) && result.errors.length ? result.errors[0] : null;
    updatePrefsErrorFlag(cwd, error);
    appendPrefsBlockedEvent(cwd, error);
    return { prefs: result.prefs || {}, hadError: Boolean(error) };
  } catch (err) {
    const error = { code: err && err.code, file: err && err.file || cwd, line: null, message: err && err.message };
    updatePrefsErrorFlag(cwd, error);
    appendPrefsBlockedEvent(cwd, error);
    return { prefs: {}, hadError: true };
  }
};

// Sanitize run_id for safe filesystem use (evidence-{runId}-{unitId}.jsonl)
function sanitizeRunId(id) {
  return String(id || 'adhoc').replace(/[^\w.\-]/g, '_');
}

// Resolve the run owning this hook fire. Multi-run safe.
//
// Strategy (v1.14.1+):
//   1. Direct session_id match against runs/*.json — best case
//   2. Single-active-run heal: if no match but exactly 1 active run exists,
//      claim it by updating its session_id to ours. The skill activation
//      seeds session_id with a random hex fallback (CLAUDE_SESSION_ID env
//      var isn't reliably set) so the FIRST hook fire of a session always
//      mismatches — this self-heals on that first fire.
//   3. Multi-active no-match: ambiguous, can't disambiguate without
//      session_id correlation. Return null and let caller fall back.
//
// Returns the resolved run record, or null when no resolution possible.
const resolveRunForSession = (cwd, sessionId) => {
  if (!runs || !sessionId) return null;
  try {
    const direct = runs.resolveBySessionId(cwd, sessionId);
    if (direct) return direct;
    const active = runs.listActive(cwd);
    if (active.length === 1) {
      // Heal: claim the lone active run with this session_id
      runs.update(cwd, active[0].id, { session_id: sessionId });
      return Object.assign({}, active[0], { session_id: sessionId });
    }
  } catch { /* fall through to null */ }
  return null;
};

// Bump last_heartbeat on the run owning this session.
// Multi-run path (M004+): resolves run, updates runs/{id}.json via forge-runs.js
// (which auto-refreshes the legacy auto-mode.json alias).
// Legacy fallback: writes directly to auto-mode.json (pre-M004 workspaces without runs/).
const bumpHeartbeat = (cwd, sessionId) => {
  const r = resolveRunForSession(cwd, sessionId);
  if (r) {
    try { runs.bumpHeartbeat(cwd, r.id); return; }
    catch { /* fall through to legacy */ }
  }
  // Legacy: pre-M004 single-run, no runs/ directory or no session match (+ multi-active)
  try {
    const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
    const auto = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
    if (auto && auto.active === true) {
      auto.last_heartbeat = Date.now();
      fs.writeFileSync(autoFile, JSON.stringify(auto), 'utf8');
    }
  } catch { /* no auto mode or unreadable — ignore */ }
};

// Resolve the directory that OWNS this hook fire — never the raw cwd.
//
// Two-degree ladder (S01/T06), each degree named:
//   1. resolveOwner(cwd, {stopAt: os.homedir()}) — the sole `.gsd` tree-walk
//      this repo allows (forge-workspace.js:150). Handles the plain case: cwd
//      is the workspace, or a subdirectory of it.
//   2. RunRecord.cwd via resolveRunForSession — handles worktree isolation,
//      where the CWD the worker actually runs in (CODE_DIR) has NO `.gsd` in
//      any ancestor (measured 2026-08-14: classify() returns 'none' for every
//      ancestor up to stopAt), but the run that dispatched it recorded the
//      ORIGINAL workspace in `cwd` at registration (forge-runs.js `add()`:
//      `cwd: record.cwd || cwd`). `r.root`/`r.project` are NOT used here —
//      measured null on the live run this task was executed under (additive
//      fields, not populated by this milestone).
//
// Neither degree found → null. Caller MUST treat null as "do not write,
// do not mkdirSync" — never as "create one here" (same contract resolveOwner
// itself documents).
const resolveOwnerDir = (cwd, sessionId) => {
  if (workspaceMod && typeof workspaceMod.resolveOwner === 'function') {
    try {
      const owner = workspaceMod.resolveOwner(cwd, { stopAt: os.homedir() });
      if (owner) return owner;
    } catch { /* fall through to the RunRecord degree */ }
  }
  const r = resolveRunForSession(cwd, sessionId);
  // Security (T06-SECURITY.md, Input Validation blocker 3): `r.cwd` is DATA
  // read from a RunRecord file, not a trusted constant. A record hand-edited
  // or corrupted to carry a bogus `cwd` must not become a NEW directory this
  // hook writes into — it is accepted only when it independently classifies
  // as a real project (`isProject`, same WORK_ENTRIES predicate `resolveOwner`
  // itself uses). Anything else → null, never "create one here".
  if (r && typeof r.cwd === 'string' && r.cwd) {
    if (workspaceMod && typeof workspaceMod.isProject === 'function') {
      try {
        if (workspaceMod.isProject(r.cwd)) return r.cwd;
        return null;
      } catch { return null; }
    }
    // workspaceMod unavailable — cannot validate r.cwd, so it cannot be
    // trusted either (MEM008 silent-fail still holds: exit 0, just no write).
    return null;
  }
  return null;
};

// Resolve unit context for evidence file naming.
//
// Returns the THREE axes `{ milestone, slice, unit }` (S01/T02) alongside the
// pre-existing `{ runId, unitId, kind }` — the old fields are kept verbatim so
// the current file-name call site (:744) keeps working byte-for-byte until T03
// adopts the composite key. Only the RETURN CONTRACT widens here.
//
// An absent milestone/slice axis resolves to the NAMED sentinel exported by
// forge-evidence-path.js — never `''`. An empty axis spliced into a name
// produces `evidence--T01.jsonl`, which re-opens exactly the parse ambiguity
// T01 closed.
//
// Both paths (resolved run record, and the auto-mode.json legacy fallback)
// return all three axes; the fallback has no milestone axis to read from the
// alias, so it names that absence instead of inventing one.
const resolveUnitContext = (cwd, sessionId) => {
  const NO_MS = (evidencePath && evidencePath.SENTINEL_NO_MILESTONE) || '_no-milestone_';
  const NO_SL = (evidencePath && evidencePath.SENTINEL_NO_SLICE) || '_no-slice_';
  const r = resolveRunForSession(cwd, sessionId);
  if (r) {
    const unit = (r.worker || '').split('/')[1] || 'adhoc';
    // Only a milestone-kind run's id IS a milestone id. A task run's id is a
    // task id — naming it "milestone" would be a fabricated axis.
    const milestone = r.kind === 'milestone' && r.id ? r.id : NO_MS;
    const slice = r.worker_slice ? r.worker_slice : NO_SL;
    return { runId: r.id, unitId: unit, kind: r.kind, milestone, slice, unit };
  }
  try {
    const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
    const auto = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
    if (auto && typeof auto.worker === 'string' && auto.worker.length > 0) {
      const parts = auto.worker.split('/');
      const unit = parts.length === 2 ? parts[1] : 'adhoc';
      return {
        runId: null,
        unitId: unit,
        kind: null,
        milestone: NO_MS,
        slice: auto.worker_slice ? auto.worker_slice : NO_SL,
        unit,
      };
    }
  } catch { /* no auto-mode / unreadable → adhoc */ }
  return { runId: null, unitId: 'adhoc', kind: null, milestone: NO_MS, slice: NO_SL, unit: 'adhoc' };
};

// Read forge_isolation.file_locks pref (default true). Returns boolean.
// Skipped check when forge_isolation.mode is worktree (separate FS — no locks needed).
const readFileLocksEnabled = (cwd) => {
  // When prefs are blocked, resolvePrefsSafe intentionally returns {} here;
  // these existing consumer defaults keep the hook inert and fail-open.
  const isolation = resolvePrefsSafe(cwd).prefs.forge_isolation || {};
  const mode = String(isolation.mode || 'shared').toLowerCase();
  const value = isolation.file_locks;
  const enabled = value === undefined ? true : (value === true || String(value).toLowerCase() === 'true');
  if (mode === 'worktree') return false;
  return enabled;
};

// Read evidence.mode from merged prefs (user → repo → local, last wins).
// Valid values: lenient | strict | disabled. Defaults to lenient.
const readEvidenceMode = (cwd) => {
  let mode = String((resolvePrefsSafe(cwd).prefs.evidence || {}).mode || 'lenient').toLowerCase();
  if (mode !== 'lenient' && mode !== 'strict' && mode !== 'disabled') {
    mode = 'lenient';
  }
  return mode;
};

const truncate = (s, max) => {
  if (typeof s !== 'string') return '';
  return s.length <= max ? s : s.slice(0, max) + '…';
};

// ── S03/T03: PreToolUse Bash command-rewrite branch helpers ────────────────
// (`forge-command-rewrite.js` + `forge-resources.js` lazy-required below, dual
// dev/installed path — same idiom as `runs`/`filelock` at the top of the
// file.) Kept as small standalone helpers so the branch body reads linearly.

// Dual-path lazy require: dev (sibling under scripts/) then installed
// (~/.claude/<name>). Returns null (never throws) on total absence — an
// absent module means the branch is inert (T01 key_links contract).
function requireDualPath(name) {
  try { return require(path.join(__dirname, 'scripts', name)); }
  catch {
    try { return require(path.join(__dirname, name)); }
    catch { return null; }
  }
}

// Test-only counting shim (B1 proof). Inert unless FORGE_REWRITE_TEST_COUNTERS
// is set — never touched in production. Each call appends one line naming the
// stage reached, so a test can assert ZERO lines were written for a
// non-candidate command (the lexical gate short-circuited before any of
// these fs/pool/resolver checkpoints ran).
function recordRewriteStage(stage) {
  const counterFile = process.env.FORGE_REWRITE_TEST_COUNTERS;
  if (!counterFile) return;
  try { fs.appendFileSync(counterFile, stage + '\n', 'utf8'); } catch { /* MEM008 */ }
}

// Test-only fault injection (B2 proof). FORGE_REWRITE_FAULT names the stage
// ('tokenizer'|'resolver'|'pool'|'emission') to synthetically fail at — a
// seam honored ONLY under this env var, same pattern as
// FORGE_RESOURCES_PRESSURE (S01) / the fixedNow clock injection (S02).
// Production never sets this var, so the throws below never fire outside a
// test process.
function rewriteFaultStage() {
  return process.env.FORGE_REWRITE_FAULT || '';
}

// Bridge file path — grant persisted so the PostToolUse Bash branch can
// release the lease it took here (W5). Keyed by session_id so concurrent
// sessions on the same box never collide.
function rewriteBridgePath(sessionId) {
  return path.join(os.tmpdir(), `forge-rewrite-grant-${sanitizeRunId(sessionId || 'nosession')}.json`);
}

// Best-effort append to .gsd/forge/events.jsonl — same append idiom as
// appendPrefsBlockedEvent above. Never throws (MEM008); silently a no-op if
// the repo has no .gsd/forge yet.
function appendRewriteEvent(cwd, eventName, fields) {
  try {
    const forgeDir = path.join(cwd, '.gsd', 'forge');
    if (!fs.existsSync(forgeDir)) return;
    const event = Object.assign({ ts: new Date().toISOString(), event: eventName }, fields || {});
    fs.appendFileSync(path.join(forgeDir, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8');
  } catch { /* MEM008 */ }
}

// Forge workers below have a machine-readable return contract consumed by the
// orchestration skills.  Claude Code's SubagentStop hook can repair a missing
// contract in-place: blocking the first stop feeds the reason back to the SAME
// subagent, preserving its context and avoiding a costly fresh dispatch.
//
// forge-memory is deliberately absent.  It is a command-only agent whose
// contract is the fragment written through forge-memory.js, not a final result
// block.  Unknown/custom agents must remain untouched by a global hook.
const RESULT_BLOCK_AGENTS = new Set([
  'forge-advocate',
  'forge-completer',
  'forge-discusser',
  'forge-executor',
  'forge-plan-checker',
  'forge-planner',
  'forge-researcher',
  'forge-reviewer',
  'forge-worker',
]);

const validateForgeSubagentResult = (data) => {
  const agentType = String(data && data.agent_type || '');
  if (!RESULT_BLOCK_AGENTS.has(agentType)) {
    return { ok: true, reason: 'not-forge-worker', tracked: false, hasBlock: null };
  }

  const message = String(data && data.last_assistant_message || '');
  const hasBlock = message.includes('---GSD-WORKER-RESULT---');

  // Claude Code sets stop_hook_active on the continuation caused by a blocking
  // stop hook.  Fail open then, even if the worker ignored the feedback, so a
  // malformed model response can never create an infinite hook loop.
  //
  // Failing open is right; reporting the escape as success is not.  This branch
  // used to return before `hasBlock` was ever computed, so the caller wrote
  // `status: 'done'` for a worker that never emitted the contract — the very
  // "a truncated agent is indistinguishable from a finished one" pathology,
  // stamped into the artifact meant to tell them apart.  `hasBlock` now rides
  // along on every return so the caller can fail open AND say what happened.
  if (data && data.stop_hook_active === true) {
    return { ok: true, reason: 'retry-escape', tracked: true, hasBlock };
  }

  if (!hasBlock) {
    return {
      ok: false,
      tracked: true,
      hasBlock: false,
      // The wording matters more than it looks. The previous text said "only
      // inspect your current result and emit the missing structured block",
      // which a compliant agent obeys literally: it emits the result block
      // ALONE. For agents whose deliverable is inline prose in that same
      // message (forge-advocate's per-objection verdicts, forge-reviewer's
      // findings), the orchestrator then reads a scoreboard with the payload
      // stripped off. That is a measured failure mode, not a hypothetical:
      // M018 lost six advocate defenses this way, three of them returning
      // exactly `refuted=3 conceded=2 open=1` and nothing else. So the repair
      // instruction must ask for the COMPLETE answer while still forbidding
      // the expensive part (re-running tools).
      reason: [
        `Forge contract missing for ${agentType}.`,
        'Re-emit your COMPLETE final answer in ONE message: every inline deliverable your agent instructions require (per-objection verdicts, findings, summary prose), followed by the ---GSD-WORKER-RESULT--- block.',
        'Do not re-run tools or redo investigation — restate the conclusions you already reached.',
        'A message containing only the result block discards your work: the orchestrator reads this message and nothing else.',
      ].join(' '),
    };
  }

  return { ok: true, reason: 'valid', tracked: true, hasBlock: true };
};

// Durable record of a worker that stopped without its contract.
//
// The blocking stdout above is transient: it goes to the subagent, never to the
// orchestrator, and nothing survives the turn.  When the repair pass also comes
// back without the block, the orchestrator is handed a truncated message and no
// way to know a contract miss even happened — so it infers, and the inference is
// where sessions start improvising.  One append-only line puts the fact
// somewhere the model does not author.
//
// Silent-fail throughout (MEM008): a hook must never abort the tool call it
// observes.  Never creates `.gsd/forge` — in a non-Forge repo there is nothing
// to record and nothing to scaffold.
const recordContractMiss = (cwd, data, missPhase, agentType) => {
  try {
    const forgeDir = path.join(cwd, '.gsd', 'forge');
    if (!fs.existsSync(forgeDir)) return;
    const message = String(data && data.last_assistant_message || '');
    fs.appendFileSync(path.join(forgeDir, 'contract-miss.jsonl'), JSON.stringify({
      ts        : new Date().toISOString(),
      session_id: data && data.session_id ? String(data.session_id) : '',
      agent_id  : data && data.agent_id ? String(data.agent_id) : '',
      agent_type: agentType,
      phase     : missPhase, // 'repair-requested' → blocked once | 'escaped' → failed open
      chars     : message.length,
      tail      : truncate(message.slice(-240), 240),
    }) + '\n', 'utf8');
  } catch { /* recording a miss must never become a second failure */ }
};

// ── Schema-mismatch guard helpers (SessionStart) ──────────────────────────────
// Lazy-load forge-doctor (owns checkSchema + CURRENT_SCHEMA). Same dev/installed
// resolution as runs/filelock above: installed → ~/.claude/scripts/, dev → sibling.
const loadDoctor = () => {
  try { return require(path.join(__dirname, 'scripts', 'forge-doctor.js')); } catch {}
  try { return require(path.join(__dirname, 'forge-doctor.js')); } catch {}
  return null;
};

// Lazy-load forge-schema-guard (owns parseSchemaSemver + cmpSemver). Same
// dev/installed resolution as loadDoctor above. When the helper doesn't
// resolve (missing file, broken require), buildSchemaWarning below falls back
// to the generic divergence message — it never reintroduces a local copy of
// the comparator and never throws (MEM008: hook is absolute silent-fail).
const loadSchemaGuard = () => {
  try { return require(path.join(__dirname, 'scripts', 'forge-schema-guard.js')); } catch {}
  try { return require(path.join(__dirname, 'forge-schema-guard.js')); } catch {}
  return null;
};

// Build the high-visibility warning injected into session context on mismatch.
// res = { ok, expected (local tooling schema), actual (repo .gsd/SCHEMA-VERSION) }.
// Direction matters: tooling OLDER than repo is the dangerous case (a closing
// milestone may be written to a monolith the repo now ignores → silently dropped).
const buildSchemaWarning = (res) => {
  const tooling = res.expected; // CURRENT_SCHEMA baked into the local tooling
  const repo    = res.actual;   // .gsd/SCHEMA-VERSION committed in the repo
  const guard = loadSchemaGuard();
  const header = '⚠️ ATENÇÃO — incompatibilidade de schema do Forge';

  if (!guard || typeof guard.parseSchemaSemver !== 'function' || typeof guard.cmpSemver !== 'function') {
    return [
      header,
      `A tooling Forge (${tooling}) e o schema do repo (${repo}) divergem.`,
      'Rode /forge-update ou /forge-doctor --fix --migrate antes de fechar milestone.',
    ].join('\n');
  }

  const tv = guard.parseSchemaSemver(tooling);
  const rv = guard.parseSchemaSemver(repo);
  const dir = (tv && rv) ? guard.cmpSemver(tv, rv) : null;

  if (dir === -1) {
    // tooling < repo — the headline failure mode
    return [
      header,
      `Sua tooling Forge local (${tooling}) é MAIS ANTIGA que o schema deste repositório (${repo}).`,
      'Rode /forge-update ANTES de fechar qualquer milestone — senão sua entrada de LEDGER/DECISIONS',
      'pode ser gravada num arquivo que o repo ignora e NÃO será commitada (perda silenciosa).',
    ].join('\n');
  }
  if (dir === 1) {
    // tooling > repo — repo needs migrating up
    return [
      header,
      `Sua tooling Forge local (${tooling}) é MAIS NOVA que o schema deste repositório (${repo}).`,
      'Rode /forge-doctor --fix --migrate para migrar o repo ao schema atual antes de continuar.',
    ].join('\n');
  }
  // Unparseable on one side — generic divergence notice
  return [
    header,
    `A tooling Forge (${tooling}) e o schema do repo (${repo}) divergem.`,
    'Rode /forge-update ou /forge-doctor --fix --migrate antes de fechar milestone.',
  ].join('\n');
};

// Testability seam (S01/T02): the hook is a CLI first — `require`-ing it must
// NOT wire stdin (a listener that never sees `end` would hang the requiring
// process). Exporting resolveUnitContext lets its three-axis contract be
// exercised directly instead of asserted through a spawned hook fire.
module.exports = { resolveUnitContext, sanitizeRunId, resolveRunForSession, resolveOwnerDir };
if (require.main !== module) return;

process.stdin.setEncoding('utf8');
let raw = '';
process.stdin.on('data', chunk => (raw += chunk));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(raw);
    const sessionId = data.session_id || '';
    const cwd       = data.cwd || process.cwd();

    // ── SessionStart: warn on forge tooling ↔ repo schema mismatch ──────────
    // Deterministic guard (does NOT depend on the model reading CLAUDE.md):
    // fires on startup/resume/clear/compact. When the local tooling schema
    // differs from the committed .gsd/SCHEMA-VERSION, inject a loud notice so
    // the user runs /forge-update before a milestone close silently drops a
    // ledger entry into a now-ignored monolith. Never blocks the session.
    if (phase === 'session-start') {
      try {
        if (!fs.existsSync(path.join(cwd, '.gsd'))) return; // not a forge project — stay silent
        const doctor = loadDoctor();
        if (!doctor || typeof doctor.checkSchema !== 'function') return;
        const res = doctor.checkSchema(cwd);
        // Warn only on a real mismatch against an EXISTING stamp. actual == null
        // means the repo has no SCHEMA-VERSION yet (fresh / pre-schema project) —
        // that is not a mismatch, so we stay silent to avoid false alarms.
        if (res.ok || res.actual == null) return;
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: buildSchemaWarning(res),
          },
        }));
      } catch { /* never block session start (MEM008) */ }
      return;
    }

    // ── SubagentStart: log start timestamp for timing ───────────────────────
    if (phase === 'subagent-start') {
      const agentType  = data.agent_type  || 'unknown';
      const agentId    = data.agent_id    || '';
      const liveFile   = path.join(os.tmpdir(), `forge-live-${sessionId || 'unknown'}.json`);

      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(liveFile, 'utf8')); } catch {}

      fs.writeFileSync(liveFile, JSON.stringify({
        ...existing,
        status          : 'dispatching',
        subagent_type   : agentType,
        agent_id        : agentId,
        subagent_started: Date.now(),
      }), 'utf8');

      bumpHeartbeat(cwd, sessionId);
      return;
    }

    // ── SubagentStop: compute real worker duration ───────────────────────────
    if (phase === 'subagent-stop') {
      const liveFile  = path.join(os.tmpdir(), `forge-live-${sessionId || 'unknown'}.json`);

      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(liveFile, 'utf8')); } catch {}

      const started   = existing.subagent_started || Date.now();
      const durationMs = Date.now() - started;

      const contract = validateForgeSubagentResult(data);
      const agentType = String(data && data.agent_type || existing.subagent_type || '');

      if (!contract.ok) {
        recordContractMiss(cwd, data, 'repair-requested', agentType);
        fs.writeFileSync(liveFile, JSON.stringify({
          ...existing,
          status           : 'repairing-contract',
          subagent_duration: durationMs,
        }), 'utf8');

        bumpHeartbeat(cwd, sessionId);
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: contract.reason,
        }));
        return;
      }

      // Failed open on the repair pass and STILL no contract.  The stop is
      // allowed (no infinite loop), but it is not reported as `done`: the
      // orchestrator's missing-result branch keys off exactly this distinction.
      const escaped = contract.tracked === true && contract.hasBlock === false;
      if (escaped) recordContractMiss(cwd, data, 'escaped', agentType);

      fs.writeFileSync(liveFile, JSON.stringify({
        ...existing,
        status           : escaped ? 'contract-missed' : 'done',
        subagent_duration: durationMs,
        completed_at     : Date.now(),
      }), 'utf8');

      bumpHeartbeat(cwd, sessionId);
      return;
    }

    // ── PreCompact: backup STATE.md before context compression ──────────────
    if (phase === 'pre-compact') {
      const stateFile  = path.join(cwd, '.gsd', 'STATE.md');
      const backupFile = path.join(cwd, '.gsd', 'STATE.pre-compact.md');
      try {
        if (fs.existsSync(stateFile)) {
          fs.copyFileSync(stateFile, backupFile);
        }
      } catch { /* not a forge project — skip */ }
      return;
    }

    // ── PostCompact: write recovery signal if forge-auto was active ────────────
    // M004: scoped per-session — compact-signal-{sessionId}.json
    // Legacy fallback: also writes unscoped compact-signal.json (helps pre-M004 boot)
    if (phase === 'post-compact') {
      let recoverySignal = false;
      let runId = null;
      let worker = null;

      const r = resolveRunForSession(cwd, sessionId);
      if (r && r.active === true) {
        recoverySignal = true;
        runId = r.id;
        worker = r.worker;
      }

      if (!recoverySignal) {
        try {
          const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
          const autoMode = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
          if (autoMode && autoMode.active === true) {
            recoverySignal = true;
            worker = autoMode.worker || null;
          }
        } catch {}
      }

      if (recoverySignal) {
        const payload = JSON.stringify({
          recovered_at: Date.now(),
          milestone: runId,
          worker,
          session_id: sessionId || null,
        });
        const dir = path.join(cwd, '.gsd', 'forge');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        if (sessionId) {
          try { fs.writeFileSync(path.join(dir, `compact-signal-${sanitizeRunId(sessionId)}.json`), payload, 'utf8'); } catch {}
        }
        try { fs.writeFileSync(path.join(dir, 'compact-signal.json'), payload, 'utf8'); } catch {}
      }
      return;
    }

    // ── Stop: block Claude from stopping when a fresh Forge run is active ────
    // Guards run in order; any allow path returns immediately.
    // Resolution is READ-ONLY (resolveBySessionId only) — never resolveRunForSession (has heal).
    // Counter lives in os.tmpdir() — max 3 consecutive blocks, then allow + reset.
    if (phase === 'stop') {
      try {
        const REASON  = 'Active Forge run with fresh heartbeat — the dispatch loop must not stop mid-run.';
        const CONTINUE = 'A Forge run is still active in this workspace. Re-read .gsd/STATE.md, derive the next unit from the dispatch table, and continue the dispatch loop. To stop intentionally: create .gsd/forge/pause or deactivate the run via scripts/forge-runs.js --update <id> --json \'{"active":false}\'.';

        const stopCounterFile = path.join(os.tmpdir(), `forge-stop-blocks-${sessionId}.json`);

        const readCount = () => {
          try {
            const parsed = JSON.parse(fs.readFileSync(stopCounterFile, 'utf8'));
            return (typeof parsed.count === 'number') ? parsed.count : 0;
          } catch { return 0; }
        };
        const writeCount = (n) => {
          try { fs.writeFileSync(stopCounterFile, JSON.stringify({ count: n, updated_at: Date.now() }), 'utf8'); } catch {}
        };
        const resetCount = () => writeCount(0);

        // Guard 1: stop_hook_active flag — allow when explicitly set (counter untouched)
        if (data.stop_hook_active === true) return;

        // Guard 2: no .gsd/forge/ — not a forge workspace, no-op (~1 stat)
        if (!fs.existsSync(path.join(cwd, '.gsd', 'forge'))) return;

        // Guard 3: pause file present — allow + reset counter
        if (fs.existsSync(path.join(cwd, '.gsd', 'forge', 'pause'))) {
          resetCount();
          return;
        }

        // Guard 4: resolve run READ-ONLY (never resolveRunForSession)
        let run = null;
        if (runs) {
          run = runs.resolveBySessionId(cwd, sessionId);
        }
        // Legacy fallback: check auto-mode.json (read-only, no update)
        if (!run) {
          try {
            const autoFile = path.join(cwd, '.gsd', 'forge', 'auto-mode.json');
            const auto = JSON.parse(fs.readFileSync(autoFile, 'utf8'));
            if (auto && auto.active === true && auto.session_id === sessionId) {
              run = auto;
            }
          } catch {}
        }
        if (!run) {
          resetCount();
          return; // no matching run for this session
        }

        // Guard 5: stale heartbeat — allow + reset counter
        // last_heartbeat is a numeric epoch in production (forge-runs.js writes
        // Date.now()); ISO strings are tolerated for hand-edited/legacy records.
        const hb = run.last_heartbeat;
        const threshold = (runs && runs.ACTIVE_THRESHOLD_MS) ? runs.ACTIVE_THRESHOLD_MS : 15 * 60 * 1000;
        const hbMs = (typeof hb === 'number') ? hb : (hb ? Date.parse(hb) : NaN);
        if (!hb || isNaN(hbMs) || (Date.now() - hbMs) >= threshold) {
          resetCount();
          return;
        }

        // Guard 5.5 (2026-08-24): worker in flight — allow + reset. A non-null
        // run.worker means the orchestrator DISPATCHED a unit and is waiting on
        // the async Agent() result; ending the turn is the loop's CORRECT state
        // there (the completion notification re-invokes it). Measured before
        // this guard: every wait boundary of a live run cost 1 block + 1 filler
        // tool call just to satisfy the hook — friction, not protection. A
        // stale worker stamp cannot wedge this open: the heartbeat travels WITH
        // the worker stamp, and Guard 5 already allowed on a stale heartbeat.
        if (run.worker) {
          resetCount();
          return;
        }

        // Guard 6: counter exhausted (>= 3) — allow + reset (5th will block again)
        const count = readCount();
        if (count >= 3) {
          writeCount(0);
          return;
        }

        // Guard 7: block — increment counter, emit block output
        writeCount(count + 1);
        process.stdout.write(JSON.stringify({
          decision: 'block',
          reason: REASON,
          hookSpecificOutput: {
            hookEventName: 'Stop',
            additionalContext: CONTINUE,
          },
        }));
      } catch { /* silent-fail — hook must never crash (MEM008) */ }
      return;
    }

    // ── PreToolUse / PostToolUse: track Agent dispatches ────────────────────
    const toolName  = data.tool_name  || '';
    const toolInput = data.tool_input || {};

    // ── Safety guards (PreToolUse only) ─────────────────────────────────────
    if (phase === 'pre') {
      let blockMessage = null;

      // ── Bash guards ────────────────────────────────────────────────────────
      if (toolName === 'Bash') {
        const cmd = toolInput.command || '';

        if (/git\s+commit\b/.test(cmd) && /--no-verify\b/.test(cmd)) {
          blockMessage = '[forge-hook] Bloqueado: git commit --no-verify contorna hooks de pre-commit. Corrija a falha do hook.';
        }

        if (!blockMessage && /git\s+push\b/.test(cmd)) {
          const cmdWithoutSafe = cmd.replace(/--force-with-lease\S*/g, '');
          if (/--force\b/.test(cmdWithoutSafe) || /(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*(?:\s|$)/.test(cmdWithoutSafe)) {
            blockMessage = '[forge-hook] Bloqueado: git push --force pode sobrescrever commits remotos. Use --force-with-lease se necessário.';
          }
        }

        if (!blockMessage && /\brm\b/.test(cmd) && /\.gsd/.test(cmd)) {
          const flagsMatch = cmd.match(/\B-([a-zA-Z]+)/g) || [];
          const allFlags   = flagsMatch.join('');
          if (allFlags.includes('r') && allFlags.includes('f')) {
            blockMessage = '[forge-hook] Bloqueado: remoção destrutiva de .gsd/ protege o estado do Forge.';
          }
        }
      }

      // ── Write guard — protect append-only files (DECISIONS.md, LEDGER.md) ─
      if (!blockMessage && toolName === 'Write') {
        const filePath = toolInput.file_path || '';
        const isAppendOnly = /[/\\]\.gsd[/\\](DECISIONS|LEDGER)\.md$/.test(filePath);
        if (isAppendOnly) {
          try {
            if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
              const name = path.basename(filePath);
              blockMessage = `[forge-hook] Bloqueado: Write em ${name} (append-only). Use Edit: Read o arquivo completo primeiro (sem limit, paginando se grande), depois Edit com old_string = última linha existente (exata) e new_string = essa linha + newline + nova(s) linha(s). Ou Bash: cat >> ${filePath.replace(/.*\.gsd/, '.gsd')} << 'EOF' (nunca >).`;
            }
          } catch { /* can't stat — allow */ }
        }
      }

      // ── Write / Edit guards — block hardcoded secrets ────────────────────
      if (!blockMessage && (toolName === 'Write' || toolName === 'Edit')) {
        const filePath  = toolInput.file_path || '';
        const content   = toolName === 'Write' ? (toolInput.content || '') : (toolInput.new_string || '');

        const isSafeEnvFile = /\.env\.(example|sample)$/i.test(filePath);

        if (!isSafeEnvFile) {
          const secretPattern = /(API_KEY|SECRET_KEY|PRIVATE_KEY|PASSWORD)\s*=\s*["'][^${\s]{8,}/;
          const lines = content.split('\n');
          const hasBareSecret = lines.some(line => {
            const trimmed = line.trimStart();
            if (trimmed.startsWith('#') || trimmed.startsWith('//')) return false;
            return secretPattern.test(line);
          });
          if (hasBareSecret) {
            blockMessage = '[forge-hook] Bloqueado: possível secret hardcoded detectado. Use variável de ambiente.';
          }
        }
      }

      // ── File-lock cross-run check (M004+, shared/branch modes only) ────────
      if (!blockMessage && (toolName === 'Write' || toolName === 'Edit') && filelock && runs && sessionId) {
        const filePath = toolInput.file_path || '';
        if (filePath && readFileLocksEnabled(cwd)) {
          try {
            const r = resolveRunForSession(cwd, sessionId);
            if (r && r.active) {
              const rel = path.isAbsolute(filePath) ? path.relative(cwd, filePath) : filePath;
              // The persisted token is the ownership proof.  Run/session IDs
              // remain diagnostic and are only used to discover this run's
              // identity for a reentrant edit.  The status API intentionally
              // never exposes the persisted owner token.
              const current = filelock.checkFileLock(cwd, rel);
              const sameSession = current && current.held && current.holder &&
                current.holder.run_id === r.id && current.holder.session_id === sessionId;
              // A hook invocation cannot safely recover a private token from a
              // public status read.  Treat the same active run/session as a
              // reentrant owner and let the file-lock layer continue to fence
              // competing run/session identities.
              // 4a (PR #110): the reentrant path RENEWS. It used to return `{acquired:true,
              // reentrant:true}` without touching the lock, so `renewed_at` never advanced and the
              // clock measured *time since the FIRST write* instead of *time since the last* —
              // exactly the premise the clock-only doctrine assumed true in order to justify itself.
              // `acquireFileLock` cannot be reused here (a hook cannot recover the private
              // owner_token from a public status read, so it would steal from itself by another
              // door). `touchFileLock` compares identity — run_id AND session_id — and refuses
              // anything else with `owner_mismatch`, in which case we fall through to normal
              // acquisition rather than pretending the renewal happened.
              let result;
              if (sameSession) {
                const touched = filelock.touchFileLock(cwd, rel, { runId: r.id, sessionId });
                result = touched && touched.ok
                  ? { acquired: true, reentrant: true, renewed: true }
                  : filelock.acquireFileLock(cwd, rel, r.id, sessionId, { intent: toolName.toLowerCase() });
              } else {
                result = filelock.acquireFileLock(cwd, rel, r.id, sessionId, { intent: toolName.toLowerCase() });
              }
              if (!result.acquired) {
                const h = result.holder || {};
                const ageS = Math.round((h.age_ms || 0) / 1000);
                if (result.reason === 'guard_busy') {
                  blockMessage = `[forge-hook] Bloqueado: mutex do arquivo "${rel}" está ocupado; tente novamente.`;
                } else if (result.reason === 'holder_unmeasured') {
                  // 4b: fail-closed, NAMED, with the operator's only exit written where they read it.
                  // The lock is held by a run whose liveness could not be measured (illegible or
                  // truncated `runs/<id>.json`). No code path can convert this one — the reaper only
                  // reaches records it can read — so the way out is a human act, and it is spelled out.
                  blockMessage = `[forge-hook] Bloqueado: arquivo "${rel}" preso por run ${h.run_id || 'desconhecido'} cuja atividade NÃO pôde ser medida (registro ilegível). `
                    + `A idade sozinha não libera este lock — liveness vence o relógio. Saídas: /forge-pause ${h.run_id || '<run>'}, `
                    + `ou remova o registro ilegível .gsd/forge/runs/${h.run_id || '<run>'}.json.`;
                } else if (h.run_diagnostic === 'active-run') {
                  blockMessage = `[forge-hook] Bloqueado: arquivo "${rel}" em uso por run ${h.run_id || 'desconhecido'} (VIVA) há ${ageS}s. `
                    + `Um dono vivo nunca perde o lock para a idade. Aguarde ou execute /forge-pause ${h.run_id || ''}.`;
                } else {
                  blockMessage = `[forge-hook] Bloqueado: arquivo "${rel}" em uso por run ${h.run_id || 'desconhecido'} há ${ageS}s. Aguarde ou execute /forge-pause ${h.run_id || ''}.`;
                }
              }
            }
          } catch (error) {
            blockMessage = `[forge-hook] Bloqueado: não foi possível validar o file-lock de "${filePath}" (${error.message}). Tente novamente.`;
          }
        }
      }

      // ── Command-rewrite branch (S03/T03) ───────────────────────────────────
      // Runs only when nothing above blocked the command (guard ordering,
      // T03 truth #1: a blocked command is NEVER rewritten). B1: the lexical
      // gate (`looksLikeRunnerCommand`, pure string, zero I/O) short-circuits
      // BEFORE any fs/spawnSync/prefs/pool/resolver work — the resolver
      // module isn't even required for a non-candidate command. B2/MEM008:
      // this entire branch is wrapped so ANY exception at ANY stage
      // (tokenizer, resolver, pool acquire, emission serialization) falls
      // through with the command byte-identical, hook exit 0, no stdout
      // rewrite emission — this branch blocks NOTHING, ever (unlike the
      // guards above, which `exit(2)`). This branch NEVER emits
      // `permissionDecision` — T02 measured `updatedInput` is honored
      // without it in the headless path `forge-hook.js` runs in
      // (T02-SUMMARY Answer 1), so the permission-widening hazard (S03-PLAN
      // Notes) never arises: no chain segment is ever auto-allowed here.
      if (!blockMessage && toolName === 'Bash') {
        try {
          const cmd = toolInput.command || '';
          const rewriteMod = requireDualPath('forge-command-rewrite.js');
          if (rewriteMod && typeof rewriteMod.looksLikeRunnerCommand === 'function') {
            const fault = rewriteFaultStage();
            const isCandidate = rewriteMod.looksLikeRunnerCommand(cmd);
            // Synthetic tokenizer-stage fault (test-only, B2 proof) — thrown
            // AFTER the real (successful) gate call, simulating a tokenizer
            // failure downstream of the pure check without touching T01's
            // module. Never reachable without FORGE_REWRITE_FAULT set.
            if (fault === 'tokenizer') throw new Error('forced-fault:tokenizer');
            if (isCandidate) {
              let acquiredHandle = null;
              let resourcesMod = null;
              try {
                recordRewriteStage('resolver-require');
                resourcesMod = requireDualPath('forge-resources.js');
                if (fault === 'resolver') throw new Error('forced-fault:resolver');
                if (resourcesMod && typeof resourcesMod.acquireCommandBudget === 'function') {
                  recordRewriteStage('resolver-acquire');
                  // TTL derives from tool_input.timeout per S02's
                  // deriveSlotTtlMs contract (forge-resource-pool.js) — this
                  // branch performs zero sizing math itself (D10).
                  const contract = resourcesMod.acquireCommandBudget({
                    cwd,
                    commandTimeoutMs: toolInput.timeout,
                    session: sessionId,
                  });
                  if (contract && contract.pool && contract.pool.handle &&
                      Array.isArray(contract.pool.handle.slots) && contract.pool.handle.slots.length) {
                    acquiredHandle = contract.pool.handle;
                  }
                  if (fault === 'pool') throw new Error('forced-fault:pool');

                  if (contract && contract.enforcement === 'off') {
                    // `resources.enforcement: off` (S06/T03) — same bypass as
                    // forge-verify.js / forge-reverify.js. Releases the lease
                    // (W5) and returns WITHOUT writing the `updatedInput`
                    // stdout payload, so the executor's command passes
                    // through byte-identical. FAIL-SAFE: only the exact
                    // string `off` bypasses; any other value leaves the
                    // rewrite ON. D10: reads, never derives.
                    if (acquiredHandle) {
                      try {
                        recordRewriteStage('release-enforcement-off');
                        resourcesMod.releaseCommandBudget(acquiredHandle, { cwd });
                      } catch { /* MEM008 */ }
                    }
                    appendRewriteEvent(cwd, 'rewrite-skipped', { reason: 'intact:enforcement-off' });
                    return;
                  }

                  if (contract && contract.admit === false) {
                    // Critical pressure: admission refused — the same guard
                    // forge-verify.js / forge-reverify.js already carry. D3
                    // is LOCKED: never refuse the spawn. Skip the rewrite and
                    // let the command through byte-identical rather than hand
                    // the planner a zero-worker contract: `--maxWorkers=0` /
                    // `VITEST_MAX_FORKS=0` are FALSY to the runners, so the
                    // "cap" the rewrite would announce does not exist (full
                    // parallelism), and playwright's `--workers=0` can break
                    // the command outright. Emitting `rewrite-applied` here
                    // would be telemetry claiming control at the exact moment
                    // there is none. The reason reuses the enum member
                    // forge-resources.js owns (D8) — if a stale installed
                    // copy lacks REASON_CODES the member access throws and
                    // the inner catch still falls through intact (MEM008).
                    const refusedReason =
                      resourcesMod.REASON_CODES.INTACT_ADMISSION_REFUSED_ADVISORY;
                    if (acquiredHandle) {
                      // W5: an admit:false contract holds no slots today
                      // (acquireCommandBudget returns before the pool), but a
                      // future acquire path that does grant one must not leak
                      // its lease through this branch.
                      try {
                        recordRewriteStage('release-admission-refused');
                        resourcesMod.releaseCommandBudget(acquiredHandle, { cwd });
                      } catch { /* MEM008 */ }
                    }
                    appendRewriteEvent(cwd, 'rewrite-skipped', { reason: refusedReason });
                    return;
                  }

                  const plan = rewriteMod.planRewrite(cmd, contract, { cwd });
                  if (plan.outcome === 'rewritten') {
                    if (fault === 'emission') throw new Error('forced-fault:emission');
                    if (acquiredHandle) {
                      const cmdHash = require('crypto').createHash('sha256').update(plan.command).digest('hex');
                      try {
                        recordRewriteStage('bridge-write');
                        fs.writeFileSync(rewriteBridgePath(sessionId), JSON.stringify({
                          cmdHash,
                          grant: acquiredHandle,
                          ts: Date.now(),
                        }), 'utf8');
                      } catch { /* MEM008 — bridge write is best-effort */ }
                    }
                    appendRewriteEvent(cwd, 'rewrite-applied', {
                      runner: plan.runner,
                      workers: contract.workers,
                      heapMb: contract.heapMb,
                    });
                    // Single-stdout invariant: this is the ONLY stdout write
                    // of the pre invocation on this path. No
                    // permissionDecision field (see comment above the
                    // branch).
                    process.stdout.write(JSON.stringify({
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        updatedInput: { command: plan.command },
                      },
                    }));
                    return;
                  }
                  // outcome === 'intact': release any lease taken above
                  // immediately (W5 — non-error intact path).
                  if (acquiredHandle) {
                    try {
                      recordRewriteStage('release-intact');
                      resourcesMod.releaseCommandBudget(acquiredHandle, { cwd });
                    } catch { /* MEM008 */ }
                  }
                  appendRewriteEvent(cwd, 'rewrite-skipped', { reason: plan.reason });
                }
              } catch (innerErr) {
                // W5: release-on-error — a lease acquired above MUST be
                // released here, BEFORE falling through with the command
                // intact. Never re-throw; the outer catch would still
                // degrade safely, but releasing here (not there) is what
                // the leaked-lease test asserts against.
                if (acquiredHandle && resourcesMod && typeof resourcesMod.releaseCommandBudget === 'function') {
                  try {
                    recordRewriteStage('release-error');
                    resourcesMod.releaseCommandBudget(acquiredHandle, { cwd });
                  } catch { /* MEM008 */ }
                }
                // Fall through — command proceeds byte-identical, no stdout
                // rewrite emission (B2).
              }
            }
          }
        } catch { /* MEM008 — top-level guard: command proceeds byte-identical */ }
      }

      if (blockMessage) {
        process.stdout.write(blockMessage + '\n');
        process.exit(2);
      }
    }

    // ── PostToolUse: evidence capture (Bash/Write/Edit only) ─────────────────
    // S01/T03: file name is owned by forge-evidence-path.js's composite key
    // (milestone~slice~unit), built from the three axes resolveUnitContext
    // (S01/T02) now returns. `evidencePath` is the same lazy/tolerant
    // require used by every sibling module in this file — module missing →
    // this branch degrades to the legacy bare/adhoc name and NEVER aborts
    // the tool call (MEM008).
    //
    // S01/T06: the OWNER is resolved BEFORE the unit — never the raw cwd.
    // Without this order the branch below can `mkdirSync` a fresh `.gsd/` at
    // whatever directory the shell happened to be anchored in (the SVN/WDMA
    // orphans this task closes). When no owner resolves, `mkdirSync` is
    // UNREACHABLE: the whole branch returns instead — never "create one here".
    if (phase === 'post' && (toolName === 'Bash' || toolName === 'Write' || toolName === 'Edit')) {
      try {
        const mode = readEvidenceMode(cwd);
        // No owner resolvable → skip entirely. `mkdirSync` below is UNREACHABLE
        // in that case, not merely unlikely — never "create one here" (a bare
        // `return` here would also skip the unrelated phase==='post' blocks
        // below, e.g. the context monitor, so the guard is an `if`, not a
        // short-circuit return).
        const ownerDir = mode !== 'disabled' ? resolveOwnerDir(cwd, sessionId) : null;
        if (mode !== 'disabled' && ownerDir) {
          const ctx = resolveUnitContext(ownerDir, sessionId);
          const evidenceDir  = path.join(ownerDir, '.gsd', 'forge');
          const fileSlug = evidencePath && typeof evidencePath.buildEvidenceFileName === 'function'
            ? evidencePath.buildEvidenceFileName({ milestone: ctx.milestone, slice: ctx.slice, unit: ctx.unit })
            : (ctx.runId
                ? `evidence-${sanitizeRunId(ctx.runId)}-${ctx.unitId}.jsonl`
                : `evidence-${ctx.unitId}.jsonl`);
          const evidenceFile = path.join(evidenceDir, fileSlug);

          const toolResponse = data.tool_response || {};
          const line = {
            ts          : Date.now(),
            tool        : toolName,
            cmd         : truncate(toolInput.command || '', 200),
            file        : toolInput.file_path || null,
            ok          : toolResponse.success !== false && toolResponse.interrupted !== true,
            interrupted : toolResponse.interrupted === true,
          };

          let serialized = JSON.stringify(line);
          if (Buffer.byteLength(serialized, 'utf8') > 512) {
            line.cmd = truncate(line.cmd, 80);
            line.file = truncate(line.file || '', 200) || null;
            serialized = JSON.stringify(line);
            if (Buffer.byteLength(serialized, 'utf8') > 512) {
              line.cmd = '[truncated]';
              serialized = JSON.stringify(line);
            }
          }

          fs.mkdirSync(evidenceDir, { recursive: true });
          fs.appendFileSync(evidenceFile, serialized + '\n', 'utf8');
        }
      } catch { /* silent-fail — hook must never crash Claude Code (MEM008) */ }
    }

    // ── PostToolUse: release the command-rewrite bridge (S03/T03, W5) ──────
    // If a Pre invocation rewrote this command it left a bridge keyed by
    // session_id with the sha256 of the REWRITTEN command. Match here means
    // Claude actually ran the rewritten command (releasing the lease it
    // consumed). A mismatch — or no bridge at all — means either this isn't
    // a rewrite candidate, or Claude ignored the rewrite (T02 Q3 case): left
    // untouched for TTL reap, never counted as a release success.
    if (phase === 'post' && toolName === 'Bash') {
      try {
        const bridgePath = rewriteBridgePath(sessionId);
        const bridgeRaw = fs.readFileSync(bridgePath, 'utf8');
        const bridge = JSON.parse(bridgeRaw);
        const executedHash = require('crypto').createHash('sha256').update(toolInput.command || '').digest('hex');
        if (bridge && bridge.cmdHash === executedHash) {
          const resourcesMod = requireDualPath('forge-resources.js');
          if (resourcesMod && typeof resourcesMod.releaseCommandBudget === 'function') {
            resourcesMod.releaseCommandBudget(bridge.grant, { cwd });
          }
          try { fs.unlinkSync(bridgePath); } catch { /* MEM008 */ }
        }
        // Mismatch: leave the bridge in place for TTL reap — do not delete,
        // do not release (the rewritten command never actually ran).
      } catch { /* no bridge, unreadable, or release failure — MEM008 no-op */ }
    }

    // ── PostToolUse: proactive context monitor (writes additionalContext, never blocks) ──
    // Complements (does not replace) the PostCompact reactive recovery.
    if (phase === 'post') {
      try {
        if (ctxMonitor && sessionId) {
          const prefs = ctxMonitor.readContextMonitorPrefs(cwd);
          if (prefs.enabled) {
            const bridgeFile = path.join(os.tmpdir(), `forge-ctx-${sessionId}.json`);
            let bridge = null;
            try { bridge = JSON.parse(fs.readFileSync(bridgeFile, 'utf8')); } catch {}
            if (bridge && !ctxMonitor.isStale(bridge.ts)) {
              const severity = ctxMonitor.severityFor(bridge.context_pct_remaining, prefs.thresholds);
              const debounceFile = path.join(os.tmpdir(), `forge-ctx-debounce-${sanitizeRunId(sessionId)}.json`);
              let dstate = {};
              try { dstate = JSON.parse(fs.readFileSync(debounceFile, 'utf8')); } catch {}
              const decision = ctxMonitor.shouldInject(severity, dstate);
              try { fs.writeFileSync(debounceFile, JSON.stringify(decision.nextState), 'utf8'); } catch {}
              if (decision.inject) {
                process.stdout.write(JSON.stringify({
                  hookSpecificOutput: {
                    hookEventName: 'PostToolUse',
                    additionalContext: ctxMonitor.buildAdditionalContext(severity, prefs.thresholds),
                  },
                }));
              }
            }
          }
        }
      } catch { /* silent-fail — context monitor never aborts a tool call (MEM008) */ }
    }

    // ── PostToolUse: usage poll (token-auth sessions only) ───────────────────
    // Under ANTHROPIC_AUTH_TOKEN, Claude Code omits rate_limits, so the
    // statusline's 5h/weekly bars and forge-auto's exhaustion handoff go blind.
    // forge-usage-poll.js reads the unified-* headers and writes the bridge the
    // statusline (display fallback) and forge-auto (handoff) consume. Detached +
    // self-throttling (adaptive cadence); a coarse 90s mtime floor here keeps
    // rapid tool calls from spawning node needlessly. Best-effort (MEM008).
    if (phase === 'post' && sessionId && process.env.ANTHROPIC_AUTH_TOKEN) {
      try {
        const bridge = path.join(os.tmpdir(), `forge-ratelimit-${sessionId}.json`);
        let fresh = false;
        try { fresh = (Date.now() - fs.statSync(bridge).mtimeMs) < 90000; } catch {}
        if (!fresh) {
          let poller = path.join(__dirname, 'scripts', 'forge-usage-poll.js');
          if (!fs.existsSync(poller)) poller = path.join(__dirname, 'forge-usage-poll.js');
          if (fs.existsSync(poller)) {
            const child = require('child_process').spawn(
              process.execPath, [poller, '--session', sessionId],
              { detached: true, stdio: 'ignore' });
            child.unref();
          }
        }
      } catch { /* never block a tool call (MEM008) */ }
    }

    // Only track Agent tool dispatches (from here on)
    if (toolName !== 'Agent') return;

    const description  = toolInput.description  || '(sem descrição)';
    const subagentType = toolInput.subagent_type || 'general-purpose';
    const now          = Date.now();

    const liveFile = path.join(os.tmpdir(), `forge-live-${sessionId || 'unknown'}.json`);

    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(liveFile, 'utf8')); } catch {}

    let state;
    if (phase === 'pre') {
      state = {
        status       : 'dispatching',
        description,
        subagent_type: subagentType,
        started_at   : now,
        completed_at : null,
        duration_ms  : null,
        count        : existing.count || 0,
      };
    } else {
      const startedAt = existing.started_at || now;
      state = {
        status       : 'done',
        description,
        subagent_type: subagentType,
        started_at   : startedAt,
        completed_at : now,
        duration_ms  : now - startedAt,
        count        : (existing.count || 0) + 1,
      };
    }

    fs.writeFileSync(liveFile, JSON.stringify(state), 'utf8');
  } catch {
    // Never crash — hooks must exit cleanly
  }
});
