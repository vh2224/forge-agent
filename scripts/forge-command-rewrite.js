#!/usr/bin/env node
'use strict';

/**
 * forge-command-rewrite.js
 *
 * D6 (CONTEXT, milestone M-20260813221024-controle-recursos): the operator kept
 * chain rewriting (`a && b`) AGAINST a stated reservation, and the condition
 * attached to that decision is part of it, not an addendum — a REAL tokenizer
 * (never a regex over the whole command string) with an explicit per-construct
 * refusal path. Any form whose equivalence cannot be proven passes through
 * byte-identical, tagged with a named, enumerated, counted reason. This module
 * would rather refuse too much than rewrite too little — the same posture
 * `forge-reverify.js#resolveVerifyCommand` already takes (falls back to
 * no-command on any shell metacharacter; the spawn there is `shell:false`).
 *
 * D10 (sizing-free): this module NEVER decides worker counts, heap sizes, or
 * Playwright caps. It receives a `budget` object (the exact shape produced by
 * `forge-resources.js#resolveResourceBudget`: `workers`, `heapMb`,
 * `playwrightWorkers`) and only maps those numbers onto runner-specific
 * presentation (env vars or argv flags). All sizing formulas live in
 * `forge-resources.js` — nothing here re-derives a worker count.
 *
 * Two SEPARATE frozen enums (kept apart deliberately — different vocabulary):
 *  - TOKENIZE_REFUSAL_REASONS: construct-level reasons the character-walking
 *    tokenizer itself refuses on ($( ), backtick, single |, < >, background &,
 *    ( ) subshell, backslash escape outside quotes, newline, unterminated
 *    quote). These are a property of the STRING, not of the rewrite decision.
 *  - REWRITE_REASON_CODES: outcome-level reasons `planRewrite` returns —
 *    either why it rewrote something (`rewritten:*`) or why it left a runner
 *    candidate intact (`intact:*`), including a member that WRAPS a tokenizer
 *    refusal (`intact:tokenize-refused`) without merging the two vocabularies.
 * Both follow the same `Object.freeze` idiom as `REASON_CODES` in
 * `scripts/forge-resources.js` and `POOL_REASON_CODES` in
 * `scripts/forge-resource-pool.js`.
 *
 * Insertion-only rewriting: `planRewrite` NEVER re-serializes the original
 * string. It records `{at, text}` insertion points (offsets into the
 * ORIGINAL command string) and the final `command` is built by splicing those
 * texts in — untouched bytes, including quoting, are copied verbatim. This is
 * mechanically verifiable: removing the inserted spans from the output always
 * yields the byte-identical original (see the property test in
 * `forge-command-rewrite.test.js`).
 *
 * `looksLikeRunnerCommand` is a pure lexical gate: zero I/O, zero `require`
 * of `forge-isolation.js` (or any pool/resolver module) on its call path.
 * That lazy require happens ONLY inside `rewriteManagerSegment`, on the full
 * rewrite path, for npm/pnpm/yarn indirection — never on the gate. The gate
 * must never return `false` for anything `planRewrite` can actually rewrite:
 * it shares the exact same `classifySegment` predicate that `planRewrite`
 * uses to decide a segment is a runner candidate, so the two can never
 * diverge into a false negative.
 */

const fs = require('fs');
const path = require('path');

// ── Frozen enum: tokenizer construct-level refusal reasons ─────────────────
const TOKENIZE_REFUSAL_REASONS = Object.freeze({
  COMMAND_SUBSTITUTION: 'tokenize-refused:command-substitution',
  BACKTICK: 'tokenize-refused:backtick',
  SINGLE_PIPE: 'tokenize-refused:single-pipe',
  REDIRECTION: 'tokenize-refused:redirection',
  BACKGROUND: 'tokenize-refused:background',
  SUBSHELL: 'tokenize-refused:subshell',
  BACKSLASH_ESCAPE: 'tokenize-refused:backslash-escape',
  NEWLINE: 'tokenize-refused:newline',
  UNTERMINATED_QUOTE: 'tokenize-refused:unterminated-quote',
  EMPTY_OR_INVALID: 'tokenize-refused:empty-or-invalid',
  EMPTY_SEGMENT: 'tokenize-refused:empty-segment',
  VARIABLE_EXPANSION: 'tokenize-refused:variable-expansion',
});

