#!/usr/bin/env node
// forge-accounts.test.js — contract tests for the account registry.
//
// The property under guard: listing accounts must NOT read the vault. It used
// to call readToken() per account, i.e. one `security find-generic-password`
// per registered account on every call — and the app lists at init, on
// .onAppear and after every mutation. On an ad-hoc signed bundle each read can
// cost an authorisation dialog.
//
// The fix cannot follow forge-secrets and make the field nullable:
// ForgeKit/Models.swift declares `has_token: Bool` NON-optional, so a null
// fails Codable for the entire account list. Hence the tests below assert both
// halves — zero vault reads AND a real boolean, always.
//
// Measurement, not code reading: on macOS a counting `security` shim goes on
// PATH ahead of the real one; elsewhere the file-backed store is made
// unavailable. Both prove the absence of a probe behaviourally.
//
// Run: node scripts/forge-accounts.test.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ENGINE = path.join(__dirname, 'forge-accounts.js');
const IS_DARWIN = process.platform === 'darwin';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-accounts-'));
const HOME = path.join(TMP, 'home');
const REGISTRY = path.join(TMP, 'registry.json');
const SHIM_DIR = path.join(TMP, 'bin');
const SEC_LOG = path.join(TMP, 'security-calls.log');
const SEC_STORE = path.join(TMP, 'keychain');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(SHIM_DIR, { recursive: true });
fs.mkdirSync(SEC_STORE, { recursive: true });

// A fake `security(1)`: logs every invocation, and emulates the keychain with
// one file per service so the darwin code path can be exercised end to end.
// FORGE_TEST_SECURITY_MODE=empty makes every lookup miss (exit 44), which is
// how the real tool reports "no such item".
if (IS_DARWIN) {
  fs.writeFileSync(path.join(SHIM_DIR, 'security'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FORGE_TEST_SECURITY_LOG"
cmd="$1"; shift
svc=""; val=""
while [ $# -gt 0 ]; do
  case "$1" in
    -s) svc="$2"; shift 2 ;;
    -w) if [ $# -gt 1 ] && [ "\${2#-}" = "$2" ]; then val="$2"; shift 2; else shift; fi ;;
    *) shift ;;
  esac
done
store="$FORGE_TEST_SECURITY_STORE"
case "$cmd" in
  add-generic-password) printf '%s' "$val" > "$store/$svc" ;;
  find-generic-password)
    [ "$FORGE_TEST_SECURITY_MODE" = "empty" ] && exit 44
    [ -f "$store/$svc" ] || exit 44
    cat "$store/$svc"; echo ;;
  delete-generic-password) rm -f "$store/$svc" ;;
esac
exit 0
`, { mode: 0o755 });
}

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

function cli(args, extraEnv) {
  return spawnSync(process.execPath, [ENGINE, ...args], {
    encoding: 'utf8',
    input: '',
    env: {
      ...process.env,
      HOME,
      USERPROFILE: HOME,
      FORGE_ACCOUNTS_REGISTRY: REGISTRY,
      FORGE_ACCOUNT: '',
      PATH: IS_DARWIN ? `${SHIM_DIR}${path.delimiter}${process.env.PATH}` : process.env.PATH,
      // run-tests.js sets FORGE_KEYCHAIN_DISABLED=1 for every suite so nothing
      // can reach the real `security` (it raises a modal dialog under an
      // isolated HOME). THIS suite is the sanctioned exception: it is the one
      // that measures the darwin branch, and it does so against the counting
      // shim installed above — which is ahead of the real binary on PATH, so
      // re-enabling here still cannot touch a real keychain. Cleared rather
      // than deleted so it also overrides an inherited value.
      FORGE_KEYCHAIN_DISABLED: '',
      FORGE_TEST_SECURITY_LOG: SEC_LOG,
      FORGE_TEST_SECURITY_STORE: SEC_STORE,
      ...(extraEnv || {}),
    },
  });
}

function listJson(extraArgs, extraEnv) {
  const r = cli(['--list', '--json', ...(extraArgs || [])], extraEnv);
  assert(r.status === 0, `--list falhou: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

