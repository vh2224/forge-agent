#!/usr/bin/env node
// forge-secrets.test.js — contract tests for the credential vault.
//
// The properties worth guarding are all about the secret NOT leaking: it must
// never reach the registry file, never reach stdout, and reach only the child
// process that needs it.
//
// Run: node scripts/forge-secrets.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ENGINE = path.join(__dirname, 'forge-secrets.js');

// Isolate the registry; the Keychain is shared, so tests use a unique service
// prefix and clean up after themselves.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-secrets-'));
const REGISTRY = path.join(TMP, 'registry.json');
const SERVICE = `test${Date.now()}`;
process.env.FORGE_SECRETS_REGISTRY = REGISTRY;

const secrets = require('./forge-secrets.js');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) {
    failed++; failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, b, m) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${m || 'mismatch'}\n     esperado: ${JSON.stringify(b)}\n     obtido:   ${JSON.stringify(a)}`);
  }
}
function cli(args, input) {
  return spawnSync(process.execPath, [ENGINE, ...args], {
    encoding: 'utf8',
    input: input === undefined ? '' : input,
    env: { ...process.env, FORGE_SECRETS_REGISTRY: REGISTRY },
  });
}

console.log('\n=== forge-secrets.js — contract test suite ===\n');

console.log('mapeamento de env var');

test('serviços conhecidos usam a variável que o CLI realmente lê', () => {
  // Getting this wrong runs the command unauthenticated, which fails in a way
  // that looks like a bad token.
  assertEq(secrets.envVarFor('railway'), 'RAILWAY_TOKEN');
  assertEq(secrets.envVarFor('vercel'), 'VERCEL_TOKEN');
  assertEq(secrets.envVarFor('fly'), 'FLY_API_TOKEN');
  assertEq(secrets.envVarFor('cloudflare'), 'CLOUDFLARE_API_TOKEN');
});

test('serviço desconhecido cai na convenção SERVICE_TOKEN', () => {
  assertEq(secrets.envVarFor('meuservico'), 'MEUSERVICO_TOKEN');
  assertEq(secrets.envVarFor('my-thing'), 'MY_THING_TOKEN');
});

console.log('\nregistro e segredo');

test('o segredo NUNCA entra no arquivo de registro', () => {
  const secret = 'sk-super-secreto-12345';
  secrets.add({ service: SERVICE, name: 'a', secret });
  const raw = fs.readFileSync(REGISTRY, 'utf8');
  assert(!raw.includes(secret), 'segredo vazou para o registro!');
  assert(raw.includes(SERVICE), 'o registro deve conter o serviço');
});

test('o segredo volta pelo cofre', () => {
  assertEq(secrets.get(SERVICE, 'a'), 'sk-super-secreto-12345');
});

test('list() não expõe segredo, e por padrão nem toca no cofre', () => {
  // Reading to check presence means one Keychain access per entry, which on an
  // unsigned bundle is one authorisation dialog per entry.
  const rows = secrets.list().filter(c => c.service === SERVICE);
  assertEq(rows.length, 1);
  assertEq(rows[0].has_secret, null, 'sem --verify não se afirma nada sobre o valor');
  assert(!('secret' in rows[0]), 'list() não pode carregar o segredo');
  assert(!JSON.stringify(rows).includes('sk-super-secreto'), 'segredo em list()');
});

test('list({verify:true}) confirma presença sem revelar', () => {
  const rows = secrets.list({ verify: true }).filter(c => c.service === SERVICE);
  assertEq(rows[0].has_secret, true);
  assert(!JSON.stringify(rows).includes('sk-super-secreto'));
});

test('não verificado é diferente de ausente', () => {
  // null and false are distinct claims: "we did not look" must never render as
  // "it is missing", which would send the user re-adding a healthy secret.
  const unverified = secrets.list().find(c => c.service === SERVICE);
  const verified = secrets.list({ verify: true }).find(c => c.service === SERVICE);
  assertEq(unverified.has_secret, null);
  assertEq(verified.has_secret, true);
});

test('readicionar substitui em vez de duplicar', () => {
  secrets.add({ service: SERVICE, name: 'a', secret: 'novo-valor' });
  const rows = secrets.load().filter(c => c.service === SERVICE && c.name === 'a');
  assertEq(rows.length, 1, 'não pode duplicar a entrada');
  assertEq(secrets.get(SERVICE, 'a'), 'novo-valor');
});

test('--env sobrepõe a convenção', () => {
  secrets.add({ service: SERVICE, name: 'custom', secret: 'x', envVar: 'MINHA_VAR' });
  assertEq(secrets.find(SERVICE, 'custom').env_var, 'MINHA_VAR');
});

console.log('\nexec');

test('exec injeta a variável no filho e nada mais', () => {
  secrets.add({ service: SERVICE, name: 'exec1', secret: 'valor-do-exec' });
  const r = cli(['--exec', SERVICE, 'exec1', '--',
    process.execPath, '-e', 'console.log(process.env.' + secrets.envVarFor(SERVICE) + ')']);
  assertEq(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assertEq(r.stdout.trim(), 'valor-do-exec');
});

test('exec não vaza o segredo para o próprio ambiente', () => {
  const varName = secrets.envVarFor(SERVICE);
  assert(!process.env[varName], 'a variável não pode existir no processo pai');
});

test('exec propaga o código de saída do comando', () => {
  const r = cli(['--exec', SERVICE, 'exec1', '--', process.execPath, '-e', 'process.exit(3)']);
  assertEq(r.status, 3, 'o exit code do filho tem que chegar ao chamador');
});

test('exec de nome inexistente falha listando o que existe', () => {
  // Naming the alternatives is the difference between a dead end and a fix.
  const r = cli(['--exec', SERVICE, 'nao-existe', '--', 'echo', 'oi']);
  assertEq(r.status, 1);
  assert(/não existe/.test(r.stderr), r.stderr);
  assert(r.stderr.includes(`${SERVICE}/a`), 'deve listar as alternativas');
});

test('exec sem -- é erro de uso, não execução às cegas', () => {
  const r = cli(['--exec', SERVICE, 'exec1']);
  assertEq(r.status, 2);
});

console.log('\nsuperfície da CLI');

test('não existe comando que imprima o segredo', () => {
  // An agent that can print a secret will eventually print it into a
  // transcript, so the surface simply does not include one.
  const help = cli(['--help']).stdout;
  assert(!/--print|--token|--reveal|--show/.test(help), `help oferece impressão:\n${help}`);
  for (const flag of ['--print', '--token', '--reveal']) {
    const r = cli([flag, SERVICE, 'a']);
    assert(!r.stdout.includes('novo-valor'), `${flag} imprimiu o segredo`);
  }
});

test('--list --json não carrega segredo', () => {
  const r = cli(['--list', '--json']);
  assertEq(r.status, 0);
  assert(!r.stdout.includes('novo-valor'), 'segredo no --list --json');
  const rows = JSON.parse(r.stdout);
  assert(Array.isArray(rows));
});

test('--add sem stdin recusa em vez de guardar vazio', () => {
  const r = cli(['--add', SERVICE, 'vazio'], '');
  assertEq(r.status, 2);
  assert(/stdin/.test(r.stderr), r.stderr);
});

test('--add lê o segredo do stdin', () => {
  const r = cli(['--add', SERVICE, 'viacli'], 'segredo-do-stdin');
  assertEq(r.status, 0, r.stderr);
  assertEq(secrets.get(SERVICE, 'viacli'), 'segredo-do-stdin');
  assert(!r.stdout.includes('segredo-do-stdin'), 'a confirmação não pode ecoar o segredo');
});

test('--services lista o mapeamento', () => {
  const r = cli(['--services', '--json']);
  assertEq(r.status, 0);
  const rows = JSON.parse(r.stdout);
  assert(rows.some(s => s.service === 'railway' && s.env === 'RAILWAY_TOKEN'));
});

console.log('\nvários do mesmo serviço');

test('vários nomes do mesmo serviço convivem, cada um com seu segredo', () => {
  secrets.add({ service: SERVICE, name: 'ambiente-a', secret: 'token-A' });
  secrets.add({ service: SERVICE, name: 'ambiente-b', secret: 'token-B' });
  secrets.add({ service: SERVICE, name: 'ambiente-c', secret: 'token-C' });
  assertEq(secrets.get(SERVICE, 'ambiente-a'), 'token-A');
  assertEq(secrets.get(SERVICE, 'ambiente-b'), 'token-B');
  assertEq(secrets.get(SERVICE, 'ambiente-c'), 'token-C');
  assertEq(secrets.forService(SERVICE).length >= 3, true);
});

test('ambiguidade é ERRO, nunca um chute', () => {
  // Picking the first of three projects would deploy to the wrong one and look
  // exactly like success.
  const r = secrets.resolve(SERVICE, null);
  assertEq(r.error, 'ambiguous');
  assert(r.candidates.length >= 3, 'o chamador precisa das opções para poder perguntar');
  assert(!r.entry, 'não pode resolver nada em caso de ambiguidade');
});

test('nome explícito resolve mesmo havendo vários', () => {
  assertEq(secrets.resolve(SERVICE, 'ambiente-b').entry.name, 'ambiente-b');
});

test('padrão do serviço resolve quando o nome é omitido', () => {
  assertEq(secrets.setDefault(SERVICE, 'ambiente-b'), true);
  assertEq(secrets.resolve(SERVICE, null).entry.name, 'ambiente-b');
});

test('só existe um padrão por serviço', () => {
  secrets.setDefault(SERVICE, 'ambiente-c');
  const marked = secrets.forService(SERVICE).filter(c => c.is_default);
  assertEq(marked.length, 1, 'definir um padrão tem que limpar o anterior');
  assertEq(marked[0].name, 'ambiente-c');
});

test('padrão em serviço inexistente não inventa entrada', () => {
  assertEq(secrets.setDefault(SERVICE, 'nao-existe'), false);
  assertEq(secrets.find(SERVICE, 'nao-existe'), null);
});

test('serviço único dispensa nome e dispensa padrão', () => {
  const solo = SERVICE + 'solo';
  secrets.add({ service: solo, name: 'unico', secret: 's' });
  assertEq(secrets.resolve(solo, null).entry.name, 'unico');
  secrets.remove(solo, 'unico');
});

test('exec sem nome usa o padrão', () => {
  const r = cli(['--exec', SERVICE, '--',
    process.execPath, '-e', 'console.log(process.env.' + secrets.envVarFor(SERVICE) + ')']);
  assertEq(r.status, 0, r.stderr);
  assertEq(r.stdout.trim(), 'token-C', 'deve usar o padrão marcado');
});

test('exec ambíguo sai com 2 e lista as opções', () => {
  const other = SERVICE + 'amb';
  secrets.add({ service: other, name: 'x', secret: '1' });
  secrets.add({ service: other, name: 'y', secret: '2' });
  const r = cli(['--exec', other, '--', 'echo', 'oi']);
  assertEq(r.status, 2, 'ambiguidade é erro de uso, não execução');
  assert(/diga qual/.test(r.stderr), r.stderr);
  assert(r.stderr.includes('/x') || r.stderr.includes(' x '), 'deve listar os candidatos');
  secrets.remove(other, 'x'); secrets.remove(other, 'y');
});

test('--list filtra por serviço', () => {
  const r = cli(['--list', SERVICE, '--json']);
  assertEq(r.status, 0);
  const rows = JSON.parse(r.stdout);
  assert(rows.length >= 3);
  assert(rows.every(c => c.service === SERVICE), 'filtro deixou passar outro serviço');
});

console.log('\nrobustez do cofre');

test('Keychain travado não pendura — degrada para arquivo', () => {
  // A locked keychain makes `security` prompt for a password; with no TTY it
  // waits forever. This is what hung the macOS CI job past ten minutes.
  //
  // run-tests.js sets FORGE_KEYCHAIN_DISABLED=1 for the whole suite, which would
  // make this pass trivially — the engine would never call `security` at all and
  // the assertion below would prove nothing about the timeout. So on darwin the
  // switch is re-enabled for the duration of this one test, against a shim that
  // SLEEPS: the real hostile condition, reproduced without the real binary (the
  // shim is ahead of it on PATH, so no real keychain is reachable). Elsewhere
  // there is no keychain layer and the file store is the only path anyway.
  const prevDisabled = process.env.FORGE_KEYCHAIN_DISABLED;
  const prevPath = process.env.PATH;
  const shimLog = path.join(TMP, 'hang-calls.log');
  if (process.platform === 'darwin') {
    const shimDir = path.join(TMP, 'hangbin');
    fs.mkdirSync(shimDir, { recursive: true });
    // Logs before sleeping, so the assertion below can prove the engine really
    // entered the Keychain branch. Without that proof this test would pass just
    // as happily with the branch skipped entirely — `store: 'file'` is the
    // outcome either way, which is precisely the false green the kill-switch
    // would otherwise have introduced here.
    // Records the call, THEN blocks — the order matters, the log is the proof.
    // `sleep 10` and not `sleep 30`: comfortably past the budget below, short
    // enough that a SIGTERM'd shim cannot linger for long if one ever escapes.
    fs.writeFileSync(path.join(shimDir, 'security'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "${shimLog}"\nsleep 10\n`, { mode: 0o755 });
    process.env.PATH = `${shimDir}${path.delimiter}${prevPath}`;
    process.env.FORGE_KEYCHAIN_DISABLED = '';
  }
  const prev = process.env.FORGE_KEYCHAIN_TIMEOUT_MS;
  // 1000ms, not 1ms. At 1ms the SIGTERM lands before the shim has even finished
  // exec'ing, so it never records the call and the proof below cannot be made —
  // process spawn alone costs >250ms under a sandboxed runner. Still a third of
  // what the assertion allows, and a tenth of the shim's own sleep, so the
  // measurement stays unambiguous on a slow machine.
  process.env.FORGE_KEYCHAIN_TIMEOUT_MS = '1000';
  delete require.cache[require.resolve('./forge-secrets.js')];

  // The restore MUST be exception-safe. A plain tail of restore statements is
  // skipped when an assertion throws, and then the sleeping shim stays on PATH
  // for every later test in the file — each one paying the timeout, which reads
  // as "the suite hangs" rather than "one assertion failed". Learned the hard
  // way while proving this very test bites.
  try {
    const iso = require('./forge-secrets.js');

    const t0 = Date.now();
    iso.add({ service: SERVICE + 'to', name: 'x', secret: 'valor' });
    const took = Date.now() - t0;

    assert(took < 3000, `add demorou ${took}ms — deveria desistir do Keychain rápido`);
    if (process.platform === 'darwin') {
      assert(fs.existsSync(shimLog),
        'o engine nem chamou `security` — este teste não estaria cobrindo o timeout');
    }
    assertEq(iso.find(SERVICE + 'to', 'x').store, 'file', 'deve registrar que caiu no arquivo');
    assertEq(iso.get(SERVICE + 'to', 'x'), 'valor', 'o valor tem que continuar acessível');

    // Deletion now reports Keychain failures instead of claiming success. The
    // fixture was stored in the fallback, so clean it with Keychain disabled.
    process.env.FORGE_KEYCHAIN_DISABLED = '1';
    iso.remove(SERVICE + 'to', 'x');
  } finally {
    if (prev === undefined) delete process.env.FORGE_KEYCHAIN_TIMEOUT_MS;
    else process.env.FORGE_KEYCHAIN_TIMEOUT_MS = prev;
    process.env.PATH = prevPath;
    if (prevDisabled === undefined) delete process.env.FORGE_KEYCHAIN_DISABLED;
    else process.env.FORGE_KEYCHAIN_DISABLED = prevDisabled;
    delete require.cache[require.resolve('./forge-secrets.js')];
  }
});

