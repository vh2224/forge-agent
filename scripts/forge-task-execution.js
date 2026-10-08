'use strict';

// Standalone execution is a writing contract, not a preparation phase. The
// owner supplies gate decisions; this module does not select work or grant them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ids = require('./forge-ids');
const parallel = require('./forge-parallelism');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fail(code) { throw Object.assign(new Error(code), { code }); }

function locations(r) {
  if (r.scope !== 'standalone-task' || r.phase !== 'execute' || r.unitType !== 'execute-task') fail('execution-phase-unit-mismatch');
  if (r.milestoneId !== undefined || r.sliceId !== undefined) fail('standalone-task-scope-invalid');
  if (!ids.isValid(r.taskId) || ids.entityKind(r.taskId) !== 'task') fail('invalid-task');
  const task = `.gsd/tasks/${r.taskId}`, prefix = `${task}/${r.taskId}`;
  const unit = { type: 'task', id: r.taskId };
  const delivery = { input: `${prefix}-DELIVERY-INPUT.json`, output: `${prefix}-DELIVERY.json`,
    verification: `${prefix}-VERIFY-ENVELOPE.json`, artifact: `${prefix}-ARTIFACT-ENVELOPE.json` };
  const required = [`${prefix}-SUMMARY.md`, delivery.input, delivery.output];
  return { task, milestone: null, slice: null, execution: true, delivery, required,
    allowed: [...required, delivery.verification, delivery.artifact], rules: {
      [delivery.input]: { kind: 'input', unit }, [delivery.output]: { kind: 'delivery', unit },
      [delivery.verification]: { kind: 'verification', unit }, [delivery.artifact]: { kind: 'artifact', unit },
    } };
}
function relative(root, file) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) fail('execution-path-outside-scope');
  return rel;
}
function physical(root, file) {
  const rel = relative(root, path.resolve(file));
  let current = root;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) fail('execution-path-link');
  }
  return file;
}
function read(file) { return fs.readFileSync(file, 'utf8'); }
function prepare(r, root, cwd) {
  const loc = locations(r);
  if (r.writableRoots?.length) fail('standalone-execution-multiple-code-roots');
  const planFile = path.join(root, loc.task, `${r.taskId}-PLAN.md`);
  physical(root, planFile);
  if (!r.planFile || path.resolve(r.planFile) !== planFile) fail('execution-plan-path-mismatch');
  const plan = read(planFile);
  // Preserve the existing plan gate's off/skip policy, but require the caller to
  // carry that actual decision. An approved marker never causes a new question.
  const gateFile = path.join(root, loc.task, `${r.taskId}-PLAN-GATE.md`);
  physical(root, gateFile);
  const gate = fs.existsSync(gateFile) ? read(gateFile) : '';
  if (!/^status:\s*approved\s*$/m.test(gate)
      && !(r.gates?.plan === 'skipped' && r.gates?.planSkipReason === 'interactive-off')) fail('execution-plan-gate-required');
  const approvedHash = gate.match(/^plan_sha256:\s*([a-f0-9]{64})\s*$/m)?.[1];
  if (approvedHash && approvedHash !== hash(plan)) fail('execution-plan-gate-stale');
  if (r.gates?.claim !== 'proceed' || !['passed', 'not-applicable'].includes(r.gates?.security)) fail('execution-gates-required');
  if (!r.constraints || typeof r.constraints.auto_commit !== 'boolean' || r.constraints.deploy !== false) fail('execution-constraints-required');
  const writes = parallel.parseTaskFrontmatter(planFile)?.writes;
  if (!Array.isArray(writes)) fail('execution-writes-required');
  const claims = writes.map(value => {
    if (typeof value !== 'string' || !value.trim() || value.replace(/\\/g, '/').split('/').includes('..') || /[\[\]{}!]/.test(value)) fail('execution-claim-invalid');
    const file = path.resolve(cwd, value);
    const rel = relative(cwd, file);
    if (rel.split('/').some(p => ['.gsd', '.git', '.svn'].includes(p))) fail('execution-claim-protected');
    physical(cwd, file);
    return rel;
  });
  const context = [];
  const inputs = { [planFile]: hash(plan), ...(gate ? { [gateFile]: hash(gate) } : {}) };
  for (const suffix of ['BRAINSTORM', 'CONTEXT', 'RESEARCH']) {
    const file = physical(root, path.join(root, loc.task, `${r.taskId}-${suffix}.md`));
    if (fs.existsSync(file)) { const text = read(file); inputs[file] = hash(text); context.push(`## ${suffix}\n${text}`); }
  }
  if (r.contextFile) {
    const file = physical(path.join(root, loc.task), path.resolve(r.contextFile));
    const text = read(file); inputs[file] = hash(text); context.push(text);
  }
  const securityFile = path.join(root, loc.task, `${r.taskId}-SECURITY.md`);
  if (r.securityFile && path.resolve(r.securityFile) !== securityFile) fail('execution-security-path-mismatch');
  physical(root, securityFile);
  const securityText = fs.existsSync(securityFile) ? read(securityFile) : '';
  if (r.gates.security === 'passed' && !securityText.trim()) fail('execution-security-required');
  if (securityText) inputs[securityFile] = hash(securityText);
  const prefs = require('./forge-prefs').readPrefs(root);
  if (!prefs.ok) fail('execution-prefs-invalid');
  const standardsTokens = prefs.prefs?.token_budget?.coding_standards ?? 3000;
  if (!Number.isFinite(standardsTokens) || standardsTokens < 0) fail('execution-budget-invalid');
  const standardsFile = physical(root, path.join(root, '.gsd/CODING-STANDARDS.md'));
  if (fs.existsSync(standardsFile)) {
    const text = read(standardsFile); inputs[standardsFile] = hash(text);
    context.push(require('./forge-prompt')._private.truncateChars(text, Math.floor(standardsTokens * 4), { source: standardsFile }));
    context.push(`Full coding standards: ${standardsFile}`);
  }
  context.unshift(`CODE_DIR: ${cwd}\nARTIFACT_OWNER: ${root}\nClaimed paths (only writes allowed): ${JSON.stringify(claims)}`);
  return { claims, inputs, contextText: context.join('\n\n'), securityText,
    budgets: { coding_standards: standardsTokens }, plan_hash: hash(plan) };
}

