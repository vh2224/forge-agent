#!/usr/bin/env node
'use strict';

// forge-prefs-schema.test.js — M008 S02/T01 coverage keystone.
//
// Proves, mechanically and forever (standing test, not a one-shot check):
//   1. forge-prefs.schema.json is pure JSON at the repo root where
//      loadSchema() pins it (__dirname/../forge-prefs.schema.json).
//   2. Two-way coverage diff:
//        forward — every inventoried knob (generated JSONC scaffold extraction
//        ∪ the curated reader-derived INVENTORY
//        below) resolves to a schema leaf with type + description + default;
//        reverse — every schema leaf is in the inventory ∪ {$schema}
//        (the schema invents no knobs — M008 zero-semantics contract).
//   3. Defaults identity: schema defaults equal the REAL hardcoded fallbacks
//      in the reader code (witness asserts below, each cited), never the md
//      template's example values.
//   4. Self-validation: validatePrefs(defaultsFromSchema, schema) → [].
//
// Zero deps, standalone runner (repo convention): exit != 0 on any failure.

const fs = require('fs');
const path = require('path');
const { loadSchema, validatePrefs, parseJsonc } = require('./forge-prefs.js');
const { spawnSync } = require('child_process');
const { DEFAULT_THRESHOLDS } = require('./forge-context-monitor.js');
// Imported LIVE, not transcribed: the four `parallelism.*` knobs the claim gate
// reads have their hardcoded fallbacks in this object, and the witness asserts
// below compare it against the schema. A transcribed copy would drift the day
// someone edits the gate — which is the exact failure mode the witness block
// exists to catch (S04/T02: `cross_run_overlap` gained its FIRST reader here).
const { PARALLELISM_FALLBACKS } = require('./forge-claim-gate.js');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n  ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── Curated reader-derived inventory ─────────────────────────────────────────
// Every knob any reader (10 scripts + 8 skills + shared/forge-*.md specs)
// actually consumes. `default` is the REAL hardcoded fallback at the cited
// source — NOT the template's example value (e.g. milestone_cleanup default
// is `keep` although the template ships `archive` as its active example).
const INVENTORY = [
  // — top-level flat keys (NOT extractable by legacyReadFile: the legacy
  //   section parser only captures `section:\n  key: value` blocks) —
  { key: 'skip_discuss', type: 'boolean', default: false, source: 'skills/forge-auto/SKILL.md § Phase skip check (absent → no skip)' },
  { key: 'skip_research', type: 'boolean', default: false, source: 'skills/forge-auto/SKILL.md § Phase skip check' },
  { key: 'skip_slice_research', type: 'boolean', default: false, source: 'shared/forge-dispatch.md § dispatch table (research-slice skip rule)' },
  { key: 'reassess_after_slice', type: 'boolean', default: false, source: 'skills/forge-auto/SKILL.md § post-slice housekeeping' },
  { key: 'auto_commit', type: 'boolean', default: true, source: 'skills/forge-auto/SKILL.md:876 {auto_commit} injection; agents/forge-executor.md step 11' },
  { key: 'merge_strategy', type: 'string', default: 'squash', source: 'agents/forge-completer.md § complete-slice merge step' },
  { key: 'auto_push', type: 'boolean', default: false, source: 'agents/forge-completer.md § push step (opt-in)' },
  { key: 'main_branch', type: 'string', default: 'master', source: 'forge-agent-prefs.md § Git Settings (no reader hardcodes another value)' },
  { key: 'milestone_cleanup', type: 'string', default: 'keep', source: 'agents/forge-completer.md:461 "keep (default)"' },
  { key: 'task_cleanup', type: 'string', default: 'keep', source: 'skills/forge-task/SKILL.md:957 "(default: keep)"' },
  { key: 'compact_after', type: ['integer', 'string'], default: 'unlimited', source: 'skills/forge-auto/SKILL.md:63 "if set and not unlimited, else unlimited"' },
  { key: 'notifications', type: 'string', default: 'on', source: 'skills/forge-auto/SKILL.md:58 "if absent or not on/off, default on"' },
  { key: 'repo_path', type: 'string', default: '', source: 'scripts/forge-statusline.js:339 (written by install.sh; absent → update check skipped)' },
  { key: 'node_path', type: 'string', default: '', source: 'app/Sources/ForgeKit/NodeLocatorSystem.swift systemProbe (PrefsLocator.stringPref("node_path"); ausente → descoberta automática)' },
  // — effort (template-extracted too; defaults = EFFORT_DEFAULTS) —
  { key: 'effort.plan-milestone', type: 'string', default: 'medium', source: 'shared/forge-dispatch.md:1594 EFFORT_DEFAULTS' },
  { key: 'effort.plan-slice', type: 'string', default: 'medium', source: 'shared/forge-dispatch.md:1594 EFFORT_DEFAULTS' },
  { key: 'effort.discuss-milestone', type: 'string', default: 'medium', source: 'shared/forge-dispatch.md:1594 EFFORT_DEFAULTS' },
  { key: 'effort.discuss-slice', type: 'string', default: 'medium', source: 'shared/forge-dispatch.md:1594 EFFORT_DEFAULTS' },
  { key: 'effort.research-milestone', type: 'string', default: 'medium', source: 'shared/forge-dispatch.md:1595 EFFORT_DEFAULTS' },
  { key: 'effort.research-slice', type: 'string', default: 'medium', source: 'shared/forge-dispatch.md:1595 EFFORT_DEFAULTS' },
  { key: 'effort.execute-task', type: 'string', default: 'low', source: 'shared/forge-dispatch.md:1595 EFFORT_DEFAULTS' },
  { key: 'effort.complete-slice', type: 'string', default: 'low', source: 'shared/forge-dispatch.md:1596 EFFORT_DEFAULTS' },
  { key: 'effort.complete-milestone', type: 'string', default: 'low', source: 'shared/forge-dispatch.md:1596 EFFORT_DEFAULTS' },
  { key: 'effort.memory-extract', type: 'string', default: 'low', source: 'shared/forge-dispatch.md:1596 EFFORT_DEFAULTS' },
  // — thinking —
  { key: 'thinking.opus_phases', type: 'string', default: 'adaptive', source: 'shared/forge-dispatch.md § Thinking header (THINKING_OPUS default adaptive)' },
  { key: 'thinking.sonnet_phases', type: 'string', default: 'disabled', source: 'forge-agent-prefs.md § Thinking Settings (sonnet does not support extended thinking)' },
  // — ids —
  { key: 'ids.format', type: 'string', default: 'timestamp', source: 'scripts/forge-ids.js readIdFormat (value === sequential ? sequential : timestamp)' },
  // — forge_isolation —
  { key: 'forge_isolation.mode', type: 'string', default: 'shared', source: 'scripts/forge-isolation.js:40 readIsolationPrefs (let mode = shared)' },
  { key: 'forge_isolation.branch_pattern', type: 'string', default: 'forge/{M###}', source: 'scripts/forge-isolation.js:41 (let branchPattern)' },
  { key: 'forge_isolation.auto_pull_main', type: 'boolean', default: true, source: 'scripts/forge-isolation.js:42 (let autoPullMain = true)' },
  { key: 'forge_isolation.pr_on_complete', type: 'boolean', default: false, source: 'scripts/forge-isolation.js:45 (let prOnComplete = false)' },
  { key: 'forge_isolation.worktree_root', type: 'string', default: '.forge-worktrees', source: 'scripts/forge-isolation.js:43 (let worktreeRoot)' },
  { key: 'forge_isolation.worktree_cleanup_on_complete', type: 'boolean', default: false, source: 'scripts/forge-isolation.js:44' },
  { key: 'forge_isolation.file_locks', type: 'boolean', default: true, source: 'scripts/forge-hook.js readFileLocksEnabled (hook-only key; let enabled = true)' },
  { key: 'forge_isolation.repos.auto_detect', type: 'boolean', default: true, source: 'scripts/forge-repos.js readReposPrefs (let autoDetect = true)' },
  { key: 'forge_isolation.repos.include', type: 'array', default: [], source: 'scripts/forge-repos.js readReposPrefs (let include = [])' },
  { key: 'forge_isolation.repos.exclude', type: 'array', default: ['node_modules/**', 'vendor/**', '.forge-worktrees/**', '.gsd/**', 'dist/**', 'build/**', '.next/**'], source: 'scripts/forge-repos.js:20 DEFAULT_EXCLUDE (7 items — wider than the template example)' },
  // — multi_run —
  { key: 'multi_run.stale_cleanup_ms', type: 'integer', default: 1800000, source: 'scripts/forge-runs.js:27 STALE_THRESHOLD_MS = 30 * 60 * 1000' },
  { key: 'multi_run.stale_warning_ms', type: 'integer', default: 180000, source: 'forge-agent-prefs.md § Multi-Run (statusline yellow threshold)' },
  { key: 'multi_run.stale_red_ms', type: 'integer', default: 300000, source: 'forge-agent-prefs.md § Multi-Run (statusline red threshold)' },
  { key: 'multi_run.refused_when_active_count', type: 'integer', default: 2, source: "scripts/forge-cli-helpers.js:68 readPref(cwd, 'multi_run.refused_when_active_count', '2')" },
  { key: 'multi_run.dashboard_refresh_on', type: 'array', default: ['boot', 'exit', 'phase_change'], source: 'skills/forge-auto/SKILL.md:1487 + forge-agent-prefs.md § Multi-Run' },
  { key: 'multi_run.legacy_alias', type: 'boolean', default: true, source: 'scripts/forge-runs.js ALIAS_FILE refresh (auto-mode.json mirror kept by default)' },
  // — parallelism —
  { key: 'parallelism.max_concurrent', type: 'integer', default: 3, source: 'shared/forge-dispatch.md:1979 "integer 1–8; default 3"' },
  { key: 'parallelism.cross_run_overlap', type: 'string', default: 'defer', source: 'scripts/forge-claim-gate.js PARALLELISM_FALLBACKS.cross_run_overlap (primeiro reader real — S04/T02)' },
  { key: 'parallelism.block_wait_ms', type: 'integer', default: 300000, source: 'scripts/forge-claim-gate.js PARALLELISM_FALLBACKS.block_wait_ms (teto de UMA espera bloqueante)' },
  { key: 'parallelism.block_poll_ms', type: 'integer', default: 15000, source: 'scripts/forge-claim-gate.js PARALLELISM_FALLBACKS.block_poll_ms' },
  { key: 'parallelism.defer_cap', type: 'integer', default: 3, source: 'scripts/forge-claim-gate.js PARALLELISM_FALLBACKS.defer_cap (defers consecutivos da mesma unidade)' },
  { key: 'parallelism.claim_gate', type: 'string', default: 'advisory', source: 'scripts/forge-claim-gate.js PARALLELISM_FALLBACKS.claim_gate (eixo advisory|enforcing — PR #110/D1)' },
  { key: 'parallelism.orphan_run_ms', type: 'integer', default: 1800000, source: 'scripts/forge-run-reaper.js DEFAULT_THRESHOLD_MS (desativação REVERSÍVEL de run órfã sem claim)' },
  { key: 'resources.enforcement', type: 'string', default: 'clamp', source: 'scripts/forge-resources.js:195,200 (readResourcePrefs defaults + read)' },
  { key: 'resources.shadow_wait', type: 'boolean', default: true, source: 'scripts/forge-resources.js:195,201 (readResourcePrefs defaults + read)' },
  { key: 'resources.wait_cap_ms', type: 'integer', default: 30000, source: 'scripts/forge-resources.js:195,202 (readResourcePrefs defaults + read)' },
  // — retry —
  { key: 'retry.max_transient_retries', type: 'integer', default: 3, source: 'shared/forge-dispatch.md § Retry Handler (per-unit cap 3)' },
  { key: 'retry.base_backoff_ms', type: 'integer', default: 2000, source: 'shared/forge-dispatch.md § Retry Handler' },
  { key: 'retry.max_backoff_ms', type: 'integer', default: 60000, source: 'shared/forge-dispatch.md § Retry Handler' },
  // — tier_models (scalar-or-list → type ["string","array"]) —
  { key: 'tier_models.light', type: ['string', 'array'], default: 'claude-haiku-4-5-20251001', source: 'scripts/forge-tier-chain.js:35 DEFAULT_TIER_MODEL.light' },
  { key: 'tier_models.standard', type: ['string', 'array'], default: 'claude-sonnet-5', source: 'scripts/forge-tier-chain.js:36 DEFAULT_TIER_MODEL.standard' },
  { key: 'tier_models.heavy', type: ['string', 'array'], default: 'claude-opus-5', source: 'scripts/forge-tier-chain.js:37 DEFAULT_TIER_MODEL.heavy (opus-5: 1M context is the model default, no [1m] suffix)' },
  { key: 'tier_models.max', type: ['string', 'array'], default: 'claude-fable-5', source: 'scripts/forge-tier-chain.js:38 DEFAULT_TIER_MODEL.max' },
  // — workers —
  { key: 'workers.execute-task', type: 'string', default: 'claude', source: 'shared/forge-dispatch.md:1259 (whitelist claude|codex, default-safe claude)' },
  { key: 'workers.plan-slice', type: 'string', default: 'claude', source: 'shared/forge-dispatch.md:1260' },
  { key: 'workers.timeout', type: 'integer', default: 1800, source: 'shared/forge-dispatch.md:1261 + :969 (invalid/non-positive → 1800); adapter-side null passthrough in scripts/forge-xllm.js readWorkersTimeout' },
  { key: 'workers.codex_model', type: ['string', 'null'], default: null, source: 'shared/forge-dispatch.md:1262 "unset (null) → Codex CLI default"' },
  // — routing (open domain map — leaf with additionalProperties: true) —
  { key: 'routing', type: 'object', default: {}, source: 'scripts/forge-routing.js readRoutingConfig (opt-in; absent block → legacy tier_models/workers)' },
  // — verification —
  { key: 'verification.preference_commands', type: 'array', default: [], source: 'scripts/forge-verify.js discovery chain step 2 (default empty → next step)' },
  { key: 'verification.command_timeout_ms', type: 'integer', default: 120000, source: 'scripts/forge-verify.js:62 DEFAULT_COMMAND_TIMEOUT_MS = 120_000' },
  // — evidence —
  { key: 'evidence.mode', type: 'string', default: 'lenient', source: "scripts/forge-hook.js readEvidenceMode (let mode = 'lenient'; whitelist fallback lenient)" },
  // — file_audit —
  { key: 'file_audit.ignore_list', type: 'array', default: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'dist/**', 'build/**', '.next/**', '.gsd/**', 'node_modules/**'], source: 'agents/forge-completer.md:146 hardcoded DEFAULT list' },
  // — memory cost policy —
  { key: 'memory.extraction', type: 'string', default: 'adaptive', source: 'scripts/forge-cost-policy.js normalizeMemoryMode; skills forge-auto/next/task adaptive gate' },
  // — checker_memory —
  { key: 'checker_memory.mode', type: 'string', default: 'enabled', source: 'agents/forge-completer.md sub-step 1.9 (enabled unless explicitly disabled)' },
  // — plan_check —
  { key: 'plan_check.mode', type: 'string', default: 'advisory', source: 'skills/forge-auto/SKILL.md plan-check gate (default advisory; CLAUDE.md § Anti-Hallucination Layer)' },
  // — review —
  { key: 'review.mode', type: 'string', default: 'enabled', source: 'shared/forge-review.md § Step 0 (gate runs unless disabled)' },
  { key: 'review.engine', type: 'string', default: 'agents', source: 'shared/forge-review.md:217 "engine == agents (default)"' },
  { key: 'review.style', type: 'string', default: 'dialectic', source: 'shared/forge-review.md:216 "style == dialectic (default)"' },
  { key: 'review.trigger', type: 'string', default: 'adaptive', source: 'scripts/forge-cost-policy.js normalizeReviewConfig; shared/forge-review.md Step 1.5' },
  { key: 'review.adaptive_flags_lines', type: 'integer', default: 40, source: 'scripts/forge-cost-policy.js normalizeReviewConfig flagsLines' },
  { key: 'review.adaptive_dialectic_lines', type: 'integer', default: 400, source: 'scripts/forge-cost-policy.js normalizeReviewConfig dialecticLines' },
  { key: 'review.rounds', type: 'integer', default: 1, source: 'shared/forge-review.md:16 "review.rounds, default 1"' },
  { key: 'review.ask_in_auto', type: 'string', default: 'defer', source: 'shared/forge-review.md § Step 7b auto branch (defer default)' },
  { key: 'review.fix_conceded', type: 'boolean', default: true, source: 'shared/forge-review.md § resolution table (fix_conceded default true)' },
  { key: 'review.challenger', type: 'string', default: 'claude', source: 'shared/forge-review.md:75 "whitelist claude|codex|gemini, default claude"' },
  { key: 'review.advocate', type: 'string', default: 'claude', source: 'shared/forge-review.md § Step 0 (advocate default claude)' },
  { key: 'review.challenger_model', type: ['string', 'null'], default: null, source: 'shared/forge-review.md:76 "challengerModel — default null (unset)"' },
  { key: 'review.advocate_model', type: 'string', default: 'claude-fable-5', source: "shared/forge-review.md:77 \"advocateModel — default 'claude-fable-5' (literal — not null)\"" },
  // — plan_gate —
  { key: 'plan_gate.interactive', type: 'string', default: 'always', source: "shared/forge-plan-gate.md:39 let interactive='always' (+ :47 whitelist fallback)" },
  { key: 'plan_gate.ask_in_auto', type: 'string', default: 'defer', source: "shared/forge-plan-gate.md:39 askAuto='defer'" },
  // — token_budget —
  { key: 'token_budget.auto_memory', type: 'integer', default: 2000, source: 'shared/forge-dispatch.md:779/:803 "?? 2000"' },
  { key: 'token_budget.ledger_snapshot', type: 'integer', default: 1500, source: 'shared/forge-dispatch.md:781' },
  { key: 'token_budget.coding_standards', type: 'integer', default: 3000, source: 'shared/forge-dispatch.md:780' },
  // — verifier —
  { key: 'verifier.test_quality', type: 'string', default: 'advisory', source: 'scripts/forge-verifier.js Level 4 gate (advisory default — M003 posture)' },
  // — symbol_check —
  { key: 'symbol_check.mode', type: 'string', default: 'advisory', source: 'scripts/forge-symbol-check.js + skills dispatch guard (advisory default)' },
  // — context_monitor —
  { key: 'context_monitor.enabled', type: 'boolean', default: true, source: 'scripts/forge-context-monitor.js readContextMonitorPrefs (let enabled = true)' },
  { key: 'context_monitor.alerts_enabled', type: 'boolean', default: true, source: 'scripts/forge-context-monitor.js readContextMonitorPrefs (let alertsEnabled = true)' },
  { key: 'context_monitor.debounce_tool_uses', type: 'integer', default: 5, source: 'scripts/forge-context-monitor.js DEBOUNCE_TOOLUSES' },
  { key: 'context_monitor.checkpoint_threshold', type: 'number', default: 0.4, source: 'scripts/forge-context-monitor.js DEFAULT_THRESHOLDS.checkpoint' },
  { key: 'context_monitor.warning_threshold', type: 'number', default: 0.35, source: 'scripts/forge-context-monitor.js:44 DEFAULT_THRESHOLDS.warning' },
  { key: 'context_monitor.critical_threshold', type: 'number', default: 0.25, source: 'scripts/forge-context-monitor.js:44 DEFAULT_THRESHOLDS.critical' },
  // — repair —
  { key: 'repair.budget', type: 'integer', default: 2, source: 'shared/forge-dispatch.md:1850 "Default budget: repair.budget = 2"' },
  // — scope_reduction —
  { key: 'scope_reduction.reinject', type: 'string', default: 'auto', source: 'skills/forge-auto/SKILL.md:1540 "default auto"' },
  // — accounts —
  { key: 'accounts.handoff_in_auto', type: 'string', default: 'on', source: 'skills/forge-auto/SKILL.md:1574 "accounts.handoff_in_auto, default on"' },
  { key: 'accounts.handoff_threshold', type: 'integer', default: 90, source: 'skills/forge-auto/SKILL.md:1574 "accounts.handoff_threshold, default 90"' },
  // — app (macOS app only, resolved via forge-prefs.js --resolved with no cwd) —
  { key: 'app.default_workspace', type: 'string', default: '', source: 'app/Sources/Forge/Stores.swift § appDefaults (empty ⇒ WorkspaceDefaults.preselect falls to last-used, never to a workspace)' },
  { key: 'app.session_root_dir', type: 'string', default: '', source: 'app/Sources/ForgeKit/WorkspaceDefaults.swift § sessionRoot (empty ⇒ home)' },
];