// ── Frozen enum: planRewrite outcome reasons (rewritten:* / intact:*) ──────
const REWRITE_REASON_CODES = Object.freeze({
  REWRITTEN_VITEST_ENV: 'rewritten:vitest-env',
  REWRITTEN_JEST_ARGV: 'rewritten:jest-argv',
  REWRITTEN_PLAYWRIGHT_ARGV: 'rewritten:playwright-argv',
  INTACT_TOKENIZE_REFUSED: 'intact:tokenize-refused',
  INTACT_NOT_RUNNER: 'intact:not-runner-command',
  INTACT_UNKNOWN_MANAGER: 'intact:unknown-manager',
  INTACT_VITEST_SHARD: 'intact:vitest-shard',
  INTACT_EXPLICIT_CONCURRENCY: 'intact:explicit-concurrency',
  INTACT_SCRIPT_UNRESOLVABLE: 'intact:script-unresolvable',
  INTACT_UNRECOGNIZED_RUNNER_FORM: 'intact:unrecognized-runner-form',
  // planRewriteArgv-only reasons (T01/S04) — the argv adapter never
  // reimplements tokenization/sizing; these name every point where it
  // refuses rather than guess at an unprovable argv<->string equivalence.
  INTACT_ARGV_EMPTY: 'intact:argv-empty',
  INTACT_ARGV_UNSAFE_TOKEN: 'intact:argv-unsafe-token',
  INTACT_ARGV_MULTI_SEGMENT: 'intact:argv-multi-segment',
  INTACT_ARGV_RETOKENIZE_FAILED: 'intact:argv-retokenize-failed',
  INTACT_ARGV_ROUNDTRIP_UNPROVEN: 'intact:argv-roundtrip-unproven',
  INTACT_ARGV_EMPTY_AFTER_ENV_STRIP: 'intact:argv-empty-after-env-strip',
});

