#!/usr/bin/env node
'use strict';

// Contract tests for the single formulation of "is this destination ours?".
//
// The defect being closed: ownership proof lived INSIDE the file, so a format
// without comment syntax could never carry it and froze on first divergence
// while every run reported success. The digest rung is the proof that does not
// need the file's cooperation.

const assert = require('assert');
const ownership = require('./forge-projection-ownership');

let passed = 0;
function test(name, fn) { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }

try {
  // ── digest ────────────────────────────────────────────────────────────────

  test('line endings are not content — CRLF and LF digest identically', () => {
    assert.strictEqual(
      ownership.digest('a\r\nb\r\n'),
      ownership.digest('a\nb\n'),
      'um checkout com autocrlf reportaria todo destino como editado pelo operador',
    );
  });

  test('different content digests differently — the probe is not constant', () => {
    assert.notStrictEqual(ownership.digest('a\n'), ownership.digest('b\n'));
  });

  // ── decide: the ladder, rung by rung ──────────────────────────────────────

  test('nothing on disk is ours — a fresh install always projects', () => {
    for (const current of [null, undefined]) {
      const v = ownership.decide({ current, recordedDigest: undefined, markerPresent: false });
      assert.deepStrictEqual(v, { ours: true, basis: 'absent' });
    }
  });

  test('a marked file stays ours — the pre-existing rung is never narrowed', () => {
    const v = ownership.decide({ current: 'qualquer coisa', markerPresent: true });
    assert.strictEqual(v.ours, true);
    assert.strictEqual(v.basis, 'marker');
  });

  test('THE FIX: an unmarked file whose bytes match the record is ours', () => {
    const body = '{"schema":1}\n';
    const v = ownership.decide({
      current: body,
      recordedDigest: ownership.digest(body),
      markerPresent: false,
    });
    assert.strictEqual(v.ours, true, 'JSON sem marcador continua congelando');
    assert.strictEqual(v.basis, 'digest');
  });

  test('an unmarked file whose bytes DIFFER from the record is not ours', () => {
    const v = ownership.decide({
      current: '{"schema":1,"editado":true}\n',
      recordedDigest: ownership.digest('{"schema":1}\n'),
      markerPresent: false,
    });
    assert.strictEqual(v.ours, false, 'edição do operador seria sobrescrita');
    assert.strictEqual(v.basis, null);
  });

  test('an unmarked file with NO record is not ours — absence of proof is not proof', () => {
    const v = ownership.decide({ current: 'legado\n', recordedDigest: undefined, markerPresent: false });
    assert.strictEqual(v.ours, false);
  });

  test('--migrate-legacy adopts regardless — the operator escape is unchanged', () => {
    const v = ownership.decide({
      current: 'legado sem marcador\n', recordedDigest: undefined, markerPresent: false, migrateLegacy: true,
    });
    assert.strictEqual(v.ours, true);
    assert.strictEqual(v.basis, 'migrate-legacy');
  });

  test('the digest can GRANT ownership but never revoke it — the documented non-change', () => {
    // A marked file whose bytes no longer match the record: hash-first would call
    // this an operator edit and refuse. That is defensible and deliberately NOT
    // what this module does, because it would turn files that update today into
    // conflicts. Asserted so the decision is on record, not accidental.
    const v = ownership.decide({
      current: 'editado mas ainda marcado\n',
      recordedDigest: ownership.digest('original\n'),
      markerPresent: true,
    });
    assert.strictEqual(v.ours, true);
    assert.strictEqual(v.basis, 'marker');
  });

  test('an empty-string digest record is ignored, not treated as a match', () => {
    const v = ownership.decide({ current: 'x\n', recordedDigest: '', markerPresent: false });
    assert.strictEqual(v.ours, false, 'um registro vazio virou passe livre');
  });

  // ── recordOf ──────────────────────────────────────────────────────────────

  test('recordOf keys by resolved path and digests the content', () => {
    const record = ownership.recordOf([{ destination: '/tmp/a/../a/x.json', content: '{"v":1}\n' }]);
    assert.deepStrictEqual(Object.keys(record), [ownership.keyFor('/tmp/a/x.json')]);
    assert.strictEqual(record[ownership.keyFor('/tmp/a/x.json')], ownership.digest('{"v":1}\n'));
  });

  test('a dry-run entry records nothing — bytes that were never written', () => {
    const record = ownership.recordOf([{ destination: '/tmp/x.json', content: '{}', dry_run: true }]);
    assert.deepStrictEqual(record, {},
      'registrar um dry-run faria a PRÓXIMA execução acreditar que é dona de um arquivo que nunca escreveu');
  });

  test('malformed entries are skipped without throwing', () => {
    const record = ownership.recordOf([null, {}, { destination: '/tmp/y' }, { content: 'só conteúdo' }]);
    assert.deepStrictEqual(record, {});
    assert.deepStrictEqual(ownership.recordOf(undefined), {});
  });

  process.stdout.write(`\nforge-projection-ownership: ${passed} passed\n`);
} catch (err) {
  process.stderr.write(`\nFAIL após ${passed} asserções\n${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
}
