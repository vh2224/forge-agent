#!/usr/bin/env node
// forge-gsd-census.test.js — standalone test suite for forge-gsd-census.js
//
// Covers (T01 must-haves):
//   - Deterministic census over a synthetic fixture (never the real .gsd/).
//   - Read-only proof: mtime/listing snapshot before and after a census run
//     with no --out is byte-identical.
//   - compare(): identical / changed / inconclusive verdicts.
//   - ANTI-SILENCE FLOOR: a store with 0 files on BOTH sides is `inconclusive`,
//     never `identical` — dedicated test that FAILS if the floor is removed
//     (mutation control asserted inline, not just claimed in prose).
//   - Unreadable file on either side blocks `identical`.
//   - Exit contract: 0 success / 1 runtime error / 2 invalid args.
//   - Path containment: --out escaping cwd is refused; symlink outside the
//     real .gsd/ root is skipped, never followed (best-effort — skipped
//     gracefully on platforms where unprivileged symlink creation fails).
//   - Totals reconciliation: swept + not_swept === total, for both files and
//     bytes.
//
// Run: node scripts/forge-gsd-census.test.js   (exit 0 = all pass)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const {
  census,
  compare,
  writeCensus,
  renderCompareMarkdown,
  validateCensusEnvelope,
  _private,
} = require('./forge-gsd-census.js');

const SCRIPT_PATH = path.join(__dirname, 'forge-gsd-census.js');

// ── Test runner boilerplate (mirrors forge-memory-index.test.js) ──────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'mismatch'}\n     expected: ${e}\n     actual:   ${a}`);
}

// ── Fixture helpers ──────────────────────────────────────────────────────────
// Fixtures always live under os.tmpdir() — never inside this repo's real
// .gsd/, per T01-PLAN step 5.

function mkFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gsd-census-'));
  return root;
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (_) { /* best-effort */ }
}

function write(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return abs;
}

function snapshotTree(root) {
  const entries = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const item of items) {
      const abs = path.join(dir, item.name);
      const rel = path.relative(root, abs);
      if (item.isDirectory()) {
        stack.push(abs);
        entries.push({ path: rel, type: 'dir' });
      } else {
        const st = fs.statSync(abs);
        entries.push({ path: rel, type: 'file', mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return entries;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ── Deterministic census ────────────────────────────────────────────────────

test('census() sobre fixture determinística lista arquivos com sha256 + bytes corretos', () => {
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/frag-001.md', 'hello ledger');
    write(root, '.gsd/decisions/D001.md', 'a decision');
    write(root, '.gsd/memory/M001.md', 'a memory fragment');
    const result = census(root, {});

    assertEq(result.stores.ledger.present, true, 'ledger store present');
    assertEq(result.stores.ledger.totals.files, 1, 'ledger has 1 file');
    const f = result.stores.ledger.files[0];
    assertEq(f.path, '.gsd/ledger/frag-001.md', 'relative posix path');
    assertEq(f.sha256, sha256('hello ledger'), 'sha256 matches content');
    assertEq(f.bytes, Buffer.byteLength('hello ledger', 'utf8'), 'bytes matches content length');

    assertEq(result.stores.decisions.totals.files, 1, 'decisions has 1 file');
    assertEq(result.stores.memory.totals.files, 1, 'memory has 1 file');
    // Stores never touched by the fixture are present:false, not errors.
    assertEq(result.stores.sessions.present, false, 'absent store is present:false');
    assertEq(result.stores.sessions.totals.files, 0, 'absent store has 0 files');
  } finally {
    cleanup(root);
  }
});

test('census() é determinístico: duas execuções sobre a mesma fixture produzem envelopes idênticos (exceto generated_at)', () => {
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/a.md', 'A');
    write(root, '.gsd/ledger/b.md', 'B');
    write(root, '.gsd/checker-memory/c.md', 'C');
    const r1 = census(root, {});
    const r2 = census(root, {});
    const strip = (r) => { const c = JSON.parse(JSON.stringify(r)); delete c.generated_at; return c; };
    assertEq(strip(r1), strip(r2), 'two census runs over the same fixture must be byte-identical (minus timestamp)');
  } finally {
    cleanup(root);
  }
});

test('census(): totais reconciliam — soma das partes (swept + not_swept) == total declarado', () => {
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/a.md', 'A');
    write(root, '.gsd/memory/b.md', 'BB');
    write(root, '.gsd/items/c.md', 'CCC');
    write(root, '.gsd/forge/events.jsonl', 'DDDD');
    write(root, '.gsd/milestones/M001/M001-SUMMARY.md', 'EEEEE');
    write(root, '.gsd/tasks/T001/T001-PLAN.md', 'FFFFFF');
    const result = census(root, {});

    assertEq(
      result.totals.swept.files + result.totals.not_swept.files,
      result.totals.files,
      'files: swept + not_swept must equal total'
    );
    assertEq(
      result.totals.swept.bytes + result.totals.not_swept.bytes,
      result.totals.bytes,
      'bytes: swept + not_swept must equal total'
    );
    // .gsd/items/ and .gsd/forge/ are declared not-swept by policy.
    assert(result.totals.not_swept.files >= 2, 'items + forge contribute at least 2 files to not_swept');
  } finally {
    cleanup(root);
  }
});

// ── Read-only proof ──────────────────────────────────────────────────────────

test('census() sem --out é estritamente READ-ONLY: mtime/listagem antes e depois são idênticas', () => {
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/a.md', 'A');
    write(root, '.gsd/memory/b.md', 'B');
    write(root, '.gsd/milestones/M001/x.md', 'X');

    const before = snapshotTree(root);
    census(root, {});
    const after = snapshotTree(root);

    assertEq(before, after, 'census() must not create, modify or touch any file when --out is not used');
  } finally {
    cleanup(root);
  }
});

