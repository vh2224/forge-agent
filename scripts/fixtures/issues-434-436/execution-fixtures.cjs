'use strict';
// Explicit declarations for existing positive execution scenarios. Historical
// fixture bytes stay untouched. Negative tests still pass their own declarations
// (including absent/empty bindings) directly to the actual production entry.
const fs = require('fs');
const roots = require('../../forge-code-roots');
function bindingDeclarations(request) {
  const parsed = require('../../forge-must-haves').parseMustHaves(fs.readFileSync(request.planFile, 'utf8'));
  const contract = request.execution_contract, bindings = [];
  function add(kind, index, rootIds, aspect, coverage) {
    for (const root_id of rootIds) bindings.push({ root_id, criterion: { kind, index }, aspect, coverage, source: { kind: 'verification', check_index: 0 } });
  }
  parsed.truths.forEach((_, index) => add('truth', index, contract.code_roots.map(row => row.id), 'default', 'behavioral'));
  parsed.artifacts.forEach((row, index) => add('artifact', index, [roots.resolvePath(contract, row.path, { legacy: contract.code_roots.length === 1 }).root_id], 'declared-property', 'structural'));
  parsed.key_links.forEach((row, index) => add('key_link', index, [...new Set([row.from, row.to].map(file => roots.resolvePath(contract, file, { legacy: contract.code_roots.length === 1 }).root_id))], 'declared-link', 'behavioral'));
  return bindings;
}
function declareBindings(request) {
  if (request.unitType === 'execute-task' && request.execution_contract && request.planFile
      && !Object.hasOwn(request.verification || {}, 'bindings')) {
    request.verification = { ...request.verification, bindings: bindingDeclarations(request) };
  }
  return request;
}
function createFixtureHarness(...args) {
  const original = require('../forge-native-execution').createFixtureHarness(...args);
  return { ...original,
    setup(...options) { const f = original.setup(...options); declareBindings(f.r); return f; },
    nativeFixture(...options) { const f = original.nativeFixture(...options); declareBindings(f.r); return f; },
  };
}
module.exports = { bindingDeclarations, declareBindings, createFixtureHarness };
