'use strict';

// Only this reviewed inventory may turn one file into multiple CI units.
// Direct execution of the source suite still runs its original complete set.
const path = require('node:path');
const crypto = require('node:crypto');
const DEFINITIONS = Object.freeze({
  'forge-issues-434-436.test.js': { parts: 10, kind: 'cases', revision: 'recovery-v1' },
  'forge-issues-429-432.test.js': { parts: 14, kind: 'cases', revision: 'owner-v1' },
  'forge-issues-420-424.test.js': { parts: 17, kind: 'cases', revision: 'delivery-v2' },
  'forge-execution-batch-process.test.js': { parts: 16, kind: 'cases', revision: 'restart-v2', costDivisors: {0:5,5:4} },
  'forge-execution-batch-isolation.test.js': { parts: 8, kind: 'cases' },
  'forge-native-repackage.test.js': { parts: 6, kind: 'cases' },
  'forge-native-execution.test.js': { args: [['--core'], ['--saved'], ['--extra'], ['--recovery']], revision:'native-v2',
    costDivisors:{0:2,1:2,2:4,3:1}, timingEstimates:[['forge-native-execution.ci-01-of-3.test.js',2],['forge-native-execution.ci-01-of-3.test.js',2],['forge-native-execution.ci-02-of-3.test.js',1],['forge-native-execution.ci-03-of-3.test.js',1]] },
  'forge-dispatch-source-guard.test.js': { args: [['--sourceguard-core'], ...Array.from({length:8},(_,i)=>['--sourceguard-negative='+i+'/8'])], revision: 'guard-v1', divisor: 1 },
  'forge-native-host-bridge.test.js': { args: [['--bridge-cohort', 'full'], ['--bridge-cohort', 'partial']], revision: 'host-v1', divisor: 1 },
  'forge-native-recovery-delivery.test.js': { args: [['--cohort', '0'], ['--cohort', '1'], ['--cohort', '2']], divisor: 1 },
  'forge-agent-phase.test.js': { args: ['identity', 'recovery', 'native', 'sidecar'].map(name => [`--phase-cohort=${name}`]), divisor: 2 },
  'forge-communication-surfaces.test.js': { parts: 4, kind: 'cases' },
  'forge-linked-task-start.test.js': { args: [['--lts-cohort=core'], ['--lts-cohort=regressions'], ['--lts-cohort=closures']], revision:'linked-v2', costDivisors: {0:1,1:3,2:4},
    timingEstimates:[['forge-linked-task-start.ci-01-of-2.test.js',1],['forge-linked-task-start.ci-02-of-2.test.js',1],['forge-linked-task-start.ci-01-of-2.test.js',4]] },
});
// Explicit initial estimates, not observations of this new wrapper. The prior
// smoke steps in run44163993587 took56s on Linux and153s on macOS.
const INITIAL_COSTS = Object.freeze({
  // Planning estimate for each new independent core/negative cohort, NOT hosted timing.
  // Actual whole Sourceguard r5 passed31 cases in1409454ms; immutable old profile
  // describes the whole source, not these9 units. Current measured unit weights win.
  'forge-dispatch-source-guard.test.js': Object.freeze({linux:750000,darwin:750000,win32:750000}),
  // Planning estimate per full/partial cohort, NOT hosted timing. The first
  // unpartitioned local case failed after 558844ms (native463-bridge-r6-causal);
  // 750000ms reserves ~34% over that incomplete run on every platform. Actual
  // completion costs remain unknown; current measured unit timings still win.
  'forge-native-host-bridge.test.js': Object.freeze({ linux: 750000, darwin: 750000, win32: 750000 }),
  // Initial estimate, not a hosted timing or a rewrite of the published profile.
  'forge-issues-434-436.test.js': Object.freeze({ linux: 30000, darwin: 30000, win32: 30000 }),
  'forge-issues-429-432.test.js': Object.freeze({ linux: 30000, darwin: 30000, win32: 30000 }),
  'forge-ci-smoke.test.js': Object.freeze({ linux: 60000, darwin: 180000, win32: 1 }),
  // Conservative planning estimate for each new independent fixture, not a
  // hosted measurement. A measured current unit always wins in planShards.
  'forge-issues-420-424.test.js': Object.freeze({ linux: 30000, darwin: 30000, win32: 30000 }),
});
function unitsForSuite(source) {
  const definition = DEFINITIONS[source];
  if (!definition) return [{ id: source, source, args: [], divisor: 1 }];
  const count = definition.parts || definition.args.length;
  return Array.from({ length: count }, (_, index) => ({
    id: source.replace(/\.test\.js$/, `.ci-${definition.revision ? definition.revision + '-' : ''}${String(index + 1).padStart(2, '0')}-of-${count}.test.js`),
    source, args: definition.kind === 'cases' ? [`--ci-cases=${index}/${count}`] : [...definition.args[index]],
    divisor: definition.costDivisors?.[index] || definition.divisor || count,
    ...(definition.timingEstimates?.[index]?{timingEstimate:definition.timingEstimates[index]}:{}),
  }));
}
function expandSuites(suites) {
  const units = suites.flatMap(unitsForSuite);
  if (new Set(units.map(row => row.id)).size !== units.length) throw new Error('ci-unit-collision');
  return units;
}
function unitWeights(units, profile, platform) {
  const row = profile && profile.state === 'loaded' && profile.doc.platforms[platform];
  if (!row || row.status !== 'observed') return {};
  const weights = Object.fromEntries(units.filter(unit => unit.id !== unit.source && Object.hasOwn(row.weights_ms, unit.source))
    .map(unit => [unit.id, Math.max(1, Math.ceil(row.weights_ms[unit.source] / unit.divisor))]));
  for(const unit of units)if(unit.timingEstimate && Object.hasOwn(row.weights_ms,unit.timingEstimate[0]))
    weights[unit.id]=Math.max(1,Math.ceil(row.weights_ms[unit.timingEstimate[0]]/unit.timingEstimate[1]));
  for (const unit of units) if (INITIAL_COSTS[unit.source]?.[platform] && !Object.hasOwn(row.weights_ms, unit.id)) weights[unit.id] = INITIAL_COSTS[unit.source][platform];
  return weights;
}
// Whole-source and CI-unit baselines have different universes. Keep each
// explicit and human-versioned, and refuse drift between their source sets.
function validateBaselinePair({ sourceSuites, sourceText, unitText, platform, resolveBaseline }) {
  const units = expandSuites(sourceSuites), byId = new Map(units.map(unit => [unit.id,unit.source]));
  const sources = resolveBaseline({text:sourceText, platform, availableSuites:sourceSuites});
  const parts = resolveBaseline({text:unitText, platform, availableSuites:units.map(unit=>unit.id)});
  if (!sources.ok || !parts.ok) return {ok:false,errors:[...(sources.errors||[]),...(parts.errors||[])]};
  const sourceItems = new Map(sources.entries.map(entry=>[entry.suite,entry.item]));
  const projected = new Set(parts.entries.map(entry=>byId.get(entry.suite)));
  const errors = [];
  if (projected.size !== sourceItems.size || [...sourceItems.keys()].some(source=>!projected.has(source))) errors.push('source-and-unit-baseline-mismatch');
  if (parts.entries.some(entry=>sourceItems.get(byId.get(entry.suite))!==entry.item)) errors.push('source-and-unit-baseline-issue-mismatch');
  return {ok:errors.length===0,errors};
}
// The same complete roster is registered in every process before selection.
// No case may depend on a case that was run in another process.
function selectCases(cases, argv = process.argv.slice(2)) {
  const flags = argv.filter(arg => arg.startsWith('--ci-cases'));
  if (!flags.length) return cases;
  if (flags.length !== 1) throw new Error('ci-case-selector-duplicate');
  const match = /^--ci-cases=(0|[1-9]\d*)\/([1-9]\d*)$/.exec(flags[0]);
  if (!match) throw new Error('ci-case-selector-invalid');
  const index = Number(match[1]), count = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index >= count || count > 64) throw new Error('ci-case-selector-invalid');
  const names = cases.map(row => row.name);
  if (names.some(name => typeof name !== 'string' || !name) || new Set(names).size !== names.length) throw new Error('ci-case-roster-invalid');
  const keys = cases.map(row => row.group === undefined ? row.name : row.group);
  if (keys.some(key => typeof key !== 'string' || !key)) throw new Error('ci-case-group-invalid');
  const groups = [...new Set(keys)], groupIndex = new Map(groups.map((key, position) => [key, position]));
  const selected = cases.filter((_, position) => groupIndex.get(keys[position]) % count === index);
  if (!selected.length) throw new Error('ci-case-partition-empty');
  const roster = { source: path.basename(process.argv[1] || ''), index, count,
    total: cases.length, total_groups: groups.length, roster_sha256: crypto.createHash('sha256').update(JSON.stringify(cases.map((row,i)=>({name:row.name,group:keys[i]})))).digest('hex'),
    selected: selected.map(row => row.name) };
  process.stdout.write(`CI case partition: ${JSON.stringify(roster)}\n`);
  return selected;
}
module.exports = { DEFINITIONS, unitsForSuite, expandSuites, unitWeights, validateBaselinePair, selectCases };
