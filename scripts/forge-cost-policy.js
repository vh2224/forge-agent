#!/usr/bin/env node
/**
 * Deterministic cost gates for Forge.
 *
 * The policy intentionally decides WHETHER an LLM call is warranted; it never
 * asks another model to decide whether to ask a model.  Two hot-path policies
 * live here:
 *   - review: skip docs-only diffs, use one-pass flags for ordinary code, and
 *     reserve the full dialectic for explicit risk signals.
 *   - memory: extract only when a completed unit can add durable knowledge.
 *
 * Zero npm dependencies. CommonJS for the installed ~/.claude/scripts layout.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let prefsEngine = null;
try { prefsEngine = require('./forge-prefs.js'); } catch {}

const DOC_PATH_RE = /(^|\/)(docs?|examples?|changelog)(\/|$)|\.(?:md|mdx|txt|rst|adoc)$/i;
const TEST_PATH_RE = /(^|\/)(?:test|tests|__tests__|fixtures?)(\/|$)|\.(?:test|spec)\.[^.]+$/i;
const SENSITIVE_PATH_RE = /(^|\/)(?:auth|security|crypto|permissions?|payments?|billing|migrations?|infra|deploy|database|schema)(?:\/|[._-]|$)|(^|\/)\.github\/workflows(?:\/|$)/i;
const MEMORY_SIGNAL_RE = /\b(?:decision|decidiu|gotcha|pitfall|workaround|unexpected|surpresa|pattern|padr[aã]o|convention|conven[cç][aã]o|constraint|restri[cç][aã]o|root cause|causa raiz|reusable|reutiliz[aá]vel)\b/i;
const MAX_UNTRACKED_SCAN_BYTES = 8 * 1024 * 1024;

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseNumstat(text) {
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const parts = raw.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : Number(parts[0]);
    const deleted = parts[1] === '-' ? 0 : Number(parts[1]);
    const file = normalizePath(parts.slice(2).join('\t'));
    if (!file) continue;
    entries.push({
      file,
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
      binary: parts[0] === '-' || parts[1] === '-',
    });
  }
  return entries;
}

function run(cwd, command, args) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function canonicalRoot(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // Keep the original path so the caller reports the actual VCS failure.
    return resolved;
  }
}

function collectDiff(cwd, base, scopeFile) {
  // Every containment comparison below must use the same canonical namespace as
  // `realpathSync` on untracked files. On macOS `/tmp` and `/var` commonly
  // traverse symlinks, so a lexical root would otherwise classify safe new files
  // as escaped and suppress their diff contribution.
  const root = canonicalRoot(cwd);
  const insideGit = run(root, 'git', ['rev-parse', '--is-inside-work-tree']);
  if (insideGit.ok) {
    // `git diff <base>` includes committed changes since base plus current
    // tracked working-tree changes. No shell/eval and no user-controlled flags.
    const safeBase = typeof base === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/@{}^~:-]*$/.test(base)
      ? base
      : 'HEAD';
    let diff = run(root, 'git', ['diff', '--numstat', safeBase, '--']);
    let warning = null;
    if (!diff.ok && safeBase !== 'HEAD') {
      warning = diff.stderr.trim() || `git-diff-failed:${safeBase}`;
      diff = run(root, 'git', ['diff', '--numstat', 'HEAD', '--']);
    }

    const entries = diff.ok ? parseNumstat(diff.stdout) : [];
    const seen = new Set(entries.map((entry) => entry.file));
    const untracked = run(root, 'git', ['ls-files', '--others', '--exclude-standard', '-z', '--']);
    if (untracked.ok) {
      for (const relative of untracked.stdout.split('\0').map(normalizePath).filter(Boolean)) {
        if (seen.has(relative)) continue;
        const absolute = path.resolve(root, relative);
        const escaped = path.relative(root, absolute);
        if (escaped === '..' || escaped.startsWith(`..${path.sep}`) || path.isAbsolute(escaped)) continue;
        try {
          const stat = fs.lstatSync(absolute);
          if (stat.isSymbolicLink()) {
            entries.push({ file: relative, added: 0, deleted: 0, binary: true });
            seen.add(relative);
            warning = warning || `untracked-symlink-not-read:${relative}`;
            continue;
          }
          if (!stat.isFile()) continue;
          const real = fs.realpathSync(absolute);
          const escapedReal = path.relative(root, real);
          if (escapedReal === '..' || escapedReal.startsWith(`..${path.sep}`) || path.isAbsolute(escapedReal)) {
            warning = warning || `untracked-realpath-escaped:${relative}`;
            entries.push({ file: relative, added: 0, deleted: 0, binary: true });
            seen.add(relative);
            continue;
          }
          if (stat.size > MAX_UNTRACKED_SCAN_BYTES) {
            // Do not read an arbitrarily large untracked file into the
            // orchestrator process. The conservative estimate plus binary flag
            // promotes the review to dialectic without exposing file content.
            entries.push({ file: relative, added: Math.ceil(stat.size / 80), deleted: 0, binary: true });
            seen.add(relative);
            warning = warning || `untracked-scan-capped:${relative}`;
            continue;
          }
          const data = fs.readFileSync(absolute);
          const binary = data.includes(0);
          const added = binary ? 0 : (data.length === 0 ? 0 : data.toString('utf8').split(/\r?\n/).length);
          entries.push({ file: relative, added, deleted: 0, binary });
          seen.add(relative);
        } catch {
          warning = warning || `untracked-stat-failed:${relative}`;
        }
      }
    } else {
      warning = warning || untracked.stderr.trim() || 'git-untracked-scan-failed';
    }
    const usable = diff.ok || (untracked.ok && entries.length > 0);
    return {
      vcs: 'git',
      base: safeBase,
      ok: usable,
      entries,
      warning: diff.ok ? warning : (diff.stderr.trim() || warning || 'git-diff-failed'),
    };
  }

  const insideSvn = run(root, 'svn', ['info']);
  if (insideSvn.ok) {
    return { vcs: 'svn', base: null, ...require('./forge-review-diff').collectDiffEntries(root, scopeFile) };
  }

  return { vcs: 'none', base: null, ok: false, entries: [], warning: 'vcs-unavailable' };
}

/**
 * Restricts a collected diff to one unit's paths.
 *
 * Only SVN needs this. Git scopes itself: the slice branch and `.gitignore`
 * already exclude other people's work. An SVN working copy has neither, and is
 * routinely shared, so the raw diff carries colleagues' uncommitted files —
 * enough of them to push this policy from `flags` to `dialectic` and to shard
 * the review across challengers reading code the unit does not own.
 *
 * Fails open in both empty cases: an unreadable/empty scope file, or one that
 * matches nothing, leaves the diff untouched rather than shrinking it to zero.
 * A zero-entry diff would decide `skip` — turning a mis-applied scope into a
 * silently skipped review, which is the failure this whole layer guards against.
 */
