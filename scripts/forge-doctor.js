#!/usr/bin/env node
// forge-doctor — schema-version + projection-versioned checks for Forge Agent
//
// Library exports:
//   CURRENT_SCHEMA              // string — 'fragment-store@3.0.0'
//   checkSchema(cwd)            // (cwd?) → { ok, expected, actual, message }
//   checkProjectionVersioned(cwd) // (cwd?) → { ok, tracked: string[], skipped?: string, message }
//   checkPlanRepoDeclared(cwd)  // (cwd?) → { ok, plans: string[], skipped?: string, message }  (advisory)
//   checkWorkspaceConsistency(cwd) // (cwd?) → { ok: true, workspaces, divergentCount, skipped?, message }  (advisory, D3)
//   checkResources(cwd, options)   // (cwd?, { platform?, poolDir? }?) → { ok: true, verdict?, pool?, census?, skipped?, message }  (advisory)
//   checkClaimStuck(cwd)           // (cwd?) → { ok: true, verdict, stuck, unmeasured, census, skipped?, message }  (advisory, #120)
//
// CLI:
//   node forge-doctor.js --check schema [--cwd <dir>]
//   node forge-doctor.js --check projection-versioned [--cwd <dir>]
//   node forge-doctor.js --check plan-repo-declared [--cwd <dir>]
//   node forge-doctor.js --check workspace-consistency [--cwd <dir>]
//   node forge-doctor.js --check run-overlap [--cwd <dir>]
//   node forge-doctor.js --check resources [--cwd <dir>]
//   node forge-doctor.js --check claim-stuck [--cwd <dir>]
//   node forge-doctor.js --check all [--cwd <dir>]
//   node forge-doctor.js --fix [--cwd <dir>]
//   node forge-doctor.js --regen-projection [--cwd <dir>]
//   node forge-doctor.js --help
//
// Exit codes: 0 all checks pass, 1 check failed, 2 bad arguments.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ── Imports from forge-ignore ─────────────────────────────────────────────────
const { PROJECTION_IGNORE_PATHS, detectVcs } = require('./forge-ignore');
const { audit: auditReview } = require('./forge-review-audit');
const { detect: detectCapabilities } = require('./forge-capabilities');
const maintenance = require('./forge-maintenance');

// ── Constants ─────────────────────────────────────────────────────────────────
const CURRENT_SCHEMA = 'fragment-store@3.0.0';
const SCHEMA_FILE = '.gsd/SCHEMA-VERSION';

// Single source of truth for the check names this CLI accepts via `--check`.
// `runCheck` dispatches these; the unknown-check message and `--help` text
// must both be derived from this array — never hand-repeated.
const VALID_CHECKS = ['schema', 'projection-versioned', 'review-model-drift', 'plan-repo-declared', 'capabilities', 'workspace-consistency', 'run-overlap', 'resources', 'claim-stuck'];

// ── checkSchema ───────────────────────────────────────────────────────────────
/**
 * Reads .gsd/SCHEMA-VERSION and compares to CURRENT_SCHEMA.
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: boolean, expected: string, actual: string|null, message: string }}
 */
function checkSchema(cwd) {
  const dir = cwd || process.cwd();
  const schemaPath = path.join(dir, SCHEMA_FILE);

  if (!fs.existsSync(schemaPath)) {
    return {
      ok: false,
      expected: CURRENT_SCHEMA,
      actual: null,
      message: `SCHEMA-VERSION not found at ${schemaPath}. Run --fix to create it.`,
    };
  }

  const actual = fs.readFileSync(schemaPath, 'utf8').trim();

  if (actual === CURRENT_SCHEMA) {
    return {
      ok: true,
      expected: CURRENT_SCHEMA,
      actual,
      message: `Schema version matches: ${actual}`,
    };
  }

  return {
    ok: false,
    expected: CURRENT_SCHEMA,
    actual,
    message: `Schema version mismatch — expected "${CURRENT_SCHEMA}", got "${actual}". Run --fix to update.`,
  };
}

// ── checkProjectionVersioned ──────────────────────────────────────────────────
/**
 * Checks if any projection monolith is tracked by VCS (should be ignored).
 * Uses PROJECTION_IGNORE_PATHS from forge-ignore.js — single source of truth.
 *
 * The membership question goes through the `forge-vcs.js` seam (`isTracked`),
 * never through a VCS command parsed here. This layer previously read
 * `svn status <path>` textually and got the answer backwards on both ends —
 * an ignored path prints `I <path>` (read as tracked) and a versioned clean
 * one prints nothing (read as untracked). Re-implementing VCS access beside
 * the seam is what produced that; the seam owns the oracle now.
 *
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: boolean, tracked: string[], skipped?: string, unreadable?: string[], message: string }}
 */
