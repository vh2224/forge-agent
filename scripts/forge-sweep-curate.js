#!/usr/bin/env node
'use strict';

// Human curatorial verdicts are the only authority that can remove a fact.
// Planning is deliberately advisory and applying always measures it again.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const memory = require('./forge-memory');
const { buildClusters } = require('./forge-memory-clusters');
const { rewriteFragment } = require('./forge-memory-rewrite');
const { createRegistry, formatPreview } = require('./forge-sweep-registry');
const { writeVault, restoreVault, normalizeMemberId } = require('./forge-sweep-vault');
const journal = require('./forge-sweep-journal');
const { activeUnits, isUnitBlocked } = require('./forge-sweep-active-phase');
const { createEligibility, isVcsQueryFailure } = require('./forge-sweep-eligibility');

const OPERATION = 'curadoria-semantica';
const VERDICTS = new Set(['manter', 'fundir-no-sobrevivente']);
const USAGE = 'Uso: node scripts/forge-sweep-curate.js [--cwd <dir>] [--arbitration <arquivo>] [--apply|--undo] [--yes] [--json] [--help]';

/*
 * Contract map for future operators:
 *
 * 1. buildClusters produces the live candidate population.  It does not make
 *    a mutation decision and its recommended survivor is advisory only.
 * 2. validateArbitrationShape checks the document both while it is loaded
 *    from the CLI and again at the exported apply boundary.  A caller cannot
 *    slip around the file reader with an object literal.
 * 3. validateArbitrationAgainstPlan anchors every compound item address to a
 *    particular live cluster.  The same mem_id in another fragment remains a
 *    separate fact, by design.
 * 4. curatePlan applies the active-phase fence before a target reaches the
 *    generic eligibility filter.  An incomplete active-run observation is a
 *    named skip, never a clean observation.
 * 5. The registry invokes eligibility at its normal target boundary.  This
 *    command supplies members with actual fragment paths so every possible
 *    rewrite is checked through the one policy helper.
 * 5b. Eligibility narrows WHICH judged clusters may be written; it never
 *    narrows the universe the arbitration is judged against.  A cluster the
 *    filter removed is reported as a named skip and its verdicts are dropped.
 * 6. applyCurate rebuilds the plan before it opens a vault.  The fingerprint
 *    compares item identities rather than an old JSON plan file, preventing a
 *    human verdict from being applied to a changed store.
 * 7. writeVault receives every path that can be passed to rewriteFragment.
 *    appendIntent must then succeed before the first rewrite.  A later
 *    outcome failure still leaves a durable intent pointer for undo.
 * 8. rewriteFragment is intentionally the only write boundary for facts.
 *    This module neither parses nor serializes memory fragments, and does not
 *    choose an EOL spelling.
 * 9. Undo reads pointer-only journal data and lets restoreVault compare raw
 *    buffers.  It reports individual restoration conflicts without writing an
 *    undo-done outcome until all requested members are restored.
 * 10. Curation rewrites a fragment IN PLACE, so after a real apply the
 *    destination always diverges from the vaulted bytes.  The vault refuses a
 *    divergent destination by default (correctly), which made `--undo` inert
 *    on every post-apply attempt.  The opt-in is deliberately NOT a boolean:
 *    the apply records the exact member ids it vaulted and undo replays only
 *    that closed set into restoreVault.  A vault member outside the recorded
 *    set is still refused by name, and a missing/foreign record authorizes
 *    nothing at all — the historical deny-by-default.  The record is a
 *    curate-owned sidecar rather than a journal field because the journal is
 *    pointer-only by design (S08 § W3) and its reader carries named fields
 *    only; the sidecar is opened BEFORE the first rewrite so an interrupted
 *    apply still leaves an undoable authorization.
 * 10b. That record names only the members whose rewrite MAY HAVE CHANGED BYTES.
 *    It grows ONE MEMBER AT A TIME, each appended immediately before its own
 *    rewrite is attempted (so a crash mid-rewrite is still undoable — the
 *    crash-safety the pre-loop write existed to give, with no window), and the
 *    member is WITHDRAWN again when the boundary refuses without throwing:
 *    every `refusal()` in forge-memory-rewrite returns before the atomic write,
 *    so the destination still holds its pre-apply bytes.  A member skipped by
 *    OFF_SET_REASON is never named at all.  Authorizing an untouched member
 *    buys nothing — unrewritten, it restores as `alreadyPresent` and needs no
 *    authorization — and only removes the fence that would otherwise refuse to
 *    clobber a legitimate LATER edit to it.  These are live `.gsd/memory/*.md`,
 *    forge-memory's own write target after every unit, so an interim edit is
 *    the normal flow (S07 R1; S08: "undo devolve bytes pré-apply, o problema é
 *    atropelar a edição").
 *
 * These rules are kept near the imports because adding a convenient local
 * serializer, a group container, or a fall-through safety gate would defeat
 * the guarantees that the small helpers below deliberately compose.
 * The implementation consequently stays intentionally narrow.
 * New persistence features belong in a shared boundary, not here.
 * New policy features belong in eligibility or active-phase.
 * New clustering signals belong in forge-memory-clusters.
 * This command only coordinates those independent decisions.
 */

