#!/usr/bin/env node
'use strict';

// Runtime fixtures matter here: a checkout may normalize committed text EOLs,
// whereas the vault's only useful promise is preservation of actual bytes.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { serializeGroup } = require('./forge-grouped-file');
const { vaultDir, writeVault, restoreVault, listVaults } = require('./forge-sweep-vault');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed++;
    failures.push({ name, error: error.message });
    console.log(`  not ok - ${name}: ${error.message}`);
  }
}

function assert(value, message) {
  if (!value) throw new Error(message || 'assertion failed');
}

function fixture() {
  // realpath, never the raw mkdtemp: this cwd is handed to production, which resolves it
  // — on macOS os.tmpdir() is a symlink to /private/..., so an unresolved fixture root
  // makes asserts like `refused[0].path === f.memberB` compare two spellings of the same
  // file and fail. The symlink case below exists precisely because of this. Do not "simplify".
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sweep-vault-test-')));
}

function write(cwd, relative, bytes) {
  const file = path.join(cwd, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

function remove(cwd) {
  fs.rmSync(cwd, { recursive: true, force: true });
}

console.log('\nforge-sweep-vault: byte-preserving pre-apply containers\n');

test('round-trips runtime CRLF and LF fixtures byte-for-byte', () => {
  const cwd = fixture();
  const crlf = Buffer.from('# CRLF\r\nline two\r\n', 'utf8');
  const lf = Buffer.from('# LF\nline two\n', 'utf8');
  const crlfPath = write(cwd, '.gsd/memory/crlf.md', crlf);
  const lfPath = write(cwd, '.gsd/decisions/lf.md', lf);
  const vault = writeVault(cwd, { operation: 'dedupe', files: [crlfPath, lfPath] });
  assert(vault.ok, 'vault write should succeed');
  assert(vault.containerPath.startsWith(vaultDir(cwd)), 'container should be in vault directory');
  fs.unlinkSync(crlfPath);
  fs.unlinkSync(lfPath);
  const result = restoreVault(cwd, vault.containerPath);
  assert(result.restored.length === 2, 'both missing files should restore');
  assert(Buffer.compare(crlf, fs.readFileSync(crlfPath)) === 0, 'CRLF bytes must match exactly');
  assert(Buffer.compare(lf, fs.readFileSync(lfPath)) === 0, 'LF bytes must match exactly');
  remove(cwd);
});

test('round-trips a BOM and a file without a final newline', () => {
  const cwd = fixture();
  const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]);
  const noFinalNewline = Buffer.from('last line has no newline', 'utf8');
  const bomPath = write(cwd, '.gsd/items/bom.md', bom);
  const plainPath = write(cwd, '.gsd/items/no-final.md', noFinalNewline);
  const vault = writeVault(cwd, { operation: 'dedupe', files: [bomPath, plainPath] });
  fs.unlinkSync(bomPath);
  fs.unlinkSync(plainPath);
  const result = restoreVault(cwd, vault.containerPath);
  assert(result.refused.length === 0, 'restore must not refuse valid byte fixtures');
  assert(Buffer.compare(bom, fs.readFileSync(bomPath)) === 0, 'BOM must survive');
  assert(Buffer.compare(noFinalNewline, fs.readFileSync(plainPath)) === 0, 'final newline absence must survive');
  remove(cwd);
});

test('an identical present destination is reported without rewriting it', () => {
  const cwd = fixture();
  const bytes = Buffer.from('same bytes\r\n', 'utf8');
  const member = write(cwd, '.gsd/memory/same.md', bytes);
  const vault = writeVault(cwd, { operation: 'dedupe', files: [member] });
  const before = fs.statSync(member).mtimeMs;
  const result = restoreVault(cwd, vault.containerPath);
  const after = fs.statSync(member).mtimeMs;
  assert(result.alreadyPresent.length === 1, 'identical file should be already present');
  assert(result.restored.length === 0, 'identical file must not be rewritten');
  assert(before === after, 'mtime must be untouched for already-present bytes');
  assert(Buffer.compare(bytes, fs.readFileSync(member)) === 0, 'bytes must stay untouched');
  remove(cwd);
});