function checkProjectionVersioned(cwd) {
  const dir = cwd || process.cwd();
  const vcs = detectVcs(dir);

  if (vcs === 'none') {
    return {
      ok: true,
      tracked: [],
      skipped: 'not-git',
      message: 'No VCS detected — projection-versioned check skipped.',
    };
  }

  const { isTracked } = require('./forge-vcs');

  const tracked = [];
  const unreadable = [];
  for (const projPath of PROJECTION_IGNORE_PATHS) {
    const probe = isTracked(dir, projPath, { vcs });
    // `ok: false` is "could not ask" (VCS binary absent), never "the answer is
    // no". Accusing on an unanswered probe is how this check lost the operator's
    // trust in the first place — it is reported, not counted.
    if (!probe.ok) unreadable.push(projPath);
    else if (probe.tracked) tracked.push(projPath);
  }

  const label = vcs === 'svn' ? 'SVN' : 'git';
  const suffix = unreadable.length
    ? ` (${unreadable.length} path(s) could not be probed: ${unreadable.join(', ')})`
    : '';

  if (tracked.length === 0) {
    return {
      ok: true,
      tracked: [],
      ...(unreadable.length ? { unreadable } : {}),
      message: `No projection monoliths are tracked by ${label}.${suffix}`,
    };
  }

  // Both failure texts are verbatim what they were before the seam refactor —
  // `commands/forge-doctor.md` reproduces the git one as sample output.
  const accusation = vcs === 'svn'
    ? `${tracked.length} projection monolith(s) tracked by SVN (should be ignored): ${tracked.join(', ')}`
    : `${tracked.length} projection monolith(s) accidentally tracked by git (should be in .gitignore): ${tracked.join(', ')}`;
  return {
    ok: false,
    tracked,
    ...(unreadable.length ? { unreadable } : {}),
    message: `${accusation}${suffix}`,
  };
}

// ── checkPlanRepoDeclared ─────────────────────────────────────────────────────
//
// Advisory (TASK-018). `repo:` is a frontmatter field introduced AFTER plans already
// existed, so a milestone planned before it — or by an older planner — carries plans that
// cannot be attributed to one repo in a multi-repo workspace. The resolver refuses those
// units fail-closed (`sidecar-code-dir-undeclared`), which is correct but only visible one
// unit at a time, mid-run. This layer answers the question up front: WHICH pending plans
// will refuse. It never writes: filling `repo:` by guesswork is worse than leaving it
// absent, because the resolver TRUSTS the declaration (P4 returns before the probe).

const PLAN_FILE_RE = /-PLAN\.md$/i;
const TASK_PLAN_FILE_RE = /^T.*-PLAN\.md$/i;
// The predicate this layer reports on. Deliberately ONE field: the class ("frontmatter key
// added after plans exist") is broader, but a second real case has to show up before
// generalizing is anything but speculation.
const REQUIRED_PLAN_FIELD = 'repo';

// Recursive walker, zero deps. Never descends into `archive/` and never returns a path
// under `.gsd/archive/` — an archived plan will never be dispatched again, so flagging it
// would be pure noise.
function collectPlanFiles(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'archive') continue;
      collectPlanFiles(full, out);
    } else if (ent.isFile() && PLAN_FILE_RE.test(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Lists pending plans that declare no `repo:` in a multi-repo workspace.
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: boolean, plans: string[], skipped?: string, message: string }}
 */
function checkPlanRepoDeclared(cwd) {
  const dir = cwd || process.cwd();

  const { discoverRepos } = require('./forge-repos');
  let repos = [];
  try { repos = discoverRepos(dir) || []; } catch (_) { repos = []; }
  if (repos.length < 2) {
    return {
      ok: true,
      plans: [],
      skipped: 'single-repo',
      message: `Workspace has ${repos.length} repo(s) — \`${REQUIRED_PLAN_FIELD}:\` is only needed in a multi-repo workspace; check skipped.`,
    };
  }

  const { parseScalarField, frontmatterOf } = require('./forge-code-dir');

  const candidates = [];
  const milestonesDir = path.join(dir, '.gsd', 'milestones');
  for (const p of collectPlanFiles(milestonesDir, [])) {
    if (TASK_PLAN_FILE_RE.test(path.basename(p))) candidates.push(p);
  }
  const tasksDir = path.join(dir, '.gsd', 'tasks');
  for (const p of collectPlanFiles(tasksDir, [])) candidates.push(p);

  const plans = [];
  for (const planPath of candidates) {
    if (planPath.replace(/\\/g, '/').includes('/.gsd/archive/')) continue;

    // Already executed → declaring `repo:` now changes nothing.
    const planDir = path.dirname(planPath);
    let siblings = [];
    try { siblings = fs.readdirSync(planDir); } catch (_) { siblings = []; }
    if (siblings.some(name => /-SUMMARY\.md$/i.test(name))) continue;

    let text = '';
    try { text = fs.readFileSync(planPath, 'utf8'); } catch (_) { continue; }
    const fm = frontmatterOf(text);
    const status = String(parseScalarField(fm, 'status') || '').toUpperCase();
    if (status === 'DONE' || status === 'DECOMPOSED') continue;

    if (!parseScalarField(fm, REQUIRED_PLAN_FIELD)) {
      plans.push(path.relative(dir, planPath).replace(/\\/g, '/'));
    }
  }

  plans.sort();

  if (plans.length === 0) {
    return {
      ok: true,
      plans: [],
      message: `All pending plans declare \`${REQUIRED_PLAN_FIELD}:\` (${repos.length} repos in workspace).`,
    };
  }

  return {
    ok: true, // advisory — a missing `repo:` is legitimate in a single-repo workspace and
              // is already handled fail-closed by the resolver; this never fails the run.
    plans,
    message: `${plans.length} pending plan(s) declare no \`${REQUIRED_PLAN_FIELD}:\` in a multi-repo workspace (${repos.length} repos). `
      + 'Those whose `writes:`/`expected_output:` cannot be attributed to a single repo will be refused with '
      + '`sidecar-code-dir-undeclared` and fall back to Claude. '
      + `Declaring \`${REQUIRED_PLAN_FIELD}: <repo-dir-name>\` in the plan frontmatter removes the ambiguity up front — `
      + '`--fix` does NOT fill it: the resolver trusts the declaration, so a guessed value is worse than an absent one.',
  };
}