// legacyReadFile flattens exactly 2 levels (section.key) — nested level-3 keys
// under forge_isolation.repos surface as forge_isolation.<key>. Map those
// extraction artifacts back to their real schema paths.
const KEY_ALIASES = {
  'forge_isolation.auto_detect': 'forge_isolation.repos.auto_detect',
  'forge_isolation.include': 'forge_isolation.repos.include',
  'forge_isolation.exclude': 'forge_isolation.repos.exclude',
};

// ── Schema walking helpers ───────────────────────────────────────────────────
const VALID_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];

function typeIsValid(t) {
  const types = Array.isArray(t) ? t : [t];
  return types.length > 0 && types.every((x) => VALID_TYPES.includes(x));
}

// Resolve a dotted key through the schema properties tree.
// Returns { node } for an exact match, { node, viaAdditional: true } when an
// intermediate/terminal segment is absorbed by additionalProperties: true,
// or null when the key does not resolve.
function resolveKey(schema, dotted) {
  let node = schema;
  const parts = dotted.split('.');
  for (const part of parts) {
    const props = isPlainObject(node.properties) ? node.properties : {};
    if (Object.prototype.hasOwnProperty.call(props, part)) {
      node = props[part];
    } else if (node.additionalProperties === true) {
      return { node, viaAdditional: true };
    } else {
      return null;
    }
  }
  return { node, viaAdditional: false };
}

