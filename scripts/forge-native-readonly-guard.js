#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const roots = require('./forge-code-roots');
const vcs = require('./forge-vcs');
const execution = require('./forge-task-execution');
const lease = require('./forge-unit-lease');
const { sha256, fingerprint, resolveSafeFile } = require('./forge-delivery');
const { readBoundedStableFile } = require('./forge-autonomy-sources');

const REASONS = Object.freeze({
  MUTATION: 'native-readonly-mutation-detected',
  UNRECONCILED: 'native-readonly-writer-unreconciled',
  UNAVAILABLE: 'native-readonly-guard-unavailable',
  USAGE: 'native-readonly-guard-invalid-usage',
});
const MAX_ENTRIES = 20000;
const FILE_BYTES = 1024 * 1024;
const SNAPSHOT_BYTES = 16 * FILE_BYTES;
const ATTESTATION = '--writer-stopped é atestado do chamador, não prova de processo.';
const LIMITS = Object.freeze([
  'Detecção depois da unidade, não sandbox do SO; nunca reverte, apaga ou corrige arquivos.',
  'Não ficam provados caminhos ignorados, escritas fora das raízes guardadas, mudança criada e revertida dentro da janela, efeitos de rede e escritores alheios concorrentes no mesmo owner.',
  'Leitura limitada a 20000 entradas por árvore; arquivos de código/hooks e registros próprios a 1 MiB, append e baseline a 16 MiB; indisponibilidade falha fechada.',
  'Captura recusa índices com assume-unchanged, skip-worktree ou outros estados que ocultam caminhos; o chamador não deve iniciar a unidade nessa condição.',
]);
function fail(detail, usage = false) { throw Object.assign(new Error(detail), { guardDetail: detail, usage }); }
function result(ok, reason, exitCode, fields = {}) {
  return { ok, reason, exit_code: exitCode, ...fields, attestation: ATTESTATION, limits: LIMITS };
}
function failure(error) {
  return result(false, error.usage ? REASONS.USAGE : REASONS.UNAVAILABLE, error.usage ? 2 : 4,
    { detail: error.guardDetail || 'leitura indisponível' });
}
function contained(root, file) {
  const parent = roots.key(root).replace(/\/$/, ''), target = roots.key(file);
  return target === parent || target.startsWith(`${parent}/`);
}
function noLinks(file, allowMissing = false) {
  const absolute = path.resolve(file), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) fail('link simbólico');
  }
}
function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) fail('raiz absoluta obrigatória', true);
  noLinks(value);
  const real = fs.realpathSync.native(value);
  if (!fs.statSync(real).isDirectory()) fail('raiz indisponível');
  return real;
}
function relative(value, ownerPermission = false) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || /[\0-\x1f\x7f:*?\[\]{}!]/.test(value)) fail('caminho relativo exato obrigatório', true);
  const portable = value.replace(/\\/g, '/'), parts = portable.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))
      || ownerPermission && (parts[0] !== '.gsd' || parts.length < 2)) fail('permissão exata sob .gsd obrigatória', true);
  return portable;
}
function ownerFile(owner, relativePath, allowMissing = false, maxBytes = FILE_BYTES) {
  const file = path.join(owner, relativePath);
  noLinks(file, allowMissing);
  const resolved = resolveSafeFile(file, [owner], { allowMissing, maxBytes });
  if (resolved.error) fail('arquivo protegido indisponível');
  if (!contained(owner, resolved.path)) fail('arquivo fora do owner');
  return resolved.path;
}
function bytes(file, maxBytes = FILE_BYTES) {
  noLinks(file);
  const resolved = resolveSafeFile(file, [fs.realpathSync.native(path.dirname(file))], { maxBytes });
  if (resolved.error) fail('arquivo ou limite indisponível');
  const read = readBoundedStableFile(resolved.path, maxBytes, { expectedReal: resolved.path });
  if (read.error) fail('leitura instável ou indisponível');
  return read.buffer;
}
function permissions(options) {
  const lists = {};
  for (const [input, output] of [['allowAppend', 'allow_append'], ['allowPublication', 'allow_publication']]) {
    const values = options[input] === undefined ? [] : options[input];
    if (!Array.isArray(values) || values.length > 100) fail('lista de permissões inválida', true);
    lists[output] = values.map(value => relative(value, true)).sort();
    if (new Set(lists[output].map(roots.key)).size !== values.length) fail('permissão duplicada', true);
  }
  if (lists.allow_append.some(value => lists.allow_publication.some(other => roots.key(other) === roots.key(value)))) fail('permissões sobrepostas', true);
  if (options.ownLease !== undefined && (typeof options.ownLease !== 'string' || !options.ownLease.trim() || options.ownLease.length > 1024 || /[\0-\x1f\x7f]/.test(options.ownLease))) fail('unidade própria inválida', true);
  if (options.ownRun !== undefined && (typeof options.ownRun !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.ownRun))) fail('run próprio inválido', true);
  return { ...lists, own_lease: options.ownLease === undefined ? null : lease.normalizeUnitKey(options.ownLease), own_run: options.ownRun === undefined ? null : options.ownRun };
}
function config(options) {
  const owner = directory(options.owner);
  if (!Array.isArray(options.codeRoots) || !options.codeRoots.length || options.codeRoots.length > 14) fail('uma ou mais raízes de código obrigatórias', true);
  const codeRoots = options.codeRoots.map((entry, index) => {
    const value = typeof entry === 'string' ? { id: `code-${index + 1}`, path: entry } : entry;
    if (!value || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.id || '')) fail('identidade de raiz inválida', true);
    return { root: value.id, path: directory(value.path) };
  });
  if (new Set(codeRoots.map(root => root.root)).size !== codeRoots.length) fail('identidade de raiz duplicada', true);
  for (let i = 0; i < codeRoots.length; i++) for (let j = i + 1; j < codeRoots.length; j++) {
    if (contained(codeRoots[i].path, codeRoots[j].path) || contained(codeRoots[j].path, codeRoots[i].path)) fail('raízes sobrepostas', true);
  }
  const mode = options.mode === undefined ? 'full' : options.mode;
  if (!['full', 'code-only'].includes(mode)) fail('modo inválido', true);
  return { owner, codeRoots, mode, permissions: permissions(options) };
}
function outputPath(value, settings) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) fail('destino obrigatório', true);
  const absolute = path.resolve(value), parent = path.dirname(absolute);
  // Resolve the parent, including Windows short names/case, before comparing keys.
  // A link alias is refused even when it currently resolves outside the roots.
  try { noLinks(parent); } catch { fail('destino com link ou pai indisponível', true); }
  const target = path.join(fs.realpathSync.native(parent), path.basename(absolute));
  if (target.split(path.sep).some(part => part.toLowerCase() === '.gsd')
      || [settings.owner, ...settings.codeRoots.map(root => root.path)].some(root => contained(root, target))) fail('destino dentro de raiz guardada', true);
  try { fs.lstatSync(target); fail('destino já existe', true); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}