// Bounded content census of the owner's control tree, including ignored files.
// Exclude only the event stream written by this adapter. No provider output or
// source content is stored here. Symlink coverage is refused, never assumed.
function protectedSnapshot(root) {
  const result = {}; let entries = 0, bytes = 0;
  function visit(file, rel) {
    if (!fs.existsSync(file)) return;
    if (++entries > 20000) fail('execution-protected-snapshot-limit');
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) fail('execution-path-link');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), `${rel}/${name}`);
    } else {
      if (!stat.isFile()) fail('execution-protected-file-type');
      if (rel === '.gsd/forge/events.jsonl') return;
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024) fail('execution-protected-snapshot-limit');
      result[rel] = hash(fs.readFileSync(file));
    }
  }
  visit(path.join(root, '.gsd'), '.gsd');
  return result;
}
function assertProtected(root, before) {
  if (JSON.stringify(protectedSnapshot(root)) !== JSON.stringify(before)) fail('execution-protected-metadata');
}
function verifyResult(cwd, prepared, result) {
  const files = {};
  for (const entry of result.files_changed || []) {
    const rel = typeof entry === 'string' ? entry : entry.path;
    if (!rel || !prepared.claims.some(claim => parallel.claimPathMatches(claim, rel))) fail('execution-outside-claim');
    const file = physical(cwd, path.resolve(cwd, rel));
    files[rel] = fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
  }
  return files;
}
function assertReplay(r, record) {
  for (const [file, expected] of Object.entries(record.execution.inputs)) {
    if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== expected) fail('execution-input-changed');
  }
  for (const [rel, expected] of Object.entries(record.execution.verified_files)) {
    const file = physical(fs.realpathSync(r.cwd), path.resolve(r.cwd, rel));
    const current = fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
    if (current !== expected) fail('execution-replay-code-changed');
  }
  if (JSON.stringify(replayState(r.cwd)) !== JSON.stringify(record.execution.code_state)) fail('execution-replay-baseline-changed');
}
function replayState(cwd) {
  const state = require('./forge-surgical-reset').captureAttemptSnapshot(cwd);
  return { start_sha: state.start_sha, pre_dirty: state.pre_dirty, vcs: state.vcs };
}
module.exports = { locations, prepare, protectedSnapshot, assertProtected, verifyResult, assertReplay, replayState };
