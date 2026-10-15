'use strict';

// Standalone execution is a writing contract, not a preparation phase. The
// owner supplies gate decisions; this module does not select work or grant them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ids = require('./forge-ids');
const parallel = require('./forge-parallelism');
const roots = require('./forge-code-roots');
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
  const rootSources = (r.execution_contract?.code_roots || []).flatMap(root => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(root.id)) fail('root-id-invalid');
    return ['verification', 'artifact'].map(kind => ({ path: `${prefix}-${kind.toUpperCase()}-${root.id}-ENVELOPE.json`, kind, root_id: root.id }));
  });
  delivery.rootSources = rootSources;
  return { task, milestone: null, slice: null, execution: true, delivery, required,
    allowed: [...required, delivery.verification, delivery.artifact, ...rootSources.map(row => row.path)], rules: {
      [delivery.input]: { kind: 'input', unit }, [delivery.output]: { kind: 'delivery', unit },
      [delivery.verification]: { kind: 'verification', unit }, [delivery.artifact]: { kind: 'artifact', unit },
      ...Object.fromEntries(rootSources.map(row => [row.path, { kind: row.kind, unit }])),
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
  if (r.writableRoots?.length && !r.execution_contract) fail('standalone-execution-multiple-code-roots');
  const contract = r.execution_contract
    ? roots.validateContract(r.execution_contract, { owner: root }) : roots.singleContract(root, cwd);
  const primary = contract.code_roots.find(entry => entry.id === contract.primary_root_id);
  if (roots.key(fs.realpathSync.native(cwd)) !== roots.key(primary.path)) fail('execution-primary-root-mismatch');
  const extras = contract.code_roots.filter(entry => entry.id !== contract.primary_root_id).map(entry => entry.path);
  if (r.writableRoots?.some(p => !extras.some(e => roots.key(e) === roots.key(fs.realpathSync.native(p))))) fail('execution-extra-root-undeclared');
  const planFile = path.join(root, loc.task, `${r.taskId}-PLAN.md`);
  physical(root, planFile);
  if (!r.planFile) fail('execution-plan-path-mismatch');
  const suppliedPlan = path.resolve(r.planFile);
  // Canonicalize only the owner prefix; physical() rejects links inside it.
  const suppliedOwner = path.resolve(path.dirname(suppliedPlan), '../../..');
  if (roots.key(path.join(suppliedOwner, loc.task, r.taskId + '-PLAN.md')) !== roots.key(suppliedPlan)
      || roots.key(fs.realpathSync.native(suppliedOwner)) !== roots.key(fs.realpathSync.native(root))) fail('execution-plan-path-mismatch');
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
  const validated = roots.validatePlan(plan, contract);
  const claims = validated.writes;
  if (r.execution_contract) {
    const claim = r.claim;
    if (!claim || claim.schema_version !== 2 || claim.released || !claim.generation) fail('execution-held-claim-required');
    const held = r.runId && require('./forge-runs').get(root, r.runId);
    if (!held || held.active !== true || held.write_claim?.generation !== claim.generation || held.write_claim.released
        || roots.digest(held.write_claim) !== roots.digest(claim)) fail('execution-claim-generation-stale');
    roots.claimGroups(claim);
    if (roots.digest(claim.execution_contract) !== roots.digest(contract)
        || claims.some(p => !claim.paths.some(c => roots.covers(c, p)))) fail('execution-held-claim-mismatch');
    const capability = require('./forge-transport-capabilities').executionCapability(r.route, contract, { nativeInvocation: r.nativeInvocation });
    if (!capability.supported) fail(capability.reason_code);
    if (r.plan_contract && (r.plan_contract.plan_sha256 !== validated.plan_sha256
        || r.plan_contract.contract_sha256 !== validated.contract_sha256
        || r.plan_contract.capabilities_sha256 !== roots.digest(capability))) fail('execution-preflight-stale');
  }
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
  context.unshift(`CODE_DIR: ${cwd}\nARTIFACT_OWNER: ${root}\nExecution contract: ${JSON.stringify(contract)}\nClaimed paths (only writes allowed): ${JSON.stringify(claims)}`);
  const snapshotApi = require('./forge-surgical-reset');
  const ordered = [primary, ...contract.code_roots.filter(entry => entry.id !== primary.id)];
  const snapshots = (ordered.length > 1 ? snapshotApi.captureMultiAttemptSnapshot(ordered.map(entry => entry.path), { attemptId: r.dispatchId })
    : [snapshotApi.captureAttemptSnapshot(cwd, { attemptId: r.dispatchId })]).map((snapshot, i) => ({ ...snapshot, root_id: ordered[i].id }));
  return { claims, execution_contract: contract, writableRoots: extras, snapshots, inputs, contextText: context.join('\n\n'), securityText,
    budgets: { coding_standards: standardsTokens }, plan_hash: hash(plan) };
}

// Content census of the owner's control tree, including ignored files. Memory
// is bounded by the entry limit and one shared read buffer, not archive sizes.
// Event streams are protected too; only the trusted broker may prove appends.
// No provider output or
// source content is stored here. Symlink coverage is refused, never assumed.
function protectedSnapshot(root) {
  const result = {}, observed = [], buffer = Buffer.allocUnsafe(64 * 1024);
  let entries = 0;
  function statAt(file) {
    try { return fs.lstatSync(file, { bigint: true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('execution-protected-snapshot-unstable');
      throw error;
    }
  }
  function checkType(stat) {
    if (stat.isSymbolicLink()) fail('execution-path-link');
    if (!stat.isFile() && !stat.isDirectory()) fail('execution-protected-file-type');
  }
  function sameStat(before, after) {
    const fields = ['dev', 'ino', 'mode', 'birthtimeNs'];
    if (before.isFile()) fields.push('size', 'mtimeNs', 'ctimeNs', 'nlink');
    if (fields.some(key => before[key] !== after[key])) fail('execution-protected-snapshot-unstable');
  }
  function visit(file, rel, initial) {
    if (++entries > 20000) fail('execution-protected-snapshot-limit');
    const stat = initial || statAt(file);
    checkType(stat);
    if (stat.isDirectory()) {
      result[`${rel}/`] = 'directory';
      const names = fs.readdirSync(file).sort();
      observed.push({ file, rel, stat, names });
      for (const name of names) visit(path.join(file, name), `${rel}/${name}`);
      return;
    }
    observed.push({ file, rel, stat });
    result[rel] = fileDigest(file, stat);
  }
  function fileDigest(file, stat) {
    const digest = crypto.createHash('sha256');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    try {
      sameStat(stat, fs.fstatSync(fd, { bigint: true }));
      // Stop at the observed size even if another process keeps appending.
      let remaining = stat.size;
      while (remaining > 0n) {
        const length = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
        const count = fs.readSync(fd, buffer, 0, length, null);
        if (!count) fail('execution-protected-snapshot-unstable');
        digest.update(buffer.subarray(0, count));
        remaining -= BigInt(count);
      }
      sameStat(stat, fs.fstatSync(fd, { bigint: true }));
      sameStat(stat, statAt(file));
      return digest.digest('hex');
    } finally { fs.closeSync(fd); }
  }
  const gsd = path.join(root, '.gsd');
  let initial;
  try { initial = fs.lstatSync(gsd, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  visit(gsd, '.gsd', initial);
  // Recheck earlier files and directories: a late read must not hide a change
  // behind the traversal. Compare directory identities and the complete name
  // set, including event creation/removal, as well as every file's bytes.
  for (const { file, rel, stat, names } of observed) {
    const current = statAt(file);
    checkType(current);
    sameStat(stat, current);
    if (names) {
      const currentNames = fs.readdirSync(file).sort();
      if (JSON.stringify(names) !== JSON.stringify(currentNames)) {
        fail('execution-protected-snapshot-unstable');
      }
    } else if (fileDigest(file, current) !== result[rel]) fail('execution-protected-snapshot-unstable');
  }
  return result;
}
function assertProtected(root, before) {
  if (roots.digest(Object.entries(protectedSnapshot(root)).sort()) !== roots.digest(Object.entries(before).sort())) fail('execution-protected-metadata');
}
function verifyResult(cwd, prepared, result) {
  const files = {};
  roots.validateContract(prepared.execution_contract, { revalidate: true });
  for (const entry of result.files_changed || []) {
    const multiple = prepared.execution_contract.code_roots.length > 1;
    if (multiple && (typeof entry === 'string' ? !entry.includes('::') : !entry.root_id)) fail('execution-result-root-required');
    const resolved = roots.resolvePath(prepared.execution_contract, typeof entry === 'string' ? entry
      : { root_id: entry.root_id || prepared.execution_contract.primary_root_id, path: entry.path }, { legacy: !multiple });
    if (!prepared.claims.some(claim => roots.covers(claim, resolved))) fail('execution-outside-claim');
    files[roots.qualified(resolved)] = fs.existsSync(resolved.absolute) ? hash(fs.readFileSync(resolved.absolute)) : null;
  }
  // Independently inspect every checkout; a caller's files_changed is never the
  // authoritative census, including deletion, rename and omitted new files.
  for (const snapshot of prepared.snapshots) {
    const now = require('./forge-surgical-reset').captureAttemptSnapshot(snapshot.code_dir);
    if (now.start_sha !== snapshot.start_sha || now.vcs !== snapshot.vcs) fail('execution-baseline-changed');
    const before = new Map(snapshot.pre_dirty.map(p => [p.path, p.hash]));
    const after = new Map(now.pre_dirty.map(p => [p.path, p.hash]));
    for (const rel of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(rel) === after.get(rel)) continue;
      const resolved = roots.resolvePath(prepared.execution_contract, { root_id: snapshot.root_id, path: rel });
      if (!prepared.claims.some(claim => roots.covers(claim, resolved))) fail('execution-outside-claim');
      const q = roots.qualified(resolved);
      const observed = fs.existsSync(resolved.absolute) ? hash(fs.readFileSync(resolved.absolute)) : null;
      if (!(q in files)) fail('execution-result-omitted-delta');
      if (files[q] !== observed) fail('execution-result-raced');
    }
  }
  return files;
}
function assertReplay(r, record) {
  if (r.execution_contract) {
    const held = r.runId && require('./forge-runs').get(r.contextRoot || r.cwd, r.runId);
    if (!held || !held.active || !r.claim?.generation || held.write_claim?.released
        || roots.digest(held.write_claim) !== roots.digest(r.claim)) fail('execution-claim-generation-stale');
    roots.claimGroups(held.write_claim);
  }
  for (const [file, expected] of Object.entries(record.execution.inputs)) {
    if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== expected) fail('execution-input-changed');
  }
  for (const [rel, expected] of Object.entries(record.execution.verified_files)) {
    const contract = record.execution.execution_contract;
    if (contract) roots.validateContract(contract, { revalidate: true });
    const file = contract ? roots.resolvePath(contract, rel).absolute : physical(fs.realpathSync.native(r.cwd), path.resolve(r.cwd, rel));
    const current = fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
    if (current !== expected) fail('execution-replay-code-changed');
  }
  if (JSON.stringify(replayState(r.cwd, record.execution.execution_contract)) !== JSON.stringify(record.execution.code_state)) fail('execution-replay-baseline-changed');
}
function replayState(cwd, contract) {
  if (contract) {
    roots.validateContract(contract, { revalidate: true });
    return contract.code_roots.map(root => ({ root_id: root.id, identity_sha256: root.identity_sha256, ...replayState(root.path) }));
  }
  const state = require('./forge-surgical-reset').captureAttemptSnapshot(cwd);
  return { start_sha: state.start_sha, pre_dirty: state.pre_dirty, vcs: state.vcs };
}
module.exports = { locations, prepare, protectedSnapshot, assertProtected, verifyResult, assertReplay, replayState };