function applyScopeFile(diff, scopeFile) {
  if (!scopeFile) return diff;
  let wanted;
  try {
    wanted = new Set(
      fs.readFileSync(scopeFile, 'utf8').split(/\r?\n/).map(normalizePath).filter(Boolean)
    );
  } catch {
    return { ...diff, warning: diff.warning || 'scope-file-unreadable' };
  }
  if (wanted.size === 0) return { ...diff, warning: diff.warning || 'scope-file-empty' };

  const inScope = entry => {
    if (wanted.has(entry.file)) return true;
    for (const declared of wanted) if (entry.file.startsWith(`${declared}/`)) return true;
    return false;
  };
  const entries = diff.entries.filter(inScope);
  if (entries.length === 0) return { ...diff, warning: diff.warning || 'scope-file-matched-nothing' };
  return { ...diff, entries, scoped: diff.entries.length - entries.length };
}

function normalizeReviewConfig(review) {
  const cfg = review && typeof review === 'object' ? review : {};
  const mode = ['enabled', 'disabled'].includes(String(cfg.mode || '').toLowerCase())
    ? String(cfg.mode).toLowerCase()
    : 'enabled';
  const style = ['dialectic', 'flags'].includes(String(cfg.style || '').toLowerCase())
    ? String(cfg.style).toLowerCase()
    : 'dialectic';
  const trigger = ['always', 'adaptive'].includes(String(cfg.trigger || '').toLowerCase())
    ? String(cfg.trigger).toLowerCase()
    : 'adaptive';
  return {
    mode,
    style,
    trigger,
    flagsLines: positiveInt(cfg.adaptive_flags_lines, 40),
    dialecticLines: positiveInt(cfg.adaptive_dialectic_lines, 400),
    rounds: Number.isInteger(cfg.rounds) && cfg.rounds >= 0 && cfg.rounds <= 3 ? cfg.rounds : 1,
  };
}