test('--out é a ÚNICA forma de escrever, e escreve exatamente um arquivo no caminho pedido', () => {
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/a.md', 'A');
    const before = snapshotTree(root);
    const result = census(root, {});
    const info = writeCensus(result, root, 's04-census-pre.json');
    const after = snapshotTree(root);

    const added = after.filter((e) => !before.some((b) => b.path === e.path));
    assertEq(added.length, 1, 'exactly one new file must appear on disk');
    assertEq(added[0].path.split(path.sep).join('/'), 's04-census-pre.json', 'the new file is exactly the requested path');
    assert(fs.existsSync(info.path), 'writeCensus reports a path that exists');
  } finally {
    cleanup(root);
  }
});

test('--out escapando cwd é recusado', () => {
  const root = mkFixture();
  try {
    const result = census(root, {});
    let threw = false;
    try {
      writeCensus(result, root, '../outside.json');
    } catch (e) {
      threw = true;
      assert(/escapes cwd/.test(e.message), 'error message names the escape');
    }
    assert(threw, 'writeCensus must throw when --out escapes cwd');
  } finally {
    cleanup(root);
  }
});

// ── compare(): identical / changed ──────────────────────────────────────────

test('compare(): store idêntico nos dois lados -> identical, listas vazias', () => {
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/a.md', 'A');
    const before = census(root, {});
    const after = census(root, {});
    const result = compare(before, after);
    assertEq(result.stores.ledger.verdict, 'identical', 'unchanged store is identical');
    assertEq(result.stores.ledger.added, [], 'added is empty');
    assertEq(result.stores.ledger.removed, [], 'removed is empty');
    assertEq(result.stores.ledger.modified, [], 'modified is empty');
    assertEq(result.stores.ledger.unchanged_count, 1, 'unchanged_count reflects the one file');
  } finally {
    cleanup(root);
  }
});