// ── Character-walking tokenizer ─────────────────────────────────────────────
// Walks the command string ONE character at a time. Never applies a regex to
// the whole string to make a rewrite/refusal decision — every refusal fires
// at the exact character offset of the construct it names. Words absorb
// contiguous quote spans (e.g. `--foo="bar baz"qux` is ONE word token);
// `&&` / `||` / `;` (unquoted, outside a word) are chain-segment separators.
function tokenizeCommand(cmd) {
  if (typeof cmd !== 'string' || cmd.length === 0) {
    return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.EMPTY_OR_INVALID, at: 0 };
  }
  const len = cmd.length;
  const tokens = [];
  let i = 0;
  let wordStart = -1;
  let wordBuf = '';

  function flushWord(end) {
    if (wordStart !== -1) {
      tokens.push({ type: 'word', raw: wordBuf, start: wordStart, end });
      wordStart = -1;
      wordBuf = '';
    }
  }

  while (i < len) {
    const c = cmd[i];

    if (c === '\n') return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.NEWLINE, at: i };

    if (c === ' ' || c === '\t' || c === '\r') { flushWord(i); i += 1; continue; }

    if (c === "'") {
      if (wordStart === -1) wordStart = i;
      const close = cmd.indexOf("'", i + 1);
      if (close === -1) return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.UNTERMINATED_QUOTE, at: i };
      wordBuf += cmd.slice(i, close + 1);
      i = close + 1;
      continue;
    }

    if (c === '"') {
      if (wordStart === -1) wordStart = i;
      let j = i + 1;
      let closed = false;
      while (j < len) {
        const cj = cmd[j];
        if (cj === '"') { closed = true; break; }
        if (cj === '\n') return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.NEWLINE, at: j };
        if (cj === '$') return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.COMMAND_SUBSTITUTION, at: j };
        if (cj === '`') return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.BACKTICK, at: j };
        if (cj === '\\') return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.BACKSLASH_ESCAPE, at: j };
        j += 1;
      }
      if (!closed) return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.UNTERMINATED_QUOTE, at: i };
      wordBuf += cmd.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (c === '`') return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.BACKTICK, at: i };
    if (c === '\\') return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.BACKSLASH_ESCAPE, at: i };

    if (c === '$') {
      if (cmd[i + 1] === '(') return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.COMMAND_SUBSTITUTION, at: i };
      // Bare $VAR outside quotes is unprovable: its expanded value is
      // invisible to hasExplicitConcurrency, so a generated concurrency flag
      // could silently override a human's explicit choice hidden inside the
      // variable (R3). Refuse rather than treat as a literal word character.
      return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.VARIABLE_EXPANSION, at: i };
    }

    if (c === '(' || c === ')') return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.SUBSHELL, at: i };
    if (c === '<' || c === '>') return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.REDIRECTION, at: i };

    if (c === '|') {
      flushWord(i);
      if (cmd[i + 1] === '|') { tokens.push({ type: 'op', raw: '||', start: i, end: i + 2 }); i += 2; continue; }
      return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.SINGLE_PIPE, at: i };
    }

    if (c === '&') {
      flushWord(i);
      if (cmd[i + 1] === '&') { tokens.push({ type: 'op', raw: '&&', start: i, end: i + 2 }); i += 2; continue; }
      return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.BACKGROUND, at: i };
    }

    if (c === ';') {
      flushWord(i);
      tokens.push({ type: 'op', raw: ';', start: i, end: i + 1 });
      i += 1;
      continue;
    }

    if (wordStart === -1) wordStart = i;
    wordBuf += c;
    i += 1;
  }
  flushWord(len);

  if (tokens.length === 0) {
    return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.EMPTY_OR_INVALID, at: len };
  }

  const segments = [];
  let current = [];
  for (const token of tokens) {
    if (token.type === 'op') { segments.push(current); current = []; }
    else current.push(token);
  }
  segments.push(current);

  if (segments.some((seg) => seg.length === 0)) {
    return { ok: false, reason: TOKENIZE_REFUSAL_REASONS.EMPTY_SEGMENT, at: len };
  }

  return { ok: true, tokens, segments };
}