// ── Review sharding — keep a challenger's context bounded ───────────────────
// A single challenger reading a whole slice diff dies on context once the diff
// is big enough, and a dead challenger returns NO verdict at all: the gate
// degrades to "no objections" on exactly the changes most likely to carry one.
// (Observed: four agents burned on one diff, the real defect found later by
// hand.) Splitting by FILE keeps each challenger's read bounded and, unlike
// splitting by hunk, never shows an agent half a function.
//
// Deterministic bin-packing: files sorted by size descending, each placed in the
// lightest shard so far. Same input always yields the same shards, so a resumed
// review re-derives the identical split. One shard means "no split" — the caller
// keeps today's single unscoped dispatch.
const SHARD_MIN_LINES   = 1500; // below this a single challenger is comfortable
const SHARD_TARGET_LINES = 800; // aim per shard once splitting
const SHARD_MAX          = 6;   // ceiling on parallel challengers per review
// The external challenger adapter (forge-xllm.js MAX_DIFF_LINES) refuses any diff
// above this many lines with review-diff-too-large before calling a provider. The
// shard cap can still pack more than that into one shard (or one file can exceed
// it alone), so such a shard is marked here: dispatching it can only fail, and the
// procedure records it as incomplete coverage instead. Changed lines are a lower
// bound on the diff's own line count, so a marked shard is always refused.
const CHALLENGER_MAX_DIFF_LINES = 4000;

function markOversized(shard) {
  return shard.lines > CHALLENGER_MAX_DIFF_LINES
    ? { ...shard, oversized: true, max_lines: CHALLENGER_MAX_DIFF_LINES }
    : shard;
}

function planReviewShards(entries, opts) {
  const o = opts || {};
  const minLines = positiveInt(o.minLines, SHARD_MIN_LINES);
  const target = positiveInt(o.targetLines, SHARD_TARGET_LINES);
  const maxShards = positiveInt(o.maxShards, SHARD_MAX);
  const list = (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      file: normalizePath(entry && entry.file),
      // A binary file carries no line counts but still costs a read; charge it
      // one line so it cannot make a shard look free.
      lines: Number(entry && entry.review_lines || 0) || Number(entry && entry.added || 0) + Number(entry && entry.deleted || 0) || 1,
    }))
    .filter((entry) => entry.file);
  const total = list.reduce((sum, entry) => sum + entry.lines, 0);
  if (list.length <= 1 || total < minLines) {
    return list.length ? [markOversized({ files: list.map((e) => e.file), lines: total })] : [];
  }
  const count = Math.max(2, Math.min(maxShards, list.length, Math.ceil(total / target)));
  const shards = Array.from({ length: count }, () => ({ files: [], lines: 0 }));
  for (const entry of list.slice().sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file))) {
    let lightest = shards[0];
    for (const shard of shards) if (shard.lines < lightest.lines) lightest = shard;
    lightest.files.push(entry.file);
    lightest.lines += entry.lines;
  }
  // A shard can end up empty when files < count is impossible by construction,
  // but stay defensive: never hand the caller a dispatch with no files.
  return shards.filter((shard) => shard.files.length > 0).map(markOversized);
}