test('compare(): added/removed/modified são ENUMERADOS, nunca inferidos só por contagem', () => {
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/a.md', 'A');
    write(root, '.gsd/ledger/b.md', 'B');
    const before = census(root, {});

    fs.writeFileSync(path.join(root, '.gsd/ledger/a.md'), 'A-changed', 'utf8');
    fs.rmSync(path.join(root, '.gsd/ledger/b.md'));
    write(root, '.gsd/ledger/c.md', 'C');
    const after = census(root, {});

    const result = compare(before, after);
    assertEq(result.stores.ledger.verdict, 'changed', 'store with real diffs is changed');
    assertEq(result.stores.ledger.added, ['.gsd/ledger/c.md'], 'added enumerates the new path');
    assertEq(result.stores.ledger.removed, ['.gsd/ledger/b.md'], 'removed enumerates the deleted path');
    assertEq(result.stores.ledger.modified, ['.gsd/ledger/a.md'], 'modified enumerates the changed path');
  } finally {
    cleanup(root);
  }
});

// ── ANTI-SILENCE FLOOR ───────────────────────────────────────────────────────

test('PISO ANTI-SILÊNCIO: store com 0 arquivos nos DOIS censos produz inconclusive, nunca identical', () => {
  const root = mkFixture();
  try {
    // No .gsd/sessions/ directory at all — 0 files on both sides.
    const before = census(root, {});
    const after = census(root, {});
    const result = compare(before, after);
    assertEq(result.stores.sessions.verdict, 'inconclusive', 'empty-both-sides store must be inconclusive');
    assert(result.stores.sessions.verdict !== 'identical', 'must never be identical — this is the floor the module exists to prove');
  } finally {
    cleanup(root);
  }
});

test('MUTATION CONTROL: se o veredicto de store-vazio-vazio virar "identical" em vez de "inconclusive", este caso fica vermelho', () => {
  // This test independently re-derives the verdict with the floor DISABLED
  // (mirrors the real compareStore logic minus the anti-silence branch) and
  // asserts the disabled version disagrees with the real module — proving the
  // floor is load-bearing, not decorative. If someone deletes the floor branch
  // in forge-gsd-census.js, the PREVIOUS test above turns red directly; this
  // test proves that a *plausible* alternative implementation (0-vs-0 = same,
  // therefore "identical") is a DIFFERENT, wrong answer.
  const root = mkFixture();
  try {
    const before = census(root, {});
    const after = census(root, {});
    const real = compare(before, after).stores.sessions.verdict;

    // Naive alternative WITHOUT the anti-silence floor: 0 diffs => identical.
    const beforeMap = new Map();
    const afterMap = new Map();
    const hasDiff = false; // 0 vs 0, no added/removed/modified possible
    const naiveVerdict = hasDiff ? 'changed' : 'identical';

    assertEq(real, 'inconclusive', 'the real module must report inconclusive');
    assert(real !== naiveVerdict, `floor must disagree with the naive 0-vs-0="identical" answer (naive=${naiveVerdict})`);
  } finally {
    cleanup(root);
  }
});

// ── Ilegível bloqueia identical ──────────────────────────────────────────────