// ── Lexical helpers (pure, zero I/O) ────────────────────────────────────────
function unquoteSimple(raw) {
  if (raw.length >= 2 && raw[0] === "'" && raw[raw.length - 1] === "'") return raw.slice(1, -1);
  if (raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"') return raw.slice(1, -1);
  return raw;
}

function basenameLike(word) {
  const parts = word.split(/[\\/]/);
  return parts[parts.length - 1] || word;
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const RUNNER_BIN_RE = /^(vitest|jest|playwright)(\.(cmd|exe))?$/i;

function stripEnvPrefix(tokens) {
  let idx = 0;
  while (idx < tokens.length && ENV_ASSIGNMENT_RE.test(unquoteSimple(tokens[idx].raw))) idx += 1;
  return tokens.slice(idx);
}

// Classifies ONE chain segment (already split by tokenizeCommand). Returns
// `{kind:'direct', runner, tokens, headToken}` for a direct runner
// invocation, `{kind:'manager', manager, scriptName, tokens, subToken}` for
// npm/pnpm/yarn indirection, or `{kind:'none'}` / `{kind:'unrecognized'}`
// otherwise. This is the SAME predicate `looksLikeRunnerCommand` and
// `planRewrite` both consume — the shared source of truth that prevents the
// gate from ever diverging into a false negative.
function classifySegment(segTokens) {
  const rest = stripEnvPrefix(segTokens);
  if (!rest.length) return { kind: 'none' };
  const head = unquoteSimple(rest[0].raw);
  const headBase = basenameLike(head);

  // `tokens` on every branch below is the FULL segment (env-prefix words
  // included) — insertion anchors and explicit-concurrency checks both need
  // to see any pre-existing VITEST_MAX_*/env assignment, not the stripped
  // view. `headToken`/`subToken` mark the meaningful sub-position.
  if (headBase === 'npx') {
    if (rest.length < 2) return { kind: 'unrecognized' };
    const name = basenameLike(unquoteSimple(rest[1].raw));
    if (RUNNER_BIN_RE.test(name)) {
      const runner = name.replace(/\.(cmd|exe)$/i, '').toLowerCase();
      // `npx playwright <anything>` is only a test run when the `test`
      // subcommand follows — same requirement the bare-`playwright` branch
      // below already applies (R5). `npx playwright install ...` is not a
      // test invocation and must not be mutated.
      if (runner === 'playwright') {
        if (rest.length >= 3 && unquoteSimple(rest[2].raw) === 'test') {
          return { kind: 'direct', runner, tokens: segTokens, headToken: segTokens[0], subToken: rest[2] };
        }
        return { kind: 'unrecognized' };
      }
      return { kind: 'direct', runner, tokens: segTokens, headToken: segTokens[0], subToken: rest[1] };
    }
    return { kind: 'unrecognized' };
  }

  if (headBase.toLowerCase() === 'playwright') {
    if (rest.length >= 2 && unquoteSimple(rest[1].raw) === 'test') {
      return { kind: 'direct', runner: 'playwright', tokens: segTokens, headToken: segTokens[0], subToken: rest[1] };
    }
    return { kind: 'unrecognized' };
  }

  if (RUNNER_BIN_RE.test(headBase)) {
    return { kind: 'direct', runner: headBase.replace(/\.(cmd|exe)$/i, '').toLowerCase(), tokens: segTokens, headToken: segTokens[0] };
  }

  if (['npm', 'pnpm', 'yarn'].includes(headBase)) {
    if (rest.length >= 2) {
      const sub = unquoteSimple(rest[1].raw);
      if (sub === 'test') return { kind: 'manager', manager: headBase, scriptName: 'test', tokens: segTokens, headToken: segTokens[0], subToken: rest[1] };
      if (sub === 'run' && rest.length >= 3) {
        return { kind: 'manager', manager: headBase, scriptName: unquoteSimple(rest[2].raw), tokens: segTokens, headToken: segTokens[0], subToken: rest[2] };
      }
    }
    return { kind: 'unrecognized' };
  }

  return { kind: 'none' };
}

function looksLikeRunnerCommandFromTokenized(tokenized) {
  return tokenized.segments.some((seg) => {
    const c = classifySegment(seg);
    return c.kind === 'direct' || c.kind === 'manager';
  });
}

// Pure-string lexical gate. Zero I/O, zero require of forge-isolation.js or
// any pool/resolver module — that lazy require happens only on the full
// rewrite path inside rewriteManagerSegment.
function looksLikeRunnerCommand(cmd) {
  const tokenized = tokenizeCommand(cmd);
  if (!tokenized.ok) return false;
  return looksLikeRunnerCommandFromTokenized(tokenized);
}

// ── Explicit-flag / shard detection (never override a human choice) ───────
const EXPLICIT_CONCURRENCY_RE = /^(--workers=|--maxWorkers=|maxWorkers=|VITEST_MAX_FORKS=|VITEST_MAX_THREADS=)/;
// Space-separated flag forms (`--maxWorkers 2`, `--workers 2`) are also
// explicit human choices — both jest (yargs) and playwright (commander)
// accept this form, and missing it duplicates the generated flag (R4).
const EXPLICIT_CONCURRENCY_SPACE_RE = /^(--workers|--maxWorkers)$/;
function hasExplicitConcurrency(tokens) {
  return tokens.some((t, idx) => {
    const raw = unquoteSimple(t.raw);
    if (EXPLICIT_CONCURRENCY_RE.test(raw)) return true;
    return EXPLICIT_CONCURRENCY_SPACE_RE.test(raw) && idx + 1 < tokens.length;
  });
}
function hasVitestShard(tokens) {
  return tokens.some((t) => /^--shard(=|$)/.test(unquoteSimple(t.raw)));
}

function vitestEnvPrefix(budget) {
  return `VITEST_MAX_FORKS='${budget.workers}' VITEST_MAX_THREADS='${budget.workers}' NODE_OPTIONS='--max-old-space-size=${budget.heapMb}' `;
}

// ── Direct runner segment rewrite (vitest / jest / playwright test) ───────
function rewriteDirectSegment(runner, tokens, budget) {
  if (runner === 'vitest') {
    if (hasVitestShard(tokens)) return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_VITEST_SHARD };
    if (hasExplicitConcurrency(tokens)) return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_EXPLICIT_CONCURRENCY };
    const headToken = tokens[0];
    return {
      rewritten: true,
      insertions: [{ at: headToken.start, text: vitestEnvPrefix(budget) }],
      reason: REWRITE_REASON_CODES.REWRITTEN_VITEST_ENV,
    };
  }
  if (runner === 'jest') {
    if (hasExplicitConcurrency(tokens)) return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_EXPLICIT_CONCURRENCY };
    const last = tokens[tokens.length - 1];
    return {
      rewritten: true,
      insertions: [{ at: last.end, text: ` --maxWorkers=${budget.workers}` }],
      reason: REWRITE_REASON_CODES.REWRITTEN_JEST_ARGV,
    };
  }
  if (runner === 'playwright') {
    if (hasExplicitConcurrency(tokens)) return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_EXPLICIT_CONCURRENCY };
    const last = tokens[tokens.length - 1];
    return {
      rewritten: true,
      insertions: [{ at: last.end, text: ` --workers=${budget.playwrightWorkers}` }],
      reason: REWRITE_REASON_CODES.REWRITTEN_PLAYWRIGHT_ARGV,
    };
  }
  return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_UNRECOGNIZED_RUNNER_FORM };
}

