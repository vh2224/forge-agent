#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_COLUMNS = ['id', 'surface', 'primitive', 'applicability', 'probe', 'e2e', 'verdict', 'action'];
const ALLOWED_APPLICABILITY = ['applicable', 'VCS-neutral', 'Git-only', 'macOS-only, VCS-neutral', 'limited by VCS'];
const ALLOWED_VERDICTS = ['verified', 'verified-neutral', 'declared-limitation'];

function evidenceReferences(root, value) {
  const names = String(value).match(/[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:js|md|json)\b/g) || [];
  return names.map((name) => {
    const candidates = name.includes('/')
      ? [path.join(root, name)]
      : [path.join(root, 'scripts', name), path.join(root, 'docs', 'svn-parity-evidence', name), path.join(root, name)];
    return { name, resolved: candidates.find((candidate) => fs.existsSync(candidate)) || null };
  });
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
  return { expected_ids: ids.length, observed_ids: matrixIds.filter((id) => ids.includes(id)).length, missing, duplicates, incomplete, invalid_applicability, invalid_verdict, unresolved_evidence, additional_families: extras.length, extra_ids: extras, ok: missing.length === 0 && duplicates.length === 0 && incomplete.length === 0 && invalid_applicability.length === 0 && invalid_verdict.length === 0 && unresolved_evidence.length === 0 };
}

module.exports = { REQUIRED_COLUMNS, ALLOWED_APPLICABILITY, ALLOWED_VERDICTS, evidenceReferences, parseRows, audit };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const matrix = path.resolve(process.argv[2] || path.join(root, 'docs', 'svn-capability-matrix.md'));
  const result = audit(root, matrix);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exitCode = 1;
}
