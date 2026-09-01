#!/usr/bin/env node
/** Advisory route audit: event history is evidence; current prefs are context only. */
'use strict';

const fs = require('fs');
const path = require('path');
const readEvents = require('./forge-review-pairing').readEvents;
const runs = require('./forge-runs');
const { resolveRoute, mapPhase } = require('./forge-routing');

/*
 * Event contract notes
 * --------------------
 * This tool consumes append-only telemetry, which means every decision is
 * evidence-based and order-preserving. It deliberately does not infer a
 * fallback from current preferences: configuration can be changed after a
 * worker was dispatched, while the event stream records what happened.
 *
 * A unit key includes milestone and slice. Task ids repeat by design across
 * milestones, and a bare T01 key would silently merge unrelated work.
 *
 * Scope is intentionally strict. Empty strings and '-' are data values; only
 * an event that owns both discriminator properties can be considered scoped.
 * No global legacy fallback is used here because an audit with no evidence is
 * more truthful than one that borrows another slice's evidence: an audit never
 * answers a milestone query with another milestone's dispatches.
 *
 * The one sanctioned widening is an identity, not a guess. Emitters record the
 * milestone as `${RUN_ID:-{M###}}`, so the same milestone can appear under its
 * run id. The runs registry maps one to the other, and both spellings of the
 * SAME milestone are accepted. Unrelated milestones never are.
 *
 * Engine names come from two vocabularies. `gpt` is the model-family spelling
 * emitted by older dispatches, while `codex` is the worker-engine spelling.
 * Unknown and absent engines stay undefined so a historical record never
 * turns into an invented Claude dispatch.
 *
 * Every dispatch replaces the unit's complete runtime snapshot. The four
 * axes are historical evidence from that dispatch only: host_runtime,
 * worker_mode and dispatch_allowed retain their own recorded values, while
 * worker_engine is normalized exclusively from event.engine. A later legacy
 * dispatch therefore clears axes it did not record instead of inheriting
 * them from an earlier attempt, a neighbouring unit, or current preferences.
 * Only undefined means absent; explicit falsy values (especially the boolean
 * false) remain present evidence and participate in runtime coverage.
 *
 * There are exactly two drift signals: the explicit fallback event and a
 * changed first-to-last dispatch engine. The latter covers chain walks, which
 * intentionally do not generate a generic fallback event while a next member
 * remains available.
 *
 * Route rendering is documentation-only. It has a stable heading because a
 * summary has many owners and this tool must surgically replace only its own
 * section. An unavailable event file is therefore an empty audit, not an
 * error and never a blocked close-out.
 *
 * The write guard requires an existing, non-symlink target below cwd/.gsd.
 * The caller may invoke this CLI by hand, so path validation is part of the
 * CLI boundary rather than a convention delegated to forge-completer.
 *
 * JSONL is read only through forge-review-pairing.readEvents. That reader
 * parses line-by-line and discards a truncated record, which is required for
 * telemetry produced immediately before an interrupted process exits.
 *
 * `hint` is evidence only. Older events do not have it, and no reason-to-hint
 * lookup exists in this module. If a hint was not recorded, the markdown
 * omits it rather than presenting synthesized diagnostic text as history.
 */

// eventEngine in forge-review-pairing deliberately defaults legacy data to Claude; this audit must not.
function normalizeEngine(value) {
  if (value === 'codex' || value === 'gpt') return 'codex';
  if (value === 'claude') return 'claude';
  if (value === 'gemini') return 'gemini';
  return undefined;
}

function inScope(event, scope) {
  if (!event || !Object.prototype.hasOwnProperty.call(event, 'slice') || event.slice !== scope.slice) return false;
  if (!Object.prototype.hasOwnProperty.call(event, 'milestone')) return false;
  if (event.milestone === scope.milestone) return true;
  // Alias set, when supplied, holds only other spellings of THIS milestone (run id ↔ milestone id).
  return scope.milestone_aliases instanceof Set && scope.milestone_aliases.has(event.milestone);
}

// A milestone run is registered under its own id, so RUN_ID and the milestone id are the same
// entity recorded under two spellings. The registry is the only source consulted; a milestone
// with no run record simply has no alias.
function milestoneAliases(cwd, milestone) {
  const aliases = new Set();
  if (typeof milestone !== 'string' || milestone === '') return aliases;
  let records = [];
  try { records = runs.listAll(cwd); } catch { records = []; }
  for (const record of records) {
    if (!record || typeof record.id !== 'string') continue;
    const dirId = typeof record.milestone_dir === 'string'
      ? (record.milestone_dir.split('/').filter(Boolean).pop() || undefined)
      : undefined;
    if (record.id === milestone && dirId) aliases.add(dirId);
    if (dirId === milestone) aliases.add(record.id);
  }
  aliases.delete(milestone);
  return aliases;
}