/** Runtime capability diagnostics retained alongside the v4.2 workspace checks. */
function checkCapabilities(cwd, options = {}) {
  let legacy = { probes: {} };
  try { legacy = detectCapabilities(cwd, options); } catch (error) {
    // `--check all` remains useful in a minimal fixture or an uninitialised
    // directory; the richer maintenance report below carries the actionable
    // diagnostic when a catalog is present.
    legacy = { probes: {}, error: error.message };
  }
  const report = maintenance.diagnose({
    ...options,
    repo: options.repo || path.resolve(__dirname, '..'),
    cwd,
    runtime: options.runtime || 'claude',
  });
  const failures = (report.required_failures || []).map((id) => {
    const probe = report.probes && report.probes[id];
    return { id, status: probe && probe.status, reason_code: probe && probe.reason_code };
  });
  const warnings = Object.keys(report.probes || {}).sort()
    .map((id) => report.probes[id])
    .filter((probe) => probe.reason_code === 'not-selected'
      || (probe.status !== 'available' && !(report.required_failures || []).includes(probe.id)))
    .map((probe) => ({ id: probe.id, status: probe.status, reason_code: probe.reason_code }));
  const message = report.ok
    ? `Capabilities ${report.runtime}: required capabilities available (${warnings.length} conditional warning(s)).`
    : `Capabilities ${report.runtime}: ${failures.length} required failure(s); see reason_code.`;
  return {
    check: 'capabilities',
    ok: report.ok,
    protocol_version: report.protocol_version,
    runtime: report.runtime,
    // Keep legacy probe fields byte-compatible; richer maintenance diagnostics
    // are additive and do not change existing doctor consumers.
    probes: report.probes || legacy.probes || {},
    diagnostics: report.diagnostics || [],
    failures,
    warnings,
    message,
  };
}

// ── checkWorkspaceConsistency ─────────────────────────────────────────────────
/**
 * Advisory guard (D3, T04): confronts the registry (~/.claude) against the
 * on-disk marker of each indexed workspace and surfaces divergence. Wraps
 * `auditWorkspaces` from `forge-workspace-consistency.js` — this function does
 * not implement the comparison itself, it only shapes the result the way this
 * CLI's other checks are shaped, following `checkPlanRepoDeclared`'s form.
 *
 * ALWAYS `ok: true` — divergence here is advisory information, never a
 * failure. See `forge-workspace-consistency.js` for the full rationale (D3
 * mandates this guard never blocks).
 *
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: true, workspaces: object[], divergentCount: number, skipped?: string, message: string }}
 */
function checkWorkspaceConsistency(cwd) {
  const dir = cwd || process.cwd();
  const { auditWorkspaces } = require('./forge-workspace-consistency');

  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) {
    return {
      ok: true,
      workspaces: [],
      divergentCount: 0,
      skipped: 'no-home',
      message: 'forge-workspace-consistency: sem HOME resolvível — check pulado (advisory).',
    };
  }

  let result;
  try {
    result = auditWorkspaces({ home, cwd: dir });
  } catch (e) {
    return {
      ok: true, // advisory — an internal error here still must not fail `--check all`
      workspaces: [],
      divergentCount: 0,
      skipped: `error: ${e.message}`,
      message: `forge-workspace-consistency: erro ao auditar (${e.message}) — advisory, não bloqueia.`,
    };
  }

  if (result.skipped) {
    return {
      ok: true,
      workspaces: [],
      divergentCount: 0,
      skipped: result.skipped,
      message: `forge-workspace-consistency: ${result.skipped} — nada a confrontar.`,
    };
  }

  const divergent = result.workspaces.filter((w) => w.status === 'divergent');
  const unreadable = result.workspaces.filter((w) => w.status === 'marker-unreadable');

  if (divergent.length === 0 && unreadable.length === 0) {
    return {
      ok: true,
      workspaces: result.workspaces,
      divergentCount: 0,
      message: `${result.workspaces.length} workspace(s) indexado(s) verificado(s) — registry e marcador consistentes (advisory).`,
    };
  }

  const lines = [];
  for (const w of divergent) {
    for (const d of w.diffs) {
      const reg = d.registry_path || '(ausente)';
      const mk = d.marker_path || '(ausente)';
      lines.push(`${w.workspace}: ${d.name} [${d.kind}] registry=${reg} marcador=${mk}`);
    }
  }
  for (const w of unreadable) {
    lines.push(`${w.workspace}: marcador ilegível (${w.error})`);
  }

  return {
    ok: true, // advisory — never fails `--check all`; D3 requires exit 0 always
    workspaces: result.workspaces,
    divergentCount: divergent.length,
    message: `${divergent.length + unreadable.length} workspace(s) com registry × marcador divergentes ou ilegíveis (advisory, nunca bloqueia):\n    `
      + lines.join('\n    '),
  };
}

