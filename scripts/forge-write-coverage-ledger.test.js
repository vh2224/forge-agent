#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mod = require('./forge-write-coverage-ledger.js');
let passed = 0; let failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); } }
function assert(value, message) { if (!value) throw new Error(message); }
function eq(actual, expected, message) { if (actual !== expected) throw new Error(`${message}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`); }
function fixture() { const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-write-ledger-')); fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true }); return cwd; }
function git(cwd, args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); }
function report(overrides) { return { generated_at: '2026-08-20T00:00:00.000Z', vcs: 'git', verdict: 'GO', coverage: 1, coverage_mean_per_unit: 1, totals: { written: 2, declared_hits: 2 }, units_considered: 2, units_measured: 2, skipped: [], instrument_warning: false, reconciliation: { units: { balances: true }, commits: { balances: true }, refs: [{ balances: true }] }, thresholds: { go: 0.9, rescope: 0.7 }, exit_reason: null, ...(overrides || {}) }; }

test('snapshot compacto preserva veredito, reconciliação e milestone', () => {
  const row = mod.compactRecord(report(), 'M123', { sourceHead: 'abc' });
  eq(row.milestone, 'M123', 'milestone'); eq(row.verdict, 'GO', 'veredito'); eq(row.reconciliation_balances.refs, true, 'refs');
  assert(!('units' in row), 'linhas detalhadas não inflam o ledger'); assert(/^[a-f0-9]{64}$/.test(row.measurement_id), 'identidade determinística');
});
test('proveniência usa a branch registrada da run, não o HEAD do workspace', () => {
  const cwd = fixture(); git(cwd, ['init', '-q', '--initial-branch=master']); git(cwd, ['config', 'user.email', 't@example.com']); git(cwd, ['config', 'user.name', 'T']);
  fs.writeFileSync(path.join(cwd, 'base.txt'), 'base'); git(cwd, ['add', 'base.txt']); git(cwd, ['commit', '-q', '-m', 'base']);
  git(cwd, ['branch', 'forge/custom-run']); const master = git(cwd, ['rev-parse', 'HEAD']);
  git(cwd, ['checkout', '-q', 'forge/custom-run']); fs.writeFileSync(path.join(cwd, 'branch.txt'), 'branch'); git(cwd, ['add', 'branch.txt']); git(cwd, ['commit', '-q', '-m', 'branch']); const branch = git(cwd, ['rev-parse', 'HEAD']); git(cwd, ['checkout', '-q', 'master']);
  const runsDir = path.join(cwd, '.gsd', 'forge', 'runs'); fs.mkdirSync(runsDir, { recursive: true }); fs.writeFileSync(path.join(runsDir, 'M123.json'), JSON.stringify({ id: 'M123', branch: 'forge/custom-run' }));
  const revision = mod.sourceRevision(cwd, 'M123'); eq(revision.source_ref, 'forge/custom-run', 'ref registrada'); eq(revision.source_head, branch, 'sha da run'); assert(revision.source_head !== master, 'não usa master');
});
test('inconclusive é persistido como fato, nunca promovido a verde', () => {
  const row = mod.compactRecord(report({ verdict: 'inconclusive', coverage: null, units_measured: 0, exit_reason: 'nenhuma unidade medida' }), 'M124', { sourceHead: null });
  eq(row.verdict, 'inconclusive', 'veredito'); eq(row.coverage, null, 'ausência'); eq(row.exit_reason, 'nenhuma unidade medida', 'causa');
});
test('append é idempotente para a mesma medição e append-only para uma nova', () => {
  const cwd = fixture(); const a = mod.compactRecord(report(), 'M123', { sourceHead: 'abc' });
  const first = mod.appendRecord(cwd, a); const duplicate = mod.appendRecord(cwd, a);
  const b = mod.compactRecord(report({ totals: { written: 3, declared_hits: 2 }, coverage: 2 / 3 }), 'M123', { sourceHead: 'def' });
  const second = mod.appendRecord(cwd, b); const lines = fs.readFileSync(path.join(cwd, mod.LEDGER_RELATIVE), 'utf8').trim().split(/\r?\n/);
  eq(first.appended, true, 'primeira'); eq(duplicate.appended, false, 'retry'); eq(duplicate.reason, 'duplicate-measurement', 'razão'); eq(second.appended, true, 'nova'); eq(lines.length, 2, 'linhas');
});
test('linha corrompida impede append em vez de desaparecer do censo', () => {
  const cwd = fixture(); const file = path.join(cwd, mod.LEDGER_RELATIVE); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{quebrado}\n', 'utf8');
  let message = ''; try { mod.appendRecord(cwd, mod.compactRecord(report(), 'M123', { sourceHead: 'abc' })); } catch (e) { message = e.message; }
  assert(message.includes('linha 1'), 'corrupção nomeada'); eq(fs.readFileSync(file, 'utf8'), '{quebrado}\n', 'arquivo não alterado');
});
test('tail parcial é preservado e recuperado antes do próximo append', () => {
  const cwd = fixture(); const file = path.join(cwd, mod.LEDGER_RELATIVE); fs.mkdirSync(path.dirname(file), { recursive: true });
  const first = mod.compactRecord(report(), 'M123', { sourceHead: 'abc' });
  fs.writeFileSync(file, `${JSON.stringify(first)}\n{"measurement_id":"interrompido`, 'utf8');
  const second = mod.compactRecord(report({ coverage: 0.5 }), 'M124', { sourceHead: 'def' });
  mod.appendRecord(cwd, second);
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  eq(rows.length, 2, 'duas linhas válidas'); eq(rows[1].measurement_id, second.measurement_id, 'nova linha');
  const recovery = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.incomplete-'));
  eq(recovery.length, 1, 'tail preservado'); assert(fs.readFileSync(path.join(path.dirname(file), recovery[0]), 'utf8').includes('interrompido'), 'bytes recuperáveis');
});
test('JSON completo sem newline é reparado antes do próximo append', () => {
  const cwd = fixture(); const file = path.join(cwd, mod.LEDGER_RELATIVE); fs.mkdirSync(path.dirname(file), { recursive: true });
  const first = mod.compactRecord(report(), 'M123', { sourceHead: 'abc' });
  const second = mod.compactRecord(report({ coverage: 0.5 }), 'M124', { sourceHead: 'def' });
  fs.writeFileSync(file, JSON.stringify(first), 'utf8');
  mod.appendRecord(cwd, second);
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  eq(rows.length, 2, 'objetos permanecem em linhas separadas');
});
test('milestone inválido falha fechado antes de criar o ledger', () => {
  const cwd = fixture(); let threw = false; try { mod.recordCoverage(cwd, '../escape', { report: report(), sourceHead: 'abc' }); } catch { threw = true; }
  assert(threw, 'recusado'); assert(!fs.existsSync(path.join(cwd, mod.LEDGER_RELATIVE)), 'nenhum arquivo');
});
test('CLI sem milestone retorna erro nomeado', () => {
  const cwd = fixture(); const r = spawnSync(process.execPath, [path.join(__dirname, 'forge-write-coverage-ledger.js'), '--cwd', cwd], { encoding: 'utf8' });
  eq(r.status, 2, 'exit'); assert(r.stderr.includes('milestone inválido'), 'causa');
});
console.log(`\n${passed} passed, ${failed} failed`); if (failed) process.exit(1);