// Collect every schema leaf path (a node without a `properties` tree — nodes
// with additionalProperties: true and no fixed properties count as leaves).
function collectLeaves(schema) {
  const leaves = [];
  function walk(node, parts) {
    if (isPlainObject(node.properties)) {
      for (const key of Object.keys(node.properties)) walk(node.properties[key], parts.concat(key));
    } else if (parts.length > 0) {
      leaves.push(parts.join('.'));
    }
  }
  walk(schema, []);
  return leaves;
}

// Inline defaultsFromSchema (T02 ships the exported version) — build the
// full defaults object by walking the schema tree.
function defaultsFromSchema(schema) {
  function walk(node) {
    if (isPlainObject(node.properties)) {
      const out = {};
      for (const key of Object.keys(node.properties)) out[key] = walk(node.properties[key]);
      return out;
    }
    return node.default;
  }
  return walk(schema);
}

// ── 1. Pure JSON at the loadSchema() location ────────────────────────────────
const schemaPath = path.join(__dirname, '..', 'forge-prefs.schema.json');
let schema = null;

check('schema file exists at repo root (loadSchema pin: __dirname/../forge-prefs.schema.json)', () => {
  assert(fs.existsSync(schemaPath), `missing: ${schemaPath}`);
});

check('schema is pure JSON (bare JSON.parse succeeds — no JSONC)', () => {
  schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert(isPlainObject(schema), 'schema root must be an object');
});