function decideReview(input) {
  const config = normalizeReviewConfig(input && input.review);
  const entries = Array.isArray(input && input.entries) ? input.entries : [];
  const risk = String(input && input.risk || 'normal').toLowerCase();
  const securityPresent = Boolean(input && input.securityPresent);
  const verificationDrift = Boolean(input && input.verificationDrift);
  const changedLines = entries.reduce((sum, entry) => sum + Number(entry.added || 0) + Number(entry.deleted || 0), 0);
  const files = entries.map((entry) => normalizePath(entry.file)).filter(Boolean);
  const docsOnly = files.length > 0 && files.every((file) => DOC_PATH_RE.test(file));
  const testsOnly = files.length > 0 && files.every((file) => TEST_PATH_RE.test(file));
  const sensitiveFiles = files.filter((file) => SENSITIVE_PATH_RE.test(file));
  const binaryFiles = entries.filter((entry) => entry.binary).map((entry) => normalizePath(entry.file));
  const riskSignals = [];

  if (risk === 'high' || risk === 'critical') riskSignals.push(`risk:${risk}`);
  if (securityPresent) riskSignals.push('security-checklist');
  if (verificationDrift) riskSignals.push('verification-drift');
  if (sensitiveFiles.length > 0) riskSignals.push('sensitive-path');
  if (binaryFiles.length > 0) riskSignals.push('binary-or-unscanned-change');
  if (changedLines >= config.dialecticLines) riskSignals.push('large-diff');

  const fullCalls = 2 + config.rounds;
  let decision;
  let reason;

  if (config.mode === 'disabled') {
    decision = 'skip';
    reason = 'review-disabled';
  } else if (entries.length === 0) {
    decision = 'skip';
    reason = 'empty-diff';
  } else if (config.trigger === 'always') {
    decision = config.style;
    reason = 'configured-always';
  } else if (config.style === 'flags') {
    decision = 'flags';
    reason = 'configured-flags';
  } else if (riskSignals.length > 0) {
    decision = 'dialectic';
    reason = `adaptive-risk:${riskSignals.join(',')}`;
  } else if (docsOnly) {
    decision = 'skip';
    reason = 'adaptive-docs-only';
  } else {
    decision = 'flags';
    reason = testsOnly
      ? 'adaptive-tests-only'
      : (changedLines <= config.flagsLines ? 'adaptive-small-diff' : 'adaptive-normal-diff');
  }

  const estimatedCalls = decision === 'skip' ? 0 : (decision === 'flags' ? 1 : fullCalls);
  return {
    decision,
    reason,
    trigger: config.trigger,
    configured_style: config.style,
    changed_files: files.length,
    changed_lines: changedLines,
    docs_only: docsOnly,
    tests_only: testsOnly,
    sensitive_files: sensitiveFiles,
    binary_files: binaryFiles,
    risk_signals: riskSignals,
    estimated_calls: estimatedCalls,
    saved_calls_vs_dialectic: Math.max(0, fullCalls - estimatedCalls),
    // Additive. Length 1 (or 0) = no split, the caller dispatches exactly as
    // before. Only computed when a challenger will actually run.
    shards: decision === 'skip' ? [] : planReviewShards(entries),
  };
}

function normalizeMemoryMode(memory) {
  const value = String(memory && memory.extraction || '').toLowerCase();
  return ['always', 'adaptive', 'disabled'].includes(value) ? value : 'adaptive';
}

function decideMemory(input) {
  const mode = normalizeMemoryMode(input && input.memory);
  const unitType = String(input && input.unitType || '').toLowerCase();
  const result = String(input && input.result || '');

  if (mode === 'disabled') return { decision: 'skip', reason: 'memory-disabled', mode };
  if (mode === 'always') return { decision: 'extract', reason: 'configured-always', mode };

  if (unitType === 'complete-slice' || unitType === 'complete-milestone') {
    return { decision: 'extract', reason: 'adaptive-boundary-summary', mode };
  }
  if (unitType === 'execute-task' && MEMORY_SIGNAL_RE.test(result)) {
    return { decision: 'extract', reason: 'adaptive-durable-signal', mode };
  }
  return { decision: 'skip', reason: `adaptive-artifact-owned:${unitType || 'unknown'}`, mode };
}