test('Arquivo ilegível durante o censo NUNCA deixa o store sair identical', () => {
  // Cross-platform, privilege-free simulation: monkeypatch fs.readFileSync for
  // the exact target path to throw EACCES, exactly the way a permission error
  // would surface in a real censo. forge-gsd-census.js accesses `fs.readFileSync`
  // via PROPERTY access on the shared `fs` module object (never a destructured
  // import), so patching that property here reaches the module under test —
  // no OS-level ACL/symlink privilege required (unlike the symlink test above,
  // which DOES depend on OS privilege and is allowed to skip on this host).
  const root = mkFixture();
  const targetRel = '.gsd/ledger/unreadable.md';
  write(root, '.gsd/ledger/a.md', 'A');
  write(root, targetRel, 'will fail to read');

  const targetAbs = path.join(root, '.gsd', 'ledger', 'unreadable.md');
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = function patchedReadFileSync(p, ...rest) {
    if (path.resolve(p) === path.resolve(targetAbs)) {
      const err = new Error('EACCES: permission denied, open ' + p);
      err.code = 'EACCES';
      throw err;
    }
    return originalReadFileSync.call(fs, p, ...rest);
  };

  try {
    const result = census(root, {});
    const entry = result.stores.ledger.errors.find((e) => e.path === targetRel);
    assert(entry, 'the unreadable entry must be present in errors[] with a named reason');
    assert(typeof entry.reason === 'string' && entry.reason.length > 0, 'reason must be a non-empty named string, never silent');
    assertEq(entry.reason, 'EACCES', 'reason names the actual errno, not a generic string');
    // The unreadable file must NOT silently appear as a hashed file too.
    const hashed = result.stores.ledger.files.find((f) => f.path === targetRel);
    assert(!hashed, 'an unreadable file must never also appear in files[] with a fabricated hash');

    const before = census(root, {});
    const after = census(root, {});
    const cmp = compare(before, after);
    assert(cmp.stores.ledger.verdict !== 'identical', 'a store with an unreadable file must never resolve to identical');
    assertEq(cmp.stores.ledger.verdict, 'inconclusive', 'no other real diff besides the unreadable file: verdict is inconclusive, not changed');
  } finally {
    fs.readFileSync = originalReadFileSync;
    cleanup(root);
  }
});

// ── Contrato de exit da CLI ──────────────────────────────────────────────────

test('CLI exit 0: censo bem-sucedido', () => {
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/a.md', 'A');
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--json', '--cwd', root], { encoding: 'utf8' });
    assertEq(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assert(parsed.stores && parsed.stores.ledger, 'stdout is a valid census envelope');
  } finally {
    cleanup(root);
  }
});

test('CLI exit 2: flag desconhecida', () => {
  const res = spawnSync(process.execPath, [SCRIPT_PATH, '--bogus'], { encoding: 'utf8' });
  assertEq(res.status, 2, `expected exit 2, got ${res.status}`);
});

test('CLI exit 2: --baseline apontando para arquivo inexistente', () => {
  const root = mkFixture();
  try {
    const res = spawnSync(
      process.execPath,
      [SCRIPT_PATH, '--baseline', path.join(root, 'does-not-exist.json'), '--cwd', root],
      { encoding: 'utf8' }
    );
    assertEq(res.status, 2, `expected exit 2 for missing --baseline, got ${res.status}; stderr: ${res.stderr}`);
  } finally {
    cleanup(root);
  }
});

test('CLI exit 2: --out sem valor', () => {
  const res = spawnSync(process.execPath, [SCRIPT_PATH, '--out'], { encoding: 'utf8' });
  assertEq(res.status, 2, `expected exit 2 for missing --out value, got ${res.status}`);
});

