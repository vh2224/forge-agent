#!/usr/bin/env node
'use strict';

// Fixtures only: never read a real account, run a real provider, or touch WDMA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-diagnostic-'));
const accounts = require('./forge-accounts');
const originalLookup = accounts.resolveLaunch;
const token = 'fixture-secret-never-log';
accounts.resolveLaunch = () => ({ name: 'fixture', token });
const claude = require('./forge-claude-sidecar');
const unit = require('./forge-unit-sidecar');
const { diagnostic } = require('./forge-sidecar-diagnostic');
const { resolveDispatch } = require('./forge-dispatch-resolve');
const oldBin = process.env.FORGE_XLLM_CLAUDE_BIN;
const provider = path.join(root, 'provider.js');
fs.writeFileSync(provider, `
const fs = require('fs');
fs.appendFileSync('calls.txt', 'call\\n');
const args = process.argv.slice(2);
const instruction = args[args.indexOf('-p') + 1];
const prefix = 'Read the complete task prompt from this UTF-8 file: ';
const suffix = '. Follow it exactly and finish with its required worker-result block.';
const prompt = fs.readFileSync(JSON.parse(instruction.slice(prefix.length, -suffix.length)), 'utf8');
fs.writeFileSync('observed-prompt.txt', prompt);
const output = fs.readFileSync('output.txt');
if (fs.existsSync('stderr.txt')) process.stderr.write(fs.readFileSync('stderr.txt'));
process.stdout.write(output);
`);
process.env.FORGE_XLLM_CLAUDE_BIN = provider;
after(() => {
  accounts.resolveLaunch = originalLookup;
  if (oldBin === undefined) delete process.env.FORGE_XLLM_CLAUDE_BIN;
  else process.env.FORGE_XLLM_CLAUDE_BIN = oldBin;
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});
const requiredPath = '.gsd/milestones/M001/M001-RESEARCH.md';
const optionalPath = '.gsd/CODING-STANDARDS.md';
const allowed = [requiredPath, optionalPath];
const required = [requiredPath];
function payload() { return { status: 'done', summary: 'Research complete', questions: [],
  artifacts: [{ path: requiredPath, content: '# Pesquisa Ω\r\n\n```json\n{"á":"ação"}\n```\nLiteral ---GSD-WORKER-RESULT--- and ---END-RESULT---.' }] }; }