check('loadSchema() returns the same non-null schema (validator live, zero engine change)', () => {
  const loaded = loadSchema();
  assert(loaded !== null, 'loadSchema() returned null');
  assert(deepEqual(loaded, schema), 'loadSchema() differs from raw file parse');
});

if (!schema) {
  console.error(`\n${passed} passed, ${failed} failed — schema unreadable, aborting`);
  process.exit(1);
}

// ── 2. Mechanical inventory — generated scaffold side ───────────────────────
// Nesting-aware extraction (M015 S02 review R3 fix): the scaffold comments
// every preference line with `// `. A structural-line regex uncomments only
// lines that look like `"key": value`, `"key": {`, or a closing `}`/`]` —
// prose/header comment lines (descriptions, `── section ──` banners) stay
// commented. The result is valid JSONC that parseJsonc can parse into a real
// nested object, from which we derive actual dotted LEAF paths (walking the
// object structure) instead of matching each dotted-path component
// independently against the raw text (the old approach: `evidence.mode`
// "matched" because `"evidence":` and ANY of the 6 unrelated `"mode":`
// occurrences in the file both matched somewhere, regardless of nesting).
const STRUCTURAL_COMMENT_LINE = /^(\s*)\/\/ ("(?:[^"\\]|\\.)*"\s*:\s*(?:\{|\[.*|.*[,]?)\s*$|\}[,]?\s*$|\][,]?\s*$)/;
function uncommentStructuralLines(text) {
  return text
    .split('\n')
    .map((line) => {
      const m = line.match(STRUCTURAL_COMMENT_LINE);
      return m ? m[1] + m[2] : line;
    })
    .join('\n');
}
function collectObjectLeafPaths(obj, prefix, out) {
  out = out || [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) collectObjectLeafPaths(v, p, out);
    else out.push(p);
  }
  return out;
}
const scaffoldKeys = [];
let scaffoldRawText = '';
{
  const scaffoldRun = spawnSync(process.execPath, [path.join(__dirname, 'forge-prefs.js'), '--scaffold', '--schema-ref', 'forge-prefs.schema.json'], { encoding: 'utf8' });
  assert(scaffoldRun.status === 0, `scaffold command failed: ${scaffoldRun.stderr || scaffoldRun.stdout}`);
  scaffoldRawText = scaffoldRun.stdout;
  const parsed = parseJsonc(scaffoldRun.stdout);
  assert(parsed.ok, `generated scaffold is not valid JSONC: ${parsed.error && parsed.error.message}`);
  const uncommented = uncommentStructuralLines(scaffoldRun.stdout);
  const uncommentedParsed = parseJsonc(uncommented);
  assert(uncommentedParsed.ok, `structurally-uncommented scaffold is not valid JSONC: ${uncommentedParsed.error && uncommentedParsed.error.message}`);
  for (const path_ of collectObjectLeafPaths(uncommentedParsed.value)) {
    if (path_ === '$schema') continue;
    scaffoldKeys.push(path_);
  }
}