// ── checkRunOverlap ──────────────────────────────────────────────────────────
/**
 * Advisory guard (S07/T03): confronts the touch snapshots forge-touch.js
 * records against every other active run and surfaces cross-run file
 * collisions. Wraps `collectRunTouches`/`computeOverlap` from
 * `forge-overlap.js` — this function does not implement the comparison
 * itself, it only shapes the result the way this CLI's other checks are
 * shaped, following `checkWorkspaceConsistency`'s form.
 *
 * ALWAYS `ok: true` — overlap here is advisory information, never a failure.
 * See `forge-overlap.js` for the locked boundary (signals, never sequences)
 * and the verdict floor (`pairs_compared === 0` → `inconclusive`, never a
 * silent `clean`).
 *
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: true, verdict?: string, overlaps: object[], skipped?: string, message: string }}
 */
function checkRunOverlap(cwd) {
  const dir = cwd || process.cwd();
  const { collectRunTouches, computeOverlap, formatOverlap } = require('./forge-overlap');

  const runsDir = path.join(dir, '.gsd', 'forge', 'runs');
  if (!fs.existsSync(runsDir)) {
    return {
      ok: true,
      overlaps: [],
      skipped: 'no-runs-registry',
      message: 'forge-overlap: sem .gsd/forge/runs/ — nada a confrontar (advisory).',
    };
  }

  let result;
  try {
    result = computeOverlap(collectRunTouches(dir, {}));
  } catch (e) {
    return {
      ok: true, // advisory — an internal error here still must not fail `--check all`
      overlaps: [],
      skipped: `error: ${e.message}`,
      message: `forge-overlap: erro ao confrontar (${e.message}) — advisory, não bloqueia.`,
    };
  }

  return {
    ok: true, // advisory — never fails `--check all`, including verdict === 'overlap'
    verdict: result.verdict,
    overlaps: result.overlaps,
    census: {
      runs_examined: result.runs_examined,
      runs_with_touch_data: result.runs_with_touch_data,
      pairs_compared: result.pairs_compared,
      files_compared: result.files_compared,
      skipped: result.skipped.length,
    },
    message: formatOverlap(result),
  };
}

// ── checkResources ───────────────────────────────────────────────────────────
/**
 * Advisory guard (S05/T02): surfaces the S05/T01 census plus a LIVE read of
 * current resource pressure and pool occupancy, in the shape of every other
 * check on this CLI (molde: `checkRunOverlap`). This function does not decide
 * anything about admission/sizing (CONTEXT D10) — it consumes
 * `forge-resources-census.js` (T01), `resolveResourceBudget` (forge-resources.js)
 * and `poolStatus` (forge-resource-pool.js) and formats what they already
 * computed.
 *
 * `noEvents: true` is passed to `resolveResourceBudget` deliberately — this
 * diagnostic runs the resolver LIVE to report current pressure, and without
 * `noEvents` every invocation of this check would append a `resource-admission`
 * event, contaminating the very census it reports (S05-PLAN.md § "O diagnóstico
 * não pode poluir o log que audita"). Proven by a byte-identical events.jsonl
 * before/after test.
 *
 * ALWAYS `ok: true` — resource pressure/pool/census here is advisory
 * information, never a failure. `--check all` never turns red because of this
 * check, including when the census verdict is `degraded`.
 *
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @param {object} [options] - `{ platform, poolDir }` — both forwarded for
 *   test injection (forced platform degradation, isolated pool root).
 * @returns {{ ok: true, verdict?: string, skipped?: string, message: string }}
 */
