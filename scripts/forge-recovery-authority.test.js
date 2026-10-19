'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The child loads a fresh module/WeakMap: an opaque handle cannot be the source.
if (process.argv[2] === '--resume') {
  const api = require('./forge-recovery-authority');
  const fixture = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const store = api.createRecoveryAuthority({ resolveProfile: () => fixture.home, clock: () => 70001 });
  const handle = store.issueRecoveryException(fixture.reference, fixture.scope);
  const scope = require('./forge-attempt-recovery').exceptionFor(handle, fixture.scope, 70001);
  process.stdout.write(JSON.stringify({ reference: scope.reference, unit: scope.unit }));
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-authority-'));
  try {
    const api = require('./forge-recovery-authority');
    const interaction = require('./forge-interaction');
    const recovery = require('./forge-attempt-recovery');
    const home = path.join(root, 'profile');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const source = path.join(home, '.codex', 'AGENTS.md');
    const section = 'user:forge-routing-continuity';
    const text = `unrelated private text\n<!-- ${section}:start -->\nAuthorization fixture.\n<!-- ${section}:end -->\n`;
    fs.writeFileSync(source, text);
    const dependencies = { resolveProfile: () => home, clock: () => 1 };
    const store = api.createRecoveryAuthority(dependencies);
    const reference = 'conversation:fixture:19-10';
    const consent = { reference, host: 'codex', section, expires_at: 200000 };
    const scope = { unit: 'execute-task/T01', roots_sha256: 'roots', owner: root, roots: [root],
      request_identity_sha256: 'identity', chain_sha256: 'chain', routes: ['route'],
      purpose: 'sidecar-recovery', expires_at: 150000, gates_preserved: true };
    assert.throws(() => store.registerStandingAuthorization({ ...consent, approved: true }), /attestation-required/);
    assert.throws(() => store.issueRecoveryException({ approved: true }, scope), /reference-invalid/);
    const adapter = interaction.createRecoveryAuthorizationAdapter(observation => ({ ...observation,
      received: true, answer: 'authorize', resolved_at: 1 }), dependencies);
    adapter.registerStandingAuthorization(consent);
    const record = store.readStandingAuthorization(reference);
    assert.strictEqual(record.reference, reference);
    assert(!JSON.stringify(record).includes('Authorization fixture'));
    const handle = store.issueRecoveryException(reference, scope);
    assert.strictEqual(recovery.exceptionFor(handle, scope, 2).reference, reference);
    assert.throws(() => recovery.exceptionFor(JSON.parse(JSON.stringify(handle)), scope, 2), /exception-invalid/);
    const fixture = path.join(root, 'child.json');
    fs.writeFileSync(fixture, JSON.stringify({ home, reference, scope }));
    const child = spawnSync(process.execPath, [__filename, '--resume', fixture], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(JSON.parse(child.stdout).unit, scope.unit);
    console.log('PASS host registration, imported consent refused, fresh-process revalidation and opaque issuance');
    for (const patch of [{ unit: 'foreign' }, { roots_sha256: 'foreign' }, { request_identity_sha256: 'foreign' }, { purpose: 'other' }]) {
      assert.throws(() => recovery.exceptionFor(handle, { ...scope, ...patch }, 2), /exception-invalid/);
    }
    assert.throws(() => store.issueRecoveryException(reference, { ...scope, expires_at: 200001 }), /scope-invalid/);
    assert.throws(() => recovery.exceptionFor(handle, scope, 150001), /exception-invalid/);
    assert.throws(() => api.createRecoveryAuthority({ ...dependencies, clock: () => 200001 }).readStandingAuthorization(reference), /authorization-expired/);
    const permanentReference = 'conversation:permanent:cross-host';
    adapter.registerStandingAuthorization({ reference: permanentReference, host: 'claude', source_host: 'codex', section });
    const later = api.createRecoveryAuthority({ ...dependencies, clock: () => 300000 });
    assert.strictEqual(later.readStandingAuthorization(permanentReference).expires_at, null);
    const renewedScope = { ...scope, expires_at: 400000 };
    const renewed = later.issueRecoveryException(permanentReference, renewedScope);
    assert.strictEqual(recovery.exceptionFor(renewed, renewedScope, 300001).reference, permanentReference);
    assert.throws(() => recovery.exceptionFor(renewed, renewedScope, 400001), /exception-invalid/);
    assert.throws(() => adapter.registerStandingAuthorization({ ...consent, source_host: '../outside' }), /source-not-allowed/);
    // Exercise the real forge-home dependency with a fixture OS profile.
    const savedEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'FORGE_HOME', 'CODEX_HOME'].map(key => [key, process.env[key]]));
    try {
      process.env.HOME = process.env.USERPROFILE = home;
      process.env.FORGE_HOME = process.env.CODEX_HOME = root;
      assert.strictEqual(api.createRecoveryAuthority({ clock: () => 300000 }).readStandingAuthorization(permanentReference).source, record.source);
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    console.log('PASS permanent standing preference, bounded renewed capability, cross-host canonical source and real profile resolver');
    const falseHost = interaction.createRecoveryAuthorizationAdapter(() => ({ approved: true }), dependencies);
    assert.throws(() => falseHost.registerStandingAuthorization(consent), /attestation-invalid/);
    const foreignProfile = interaction.createRecoveryAuthorizationAdapter(row => ({ ...row, profile: root, received: true, answer: 'authorize', resolved_at: 1 }), dependencies);
    assert.throws(() => foreignProfile.registerStandingAuthorization(consent), /attestation-invalid/);
    assert.throws(() => adapter.registerStandingAuthorization({ ...consent, section: 'imported-authorization' }), /source-not-allowed/);
    const filename = path.join(home, '.forge-personal', 'recovery-authority', `${require('./forge-code-roots').digest(reference)}.json`);
    const original = fs.readFileSync(filename);
    fs.writeFileSync(filename, '{');
    assert.throws(() => store.readStandingAuthorization(reference), /store-corrupt/);
    fs.writeFileSync(filename, JSON.stringify({ record: { ...record, expires_at: 999999 }, signature: '0'.repeat(64) }));
    assert.throws(() => store.issueRecoveryException(reference, scope), /store-invalid/);
    fs.writeFileSync(filename, original);
    fs.writeFileSync(source, text.replace('Authorization fixture.', 'Changed authorization.'));
    assert.throws(() => store.readStandingAuthorization(reference), /source-changed/);
    fs.unlinkSync(source);
    assert.throws(() => store.readStandingAuthorization(reference), /source-missing/);
    fs.writeFileSync(source, text);
    const other = path.join(root, 'other-profile');
    fs.cpSync(home, other, { recursive: true });
    assert.throws(() => api.createRecoveryAuthority({ resolveProfile: () => other, clock: () => 2 }).readStandingAuthorization(reference), /profile-mismatch/);
    const originalDir = path.join(home, '.codex');
    const movedDir = path.join(home, 'moved-codex');
    fs.renameSync(originalDir, movedDir);
    fs.symlinkSync(movedDir, originalDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => store.readStandingAuthorization(reference), /path-link/);
    fs.unlinkSync(originalDir);
    fs.renameSync(movedDir, originalDir);
    // Changes outside the explicitly attested section do not replace consent.
    fs.writeFileSync(source, text.replace('unrelated private text', 'other private text'));
    assert.strictEqual(store.readStandingAuthorization(reference).source_sha256, record.source_sha256);
    const pending = recovery.createRecovery({ unit: scope.unit, roots_sha256: scope.roots_sha256, clock: () => 2 });
    pending.questions([{ id: 'functional', question: 'Which functional behavior?' }]);
    pending.next({ exception: handle }).then(result => {
      assert.strictEqual(result.action, 'pending-questions');
      assert.strictEqual(result.questions[0].status, 'pending');
    }).catch(error => { console.error(error); process.exitCode = 1; });
    store.revokeStandingAuthorization(reference);
    assert.throws(() => store.issueRecoveryException(reference, scope), /authorization-revoked/);
    assert.throws(() => adapter.registerStandingAuthorization(consent), /authorization-revoked/);
    assert(!fs.readFileSync(filename, 'utf8').includes('Authorization fixture'));
    console.log('PASS profile/source/symlink, tampered store, revocation/expiry, scope and functional-question independence');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