// Default injectable `readScript(cwd, name)` — reads package.json's
// scripts[name]. Callers (tests, T03/S04 reuse) may inject their own to
// avoid filesystem coupling; this default is only used when opts.readScript
// is absent.
function defaultReadScript(cwd, name) {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    if (pkg && pkg.scripts && typeof pkg.scripts[name] === 'string') return pkg.scripts[name];
    return null;
  } catch {
    return null;
  }
}

// ── Manager-indirection segment rewrite (npm/pnpm/yarn test | run <name>) ──
// Lazily requires forge-isolation.js's resolvePackageManager — the ONLY
// require of that module anywhere in this file, and it never happens on the
// looksLikeRunnerCommand gate path (T01 truth #3).
function rewriteManagerSegment(classification, budget, { cwd, readScript }) {
  const { resolvePackageManager } = require('./forge-isolation.js');
  const pmInfo = resolvePackageManager(cwd);
  if (!pmInfo) {
    return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_UNKNOWN_MANAGER };
  }

  const scriptBody = readScript(cwd, classification.scriptName);
  if (typeof scriptBody !== 'string' || !scriptBody.trim()) {
    return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_SCRIPT_UNRESOLVABLE };
  }

  // Script body is tokenized by the SAME tokenizer (T01 truth #7) — an
  // unrecognizable/unprovable script body degrades to intact, never to a
  // best-effort guess.
  const bodyTokenized = tokenizeCommand(scriptBody);
  if (!bodyTokenized.ok) {
    return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_SCRIPT_UNRESOLVABLE };
  }
  // A multi-segment script body (`"test": "jest && cleanup"`) is unprovable:
  // npm/pnpm/yarn append the forwarded flag to the END of the whole script
  // string, which can land on a LATER segment (e.g. `cleanup`), not the
  // runner segment being classified here (R2). Only a single-segment body
  // is safe to rewrite.
  if (bodyTokenized.segments.length !== 1) {
    return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_SCRIPT_UNRESOLVABLE };
  }
  const bodySeg = bodyTokenized.segments[0] || [];
  const bodyClassification = classifySegment(bodySeg);
  if (bodyClassification.kind !== 'direct') {
    return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_UNRECOGNIZED_RUNNER_FORM };
  }

  const runner = bodyClassification.runner;
  const outerTokens = classification.tokens;
  const headOuter = outerTokens[0];
  const lastOuter = outerTokens[outerTokens.length - 1];

  if (runner === 'vitest') {
    if (hasVitestShard(bodyClassification.tokens)) return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_VITEST_SHARD };
    if (hasExplicitConcurrency(bodyClassification.tokens) || hasExplicitConcurrency(outerTokens)) {
      return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_EXPLICIT_CONCURRENCY };
    }
    return {
      rewritten: true,
      runner,
      insertions: [{ at: headOuter.start, text: vitestEnvPrefix(budget) }],
      reason: REWRITE_REASON_CODES.REWRITTEN_VITEST_ENV,
    };
  }

  if (runner === 'jest' || runner === 'playwright') {
    if (hasExplicitConcurrency(bodyClassification.tokens) || hasExplicitConcurrency(outerTokens)) {
      return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_EXPLICIT_CONCURRENCY };
    }
    const flag = runner === 'jest' ? `--maxWorkers=${budget.workers}` : `--workers=${budget.playwrightWorkers}`;
    // Per-manager `--` rule (research W2, S03-PLAN Notes): npm ALWAYS needs
    // `--` to forward args; yarn NEVER needs it; pnpm only for the literal
    // `test` script (pnpm/pnpm#5522, #4821). Forwarding syntax is a property
    // of the binary that actually parses argv — the LITERAL invoked manager
    // (`classification.manager`), not the repo's detected lockfile manager
    // (`pmInfo.manager`), which can disagree (R1: `npm run e2e` in a
    // pnpm-lock repo gets no `--` if keyed on the detected manager, npm
    // swallows the flag as config, and the runner runs uncapped).
    const needsDashDash = classification.manager === 'npm' || (classification.manager === 'pnpm' && classification.scriptName === 'test');
    const text = needsDashDash ? ` -- ${flag}` : ` ${flag}`;
    const reason = runner === 'jest' ? REWRITE_REASON_CODES.REWRITTEN_JEST_ARGV : REWRITE_REASON_CODES.REWRITTEN_PLAYWRIGHT_ARGV;
    return { rewritten: true, runner, insertions: [{ at: lastOuter.end, text }], reason };
  }

  return { rewritten: false, reason: REWRITE_REASON_CODES.INTACT_UNRECOGNIZED_RUNNER_FORM };
}