function checkResources(cwd, options) {
  const dir = cwd || process.cwd();
  const opts = options || {};

  try {
    const { resolveResourceBudget } = require('./forge-resources.js');
    const { poolStatus } = require('./forge-resource-pool.js');
    const {
      collectResourceEvents, buildCensus, reconcileW3, formatCensus,
    } = require('./forge-resources-census.js');

    // (a) Live pressure — noEvents:true so the diagnostic never contaminates
    // the very stream it audits.
    const contract = resolveResourceBudget({ cwd: dir, noEvents: true, platform: opts.platform });

    const aggregateMb = contract.workers * contract.heapMb;
    const totalMb = Math.round(os.totalmem() / (1024 * 1024));

    const pressureLines = [
      `forge-doctor: pressão viva — reason=${contract.reason} nível=${contract.pressureLevel === null ? 'n/a' : contract.pressureLevel}`
      + ` workers=${contract.workers} heapMb=${contract.heapMb} playwrightWorkers=${contract.playwrightWorkers}`
      + ` enforcement=${contract.enforcement} fonte=${contract.source}`
      + `${contract.maxConcurrentClamp !== undefined ? ` clamp=${contract.maxConcurrentClamp}` : ''}`,
      `  heap agregado: ${aggregateMb} MB (workers × heapMb) vs RAM ${totalMb} MB`
      + `${contract.shadowWait && contract.shadowWait.triggered ? ' · shadow-wait ativo' : ''}`,
    ];

    // (b) Pool occupancy.
    const pool = poolStatus({ poolDir: opts.poolDir });
    const poolLine = pool.ok
      ? `  pool: ceiling=${pool.ceiling} held=${pool.held} free=${pool.free}`
      + ` (${(pool.slots || []).filter((s) => s.state === 'held').length} held-observados)`
      : `  pool: ${pool.reason}`;

    // (c) T01 census + W3 reconciliation.
    const collected = collectResourceEvents(dir, {});
    const census = buildCensus(collected);
    census.w3 = reconcileW3(dir, collected, {});

    const message = [...pressureLines, poolLine, formatCensus(census)].join('\n');

    return {
      ok: true, // advisory — never fails `--check all`, including verdict === 'degraded'
      verdict: census.verdict,
      pool: pool.ok ? { ceiling: pool.ceiling, held: pool.held, free: pool.free } : { reason: pool.reason },
      census: {
        events_scanned: census.events_scanned,
        resource_events: census.resource_events,
        degraded_count: census.degraded_count,
        skipped: census.skipped.length,
      },
      message,
    };
  } catch (e) {
    return {
      ok: true, // advisory — an internal error here still must not fail `--check all`
      skipped: `error: ${e.message}`,
      message: `forge-doctor: erro ao diagnosticar recursos (${e.message}) — advisory, não bloqueia.`,
    };
  }
}

// ── module.exports ────────────────────────────────────────────────────────────
module.exports = {
  CURRENT_SCHEMA,
  VALID_CHECKS,
  checkSchema,
  checkProjectionVersioned,
  checkPlanRepoDeclared,
  checkCapabilities,
  checkWorkspaceConsistency,
  checkRunOverlap,
  checkResources,
  checkClaimStuck,
};

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

// ── checkClaimStuck ──────────────────────────────────────────────────────────
/**
 * Advisory guard (issue #120): surfaces the runs the reaper can NEVER reach —
 * active, holding a write claim, and with a heartbeat already past the same
 * threshold `forge-run-reaper.js` uses. Wraps `findStuckClaims`
 * (`forge-claim-stuck.js`); this function does not implement the census, it
 * only shapes the result the way this CLI's other checks are shaped (molde:
 * `checkRunOverlap`).
 *
 * Why it earns a place on the dashboard: today that state has no automatic
 * exit and no name. It shows up to the operator as a recurring `Bloqueado:`
 * with no root cause, and the only remedy (`/forge-pause <run>`) is invisible
 * unless you already know which run is stuck. Counting AND naming them is what
 * makes the state legible — and it is also the measurement that later decides
 * the policy question the issue deliberately leaves open.
 *
 * ALWAYS `ok: true` — a stuck run is advisory information, never a failure of
 * this CLI. `--check all` never turns red because of it, including when the
 * verdict is `stuck`. Deciding what to DO about the run is not this check's
 * job and not this module's (see forge-claim-stuck.js § What this module
 * REFUSES to do).
 *
 * @param {string} [cwd] - Working directory (default: process.cwd())
 * @returns {{ ok: true, verdict: string, stuck: object[], unmeasured: object[], census: object, skipped?: string, message: string }}
 */
function checkClaimStuck(cwd) {
  const dir = cwd || process.cwd();

  const runsDir = path.join(dir, '.gsd', 'forge', 'runs');
  if (!fs.existsSync(runsDir)) {
    return {
      ok: true,
      verdict: 'inconclusive',
      stuck: [],
      unmeasured: [],
      census: { runs_examined: 0, runs_classified: 0, claim_holders: 0, skipped: [], unparseable: [] },
      skipped: 'no-runs-registry',
      message: 'forge-claim-stuck: sem .gsd/forge/runs/ — nada a classificar (advisory).',
    };
  }

  let result;
  try {
    const { findStuckClaims, formatStuck } = require('./forge-claim-stuck');
    result = findStuckClaims(dir, {});
    return {
      ok: true, // advisory — never fails `--check all`, including verdict === 'stuck'
      verdict: result.verdict,
      stuck: result.stuck,
      unmeasured: result.unmeasured,
      census: result.census,
      threshold_ms: result.threshold_ms,
      message: formatStuck(result),
    };
  } catch (e) {
    return {
      ok: true, // advisory — an internal error here still must not fail `--check all`
      verdict: 'inconclusive',
      stuck: [],
      unmeasured: [],
      census: { runs_examined: 0, runs_classified: 0, claim_holders: 0, skipped: [], unparseable: [] },
      skipped: `error: ${e.message}`,
      message: `forge-claim-stuck: erro ao classificar runs (${e.message}) — advisory, não bloqueia.`,
    };
  }
}

