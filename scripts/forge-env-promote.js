#!/usr/bin/env node
'use strict';

// forge-env-promote.js — deterministic, orchestrator-side partial→done gate (M016 S01).
// The allowlist is deliberately imported from forge-xllm.js: do not copy it into docs/mirrors.
//
// M018 S06/T02 — WHICH reasons are corroborated runtime-first is likewise not
// written here: it is DERIVED from `promotableReasons()` in forge-env-coverage.js
// (verdict === 'promotable'). That indirection is what keeps the coverage table
// from becoming decoration — flipping a verdict there changes behaviour here, and
// a reason deleted there stops being runtime-gated here. Re-typing the list
// `['out-of-scope-test-failure','network-required']` anywhere would silently fork
// the two, which is exactly the failure mode the table was built to prevent.

const fs = require('fs');
const path = require('path');
const { MH_SCOPE_ENUM, ENV_REASON_ENUM } = require('./forge-xllm.js');

const SANDBOX_DENIAL_RE = /\bEPERM\b|\bEACCES\b|\bEROFS\b|permission denied|operation not permitted|read-only file system|not permitted by the sandbox/i;
const RUNNER_NAMES = 'npm|npx|pnpm|yarn|bun|node|jest|vitest|mocha|playwright|pytest|python3?|tox|go|cargo|make|gradle|mvn|dotnet|bundle|rspec|rake|php|composer|cmake|ctest|tsc|eslint|ruff';
const ATTEMPTED_COMMAND_RE = new RegExp(`(?:^|[\\s\`'"(\\\\/])(?:${RUNNER_NAMES})\\b|\`[^\`\\n]{3,}\``);
const RUNNER_TOKEN_RE = new RegExp(`\\b(?:${RUNNER_NAMES})\\b`, 'gi');
// `switch -c` is the modern alias of `checkout -b`: without it a legitimate git
// write reads as a non-write and the claim is rejected by mistake. Additive and
// fail-closed — no previously-recognised operation leaves this alternation.
const GIT_WRITE_RE = /\bgit[ \t]+(?:commit|push|tag|merge|rebase|cherry-pick|revert|stash|add|am|apply|checkout[ \t]+-b|switch[ \t]+-[cC])\b/i;

// Commands whose failure can substantiate a `network-required` claim. Matched
// against the observed `cmd` string only — the runtime entry carries no stderr
// (see buildRuntimeEvidence in forge-evidence-admit.js), so `cmd` + `exit_code`
// is the entire vocabulary available to a runtime-first corroborator.
const NETWORK_CMD_RE = /(?:\b(?:npm|pnpm|yarn|bun)\b[^\n]*\b(?:install|add|ci)\b)|\bcurl\b|\bwget\b|\bpip3?\b[^\n]*\binstall\b|\bgit\b[^\n]*\b(?:clone|fetch|pull)\b|\bcargo\b[^\n]*\bfetch\b|\bgo\b[^\n]*\bmod\b[^\n]*\bdownload\b|\bapt-get\b|\bbrew\b|\bdocker\b[^\n]*\bpull\b/i;

// S06 review R5. The runtime half of `out-of-scope-test-failure` may only ever
// REJECT (see DP3 at the case itself) — but it was rejecting almost nothing:
// ANY failed command carrying ANY token from RUNNER_NAMES corroborated, so a red
// `npm run lint` or a failed `tsc` stood in for a claim about a specific test
// file. RUNNER_NAMES is the vocabulary of "something was invoked"; it is not the
// vocabulary of "a test was run". This narrower alternation is the latter, and
// it is deliberately a SUBSET — anything it does not recognise is not silently
// promoted to a test invocation.
const TEST_INVOCATION_RE = new RegExp(
  [
    // Dedicated test runners: the binary name alone is the invocation.
    '(?:^|[\\s`\'"(\\\\/])(?:jest|vitest|mocha|playwright|pytest|rspec|ctest|tox)\\b',
    // Toolchains where `test` is the subcommand.
    '\\b(?:go|cargo|dotnet|swift|bundle)[ \\t]+(?:exec[ \\t]+\\S+[ \\t]+)?test\\b',
    // Script/target runners: the target name must itself mention test
    // (`npm test`, `npm run test:unit`, `make test-all`, `mvn verify` does not).
    '\\b(?:npm|npx|pnpm|yarn|bun|make|rake|gradle|mvn)[ \\t]+(?:run[ \\t]+)?[A-Za-z0-9:._-]*test[A-Za-z0-9:._-]*\\b',
    // `node --test`, `node scripts/run-tests.js`.
    '\\bnode\\b[^\\n]*(?:--test\\b|\\btests?\\b)',
  ].join('|'),
  'i',
);

