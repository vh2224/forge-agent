#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const api = require('./forge-source-manifest.js');
const root = path.resolve(__dirname, '..');
function throwsCode(fn, code) { assert.throws(fn, error => error.code === code); }
function copy(value) { return JSON.parse(JSON.stringify(value)); }
function testCatalog() { const manifest = api.readManifest(root); const audit = api.audit(manifest); assert.strictEqual(audit.ok, true); assert(audit.source_ids.includes('agents')); }
function testDeterminism() { const fixtureDir = path.join(__dirname, 'fixtures', 'source-manifest'); const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'claude-3.1.4.json'), 'utf8')); const first = api.normalize(fixture); const second = api.normalize(JSON.parse(JSON.stringify(fixture))); const golden = fs.readFileSync(path.join(fixtureDir, 'claude-3.1.4.normalized.json'), 'utf8').replace(/\r\n/g, '\n'); assert.strictEqual(first, second); assert.strictEqual(first, golden); assert(first.endsWith('\n')); }
function testRejectedCatalogs() { const manifest = api.readManifest(root); const duplicate = copy(manifest); duplicate.sources.push(copy(duplicate.sources[0])); throwsCode(() => api.audit(duplicate), api.REASON.DUPLICATE_ID); const traversal = copy(manifest); traversal.sources[0].inputs[0] = '../escape'; throwsCode(() => api.audit(traversal), api.REASON.UNSAFE_PATH); const hostRule = copy(manifest); hostRule.sources[0].common.host = 'codex'; throwsCode(() => api.audit(hostRule), api.REASON.COMMON_HOST_RULE); const omitted = copy(manifest); omitted.sources = omitted.sources.filter(source => source.source_id !== 'skills'); throwsCode(() => api.audit(omitted), api.REASON.UNCOVERED_PUBLIC_SURFACE); }
function testPlatformPaths() { assert.strictEqual(api.isSafeRelative('skills/forge-help/SKILL.md'), true); assert.strictEqual(api.isSafeRelative('skills\\forge-help\\SKILL.md'), true); assert.strictEqual(api.isSafeRelative('C:\\temp\\bad'), false); assert.strictEqual(api.isSafeRelative('/tmp/bad'), false); }
function testProcedureClosure() {
  const inventory = api.readManifest(root).sources.find(source => source.source_id === 'procedures');
  assert(inventory, 'missing canonical runtime procedure surface');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'shared/forge-procedures.json'), 'utf8'));
  for (const file of ['scripts/forge-procedure-context.js', 'shared/schemas/procedures.schema.json', 'shared/forge-procedures.json', ...manifest.modules.map(module => module.path)]) {
    assert(inventory.inputs.includes(file), `uncovered closure file ${file}`);
    assert(fs.statSync(path.join(root, file)).isFile(), file);
  }
  for (const phase of manifest.phases) {
    const loaded = require('./forge-procedure-context').loadProcedureContext({ cwd: root, forgeHome: root, phase: phase.id });
    assert(loaded.content.includes('<!-- forge-procedure:core -->'), phase.id);
    assert(loaded.modules.every(module => inventory.inputs.includes(module.path)), phase.id);
  }
  const distribution = manifest.modules.find(module => module.id === 'distribution');
  assert.equal(distribution.owner, 'T06');
  assert.equal(distribution.status, 'ready');
  assert.deepStrictEqual(manifest.phases.find(phase => phase.id === 'distribution').consumers,
    ['scripts/forge-installer.js', 'scripts/forge-codex-renderer.js', 'scripts/forge-claude-renderer.js']);
}
testCatalog(); testDeterminism(); testRejectedCatalogs(); testPlatformPaths(); testProcedureClosure(); console.log(`forge-source-manifest tests passed on ${process.platform}`);
