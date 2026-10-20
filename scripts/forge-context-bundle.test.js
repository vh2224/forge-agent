#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeFragment } = require('./forge-memory.js');
const { buildContextBundle, buildContextBundleResult } = require('./forge-context-bundle.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-context-bundle-'));
const cli = path.join(__dirname, 'forge-context-bundle.js');
let count = 0;
function test(name, fn) { fn(); count++; console.log(`ok ${count} - ${name}`); }
function run(args) { return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', shell: false }); }
try {
  fs.mkdirSync(path.join(root, '.gsd'));
  fs.writeFileSync(path.join(root, '.gsd/CODING-STANDARDS.md'), '## Lint & Format Commands\nMANDATORY_LINT\n## Other\nignore');
  const decisions = path.join(root, 'slice.md');
  fs.writeFileSync(decisions, '## Decisions\nMANDATORY_DECISION\n## Other\nignore');
  writeFragment(root, { unit_id: 'T01', facts: [{ mem_id: 'MEM001', category: 'gotcha', text: 'ultraviolet fixture sentinel', source_unit: 'execute-task/T01' }], stats: [] });
  const opts = { cwd: root, sliceContext: decisions, query: 'ultraviolet' };
  test('compatibility string builder equals structured result with unique memory', () => {
    const r = buildContextBundleResult(opts);
    assert.equal(buildContextBundle(opts), r.markdown);
    assert.equal((r.markdown.match(/## Project Memory/g) || []).length, 1);
    assert(r.markdown.indexOf('MANDATORY_LINT') < r.markdown.indexOf('MANDATORY_DECISION'));
    assert.equal(r.selection.status, 'selected');
    assert(!JSON.stringify(r.selection).includes('fixture sentinel'));
  });
  test('budget applies only to optional memory and owner is independent of code cwd', () => {
    const r = buildContextBundleResult({ ...opts, cwd: path.dirname(root), owner: root, maxTokens: 0 });
    assert(r.markdown.includes('MANDATORY_LINT')); assert(r.markdown.includes('MANDATORY_DECISION'));
    assert(!r.markdown.includes('fixture sentinel')); assert.equal(r.selection.status, 'disabled');
  });
  test('missing query has explicit deterministic empty fallback', () => {
    assert.equal(buildContextBundleResult({ cwd: root }).selection.reason, 'no-query');
    assert(!buildContextBundle({ cwd: root }).includes('fixture sentinel'));
  });
  test('optional failure does not remove other sections or swallow config errors', () => {
    const r = buildContextBundleResult({ ...opts, memoryProvider: () => { throw new Error('private'); } });
    assert(r.markdown.includes('MANDATORY_LINT')); assert.equal(r.selection.status, 'optional-error');
    assert.throws(() => buildContextBundleResult({ ...opts, maxTokens: -1 }));
    assert.throws(() => buildContextBundleResult({ ...opts, maxTokens: null }));
  });
  const out = path.join(root, 'out.md'); const report = path.join(root, 'report.json');
  test('CLI query file and IDs are data; optional report contains no query/full fact/path', () => {
    const queryFile = path.join(root, 'query.txt');
    fs.writeFileSync(queryFile, 'ultraviolet fixture $(do-not-execute) `literal` "quoted"');
    const p = run(['--cwd', root, '--slice-context', decisions, '--out', out, '--query-file', queryFile, '--selection-report', report,
      '--unit-type', 'execute-task', '--task-id', 'T02', '--limit', '1', '--max-tokens', '200']);
    assert.equal(p.status, 0, p.stderr); assert(fs.readFileSync(out, 'utf8').includes('fixture sentinel'));
    const r = JSON.parse(fs.readFileSync(report)); assert.equal(r.unit.taskId, 'T02');
    assert(!JSON.stringify(r).includes('do-not-execute')); assert(!JSON.stringify(r).includes(root));
  });
  test('CLI inline quoted query and zero limit preserve compatibility flags', () => {
    const p = run(['--cwd', root, '--out', out, '--query', 'ultraviolet "literal"', '--limit', '0']);
    assert.equal(p.status, 0, p.stderr); assert(!fs.readFileSync(out, 'utf8').includes('fixture sentinel'));
  });
  test('invalid query read/config/argument fail without exposing private path', () => {
    for (const args of [['--query-file', path.join(root, 'missing')], ['--max-tokens', '-1'], ['--query', 'a', '--query-file', 'b'], ['--unknown', 'x'], ['--query']]) {
      const p = run(['--cwd', root, '--out', out, ...args]);
      assert.equal(p.status, 2); assert(!p.stderr.includes(root));
    }
  });
  test('project-local JavaScript never executes when selecting context', () => {
    fs.mkdirSync(path.join(root, 'scripts')); fs.writeFileSync(path.join(root, 'scripts/forge-memory.js'), 'throw new Error("PROJECT_EXECUTED")');
    assert.equal(buildContextBundleResult(opts).selection.status, 'selected');
  });
  console.log(`${count} bundle contract tests passed`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