// Shell operators that separate one command from the next. `&&`/`||` before the
// single-char `|` so the two-character forms are never split as a pipe.
const SEGMENT_OPERATORS = ['&&', '||', ';', '|', '\n'];

// Three-valued attribution verdict for a compound command (S06 review R6).
const NETWORK_ATTRIBUTION = Object.freeze({
  ATTRIBUTED: 'attributed',
  AMBIGUOUS: 'ambiguous',
  NONE: 'none',
});

// A sixth NAMED fallback, and — like COVERAGE_UNAVAILABLE — deliberately NOT a
// member of RUNTIME_STATES: the stream collected fine, it is this one observed
// command whose failure cannot be pinned to a segment. Collapsing it into a
// stream state would report "the sidecar collected nothing" about a turn that
// collected everything.
const ATTRIBUTION_AMBIGUOUS = 'network-attribution-ambiguous';

/**
 * Split a shell command string into the segments a `&&`/`||`/`;`/`|` chain
 * executes. Quote-aware (single, double, backslash escape) so an operator
 * inside `curl 'a&&b'` is not a boundary.
 *
 * This is NOT a shell parser and does not pretend to be one: subshells,
 * here-docs and command substitution are left inside whatever segment they
 * start in. That is safe for the only consumer below, which asks "could a
 * non-network command have been the failure?" — an unsplit exotic construct
 * makes the answer MORE conservative (one big mixed segment), never less.
 *
 * @param {string} cmd
 * @returns {string[]} non-empty, trimmed segments in execution order
 */
function splitCommandSegments(cmd) {
  const text = typeof cmd === 'string' ? cmd : '';
  const segments = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\' && quote === '"' && i + 1 < text.length) { current += text[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) { current += ch + text[++i]; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    const op = SEGMENT_OPERATORS.find(o => text.startsWith(o, i));
    if (op) { segments.push(current); i += op.length - 1; current = ''; continue; }
    current += ch;
  }
  segments.push(current);
  return segments.map(s => s.trim()).filter(Boolean);
}

/**
 * Decide whether an OBSERVED FAILURE of a compound command can be attributed to
 * a network operation.
 *
 * The defect (S06 review R6): `exit_code` describes the compound as a whole
 * while NETWORK_CMD_RE was tested against the whole `cmd` string, so
 * `curl x && npm test` exiting 1 promoted a `network-required` claim even though
 * `npm test` is what failed — measured, and the textual corroborator would have
 * rejected that same claim.
 *
 * Requiring the network command to BE the entire string was rejected as the fix:
 * it destroys `cd dir && npm install`, the dominant legitimate shape. So the
 * answer is three-valued and the third value is honest about not knowing:
 *
 *   ATTRIBUTED — every segment that could have been the failure point is a
 *                network command (in particular: the single-segment case). It
 *                does not matter which one failed; whichever it was, it was
 *                network.
 *   NONE       — no segment is a network command. Nothing to attribute.
 *   AMBIGUOUS  — the chain mixes network and non-network segments. `&&` stops at
 *                the FIRST failure, so any segment is a candidate and the exit
 *                code does not say which. The caller must not decide from this.
 *
 * @param {string} cmd
 * @returns {{verdict:string, segments:string[], network:string[]}}
 */
function attributeNetworkFailure(cmd) {
  const segments = splitCommandSegments(cmd);
  const network = segments.filter(segment => NETWORK_CMD_RE.test(segment));
  let verdict = NETWORK_ATTRIBUTION.AMBIGUOUS;
  if (network.length === 0) verdict = NETWORK_ATTRIBUTION.NONE;
  else if (network.length === segments.length) verdict = NETWORK_ATTRIBUTION.ATTRIBUTED;
  return { verdict, segments, network };
}