function runCheck(name, cwd, options = {}) {
  const checks = name === 'all' ? VALID_CHECKS.slice() : [name];
  const explicit = name !== 'all';

  let allOk = true;
  const results = [];

  for (const c of checks) {
    if (c === 'schema') {
      const r = checkSchema(cwd);
      results.push({ check: 'schema', ...r });
      if (!r.ok) allOk = false;
    } else if (c === 'projection-versioned') {
      const r = checkProjectionVersioned(cwd);
      results.push({ check: 'projection-versioned', ...r });
      if (!r.ok) allOk = false;
    } else if (c === 'review-model-drift') {
      const report = auditReview(path.join(cwd, '.gsd', 'forge', 'events.jsonl'), cwd);
      results.push({ check: c, ok: true, report, message: `${report.drifts.length} advisory review model drift(s) (compares history against TODAY's advocate_model preference — a past preference change can surface old, then-compliant events as drift).` });
    } else if (c === 'plan-repo-declared') {
      const r = checkPlanRepoDeclared(cwd);
      results.push({ check: c, ...r });
      // Advisory: `r.ok` is always true, so this never flips `allOk`.
      if (!r.ok) allOk = false;
    } else if (c === 'capabilities') {
      const r = checkCapabilities(cwd, options);
      results.push(r);
      // Capability availability is actionable when explicitly requested, but
      // remains advisory in the aggregate doctor dashboard so missing paid
      // CLIs do not block unrelated schema/workspace diagnostics.
      if (!r.ok && explicit) allOk = false;
    } else if (c === 'workspace-consistency') {
      const r = checkWorkspaceConsistency(cwd);
      results.push({ check: c, ...r });
      // Advisory (D3): `r.ok` is always true, so this never flips `allOk` — a
      // registry × marker divergence must never fail `--check all`.
      if (!r.ok) allOk = false;
    } else if (c === 'run-overlap') {
      const r = checkRunOverlap(cwd);
      results.push({ check: c, ...r });
      // Advisory: `r.ok` is always true, so this never flips `allOk` — a
      // cross-run overlap must never fail `--check all`.
      if (!r.ok) allOk = false;
    } else if (c === 'resources') {
      const r = checkResources(cwd, options);
      results.push({ check: c, ...r });
      // Advisory: `r.ok` is always true, so this never flips `allOk` — live
      // pressure/pool/census here must never fail `--check all`.
      if (!r.ok) allOk = false;
    } else if (c === 'claim-stuck') {
      const r = checkClaimStuck(cwd);
      results.push({ check: c, ...r });
      // Advisory: `r.ok` is always true, so this never flips `allOk` — a run
      // out of the reaper's reach is a fact to surface, never a failure of the
      // diagnostic that surfaced it.
      if (!r.ok) allOk = false;
    } else {
      process.stderr.write(`forge-doctor: unknown check "${c}". Valid: ${VALID_CHECKS.join(', ')}, all\n`);
      process.exit(2);
    }
  }

  return { allOk, results };
}

function formatResults(results) {
  const lines = [];
  for (const r of results) {
    // R5 (S05 review, arbitrated): an `inconclusive`/errored advisory result
    // rendering ✓ invites the wrong inference — this milestone's whole thesis
    // is that inconclusive != clean. Both `resources` and `run-overlap` now
    // warn on anything short of a genuinely clean/measured result; exit code
    // stays 0 in every case (advisory posture unchanged).
    const advisoryWarn = (r.check === 'plan-repo-declared' && Array.isArray(r.plans) && r.plans.length > 0)
      || (r.check === 'workspace-consistency' && r.divergentCount > 0)
      || (r.check === 'run-overlap' && (r.verdict === 'overlap' || r.verdict === 'inconclusive'))
      || (r.check === 'resources' && ((r.verdict && r.verdict !== 'clean') || Boolean(r.skipped)))
      // Same R5 arbitration: a run out of the reaper's reach, and an `inconclusive` census that
      // classified nothing, must not both render ✓ next to a genuinely measured clean.
      || (r.check === 'claim-stuck' && r.verdict !== 'clean');
    const icon = advisoryWarn ? '⚠' : (r.ok ? '✓' : '✗');
    const label = r.check === 'schema' ? 'Layer 2 — Schema version'
      : r.check === 'review-model-drift' ? 'Advisory — Review model drift'
      : r.check === 'plan-repo-declared' ? 'Advisory — Plan repo declaration'
      : r.check === 'capabilities' ? 'Runtime — Capabilities'
      : r.check === 'workspace-consistency' ? 'Advisory — Workspace registry × marker consistency'
      : r.check === 'run-overlap' ? 'Advisory — Cross-run overlap'
      : r.check === 'resources' ? 'Advisory — Resource control'
      : r.check === 'claim-stuck' ? 'Advisory — Runs fora do alcance do reaper'
      : r.check === 'projection-versioned' ? 'Layer 3 — Projection versioned'
      // Named, never inherited. This chain used to END at the projection label, so a check added
      // without one rendered under ANOTHER check's name — a diagnostic lying about what it
      // measured, which is the exact failure this file exists to catch elsewhere.
      : r.check;
    lines.push(`  ${icon} ${label}`);
    lines.push(`    ${r.message}`);
    if (!r.ok && r.tracked && r.tracked.length > 0) {
      for (const t of r.tracked) lines.push(`      - ${t}`);
    }
    if (advisoryWarn && r.check === 'plan-repo-declared') {
      for (const p of r.plans) lines.push(`      - ${p}`);
    }
    if (r.check === 'capabilities') {
      for (const failure of r.failures || []) lines.push(`      - ${failure.id}: ${failure.status} (${failure.reason_code})`);
      for (const warning of r.warnings || []) if (warning.reason_code !== 'not-selected') lines.push(`      - warning ${warning.id}: ${warning.status} (${warning.reason_code})`);
    }
  }
  return lines.join('\n');
}