function aggregateUnits(events, scope) {
  const units = new Map();
  for (const event of events) {
    if (!inScope(event, scope)) continue;
    if (!['dispatch', 'worker-engine-fallback'].includes(event.event)) continue;
    if (typeof event.unit !== 'string') continue;
    // Alias-matched events belong to the queried milestone, so they key under it: the codex dispatch
    // written as RUN_ID and the Claude fallback written as {M###} are one unit, not two.
    const milestone = scope.milestone !== undefined ? scope.milestone : event.milestone;
    const key = `${milestone}|${event.slice}|${event.unit}`;
    if (!units.has(key)) units.set(key, {
      key, unit: event.unit, milestone, slice: event.slice,
      engine_attempted: [], engine_final: undefined, route_source: undefined,
      domain: undefined, tier: undefined, model: undefined, fallback_reason: undefined,
      fallback_hint: undefined, fallback: false,
      host_runtime: undefined, worker_engine: undefined, worker_mode: undefined,
      dispatch_allowed: undefined,
    });
    const unit = units.get(key);
    if (event.event === 'dispatch') {
      const engine = normalizeEngine(event.engine);
      unit.engine_attempted.push(engine);
      unit.engine_final = engine;
      // Last-dispatch-wins as one indivisible snapshot. Do not merge fields
      // with the previous attempt: an omitted key is itself absence evidence.
      unit.host_runtime = Object.prototype.hasOwnProperty.call(event, 'host_runtime')
        ? event.host_runtime : undefined;
      unit.worker_engine = engine;
      unit.worker_mode = Object.prototype.hasOwnProperty.call(event, 'worker_mode')
        ? event.worker_mode : undefined;
      unit.dispatch_allowed = Object.prototype.hasOwnProperty.call(event, 'dispatch_allowed')
        ? event.dispatch_allowed : undefined;
      if (unit.engine_attempted.length === 1) {
        unit.route_source = event.route_source;
        unit.domain = event.domain;
        unit.tier = event.tier;
        unit.model = event.model;
      }
    } else if (event.event === 'worker-engine-fallback') {
      unit.fallback = true;
      unit.fallback_reason = event.reason;
      if (typeof event.hint === 'string' && event.hint.length > 0) unit.fallback_hint = event.hint;
    }
  }
  return [...units.values()];
}

const RUNTIME_AXES = ['host_runtime', 'worker_engine', 'worker_mode', 'dispatch_allowed'];

function runtimeCoverage(units) {
  const list = Array.isArray(units) ? units : [];
  const missing = Object.fromEntries(RUNTIME_AXES.map(axis => [axis, 0]));
  let complete = 0;
  for (const unit of list) {
    let unitComplete = true;
    for (const axis of RUNTIME_AXES) {
      // Empty strings, '-', false and every other explicit value are present.
      if (!unit || unit[axis] === undefined) {
        missing[axis] += 1;
        unitComplete = false;
      }
    }
    if (unitComplete) complete += 1;
  }
  return {
    total: list.length,
    complete,
    incomplete: list.length - complete,
    missing,
  };
}

function classifyUnit(unit) {
  const changed = unit.engine_attempted.length > 1 && unit.engine_final !== unit.engine_attempted[0];
  // D7 (tier_models + a single Claude dispatch is ordinary legacy routing, not a fallback) needs no
  // dedicated term: with neither an explicit fallback nor a chain walk, drift is already false.
  return { ...unit, changed, drift: unit.fallback || changed };
}

function configuredRoute(cwd, unit) {
  try {
    const type = typeof unit?.unit === 'string' ? unit.unit.split('/')[0] : 'execute-task';
    const route = resolveRoute({ cwd, unitType: type, tier: unit?.tier || 'standard', domain: unit?.domain });
    return { ...route, phase: mapPhase(type), label: 'prefs atuais — podem ter mudado desde o dispatch' };
  } catch (error) {
    return { error: error.message, label: 'prefs atuais — podem ter mudado desde o dispatch' };
  }
}