test('cofre ilegível é INDETERMINADO, nunca "sem valor"', () => {
  // The defect this pins: `list()` computed presence as `!!get(...)`, and
  // `get()` returned null for every failure — a corrupt fallback file, a
  // permission error, a Keychain timeout. So a credential that was perfectly
  // fine listed as missing, and the fix the UI suggested was to re-add it.
  //
  // The scenario is built from the file store rather than the real Keychain on
  // purpose: run-tests.js isolates HOME but not the Keychain, so a test that
  // needed a broken Keychain would either hang or not run off macOS.
  const svc = SERVICE + 'corrupt';
  const FALLBACK = `${REGISTRY}.secrets`;

  // A registry entry with no value anywhere: written straight through save(),
  // so nothing is ever put in the Keychain and `security` answers 44 (absent)
  // on darwin, while other platforms simply have no keychain layer.
  const creds = secrets.load();
  creds.push({
    service: svc, name: 'x', env_var: 'X_TOKEN', note: '',
    store: 'file', added_at: new Date().toISOString(),
  });
  secrets.save(creds);

  const existed = fs.existsSync(FALLBACK);
  const previous = existed ? fs.readFileSync(FALLBACK, 'utf8') : null;
  try {
    fs.writeFileSync(FALLBACK, '{ this is not json', { mode: 0o600 });
    fs.chmodSync(FALLBACK, 0o600);

    const row = secrets.list({ verify: true }).find(c => c.service === svc);
    assert(row, 'a entrada de teste deveria estar no registro');
    assert(row.has_secret !== false,
      'REGRESSÃO: cofre ilegível reportado como "sem valor" — é exatamente o defeito ' +
      'que manda o usuário readicionar um segredo saudável');
    assertEq(row.has_secret, null, 'leitura falha não afirma nada sobre o valor');
    assertEq(row.verify_failed, true, 'o motivo do null precisa ser distinguível');
    assertEq(secrets.secretState(svc, 'x'), 'unknown');

    // The bite: `get()` is null here, so the old `has_secret: !!get(...)`
    // would have produced `false`. Anyone reverting list() to that form fails
    // the assertion above because of this exact condition.
    assertEq(secrets.get(svc, 'x'), null,
      'get() devolve null no cenário — é por isso que !!get() produziria false');
  } finally {
    if (previous === null) { try { fs.rmSync(FALLBACK, { force: true }); } catch {} }
    else {
      fs.writeFileSync(FALLBACK, previous, { mode: 0o600 });
      fs.chmodSync(FALLBACK, 0o600);
    }
    secrets.save(secrets.load().filter(c => c.service !== svc));
  }
});

