'use strict';

// D4 rendered-block cap (M-20260811134201-controle-contexto-gsd / S01 T02).
//
// The cap is ADVISORY and lives on the RENDERED block: it reports, it never
// trims and never refuses. Two things have to stay true, and both are asserted
// here rather than argued in prose:
//   1. extracting renderLedgerBlock out of renderLedger changed no byte of the
//      rendered ledger (identity against a re-implemented expected shape);
//   2. `--write` over the cap still writes the fragment byte for byte as the
//      capless version would — the warning is a warning, not an edit.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ledger = require('./forge-ledger');
const projection = require('./forge-projection');

const CLI = path.join(__dirname, 'forge-ledger.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failed++; failures.push({ name, error }); console.log(`  ✗ ${name}`); }
}

function tmpCwd() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ledger-cap-'));
  fs.mkdirSync(ledger.ledgerDir(cwd), { recursive: true });
  return cwd;
}

function thinEntry(id) {
  return {
    id,
    title: `Thin ${id}`,
    completed_at: '2026-01-0'.concat(String(id.length % 9 + 1), 'T00:00:00Z'),
    slices: ['S01'],
    key_files: ['scripts/a.js'],
    key_decisions: ['keep it small'],
    body: '',
  };
}

function fatEntry(id) {
  return {
    id,
    title: `Fat ${id}`,
    completed_at: '2026-02-01T00:00:00Z',
    slices: ['S01', 'S02', 'S03'],
    key_files: Array.from({ length: 8 }, (_, i) => `scripts/file-${i}.js`),
    key_decisions: Array.from({ length: 6 }, (_, i) => `decision number ${i}`),
    body: '',
  };
}

function writeViaCli(cwd, entry) {
  const res = spawnSync(process.execPath, [CLI, '--write', '--cwd', cwd], {
    input: JSON.stringify(entry),
    encoding: 'utf8',
  });
  return res;
}

// ── 1. Extraction identity ────────────────────────────────────────────────────

test('renderLedger output equals header + renderLedgerBlock per entry (no second copy of the shape)', () => {
  const cwd = tmpCwd();
  const entries = ['M001', 'M002', 'M003'].map((id, i) => ({
    ...thinEntry(id),
    completed_at: `2026-01-0${i + 1}T00:00:00Z`,
  }));
  for (const entry of entries) ledger.writeFragment(cwd, entry);

  const rendered = projection.renderLedger(cwd);

  const expected = ['# Forge Project Ledger', ''];
  expected.push('> Compact record of completed milestones. Append-only. Never deleted.');
  expected.push('');
  for (const entry of entries) {
    const frag = ledger.parseFragment(fs.readFileSync(ledger.fragmentPath(cwd, entry.id), 'utf8'));
    expected.push(...projection.renderLedgerBlock(frag, entry.id));
  }

  assert.strictEqual(rendered, expected.join('\n'));
  assert.ok(rendered.includes('## M002'), 'sanity: the fixture actually rendered its entries');
});

test('renderLedgerBlock ends with the block separator it documents', () => {
  const block = projection.renderLedgerBlock(ledger.parseFragment(
    '---\nid: M001\ntitle: t\n---\n'
  ), 'M001');
  assert.deepStrictEqual(block.slice(-projection.LEDGER_BLOCK_SEPARATOR_LINES), ['', '---', '']);
  assert.strictEqual(projection.LEDGER_BLOCK_SEPARATOR_LINES, 3);
});

// ── 2. --write reports the cap ────────────────────────────────────────────────

test('--write over the cap prints over_cap:true with rendered_lines > 15 and exits 0', () => {
  const cwd = tmpCwd();
  const res = writeViaCli(cwd, fatEntry('M010'));
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.strictEqual(out.over_cap, true);
  assert.strictEqual(out.cap, 15);
  assert.ok(out.rendered_lines > 15, `expected > 15 rendered lines, got ${out.rendered_lines}`);
  assert.ok(/over the D4 cap/.test(res.stderr), `expected a stderr warning, got: ${JSON.stringify(res.stderr)}`);
  assert.ok(/M010/.test(res.stderr), 'the warning names the entry id');
});

test('--write within the cap prints over_cap:false and writes nothing to stderr', () => {
  const cwd = tmpCwd();
  const res = writeViaCli(cwd, thinEntry('M011'));
  assert.strictEqual(res.status, 0, `expected exit 0, got ${res.status}: ${res.stderr}`);
  const out = JSON.parse(res.stdout);
  assert.strictEqual(out.over_cap, false);
  assert.ok(out.rendered_lines <= 15, `expected <= 15, got ${out.rendered_lines}`);
  assert.strictEqual(res.stderr, '', `expected empty stderr, got: ${JSON.stringify(res.stderr)}`);
});

test('the envelope keeps path and created untouched (additive fields only)', () => {
  const cwd = tmpCwd();
  const first = JSON.parse(writeViaCli(cwd, fatEntry('M012')).stdout);
  assert.strictEqual(first.created, true);
  assert.strictEqual(first.path, ledger.fragmentPath(cwd, 'M012'));
  const second = JSON.parse(writeViaCli(cwd, fatEntry('M012')).stdout);
  assert.strictEqual(second.created, false, 'idempotent re-write still reports created:false');
  assert.strictEqual(second.over_cap, true, 'and still measures the block');
});

// ── 3. No trim ────────────────────────────────────────────────────────────────

test('the fragment written over the cap is byte-identical to the capless serialization', () => {
  const cwd = tmpCwd();
  const capless = tmpCwd();
  const entry = fatEntry('M013');

  // writeFragment is the capless path — the CLI measures AFTER calling it, so
  // these two files must agree byte for byte or something trimmed.
  ledger.writeFragment(capless, entry);
  const res = writeViaCli(cwd, entry);
  assert.strictEqual(res.status, 0);

  const viaCli = fs.readFileSync(ledger.fragmentPath(cwd, 'M013'));
  const viaLib = fs.readFileSync(ledger.fragmentPath(capless, 'M013'));
  assert.strictEqual(Buffer.compare(viaCli, viaLib), 0, 'the cap must not rewrite a single byte');

  const text = viaCli.toString('utf8');
  for (const kf of entry.key_files) assert.ok(text.includes(kf), `key_file ${kf} survived`);
  for (const kd of entry.key_decisions) assert.ok(text.includes(kd), `key_decision "${kd}" survived`);
  for (const s of entry.slices) assert.ok(text.includes(s), `slice ${s} survived`);
});

test('measureRenderedBlock excludes the separator lines', () => {
  const cwd = tmpCwd();
  const entry = thinEntry('M014');
  ledger.writeFragment(cwd, entry);
  const content = fs.readFileSync(ledger.fragmentPath(cwd, 'M014'), 'utf8');
  const measured = ledger.measureRenderedBlock(content, 'M014');
  const block = projection.renderLedgerBlock(ledger.parseFragment(content), 'M014');
  assert.strictEqual(measured, block.length - projection.LEDGER_BLOCK_SEPARATOR_LINES);
  assert.strictEqual(ledger.LEDGER_LINE_CAP, 15);
});

if (failed) {
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error.stack}`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} ledger cap tests passed`);
}