check('scaffold extraction is non-trivial (>= 50 parseable keys)', () => {
  assert(scaffoldKeys.length >= 50, `only ${scaffoldKeys.length} keys extracted — scaffold or parser regressed`);
});

// Mutation-proof: deleting the `"mode":` line under `"evidence":` must make
// `evidence.mode` disappear from scaffoldKeys — proves the extraction is
// scoped by actual nesting, not a flat substring/regex match anywhere in the
// file (the bug this fix closes). Mutates only an in-memory copy of the
// generated text, never a repo file.
check('mutation-proof: nesting-aware extraction loses evidence.mode when its line is deleted', () => {
  const mutatedText = scaffoldRawText
    .split('\n')
    .filter((line) => !/\/\/ "mode": "lenient"/.test(line))
    .join('\n');
  const mutatedUncommented = uncommentStructuralLines(mutatedText);
  const mutatedParsed = parseJsonc(mutatedUncommented);
  assert(mutatedParsed.ok, `mutated scaffold failed to parse: ${mutatedParsed.error && mutatedParsed.error.message}`);
  const mutatedKeys = collectObjectLeafPaths(mutatedParsed.value);
  assert(!mutatedKeys.includes('evidence.mode'), 'evidence.mode survived deletion of its own line — extraction is not nesting-aware');
  // Sanity: the flat/naive approach (old bug) WOULD still see evidence.mode
  // present, because "evidence": and other "mode": occurrences remain in the
  // mutated text — this documents exactly what the regression would look like.
  const naivePresent = 'evidence.mode'.split('.').every((part) => new RegExp(`"${part}"\\s*:`).test(mutatedText));
  assert(naivePresent, 'test fixture invalid: naive flat match should still "see" evidence.mode after mutation (to prove the old bug)');
});