function auditSlice(options) {
  const cwd = path.resolve(options.cwd || process.cwd());
  // RUN_ID and milestone id are two spellings of one milestone; nothing else widens the query.
  const scope = { slice: options.slice, milestone: options.milestone, milestone_aliases: milestoneAliases(cwd, options.milestone) };
  const eventsFile = options.eventsFile || path.join(cwd, '.gsd', 'forge', 'events.jsonl');
  let events = [];
  try { events = readEvents(eventsFile); } catch { events = []; }
  const units = aggregateUnits(events, scope).map(classifyUnit);
  const task_units = units.filter(unit => unit.unit.startsWith('execute-task/'));
  const plan_units = units.filter(unit => unit.unit.startsWith('plan-slice/'));
  // The Configuração line describes the route a task took, so a plan-slice only labels it when the
  // slice has no task evidence at all.
  return { units, task_units, drift_units: units.filter(unit => unit.drift), plan_units,
    runtime_coverage: runtimeCoverage(units),
    configured_route: configuredRoute(cwd, task_units[0] || units[0]) };
}

function formatRouteMd(result) {
  const taskCount = result.task_units.length;
  const driftTasks = result.task_units.filter(unit => unit.drift).length;
  const driftPlans = result.plan_units.filter(unit => unit.drift).length;
  const lines = ['## Route', '', '_Advisory — histórico de dispatches; prefs atuais — podem ter mudado desde o dispatch._', ''];
  // Numerator and count share one denominator: the tasks sentence counts task drift only, and
  // plan-slice drift is reported on the plans line where plan units already live.
  if (result.units.length === 0) lines.push('- 0 tasks com dispatch registrado nesta slice.');
  else if (driftTasks === 0) lines.push(`- rota configurada rodou em ${taskCount}/${taskCount} tasks.`);
  else lines.push(`- rota configurada rodou em ${taskCount - driftTasks}/${taskCount} tasks; ${driftTasks} drift(s) observado(s).`);
  if (result.plan_units.length) lines.push(`- Planos: ${result.plan_units.length} unidade(s) plan-slice fora do denominador de tasks; ${driftPlans} drift(s) observado(s).`);
  // Recalculate instead of trusting result.runtime_coverage so callers that
  // construct result objects manually retain the same formatter contract.
  const coverage = runtimeCoverage(result.units);
  lines.push(`- Cobertura runtime: ${coverage.complete}/${coverage.total} completas; ${coverage.incomplete} unidade(s) incompleta(s); ausentes: host_runtime=${coverage.missing.host_runtime}, worker_engine=${coverage.missing.worker_engine}, worker_mode=${coverage.missing.worker_mode}, dispatch_allowed=${coverage.missing.dispatch_allowed}.`);
  const displayRuntime = value => value === undefined ? 'ausente' : String(value);
  for (const unit of result.units) {
    lines.push(`- Runtime ${unit.unit}: host=${displayRuntime(unit.host_runtime)}; worker=${displayRuntime(unit.worker_engine)}; mode=${displayRuntime(unit.worker_mode)}; allowed=${displayRuntime(unit.dispatch_allowed)}.`);
  }
  for (const unit of result.drift_units) {
    const attempted = unit.engine_attempted.map(engine => engine === undefined ? 'undefined' : engine).join(', ');
    const reason = unit.fallback_reason || (unit.changed ? 'engine-chain-walk' : 'unknown');
    lines.push(`- Drift ${unit.unit}: rodou \`${unit.engine_final === undefined ? 'undefined' : unit.engine_final}\`; attempted=[${attempted}]; reason=${reason}.`);
    if (unit.fallback_hint) lines.push(`  - hint: ${unit.fallback_hint}`);
  }
  const route = result.configured_route;
  if (route && !route.error) lines.push(`- Configuração (${route.label}): source=${route.source}; chain=${(route.chain || []).map(x => x.engine || x.id).join(' → ') || 'n/a'}.`);
  return `${lines.join('\n')}\n`;
}