// Runtime-evidence states. `collected` is the only one in which the runtime is
// allowed to decide alone; every other state routes to the textual corroborator
// and MUST be named in the returned `fallbacks[]` — a silent textual accept is
// the origin defect this slice exists to close.
const RUNTIME_STATES = Object.freeze({
  NOT_COLLECTED: 'not-collected',
  MALFORMED: 'malformed',
  COLLECTOR_FAILED: 'collector-failed',
  NO_COMMAND_ENTRIES: 'no-command-entries',
  COLLECTED: 'collected',
});

// S06 review R4. A fifth NAMED fallback, for the one degradation that is not a
// state of the runtime stream at all: the coverage table itself failed to load,
// so WHICH reasons are runtime-first is unknown. It used to be a bare
// `catch { promotable = []; }` — which silently disabled the entire
// runtime-first gate, turning an explicit runtime REJECTION into `promote:true`
// with no `fallbacks[]` entry whatsoever (proved with a `Module._load` hook).
// Deliberate-and-unnamed is still unnamed, and naming the fallback is exactly
// what this slice exists to install. Kept OUT of RUNTIME_STATES on purpose: it
// is not a verdict about the stream, and collapsing it into `not-collected`
// would report a broken require as "the sidecar collected nothing".
const COVERAGE_UNAVAILABLE = 'coverage-unavailable';

/**
 * Extract the distinct runner tool names (npm, pytest, make, ...) mentioned in
 * a text blob. Shared with forge-reverify.js's ambiguous-multi-command gate so
 * both places recognize the same runner vocabulary from a single source.
 * @param {string} text
 * @returns {string[]} lowercased, deduplicated runner names
 */
function extractRunnerTokens(text) {
  const value = typeof text === 'string' ? text : '';
  const matches = value.match(RUNNER_TOKEN_RE) || [];
  return [...new Set(matches.map(token => token.toLowerCase()))];
}

function textOf(entry) {
  return `${entry && entry.item || ''}\n${entry && entry.note || ''}`;
}