// Union: curated ∪ generated scaffold (with legacy-flattening aliases applied).
const inventoryKeys = new Set(INVENTORY.map((e) => e.key));
const aliasedScaffoldKeys = scaffoldKeys.map((k) => KEY_ALIASES[k] || k);
const allKeys = new Set([...inventoryKeys, ...aliasedScaffoldKeys]);

// ── 3. Coverage diff — forward (inventory ⊆ schema) ─────────────────────────
check('forward coverage: every inventoried knob resolves to a schema leaf with type + description + default', () => {
  const missing = [];
  for (const key of allKeys) {
    const hit = resolveKey(schema, key);
    if (!hit) { missing.push(key); continue; }
    if (hit.viaAdditional) continue; // absorbed by an open map (routing domains)
    const n = hit.node;
    const bad = [];
    if (!typeIsValid(n.type)) bad.push('invalid/missing type');
    if (typeof n.description !== 'string' || n.description.trim() === '') bad.push('empty description');
    const hasDefault = Object.prototype.hasOwnProperty.call(n, 'default');
    const hasChildren = isPlainObject(n.properties);
    if (!hasDefault && !hasChildren) bad.push('no default');
    if (bad.length) missing.push(`${key} (${bad.join(', ')})`);
  }
  assert(missing.length === 0, `inventory keys not covered by schema:\n    ${missing.join('\n    ')}`);
});

// ── 4. Coverage diff — reverse (schema ⊆ inventory ∪ {$schema}) ─────────────
check('reverse coverage: every schema leaf is inventoried (no invented knobs — zero-semantics contract)', () => {
  const extras = collectLeaves(schema).filter((leaf) => leaf !== '$schema' && !allKeys.has(leaf));
  assert(extras.length === 0, `schema leaves absent from the inventory:\n    ${extras.join('\n    ')}`);
});

// ── 5. Defaults identity — every curated entry vs schema ────────────────────
check('curated inventory defaults are byte-identical to schema defaults (all entries)', () => {
  const bad = [];
  for (const entry of INVENTORY) {
    const hit = resolveKey(schema, entry.key);
    if (!hit || hit.viaAdditional) { bad.push(`${entry.key}: unresolved`); continue; }
    if (!deepEqual(hit.node.default, entry.default)) {
      bad.push(`${entry.key}: schema=${JSON.stringify(hit.node.default)} reader=${JSON.stringify(entry.default)} [${entry.source}]`);
    }
    if (!deepEqual(hit.node.type, entry.type)) {
      bad.push(`${entry.key}: type schema=${JSON.stringify(hit.node.type)} inventory=${JSON.stringify(entry.type)}`);
    }
  }
  assert(bad.length === 0, `defaults/type mismatches:\n    ${bad.join('\n    ')}`);
});