function failure(reason, detail) {
  const error = new Error(detail ? `${reason}: ${detail}` : reason);
  error.reason = reason; error.exitCode = 1; return error;
}

function parseArgs(argv) {
  const options = { cwd: process.cwd(), apply: false, undo: false, yes: false, json: false, help: false, arbitration: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--undo') options.undo = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--cwd' || arg === '--arbitration') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} exige um valor`);
      options[arg.slice(2)] = value;
    } else throw new Error(`argumento desconhecido: ${arg}`);
  }
  if (options.apply && options.undo) throw new Error('--apply e --undo são exclusivos');
  if (options.yes && !options.apply && !options.undo) throw new Error('--yes exige --apply ou --undo');
  if (options.apply && !options.arbitration) throw new Error('--apply exige --arbitration');
  if (options.json && (options.apply || options.undo) && !options.yes) throw new Error('--json com mutação exige --yes');
  return options;
}

function resolveCwd(value) {
  const cwd = path.resolve(value);
  try { if (!fs.statSync(cwd).isDirectory()) throw new Error('não é diretório'); }
  catch (error) { throw new Error(`não foi possível acessar --cwd: ${error.message}`); }
  return cwd;
}

function itemAddress(item) { return `${item.storage_key}\0${item.mem_id}`; }
function itemUnit(item) { return { unitId: item.unit_id, milestoneId: item.milestone_id }; }

// This validates syntax and internal cardinality. Membership is checked only
// against the fresh plan below, so a stale file cannot select an old fact.
function validateArbitrationShape(doc, plan) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.clusters)) throw failure('arbitration-unreadable', 'expected clusters[]');
  const seenClusters = new Set();
  for (const cluster of doc.clusters) {
    if (!cluster || typeof cluster !== 'object' || typeof cluster.cluster_id !== 'string' || !cluster.cluster_id || !Array.isArray(cluster.items) || seenClusters.has(cluster.cluster_id)) throw failure('arbitration-unreadable', 'cluster_id deve ser único e items[] é obrigatório');
    seenClusters.add(cluster.cluster_id);
    const addresses = new Set(); let survivors = 0;
    for (const item of cluster.items) {
      if (!item || typeof item.storage_key !== 'string' || !item.storage_key || typeof item.mem_id !== 'string' || !item.mem_id || !VERDICTS.has(item.verdict)) throw failure('arbitration-unreadable', `${cluster.cluster_id}: item ou veredito inválido`);
      const address = itemAddress(item);
      if (addresses.has(address)) throw failure('arbitration-unreadable', `${cluster.cluster_id}: item duplicado`);
      addresses.add(address); if (item.verdict === 'manter') survivors += 1;
    }
    if (survivors === 0) throw failure('no-survivor', cluster.cluster_id);
    if (survivors !== 1) throw failure('multiple-survivors', cluster.cluster_id);
  }
  if (plan) validateArbitrationAgainstPlan(doc, plan);
  return doc;
}

function validateArbitrationAgainstPlan(doc, plan) {
  const clusters = clustersFromPlan(plan);
  const known = new Map(clusters.map(cluster => [cluster.id, cluster]));
  for (const verdict of doc.clusters) {
    const cluster = known.get(verdict.cluster_id);
    if (!cluster) throw failure('unknown-cluster', verdict.cluster_id);
    const allowed = new Set((cluster.items || []).map(itemAddress));
    for (const item of verdict.items) if (!allowed.has(itemAddress(item))) throw failure('unknown-item', `${verdict.cluster_id}: ${item.storage_key}/${item.mem_id}`);
    const judged = new Set(verdict.items.map(itemAddress));
    const missing = (cluster.items || []).filter(item => !judged.has(itemAddress(item)));
    if (missing.length) throw failure('unjudged-items', verdict.cluster_id);
  }
  const judgedClusters = new Set(doc.clusters.map(item => item.cluster_id));
  const missingClusters = clusters.filter(item => !judgedClusters.has(item.id));
  if (missingClusters.length) throw failure('unjudged-items', missingClusters[0].id);
  return doc;
}

function clustersFromPlan(plan) {
  if (Array.isArray(plan && plan.clusters)) return plan.clusters;
  return (plan && plan.targets || []).map(target => ({ id: target.name || target.path, items: (target.members || []).map(item => ({ storage_key: item.storage_key || item.storageKey, mem_id: item.mem_id || item.memId, unit_id: item.unit_id, milestone_id: item.milestone_id })) }));
}

function loadArbitration(file, plan) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
  catch (error) { throw failure('arbitration-unreadable', error.message); }
  return validateArbitrationShape(parsed, plan);
}

function rawPlan(ctx) {
  const clusters = (ctx.buildClusters || buildClusters)(ctx.cwd);
  return { clusters: clusters.clusters || [], verdict: clusters.verdict || 'NO-TARGET', census: clusters.census || {} };
}

function phaseReason(phase, item) {
  if (!phase || phase.ok !== true) return 'active-phase-unknown';
  const blocked = (isUnitBlocked)(phase, itemUnit(item));
  return blocked && blocked.blocked ? (blocked.reason || 'active-phase') : null;
}

function curatePlan(ctx) {
  let measured;
  try { measured = rawPlan(ctx); } catch (error) { return { targets: [], skipped: [{ path: '.gsd/memory', reason: `cluster-indisponível: ${error.message}` }], verdict: 'UNAVAILABLE', clusters: [] }; }
  let phase;
  try { phase = (ctx.activeUnits || activeUnits)(ctx.cwd); } catch (_) { phase = { ok: false }; }
  let entries;
  try { entries = (ctx.listFragments || memory.listFragments)(ctx.cwd); }
  catch (error) { return { targets: [], skipped: [{ path: '.gsd/memory', reason: `fragmentos-indisponíveis: ${error.message}` }], verdict: measured.verdict, clusters: measured.clusters }; }
  const paths = new Map(entries.map(entry => [entry.storageKey, entry.path]));
  const targets = []; const skipped = [];
  for (const cluster of measured.clusters) {
    const members = cluster.items.map(item => ({ storageKey: item.storage_key, memId: item.mem_id, path: paths.get(item.storage_key), ...item }));
    if (members.some(member => !member.path)) { skipped.push({ path: cluster.id, reason: 'fragmento-indisponível' }); continue; }
    const reason = cluster.items.map(item => phaseReason(phase, item)).find(Boolean);
    if (reason) { skipped.push({ path: cluster.id, reason }); continue; }
    // `path` is the cluster identity used for display and matching (registry.js);
    // it is deliberately NOT `containerPath` — a curation cluster spans several
    // real fragment files, so it has no single container to VCS-check. Setting
    // containerPath here would feed this synthetic compound id into
    // targetPaths() (forge-sweep-eligibility.js), which resolves it against
    // cwd as if it were a real path and refuses every cluster with "caminho
    // fora do cwd" — a universal false rejection found during T05 dogfood.
    // Eligibility for this operation is decided entirely by the real member
    // fragment paths already carried on `members[].path`.
    targets.push({ name: cluster.id, path: cluster.id, members });
  }
  for (const item of measured.census.skipped || []) skipped.push({ path: item.key || item.item || '.gsd/memory', reason: item.reason || 'cluster-skipped' });
  return { targets, skipped, verdict: measured.verdict, clusters: measured.clusters };
}

function planFingerprint(preview) {
  const clusters = clustersFromPlan(preview && preview.operations ? { targets: (preview.operations || []).flatMap(operation => operation.targets || []) } : preview);
  return crypto.createHash('sha256').update(clusters.map(cluster => `${cluster.id}\0${(cluster.items || []).map(itemAddress).sort().join('\n')}`).sort().join('\n')).digest('hex');
}

/*
 * The one canonical eligible set.  `plan` is what the registry already passed
 * through the eligibility filter; `fresh` is the unfiltered re-measurement.
 * Two separate duties, deliberately not collapsed:
 *   - the arbitration's cluster UNIVERSE is judged against `fresh`, so a dirty
 *     fragment anywhere else in the store cannot abort an otherwise complete
 *     curatorial session (an eligibility exclusion is a named skip, never an
 *     unknown-cluster failure);
 *   - every write address is resolved through THIS set only, so a
 *     VCS-ineligible target is structurally unable to reach rewriteFragment
 *     no matter which plan shape a future edit chooses to validate against.
 */
function eligibleSet(plan) {
  const clusterIds = new Set(); const byStorage = new Map();
  for (const target of (plan && plan.targets) || []) {
    const id = target.name || target.path;
    if (id) clusterIds.add(id);
    for (const member of target.members || []) {
      const key = member.storageKey || member.storage_key;
      if (key) byStorage.set(key, member.path);
    }
  }
  return { clusterIds, byStorage };
}

const FILTERED_REASON = 'cluster-filtrado-por-eligibility';
const OFF_SET_REASON = 'alvo-inelegível-no-limite-de-escrita';

function filteredOutClusters(doc, eligible) {
  return (doc.clusters || []).filter(cluster => !eligible.clusterIds.has(cluster.cluster_id))
    .map(cluster => ({ path: cluster.cluster_id, reason: FILTERED_REASON }));
}

function selectedDrops(doc, eligible) {
  const byStorage = new Map();
  for (const cluster of doc.clusters) {
    if (eligible && !eligible.clusterIds.has(cluster.cluster_id)) continue;
    for (const item of cluster.items) if (item.verdict === 'fundir-no-sobrevivente') {
      if (!byStorage.has(item.storage_key)) byStorage.set(item.storage_key, []);
      byStorage.get(item.storage_key).push(item.mem_id);
    }
  }
  return byStorage;
}

// The ordered write population: every storage key whose fragment path the
// eligible set resolves, carrying both halves so the vault member id produced
// for a file can be attributed back to the storage key that will be rewritten.
function dropTargets(cwd, drops, eligible) {
  return [...drops.keys()]
    .map(storageKey => ({ storageKey, file: eligible.byStorage.get(storageKey) }))
    .filter(entry => Boolean(entry.file))
    .map(entry => ({ storageKey: entry.storageKey, file: path.resolve(cwd, entry.file) }));
}

function filesForDrops(cwd, drops, eligible) {
  // rewriteFragment owns storage-key lookup; use the eligible member addresses
  // only for vault file paths, never serialize fragments here.
  return dropTargets(cwd, drops, eligible).map(entry => entry.file);
}

const AUTH_DIR = path.join('.gsd', 'forge', 'sweep-curate-auth');
const AUTH_MISSING = 'authorization-record-failed';

// One sidecar per container, named after the container basename. The container
// path handed to these helpers is already the journal's validated resolution
// (safeContainerPath), so only its basename is ever used to address the record.
function authorizationPath(cwd, containerPath) {
  return path.join(cwd, AUTH_DIR, `${path.basename(containerPath)}.json`);
}

function writeAuthorization(cwd, containerPath, members, options) {
  const ids = (Array.isArray(members) ? members : []).map(normalizeMemberId).filter(Boolean);
  const io = Object.assign({}, fs, options && options.io);
  let temporary = null;
  let handle = null;
  try {
    const file = authorizationPath(cwd, containerPath);
    io.mkdirSync(path.dirname(file), { recursive: true });
    temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    handle = io.openSync(temporary, 'wx');
    io.writeFileSync(handle, `${JSON.stringify({ operation: OPERATION, container: path.basename(containerPath), members: ids }, null, 2)}\n`, 'utf8');
    io.fsyncSync(handle);
    io.closeSync(handle);
    handle = null;
    // The previous authorization remains intact until this single publication
    // boundary. A failed/truncated staging write can therefore never erase the
    // members that already make an interrupted apply undoable.
    io.renameSync(temporary, file);
    temporary = null;
    return { ok: true, file, members: ids };
  } catch (error) {
    if (handle !== null) { try { io.closeSync(handle); } catch (_) {} }
    if (temporary) { try { io.unlinkSync(temporary); } catch (_) {} }
    return { ok: false, error: error.message };
  }
}

// Deny-by-default at every failure: unreadable, malformed, written by another
// operation, or naming a different container all yield the empty set, which is
// exactly the historical unconditional refusal. A record is never inferred from
// the container's own contents — that would authorize every parsed member and
// dissolve the fence this function exists to keep.
function authorizedMembers(cwd, containerPath) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(authorizationPath(cwd, containerPath), 'utf8')); }
  catch (_) { return []; }
  if (!parsed || typeof parsed !== 'object') return [];
  if (parsed.operation !== OPERATION) return [];
  if (parsed.container !== path.basename(containerPath)) return [];
  if (!Array.isArray(parsed.members)) return [];
  return parsed.members.map(normalizeMemberId).filter(Boolean);
}

function applyCurate(ctx, plan) {
  const fresh = curatePlan(ctx);
  const expectedFingerprint = ctx.planFingerprint || planFingerprint(plan);
  if (expectedFingerprint !== planFingerprint(fresh)) return { written: [], skipped: (plan.skipped || []).concat([{ path: '.gsd/memory', reason: 'plan-changed' }]), error: 'plan-changed' };
  const arbitration = validateArbitrationShape(ctx.arbitration, fresh);
  const eligible = eligibleSet(plan);
  const filteredOut = filteredOutClusters(arbitration, eligible);
  const drops = selectedDrops(arbitration, eligible);
  const targets = dropTargets(ctx.cwd, drops, eligible);
  const files = targets.map(entry => entry.file);
  if (!files.length) return { written: [], skipped: (fresh.skipped || []).concat(filteredOut) };
  let vault;
  try { vault = (ctx.writeVault || writeVault)(ctx.cwd, { operation: OPERATION, files }); }
  catch (error) { return { written: [], skipped: (fresh.skipped || []).concat(filteredOut, [{ path: '.gsd/forge/sweep-vault', reason: `vault-failed: ${error.message}` }]), error: 'vault-failed' }; }
  if (!vault || vault.ok !== true) return { written: [], skipped: (fresh.skipped || []).concat(filteredOut, (vault && vault.skipped) || [{ path: '.gsd/forge/sweep-vault', reason: 'vault-failed' }]), error: 'vault-failed' };
  const intent = (ctx.journal || journal).appendIntent(ctx.cwd, { operation: OPERATION, containers: [vault.containerPath] });
  if (!intent || intent.ok !== true) return { written: [], skipped: (fresh.skipped || []).concat(filteredOut, [{ path: vault.containerPath, reason: `journal-intent-failed: ${(intent && intent.error) || 'indisponível'}` }]), error: 'journal-intent-failed' };
  // Opened before the first rewrite, for the same reason appendIntent is: an
  // apply interrupted mid-loop must still be undoable. It starts EMPTY and is
  // grown one member at a time below (§ 10b) — a member the loop never rewrites
  // must never be authorized to overwrite a later legitimate edit.
  const writeAuth = ctx.writeAuthorization || writeAuthorization;
  const authorized = [];
  let authorization = writeAuth(ctx.cwd, vault.containerPath, authorized);
  if (!authorization || authorization.ok !== true) return { written: [], skipped: (fresh.skipped || []).concat(filteredOut, [{ path: vault.containerPath, reason: `${AUTH_MISSING}: ${(authorization && authorization.error) || 'indisponível'}` }]), error: AUTH_MISSING };
  const memberIds = new Map(targets.map((entry, index) => [entry.storageKey, (vault.members || [])[index]]));
  const written = []; const skipped = (fresh.skipped || []).concat(filteredOut);
  for (const [storageKey, dropMemIds] of drops) {
    // Last structural gate: an address absent from the eligible set never
    // reaches the write boundary, whatever produced `drops`.
    if (!eligible.byStorage.has(storageKey)) { skipped.push({ path: storageKey, reason: OFF_SET_REASON }); continue; }
    // Authorize THIS member, and only it, before its rewrite can start. If the
    // record cannot be grown, the rewrite does not happen: an unrecorded
    // rewrite is exactly the un-undoable apply the pre-loop write forbids.
    const candidate = authorized.concat([memberIds.get(storageKey)].filter(Boolean));
    const grown = writeAuth(ctx.cwd, vault.containerPath, candidate);
    if (!grown || grown.ok !== true) { skipped.push({ path: storageKey, reason: `${AUTH_MISSING}: ${(grown && grown.error) || 'indisponível'}` }); continue; }
    authorization = grown; authorized.length = 0; authorized.push(...candidate);
    const result = (ctx.rewriteFragment || rewriteFragment)(ctx.cwd, { storageKey, dropMemIds });
    if (result && result.ok) { written.push(result.path); continue; }
    skipped.push({ path: (result && result.path) || storageKey, reason: (result && result.reason) || 'rewrite-failed' });
    // A NON-THROWING refusal is the write boundary's own statement that it
    // returned before touching the destination (every `refusal()` in
    // forge-memory-rewrite precedes the atomic write). Those bytes are still
    // the pre-apply bytes, so the member restores as `alreadyPresent` and
    // needs no authorization — withdrawing it is pure protection. A THROW is
    // deliberately NOT withdrawn: the rewrite may have landed.
    const withdrawn = authorized.slice(0, -1);
    const shrunk = writeAuth(ctx.cwd, vault.containerPath, withdrawn);
    if (!shrunk || shrunk.ok !== true) { skipped.push({ path: vault.containerPath, reason: `authorization-withdraw-failed: ${(shrunk && shrunk.error) || 'indisponível'}` }); continue; }
    authorization = shrunk; authorized.length = 0; authorized.push(...withdrawn);
  }
  const outcome = (ctx.journal || journal).appendOutcome(ctx.cwd, { id: intent.id, phase: 'apply-done', written: [vault.containerPath] });
  if (!outcome || outcome.ok !== true) skipped.push({ path: vault.containerPath, reason: `journal-outcome-failed: ${(outcome && outcome.error) || 'indisponível'}` });
  return { written, skipped, journalId: intent.id, vault: vault.containerPath, authorization: authorization.file, authorized: authorization.members };
}

function buildRegistry() { const registry = createRegistry(); registry.register({ name: OPERATION, description: 'Aplica somente vereditos humanos de curadoria semântica.', plan: curatePlan, apply: applyCurate }); return registry; }
function askConfirmation(text) { return new Promise(resolve => { const terminal = readline.createInterface({ input: process.stdin, output: process.stderr }); terminal.on('close', () => resolve(false)); terminal.question(text, answer => { terminal.close(); resolve(answer.trim().toLowerCase() === 'sim'); }); }); }

async function runUndo(cwd, options) {
  const listed = journal.latestUndoable(cwd);
  if (!listed.ok) { process.stderr.write(`${OPERATION}: ${listed.error}\n`); return 1; }
  if (!listed.entry) { process.stdout.write(options.json ? '{"undo":null}\n' : 'nada para desfazer\n'); return 0; }
  if (!options.yes && !process.stdin.isTTY) { process.stdout.write('desfazer não confirmado fora de TTY; use --yes para confirmar\n'); return 0; }
  if (!options.yes && !(await askConfirmation('Confirmar desfazer? Digite "sim": '))) return 0;
  const restored = []; const errors = [];
  for (const rel of listed.entry.containers) {
    const container = journal._private.safeContainerPath(cwd, rel);
    if (!container) { errors.push(`${rel}: container inválido`); continue; }
    try {
      // The closed set recorded by the apply that wrote this container — never
      // a boolean, never the container's own member list.
      const result = restoreVault(cwd, container, { overwrite: authorizedMembers(cwd, container) });
      restored.push(...result.restored, ...result.alreadyPresent);
      for (const refused of result.refused) errors.push(`${refused.path}: ${refused.reason}`);
    } catch (error) { errors.push(error.message); }
  }
  if (!errors.length) { const outcome = journal.appendOutcome(cwd, { id: listed.entry.id, phase: 'undo-done', written: restored }); if (!outcome.ok) errors.push(outcome.error); }
  process.stdout.write(options.json ? `${JSON.stringify({ undo: { restored, errors } })}\n` : `desfeito: ${restored.length} restaurado(s)\n`); return errors.length ? 1 : 0;
}

async function main(argv) {
  let options; try { options = parseArgs(argv); } catch (error) { process.stderr.write(`${error.message}\n${USAGE}\n`); return 2; }
  if (options.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  try {
    const cwd = resolveCwd(options.cwd); if (options.undo) return runUndo(cwd, options);
    const ctx = { cwd }; const preliminary = curatePlan(ctx);
    ctx.planFingerprint = planFingerprint(preliminary);
    if (options.arbitration) ctx.arbitration = loadArbitration(options.arbitration, preliminary);
    const eligibility = createEligibility(cwd, { toolUndo: { available: true } }); const registry = buildRegistry();
    if (!options.apply) { const result = registry.run(ctx, { filter: eligibility.filter }); const payload = { preview: result.preview, applied: false, verdict: preliminary.verdict, vcs: eligibility.vcs }; process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : `${formatPreview(result.preview)}\nveredito: ${preliminary.verdict}\n`); return result.preview.operations.some(op => (op.skipped || []).some(item => isVcsQueryFailure(item.reason))) ? 1 : 0; }
    if (!options.yes && !process.stdin.isTTY) { process.stdout.write('aplicação não confirmada fora de TTY; use --yes para confirmar\n'); return 0; }
    if (!options.yes && !(await askConfirmation('Confirmar aplicação? Digite "sim": '))) return 0;
    const result = registry.run(ctx, { filter: eligibility.filter, confirm: () => true }); const entry = result.results[0] && result.results[0].result; const payload = { preview: result.preview, applied: result.applied, result: entry || null }; process.stdout.write(options.json ? `${JSON.stringify(payload, null, 2)}\n` : `${formatPreview(result.preview)}\n`); return entry && entry.error ? 1 : 0;
  } catch (error) { process.stderr.write(`${OPERATION}: ${error.reason || error.message}\n`); return error.exitCode || 1; }
}

module.exports = { buildRegistry, validateArbitrationShape, planFingerprint, main, _private: { OPERATION, parseArgs, resolveCwd, loadArbitration, validateArbitrationAgainstPlan, curatePlan, applyCurate, selectedDrops, filesForDrops, dropTargets, eligibleSet, filteredOutClusters, rawPlan, runUndo, FILTERED_REASON, OFF_SET_REASON, AUTH_MISSING, AUTH_DIR, authorizationPath, writeAuthorization, authorizedMembers } };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