function failOpenOnDiffError(decision, review, diffOk) {
  if (diffOk || !decision || decision.reason !== 'empty-diff') return decision;
  const cfg = normalizeReviewConfig(review);
  const next = { ...decision };
  next.decision = cfg.trigger === 'always' ? cfg.style : 'flags';
  next.reason = 'diff-unavailable-fail-open';
  next.estimated_calls = next.decision === 'dialectic' ? 2 + cfg.rounds : 1;
  next.saved_calls_vs_dialectic = Math.max(0, 2 + cfg.rounds - next.estimated_calls);
  return next;
}

function readPrefs(cwd) {
  if (!prefsEngine || typeof prefsEngine.readPrefs !== 'function') return {};
  try {
    const resolved = prefsEngine.readPrefs(path.resolve(cwd || process.cwd()));
    return resolved && resolved.prefs || {};
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const out = { command: argv[0] || '', cwd: process.cwd(), base: null, risk: 'normal', securityPresent: false, verificationDrift: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cwd') out.cwd = argv[++i];
    else if (arg === '--base') out.base = argv[++i];
    else if (arg === '--scope-file') out.scopeFile = argv[++i];
    else if (arg === '--risk') out.risk = argv[++i];
    else if (arg === '--unit-type') out.unitType = argv[++i];
    else if (arg === '--security-present') out.securityPresent = true;
    else if (arg === '--verification-drift') out.verificationDrift = true;
    else if (arg === '--stdin') out.stdin = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node forge-cost-policy.js review [--cwd <dir>] [--base <git-ref>] [--scope-file <f>] [--risk normal|high] [--security-present] [--verification-drift]',
    '  <result | node forge-cost-policy.js memory --unit-type <type> [--cwd <dir>] --stdin',
  ].join('\n');
}

function runCli(argv) {
  let args;
  try { args = parseArgs(argv); }
  catch (err) {
    process.stderr.write(`${err.message}\n${usage()}\n`);
    return 2;
  }
  if (args.help || !['review', 'memory'].includes(args.command)) {
    process.stdout.write(`${usage()}\n`);
    return args.help ? 0 : 2;
  }

  const prefs = readPrefs(args.cwd);
  if (args.command === 'review') {
    const diff = applyScopeFile(collectDiff(args.cwd, args.base, args.scopeFile), args.scopeFile);
    let decision = decideReview({
      review: prefs.review,
      entries: diff.entries,
      risk: args.risk,
      securityPresent: args.securityPresent,
      verificationDrift: args.verificationDrift,
    });
    // A broken diff probe must never masquerade as an empty diff and silently
    // suppress review. Adaptive mode fails open to one-pass flags; an explicit
    // always+dialectic configuration remains authoritative.
    decision = failOpenOnDiffError(decision, prefs.review, diff.ok);
    process.stdout.write(`${JSON.stringify({ ...decision, diff_source: diff.vcs, diff_warning: diff.warning })}\n`);
    return 0;
  }

  if (!args.unitType) {
    process.stderr.write('--unit-type is required for memory policy\n');
    return 2;
  }
  const result = args.stdin ? fs.readFileSync(0, 'utf8') : '';
  process.stdout.write(`${JSON.stringify(decideMemory({ memory: prefs.memory, unitType: args.unitType, result }))}\n`);
  return 0;
}

module.exports = {
  applyScopeFile,
  parseNumstat,
  collectDiff,
  normalizeReviewConfig,
  decideReview,
  planReviewShards,
  CHALLENGER_MAX_DIFF_LINES,
  decideMemory,
  failOpenOnDiffError,
  runCli,
};

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
