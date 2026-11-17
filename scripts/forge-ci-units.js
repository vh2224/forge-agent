'use strict';

// Only this reviewed inventory may turn one file into multiple CI units.
// Direct execution of the source suite still runs its original complete set.
const path = require('node:path');
const crypto = require('node:crypto');
const DEFINITIONS = Object.freeze({
  'forge-execution-batch-process.test.js': { parts: 16, kind: 'cases' },
  'forge-execution-batch-isolation.test.js': { parts: 8, kind: 'cases' },
  'forge-native-repackage.test.js': { parts: 6, kind: 'cases' },
  'forge-native-execution.test.js': { args: [['--core-saved'], ['--extra'], ['--recovery']], divisor: 2 },
  'forge-native-recovery-delivery.test.js': { args: [['--cohort', '0'], ['--cohort', '1'], ['--cohort', '2']], divisor: 1 },
  'forge-agent-phase.test.js': { args: ['identity', 'recovery', 'native', 'sidecar'].map(name => [`--phase-cohort=${name}`]), divisor: 2 },
});
function unitsForSuite(source) {
  const definition = DEFINITIONS[source];
  if (!definition) return [{ id: source, source, args: [], divisor: 1 }];
  const count = definition.parts || definition.args.length;
  return Array.from({ length: count }, (_, index) => ({
    id: source.replace(/\.test\.js$/, `.ci-${String(index + 1).padStart(2, '0')}-of-${count}.test.js`),
    source, args: definition.kind === 'cases' ? [`--ci-cases=${index}/${count}`] : [...definition.args[index]],
    divisor: definition.divisor || count,
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
  return Object.fromEntries(units.filter(unit => unit.id !== unit.source && Object.hasOwn(row.weights_ms, unit.source))
    .map(unit => [unit.id, Math.max(1, Math.ceil(row.weights_ms[unit.source] / unit.divisor))]));
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
  const selected = cases.filter((_, position) => position % count === index);
  if (!selected.length) throw new Error('ci-case-partition-empty');
  const roster = { source: path.basename(process.argv[1] || ''), index, count,
    total: cases.length, roster_sha256: crypto.createHash('sha256').update(JSON.stringify(names)).digest('hex'),
    selected: selected.map(row => row.name) };
  process.stdout.write(`CI case partition: ${JSON.stringify(roster)}\n`);
  return selected;
}
module.exports = { DEFINITIONS, unitsForSuite, expandSuites, unitWeights, validateBaselinePair, selectCases };
