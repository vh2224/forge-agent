#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_COLUMNS = ['id', 'surface', 'primitive', 'applicability', 'probe', 'e2e', 'verdict', 'action'];
const ALLOWED_APPLICABILITY = ['applicable', 'VCS-neutral', 'Git-only', 'macOS-only, VCS-neutral', 'limited by VCS'];
const ALLOWED_VERDICTS = ['verified', 'verified-neutral', 'declared-limitation'];
const EVIDENCE_SCHEMA = 'forge-svn-evidence/v1';
const ALLOWED_RESULTS = ['passed', 'failed', 'non-green'];

function evidenceReferences(root, value) {
  const matches = [...String(value).matchAll(/([A-Za-z0-9][A-Za-z0-9._/-]*\.(?:json|js|md))(?:#claim=([A-Za-z0-9._-]+))?/g)];
  return matches.map((match) => {
    const name = match[1];
    const candidates = name.includes('/')
      ? [path.join(root, name)]
      : [path.join(root, 'scripts', name), path.join(root, 'docs', 'svn-parity-evidence', name), path.join(root, name)];
    return { name, claim: match[2] || null, reference: match[0], resolved: candidates.find((candidate) => fs.existsSync(candidate)) || null };
  });
}

function validateEvidenceClaim(ref) {
  if (!ref.resolved || path.extname(ref.resolved) !== '.json') return null;
  let document;
  try { document = JSON.parse(fs.readFileSync(ref.resolved, 'utf8')); }
  catch (_) { return { reason: 'invalid-json' }; }
  if (document.schema !== EVIDENCE_SCHEMA || !document.claims || Array.isArray(document.claims) || typeof document.claims !== 'object') {
    return { reason: 'invalid-schema' };
  }
  const claimNames = Object.keys(document.claims);
  if (!ref.claim) return { reason: claimNames.length > 1 ? 'ambiguous-claim' : 'missing-claim-selector' };
  if (!Object.prototype.hasOwnProperty.call(document.claims, ref.claim)) return { reason: 'missing-claim' };
  const result = document.claims[ref.claim] && document.claims[ref.claim].result;
  if (!ALLOWED_RESULTS.includes(result)) return { reason: 'invalid-result' };
  return { result };
}

function parseRows(markdown) {
  return markdown.split(/\r?\n/).filter((line) => /^\| (?!ID \|)[^|]+ \|/.test(line) && !/^\|[-: ]+\|/.test(line)).map((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    return Object.fromEntries(REQUIRED_COLUMNS.map((column, index) => [column, (cells[index] || '').replace(/^`|`$/g, '')]));
  });
}

function audit(root, matrixPath) {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'forge-capabilities.json'), 'utf8'));
  const rows = parseRows(fs.readFileSync(matrixPath, 'utf8'));
  const ids = catalog.capabilities.map((item) => item.capability_id);
  const matrixIds = rows.map((row) => row.id);
  const missing = ids.filter((id) => !matrixIds.includes(id));
  const duplicates = [...new Set(matrixIds.filter((id, index) => matrixIds.indexOf(id) !== index))];
  const incomplete = rows.filter((row) => REQUIRED_COLUMNS.some((column) => !row[column] || row[column] === '-')).map((row) => row.id);
  const extras = matrixIds.filter((id) => !ids.includes(id));
  const invalid_applicability = rows.filter((row) => !ALLOWED_APPLICABILITY.includes(row.applicability)).map((row) => row.id);
  const invalid_verdict = rows.filter((row) => !ALLOWED_VERDICTS.includes(row.verdict)).map((row) => row.id);
  const unresolved_evidence = rows.flatMap((row) => {
    const byColumn = ['probe', 'e2e'].map((column) => ({ column, refs: evidenceReferences(root, row[column]) }));
    const unresolved = byColumn.flatMap(({ column, refs }) => refs.filter((ref) => !ref.resolved).map((ref) => ({ id: row.id, column, reference: ref.name })));
    // Probe labels may be stable gate names rather than paths. Do not parse their
    // prose; require at least one concrete, existing reference across probe/E2E.
    if (byColumn.every(({ refs }) => refs.length === 0)) unresolved.push({ id: row.id, column: 'evidence', reference: null });
    return unresolved;
  });
  const semantic_evidence_errors = rows.flatMap((row) => {
    const refs = ['probe', 'e2e'].flatMap((column) => evidenceReferences(root, row[column]).map((ref) => ({ column, ref })));
    const claims = refs.map(({ column, ref }) => ({ column, ref, validation: validateEvidenceClaim(ref) })).filter((item) => item.validation);
    const errors = claims.filter(({ validation }) => validation.reason).map(({ column, ref, validation }) => ({ id: row.id, column, reference: ref.reference, claim: ref.claim, reason: validation.reason }));
    if (errors.length > 0) return errors;
    if (row.verdict === 'verified' || row.verdict === 'verified-neutral') {
      const incompatible = claims.filter(({ validation }) => validation.result !== 'passed');
      if (incompatible.length > 0) return incompatible.map(({ column, ref, validation }) => ({ id: row.id, column, reference: ref.reference, claim: ref.claim, reason: `result-${validation.result}` }));
      if (!claims.some(({ validation }) => validation.result === 'passed')) return [{ id: row.id, column: 'evidence', reference: null, claim: null, reason: 'missing-passed-claim' }];
    }
    return [];
  });
  const ok = [missing, duplicates, incomplete, invalid_applicability, invalid_verdict, unresolved_evidence, semantic_evidence_errors].every((items) => items.length === 0);
  return { expected_ids: ids.length, observed_ids: matrixIds.filter((id) => ids.includes(id)).length, missing, duplicates, incomplete, invalid_applicability, invalid_verdict, unresolved_evidence, semantic_evidence_errors, additional_families: extras.length, extra_ids: extras, ok };
}

module.exports = { REQUIRED_COLUMNS, ALLOWED_APPLICABILITY, ALLOWED_VERDICTS, EVIDENCE_SCHEMA, ALLOWED_RESULTS, evidenceReferences, parseRows, audit };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const matrix = path.resolve(process.argv[2] || path.join(root, 'docs', 'svn-capability-matrix.md'));
  const result = audit(root, matrix);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exitCode = 1;
}