/**
 * planRewrite(cmd, budget, opts) — the single entry point. `budget` is the
 * exact `resolveResourceBudget()` contract shape (`workers`, `heapMb`,
 * `playwrightWorkers`) — this module contains ZERO sizing rules (D10) and
 * never derives its own admission signal or a numeric worker default —
 * sizing is entirely the caller's concern (see forge-resources.js).
 *
 * Returns exactly one outcome from the frozen enum:
 *   { outcome:'rewritten', command, insertions:[{at,text}], runner, reason }
 *   { outcome:'intact', reason }
 *
 * `opts.cwd` / `opts.repoRoot` — repo root for manager/script resolution
 * (defaults to `process.cwd()`). `opts.readScript(cwd, name)` — injectable
 * package.json script reader (defaults to `defaultReadScript`).
 */
function planRewrite(cmd, budget, opts = {}) {
  const tokenized = tokenizeCommand(cmd);
  if (!tokenized.ok) {
    return { outcome: 'intact', reason: REWRITE_REASON_CODES.INTACT_TOKENIZE_REFUSED, detail: tokenized.reason };
  }
  if (!looksLikeRunnerCommandFromTokenized(tokenized)) {
    return { outcome: 'intact', reason: REWRITE_REASON_CODES.INTACT_NOT_RUNNER };
  }

  const cwd = opts.cwd || opts.repoRoot || process.cwd();
  const readScript = typeof opts.readScript === 'function' ? opts.readScript : defaultReadScript;

  const insertions = [];
  let anyRewritten = false;
  let primaryReason = null;
  let primaryRunner = null;
  let sawRunnerSegment = false;

  for (const seg of tokenized.segments) {
    if (!seg.length) continue;
    const classification = classifySegment(seg);
    if (classification.kind === 'direct') {
      sawRunnerSegment = true;
      const plan = rewriteDirectSegment(classification.runner, classification.tokens, budget);
      if (plan.rewritten) {
        insertions.push(...plan.insertions);
        anyRewritten = true;
        primaryReason = plan.reason;
        primaryRunner = classification.runner;
      } else if (!primaryReason) {
        primaryReason = plan.reason;
      }
      continue;
    }
    if (classification.kind === 'manager') {
      sawRunnerSegment = true;
      const plan = rewriteManagerSegment(classification, budget, { cwd, readScript });
      if (plan.rewritten) {
        insertions.push(...plan.insertions);
        anyRewritten = true;
        primaryReason = plan.reason;
        primaryRunner = plan.runner;
      } else if (!primaryReason) {
        primaryReason = plan.reason;
      }
      continue;
    }
    // 'none' / 'unrecognized' segments are not runner candidates — they are
    // left byte-intact by construction (never touched by any insertion).
  }

  if (!sawRunnerSegment) {
    return { outcome: 'intact', reason: REWRITE_REASON_CODES.INTACT_NOT_RUNNER };
  }
  if (!anyRewritten) {
    return { outcome: 'intact', reason: primaryReason || REWRITE_REASON_CODES.INTACT_UNRECOGNIZED_RUNNER_FORM };
  }

  // Insertion-only splice: copy untouched bytes verbatim between insertion
  // points, insert new text, never re-serialize anything the tokenizer saw.
  // A Windows shell cannot execute POSIX NAME=value prefixes. The caller may
  // request spawn-environment delivery; remove only our exact generated
  // insertions, never assignments or bytes authored in the original command.
  const spawnEnv = opts.envMode === 'spawn' && insertions.some(i => i.text === vitestEnvPrefix(budget));
  const env = spawnEnv ? { VITEST_MAX_FORKS: String(budget.workers), VITEST_MAX_THREADS: String(budget.workers),
    NODE_OPTIONS: `--max-old-space-size=${budget.heapMb}` } : null;
  const sortedInsertions = insertions.filter(i => !spawnEnv || i.text !== vitestEnvPrefix(budget)).sort((a, b) => a.at - b.at);
  let command = '';
  let cursor = 0;
  for (const ins of sortedInsertions) {
    command += cmd.slice(cursor, ins.at) + ins.text;
    cursor = ins.at;
  }
  command += cmd.slice(cursor);

  return {
    outcome: 'rewritten',
    command,
    insertions: sortedInsertions,
    runner: primaryRunner,
    reason: primaryReason,
    ...(env ? { env } : {}),
  };
}

