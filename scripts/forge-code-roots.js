#!/usr/bin/env node
'use strict';

// Physical checkout identity and root-qualified paths. No caller/worker supplied
// identity grants access; every boundary measures it again before using a path.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const parallel = require('./forge-parallelism');
const must = require('./forge-must-haves');
const SCHEMA_VERSION = 2;
function fail(code, detail) { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code }); }
function digest(value) { return crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex'); }
function key(value) { const s = value.replace(/\\/g, '/'); return process.platform === 'win32' ? s.toLowerCase() : s; }
function within(root, file) { const r = key(root), f = key(file); return f === r || f.startsWith(`${r}/`); }
function realDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail('root-path-invalid');
  let real;
  try { real = fs.realpathSync.native(value); if (!fs.statSync(real).isDirectory()) fail('root-not-directory'); }
  catch (e) { fail('root-identity-unresolved', e.code); }
  return real;
}
function measureRoot(entry) {
  if (!entry || typeof entry.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(entry.id)) fail('root-id-invalid');
  const physical = realDirectory(entry.path);
  const vcs = require('./forge-vcs').detectVcs(physical);
  if (!['git', 'svn'].includes(vcs) || entry.vcs && entry.vcs !== vcs) fail('root-vcs-mismatch');
  const args = vcs === 'git' ? ['-C', physical, 'rev-parse', '--show-toplevel'] : ['info', '--show-item', 'wc-root', '--', physical + '@'];
  const probe = spawnSync(vcs, args, { cwd: physical, shell: false, windowsHide: true, encoding: 'utf8', timeout: 15000 });
  if (probe.status !== 0 || !probe.stdout.trim() || key(realDirectory(probe.stdout.trim())) !== key(physical)) fail('root-checkout-required');
  const stat = fs.statSync(physical, { bigint: true });
  const identity = { physical_path: key(physical), vcs, dev: String(stat.dev), ino: String(stat.ino), birthtime_ns: String(stat.birthtimeNs) };
  return { id: entry.id, path: physical, vcs, identity, identity_sha256: digest(identity) };
}
function validateContract(raw, options = {}) {
  if (!raw || raw.schema_version !== SCHEMA_VERSION || !Array.isArray(raw.code_roots) || !raw.code_roots.length || raw.code_roots.length > 14) fail('execution-contract-schema');
  const owner = realDirectory(raw.owner);
  if (options.owner && key(owner) !== key(realDirectory(options.owner))) fail('execution-owner-mismatch');
  const roots = raw.code_roots.map(measureRoot);
  if (new Set(roots.map(r => r.id)).size !== roots.length) fail('root-id-duplicate');
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    if (within(roots[i].path, roots[j].path) || within(roots[j].path, roots[i].path)) fail('roots-overlap-or-alias');
  }
  if (!roots.some(r => r.id === raw.primary_root_id)) fail('primary-root-invalid');
  if (options.revalidate) for (const root of roots) {
    const old = raw.code_roots.find(r => r.id === root.id);
    if (old.identity_sha256 !== root.identity_sha256) fail('root-identity-changed');
  }
  return { schema_version: SCHEMA_VERSION, owner, primary_root_id: raw.primary_root_id, code_roots: roots };
}
function singleContract(owner, cwd) {
  return validateContract({ schema_version: 2, owner, primary_root_id: 'primary', code_roots: [{ id: 'primary', path: cwd }] });
}
function assertRelative(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /[:\r\n]/.test(value)) fail('root-relative-path-required');
  const portable = value.replace(/\\/g, '/');
  if (portable.startsWith('/') || portable.split('/').some(p => p === '..' || /[. ]$/.test(p) && p !== '.') || /[\[\]{}!]/.test(portable)) fail('root-path-invalid');
  const normalized = parallel.canonicalizeClaimPath(portable);
  if (normalized === '.' || normalized.split('/').some(p => ['.gsd', '.git', '.svn'].includes(p.toLowerCase()))) fail('root-path-protected');
  return normalized;
}
function resolvePath(contract, value, options = {}) {
  let id, relative;
  if (typeof value === 'object' && value && !Array.isArray(value)) { id = value.root_id; relative = value.path; }
  else if (typeof value === 'string') {
    const at = value.indexOf('::');
    if (at >= 0) { id = value.slice(0, at); relative = value.slice(at + 2); }
    else if (options.legacy && contract.code_roots.length === 1) { id = contract.primary_root_id; relative = value; }
    else fail('root-qualified-path-required');
  } else fail('root-path-invalid');
  const root = contract.code_roots.find(r => r.id === id);
  if (!root) fail('root-unknown');
  relative = assertRelative(relative);
  // A missing descendant is safe only after resolving every existing ancestor.
  // Globs stop the walk at the last literal ancestor; concrete deltas repeat it.
  let current = root.path;
  for (const part of relative.split('/')) {
    if (/[*?]/.test(part)) break;
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
    if (stat.isSymbolicLink()) fail('root-path-link');
    if (!within(root.path, fs.realpathSync.native(current))) fail('root-path-escape');
  }
  return { root_id: id, path: relative, absolute: path.join(root.path, relative), identity_sha256: root.identity_sha256 };
}
function wire(entry) { return { root_id: entry.root_id, path: entry.path }; }
function qualified(entry) { return `${entry.root_id}::${entry.path}`; }
function covers(claim, output) { return claim.root_id === output.root_id && parallel.claimPathMatches(claim.path, output.path); }
function validatePlan(content, contract, options = {}) {
  const fields = must.parseExecutionFields(content);
  if (!must.hasStructuredMustHaves(content)) fail('execution-plan-must-haves-required');
  const parsed = must.parseMustHaves(content);
  for (const field of ['depends', 'writes', 'expected_output']) if (!Array.isArray(fields[field])) fail(`execution-plan-${field}-required`);
  if (!fields.writes.length) fail('execution-writes-required');
  if (!parsed.truths.length || !fields.expected_output.length) fail('execution-plan-criteria-required');
  const v2 = fields.roots_schema !== undefined;
  if (v2 && String(fields.roots_schema) !== '2') fail('execution-plan-roots-schema');
  if (!v2 && contract.code_roots.length !== 1) fail('legacy-multiroot-refused');
  if (v2) {
    const declared = validateContract({ schema_version: 2, owner: contract.owner, primary_root_id: fields.primary_root_id, code_roots: fields.code_roots });
    if (digest(declared) !== digest(contract)) fail('execution-plan-roots-mismatch');
  }
  const resolve = p => resolvePath(contract, p, { legacy: !v2 });
  const writes = fields.writes.map(resolve), outputs = fields.expected_output.map(resolve);
  const artifacts = parsed.artifacts.map(a => ({ ...a, ...wire(resolve(a.path)) }));
  for (const output of [...outputs, ...artifacts]) if (!writes.some(c => covers(c, output))) fail('execution-output-outside-writes');
  for (const link of parsed.key_links) { resolve(link.from); resolve(link.to); }
  return { schema_version: v2 ? 2 : 1, contract, writes: writes.map(wire), outputs: outputs.map(wire), artifacts, must_haves: parsed,
    plan_sha256: digest(content), contract_sha256: digest(contract), ...(options.capabilities ? { capabilities_sha256: digest(options.capabilities) } : {}) };
}
function normalizeAbsolutePaths(content, contract) {
  contract = validateContract(contract, { revalidate: true });
  // Rewrite only path-bearing fields. Truths and prose are never interpreted as
  // authority and are byte-preserved, including quoted absolute examples.
  const fields = must.parseExecutionFields(content), parsed = must.parseMustHaves(content), mapping = [];
  const v2 = contract.code_roots.length > 1 || fields.roots_schema !== undefined;
  const convert = value => {
    if (typeof value !== 'string') fail('migration-path-invalid');
    if (!path.isAbsolute(value)) {
      if (v2 && !value.includes('::')) fail('migration-relative-root-ambiguous');
      return value;
    }
    const candidates = contract.code_roots.filter(r => within(r.path, path.resolve(value)));
    if (candidates.length !== 1) fail('absolute-path-ambiguous');
    const entry = resolvePath(contract, { root_id: candidates[0].id, path: path.relative(candidates[0].path, value) });
    const normalized = v2 ? qualified(entry) : entry.path;
    if (!mapping.some(row => row.original === value)) mapping.push({ original: value, normalized });
    return normalized;
  };
  let normalized = content;
  for (const field of ['writes', 'expected_output']) {
    if (!Array.isArray(fields[field])) fail(`execution-plan-${field}-required`);
    const values = fields[field].map(convert);
    normalized = normalized.replace(new RegExp(`^${field}:.*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*`, 'm'),
      `${field}:\n${values.map(p => `  - ${JSON.stringify(p)}`).join('\n')}`);
  }
  const originalPaths = new Set([...parsed.artifacts.map(a => a.path), ...parsed.key_links.flatMap(l => [l.from, l.to])]);
  normalized = normalized.replace(/^(\s+(?:- )?(?:path|from|to):\s*)([^\r\n]+)$/gm, (line, prefix, value) => {
    const unquoted = value.trim().replace(/^["']|["']$/g, '');
    return originalPaths.has(unquoted) ? prefix + JSON.stringify(convert(unquoted)) : line;
  });
  if (v2 && fields.roots_schema === undefined) {
    const declaration = `roots_schema: 2\nprimary_root_id: ${contract.primary_root_id}\ncode_roots:\n`
      + contract.code_roots.map(r => `  - id: ${r.id}\n    path: ${JSON.stringify(r.path.replace(/\\/g, '/'))}\n    vcs: ${r.vcs}\n`).join('');
    normalized = normalized.replace(/^---\r?\n/, `---\n${declaration}`);
  }
  validatePlan(normalized, contract);
  if (JSON.stringify(parsed.truths) !== JSON.stringify(must.parseMustHaves(normalized).truths)) fail('migration-criteria-changed');
  return { content: normalized, schema_version: v2 ? 2 : 1, original_sha256: digest(content), normalized_sha256: digest(normalized), mapping };
}
function claimGroups(claim) {
  if (claim?.schema_version === 2) {
    const contract = validateContract(claim.execution_contract, { revalidate: true });
    if (!Array.isArray(claim.paths) || !claim.paths.length) fail('execution-writes-required');
    const paths = claim.paths.map(p => resolvePath(contract, p));
    return contract.code_roots.map(root => ({ ...root, paths: paths.filter(p => p.root_id === root.id).map(p => p.path) })).filter(g => g.paths.length);
  }
  if (claim?.schema_version !== undefined && claim.schema_version !== 1) fail('claim-schema-unsupported');
  if (!claim?.code_dir || !Array.isArray(claim.paths) || !claim.paths.length) fail('claim-identity-unknown');
  const root = measureRoot({ id: 'primary', path: claim.code_dir });
  return [{ ...root, paths: claim.paths.map(assertRelative) }];
}
module.exports = { SCHEMA_VERSION, digest, key, within, realDirectory, measureRoot, validateContract, singleContract, resolvePath, assertRelative,
  wire, qualified, covers, validatePlan, normalizeAbsolutePaths, claimGroups };
if (require.main === module) {
  try {
    const args = process.argv.slice(2), contract = validateContract(JSON.parse(fs.readFileSync(args[args.indexOf('--contract') + 1], 'utf8')));
    const plan = args.includes('--plan') ? fs.readFileSync(args[args.indexOf('--plan') + 1], 'utf8') : null;
    const result = plan ? args.includes('--normalize') ? normalizeAbsolutePaths(plan, contract) : validatePlan(plan, contract) : contract;
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (e) { process.stderr.write(JSON.stringify({ reason_code: e.code || 'root-contract-invalid', message: e.message }) + '\n'); process.exitCode = 2; }
}
