#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ignore = require('./forge-ignore.js');
const vcs = require('./forge-vcs.js');
const svnLab = require('./forge-svn-lab.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}
function run(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
}
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-'));
  run(cwd, ['init', '-q']);
  // Pin EOL handling at the repo level (repo config outranks the runner's
  // global config): the windows-latest CI image ships Git for Windows with a
  // global core.autocrlf=true, so every checkout-based restore rewrote the LF
  // fixture bytes as CRLF and the byte-for-byte asserts below (e.g.
  // restoreAndRemove comparing against 'before\n') were red on Windows only.
  //
  // KNOWN PRODUCTION LIMITATION, now DECLARED rather than tracked (#104,
  // decided 2026-08-19 as option 3): forge-vcs.js restores via plain
  // `git checkout`, so for a real Windows user with autocrlf=true the working
  // tree comes back CRLF-normalized, not with the pre-reset bytes. Passing
  // `-c core.autocrlf=false` on the restore was REJECTED — it would hand that
  // user LF where the rest of their tree has CRLF, in a recovery path. The
  // behaviour stays; what changed is that `eolRestoreFidelity` now SAYS so at
  // reset time instead of the claim living only in comments like this one.
  // This pin still only makes the test's own fixture deterministic.
  run(cwd, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(cwd, 'modified.txt'), 'before\n');
  fs.writeFileSync(path.join(cwd, 'deleted.txt'), 'delete me\n');
  run(cwd, ['add', '.']);
  run(cwd, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid', 'commit', '-qm', 'init']);
  return cwd;
}

// ── S02 review R1 — parseSvnLogXml fail-closed, the four measured inputs ────
//
// These four inputs were EXECUTED during the S02 review and all four answered
// `{ ok: true }` with a silently shrunken answer. Each assert below names the
// input it exists for; the fix in forge-vcs.js names the guard that closes it.
// A well-formed log is asserted alongside, so a parser that simply refuses
// everything cannot pass this block.
//
// Placed HERE, ahead of the git fixtures, deliberately: this suite aborts on
// the first throw (no per-test catch), and at the time it carried a
// PRE-EXISTING failure further down (the CRLF/EOL class — since closed by
// pinning core.autocrlf=false in fixture(); the placement rationale stands
// for any future fixture regression). Appended at the end, these asserts
// would never execute — a test that cannot run is not coverage.

const WELL_FORMED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<log>',
  '<logentry revision="12">',
  '<msg>feat(S04/T01): trabalho</msg>',
  '<paths><path action="M">/trunk/a.txt</path><path action="A">/trunk/b.txt</path></paths>',
  '</logentry>',
  '</log>',
].join('\n');

test('R1 log bem-formado continua parseando (os guards não são recusa geral)', () => {
  const got = vcs.parseSvnLogXml(WELL_FORMED);
  assert.strictEqual(got.ok, true, JSON.stringify(got));
  assert.strictEqual(got.revisions.length, 1);
  assert.strictEqual(got.revisions[0].rev, 12);
  assert.deepStrictEqual(got.revisions[0].paths.map((p) => p.path), ['/trunk/a.txt', '/trunk/b.txt']);
});

test('R1 log vazio é um vazio honesto, nunca malformed', () => {
  assert.deepStrictEqual(vcs.parseSvnLogXml('<?xml version="1.0"?>\n<log>\n</log>\n'), { ok: true, revisions: [] });
});

test('R1 <path> não fechado dentro de <paths> fechado é malformed, não revisão com zero paths', () => {
  // Medido ANTES do fix: { ok: true, revisions: [{ rev: 1, paths: [] }] } —
  // um arquivo escrito vira um arquivo que ninguém escreveu.
  const bad = '<log><logentry revision="1"><paths><path action="M">/trunk/a.txt</paths></logentry></log>';
  assert.deepStrictEqual(vcs.parseSvnLogXml(bad), { ok: false, error: 'svn-log-malformed' });
});

test('R1 revision="12junk" é malformed, não a revisão 12', () => {
  // Medido ANTES do fix: rev 12 — parseInt faz prefix-parse e Number.isFinite nunca dispara.
  const bad = '<log><logentry revision="12junk"><msg>x</msg></logentry></log>';
  assert.deepStrictEqual(vcs.parseSvnLogXml(bad), { ok: false, error: 'svn-log-malformed' });
});