function gitRead(root, args, allowEmpty = true) {
  const output = spawnSync('git', ['-C', root, ...args], { shell: false, windowsHide: true,
    encoding: 'buffer', maxBuffer: SNAPSHOT_BYTES, timeout: 15000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  if (output.error || output.status !== 0 || !Buffer.isBuffer(output.stdout) || !allowEmpty && !output.stdout.length) fail('VCS indisponível ou limite excedido');
  return output.stdout;
}
function excluded(value) { const portable = value.replace(/\\/g, '/').toLowerCase(); return portable === '.gsd' || portable.startsWith('.gsd/'); }
function hooksDigest(directoryPath) {
  noLinks(directoryPath, true);
  if (!fs.existsSync(directoryPath)) return fingerprint({ absent: true });
  const rows = [];
  function visit(file, rel) {
    if (rows.length >= MAX_ENTRIES) fail('limite de hooks excedido');
    const before = fs.lstatSync(file);
    if (before.isSymbolicLink() || !before.isDirectory() && !before.isFile()) fail('tipo ou link de hook indisponível');
    if (before.isDirectory()) {
      rows.push([rel, 'directory', before.mode]); const names = fs.readdirSync(file).sort();
      for (const name of names) visit(path.join(file, name), `${rel}/${name}`);
      const after = fs.lstatSync(file);
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
          || JSON.stringify(names) !== JSON.stringify(fs.readdirSync(file).sort())) fail('hooks instáveis');
    } else rows.push([rel, before.mode, sha256(bytes(file))]);
  }
  visit(directoryPath, '.');
  return fingerprint(rows);
}
function codeSnapshot(root, verifying) {
  const options = { vcs: 'git', maxBuffer: SNAPSHOT_BYTES, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, exclude: excluded };
  const head = vcs.baselineId(root.path, options), status = vcs.workingStatus(root.path, options), dirty = vcs.captureDirty(root.path, options);
  if (!head.ok || !status.ok || !dirty.ok || !/^[a-f0-9]{40,64}$/.test(head.id)) fail('VCS ou código porcelain indisponível');
  if (status.entries.length > MAX_ENTRIES || dirty.entries.length > MAX_ENTRIES) fail('limite de caminhos excedido');
  const statusRows = status.entries.filter(row => row.kind !== 'ignored' && !excluded(row.path)).map(row => {
    relative(row.path);
    if (!/^(?:\?\?|[ MADRCU?!]{2})$/.test(row.code) || row.code === '!!' || /[?!]/.test(row.code) && row.code !== '??') fail('código porcelain inesperado');
    return { path: row.path, code: row.code };
  }).sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code));
  // The porcelain index column alone cannot detect a staged blob changed while
  // both snapshots remain MM. This fixed read-only digest closes that case.
  const indexBytes = gitRead(root.path, ['ls-files', '--stage', '-v', '-z']);
  const entries = indexBytes.toString('utf8').split('\0').filter(Boolean);
  if (entries.length > MAX_ENTRIES) fail('limite do índice excedido');
  for (const entry of entries) {
    const tab = entry.indexOf('\t'); if (tab < 0) fail('índice inesperado');
    const rel = entry.slice(tab + 1); if (excluded(rel)) continue;
    // A preexisting h/S flag can hide a later content change from both VCS
    // helpers. Refuse before the unit; a newly introduced flag still yields
    // an index delta during verification against the original visible index.
    if (!verifying && entry[0] !== 'H') fail('índice oculta caminhos rastreados');
    relative(rel); noLinks(path.join(root.path, rel), true);
  }
  const dirtyRows = dirty.entries.filter(row => !excluded(row.path)).map(row => {
    relative(row.path); const file = path.join(root.path, row.path); noLinks(file, true);
    let raw = null;
    try { raw = sha256(bytes(file)); }
    catch (error) {
      if (!fs.existsSync(file) && statusRows.some(entry => entry.path === row.path && entry.code.includes('D'))) raw = null;
      else throw error;
    }
    if (raw !== null && (typeof row.hash !== 'string' || !/^[a-f0-9]{40,64}$/.test(row.hash))) fail('hash VCS indisponível');
    return { path: row.path, hash: row.hash, sha256: raw };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const hookPath = gitRead(root.path, ['rev-parse', '--git-path', 'hooks'], false).toString('utf8').trim();
  if (!hookPath || /[\0\r\n]/.test(hookPath)) fail('caminho de hooks indisponível');
  return { ...root, head: head.id, head_ref: sha256(gitRead(root.path, ['rev-parse', '--symbolic-full-name', 'HEAD'])), status: statusRows, dirty: dirtyRows,
    index: sha256(entries.filter(entry => !excluded(entry.slice(entry.indexOf('\t') + 1))).join('\0')),
    refs: sha256(gitRead(root.path, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)'])),
    stash: sha256(gitRead(root.path, ['stash', 'list', '--format=%gd%x00%H%x00%gs'])),
    config: sha256(gitRead(root.path, ['config', '--local', '--list', '-z'])),
    hooks: hooksDigest(path.resolve(root.path, hookPath)) };
}
function recordPreimage(owner, rel, kind, unit) {
  const buffer = bytes(ownerFile(owner, rel));
  let parsed;
  try { parsed = JSON.parse(buffer.toString('utf8')); } catch { fail('registro próprio inválido'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('registro próprio inválido');
  const clocks = kind === 'lease-heartbeat' ? ['heartbeat_at', 'expires_at'] : ['last_heartbeat'];
  if (kind === 'lease-heartbeat' ? !lease.validRecord(parsed, unit) : parsed.id !== unit || !Number.isFinite(parsed.started_at)) fail('registro próprio inválido');
  if (clocks.some(key => !Number.isFinite(parsed[key]))) fail('relógio próprio inválido');
  // Store a parsed, redacted preimage: immutable fields (including owner_token
  // and generation) are bound by digest, not copied from file content.
  return { path: rel, kind, file_sha256: sha256(buffer), invariant_sha256: fingerprint(Object.fromEntries(Object.entries(parsed).filter(([key]) => !clocks.includes(key)))),
    clocks: Object.fromEntries(clocks.map(key => [key, parsed[key]])) };
}
function snapshot(settings, verifying = false) {
  const codeRoots = settings.codeRoots.map(root => codeSnapshot(root, verifying));
  if (settings.mode === 'code-only') return { code_roots: codeRoots, owner_snapshot: null, appends: [], owner_records: [] };
  const ownerSnapshot = execution.protectedSnapshot(settings.owner), appends = [], records = [];
  for (const rel of settings.permissions.allow_publication) ownerFile(settings.owner, rel, true);
  for (const rel of settings.permissions.allow_append) {
    const file = ownerFile(settings.owner, rel, true, SNAPSHOT_BYTES);
    const buffer = fs.existsSync(file) ? bytes(file, SNAPSHOT_BYTES) : Buffer.alloc(0);
    appends.push({ path: rel, size: buffer.length, sha256: sha256(buffer) });
  }
  function ownRecord(rel, kind, unit) {
    try { records.push(recordPreimage(settings.owner, rel, kind, unit)); }
    catch (error) { if (!verifying) throw error; records.push({ path: rel, kind, invalid: true }); }
  }
  if (settings.permissions.own_lease !== null) ownRecord(
    path.relative(settings.owner, lease.leaseFile(settings.owner, settings.permissions.own_lease)).replace(/\\/g, '/'), 'lease-heartbeat', settings.permissions.own_lease);
  if (settings.permissions.own_run !== null) ownRecord(`.gsd/forge/runs/${settings.permissions.own_run}.json`, 'run-heartbeat', settings.permissions.own_run);
  return { code_roots: codeRoots, owner_snapshot: ownerSnapshot, appends, owner_records: records };
}
function stableSnapshot(settings, verifying = false) {
  const first = snapshot(settings, verifying), second = snapshot(settings, verifying);
  if (fingerprint(first) !== fingerprint(second)) fail('snapshot instável');
  return second;
}
function captureBaseline(options = {}) {
  try {
    const settings = config(options), out = options.out === undefined ? null : outputPath(options.out, settings);
    const baseline = { schema_version: 1, owner: settings.owner, mode: settings.mode, permissions: settings.permissions, ...stableSnapshot(settings) };
    baseline.sha256 = fingerprint(baseline);
    if (out) {
      const serialized = JSON.stringify(baseline) + '\n';
      if (Buffer.byteLength(serialized) > SNAPSHOT_BYTES) fail('limite da baseline excedido');
      // Revalidate immediately before the only write. Never replace a baseline.
      if (roots.key(outputPath(options.out, settings)) !== roots.key(out)) fail('destino mudou', true);
      try { fs.writeFileSync(out, serialized, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code === 'EEXIST') fail('destino já existe', true); throw error; }
    }
    return result(true, null, 0, { baseline });
  } catch (error) { return failure(error); }
}
function compare(baseline, current, settings) {
  const changes = [], publications = [], appended = [], transitions = [];
  let count = 0;
  const add = (list, root, rel, kind) => { count++; if (list.length < 100) list.push({ root, path: rel, kind }); };
  for (let index = 0; index < baseline.code_roots.length; index++) {
    const before = baseline.code_roots[index], after = current.code_roots[index];
    for (const [field, kind, rel] of [['head', 'head', '.git/HEAD'], ['head_ref', 'head', '.git/HEAD'], ['refs', 'ref', '.git/refs'], ['stash', 'stash', '.git/logs/refs/stash'], ['config', 'config', '.git/config'], ['hooks', 'hooks', '.git/hooks'], ['index', 'index', '.git/index']]) {
      if (before[field] !== after[field]) add(changes, before.root, rel, kind);
    }
    const statuses = rows => new Map(rows.map(row => [row.path, row.code]));
    const oldStatus = statuses(before.status), newStatus = statuses(after.status);
    const hashes = rows => new Map(rows.map(row => [row.path, row.sha256]));
    const oldHashes = hashes(before.dirty), newHashes = hashes(after.dirty);
    for (const rel of new Set([...oldStatus.keys(), ...newStatus.keys(), ...oldHashes.keys(), ...newHashes.keys()])) {
      const oldCode = oldStatus.get(rel), newCode = newStatus.get(rel);
      if (oldCode === newCode && oldHashes.get(rel) === newHashes.get(rel)) continue;
      const kind = newCode && newCode.includes('D') ? 'deleted' : !oldCode && newCode && (newCode === '??' || newCode[0] === 'A') ? 'added'
        : oldHashes.get(rel) === newHashes.get(rel) && oldCode !== newCode && oldCode?.[0] !== newCode?.[0] ? 'index' : 'modified';
      add(changes, before.root, rel, kind);
    }
  }
  if (settings.mode === 'full') {
    const oldOwner = baseline.owner_snapshot, newOwner = current.owner_snapshot;
    const exact = (list, rel) => list.some(value => roots.key(value) === roots.key(rel));
    for (const rel of new Set([...Object.keys(oldOwner), ...Object.keys(newOwner)])) {
      if (oldOwner[rel] === newOwner[rel]) continue;
      if (!rel.endsWith('/') && exact(settings.permissions.allow_publication, rel)) { add(publications, 'owner', rel, 'publication'); continue; }
      const append = baseline.appends.find(value => roots.key(value.path) === roots.key(rel));
      if (append) {
        const target = ownerFile(settings.owner, rel, true, SNAPSHOT_BYTES);
        if (!fs.existsSync(target)) { add(changes, 'owner', rel, 'append-rewrite'); continue; }
        const buffer = bytes(target, SNAPSHOT_BYTES);
        if (sha256(buffer) !== newOwner[rel]) fail('snapshot instável');
        if (buffer.length >= append.size && sha256(buffer.subarray(0, append.size)) === append.sha256) add(appended, 'owner', rel, 'append');
        else add(changes, 'owner', rel, 'append-rewrite');
        continue;
      }
      const record = baseline.owner_records.find(value => roots.key(value.path) === roots.key(rel));
      if (record && newOwner[rel] !== undefined) {
        const next = current.owner_records.find(value => value.path === record.path);
        if (next && !next.invalid && next.file_sha256 === newOwner[rel] && record.invariant_sha256 === next.invariant_sha256
            && Object.keys(record.clocks).every(key => next.clocks[key] >= record.clocks[key])
            && Object.keys(record.clocks).some(key => next.clocks[key] > record.clocks[key])) {
          add(transitions, 'owner', rel, record.kind); continue;
        }
      }
      add(changes, 'owner', rel, 'owner-control');
    }
  }
  return result(changes.length === 0, changes.length ? REASONS.MUTATION : null, changes.length ? 3 : 0,
    { changes, truncated: count > 100, allowed_publications: publications, appended, owner_transitions: transitions });
}
function verifyBaseline(baseline, options = {}) {
  if (options.writerStopped !== true) return result(false, REASONS.UNRECONCILED, 4);
  try {
    if (!baseline || baseline.schema_version !== 1 || !baseline.permissions || !Array.isArray(baseline.code_roots)) fail('baseline inválida');
    const { sha256: saved, ...body } = baseline;
    if (typeof saved !== 'string' || fingerprint(body) !== saved) fail('baseline alterada ou inválida');
    const settings = config({ owner: baseline.owner, mode: baseline.mode,
      codeRoots: baseline.code_roots.map(root => ({ id: root.root, path: root.path })), allowAppend: baseline.permissions.allow_append,
      allowPublication: baseline.permissions.allow_publication, ...(baseline.permissions.own_lease === null ? {} : { ownLease: baseline.permissions.own_lease }),
      ...(baseline.permissions.own_run === null ? {} : { ownRun: baseline.permissions.own_run }) });
    const current = stableSnapshot(settings, true);
    // Immutable permissions and the original baseline survive verification.
    return compare(baseline, current, settings);
  } catch (error) { return failure(error); }
}
function main(argv = process.argv.slice(2)) {
  let output;
  try {
    const options = { codeRoots: [], allowAppend: [], allowPublication: [] };
    let action = null, baselineFile = null, writerStopped = false;
    const fields = { '--owner': 'owner', '--mode': 'mode', '--out': 'out', '--own-lease': 'ownLease', '--own-run': 'ownRun' };
    const seen = new Set();
    for (let index = 0; index < argv.length; index++) {
      const flag = argv[index];
      if (flag === '--capture' || flag === '--verify') {
        if (action) fail('ação duplicada', true); action = flag;
        if (flag === '--verify') baselineFile = argv[++index];
      } else if (flag === '--writer-stopped') { if (writerStopped) fail('atestado duplicado', true); writerStopped = true; }
      else {
        const value = argv[++index];
        if (!value || value.startsWith('--')) fail('valor obrigatório', true);
        if (flag === '--code-root') options.codeRoots.push(value);
        else if (flag === '--allow-append') options.allowAppend.push(value);
        else if (flag === '--allow-publication') options.allowPublication.push(value);
        else if (fields[flag] && !seen.has(flag)) { options[fields[flag]] = value; seen.add(flag); }
        else fail('opção inválida ou duplicada', true);
      }
    }
    if (action === '--capture' && !writerStopped && options.out) {
      output = captureBaseline(options);
      if (output.ok) { const { baseline, ...rest } = output; output = { ...rest, captured: true, code_root_count: baseline.code_roots.length, mode: baseline.mode }; }
    } else if (action === '--verify' && baselineFile && !seen.size && !options.codeRoots.length && !options.allowAppend.length && !options.allowPublication.length) {
      let baseline;
      try { baseline = JSON.parse(bytes(path.resolve(baselineFile), SNAPSHOT_BYTES).toString('utf8')); }
      catch (error) { fail(error.guardDetail || 'baseline ilegível ou inválida'); }
      output = verifyBaseline(baseline, { writerStopped });
    } else fail('uso: --capture --owner <raiz> --code-root <raiz> --out <arquivo externo>, ou --verify <baseline> [--writer-stopped]', true);
  } catch (error) { output = failure(error); }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return output.exit_code;
}

module.exports = { captureBaseline, verifyBaseline, REASONS };
if (require.main === module) process.exitCode = main();
