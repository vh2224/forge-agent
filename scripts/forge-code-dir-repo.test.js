#!/usr/bin/env node
'use strict';

// forge-code-dir-repo.test.js — the TASK-021 scenario, reproduced and paid.
//
// The incident: a whole slice of four tasks fell from the sidecar to Claude with
// `sidecar-code-dir-undeclared`, because `repo: freyr` matched nothing. The
// declaration was right; the LOOKUP was blind — `matchDeclaredRepo` searched the
// worktree list produced by `forge-repos.discoverRepos`, which walks one level
// down, while `freyr` lives at `services/freyr`, two down. The answer could not
// be in the list being searched.
//
// So the load-bearing property in this file is not "the new code passes". It is
// that the SAME fixture, run WITHOUT the injected index, reproduces the old
// `declared_repo_status: 'unknown'` — R1/R2 are one scenario asserted twice. A
// test that only ever passes proves nothing about what it detects.
//
// Scope guard, asserted rather than assumed: this fixes ADDRESSING, not isolation
// scoping. A name that resolves to a repo with no worktree in the run is still a
// refusal — same reason, same exit code 5 (R4). Only the hint improves.
//
// Every fixture lives in a tmpdir with a SYNTHETIC $HOME. Nothing here reads or
// writes the operator's real `~/.claude/forge-gate-workspaces.json`, and nothing
// runs git.
//
// Zero deps. Standalone runner, repo convention: exit != 0 on failure.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  resolveCodeDir,
  matchDeclaredRepo,
  normalizePath,
} = require('./forge-code-dir.js');

const { buildRepoIndex, resolveRepoName } = require('./forge-repo-index.js');

const CLI = path.join(__dirname, 'forge-code-dir.js');
const SOURCE = path.join(__dirname, 'forge-code-dir.js');

// ── Runner ──────────────────────────────────────────────────────────────────

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