// A token that would need shell quoting to survive a lossless space-join is
// unprovable by this adapter — the same posture `forge-reverify.js`'s
// `resolveVerifyCommand` already takes for its own space-split (MEM004).
// This recusa COMPOSES with that upstream one; it does not replace it —
// planRewriteArgv is called on whatever argv already survived that filter,
// and re-checks the same property independently (defense in depth, not
// duplication of authority: this module owns the tokenizer/rewrite rules,
// `resolveVerifyCommand` owns which commands are eligible to reach here).
const ARGV_UNSAFE_TOKEN_RE = /[\s'"\\$`|&;<>()]/;

/**
 * planRewriteArgv(argv, budget, opts) — argv-shaped adapter over
 * planRewrite/tokenizeCommand, for callers that spawn with `shell:false`
 * and an explicit argv array (`forge-reverify.js`) instead of a shell
 * command string. NEVER reimplements tokenization or sizing (D10): budget
 * is passed straight through to `planRewrite`. Returns exactly one outcome
 * from the frozen enum:
 *   { outcome:'rewritten', argv, env, runner, reason }
 *   { outcome:'intact', reason }
 *
 * Env-prefix assignments produced by the underlying string rewrite (e.g.
 * `VITEST_MAX_FORKS='4'`) are split into `env` (a plain name->value map,
 * quoting undone, ready to merge into a child_process `env` option) —
 * NEVER left as an argv[0]-shaped `NAME=value` element, which `shell:false`
 * would execute as the binary name rather than treat as an assignment.
 *
 * Before returning a `rewritten` outcome, the adapter proves the round
 * trip at runtime: it re-renders the exact bytes it sliced out of
 * `planRewrite`'s output (assignments `NAME=<raw-value>` in front, argv
 * tokens after, joined by one space) and compares that reconstruction,
 * byte-for-byte, against the string `planRewrite` actually produced. Any
 * mismatch refuses (`intact:argv-roundtrip-unproven`) rather than return an
 * argv/env split that was never verified equivalent to what was rewritten.
 */
function planRewriteArgv(argv, budget, opts = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((t) => typeof t === 'string')) {
    return { outcome: 'intact', reason: REWRITE_REASON_CODES.INTACT_ARGV_EMPTY };
  }
  if (argv.some((t) => ARGV_UNSAFE_TOKEN_RE.test(t))) {
    return { outcome: 'intact', reason: REWRITE_REASON_CODES.INTACT_ARGV_UNSAFE_TOKEN };
  }

  const cmd = argv.join(' ');
  const plan = planRewrite(cmd, budget, opts);
  if (plan.outcome !== 'rewritten') {
    return { outcome: 'intact', reason: plan.reason };
  }

  const retok = tokenizeCommand(plan.command);
  if (!retok.ok) {
    return { outcome: 'intact', reason: REWRITE_REASON_CODES.INTACT_ARGV_RETOKENIZE_FAILED };
  }
  // The adapter never composes an argv-shaped chain (`&&`/`||`/`;`) — a
  // rewritten command that now spans more than one segment cannot be
  // represented as a single argv invocation, so it refuses rather than
  // pick one segment and silently drop the rest.
  if (retok.segments.length !== 1) {
    return { outcome: 'intact', reason: REWRITE_REASON_CODES.INTACT_ARGV_MULTI_SEGMENT };
  }

  const segTokens = retok.segments[0];
  const env = {};
  const renderParts = [];
  let idx = 0;
  while (idx < segTokens.length) {
    const raw = segTokens[idx].raw;
    if (!ENV_ASSIGNMENT_RE.test(raw)) break;
    const eq = raw.indexOf('=');
    env[raw.slice(0, eq)] = unquoteSimple(raw.slice(eq + 1));
    renderParts.push(raw);
    idx += 1;
  }

  const outArgv = [];
  for (; idx < segTokens.length; idx += 1) {
    outArgv.push(unquoteSimple(segTokens[idx].raw));
    renderParts.push(segTokens[idx].raw);
  }

  if (outArgv.length === 0) {
    return { outcome: 'intact', reason: REWRITE_REASON_CODES.INTACT_ARGV_EMPTY_AFTER_ENV_STRIP };
  }

  // Prove the round trip against the RAW sliced bytes (quoting intact) —
  // not the unquoted `env`/`outArgv` values returned to the caller. This
  // catches any bug in the env/argv split above (off-by-one, dropped
  // token, mis-stripped quote) rather than asserting a property that would
  // be true by construction if it compared against itself.
  const rendered = renderParts.join(' ');
  if (rendered !== plan.command) {
    return { outcome: 'intact', reason: REWRITE_REASON_CODES.INTACT_ARGV_ROUNDTRIP_UNPROVEN };
  }

  return { outcome: 'rewritten', argv: outArgv, env, runner: plan.runner, reason: plan.reason };
}

module.exports = {
  tokenizeCommand,
  looksLikeRunnerCommand,
  planRewrite,
  planRewriteArgv,
  REWRITE_REASON_CODES,
  TOKENIZE_REFUSAL_REASONS,
  // Exported for the test suite's internal-shape assertions (classifySegment
  // is the shared predicate both looksLikeRunnerCommand and planRewrite use).
  classifySegment,
  defaultReadScript,
};