test('raiz JSON válida mas não-objeto no arquivo fallback é INDETERMINADO, nunca "sem valor"', () => {
  // R1 review fix: JSON.parse succeeds on `null`, `[]`, a bare string or a
  // number just as well as on an object — but storeSecret always serializes a
  // plain object, so any other root is corruption, not an empty vault. Each
  // case below must report `unknown`/`has_secret: null`, never `absent`/`false`.
  const svc = SERVICE + 'nonobj';
  const FALLBACK = `${REGISTRY}.secrets`;

  const creds = secrets.load();
  creds.push({
    service: svc, name: 'x', env_var: 'X_TOKEN', note: '',
    store: 'file', added_at: new Date().toISOString(),
  });
  secrets.save(creds);

  const existed = fs.existsSync(FALLBACK);
  const previous = existed ? fs.readFileSync(FALLBACK, 'utf8') : null;
  try {
    for (const root of ['null', '[]', '"a string"', '42']) {
      fs.writeFileSync(FALLBACK, root, { mode: 0o600 });
      fs.chmodSync(FALLBACK, 0o600);

      const row = secrets.list({ verify: true }).find(c => c.service === svc);
      assert(row, `a entrada de teste deveria estar no registro (root=${root})`);
      assert(row.has_secret !== false,
        `REGRESSÃO (root=${root}): raiz JSON não-objeto reportada como "sem valor"`);
      assertEq(row.has_secret, null, `has_secret precisa ser null (root=${root})`);
      assertEq(secrets.secretState(svc, 'x'), 'unknown', `secretState precisa ser unknown (root=${root})`);
    }
  } finally {
    if (previous === null) { try { fs.rmSync(FALLBACK, { force: true }); } catch {} }
    else {
      fs.writeFileSync(FALLBACK, previous, { mode: 0o600 });
      fs.chmodSync(FALLBACK, 0o600);
    }
    secrets.save(secrets.load().filter(c => c.service !== svc));
  }
});

console.log('\nremoção');

test('remove apaga registro e segredo', () => {
  secrets.add({ service: SERVICE, name: 'temp', secret: 'apagar' });
  assertEq(secrets.remove(SERVICE, 'temp'), true);
  assertEq(secrets.find(SERVICE, 'temp'), null);
  assertEq(secrets.get(SERVICE, 'temp'), null, 'o segredo tem que sumir do cofre');
});

test('remover o que não existe devolve false', () => {
  assertEq(secrets.remove(SERVICE, 'fantasma'), false);
});

// ── Cleanup ─────────────────────────────────────────────────────────────────
for (const c of secrets.load()) {
  if (c.service === SERVICE) secrets.remove(c.service, c.name);
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n${'─'.repeat(60)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFalhas:');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.error}`);
}
console.log('');
process.exit(failed ? 1 : 0);