function block(value = payload(), pretty = false, status = value.status) {
  return `---GSD-WORKER-RESULT---\nstatus: ${status}\nresult_json: ${JSON.stringify(value, null, pretty ? 2 : undefined)}\n---END-RESULT---`;
}
const validate = value => unit.inspectArtifacts(value, allowed, required, unit.MAX_ARTIFACT_PAYLOAD_BYTES);
function rejected(text, reason, validator = validate) {
  assert.throws(() => claude.parseExecuteCandidate(text, validator), error => {
    assert.equal(error.code, 'claude-invalid-result');
    assert.equal(error.diagnostic.reason, reason);
    assert(!JSON.stringify(error).includes('private-sentinel'));
    return true;
  });
}
let sequence = 0;
function request(output) {
  const cwd = path.join(root, `workspace-${++sequence}`);
  fs.mkdirSync(path.join(cwd, '.gsd/milestones/M001'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.gsd/PROJECT.md'), '# Fixture project');
  fs.writeFileSync(path.join(cwd, '.gsd/milestones/M001/M001-CONTEXT.md'), '# Fixture context');
  fs.writeFileSync(path.join(cwd, '.gsd/forge-prefs.jsonc'), JSON.stringify({
    tier_models: { light: 'claude-sonnet-5', standard: 'claude-sonnet-5', heavy: 'claude-opus-5', max: 'claude-fable-5' },
  }));
  fs.writeFileSync(path.join(cwd, 'output.txt'), output);
  return { cwd, unitType: 'research-milestone', milestoneId: 'M001', description: 'Fixture research',
    route: resolveDispatch({ cwd, unitType: 'research-milestone', hostRuntime: 'codex' }),
    workflowId: `workflow-${sequence}`, dispatchId: `dispatch-${sequence}`,
    resultFile: path.join(root, `result-${sequence}.json`),
    constraints: { auto_commit: false, deploy: false } };
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

test('compact/multiline JSON carries Markdown, literal markers, Unicode and CRLF intact', () => {
  for (const pretty of [true, false]) {
    const parsed = claude.parseExecuteCandidate(block(payload(), pretty).replace(/\n/g, '\r\n'), validate);
    assert.deepEqual(parsed.candidate, payload());
    assert.deepEqual(parsed.classification, { marker_count: 1 });
  }
});
test('last framed block wins; an invalid last block cannot recover an earlier success', () => {
  const partial = { ...payload(), status: 'partial', questions: ['Need a decision'] };
  assert.equal(claude.parseExecuteCandidate(block() + '\n' + block(partial), validate).candidate.status, 'partial');
  rejected(block() + '\n---GSD-WORKER-RESULT---\nstatus: done', 'end-marker-missing');
});
test('envelope and JSON failures have distinct safe reasons', () => {
  for (const [text, reason] of [
    ['', 'output-empty'], ['private-sentinel', 'marker-missing'],
    ['---GSD-WORKER-RESULT---\n---END-RESULT---', 'status-missing'],
    [block().replace('status: done', 'status: wat'), 'status-invalid'],
    [block().replace(/result_json:.*\n/, ''), 'result-json-missing'],
    [block().replace(/result_json:.*\n/, 'result_json: {"private-sentinel":\n'), 'json-invalid'],
    [block().replace(/\n---END-RESULT---$/, ''), 'end-marker-missing'],
    [block().replace('status: done', 'status: partial'), 'status-mismatch'],
    [block().replace(/result_json:.*\n/, 'result_json: null\n'), 'schema-invalid'],
    [block().replace(/result_json:.*\n/, 'result_json: {} {}\n'), 'json-invalid'],
    [block().replace('result_json:', 'status: blocked\nresult_json:'), 'result-json-missing'],
  ]) rejected(text, reason);
  rejected(block(), 'validator-failed', () => { throw Error('private-sentinel'); });
  rejected(block(), 'adapter-failed', () => ({ ok: false, reason: 'private-sentinel' }));
  rejected(block(), 'schema-invalid', () => false);
});
test('artifact diagnostics identify schema, paths, duplicates, missing artifacts, questions and limits', () => {
  const cases = [
    [{ ...payload(), extra: 'private-sentinel' }, 'schema-invalid'],
    [{ ...payload(), artifacts: [{ path: '../private-sentinel', content: 'x' }] }, 'artifact-path-invalid'],
    [{ ...payload(), artifacts: [payload().artifacts[0], payload().artifacts[0]] }, 'artifact-duplicate'],
    [{ ...payload(), artifacts: [] }, 'artifact-missing'],
    [{ ...payload(), questions: ['private-sentinel'] }, 'questions-on-done'],
    [{ ...payload(), artifacts: Array(33).fill(payload().artifacts[0]) }, 'artifact-limit'],
    [{ ...payload(), artifacts: [{ path: requiredPath, content: 'á'.repeat(unit.MAX_ARTIFACT_BYTES / 2 + 1) }] }, 'artifact-limit'],
    [{ ...payload(), summary: 'x'.repeat(unit.MAX_ARTIFACT_PAYLOAD_BYTES) }, 'payload-limit'],
    [{ ...payload(), artifacts: [{ path: requiredPath, content: '   ' }] }, 'schema-invalid'],
  ];
  for (const [value, reason] of cases) {
    assert.equal(validate(value).reason, reason);
    assert.equal(unit.validateArtifacts(value, allowed, required, unit.MAX_ARTIFACT_PAYLOAD_BYTES), false);
    rejected(block(value), reason);
  }
  // The Claude stream budget must not silently restrict the Codex transport.
  assert.equal(unit.validateArtifacts({ ...payload(), summary: 'x'.repeat(unit.MAX_ARTIFACT_PAYLOAD_BYTES) }, allowed, required), true);
});
test('safe diagnostic is a closed vocabulary with numeric metadata only', () => {
  assert.deepEqual(diagnostic('private-sentinel', { stdout_bytes: 3, stderr_bytes: 'private-sentinel',
    duration_ms: -1, tail: 'private-sentinel', marker_count: Infinity }),
  { version: 1, stage: 'adapter', reason: 'adapter-failed', stdout_bytes: 3 });
});
test('real rendered research prompt, simulated provider, publication and replay use one invocation', async () => {
  const p = payload();
  p.artifacts.push({ path: optionalPath, content: '# Standards' });
  const r = request(block(p, true));
  const result = await unit.runUnitSidecar(r);
  assert.equal(result.status, 'done');
  const prompt = fs.readFileSync(path.join(r.cwd, 'observed-prompt.txt'), 'utf8');
  for (const text of ['Research codebase', 'Sidecar delivery contract', requiredPath,
    '921600', '524288', 'compact or multiline', 'auto_commit', `effort: ${r.route.effort}`]) assert(prompt.includes(text), text);
  for (const artifact of p.artifacts) assert.equal(fs.readFileSync(path.join(r.cwd, artifact.path), 'utf8'), artifact.content);
  fs.unlinkSync(path.join(r.cwd, requiredPath));
  await unit.runUnitSidecar(r);
  assert.equal(fs.readFileSync(path.join(r.cwd, 'calls.txt'), 'utf8'), 'call\n');
  assert.equal(readJson(r.resultFile + '.receipt.json').phase, 'ready');
});
test('each rejection persists sanitized diagnostics in result, receipt and event; replay never calls provider', async () => {
  for (const [output, reason] of [
    ['private-sentinel', 'marker-missing'],
    [block().replace('status: done', 'status: partial'), 'status-mismatch'],
    [block({ ...payload(), artifacts: [] }), 'artifact-missing'],
    [block({ ...payload(), artifacts: [{ path: '../private-sentinel', content: 'x' }] }), 'artifact-path-invalid'],
    [block({ ...payload(), summary: token }), 'secret-output'],
    [block().replace('Research complete', token.replace('f', '\\u0066')), 'secret-output'],
    ['x'.repeat(1024 * 1024 + 10), 'output-limit'],
  ]) {
    const r = request(output);
    const code = reason === 'output-limit' ? 'claude-output-limit' : 'claude-invalid-result';
    await assert.rejects(unit.runUnitSidecar(r), e => e.code === code);
    const failure = readJson(r.resultFile);
    const receipt = readJson(r.resultFile + '.receipt.json');
    const events = fs.readFileSync(path.join(r.cwd, '.gsd/forge/events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(failure.diagnostic.reason, reason);
    assert.equal(failure.recovery, 'operator-required');
    assert(Number.isSafeInteger(failure.diagnostic.duration_ms));
    assert.deepEqual(receipt.failure.diagnostic, failure.diagnostic);
    assert.deepEqual(events.at(-1).diagnostic, failure.diagnostic);
    const logs = JSON.stringify([failure, receipt, events]);
    for (const secret of [token, 'private-sentinel', r.cwd]) assert(!logs.includes(secret));
    assert(!fs.existsSync(path.join(r.cwd, requiredPath)));
    await assert.rejects(unit.runUnitSidecar(r), e => e.code === code);
    assert.equal(fs.readFileSync(path.join(r.cwd, 'calls.txt'), 'utf8'), 'call\n');
  }
});
test('stderr token on successful exit is refused without persisting output', async () => {
  const r = request(block());
  fs.writeFileSync(path.join(r.cwd, 'stderr.txt'), token);
  await assert.rejects(unit.runUnitSidecar(r), e => e.diagnostic.reason === 'secret-output');
  assert(!fs.readFileSync(r.resultFile, 'utf8').includes(token));
});
test('partial/blocked worker outcomes are preserved and not classified as adapter failures', async () => {
  for (const status of ['partial', 'blocked']) {
    const r = request(block({ ...payload(), status, questions: ['Human decision needed'] }));
    assert.equal((await unit.runUnitSidecar(r)).status, status);
    assert(!fs.existsSync(path.join(r.cwd, requiredPath)));
    assert.equal(readJson(r.resultFile + '.receipt.json').phase, 'ready');
  }
});
test('interrupted publication preserves validated receipt and resumes without another provider turn', async () => {
  const p = payload();
  p.artifacts.push({ path: optionalPath, content: '# Standards' });
  const r = request(block(p));
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(r.cwd, optionalPath)) { const error = Error('private-sentinel'); error.code = 'EACCES'; throw error; }
    return originalRename(from, to);
  };
  try { await assert.rejects(unit.runUnitSidecar(r), e => e.code === 'EACCES'); }
  finally { fs.renameSync = originalRename; }
  assert.equal(readJson(r.resultFile + '.receipt.json').phase, 'ready');
  assert.equal(readJson(r.resultFile).diagnostic.reason, 'publication-failed');
  assert.equal(readJson(r.resultFile).recovery, 'replay-publication');
  assert(fs.existsSync(path.join(r.cwd, requiredPath)));
  assert(!fs.existsSync(path.join(r.cwd, optionalPath)));
  await unit.runUnitSidecar(r);
  assert.equal(fs.readFileSync(path.join(r.cwd, optionalPath), 'utf8'), '# Standards');
  assert.equal(fs.readFileSync(path.join(r.cwd, 'calls.txt'), 'utf8'), 'call\n');
  fs.writeFileSync(path.join(r.cwd, optionalPath), 'concurrent edit');
  await assert.rejects(unit.runUnitSidecar(r), e => e.code === 'artifact-conflict');
  assert.equal(fs.readFileSync(path.join(r.cwd, optionalPath), 'utf8'), 'concurrent edit');
  assert.equal(readJson(r.resultFile).diagnostic.reason, 'publication-failed');
  assert.equal(readJson(r.resultFile + '.receipt.json').phase, 'ready');
  assert.equal(fs.readFileSync(path.join(r.cwd, 'calls.txt'), 'utf8'), 'call\n');
});