// DEFAULT-POLICY GUARD. This test predates the restore-over-rewrite fence and
// is deliberately kept verbatim in behavior: a two-argument `restoreVault` must
// still refuse a divergent destination with the historical reason and preserve
// its bytes. The fence added below is opt-in and per-member; if this test ever
// has to be loosened to keep the suite green, the fence has become a global
// switch and that is the defect, not the test.
test('a divergent destination is named and never overwritten', () => {
  const cwd = fixture();
  const original = Buffer.from('before\n', 'utf8');
  const changed = Buffer.from('after\n', 'utf8');
  const member = write(cwd, '.gsd/memory/conflict.md', original);
  const vault = writeVault(cwd, { operation: 'dedupe', files: [member] });
  fs.writeFileSync(member, changed);
  const result = restoreVault(cwd, vault.containerPath);
  assert(result.refused.length === 1, 'divergence must be recorded as one refusal');
  assert(result.refused[0].reason === 'destination-has-different-bytes', 'refusal needs a stable reason');
  assert(Buffer.compare(changed, fs.readFileSync(member)) === 0, 'divergent destination must remain untouched');
  remove(cwd);
});

// ── Restore-over-rewrite fence ───────────────────────────────────────────────
// Curation rewrites a fragment IN PLACE, so after a real apply the destination
// always differs from the vault bytes and the unconditional refusal above made
// `--undo` refuse every single time. The fence authorizes overwrite by MEMBER
// NAME. Selectivity is the property under test: one authorized member restores
// while a second divergent member, equally rewritten, is refused by name.

// Two divergent members, exactly one authorized.
function twoDivergentMembers() {
  const cwd = fixture();
  const originalA = Buffer.from('A original\r\n', 'utf8');
  const originalB = Buffer.from('B original\n', 'utf8');
  const memberA = write(cwd, '.gsd/memory/a.md', originalA);
  const memberB = write(cwd, '.gsd/memory/b.md', originalB);
  const vault = writeVault(cwd, { operation: 'curate', files: [memberA, memberB] });
  assert(vault.ok, 'vault write should succeed');
  // Rewrite in place -- what a real curate apply does to both.
  const rewrittenA = Buffer.from('A rewritten by curate\r\n', 'utf8');
  const rewrittenB = Buffer.from('B rewritten by curate\n', 'utf8');
  fs.writeFileSync(memberA, rewrittenA);
  fs.writeFileSync(memberB, rewrittenB);
  return { cwd, vault, memberA, memberB, originalA, originalB, rewrittenA, rewrittenB };
}

test('an explicitly named divergent member is restored over the rewrite', () => {
  const f = twoDivergentMembers();
  const result = restoreVault(f.cwd, f.vault.containerPath, { overwrite: ['.gsd/memory/a.md'] });
  assert(result.restored.length === 1, `exactly the named member restores, got ${JSON.stringify(result.restored)}`);
  assert(
    Buffer.compare(f.originalA, fs.readFileSync(f.memberA)) === 0,
    'the authorized member must return to its exact pre-apply bytes',
  );
  remove(f.cwd);
});

test('a divergent member outside the authorization set is refused by name', () => {
  const f = twoDivergentMembers();
  const result = restoreVault(f.cwd, f.vault.containerPath, { overwrite: ['.gsd/memory/a.md'] });
  assert(result.refused.length === 1, `only the unauthorized member is refused, got ${JSON.stringify(result.refused)}`);
  assert(result.refused[0].path === f.memberB, 'the refusal must carry the offending destination path');
  assert(
    result.refused[0].reason === 'destination-not-authorized-for-overwrite',
    `refusal needs a stable policy reason, got ${result.refused[0].reason}`,
  );
  assert(
    Buffer.compare(f.rewrittenB, fs.readFileSync(f.memberB)) === 0,
    'the unauthorized member must keep the bytes it had before the call',
  );
  remove(f.cwd);
});

test('an authorization naming a member that does not match authorizes nothing', () => {
  const f = twoDivergentMembers();
  const result = restoreVault(f.cwd, f.vault.containerPath, { overwrite: ['.gsd/memory/a.md.bak', '.gsd/memory/'] });
  assert(result.restored.length === 0, 'a near-miss name must not authorize anything');
  assert(result.refused.length === 2, 'both divergent members stay refused');
  assert(Buffer.compare(f.rewrittenA, fs.readFileSync(f.memberA)) === 0, 'A keeps its rewritten bytes');
  assert(Buffer.compare(f.rewrittenB, fs.readFileSync(f.memberB)) === 0, 'B keeps its rewritten bytes');
  remove(f.cwd);
});