test('R1 stream truncado é malformed — "não consegui perguntar" nunca vira "não há"', () => {
  const bad = '<?xml version="1.0"?>\n<log>\n<logentry revision="1">\n<msg>feat(S04/T01): x</msg>\n<paths><path action="M">/tr';
  assert.deepStrictEqual(vcs.parseSvnLogXml(bad), { ok: false, error: 'svn-log-malformed' });
});

test('R1 lixo puro é malformed, nunca um log vazio', () => {
  assert.deepStrictEqual(vcs.parseSvnLogXml('total garbage not xml'), { ok: false, error: 'svn-log-malformed' });
});

test('R1 entry deixada FORA de todo bloco casado é resíduo, não uma resposta mais curta', () => {
  // Uma entry completa mais uma não fechada: devolver `revisions.length === 1`
  // aqui é exatamente o encolhimento silencioso que este parser diz não fazer.
  const bad = [
    '<log>',
    '<logentry revision="1"><msg>ok</msg></logentry>',
    '<logentry revision="2"><msg>truncada',
    '</log>',
  ].join('\n');
  assert.deepStrictEqual(vcs.parseSvnLogXml(bad), { ok: false, error: 'svn-log-malformed' });
});

// ── fim do bloco R1; o restante da suíte segue byte-idêntico ──────────────

test('baselineId succeeds in a fixture and failures are normalized', () => {
  const cwd = fixture();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-empty-'));
  try {
    const baseline = vcs.baselineId(cwd);
    assert.strictEqual(baseline.ok, true);
    assert.match(baseline.id, /^[0-9a-f]{40}$/);
    const failed = vcs.baselineId(empty);
    assert.deepStrictEqual(failed.vcs, 'git');
    assert.strictEqual(failed.ok, false);
    assert(failed.error.length > 0);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true }); }
});