function readRegistry() { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); }
function writeRegistry(reg) { fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n'); }

console.log('\ncontrato da variável de autenticação');

test('TOKEN_ENV exporta o único nome canônico do token Anthropic', () => {
  const accounts = require(ENGINE);
  const expected = ['ANTHROPIC', 'AUTH', 'TOKEN'].join('_');
  assertEq(accounts.TOKEN_ENV, expected);
});

function securityCalls() {
  try { return fs.readFileSync(SEC_LOG, 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
}
function resetSecurityLog() { try { fs.unlinkSync(SEC_LOG); } catch {} }

// Make the vault answer "nothing here" without touching the registry — the
// hostile condition that separates "read the metadata" from "probed the vault".
const TOKENS_FILE = path.join(HOME, '.claude', 'forge-accounts-tokens.json');
function hideVault() {
  if (IS_DARWIN) return { FORGE_TEST_SECURITY_MODE: 'empty' };
  try { fs.renameSync(TOKENS_FILE, `${TOKENS_FILE}.hidden`); } catch {}
  return {};
}
function restoreVault() {
  if (IS_DARWIN) return;
  try { fs.renameSync(`${TOKENS_FILE}.hidden`, TOKENS_FILE); } catch {}
}

console.log('\n=== forge-accounts.js — registry contract suite ===\n');

console.log('setup');

test('registra três contas com token', () => {
  for (const n of ['alfa', 'beta', 'gama']) {
    const r = cli(['--add', n, '--token', `sk-ant-oat01-${n}xyz`]);
    assert(r.status === 0, `--add ${n} falhou: ${r.stderr}`);
  }
  assertEq(Object.keys(readRegistry().accounts).sort(), ['alfa', 'beta', 'gama']);
});

test('o token NUNCA entra no registro', () => {
  // The whole reason the metadata is `token_store` (where) and not the value.
  const raw = fs.readFileSync(REGISTRY, 'utf8');
  assert(!/sk-ant-oat01-/.test(raw), 'registro contém um token');
});

test('add persiste token_store (onde), não o token', () => {
  const a = readRegistry().accounts.alfa;
  assertEq(a.token_store, IS_DARWIN ? 'keychain' : 'file');
});

console.log('\nlistagem não abre o cofre');

test(`--list --json faz ZERO chamadas a security${IS_DARWIN ? '' : ' (pulado: só darwin)'}`, () => {
  if (!IS_DARWIN) return; // no keychain path to count on this platform
  resetSecurityLog();
  const data = listJson();
  assertEq(securityCalls().length, 0,
    `listagem chamou security ${securityCalls().length}x:\n${securityCalls().join('\n')}`);
  assertEq(data.accounts.map(a => a.has_token), [true, true, true]);
});

test('o contador de chamadas realmente conta (controle)', () => {
  if (!IS_DARWIN) return;
  // Without this, "zero calls" could just mean the shim never runs.
  resetSecurityLog();
  listJson(['--verify']);
  assert(securityCalls().length >= 3,
    `--verify deveria ler o cofre; contou ${securityCalls().length}`);
});

test('cofre indisponível não muda has_token (nenhuma sondagem acontece)', () => {
  const env = hideVault();
  try {
    const data = listJson([], env);
    assertEq(data.accounts.map(a => a.has_token), [true, true, true],
      'has_token veio do cofre, não do registro');
  } finally { restoreVault(); }
});

console.log('\nbackfill preguiçoso (registros anteriores ao campo)');

test('registro sem token_store: --list mantém has_token correto e persiste', () => {
  // Registries written before this field exist in the wild. Reporting false
  // for them would empty the app's account pickers.
  const reg = readRegistry();
  for (const a of Object.values(reg.accounts)) delete a.token_store;
  delete reg.accounts.gama.store;
  writeRegistry(reg);

  const data = listJson();
  assertEq(data.accounts.map(a => a.has_token), [true, true, true],
    'backfill não recuperou a presença do token');

  const after = readRegistry();
  for (const n of ['alfa', 'beta', 'gama']) {
    assertEq(after.accounts[n].token_store, IS_DARWIN ? 'keychain' : 'file',
      `token_store não persistiu para ${n}`);
  }
});

test('o backfill sonda uma vez só', () => {
  if (!IS_DARWIN) return;
  const reg = readRegistry();
  delete reg.accounts.alfa.token_store;
  writeRegistry(reg);

  resetSecurityLog();
  listJson();
  const first = securityCalls().length;
  assert(first >= 1, 'o backfill deveria ter sondado uma vez');
  resetSecurityLog();
  listJson();
  assertEq(securityCalls().length, 0, 'sondou de novo após persistir o backfill');
  assert(first <= 1, `sondou ${first}x para uma única conta sem metadado`);
});

console.log('\nhas_token é sempre booleano');

test('conta sem token nenhum reporta false, nunca null', () => {
  // Swift: `public let has_token: Bool` — non-optional. A null breaks Codable
  // for the WHOLE list, not just this account.
  const reg = readRegistry();
  reg.accounts.orfa = { added_at: new Date().toISOString(), note: '', store: 'keychain' };
  writeRegistry(reg);

  const data = listJson();
  for (const a of data.accounts) {
    assertEq(typeof a.has_token, 'boolean', `has_token de ${a.name} não é booleano`);
  }
  assertEq(data.accounts.find(a => a.name === 'orfa').has_token, false);
  assertEq(readRegistry().accounts.orfa.token_store, false, 'ausência deveria ser persistida');
});

test('has_token nunca é null no JSON, nem com --verify', () => {
  const raw = cli(['--list', '--json', '--verify']).stdout;
  assert(!/"has_token"\s*:\s*null/.test(raw), 'has_token null quebraria o decode do Swift');
  for (const a of JSON.parse(raw).accounts) assertEq(typeof a.has_token, 'boolean');
});

console.log('\n--verify reconcilia com a realidade');

test('token some do cofre: --verify corrige o metadado; --list sozinho não', () => {
  const env = hideVault();
  try {
    assertEq(listJson([], env).accounts.find(a => a.name === 'beta').has_token, true,
      '--list deve confiar no metadado');
    const verified = listJson(['--verify'], env);
    assertEq(verified.accounts.find(a => a.name === 'beta').has_token, false);
    assertEq(readRegistry().accounts.beta.token_store, false, '--verify não persistiu a correção');
  } finally { restoreVault(); }
});

test('--verify volta a marcar presente quando o cofre responde de novo', () => {
  const data = listJson(['--verify']);
  assertEq(data.accounts.find(a => a.name === 'beta').has_token, true);
  assertEq(readRegistry().accounts.beta.token_store, IS_DARWIN ? 'keychain' : 'file');
});

console.log('\nmutações mantêm o metadado coerente');

test('rename leva o token_store para o slot novo', () => {
  const r = cli(['--rename', 'gama', '--to', 'delta']);
  assert(r.status === 0, `rename falhou: ${r.stderr}`);
  const reg = readRegistry();
  assert(!reg.accounts.gama, 'conta antiga sobreviveu');
  assertEq(reg.accounts.delta.token_store, IS_DARWIN ? 'keychain' : 'file');
  assertEq(listJson().accounts.find(a => a.name === 'delta').has_token, true);
});

test('remove apaga o registro inteiro (sem metadado órfão)', () => {
  const r = cli(['--remove', 'delta']);
  assert(r.status === 0, `remove falhou: ${r.stderr}`);
  assert(!('delta' in readRegistry().accounts), 'entrada permaneceu após remove');
  assert(!listJson().accounts.some(a => a.name === 'delta'));
});

console.log('\nsuperfícies de segredo inalteradas');

test('--token continua imprimindo o token (é o contrato do $( ))', () => {
  const r = cli(['--token', 'alfa']);
  assert(r.status === 0, `--token falhou: ${r.stderr}`);
  assert(r.stdout.includes('sk-ant-oat01-alfaxyz'), '--token deixou de funcionar');
});

test('--list não imprime nenhum token', () => {
  const r = cli(['--list']);
  assert(!/sk-ant-/.test(r.stdout + r.stderr), 'a listagem vazou um token');
  const j = cli(['--list', '--json', '--verify']);
  assert(!/sk-ant-/.test(j.stdout + j.stderr), 'a listagem --verify vazou um token');
});

console.log(`\n${passed} passaram, ${failed} falharam`);
if (failed) {
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error}`);
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
process.exit(failed ? 1 : 0);