// The caller may hand the id back the way the host spells paths. Authorization
// is compared at the normalized member-id boundary, so a NATIVE-separator or
// `./`-prefixed spelling of the SAME member is the same member -- and nothing
// else is.
//
// The input is native BY CONSTRUCTION (`path.sep`), never a hand-written literal:
// `normalizeMemberId` -> `toPosix` folds `path.sep` only, so a literal `\` would
// exercise the intent on win32 and assert a falsehood on POSIX, where `\` is a
// legal filename character and must NOT be read as a separator.
test('authorization matches the normalized member id, not the raw spelling', () => {
  const f = twoDivergentMembers();
  const nativeSpelling = '.' + path.sep + ['.gsd', 'memory', 'a.md'].join(path.sep);
  const result = restoreVault(f.cwd, f.vault.containerPath, { overwrite: [nativeSpelling] });
  assert(result.restored.length === 1, 'a normalized spelling of the id must still authorize');
  assert(Buffer.compare(f.originalA, fs.readFileSync(f.memberA)) === 0, 'A restored to original bytes');
  remove(f.cwd);
});

// There is no global switch, by construction: the fence takes a closed set of
// names. Anything that is not a set/array of ids yields an empty set, i.e. the
// historical deny-by-default. A `true` that meant "all" would reintroduce the
// blanket overwrite this slice exists to avoid.
test('a truthy non-set policy authorizes nothing and keeps the default reason', () => {
  for (const policy of [true, 'all', '*', { '.gsd/memory/a.md': true }, 42]) {
    const f = twoDivergentMembers();
    const result = restoreVault(f.cwd, f.vault.containerPath, { overwrite: policy });
    assert(result.restored.length === 0, `policy ${JSON.stringify(policy)} must authorize nothing`);
    assert(result.refused.length === 2, `policy ${JSON.stringify(policy)} must refuse both members`);
    assert(
      result.refused.every(entry => entry.reason === 'destination-has-different-bytes'),
      'an empty authorization set is indistinguishable from no policy at all',
    );
    assert(Buffer.compare(f.rewrittenA, fs.readFileSync(f.memberA)) === 0, 'A untouched');
    remove(f.cwd);
  }
});

// Authorization is a policy about WHICH member may be overwritten; it is not a
// permission to leave `.gsd`. Containment runs first and is unaffected.
test('authorizing an escaping member id does not bypass containment', () => {
  const cwd = fixture();
  const dir = vaultDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const container = path.join(dir, 'authorized-escape.md');
  fs.writeFileSync(container, serializeGroup({ label: 'curate', units: [
    { id: '../outside.md', content: Buffer.from('never write this', 'utf8') },
  ] }).buffer);
  const result = restoreVault(cwd, container, { overwrite: ['../outside.md'] });
  assert(result.refused.length === 1, 'the escaping member is still refused');
  assert(result.refused[0].reason === 'path-escapes-gsd', 'containment reason wins over the policy');
  assert(result.restored.length === 0, 'nothing may be restored outside .gsd');
  assert(!fs.existsSync(path.join(cwd, 'outside.md')), 'outside path must remain absent');
  remove(cwd);
});

test('an authorized member whose bytes already match is still reported as present', () => {
  const cwd = fixture();
  const bytes = Buffer.from('unchanged\r\n', 'utf8');
  const member = write(cwd, '.gsd/memory/same.md', bytes);
  const vault = writeVault(cwd, { operation: 'curate', files: [member] });
  const before = fs.statSync(member).mtimeMs;
  const result = restoreVault(cwd, vault.containerPath, { overwrite: vault.members });
  const after = fs.statSync(member).mtimeMs;
  assert(result.alreadyPresent.length === 1, 'byte identity is checked before the policy');
  assert(result.restored.length === 0, 'an identical destination is never rewritten, authorized or not');
  assert(before === after, 'mtime must be untouched');
  remove(cwd);
});

test('a member id escaping .gsd is refused by real containment', () => {
  const cwd = fixture();
  const dir = vaultDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const malicious = path.join(dir, 'malicious.md');
  const serialized = serializeGroup({ label: 'dedupe', units: [
    { id: '../outside.md', content: Buffer.from('never write this', 'utf8') },
  ] });
  fs.writeFileSync(malicious, serialized.buffer);
  const result = restoreVault(cwd, malicious);
  assert(result.refused.length === 1, 'escaping member must be refused');
  assert(result.refused[0].reason === 'path-escapes-gsd', 'escape should have named reason');
  assert(!fs.existsSync(path.join(cwd, 'outside.md')), 'outside path must remain absent');
  remove(cwd);
});