function normalizedPath(value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function citedTestPaths(value) {
  // Accept ordinary source/test paths, but demand a test-ish component or suffix.
  const candidates = value.match(/(?:[A-Za-z0-9_.@-]+\/)*[A-Za-z0-9_.@-]+/g) || [];
  return candidates.filter(candidate => /(?:\.test\.|\.spec\.|(?:^|\/)tests?(?:\/|$))/i.test(candidate));
}

/**
 * Could this command's run have included the cited test path? (S06 review R5,
 * condition 2.)
 *
 * A command that names NO test path is an unscoped suite run: the cited test may
 * well be inside it, so the runtime cannot refute the claim and answers `true`.
 * A command that names test paths refutes the claim unless one of them is a
 * cited path — that is the case the old code accepted by mistake.
 *
 * @param {string} cmd
 * @param {string[]} citedPaths
 * @returns {boolean}
 */
function commandCouldRunCitedTest(cmd, citedPaths) {
  // citedTestPaths accepts a bare `test` (its `(^|/)tests?($|/)` component),
  // which is right for prose but wrong here: the `test` in `npm test` is a
  // SUBCOMMAND, not a path, and reading it as one made every unscoped suite run
  // look like a targeted run of some other file — rejecting the very claims the
  // runtime is supposed to be unable to refute. Measured while writing the
  // R5 tests. So a target only counts when it has the shape of a path.
  const looksLikePath = value => value.includes('/') || /\.(?:test|spec)\./i.test(value);
  const targeted = citedTestPaths(typeof cmd === 'string' ? cmd : '').filter(looksLikePath);
  if (targeted.length === 0) return true;
  const cited = new Set((Array.isArray(citedPaths) ? citedPaths : []).map(normalizedPath));
  return targeted.some(target => cited.has(normalizedPath(target)));
}

/**
 * Read the additive `runtime_evidence` field of a result-file into a three-state
 * verdict. Never throws: this is a report-only path, and aborting the whole
 * promotion check from an evidence READER would be the defect, not the guard —
 * any unreadable shape degrades to `malformed`, which routes to the named
 * textual fallback.
 *
 * Presence is decided by hasOwnProperty, not truthiness: `runtime_evidence: null`
 * is a DISTINCT state from an absent field (locked precedent —
 * forge-evidence-materialize.js:212,233).
 *
 * @param {object} result parsed result-file
 * @returns {{state:string, commands:Array}}
 */
function runtimeCommands(result) {
  const none = (state) => ({ state, commands: [] });
  try {
    if (!result || typeof result !== 'object') return none(RUNTIME_STATES.NOT_COLLECTED);
    if (!Object.prototype.hasOwnProperty.call(result, 'runtime_evidence')) {
      return none(RUNTIME_STATES.NOT_COLLECTED);
    }
    const evidence = result.runtime_evidence;
    if (!evidence || typeof evidence !== 'object') return none(RUNTIME_STATES.MALFORMED);
    const census = evidence.census;
    if (!census || typeof census !== 'object' || !Array.isArray(evidence.entries)) {
      return none(RUNTIME_STATES.MALFORMED);
    }
    if (census.outcome === 'collector-failed') return none(RUNTIME_STATES.COLLECTOR_FAILED);
    if (census.outcome !== 'collected') return none(RUNTIME_STATES.MALFORMED);
    const commands = evidence.entries.filter(e => e && e.kind === 'command');
    // A4 class (c), measured 2026-08-05: a turn can collect cleanly and still
    // carry zero command entries. Refusing in bulk here would break every unit
    // whose negation exists only as prose — the class this milestone itself
    // declares `measured-gap`. So it falls back to text, and SAYS SO.
    if (commands.length === 0) return none(RUNTIME_STATES.NO_COMMAND_ENTRIES);
    return { state: RUNTIME_STATES.COLLECTED, commands };
  } catch {
    return none(RUNTIME_STATES.MALFORMED);
  }
}

// A4 class (b), measured 2026-08-05: `exit_code: null` is an OBSERVED value
// ("the runtime reported no exit code"), never an absence to default. A bare
// `exit_code !== 0` admits null and manufactures a failure nothing measured.
function isObservedFailure(command) {
  return command && typeof command.exit_code === 'number' && command.exit_code !== 0;
}

const NO_RUNTIME = Object.freeze({ state: RUNTIME_STATES.NOT_COLLECTED, commands: [] });

/**
 * Load the runtime-first reason set from the coverage table. Late require
 * (sanctioned idiom, forge-xllm.js:1951) — but a load failure is REPORTED, never
 * swallowed: `{promotable: [], failed: true, error}` is what the callers turn
 * into a named `coverage-unavailable` fallback plus a fail-closed refusal while
 * a runtime stream exists (S06 review R4).
 * @returns {{promotable:string[], failed:boolean, error:(string|null)}}
 */
function loadCoverage() {
  try {
    const { promotableReasons } = require('./forge-env-coverage.js');
    const promotable = promotableReasons();
    if (!Array.isArray(promotable)) {
      return { promotable: [], failed: true, error: 'promotableReasons() did not return an array' };
    }
    return { promotable, failed: false, error: null };
  } catch (error) {
    return { promotable: [], failed: true, error: error && error.message ? error.message : String(error) };
  }
}

/**
 * @param {object} entry must_haves_status entry
 * @param {string} planText full task-plan text
 * @param {{state:string, commands:Array}} [runtime] runtime-evidence verdict
 * @param {Array} [sink] accumulator receiving `{item, reason, fallback}` whenever a
 *   runtime-first reason is decided textually. Separate channel on purpose: the
 *   return convention (null = corroborates / string = refusal reason) is load-
 *   bearing for existing callers and does not change.
 * @param {{promotable:string[], failed:boolean}} [coverage] loaded ONCE per invocation
 * @returns {string|null}
 */
function corroborates(entry, planText, runtime = NO_RUNTIME, sink = null, coverage = loadCoverage()) {
  const evidence = textOf(entry);
  const rt = runtime && typeof runtime === 'object' ? runtime : NO_RUNTIME;
  // Derived, never re-typed — see the file header.
  const cov = coverage && typeof coverage === 'object' ? coverage : { promotable: [], failed: true, error: 'no coverage' };
  const promotable = Array.isArray(cov.promotable) ? cov.promotable : [];
  if (cov.failed) {
    // S06 review R4, half 1 of 2: NAME the degradation. Never a silent gate.
    if (Array.isArray(sink)) {
      sink.push({
        item: typeof entry.item === 'string' ? entry.item : '',
        reason: entry.reason,
        fallback: COVERAGE_UNAVAILABLE,
      });
    }
    // Half 2 of 2, fail-CLOSED where it matters: a runtime stream WAS collected
    // and could have decided, but the set of runtime-first reasons is unknown —
    // so a textual accept here is exactly the flip the review measured. Refuse
    // instead. With no stream collected there is nothing to fail closed against,
    // so the pre-T02 textual path continues, now named in `fallbacks[]`.
    if (rt.state === RUNTIME_STATES.COLLECTED) {
      return `coverage table unavailable (${cov.error || 'unknown error'}) — refusing to decide textually while a runtime stream exists`;
    }
  }
  const runtimeFirst = promotable.includes(entry.reason);
  if (runtimeFirst && rt.state !== RUNTIME_STATES.COLLECTED && Array.isArray(sink)) {
    sink.push({
      item: typeof entry.item === 'string' ? entry.item : '',
      reason: entry.reason,
      fallback: rt.state,
    });
  }
  const runtimeDecides = runtimeFirst && rt.state === RUNTIME_STATES.COLLECTED;

  switch (entry.reason) {
    case 'gsd-write-refused':
      return /\.gsd\//.test(evidence)
        ? null
        : 'gsd-write-refused requires literal .gsd/ path evidence';
    // DP3: this claim makes TWO assertions and only one is promotable. The
    // runtime proves (i) "a test failed" — a command naming a runner with an
    // observed non-zero exit code. It can never prove (ii) "that test is OUTSIDE
    // the plan's scope", because no event stream knows what the plan asked for;
    // (ii) stays textual and stays mandatory. Promoting (i) alone would turn
    // "any red suite" into a universal excuse.
    case 'out-of-scope-test-failure': {
      // Computed BEFORE the runtime block (it needs the cited paths) but applied
      // after it, so the pre-existing message precedence is unchanged.
      const testPaths = citedTestPaths(evidence);
      if (runtimeDecides) {
        // S06 review R5, two conditions instead of one. (1) the failed command
        // must be a TEST invocation, not merely a command naming some runner —
        // a red `npm run lint` no longer stands in for a claim about a test
        // file. (2) it must not be a run of a DIFFERENT, specific test target:
        // a failed `vitest scripts/other.test.js` proves nothing about
        // `scripts/foo.test.js`. A command naming no test path at all (`npm
        // test`, bare `pytest`) stays acceptable — the cited test is inside the
        // suite it ran, so the runtime cannot refute the claim, and refuting it
        // anyway would be the mirror-image false negative.
        //
        // Both conditions only ever REJECT; the mandatory textual gate below
        // (cited path + absent from planText) is untouched, so half (ii) —
        // "outside the plan's scope", which no event stream can witness — keeps
        // exactly the force it had.
        const failed = rt.commands.filter(
          c => isObservedFailure(c) && TEST_INVOCATION_RE.test(typeof c.cmd === 'string' ? c.cmd : ''),
        );
        const related = failed.filter(
          c => commandCouldRunCitedTest(typeof c.cmd === 'string' ? c.cmd : '', testPaths),
        );
        if (related.length === 0) {
          const tail = failed.length === 0
            ? 'none is a failed test invocation'
            : `${failed.length} failed test invocation(s), none of which could have run the cited test path`;
          return `out-of-scope-test-failure rejected by observed runtime evidence: ${rt.commands.length} command(s) seen, ${tail}`;
        }
      }
      if (!testPaths.length) return 'out-of-scope-test-failure requires a cited test path';
      const inPlan = testPaths.some(testPath => planText.includes(normalizedPath(testPath)));
      return inPlan ? 'cited test path appears in planText' : null;
    }
    // TASK-020: this means proving the item requires committing, not that a
    // test happens to use git fixtures. `item` is self-reported boilerplate,
    // so only the execution-report `note` is evidence.
    case 'git-commit-required': {
      const note = typeof entry.note === 'string' ? entry.note : '';
      return GIT_WRITE_RE.test(note)
        ? null
        : 'git-commit-required requires a git write operation (commit/push/tag/merge) in the note; a note that merely mentions git is not evidence';
    }
    case 'network-required': {
      let ambiguous = 0;
      if (runtimeDecides) {
        // Fail-closed while a stream exists: the verdict comes from the observed
        // exit code alone, never from the regex below — but only where that exit
        // code can be ATTRIBUTED to a segment (S06 review R6).
        const failed = rt.commands.filter(isObservedFailure);
        const verdicts = failed.map(c => attributeNetworkFailure(typeof c.cmd === 'string' ? c.cmd : '').verdict);
        if (verdicts.includes(NETWORK_ATTRIBUTION.ATTRIBUTED)) return null;
        ambiguous = verdicts.filter(v => v === NETWORK_ATTRIBUTION.AMBIGUOUS).length;
        if (ambiguous === 0) {
          return `network-required rejected by observed runtime evidence: ${rt.commands.length} command(s) seen, none is a failed network command`;
        }
        // Uncertainty is made VISIBLE and then handed to the textual gate — the
        // one thing it must not do is what it used to: promote in silence. The
        // measured false accept (`curl x && npm test`, exit 1, note reporting a
        // test failure) now reaches the textual corroborator, which rejects it;
        // `cd dir && npm install` reaches it too and passes, exactly as it did
        // before any runtime evidence existed.
        if (Array.isArray(sink)) {
          sink.push({
            item: typeof entry.item === 'string' ? entry.item : '',
            reason: entry.reason,
            fallback: ATTRIBUTION_AMBIGUOUS,
            ambiguous_commands: ambiguous,
          });
        }
      }
      return /network|install|fetch|clone|download|registry/i.test(evidence)
        ? null
        : 'network-required requires network operation evidence';
    }
    case 'sandbox-exec-blocked': {
      // `item` is worker-echoed plan boilerplate — it can freely contain runner
      // names and OS-denial vocabulary for tasks *about* sandboxing, which would
      // trivially satisfy both signals with an empty `note` (a wash). Only the
      // `note` is an execution report, so corroborate against it in isolation.
      const note = typeof entry.note === 'string' ? entry.note : '';
      return SANDBOX_DENIAL_RE.test(note) && ATTEMPTED_COMMAND_RE.test(note)
        ? null
        : 'sandbox-exec-blocked requires the attempted command and an OS denial signal (EPERM/EACCES/permission denied) in the note';
    }
    default:
      return 'reason is not in the environment allowlist';
  }
}

/**
 * Corroborate every environment-scoped, unmet entry in must_haves_status
 * against the same criteria used for partial→done promotion. Pure helper
 * shared by checkEnvPromotion (status:partial) and the done-with-env-unmet
 * path (status:done) so the acceptance logic is defined exactly once.
 *
 * @param {Array} mustHavesStatus
 * @param {string} safePlanText
 * @param {{state:string, commands:Array}} [runtime] computed ONCE per invocation
 * @returns {{env_constraints:Array, rejected:Array, fallbacks:Array}}
 */
function corroborateEnvEntries(mustHavesStatus, safePlanText, runtime = NO_RUNTIME) {
  const env_constraints = [];
  const rejected = [];
  const fallbacks = [];
  // Loaded ONCE per invocation, like `runtime` — and its failure is a value, not
  // a swallowed exception (S06 review R4).
  const coverage = loadCoverage();

  for (const entry of mustHavesStatus) {
    if (!entry || entry.status === 'met') continue;
    const item = typeof entry.item === 'string' ? entry.item : '';
    if (entry.scope !== 'environment') {
      rejected.push({ item, why: 'scope must be environment' });
      continue;
    }
    if (!MH_SCOPE_ENUM.includes(entry.scope) || !ENV_REASON_ENUM.includes(entry.reason)) {
      rejected.push({ item, why: 'reason is not in the environment allowlist' });
      continue;
    }
    const why = corroborates(entry, safePlanText, runtime, fallbacks, coverage);
    if (why) {
      rejected.push({ item, why });
      continue;
    }
    env_constraints.push({ item, reason: entry.reason, note: typeof entry.note === 'string' ? entry.note : '' });
  }

  return { env_constraints, rejected, fallbacks };
}

/**
 * Check whether a partial worker result is exclusively blocked by corroborated
 * environment constraints. This function is pure and intentionally never
 * mutates the worker payload.
 *
 * M016 S01 review R1: a worker returning status:done with unmet must_haves that
 * are ALL labelled scope:environment is a second acceptance path — the same
 * corroboration criteria apply, but the verdict is distinct (`done-with-unverified-env`)
 * so callers never treat it as a silent, unconditional accept. Any rejected
 * entry means the orchestrator MUST treat the result as partial (normal failure
 * flow), never accept the done label at face value.
 *
 * @param {object} result parsed worker result
 * @param {string} planText full task-plan text
 * @returns {{promote:boolean, env_constraints:Array, rejected:Array, reason?:string, verdict?:string}}
 */
// DP7, additive in the strict sense: `fallbacks` is attached ONLY when there is a
// fallback to name, so every pre-T02 return value stays byte-identical (the
// whole-object equality guard at forge-smoke.js:8933 keeps its full bite instead
// of being loosened by the very change it exists to catch). The key's PRESENCE
// is therefore itself the signal. Consumers must read it as
// `Array.isArray(r.fallbacks) ? r.fallbacks : []` — absent means "nothing fell
// back", never "the field was dropped".
function attachFallbacks(value, fallbacks) {
  return fallbacks && fallbacks.length ? { ...value, fallbacks } : value;
}

function checkEnvPromotion(result, planText) {
  const safePlanText = typeof planText === 'string' ? planText : '';
  // Computed once per invocation, not per entry.
  const runtime = runtimeCommands(result);

  if (result && result.status === 'done' && Array.isArray(result.must_haves_status)) {
    const unmet = result.must_haves_status.filter(entry => entry && entry.status !== 'met');
    if (unmet.length === 0) {
      return { promote: false, env_constraints: [], rejected: [], reason: 'not-applicable' };
    }
    const { env_constraints, rejected, fallbacks } = corroborateEnvEntries(unmet, safePlanText, runtime);
    return attachFallbacks({
      promote: false,
      env_constraints,
      rejected,
      verdict: rejected.length > 0 ? 'done-with-unverified-env' : 'done-with-verified-env',
    }, fallbacks);
  }

  if (!result || result.status !== 'partial' || !Array.isArray(result.must_haves_status)) {
    return { promote: false, env_constraints: [], rejected: [], reason: 'not-applicable' };
  }

  const { env_constraints, rejected, fallbacks } = corroborateEnvEntries(
    result.must_haves_status, safePlanText, runtime,
  );

  return attachFallbacks({
    promote: env_constraints.length > 0 && rejected.length === 0,
    env_constraints,
    rejected,
  }, fallbacks);
}

function usage() {
  return 'Usage: node scripts/forge-env-promote.js --result <file> --plan <file> [--json]\n';
}

function runCli(args) {
  let resultPath = null;
  let planPath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--result' && args[i + 1]) resultPath = args[++i];
    else if (args[i] === '--plan' && args[i + 1]) planPath = args[++i];
    else if (args[i] === '--json') { /* accepted for mirror consistency */ }
    else if (args[i] === '--help') {
      process.stdout.write(usage());
      return 0;
    }
  }
  if (!resultPath || !planPath) {
    process.stderr.write(usage());
    return 2;
  }
  try {
    const result = JSON.parse(fs.readFileSync(path.resolve(resultPath), 'utf8'));
    const planText = fs.readFileSync(path.resolve(planPath), 'utf8');
    process.stdout.write(`${JSON.stringify(checkEnvPromotion(result, planText))}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));

module.exports = {
  checkEnvPromotion,
  corroborates,
  corroborateEnvEntries,
  extractRunnerTokens,
  runtimeCommands,
  loadCoverage,
  splitCommandSegments,
  attributeNetworkFailure,
  commandCouldRunCitedTest,
  RUNTIME_STATES,
  COVERAGE_UNAVAILABLE,
  NETWORK_ATTRIBUTION,
  ATTRIBUTION_AMBIGUOUS,
  TEST_INVOCATION_RE,
};