// ── 6. Witness spot-checks (≥12) — REAL hardcoded reader values ─────────────
function schemaDefault(key) {
  const hit = resolveKey(schema, key);
  if (!hit) throw new Error(`${key}: not in schema`);
  return hit.node.default;
}
// ── 6b. Island join: schema default ↔ the list hardcoded in the completer ────
// The parity net was TWO DISCONNECTED ISLANDS: (A) schema ↔ INVENTORY ↔
// reference.md, and (B) completer.md ↔ Swift defaultIgnoreList. Nothing asserted
// A == B — the INVENTORY's `source:` field naming agents/forge-completer.md:146 is
// a COMMENT, not a read. Editing the schema and forgetting the completer left both
// suites green, which is the same "the 4th site nobody wired" shape that produced
// the T03 repair (S03 review R23). This check reads the completer's real literals.
check('file_audit.ignore_list: schema default == the completer.md hardcoded fallback', () => {
  const completerPath = path.join(__dirname, '..', 'agents', 'forge-completer.md');
  const text = fs.readFileSync(completerPath, 'utf8');
  // Both occurrences on the FILE_AUDIT_IGNORE line: the parse branch and the catch
  // branch. They must agree with each other AND with the schema.
  const literals = [...text.matchAll(/\[\s*'package-lock\.json'[^\]]*\]/g)]
    .map((src) => JSON.parse(src[0].replace(/'/g, '"')));
  assert(literals.length >= 2,
    `expected >= 2 hardcoded ignore_list literals in agents/forge-completer.md, found ${literals.length} — extraction regressed`);
  const fromSchema = schemaDefault('file_audit.ignore_list');
  literals.forEach((literal, i) => {
    assert(deepEqual(literal, fromSchema),
      `completer.md literal #${i + 1} diverges from the schema default:\n    completer: ${JSON.stringify(literal)}\n    schema:    ${JSON.stringify(fromSchema)}`);
  });
});

const WITNESSES = [
  // hook-only keys (read by scripts/forge-hook.js, some absent from template blocks)
  ['evidence.mode', 'lenient', "scripts/forge-hook.js readEvidenceMode: let mode = 'lenient'"],
  ['forge_isolation.file_locks', true, 'scripts/forge-hook.js readFileLocksEnabled: let enabled = true (hook-only)'],
  // gates
  ['plan_check.mode', 'advisory', 'CLAUDE.md § Anti-Hallucination Layer + skills plan-check gate'],
  ['review.rounds', 1, 'shared/forge-review.md:16 default 1'],
  ['review.advocate_model', 'claude-fable-5', 'shared/forge-review.md:77 literal default'],
  ['plan_gate.interactive', 'always', "shared/forge-plan-gate.md:39 let interactive='always'"],
  // tier defaults (forge-tier-chain.js DEFAULT_TIER_MODEL — not exported, cited)
  ['tier_models.light', 'claude-haiku-4-5-20251001', 'scripts/forge-tier-chain.js:35'],
  ['tier_models.heavy', 'claude-opus-5', 'scripts/forge-tier-chain.js:37 (opus-5: no [1m] suffix)'],
  // effort defaults (shared/forge-dispatch.md EFFORT_DEFAULTS)
  ['effort.execute-task', 'low', 'shared/forge-dispatch.md:1595'],
  ['effort.plan-slice', 'medium', 'shared/forge-dispatch.md:1594'],
  // exported reader constants (imported live below in addition to literals)
  ['context_monitor.warning_threshold', DEFAULT_THRESHOLDS.warning, 'scripts/forge-context-monitor.js:44 DEFAULT_THRESHOLDS.warning (imported)'],
  ['context_monitor.critical_threshold', DEFAULT_THRESHOLDS.critical, 'scripts/forge-context-monitor.js:44 DEFAULT_THRESHOLDS.critical (imported)'],
  ['context_monitor.checkpoint_threshold', DEFAULT_THRESHOLDS.checkpoint, 'scripts/forge-context-monitor.js DEFAULT_THRESHOLDS.checkpoint (imported)'],
  // CLI helper fallback arg
  ['multi_run.refused_when_active_count', 2, "scripts/forge-cli-helpers.js:68 readPref(..., '2')"],
  ['multi_run.stale_cleanup_ms', 1800000, 'scripts/forge-runs.js:27 STALE_THRESHOLD_MS = 30 * 60 * 1000'],
  // sidecar + verify + ids + cleanup + compact
  ['workers.timeout', 1800, 'shared/forge-dispatch.md:969 invalid → 1800'],
  ['verification.command_timeout_ms', 120000, 'scripts/forge-verify.js:62 DEFAULT_COMMAND_TIMEOUT_MS'],
  ['ids.format', 'timestamp', 'scripts/forge-ids.js readIdFormat fallback'],
  ['milestone_cleanup', 'keep', 'agents/forge-completer.md:461 — REAL default (template example shows archive)'],
  ['compact_after', 'unlimited', 'skills/forge-auto/SKILL.md:63 — REAL default (template example shows 50)'],
  // parallelism — the claim gate is the reader; the fallbacks are imported live
  // (scripts/forge-claim-gate.js PARALLELISM_FALLBACKS), never transcribed.
  ['parallelism.cross_run_overlap', PARALLELISM_FALLBACKS.cross_run_overlap, 'scripts/forge-claim-gate.js resolvePostureFromPrefs fallback (imported)'],
  ['parallelism.block_wait_ms', PARALLELISM_FALLBACKS.block_wait_ms, 'scripts/forge-claim-gate.js readParallelism fallback (imported)'],
  ['parallelism.block_poll_ms', PARALLELISM_FALLBACKS.block_poll_ms, 'scripts/forge-claim-gate.js readParallelism fallback (imported)'],
  ['parallelism.defer_cap', PARALLELISM_FALLBACKS.defer_cap, 'scripts/forge-claim-gate.js readParallelism fallback (imported)'],
  ['parallelism.claim_gate', PARALLELISM_FALLBACKS.claim_gate, 'scripts/forge-claim-gate.js resolveEnforcementFromPrefs fallback (imported)'],
  ['parallelism.orphan_run_ms', PARALLELISM_FALLBACKS.orphan_run_ms, 'scripts/forge-claim-gate.js readParallelism fallback (imported)'],
  ['forge_isolation.repos.exclude', ['node_modules/**', 'vendor/**', '.forge-worktrees/**', '.gsd/**', 'dist/**', 'build/**', '.next/**'], 'scripts/forge-repos.js:20 DEFAULT_EXCLUDE'],
];
check(`witness defaults identity (${WITNESSES.length} >= 12 asserts, each cited)`, () => {
  assert(WITNESSES.length >= 12, 'need at least 12 witnesses');
  const bad = [];
  for (const [key, expected, source] of WITNESSES) {
    const actual = schemaDefault(key);
    if (!deepEqual(actual, expected)) {
      bad.push(`${key}: schema=${JSON.stringify(actual)} expected=${JSON.stringify(expected)} [${source}]`);
    }
  }
  assert(bad.length === 0, `witness mismatches:\n    ${bad.join('\n    ')}`);
});

// ── 7. Self-validation — schema validates its own defaults with 0 warnings ──
check('validatePrefs(defaultsFromSchema(schema), schema) → [] (0 warnings)', () => {
  const defaults = defaultsFromSchema(schema);
  assert(Object.prototype.hasOwnProperty.call(defaults, '$schema'), '$schema must be a declared root property');
  const warnings = validatePrefs(defaults, schema);
  assert(warnings.length === 0, `warnings:\n    ${warnings.map((w) => w.message).join('\n    ')}`);
});

// ── 7b. Bounds: the schema must not accept what the runtime rejects (S04 R8) ─
// `positiveIntPref` (scripts/forge-claim-gate.js) rejects `<= 0` for the three
// anti-livelock timings and falls back to the default. A schema that validated
// `0` would make the validated document lie about the behaviour the operator
// gets. `minimum` is declared AND enforced by validatePrefs.
for (const key of ['parallelism.block_wait_ms', 'parallelism.block_poll_ms', 'parallelism.defer_cap']) {
  check(`${key} declares minimum: 1 and validatePrefs rejects 0 and negatives`, () => {
    const hit = resolveKey(schema, key);
    assert(hit && hit.node.minimum === 1, `${key}: minimum !== 1`);
    for (const bad of [0, -1]) {
      const doc = { parallelism: { [key.split('.')[1]]: bad } };
      const warnings = validatePrefs(doc, schema);
      assert(warnings.some((w) => w.key === key), `${key}=${bad} deveria gerar warning e não gerou`);
    }
    const ok = validatePrefs({ parallelism: { [key.split('.')[1]]: 1 } }, schema);
    assert(!ok.some((w) => w.key === key), `${key}=1 é válido e não pode gerar warning`);
  });
}

// ── 8. Structural sanity ─────────────────────────────────────────────────────
check('open-set routing node declares additionalProperties: true (validator must not flag domains)', () => {
  const hit = resolveKey(schema, 'routing');
  assert(hit && hit.node.additionalProperties === true, 'routing.additionalProperties !== true');
});

check('no stub descriptions anywhere in the schema', () => {
  const raw = fs.readFileSync(schemaPath, 'utf8');
  assert(!/"description": ""/.test(raw), 'empty description found');
  assert(!/\bTODO\b|\bTBD\b/.test(raw), 'TODO/TBD found');
});

// ── 9. Mechanical reader-grep coverage (S02-R2) ─────────────────────────────
// A SECOND, hand-curation-free signal on top of the INVENTORY above: grep the
// runtime engine scripts (scripts/forge-*.js, excluding *.test.js and the
// forge-smoke.js harness — the latter carries mock/prose pref strings that are
// NOT real reads) for the pref-read patterns the engine actually uses:
//   • `readPrefs(...).X.Y` / `readPrefsCached(...).X.Y`   (drill into .prefs.<dotted>)
//   • `readPref(cwd, 'X.Y')`                              (the singular CLI-helper form)
//   • `--key X.Y`                                         (embedded --resolved --key knob)
// then assert every extracted dotted knob resolves against forge-prefs.schema.json.
// This catches a FUTURE reader consuming a pref absent from the schema — the
// INVENTORY list would silently miss it, this grep would not.
//
// SCOPE LIMITATION (by design): only the JS engine scripts are grepped. The
// markdown skills (skills/**/SKILL.md) read prefs via prose `--resolved --key`
// invocations too, but markdown is prose — parsing it for "real" reads vs.
// documentation examples is unreliable, so it is out of scope here. The skills
// are covered by the shared/forge-*.md spec cross-refs in the INVENTORY.
//
// A dotted access is COVERED when, walking the schema:
//   - every segment resolves through `.properties`, OR
//   - an intermediate/terminal segment is absorbed by `additionalProperties: true`
//     (open maps — routing domains), OR
//   - a proper prefix resolves to a LEAF and the trailing segments are runtime
//     value access on the resolved value (e.g. `.prefs.repo_path.trim` — `.trim`
//     is a String method, not a schema knob).
// A section that exists in the schema whose requested child does NOT exist (and
// is not an open map) is a REAL finding — reported, never silently passed.
function accessResolves(rootSchema, dotted) {
  let node = rootSchema;
  const parts = dotted.split('.');
  for (let i = 0; i < parts.length; i++) {
    const props = isPlainObject(node.properties) ? node.properties : {};
    if (Object.prototype.hasOwnProperty.call(props, parts[i])) {
      node = props[parts[i]];
    } else if (node.additionalProperties === true) {
      return true; // open map absorbs the remaining segments
    } else if (!isPlainObject(node.properties)) {
      return i > 0; // reached a leaf; trailing parts are value access (.trim/.mode/…)
    } else {
      return false; // section exists but this child does not → real finding
    }
  }
  return true;
}

check('mechanical reader-grep: every pref key referenced in scripts/forge-*.js exists in the schema', () => {
  const scriptsDir = __dirname;
  const files = fs.readdirSync(scriptsDir)
    .filter((f) => /^forge-.*\.js$/.test(f) && !/\.test\.js$/.test(f) && f !== 'forge-smoke.js');
  assert(files.length >= 8, `expected ~10 engine scripts, found ${files.length}`);

  const dottedRe = /\.prefs\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/g;
  const readPrefRe = /readPref\(\s*[A-Za-z0-9_.]+\s*,\s*['"]([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)['"]/g;
  const keyFlagRe = /--key\s+([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)/g; // require a dot → skips prose `--key mant`

  const found = new Map(); // dotted → sample "file:line"
  for (const file of files) {
    const text = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, idx) => {
      for (const re of [dottedRe, readPrefRe, keyFlagRe]) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          const key = m[1];
          // ignore the pure `prefs` container and single-segment method noise handled by walk
          if (!found.has(key)) found.set(key, `${file}:${idx + 1}`);
        }
      }
    });
  }

  assert(found.size >= 5, `grep surfaced too few reads (${found.size}) — extraction regex regressed`);

  const findings = [];
  for (const [key, where] of found) {
    if (!accessResolves(schema, key)) findings.push(`${key} (${where})`);
  }
  assert(findings.length === 0,
    `reader references keys ABSENT from forge-prefs.schema.json:\n    ${findings.join('\n    ')}`);
  console.log(`  (mechanical guard: ${found.size} engine-read keys across ${files.length} scripts, all schema-resolved)`);
});

// ── Report ───────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\nforge-prefs-schema: ${passed}/${total} checks passed`);
console.log(`inventory: ${INVENTORY.length} curated reader-derived keys + ${scaffoldKeys.length} scaffold keys → ${allKeys.size} unique knobs; schema leaves: ${collectLeaves(schema).length}`);
if (failed > 0) process.exit(1);