// R4: containment must be proven before any mutation. A symlinked intermediate
// segment used to be followed by mkdirSync(recursive), creating directories
// outside .gsd; the later refusal only stopped the final file write.
test('a symlinked intermediate segment creates nothing outside .gsd', () => {
  const cwd = fixture();
  const outside = path.join(cwd, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
  const link = path.join(cwd, '.gsd', 'link');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch (error) {
    // Symlink creation needs privileges on some platforms; the skip is named
    // rather than silently passing.
    console.log(`  skip - symlink escape (symlink indisponível: ${error.code || error.message})`);
    remove(cwd);
    return;
  }
  const dir = vaultDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const container = path.join(dir, 'symlink-escape.md');
  fs.writeFileSync(container, serializeGroup({ label: 'dedupe', units: [
    { id: '.gsd/link/escaped/file.md', content: Buffer.from('never write this', 'utf8') },
  ] }).buffer);
  const result = restoreVault(cwd, container);
  assert(result.refused.length === 1, 'symlink boundary must be refused');
  assert(result.refused[0].reason === 'path-escapes-gsd', 'refusal needs the containment reason');
  assert(!fs.existsSync(path.join(outside, 'escaped')), 'no directory may be created outside .gsd');
  assert(result.restored.length === 0, 'nothing may be restored through the link');
  remove(cwd);
});

test('a payload containing the format delimiter prevents any vault write', () => {
  const cwd = fixture();
  const unsafe = write(cwd, '.gsd/memory/unsafe.md', Buffer.from('x\n<!-- forge:endunit id=x -->\n', 'utf8'));
  const result = writeVault(cwd, { operation: 'dedupe', files: [unsafe] });
  assert(result.ok === false, 'unsafe payload must reject the whole write');
  assert(result.skipped.length === 1, 'serializeGroup skip should be exposed');
  assert(result.skipped[0].reason === 'delimiter-in-payload', 'skip reason should be preserved');
  assert(listVaults(cwd).length === 0, 'no incomplete vault container may be written');
  remove(cwd);
});

test('listVaults returns deterministic filename order', () => {
  const cwd = fixture();
  const dir = vaultDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'z.md'), 'z');
  fs.writeFileSync(path.join(dir, 'a.md'), 'a');
  assert(listVaults(cwd).map(file => path.basename(file)).join(',') === 'a.md,z.md', 'vaults should sort by name');
  remove(cwd);
});

// ── Regression: a workspace reached through a SYMLINK ────────────────────────
// The member id is `relative(cwd, file)`, and both sides must be resolved the
// same way. They were not: `cwd` arrived lexically while the file paths arrive
// already physical, so a workspace under a symlink produced an escaping id
// (`../../real/path/.gsd/memory/x.md`). Restore resolved that back to the
// physical path, compared it against the LEXICAL `.gsd` root, and refused with
// `path-escapes-gsd` — undo entirely inert, on every member.
//
// This guard exists because the suite's own fixtures now root at the realpath
// (they must, to compare paths at all), which REMOVES the condition that
// exposed the defect. Without an explicit symlink case the bug returns unseen.
// It is also why the bug read as ubuntu-green / macOS-red: `/tmp` is real on
// Linux and a symlink to `/private/tmp` on macOS.
test('a workspace reached through a symlink yields contained ids, and undo restores', () => {
  const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-symlink-real-')));
  const link = path.join(fs.realpathSync(os.tmpdir()), `vault-symlink-view-${process.pid}`);
  try { fs.unlinkSync(link); } catch { /* first run */ }
  fs.symlinkSync(real, link, 'dir');
  try {
    const memoryDir = path.join(real, '.gsd', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    const fragment = path.join(memoryDir, 'M-20260815000001-sym.md');
    const original = Buffer.from('fato\r\noutro\r\n', 'utf8');
    fs.writeFileSync(fragment, original);

    // The workspace is addressed through the LINK; the file path is physical —
    // exactly the mixture the census hands the vault in a real run.
    const written = writeVault(link, { operation: 'dedupe-memoria', files: [fragment] });
    assert(written.ok === true, `vault must be written: ${JSON.stringify(written.skipped || [])}`);
    for (const id of written.members) {
      assert(!id.startsWith('..'), `member id must stay inside the workspace, got: ${id}`);
      assert(id.startsWith('.gsd/'), `member id must be workspace-relative, got: ${id}`);
    }

    // And the round trip actually restores: delete the fragment, undo, compare bytes.
    fs.unlinkSync(fragment);
    const restored = restoreVault(link, written.containerPath);
    assert(restored.refused.length === 0, `nothing may be refused: ${JSON.stringify(restored.refused)}`);
    assert(fs.existsSync(fragment), 'the fragment must be back on disk');
    assert(Buffer.compare(fs.readFileSync(fragment), original) === 0, 'bytes must round-trip exactly');
  } finally {
    try { fs.unlinkSync(link); } catch { /* best effort */ }
    fs.rmSync(real, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  for (const failure of failures) console.error(`${failure.name}: ${failure.error}`);
  process.exit(1);
}