function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'mismatch'}: esperado ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)}`);
  }
}

const tmps = [];

function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-code-dir-repo-'));
  tmps.push(d);
  return fs.realpathSync(d);
}

function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── Fixture: the measured shape of the incident ─────────────────────────────
//
// Workspace `lookchina` with TWO repos one level down (`web`, `api`) — exactly
// what `discoverRepos` can see, and therefore exactly what the isolation result
// carries — plus `services/freyr` two levels down, which it cannot. The plan
// declares `repo: freyr`.

function writeRegistry(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, roots: [], entries, quarantine: [] }, null, 2));
}

function makeFixture(opts) {
  const o = opts || {};
  const root = mktmp();
  const home = path.join(root, 'home');
  const ws = path.join(root, 'lookchina');
  const web = path.join(ws, 'web');
  const api = path.join(ws, 'api');
  const freyr = path.join(ws, 'services', 'freyr');
  const wts = path.join(root, '.forge-worktrees', 'RUN-1');

  for (const d of [home, web, api, freyr, path.join(wts, 'web'), path.join(wts, 'api')]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const file = path.join(home, '.claude', 'forge-gate-workspaces.json');
  writeRegistry(file, [
    { path: ws, root: null, kind: 'workspace', repos: ['api', 'services/freyr', 'web'] },
  ].concat(o.extraEntries || []));

  // The isolation result — one level only, as measured on the real disk.
  const repos = [
    { path: web, worktree: path.join(wts, 'web'), status: 'ok' },
    { path: api, worktree: path.join(wts, 'api'), status: 'ok' },
  ];
  if (o.isolateFreyr) {
    // The worktree of freyr under a DIFFERENT basename — matching must be by path.
    const wtFreyr = path.join(wts, 'freyr-checkout');
    fs.mkdirSync(wtFreyr, { recursive: true });
    repos.push({ path: freyr, worktree: wtFreyr, status: 'ok' });
  }

  const planPath = path.join(root, 'T01-PLAN.md');
  fs.writeFileSync(planPath, [
    '---',
    'id: T01',
    ...(o.noRepoField ? [] : [`repo: ${o.declare || 'freyr'}`]),
    'writes:',
    '  - "src/routes.ts"',
    '---',
    '',
    '# plano',
    '',
  ].join('\n'));

  return { root, home, file, ws, web, api, freyr, wts, planPath, isoResult: { mode: 'worktree', repos } };
}

/** The injected resolver: behaviour from forge-repo-index, never re-implemented here. */
function makeResolver(f, cwd) {
  const index = buildRepoIndex({ home: f.home, registryFile: f.file, cwd: cwd || f.ws });
  return (name, o) => resolveRepoName(name, { index, cwd: (o && o.cwd) || cwd || f.ws });
}

function runCli(args, env) {
  const r = spawnSync(process.execPath, [CLI].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, env || {}),
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// ── R1/R2: the bite proof ───────────────────────────────────────────────────

console.log('\n▸ forge-code-dir × repo index (TASK-021)\n');

test('R1 (mordida) — sem índice, o cenário TASK-021 reproduz o `unknown` antigo', () => {
  const f = makeFixture();
  const out = resolveCodeDir({ isoResult: f.isoResult, planPath: f.planPath, cwd: f.ws });
  assertEqual(out.status, 'undeclared', 'status');
  assertEqual(out.declared_repo, 'freyr', 'declared_repo');
  assertEqual(out.declared_repo_status, 'unknown', 'declared_repo_status');
  assertEqual(out.declared_repo_path, '', 'nenhum caminho é conhecido sem o índice');
  assert(/não casa com nenhum repo/.test(out.hint), 'hint antigo');
});

test('R2 — com o índice, `repo: freyr` resolve para o caminho absoluto exato', () => {
  const f = makeFixture();
  const out = resolveCodeDir({
    isoResult: f.isoResult, planPath: f.planPath, cwd: f.ws, repoIndex: makeResolver(f),
  });
  assertEqual(out.declared_repo_path, normalizePath(f.freyr), 'caminho resolvido');
  assert(out.declared_repo_status !== 'unknown', 'não é mais um miss cego');
});

test('R3 — o mesmo nome resolve de um cwd de worktree, fora do workspace', () => {
  const f = makeFixture();
  const outsideCwd = path.join(f.wts, 'web');
  const out = resolveCodeDir({
    isoResult: f.isoResult, planPath: f.planPath, cwd: outsideCwd, repoIndex: makeResolver(f, outsideCwd),
  });
  assertEqual(out.declared_repo_path, normalizePath(f.freyr), 'caminho resolvido de fora do workspace');
});

// ── R4: resolvido, mas não isolado — a recusa é MANTIDA ─────────────────────

test('R4 — resolvido-mas-não-isolado mantém reason e status; só o hint muda', () => {
  const f = makeFixture();
  const out = resolveCodeDir({
    isoResult: f.isoResult, planPath: f.planPath, cwd: f.ws, repoIndex: makeResolver(f),
  });
  assertEqual(out.status, 'undeclared', 'status de topo inalterado');
  assertEqual(out.reason, 'sidecar-code-dir-undeclared', 'reason inalterado');
  assertEqual(out.declared_repo_status, 'unisolated', 'sub-status novo (aditivo)');
  assertEqual(out.code_dir, '', 'nenhum CODE_DIR é inventado');
  // O hint embute `declared_repo_path`, que é NORMALIZADO (`\` → `/` por
  // normalizePath). Comparar contra o `f.freyr` cru casa por acidente no POSIX
  // e falha no Windows, onde path.join produz barras invertidas — esta é uma
  // das duas falhas remanescentes do item I-20260815014759. R3 logo acima já
  // compara pela forma normalizada; R4/R5 estavam fora de passo.
  assert(out.hint.includes(normalizePath(f.freyr)), `hint nomeia o caminho resolvido: ${out.hint}`);
  assert(/não tem worktree nesta run/.test(out.hint), 'hint explica que falta escopo, não nome');
});

test('R5 — a recusa de R4 sai com exit code 5 pela CLI (mirrors intactos)', () => {
  const f = makeFixture();
  const r = runCli([
    '--resolve', '--iso-result', JSON.stringify(f.isoResult), '--plan', f.planPath,
    '--cwd', f.ws, '--home', f.home, '--registry-file', f.file,
  ]);
  assertEqual(r.code, 5, 'exit');
  const j = JSON.parse(r.out);
  assertEqual(j.reason, 'sidecar-code-dir-undeclared', 'reason');
  assertEqual(j.declared_repo_status, 'unisolated', 'sub-status');
  assert(j.hint.includes(normalizePath(f.freyr)), 'hint com o caminho absoluto (forma normalizada — ver R4)');
});

// ── R6: resolve para uma worktree existente ─────────────────────────────────

// A declaração `services/freyr` avaliada de um cwd de WORKTREE — a situação real do
// sidecar. As três estratégias históricas falham todas ali: não é um caminho absoluto,
// `path.resolve(cwd, 'services/freyr')` aponta para dentro da worktree (não existe), e o
// basename declarado tem barra. Só o índice responde — e é este o caso que paga a task.
test('R6 — declaração relativa, de um cwd de worktree, resolve pelo índice', () => {
  const f = makeFixture({ isolateFreyr: true, declare: 'services/freyr' });
  const outsideCwd = path.join(f.wts, 'web');
  const out = resolveCodeDir({
    isoResult: f.isoResult, planPath: f.planPath, cwd: outsideCwd, repoIndex: makeResolver(f, outsideCwd),
  });
  assertEqual(out.status, 'ok', 'status');
  assertEqual(out.repo, f.freyr, 'repo');
  assertEqual(out.code_dir, path.join(f.wts, 'freyr-checkout'), 'code_dir é a worktree literal');
  assertEqual(out.declared_repo_source, 'repo-index', 'procedência registrada');
  assertEqual(out.declared_repo_status, 'ok', 'sub-status');
});

test('R7 — a CLI monta o índice por default: R6 resolve com exit 0 sem flag alguma', () => {
  const f = makeFixture({ isolateFreyr: true, declare: 'services/freyr' });
  const r = runCli([
    '--resolve', '--iso-result', JSON.stringify(f.isoResult), '--plan', f.planPath,
    '--cwd', path.join(f.wts, 'web'), '--home', f.home, '--registry-file', f.file,
  ]);
  assertEqual(r.code, 0, 'exit');
  const j = JSON.parse(r.out);
  assertEqual(j.declared_repo_source, 'repo-index', 'procedência');
  assertEqual(j.code_dir, path.join(f.wts, 'freyr-checkout'), 'code_dir');
});

test('R8 — `--no-repo-index` desliga a quarta estratégia', () => {
  const f = makeFixture({ isolateFreyr: true, declare: 'services/freyr' });
  const r = runCli([
    '--resolve', '--no-repo-index', '--iso-result', JSON.stringify(f.isoResult), '--plan', f.planPath,
    '--cwd', path.join(f.wts, 'web'), '--home', f.home, '--registry-file', f.file,
  ]);
  assertEqual(r.code, 5, 'sem índice, o mesmo caso de R7 volta a recusar');
  const j = JSON.parse(r.out);
  assertEqual(j.declared_repo_status, 'unknown', 'comportamento anterior');
  assertEqual(j.declared_repo_source, '', 'nenhuma procedência de índice');
});

test('R9 — índice ausente/ilegível degrada, nunca derruba o dispatch', () => {
  const f = makeFixture();
  const r = runCli([
    '--resolve', '--iso-result', JSON.stringify(f.isoResult), '--plan', f.planPath,
    '--cwd', f.ws, '--home', f.home, '--registry-file', path.join(f.root, 'inexistente.json'),
  ]);
  assertEqual(r.code, 5, 'exit — a recusa antiga, não um crash');
  assertEqual(JSON.parse(r.out).declared_repo_status, 'unknown', 'comportamento anterior');
});

// ── R10: as três estratégias históricas vencem primeiro ─────────────────────

test('R10 — um repo isolado sempre vence o índice (semântica antiga preservada)', () => {
  const f = makeFixture({ declare: 'web' });
  const out = resolveCodeDir({
    isoResult: f.isoResult, planPath: f.planPath, cwd: f.ws, repoIndex: makeResolver(f),
  });
  assertEqual(out.status, 'ok', 'status');
  assertEqual(out.repo, f.web, 'repo');
  assertEqual(out.declared_repo_source, '', 'casou por basename, não pelo índice');
});

// ── R11: nada é preenchido sozinho ──────────────────────────────────────────

test('R11 — plano sem `repo:` continua recusando mesmo com o índice completo', () => {
  const f = makeFixture({ noRepoField: true });
  const out = resolveCodeDir({
    isoResult: f.isoResult, planPath: f.planPath, cwd: f.ws, repoIndex: makeResolver(f),
  });
  assertEqual(out.status, 'undeclared', 'status');
  assertEqual(out.declared_repo, '', 'nada foi adivinhado');
  assertEqual(out.declared_repo_path, '', 'nenhum caminho foi inventado');
});

// ── R12: exit codes inalterados — um assert por código ──────────────────────

test('R12 — exit 0 (shared)', () => {
  const f = makeFixture();
  const r = runCli(['--resolve', '--iso-result', JSON.stringify({ mode: 'shared', repos: [] }),
    '--plan', f.planPath, '--cwd', f.ws, '--home', f.home, '--registry-file', f.file]);
  assertEqual(r.code, 0, 'exit');
  assertEqual(JSON.parse(r.out).status, 'shared', 'status');
});

test('R12 — exit 4 (cross-repo)', () => {
  const f = makeFixture({ noRepoField: true });
  const plan = path.join(f.root, 'T02-PLAN.md');
  fs.writeFileSync(plan, ['---', 'id: T02', 'writes:', `  - "${path.join(f.web, 'a.ts')}"`,
    `  - "${path.join(f.api, 'b.ts')}"`, '---', ''].join('\n'));
  const r = runCli(['--resolve', '--iso-result', JSON.stringify(f.isoResult),
    '--plan', plan, '--cwd', f.ws, '--home', f.home, '--registry-file', f.file]);
  assertEqual(r.code, 4, 'exit');
  assertEqual(JSON.parse(r.out).reason, 'sidecar-multirepo-unsupported', 'reason');
});

test('R12b — cross-repo declarado resolve cwd primario e writable root adicional', () => {
  const f = makeFixture({ noRepoField: true });
  const plan = path.join(f.root, 'T02-primary-PLAN.md');
  fs.writeFileSync(plan, ['---', 'id: T02', 'repo: web', 'writes:', `  - "${path.join(f.web, 'a.ts')}"`,
    `  - "${path.join(f.api, 'b.ts')}"`, '---', ''].join('\n'));
  const out = resolveCodeDir({ isoResult: f.isoResult, planPath: plan, cwd: f.ws });
  assertEqual(out.status, 'ok', 'status');
  assertEqual(out.resolution, 'multi-repo-declared', 'resolution');
  assertEqual(path.resolve(out.code_dir), path.resolve(f.wts, 'web'), 'cwd primario');
  assertEqual(out.repo_roots.length, 2, 'todas as raizes');
  assertEqual(out.writable_roots.length, 1, 'somente raiz adicional');
  assertEqual(path.resolve(out.writable_roots[0]), path.resolve(f.wts, 'api'), 'api como writable root');
});

test('R12c — escopo parcialmente atribuivel recusa antes do dispatch', () => {
  const f = makeFixture({ noRepoField: true });
  const plan = path.join(f.root, 'T02-partial-PLAN.md');
  const outside = path.join(f.root, 'repo-nao-isolado', 'secret.ts');
  fs.writeFileSync(plan, ['---', 'id: T02', 'repo: web', 'writes:', `  - "${path.join(f.web, 'a.ts')}"`,
    `  - "${outside}"`, '---', ''].join('\n'));
  const out = resolveCodeDir({ isoResult: f.isoResult, planPath: plan, cwd: f.ws });
  assertEqual(out.status, 'cross-repo', 'status fail-closed');
  assertEqual(out.reason, 'sidecar-multirepo-unsupported', 'reason');
  assertEqual(out.paths_unmatched, 1, 'path omitido permanece visivel');
  assertEqual(out.code_dir, '', 'nenhum cwd parcial e emitido');
  assertEqual(out.repo_roots.length, 0, 'nenhum snapshot parcial e autorizado');
});

test('R12d — path absoluto externo sozinho nunca herda o repo declarado', () => {
  const f = makeFixture({ noRepoField: true });
  const plan = path.join(f.root, 'T02-external-only-PLAN.md');
  const outside = path.join(f.root, 'fora-dos-repos', 'secret.ts');
  fs.writeFileSync(plan, ['---', 'id: T02', 'repo: web', 'writes:', `  - "${outside}"`, '---', ''].join('\n'));
  const out = resolveCodeDir({ isoResult: f.isoResult, planPath: plan, cwd: f.ws });
  assertEqual(out.status, 'cross-repo', 'status fail-closed');
  assertEqual(out.paths_unmatched, 1, 'absoluto externo contabilizado');
  assertEqual(out.code_dir, '', 'repo declarado nao captura absoluto externo');
  assertEqual(out.repo_roots.length, 0, 'nenhum escopo incompleto emitido');
});

test('R12e — traversal relativo que escapa do workspace e recusado', () => {
  const f = makeFixture({ noRepoField: true });
  for (const [name, escaped] of [['parent', '../outside/x.ts'], ['nested', 'web/../../outside/x.ts']]) {
    const plan = path.join(f.root, `T02-traversal-${name}-PLAN.md`);
    fs.writeFileSync(plan, ['---', 'id: T02', 'repo: web', 'writes:', `  - "${escaped}"`, '---', ''].join('\n'));
    const out = resolveCodeDir({ isoResult: f.isoResult, planPath: plan, cwd: f.ws });
    assertEqual(out.status, 'cross-repo', `${name}: status fail-closed`);
    assertEqual(out.code_dir, '', `${name}: nenhum cwd parcial`);
    assertEqual(out.repo_roots.length, 0, `${name}: nenhum escopo parcial`);
  }
});

test('R12 — exit 5 (undeclared)', () => {
  const f = makeFixture({ noRepoField: true });
  const r = runCli(['--resolve', '--iso-result', JSON.stringify(f.isoResult),
    '--plan', f.planPath, '--cwd', f.ws, '--home', f.home, '--registry-file', f.file]);
  assertEqual(r.code, 5, 'exit');
});

test('R12 — exit 2 (uso)', () => {
  const r = runCli(['--iso-result', '{}']);
  assertEqual(r.code, 2, 'exit');
});

// ── R13: pureza da biblioteca, provada varrendo o próprio texto ─────────────

test('R13 (pureza) — nenhum require de forge-repo-index fora da fronteira da CLI', () => {
  const src = fs.readFileSync(SOURCE, 'utf8');
  const boundary = src.indexOf('function cliMain(');
  assert(boundary > 0, 'fronteira da CLI localizada');

  const needle = "require('./forge-repo-index.js')";
  const hits = [];
  let at = src.indexOf(needle);
  while (at !== -1) { hits.push(at); at = src.indexOf(needle, at + 1); }

  assertEqual(hits.length, 1, 'exatamente um require do índice');
  assert(hits[0] > boundary, 'o require vive dentro de cliMain, depois de toda a biblioteca pura');

  // E nenhuma leitura de registry na biblioteca: o nome do arquivo do registry
  // não aparece em lugar nenhum do módulo.
  assert(!src.includes('forge-gate-workspaces.json'), 'nenhuma leitura direta de registry');
});

test('R13 (pureza) — matchDeclaredRepo com resolver injetado não toca disco algum', () => {
  const usable = [{ path: '/w/web', worktree: '/wt/web', status: 'ok' }];
  const calls = [];
  const m = matchDeclaredRepo('freyr', usable, '/w', (name, o) => {
    calls.push([name, o && o.cwd]);
    return { status: 'ok', path: '/w/services/freyr' };
  });
  assertEqual(calls.length, 1, 'o resolver injetado é a ÚNICA fonte');
  assertEqual(calls[0][0], 'freyr', 'nome repassado');
  assertEqual(m.status, 'unisolated', 'resolveu, mas não há worktree');
  assertEqual(m.path, '/w/services/freyr', 'caminho preservado');
});

test('R13 — um resolver que lança degrada para o veredito antigo', () => {
  const usable = [{ path: '/w/web', worktree: '/wt/web', status: 'ok' }];
  const m = matchDeclaredRepo('freyr', usable, '/w', () => { throw new Error('boom'); });
  assertEqual(m.status, 'unknown', 'degrada, não propaga');
});

// ── R14: o repo registrado como entrada própria (rota do disco real) ────────

test('R14 — freyr registrado como entrada própria (repos[] vazio) também resolve', () => {
  const root = mktmp();
  const home = path.join(root, 'home');
  const ws = path.join(root, 'lookchina');
  const web = path.join(ws, 'web');
  const api = path.join(ws, 'api');
  const freyr = path.join(ws, 'services', 'freyr');
  const wts = path.join(root, '.forge-worktrees', 'RUN-9');
  for (const d of [home, web, api, freyr, path.join(wts, 'web'), path.join(wts, 'api')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const file = path.join(home, '.claude', 'forge-gate-workspaces.json');
  // Sem `--sync-repos`: o workspace não tem índice, mas freyr está registrado sozinho.
  writeRegistry(file, [
    { path: ws, root: null, kind: 'workspace', repos: [] },
    { path: freyr, root: null, kind: 'project', repos: [] },
  ]);

  const planPath = path.join(root, 'T01-PLAN.md');
  fs.writeFileSync(planPath, ['---', 'id: T01', 'repo: freyr', 'writes:', '  - "src/x.ts"', '---', ''].join('\n'));

  const isoResult = { mode: 'worktree', repos: [
    { path: web, worktree: path.join(wts, 'web'), status: 'ok' },
    { path: api, worktree: path.join(wts, 'api'), status: 'ok' },
  ] };

  const index = buildRepoIndex({ home, registryFile: file, cwd: ws });
  const out = resolveCodeDir({
    isoResult, planPath, cwd: ws,
    repoIndex: (name, o) => resolveRepoName(name, { index, cwd: (o && o.cwd) || ws }),
  });
  assertEqual(out.declared_repo_path, normalizePath(freyr), 'endereçamento funciona antes de qualquer --sync-repos');
});

// ── Summary ─────────────────────────────────────────────────────────────────

cleanup();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFalhas:');
  for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.error}`);
  process.exit(1);
}