test('captureDirty includes gsd by default and excludes it by predicate', () => {
  const cwd = fixture();
  try {
    fs.mkdirSync(path.join(cwd, '.gsd'));
    fs.writeFileSync(path.join(cwd, '.gsd', 'x.json'), '{}\n');
    assert(vcs.captureDirty(cwd).entries.some(entry => entry.path === '.gsd/x.json'));
    assert(!vcs.captureDirty(cwd, { exclude: vcs.isGsdPath }).entries.some(entry => entry.path === '.gsd/x.json'));
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('postChanges classifies added modified and deleted files', () => {
  const cwd = fixture();
  try {
    const baseline = vcs.baselineId(cwd).id;
    fs.writeFileSync(path.join(cwd, 'modified.txt'), 'after\n');
    fs.unlinkSync(path.join(cwd, 'deleted.txt'));
    fs.writeFileSync(path.join(cwd, 'new.txt'), 'new\n');
    const entries = new Map(vcs.postChanges(cwd, baseline).entries.map(entry => [entry.path, entry.status]));
    assert.strictEqual(entries.get('modified.txt'), 'M');
    assert.strictEqual(entries.get('deleted.txt'), 'D');
    assert.strictEqual(entries.get('new.txt'), 'A');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('hashPath preserves missing-file sentinel', () => {
  const cwd = fixture();
  try { assert.deepStrictEqual(vcs.hashPath(cwd, 'absent.txt'), { vcs: 'git', ok: true, hash: null }); }
  finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('restoreAndRemove restores modifications, removes additions, and guards overlap', () => {
  const cwd = fixture();
  try {
    const baseline = vcs.baselineId(cwd).id;
    fs.writeFileSync(path.join(cwd, 'modified.txt'), 'changed\n');
    fs.writeFileSync(path.join(cwd, 'new.txt'), 'new\n');
    const done = vcs.restoreAndRemove(cwd, baseline, { restore: ['modified.txt'], remove: ['new.txt'], overlap: [] });
    // `eol` is the #104 advisory. It is additive for readers that pick fields
    // (and for JSON consumers), but a deep-equality assert is NOT such a
    // reader — it sees every key, which is why this expectation carries it.
    // The fixture pins core.autocrlf=false, so the advisory is the silent one.
    assert.deepStrictEqual(done, {
      vcs: 'git',
      ok: true,
      restored: ['modified.txt'],
      removed: ['new.txt'],
      eol: { converts: false, autocrlf: 'false', source: 'config', message: null },
    });
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'modified.txt'), 'utf8'), 'before\n');
    assert.strictEqual(fs.existsSync(path.join(cwd, 'new.txt')), false);
    assert.throws(() => vcs.restoreAndRemove(cwd, baseline, { restore: [], remove: [], overlap: ['modified.txt'] }), /overlap is non-empty/);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('captureDirty degrades a single failed hash-object to null instead of aborting the snapshot (R1)', () => {
  const cwd = fixture();
  const subCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-sub-'));
  try {
    run(subCwd, ['init', '-q']);
    fs.writeFileSync(path.join(subCwd, 'sub.txt'), 'sub\n');
    run(subCwd, ['add', '.']);
    run(subCwd, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid', 'commit', '-qm', 'sub']);
    // A submodule gitlink is a real-world path where `git hash-object -- <dir>` fails
    // (it is a directory, not a blob) while `git status` still reports it dirty —
    // exactly the per-path failure R1 guards against.
    const add = spawnSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subCwd, 'sub'], { encoding: 'utf8' });
    assert.strictEqual(add.status, 0, add.stderr || 'submodule add failed');
    fs.writeFileSync(path.join(cwd, 'modified.txt'), 'also dirty\n');
    const result = vcs.captureDirty(cwd);
    assert.strictEqual(result.ok, true);
    const byPath = new Map(result.entries.map((entry) => [entry.path, entry.hash]));
    // The unhashable gitlink path degrades to null, but does NOT abort the snapshot —
    // the sibling dirty file is still present (this is what R1 restores).
    assert.strictEqual(byPath.get('sub'), null);
    assert(byPath.has('modified.txt'), 'sibling dirty path must survive the failed path');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(subCwd, { recursive: true, force: true });
  }
});

test('gitPostChanges treats copy differently from rename per copyOriginDeleted (R4)', () => {
  const cwd = fixture();
  try {
    run(cwd, ['config', 'diff.renames', 'copies']);
    // Copy detection needs a large-enough source AND the source modified in the same
    // diff (git's copy detector only searches modified/added files in the changeset,
    // not the whole tree, without --find-copies-harder — which the seam intentionally
    // does not pass).
    const big = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n';
    fs.writeFileSync(path.join(cwd, 'modified.txt'), big);
    run(cwd, ['add', '.']);
    run(cwd, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid', 'commit', '-qm', 'big-source']);
    const baseline = vcs.baselineId(cwd).id;
    fs.copyFileSync(path.join(cwd, 'modified.txt'), path.join(cwd, 'zcopy.txt'));
    fs.appendFileSync(path.join(cwd, 'modified.txt'), 'changed\n');
    run(cwd, ['add', '.']);
    const withDelete = new Map(vcs.postChanges(cwd, baseline).entries.map((entry) => [entry.path, entry.status]));
    assert.strictEqual(withDelete.get('zcopy.txt'), 'A');
    // Default (copyOriginDeleted unset -> true) matches the reset-engine semantics:
    // the copy origin is marked 'D' (inert there — restored identically from baseline).
    assert.strictEqual(withDelete.get('modified.txt'), 'D');
    const withoutDelete = new Map(
      vcs.postChanges(cwd, baseline, { copyOriginDeleted: false }).entries.map((entry) => [entry.path, entry.status])
    );
    assert.strictEqual(withoutDelete.get('zcopy.txt'), 'A');
    // Report-only consumers (xllm) must not see the copy origin falsely marked deleted.
    assert.notStrictEqual(withoutDelete.get('modified.txt'), 'D');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('unsupported vcs returns the normalized sentinel for every primitive', () => {
  const cwd = fixture();
  try {
    // Total return shapes are the R2 resolution from S02-REVIEW: even an
    // unsupported backend provides the primitive's data sentinel.
    const opts = { vcs: 'other' };
    assert.deepStrictEqual(vcs.baselineId(cwd, opts), { vcs: 'other', ok: false, id: null, error: 'vcs-unsupported:other' });
    assert.deepStrictEqual(vcs.hashPath(cwd, 'modified.txt', opts), { vcs: 'other', ok: false, hash: null, error: 'vcs-unsupported:other' });
    assert.deepStrictEqual(vcs.captureDirty(cwd, opts), { vcs: 'other', ok: false, entries: [], error: 'vcs-unsupported:other' });
    assert.deepStrictEqual(vcs.postChanges(cwd, 'HEAD', opts), { vcs: 'other', ok: false, entries: [], error: 'vcs-unsupported:other' });
    assert.deepStrictEqual(
      vcs.restoreAndRemove(cwd, 'HEAD', { restore: [], remove: [], overlap: [] }, opts),
      { vcs: 'other', ok: false, restored: [], removed: [], error: 'vcs-unsupported:other' }
    );
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('SVN XML entity decoding is single-pass and supports named and numeric entities', () => {
  assert.strictEqual(vcs.decodeXmlEntities('&amp;&lt;&gt;&quot;&apos;'), '&<>"\'');
  assert.strictEqual(vcs.decodeXmlEntities('&amp;lt;'), '&lt;');
  assert.strictEqual(vcs.decodeXmlEntities('a&#10;b&#x2f;c'), 'a\nb/c');
});

test('SVN XML parser accepts reordered multiline attributes and ignores nested commit revision', () => {
  const xml = `<status><target path="."><entry path="dir/&amp;lt;name&gt;&#10;x"><wc-status\n props="modified"\n item="normal"\n revision="7"><commit revision="999"/></wc-status></entry></target></status>`;
  const parsed = vcs.parseSvnStatusXml(xml);
  assert.deepStrictEqual(parsed, { ok: true, entries: [{ path: 'dir/&lt;name>\nx', item: 'normal', props: 'modified' }] });
});

test('SVN XML parser decodes quotes and apostrophes in paths', () => {
  const xml = '<status><target path="."><entry path="a&amp;quot;b&amp;apos;c"><wc-status item="modified" props="none"/></entry></target></status>';
  assert.deepStrictEqual(vcs.parseSvnStatusXml(xml).entries[0], { path: 'a&quot;b&apos;c', item: 'modified', props: 'none' });
});

test('SVN XML parser rejects entries without an opening wc-status tag', () => {
  const xml = '<status><target path="."><entry path="x"><commit revision="9"/></entry></target></status>';
  assert.deepStrictEqual(vcs.parseSvnStatusXml(xml), { ok: false, error: 'svn-status-malformed' });
});

test('SVN item map classifies content and property modifications', () => {
  assert.strictEqual(vcs.mapSvnItem('modified', 'none'), 'M');
  assert.strictEqual(vcs.mapSvnItem('replaced', 'none'), 'M');
  assert.strictEqual(vcs.mapSvnItem('normal', 'modified'), 'M');
  assert.deepStrictEqual(vcs.mapSvnItem('normal', 'none'), { skip: true });
});

test('SVN item map classifies adds and deletes', () => {
  assert.strictEqual(vcs.mapSvnItem('added', 'none'), 'A');
  assert.strictEqual(vcs.mapSvnItem('unversioned', 'none'), 'A');
  assert.strictEqual(vcs.mapSvnItem('deleted', 'none'), 'D');
  assert.strictEqual(vcs.mapSvnItem('missing', 'none'), 'D');
});

test('SVN external and ignored records are skipped', () => {
  assert.deepStrictEqual(vcs.mapSvnItem('external', 'none'), { skip: true });
  assert.deepStrictEqual(vcs.mapSvnItem('ignored', 'none'), { skip: true });
});

test('SVN unknown item is fail-closed rather than treated as modified', () => {
  assert.deepStrictEqual(vcs.mapSvnItem('conflicted', 'none'), { failClosed: 'conflicted' });
});

test('SVN parser keeps a newline-containing path as exactly one entry', () => {
  const xml = '<status><entry path="one&#10;two"><wc-status item="unversioned" props="none"/></entry></status>';
  const result = vcs.parseSvnStatusXml(xml);
  assert.strictEqual(result.entries.length, 1);
  assert.strictEqual(result.entries[0].path, 'one\ntwo');
  assert.strictEqual(vcs.mapSvnItem(result.entries[0].item, result.entries[0].props), 'A');
});

test('SVN parser reads item and props only from wc-status opening tag', () => {
  const xml = '<status><entry path="x"><wc-status item="deleted" props="none"><commit item="modified" props="modified" revision="42"/></wc-status></entry></status>';
  assert.deepStrictEqual(vcs.parseSvnStatusXml(xml).entries, [{ path: 'x', item: 'deleted', props: 'none' }]);
});

test('SVN parser accepts a quoted path with a numeric hex entity', () => {
  const xml = '<status><entry path="q&#x22;z"><wc-status props="none" item="modified"/></entry></status>';
  assert.strictEqual(vcs.parseSvnStatusXml(xml).entries[0].path, 'q"z');
});

test('SVN normal with non-none property state remains a modification', () => {
  for (const props of ['modified', 'conflicted', 'unknown']) {
    assert.strictEqual(vcs.mapSvnItem('normal', props), 'M');
  }
});

test('SVN parser reports multiple status entries without cross-contamination', () => {
  const xml = '<status><entry path="a"><wc-status item="added" props="none"/></entry><entry path="b"><wc-status item="missing" props="none"/></entry></status>';
  assert.deepStrictEqual(vcs.parseSvnStatusXml(xml).entries, [
    { path: 'a', item: 'added', props: 'none' },
    { path: 'b', item: 'missing', props: 'none' },
  ]);
});

test('SVN working-copy root guard is zero-spawn and preserves capture sentinel', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-no-svn-'));
  try {
    assert.deepStrictEqual(vcs.captureDirty(cwd, { vcs: 'svn' }), {
      vcs: 'svn', ok: false, entries: [], error: 'svn-wcroot-mismatch: run primitives from the working-copy root',
    });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('SVN captureDirty converts an unknown XML item into a primitive-level failure', () => {
  if (process.platform === 'win32') {
    // The stub below is an extension-less `#!/bin/sh` file: Windows cannot
    // execute it, so `svn` fails to spawn and the primitive reports
    // `svn-status-failed` — a spawn failure, never the XML propagation this
    // case exists to prove. Named skip instead of a baseline entry, so the
    // absence of coverage is stated in the output rather than tallied as a
    // chronic red. Real Windows coverage needs a `.cmd` stub emitting the
    // same XML (separate work).
    console.log('  (skip: the svn stub is a POSIX #!/bin/sh script — on win32 it cannot spawn, so this asserts spawn failure instead of XML propagation)');
    return;
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-svn-wc-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-svn-bin-'));
  try {
    fs.mkdirSync(path.join(cwd, '.svn'));
    const mock = path.join(bin, 'svn');
    // The process stub is only a known XML producer: this exercises the public
    // primitive's fail-closed propagation without requiring a real SVN client.
    fs.writeFileSync(mock, '#!/bin/sh\nprintf "%s\\n" \'<status><entry path="unsafe"><wc-status item="conflicted" props="none"/></entry></status>\'\n');
    fs.chmodSync(mock, 0o755);
    const result = vcs.captureDirty(cwd, { vcs: 'svn', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    assert.deepStrictEqual(result, { vcs: 'svn', ok: false, entries: [], error: 'svn-status-unhandled:conflicted' });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('SVN hashPath uses distinct null and directory sentinels', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-svn-hash-'));
  try {
    fs.mkdirSync(path.join(cwd, '.svn'));
    fs.mkdirSync(path.join(cwd, 'a-dir'));
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'contents');
    const directory = vcs.hashPath(cwd, 'a-dir', { vcs: 'svn' });
    const absent = vcs.hashPath(cwd, 'absent', { vcs: 'svn' });
    const file = vcs.hashPath(cwd, 'file.txt', { vcs: 'svn' });
    assert.deepStrictEqual(directory, { vcs: 'svn', ok: true, hash: 'dir' });
    assert.deepStrictEqual(absent, { vcs: 'svn', ok: true, hash: null });
    assert.match(file.hash, /^[0-9a-f]{64}$/);
    assert.notStrictEqual(file.hash, directory.hash);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('isTracked answers membership in git and separates "no" from "could not ask"', () => {
  const cwd = fixture();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-untracked-'));
  try {
    fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'new\n');
    assert.deepStrictEqual(vcs.isTracked(cwd, 'modified.txt'), { vcs: 'git', ok: true, tracked: true });
    assert.deepStrictEqual(vcs.isTracked(cwd, 'untracked.txt'), { vcs: 'git', ok: true, tracked: false });
    // Outside a repository git exits non-zero: an ANSWER ("no"), not a failure.
    assert.deepStrictEqual(vcs.isTracked(empty, 'anything.txt'), { vcs: 'git', ok: true, tracked: false });
    // A tracked path deleted from the worktree is still under version control.
    fs.rmSync(path.join(cwd, 'deleted.txt'));
    assert.strictEqual(vcs.isTracked(cwd, 'deleted.txt').tracked, true);
    assert.deepStrictEqual(vcs.isTracked(cwd, 'modified.txt', { vcs: 'hg' }),
      { vcs: 'hg', ok: false, tracked: false, error: 'vcs-unsupported:hg' });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('svnPegSafe escapes every target so a path containing @ is not read as a peg revision', () => {
  // Unconditional: SVN strips one trailing @, so an ordinary path is unaffected
  // and `services@1.2.0` stops parsing as revision "1.2.0" (E205000).
  assert.strictEqual(vcs.svnPegSafe('.gsd/LEDGER.md'), '.gsd/LEDGER.md@');
  assert.strictEqual(vcs.svnPegSafe('SERVICES/services@1.2.0'), 'SERVICES/services@1.2.0@');
});

test('SVN restore peg-escapes whitespace Unicode and @ while preserving dirty descendants', () => {
  if (!svnLab.hasSvnToolchain()) return;
  const lab = svnLab.createLab('forge-vcs-svn-reset-');
  const svn = (args) => svnLab.run(['svn', '--non-interactive', '--config-dir', lab.config, ...args], { cwd: lab.wc });
  try {
    svnLab.initializeSvn(lab);
    const ordinary = 'plain space.txt';
    const atPath = 'unicódé@v1.txt';
    const dir = 'dir@pkg';
    const child = `${dir}/keep ü.txt`;
    fs.mkdirSync(path.join(lab.wc, dir));
    for (const [name, body] of [[ordinary, 'plain base\n'], [atPath, 'at base\n'], [child, 'child base\n']]) {
      fs.writeFileSync(path.join(lab.wc, name), body);
    }
    assert.strictEqual(svn(['add', `${ordinary}@`, `${atPath}@`, `${dir}@`]).exit, 0);
    assert.strictEqual(svn(['commit', '-m', 'reset fixture', lab.wc]).exit, 0);
    fs.writeFileSync(path.join(lab.wc, ordinary), 'plain changed\n');
    fs.writeFileSync(path.join(lab.wc, atPath), 'at changed\n');
    fs.writeFileSync(path.join(lab.wc, child), 'child preserved\n');
    assert.strictEqual(svn(['propset', 'svn:ignore', 'ignored.tmp', `${dir}@`]).exit, 0);

    const result = vcs.restoreAndRemove(lab.wc, '1', {
      restore: [ordinary, atPath, dir], remove: [], overlap: [], preserved: [path.join(dir, 'keep Ã¼.txt')],
    }, { vcs: 'svn', configDir: lab.config });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(fs.readFileSync(path.join(lab.wc, ordinary), 'utf8'), 'plain base\n');
    assert.strictEqual(fs.readFileSync(path.join(lab.wc, atPath), 'utf8'), 'at base\n');
    assert.strictEqual(fs.readFileSync(path.join(lab.wc, child), 'utf8'), 'child preserved\n');
    assert.notStrictEqual(svn(['propget', 'svn:ignore', `${dir}@`]).exit, 0, 'directory property should be reverted without touching its child');
  } finally { svnLab.cleanupChildren(lab); }
});

test('SVN failed revert returns no partial audit claim and caller can re-snapshot', () => {
  if (!svnLab.hasSvnToolchain()) return;
  const lab = svnLab.createLab('forge-vcs-svn-resnapshot-');
  const svn = (args) => svnLab.run(['svn', '--non-interactive', '--config-dir', lab.config, ...args], { cwd: lab.wc });
  try {
    svnLab.initializeSvn(lab);
    fs.writeFileSync(path.join(lab.wc, 'valid.txt'), 'base\n');
    assert.strictEqual(svn(['add', 'valid.txt@']).exit, 0);
    assert.strictEqual(svn(['commit', '-m', 'failure fixture', lab.wc]).exit, 0);
    fs.writeFileSync(path.join(lab.wc, 'valid.txt'), 'changed\n');
    const failed = vcs.restoreAndRemove(lab.wc, '1', {
      restore: ['valid.txt', 'bad\0path\n.txt'], remove: [], overlap: [], preserved: [],
    }, { vcs: 'svn', configDir: lab.config });
    assert.strictEqual(failed.ok, false);
    assert.deepStrictEqual(failed.restored, []);
    assert.deepStrictEqual(failed.removed, []);
    const fresh = vcs.postChanges(lab.wc, '1', { vcs: 'svn', configDir: lab.config });
    assert.strictEqual(fresh.ok, true, JSON.stringify(fresh));
  } finally { svnLab.cleanupChildren(lab); }
});

test('all primitives use explicit vcs and do not call detectVcs', () => {
  const cwd = fixture();
  let probes = 0;
  const previous = ignore.__setExecFileSync(() => { probes += 1; throw new Error('probe'); });
  try {
    const baseline = vcs.baselineId(cwd);
    vcs.hashPath(cwd, 'modified.txt');
    vcs.captureDirty(cwd);
    vcs.postChanges(cwd, baseline.id);
    vcs.restoreAndRemove(cwd, baseline.id, { restore: [], remove: [], overlap: [] });
    assert.strictEqual(probes, 0);
  } finally {
    ignore.__setExecFileSync(previous);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});


// ── #104 — EOL fidelity advisory ────────────────────────────────────────────
//
// The restore is a `git checkout`, which honours `core.autocrlf`, so for a user
// with `autocrlf=true` the restored file comes back CRLF-normalised instead of
// carrying the pre-reset bytes. Decision on #104 was option (3): keep the
// behaviour, SAY it. These asserts exist so the saying cannot drift from the
// doing.
//
//   E1  the advisory is tied to a MEASURED conversion, not to a string: the
//       same fixture that fires the warning is checked to really come back
//       CRLF. An advisory nobody can falsify is decoration.
//   E2  and the mirror: with conversion off, the bytes really are byte-faithful
//       AND the advisory is SILENT (`message: null`). A warning that fires
//       always trains people to skip the one that matters.
//   E3  `input` converts on CHECK-IN only — a checkout writes what the blob
//       holds — so it is silent too, and asserted separately from `false`.
//   E4  key absent from EVERY scope is a MEASURED absence (git's built-in
//       default is `false`), and carries its own `source` — never confused with
//       a probe that could not run.
//   E5  unknown is NOT false: an unrecognised value yields `converts: null`,
//       so no caller can read it as "no conversion".
//   E6  a probe that could not run yields `converts: null` with its own source.
//   E7  no restore, no advisory: `eol` is null when nothing was checked out.
//   E8  closed sets crossed in BOTH directions.

const EOL_SEEN_VALUES = new Set();
const EOL_SEEN_SOURCES = new Set();

function eolFixture(autocrlf) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-vcs-eol-'));
  run(cwd, ['init', '-q']);
  if (autocrlf !== null) run(cwd, ['config', 'core.autocrlf', autocrlf]);
  fs.writeFileSync(path.join(cwd, 'text.txt'), 'a\nb\n');
  run(cwd, ['add', '.']);
  run(cwd, ['-c', 'user.name=Forge Test', '-c', 'user.email=forge@example.invalid', 'commit', '-qm', 'init']);
  return cwd;
}

function eolRestore(cwd) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(cwd, 'text.txt'), 'clobbered\n');
  const result = vcs.restoreAndRemove(cwd, head, { restore: ['text.txt'], remove: [], overlap: [] }, {});
  if (result.eol) {
    EOL_SEEN_VALUES.add(result.eol.autocrlf);
    EOL_SEEN_SOURCES.add(result.eol.source);
  }
  return result;
}

test('#104 E1 — autocrlf=true: a conversão REALMENTE acontece, e o aviso a acompanha', () => {
  const cwd = eolFixture('true');
  try {
    const result = eolRestore(cwd);
    assert.strictEqual(result.ok, true);
    // O fato medido primeiro: os bytes restaurados NÃO são os de antes.
    const bytes = fs.readFileSync(path.join(cwd, 'text.txt'), 'utf8');
    assert.strictEqual(bytes, 'a\r\nb\r\n', 'a limitação tem de ser real, senão o aviso é decoração');
    // E só então o aviso que a descreve.
    assert.strictEqual(result.eol.converts, true);
    assert.strictEqual(result.eol.autocrlf, 'true');
    assert.strictEqual(result.eol.source, 'config');
    assert.ok(result.eol.message && result.eol.message.includes('CRLF'), 'a mensagem nomeia o que muda');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('#104 E2 — autocrlf=false: bytes fiéis E aviso SILENCIOSO', () => {
  const cwd = eolFixture('false');
  try {
    const result = eolRestore(cwd);
    const bytes = fs.readFileSync(path.join(cwd, 'text.txt'), 'utf8');
    assert.strictEqual(bytes, 'a\nb\n', 'sem conversão os bytes voltam iguais');
    assert.strictEqual(result.eol.converts, false);
    assert.strictEqual(result.eol.message, null, 'nada a avisar tem de sair calado');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('#104 E3 — autocrlf=input converte só no check-in, então também é silencioso', () => {
  const cwd = eolFixture('input');
  try {
    const result = eolRestore(cwd);
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'text.txt'), 'utf8'), 'a\nb\n');
    assert.strictEqual(result.eol.converts, false);
    assert.strictEqual(result.eol.autocrlf, 'input');
    assert.strictEqual(result.eol.message, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('#104 E4 — chave ausente em TODO escopo é ausência medida, com fonte própria', () => {
  const cwd = eolFixture(null);
  try {
    // A cascata inclui system e global — nesta máquina o instalador do Git for
    // Windows grava core.autocrlf=true no system. Para medir "ausente em todo
    // escopo" é preciso isolar os dois, apontando-os para arquivos que não
    // existem (git trata config ausente como vazia).
    const missing = path.join(cwd, 'no-such-gitconfig');
    const env = { ...process.env, GIT_CONFIG_GLOBAL: missing, GIT_CONFIG_SYSTEM: missing };
    const eol = vcs.eolRestoreFidelity(cwd, { env });
    EOL_SEEN_VALUES.add(eol.autocrlf);
    EOL_SEEN_SOURCES.add(eol.source);
    assert.strictEqual(eol.source, 'git-default', 'ausência medida != probe que não rodou');
    assert.strictEqual(eol.converts, false, 'o default embutido do git é false');
    assert.strictEqual(eol.message, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('#104 E5 — valor não reconhecido é `unknown`, NUNCA `false`', () => {
  // `git config core.autocrlf quicksand` é RECUSADO pelo próprio git
  // (`fatal: bad boolean config value`), então o valor só chega ao disco por
  // edição manual do arquivo — e é assim que o fixture o produz.
  //
  // Medido junto: num repo nesse estado, `git status` sai 128. Ou seja, o git
  // inteiro está quebrado ali e o reset falharia de qualquer forma. Este ramo
  // é defensivo, não um caminho comum — o que ele garante é que a sonda diga
  // "não sei" em vez de "não converte", que é a única resposta que um chamador
  // poderia usar para afirmar fidelidade de bytes que ninguém verificou.
  const cwd = eolFixture('false');
  try {
    fs.appendFileSync(path.join(cwd, '.git', 'config'), '\n[core]\n\tautocrlf = quicksand\n');
    const eol = vcs.eolRestoreFidelity(cwd, {});
    EOL_SEEN_VALUES.add(eol.autocrlf);
    EOL_SEEN_SOURCES.add(eol.source);
    assert.strictEqual(eol.converts, null, 'null, não false — ninguém pode ler isso como "não converte"');
    assert.notStrictEqual(eol.converts, false);
    assert.strictEqual(eol.autocrlf, 'unknown');
    assert.strictEqual(eol.source, 'unrecognised-value');
    assert.ok(eol.message, 'e diz que não sabe');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('#104 E6 — probe que não pôde rodar também é `unknown`, com fonte própria', () => {
  const missing = path.join(os.tmpdir(), 'forge-vcs-eol-nao-existe-' + process.pid);
  const eol = vcs.eolRestoreFidelity(missing, {});
  EOL_SEEN_VALUES.add(eol.autocrlf);
  EOL_SEEN_SOURCES.add(eol.source);
  assert.strictEqual(eol.converts, null);
  assert.strictEqual(eol.source, 'probe-failed');
  assert.ok(eol.message, 'silêncio por falha de sonda seria a mesma classe de defeito');
});

test('#104 E7 — sem restore não há aviso: eol é null', () => {
  const cwd = eolFixture('true');
  try {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(cwd, 'extra.txt'), 'novo\n');
    const result = vcs.restoreAndRemove(cwd, head, { restore: [], remove: ['extra.txt'], overlap: [] }, {});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.eol, null, 'nada foi checked out, então não há conversão a avisar');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('#104 E8 — conjuntos fechados cruzados nos dois sentidos', () => {
  for (const v of EOL_SEEN_VALUES) assert.ok(vcs.AUTOCRLF_VALUES.includes(v), `valor fora do conjunto: ${v}`);
  for (const src of EOL_SEEN_SOURCES) assert.ok(vcs.EOL_SOURCES.includes(src), `fonte fora do conjunto: ${src}`);
  for (const v of vcs.AUTOCRLF_VALUES) assert.ok(EOL_SEEN_VALUES.has(v), `valor declarado e nunca emitido: ${v}`);
  for (const src of vcs.EOL_SOURCES) assert.ok(EOL_SEEN_SOURCES.has(src), `fonte declarada e nunca emitida: ${src}`);
});

process.stdout.write(`\n${passed} passed, 0 failed\n`);