function cliMain() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(`forge-doctor — Forge schema-version and projection-versioned checks

Flags:
  --check <name> [--cwd <dir>]   run check: ${VALID_CHECKS.join(' | ')} |
                                 all
  --runtime <name>               capabilities host: claude | codex | both
  --json                         emit deterministic JSON for capability checks
  --recover-claim <run-id>       preview manual recovery of a stuck live claim
    --apply --confirm-owner-stopped --confirm-workspace-quiescent
  --restore-claim <run-id>       preview; apply requires --confirm-workspace-quiescent
  --fix [--cwd <dir>] [--migrate]  write SCHEMA-VERSION if missing; suggest ignore
                                 fixes. Refuses to stamp an unmigrated store unless
                                 --migrate is given (then runs forge-migrate first).
  --regen-projection [--cwd <dir>] [--force]  regenerate monolith projections from
                                 fragment store (refuses to overwrite a populated
                                 monolith from an empty store unless --force)
  --cwd <dir>                    working directory (default: process.cwd())
  --help                         show this help

Exit codes:
  0  all requested checks passed
  1  one or more checks failed
  2  bad arguments
`);
    return;
  }

  const cwdArg = typeof args.cwd === 'string' ? path.resolve(args.cwd) : process.cwd();

  if (args['recover-claim'] || args['restore-claim']) {
    if (args['recover-claim'] && args['restore-claim']) {
      process.stderr.write('forge-doctor: choose exactly one of --recover-claim or --restore-claim\n');
      process.exit(2); return;
    }
    const recovery = require('./forge-claim-recovery.js');
    const runId = String(args['recover-claim'] || args['restore-claim']);
    let result;
    if (args['restore-claim']) result = recovery.restore(cwdArg, runId, { apply: args.apply === true, confirmWorkspaceQuiescent: args['confirm-workspace-quiescent'] === true });
    else if (args.apply) result = recovery.apply(cwdArg, runId, { confirmOwnerStopped: args['confirm-owner-stopped'] === true, confirmWorkspaceQuiescent: args['confirm-workspace-quiescent'] === true });
    else result = recovery.inspect(cwdArg, runId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(result.ok ? 0 : 1); return;
  }

  if (args.fix) {
    const schemaPath = path.join(cwdArg, SCHEMA_FILE);
    const gsdDir = path.join(cwdArg, '.gsd');
    let fixed = [];

    // Ensure .gsd/ exists
    if (!fs.existsSync(gsdDir)) {
      fs.mkdirSync(gsdDir, { recursive: true });
    }

    // Migration gate: never stamp SCHEMA-VERSION on an unmigrated working copy.
    // A stamped-but-empty store makes --regen-projection destructive (it would
    // overwrite populated monoliths with empty skeletons). Require an explicit
    // --migrate to decompose the monoliths into fragments before stamping.
    const { isUnmigrated, storeState } = require('./forge-store-state');
    if (isUnmigrated(cwdArg)) {
      const st = storeState(cwdArg);
      const unmig = Object.entries(st)
        .filter(([, s]) => s.state === 'unmigrated')
        .map(([name, s]) => `${name} (${s.monolithPath}: ${s.monolithEntries} entries, 0 fragments)`);

      if (!args.migrate) {
        process.stdout.write('forge-doctor --fix:\n');
        process.stdout.write('  Refusing to stamp SCHEMA-VERSION — fragment store is not migrated.\n');
        process.stdout.write('  The following monoliths still hold the source of truth:\n');
        for (const u of unmig) process.stdout.write(`    - ${u}\n`);
        process.stdout.write('\n  Run the migration first (decomposes monoliths → fragments, then stamps):\n');
        process.stdout.write('    node scripts/forge-migrate.js\n');
        process.stdout.write('  Or let --fix run it for you:\n');
        process.stdout.write('    node scripts/forge-doctor.js --fix --migrate\n');
        process.exit(1);
        return;
      }

      // --migrate: delegate to the umbrella migrator. migrateAll() backs up each
      // monolith to .bak, decomposes into fragments, verifies, and stamps
      // SCHEMA-VERSION itself. Lazy-required to avoid the forge-migrate ↔
      // forge-doctor require cycle.
      const { migrateAll } = require('./forge-migrate');
      let results;
      try {
        results = migrateAll(cwdArg, {});
      } catch (e) {
        process.stderr.write(`forge-doctor --fix --migrate: migration failed: ${e.message}\n`);
        process.exit(1);
        return;
      }
      const migErr = ['ledger', 'decisions', 'memory'].find(n => results[n] && results[n].error);
      if (migErr) {
        process.stderr.write(`forge-doctor --fix --migrate: ${migErr} migration errored: ${results[migErr].error}\n`);
        process.stderr.write('  Partial state preserved; .bak files kept. See above.\n');
        process.exit(1);
        return;
      }
      process.stdout.write('forge-doctor --fix --migrate:\n');
      for (const n of ['ledger', 'decisions', 'memory']) {
        const r = results[n];
        if (r) process.stdout.write(`  ${n}: ${r.written} fragment(s) written, verification: ${r.verification}\n`);
      }
      process.stdout.write(`  SCHEMA-VERSION stamped: ${results.schema_version_written}\n`);
      process.exit(0);
      return;
    }

    if (!fs.existsSync(schemaPath)) {
      fs.writeFileSync(schemaPath, CURRENT_SCHEMA + '\n', 'utf8');
      fixed.push(`Created ${SCHEMA_FILE} with "${CURRENT_SCHEMA}"`);
    } else {
      const current = fs.readFileSync(schemaPath, 'utf8').trim();
      if (current !== CURRENT_SCHEMA) {
        fs.writeFileSync(schemaPath, CURRENT_SCHEMA + '\n', 'utf8');
        fixed.push(`Updated ${SCHEMA_FILE}: "${current}" → "${CURRENT_SCHEMA}"`);
      } else {
        fixed.push(`${SCHEMA_FILE} already at "${CURRENT_SCHEMA}" — no change`);
      }
    }

    // Suggest ignore fixes for tracked projections
    const projResult = checkProjectionVersioned(cwdArg);
    if (!projResult.ok && projResult.tracked.length > 0) {
      process.stdout.write(`forge-doctor --fix:\n`);
      for (const f of fixed) process.stdout.write(`  ${f}\n`);
      process.stdout.write(`\nProjection monoliths tracked by VCS:\n`);
      for (const t of projResult.tracked) process.stdout.write(`  - ${t}\n`);
      process.stdout.write(`\nTo fix, run:\n  node scripts/forge-ignore.js --apply\n`);
    } else {
      process.stdout.write(`forge-doctor --fix:\n`);
      for (const f of fixed) process.stdout.write(`  ${f}\n`);
    }
    process.exit(0);
    return;
  }

  if (args['regen-projection']) {
    const projectionScript = path.resolve(__dirname, 'forge-projection.js');
    const projArgs = ['--write-all'];
    if (cwdArg !== process.cwd()) projArgs.push('--cwd', cwdArg);
    if (args.force) projArgs.push('--force');
    try {
      execFileSync(process.execPath, [projectionScript].concat(projArgs), { stdio: 'inherit' });
      process.stdout.write('Monoliths regenerated. (.gsd/{AUTO-MEMORY,DECISIONS,LEDGER,CHECKER-MEMORY}.md refreshed from fragments.)\n');
      process.exit(0);
    } catch (err) {
      // forge-projection exits 1 when a target was blocked (empty store would
      // overwrite a populated monolith). The block reasons were printed to
      // stderr via stdio:inherit — add the operator-facing next step.
      process.stderr.write('forge-doctor --regen-projection: regeneration incomplete.\n');
      process.stderr.write('  An unmigrated store would overwrite a populated monolith.\n');
      process.stderr.write('  Run the migration first:  node scripts/forge-migrate.js\n');
      process.stderr.write('  Or force-overwrite (data loss):  node scripts/forge-doctor.js --regen-projection --force\n');
      process.exit(1);
    }
    return;
  }

  if (args.check) {
    const { allOk, results } = runCheck(args.check, cwdArg, {
      runtime: args.runtime,
      platform: typeof args.platform === 'string' ? args.platform : undefined,
      poolDir: typeof args['pool-dir'] === 'string' ? args['pool-dir'] : undefined,
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ ok: allOk, results })}\n`);
      process.exit(allOk ? 0 : 1);
      return;
    }
    process.stdout.write('Forge Doctor\n============\n\n');
    process.stdout.write(formatResults(results) + '\n');
    const passed = results.filter(r => r.ok).length;
    process.stdout.write(`\n  Summary: ${passed}/${results.length} checks passed\n`);
    process.exit(allOk ? 0 : 1);
    return;
  }

  process.stderr.write('forge-doctor: no command specified. Use --help.\n');
  process.exit(2);
}

if (require.main === module) cliMain();