function upsertRouteSection(summaryPath, md, cwd) {
  try {
    if (!fs.existsSync(summaryPath)) return { written: false, reason: 'target-missing' };
    const stat = fs.lstatSync(summaryPath);
    if (stat.isSymbolicLink()) return { written: false, reason: 'target-symlink' };
    const root = fs.realpathSync(path.resolve(cwd || process.cwd(), '.gsd'));
    const realParent = fs.realpathSync(path.dirname(summaryPath));
    const target = path.resolve(realParent, path.basename(summaryPath));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return { written: false, reason: 'outside-gsd' };
    // Operate on the ORIGINAL bytes: normalizing the whole file would rewrite line endings in
    // sections this tool does not own. Only the injected section is normalized, and it adopts the
    // file's own convention so a CRLF summary keeps a single, consistent style.
    const current = fs.readFileSync(summaryPath, 'utf8');
    const crlf = /\r\n/.test(current);
    const section = md.replace(/\r\n/g, '\n').replace(/\n*$/, '\n').replace(/\n/g, crlf ? '\r\n' : '\n');
    const eol = crlf ? '\r\n' : '\n';
    const header = /^## Route\r?$/m;   // \r? so a CRLF summary still matches its own heading
    let next;
    const hit = header.exec(current);
    if (hit) {
      const tail = current.slice(hit.index + hit[0].length);
      const nextHeader = /^## /m.exec(tail);
      const end = nextHeader ? hit.index + hit[0].length + nextHeader.index : current.length;
      next = current.slice(0, hit.index) + section + (nextHeader ? `${eol}${current.slice(end)}` : '');
    } else {
      const anchors = [/^## Checker Memory/m, /^## ⚠ Review Flags/m, /^## Security Flags/m, /^## Forward Intelligence/m, /^## Drill/m];
      const anchor = anchors.map(re => re.exec(current)).find(Boolean);
      next = anchor ? current.slice(0, anchor.index).replace(/[\r\n]*$/, eol + eol) + section + eol + current.slice(anchor.index)
        : current.replace(/[\r\n]*$/, eol + eol) + section;
    }
    if (next !== current) fs.writeFileSync(summaryPath, next, 'utf8');
    return { written: true, reason: null };
  } catch (error) { return { written: false, reason: error.code || error.message }; }
}

function parseArgs(argv) {
  // Keep argument parsing deliberately small: this is an advisory leaf CLI,
  // and malformed/missing options still end at the exit-zero JSON boundary.
  // `--events` exists for hermetic callers and tests; production normally
  // uses the event log rooted at the supplied workspace cwd.
  const out = { cwd: process.cwd(), json: false, eventsFile: undefined, write: undefined, slice: undefined, milestone: undefined };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--json') out.json = true;
    else if (['--slice', '--milestone', '--cwd', '--events', '--write'].includes(key) && argv[i + 1] !== undefined) {
      const value = argv[++i];
      if (key === '--events') out.eventsFile = value;
      else out[key.slice(2)] = value;
    }
  }
  return out;
}

/*
 * Output shape reference
 * ----------------------
 * units:          all scoped dispatch/fallback aggregates
 * task_units:     execute-task entries, the only denominator for N/N
 * plan_units:     plan-slice entries rendered outside that denominator
 * drift_units:    units matching explicit fallback or engine chain walk
 * runtime_coverage: additive census of complete units and missing runtime axes
 * configured_route: best-effort current resolver output, never a drift input
 *
 * Each unit's runtime axes are a last-dispatch-wins snapshot. worker_engine
 * comes only from normalized event.engine; undefined is absence, while falsy
 * recorded values are present. The formatter recomputes runtime_coverage from
 * units so hand-built legacy result objects remain supported.
 *
 * The CLI always serializes this object, including on internal exceptions.
 * Stderr is intentionally human-facing and may contain a write refusal while
 * stdout remains machine-readable JSON for forge-completer's availability
 * check. No code path writes when --write is absent.
 *
 * Replacement stops at the next level-two heading. It neither renders nor
 * normalizes neighbouring summary sections, preserving their byte content and
 * ownership boundaries. The file's own line-ending convention is detected and
 * applied to the injected section; no byte outside that section is rewritten.
 *
 * The anchor is exactly `## Route`; headings such as `## Route Notes` remain
 * unrelated user content. Repeating the same write consequently converges to
 * an identical file rather than appending a second Route section.
 */

module.exports = { normalizeEngine, inScope, milestoneAliases, aggregateUnits, runtimeCoverage, classifyUnit, auditSlice, formatRouteMd, upsertRouteSection };

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = auditSlice(args);
    if (args.write) {
      const write = upsertRouteSection(args.write, formatRouteMd(result), args.cwd);
      process.stderr.write(`${write.written ? 'route section: ' + args.write : 'route section refused: ' + write.reason}\n`);
      result.write = write;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ units: [], task_units: [], drift_units: [], plan_units: [], runtime_coverage: runtimeCoverage([]), error: error.message })}\n`);
  }
}