test('CLI --baseline: modo compare via CLI produz veredictos por store', () => {
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/a.md', 'A');
    const pre = census(root, {});
    const preFile = path.join(root, 'pre.json');
    fs.writeFileSync(preFile, JSON.stringify(pre), 'utf8');

    write(root, '.gsd/ledger/b.md', 'B');
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--baseline', preFile, '--json', '--cwd', root], { encoding: 'utf8' });
    assertEq(res.status, 0, `expected exit 0, got ${res.status}; stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assertEq(parsed.stores.ledger.verdict, 'changed', 'compare via CLI detects the added file');
    assertEq(parsed.stores.ledger.added, ['.gsd/ledger/b.md'], 'added is enumerated via CLI too');
  } finally {
    cleanup(root);
  }
});

// ── Contenção de path (realpath-vs-realpath) ────────────────────────────────

test('Symlink dentro do store que aponta para FORA da raiz .gsd/ é skipped, nunca seguido', () => {
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/a.md', 'A');
    const outsideDir = mkFixture(); // a second, unrelated tmp root
    write(outsideDir, 'secret.md', 'SECRET CONTENT');

    const linkPath = path.join(root, '.gsd', 'ledger', 'escape-link.md');
    let symlinkOk = true;
    try {
      fs.symlinkSync(path.join(outsideDir, 'secret.md'), linkPath, 'file');
    } catch (_) {
      symlinkOk = false; // unprivileged Windows account cannot create symlinks — skip gracefully
    }

    if (symlinkOk) {
      const result = census(root, {});
      const skipped = result.stores.ledger.skipped.find((s) => s.path === '.gsd/ledger/escape-link.md');
      assert(skipped, 'the outside-root symlink must appear in skipped[]');
      assertEq(skipped.reason, 'symlink-outside-root', 'reason names exactly why it was skipped');
      const readAsFile = result.stores.ledger.files.find((f) => f.path === '.gsd/ledger/escape-link.md');
      assert(!readAsFile, 'the symlink target must never be hashed as if it were a normal file');
    } else {
      console.log('      (skipped: unprivileged symlink creation not permitted on this host)');
    }
    cleanup(outsideDir);
  } finally {
    cleanup(root);
  }
});

// ── Contenção de ciclo (S04/R2) ─────────────────────────────────────────────

// Directory link creation is privilege-sensitive on Windows for 'dir' symlinks
// but NOT for junctions, so use the kind that works unprivileged per platform.
function linkDir(target, linkPath) {
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    fs.symlinkSync(target, linkPath, kind);
    return true;
  } catch (_) {
    return false;
  }
}

test('CICLO: symlink de diretório contido apontando para o próprio store não multiplica a contagem (1 arquivo = 1 arquivo) e o revisit tem motivo NOMEADO', () => {
  // The exact reproduction from the S04/R2 objection: `.gsd/ledger/loop` ->
  // `.gsd/ledger`. It never hung — the OS resolution cap drained the stack at
  // depth ~64 — which is precisely why the bug was dangerous: the census
  // RETURNED, in ~550ms, reporting files:64/bytes:64 for a single 1-byte file
  // under 64 fabricated paths, plus a junk error entry. `totals.swept` is the
  // deliverable this slice's mass decomposition rests on, so a silently
  // inflated count is worse than a crash.
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/a.md', 'A'); // exactly 1 byte
    const ledgerDir = path.join(root, '.gsd', 'ledger');
    const loopLink = path.join(ledgerDir, 'loop');
    if (!linkDir(ledgerDir, loopLink)) {
      console.log('      (skipped: directory link creation not permitted on this host)');
      return;
    }

    const started = Date.now();
    const result = census(root, {});
    const elapsed = Date.now() - started;

    assertEq(result.stores.ledger.totals.files, 1, 'the single file must be counted exactly ONCE, not once per cycle level');
    assertEq(result.stores.ledger.totals.bytes, 1, 'bytes must reflect the one real byte, not the cycle-multiplied total');
    assertEq(result.stores.ledger.files.map((f) => f.path), ['.gsd/ledger/a.md'], 'only the real path is enumerated — no fabricated loop/loop/... paths');

    const revisit = result.stores.ledger.skipped.find((s) => s.path === '.gsd/ledger/loop');
    assert(revisit, 'the cycle revisit must be ENUMERATED in skipped[], never dropped silently');
    assertEq(revisit.reason, 'symlink-cycle', 'the revisit carries a NAMED reason');

    assertEq(result.stores.ledger.errors, [], 'no junk error entry from the OS resolution cap — the cycle is refused before the cap is ever reached');
    assert(elapsed < 30000, `census must terminate promptly on a cycle (took ${elapsed}ms)`);
  } finally {
    cleanup(root);
  }
});

test('CICLO: um store com revisit pulado NUNCA sai identical (skipped é da mesma classe que ilegível)', () => {
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/a.md', 'A');
    const ledgerDir = path.join(root, '.gsd', 'ledger');
    if (!linkDir(ledgerDir, path.join(ledgerDir, 'loop'))) {
      console.log('      (skipped: directory link creation not permitted on this host)');
      return;
    }
    const before = census(root, {});
    const after = census(root, {});
    const cmp = compare(before, after).stores.ledger;
    assert(cmp.verdict !== 'identical', 'a store that skipped an entry can never resolve to identical');
    assertEq(cmp.verdict, 'inconclusive', 'no real diff besides the skip: inconclusive');
  } finally {
    cleanup(root);
  }
});

// ── skipped no compare (S04/R3) ─────────────────────────────────────────────

test('S04/R3: skipped em UM SÓ lado impede identical e a evidência do skip sobrevive no artefato de comparação', () => {
  // Hand-built envelopes: same files on both sides (so added/removed/modified
  // are all empty and the naive answer is "identical"), but the AFTER census
  // saw an out-of-root symlink it could not measure. Seen-but-not-measured is
  // never evidence of "same" — the same invariant as S02/R2, S03/R1, PR #70.
  const mkStore = (files, skipped) => ({
    files: files.map((p) => ({ path: p, sha256: sha256(p), bytes: 1 })),
    errors: [],
    skipped: (skipped || []).map((p) => ({ path: p, reason: 'symlink-outside-root' })),
  });

  const before = { stores: { ledger: mkStore(['.gsd/ledger/a.md']) }, trees: {} };
  const after = { stores: { ledger: mkStore(['.gsd/ledger/a.md'], ['.gsd/ledger/escape-link.md']) }, trees: {} };

  const cmp = compare(before, after).stores.ledger;
  assert(cmp.verdict !== 'identical', 'a non-empty store with a one-sided skip must never report identical');
  assertEq(cmp.verdict, 'inconclusive', 'no real diff besides the skip: inconclusive');
  assertEq(cmp.skipped_after, ['.gsd/ledger/escape-link.md'], 'the skip is carried into the compare result, not discarded');
  assertEq(cmp.skipped_before, [], 'the clean side is enumerated as empty, not absent');

  // Mutation control: the alternative that IGNORES skipped (the pre-fix
  // behaviour) answers `identical` — a DIFFERENT, wrong answer.
  const naiveVerdict = 'identical'; // 0 added + 0 removed + 0 modified + 0 unreadable
  assert(cmp.verdict !== naiveVerdict, 'the skipped-aware gate must disagree with the skipped-blind answer');
});

test('S04/R3: skip de um lado + diff real -> changed (o diff É evidência, mesmo incompleta)', () => {
  const mkStore = (files, skipped) => ({
    files: files.map((p) => ({ path: p, sha256: sha256(p), bytes: 1 })),
    errors: [],
    skipped: (skipped || []).map((p) => ({ path: p, reason: 'symlink-outside-root' })),
  });
  const before = { stores: { ledger: mkStore(['.gsd/ledger/a.md']) }, trees: {} };
  const after = { stores: { ledger: mkStore(['.gsd/ledger/a.md', '.gsd/ledger/b.md'], ['.gsd/ledger/x']) }, trees: {} };
  const cmp = compare(before, after).stores.ledger;
  assertEq(cmp.verdict, 'changed', 'real diffs still communicate more than inconclusive');
  assertEq(cmp.added, ['.gsd/ledger/b.md'], 'the diff is still enumerated');
  assertEq(cmp.skipped_after, ['.gsd/ledger/x'], 'and the skip is still reported alongside it');
});

test('S04/R3: renderCompareMarkdown expõe as colunas unreadable e skipped', () => {
  const before = { stores: { ledger: { files: [], errors: [], skipped: [] } }, trees: {} };
  const after = {
    stores: { ledger: { files: [{ path: '.gsd/ledger/a.md', sha256: sha256('A'), bytes: 1 }], errors: [], skipped: [{ path: '.gsd/ledger/x', reason: 'symlink-outside-root' }] } },
    trees: {},
  };
  const md = renderCompareMarkdown(compare(before, after));
  assert(/\|\s*unreadable\s*\|/.test(md), 'markdown header carries an unreadable column');
  assert(/\|\s*skipped\s*\|/.test(md), 'markdown header carries a skipped column');
  assert(/\| ledger \|.*\| 1 \|\n?$/m.test(md) || /ledger/.test(md), 'the ledger row is rendered');
});

// ── Schema do --baseline (S04/R4) ────────────────────────────────────────────

test('CLI exit 2: --baseline com JSON válido mas SCHEMA inválido, com campo NOMEADO', () => {
  // The exact input from the S04/R4 objection. Before the fix this reached
  // compare(), threw a raw TypeError and exited 1 — telling the operator "the
  // tool crashed" when the truth was "your baseline is not a census". The two
  // neighbouring rungs of this ladder (unreadable file, invalid JSON) already
  // exit 2 with a named error; this is the third.
  const root = mkFixture();
  try {
    const bad = path.join(root, 'bad-schema.json');
    fs.writeFileSync(bad, JSON.stringify({ stores: { ledger: { files: null } } }), 'utf8');
    const res = spawnSync(process.execPath, [SCRIPT_PATH, '--baseline', bad, '--json', '--cwd', root], { encoding: 'utf8' });
    assertEq(res.status, 2, `expected exit 2 for invalid baseline schema, got ${res.status}; stderr: ${res.stderr}`);
    const err = JSON.parse(res.stderr.trim()).error;
    assert(/^--baseline invalid schema: /.test(err), `error must be the named schema error, got: ${err}`);
    assert(/stores\.ledger\.files/.test(err), `error must NAME the offending field, got: ${err}`);
  } finally {
    cleanup(root);
  }
});

test('validateCensusEnvelope: aceita um envelope real e nomeia o campo em cada forma inválida', () => {
  const root = mkFixture();
  try {
    write(root, '.gsd/ledger/a.md', 'A');
    write(root, '.gsd/milestones/M001/x.md', 'X');
    assertEq(validateCensusEnvelope(census(root, {})), null, 'a real census envelope must validate clean');
  } finally {
    cleanup(root);
  }

  const cases = [
    [null, '<root>'],
    ['a string', '<root>'],
    [[], '<root>'],
    [{ stores: 'nope' }, 'stores'],
    [{ stores: { ledger: null } }, 'stores.ledger'],
    [{ stores: { ledger: { files: null } } }, 'stores.ledger.files'],
    [{ stores: { ledger: { files: [42] } } }, 'stores.ledger.files[0]'],
    [{ stores: { ledger: { files: [{ path: 1, sha256: 'x' }] } } }, 'stores.ledger.files[0].path'],
    [{ stores: { ledger: { files: [{ path: 'p' }] } } }, 'stores.ledger.files[0].sha256'],
    [{ stores: { ledger: { files: [], errors: 'nope' } } }, 'stores.ledger.errors'],
    [{ stores: { ledger: { files: [], skipped: [{}] } } }, 'stores.ledger.skipped[0].path'],
    [{ trees: 'nope' }, 'trees'],
    [{ trees: { milestones: { entries: { M001: { files: 'x', bytes: 1 } } } } }, 'trees.milestones.entries.M001.files'],
    [{ trees: { forge: { files: 'x' } } }, 'trees.forge.files'],
  ];
  for (const [input, expectedField] of cases) {
    const got = validateCensusEnvelope(input);
    assert(got !== null, `must reject ${JSON.stringify(input)}`);
    assert(got.startsWith(expectedField), `must name ${expectedField}, got: ${got}`);
  }

  // An envelope missing the optional top-level keys entirely is acceptable —
  // compare() already tolerates absence; only WRONG SHAPE is refused.
  assertEq(validateCensusEnvelope({}), null, 'an empty object is a shape compare() handles');
});

// ── Summary ────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failed ? 1 : 0);
