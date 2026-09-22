#!/usr/bin/env node
'use strict';

// forge-overlap.test.js — the verdict that cannot lie about its own work.
//
// The suite is organised around the one property S07 exists to defend:
//
//   R1  two runs touching the SAME file -> `overlap`, with both run ids, the
//       repo and the file path present in the human output (the bite).
//   R2  disjoint touches -> `clean` AND `pairs_compared === 1`, asserted
//       TOGETHER. A `clean` backed by zero pairs must be unconstructible.
//   R3  the floor: zero comparable runs, and exactly one comparable run, both
//       yield `inconclusive` with a named reason — and `verdict !== 'clean'`
//       is asserted explicitly in each.
//   R4  the floor BITES: a mutant copy of the source, with the
//       `pairs_compared === 0` branch returning `'clean'`, makes R3's
//       assertions fail. A floor never seen failing is not a floor (TASK-021).
//   R5  `--check` exits 0 WITH overlap present — spawned, status read.
//   R6  zero mutation: SHA-256 of every `.gsd/forge/runs/*.json` before and
//       after `--check` is identical.
//   R7  the locked boundary, in executable form: neither the source (comments
//       stripped) nor the CLI output carries integration-pipeline vocabulary.
//   R8  `OVERLAP_REASONS` crossed in BOTH directions against what the code
//       actually emits.
//   R9  `verdict` is always a member of `VERDICTS`, and the census accounts
//       for every run in the registry — none is dropped unnamed.
//   R10 HARD SAFETY: the operator's live registry was never written.
//
// Every fixture lives in a tmpdir under a SYNTHETIC $HOME. Zero deps.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MODULE = path.join(__dirname, 'forge-overlap.js');
const overlap = require('./forge-overlap.js');
const {
  collectRunTouches, computeOverlap, formatOverlap,
  VERDICTS, OVERLAP_REASONS,
} = overlap;

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

// ── tmp + synthetic $HOME ───────────────────────────────────────────────────
const tmps = [];
function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'forge-overlap-'));
  tmps.push(d);
  return fs.realpathSync(d);
}
function cleanup() {
  for (const d of tmps) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── R10 (opening half): the operator's live registry, before anything runs ──
const REAL_HOME = os.userInfo().homedir;
const LIVE_REGISTRY = path.join(REAL_HOME, '.claude', 'forge-gate-workspaces.json');
function liveRegistryStamp() {
  try {
    const st = fs.statSync(LIVE_REGISTRY);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'absent';
  }
}
const LIVE_BEFORE = liveRegistryStamp();

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const FAKE_HOME = mktmp('forge-overlap-home-');
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

// ── Reasons observed across the whole suite (R8 crosses them at the end) ────
const reasonsSeen = new Set();
function noteReasons(result) {
  for (const s of result.skipped) reasonsSeen.add(s.reason);
  for (const n of result.notes) reasonsSeen.add(n.reason);
}

// ── Fixture builders ────────────────────────────────────────────────────────

/** A cwd with a `.gsd/forge/runs/` registry and nothing else. */
function makeWorkspace() {
  const dir = mktmp('forge-overlap-ws-');
  fs.mkdirSync(path.join(dir, '.gsd', 'forge', 'runs'), { recursive: true });
  return dir;
}

/**
 * Write one RunRecord. `touched` is passed through verbatim — including
 * `undefined`, which yields a record with NO `touched` key, the on-disk shape
 * of a run that was never captured (`no-touch-record`).
 */
function writeRun(ws, id, touched, opts) {
  const o = opts || {};
  const rec = {
    id,
    kind: 'milestone',
    session_id: `sess-${id}`,
    started_at: Date.now(),
    active: o.active === undefined ? true : o.active,
  };
  if (touched !== undefined) rec.touched = touched;
  fs.writeFileSync(
    path.join(ws, '.gsd', 'forge', 'runs', `${id}.json`),
    JSON.stringify(rec, null, 2),
    'utf8',
  );
  return rec;
}

/** A `touched` snapshot in T01's shape, all repos healthy. */
function touchedOk(repos) {
  return {
    at: Date.now(),
    examined: repos.length,
    repos: repos.map((r) => ({
      name: r.name, path: r.path || null, source: r.source || 'address',
      // `undefined` when the caller omits it — the on-disk shape of a snapshot
      // written before `repo_id` existed, which must still compare by path.
      repo_id: r.repo_id,
      status: 'ok', reason: null, files: r.files,
    })),
  };
}

/** A `touched` snapshot carrying one SKIPPED repo with a T01 reason. */
function touchedSkipped(name, reason) {
  return {
    at: Date.now(),
    examined: 1,
    repos: [{ name, path: null, source: 'address', status: 'skipped', reason, files: [] }],
  };
}

function runCli(ws, extra) {
  return spawnSync(process.execPath, [MODULE, '--check', '--cwd', ws].concat(extra || []), {
    encoding: 'utf8',
  });
}

// ── R1 — the bite ───────────────────────────────────────────────────────────

test('R1: two runs touching the same file yield verdict "overlap"', () => {
  const ws = makeWorkspace();
  writeRun(ws, 'M-aaa', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts', 'src/x.ts'] }]));
  writeRun(ws, 'M-bbb', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts', 'src/y.ts'] }]));

  const result = computeOverlap(collectRunTouches(ws, {}));
  noteReasons(result);

  assertEqual(result.verdict, 'overlap', 'mesmo arquivo em duas runs deve dar overlap');
  assertEqual(result.pairs_compared, 1, 'um par deve ter sido percorrido');
  assertEqual(result.overlaps.length, 1, 'exatamente uma sobreposição');
  assertEqual(result.overlaps[0].repo, 'freyr', 'repo da sobreposição');
  assert(result.overlaps[0].files.includes('src/a.ts'), 'o arquivo em comum deve estar listado');
  assert(!result.overlaps[0].files.includes('src/x.ts'), 'arquivo exclusivo de uma run não é sobreposição');

  // The pair of ids, the repo and the path must all be READABLE, not merely
  // present in the object — the flag is for a human before a merge.
  const out = formatOverlap(result);
  assert(out.includes('M-aaa'), 'saída legível deve conter o primeiro run id');
  assert(out.includes('M-bbb'), 'saída legível deve conter o segundo run id');
  assert(out.includes('freyr'), 'saída legível deve conter o repo');
  assert(out.includes('src/a.ts'), 'saída legível deve conter o caminho do arquivo');
});

test('R1b: same file name in DIFFERENT repos is not a collision', () => {
  const ws = makeWorkspace();
  writeRun(ws, 'M-aaa', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }]));
  writeRun(ws, 'M-bbb', touchedOk([{ name: 'skuld', path: '/w/skuld', files: ['src/a.ts'] }]));

  const result = computeOverlap(collectRunTouches(ws, {}));
  noteReasons(result);
  assertEqual(result.verdict, 'clean', 'repos distintos não colidem');
  assertEqual(result.pairs_compared, 1, 'o par ainda foi confrontado');
});

test('R1c: same repo NAME at different paths (and no repo_id) is not a collision', () => {
  const ws = makeWorkspace();
  writeRun(ws, 'M-aaa', touchedOk([{ name: 'freyr', path: '/w/one/freyr', files: ['src/a.ts'] }]));
  writeRun(ws, 'M-bbb', touchedOk([{ name: 'freyr', path: '/w/two/freyr', files: ['src/a.ts'] }]));

  const result = computeOverlap(collectRunTouches(ws, {}));
  noteReasons(result);
  assertEqual(result.verdict, 'clean', 'duas árvores de trabalho distintas não colidem entre si');
});

// ── R1d/R1e — checkout-invariant identity (review-fix R2) ───────────────────
//
// The bug this replaces: `reposMatch` compared PATHS whenever both entries
// carried one. Two runs in `worktree` isolation live at
// `.forge-worktrees/{RUN-A}/freyr` and `.forge-worktrees/{RUN-B}/freyr` —
// different paths — yet both branches merge into the same default branch, so
// a file in both is exactly the merge conflict this module exists to flag.
// Path comparison answered `clean` there, with a full and confident census.

test('R1d: two WORKTREES of the same repo, same file — repo_id makes it an overlap', () => {
  const ws = makeWorkspace();
  const id = '/w/freyr/.git'; // one object store, two checkouts cut from it
  writeRun(ws, 'M-aaa', touchedOk([
    { name: 'freyr', path: '/w/.forge-worktrees/M-aaa/freyr', repo_id: id, files: ['src/a.ts', 'src/x.ts'] },
  ]));
  writeRun(ws, 'M-bbb', touchedOk([
    { name: 'freyr', path: '/w/.forge-worktrees/M-bbb/freyr', repo_id: id, files: ['src/a.ts', 'src/y.ts'] },
  ]));

  const result = computeOverlap(collectRunTouches(ws, {}));
  noteReasons(result);
  assertEqual(result.verdict, 'overlap', 'dois worktrees do MESMO repo colidem — os dois ramos voltam para a mesma default');
  assertEqual(result.pairs_compared, 1, 'o par foi de fato confrontado');
  assertEqual(result.overlaps[0].files.join(','), 'src/a.ts', 'só o arquivo em comum');
});

test('R1e: two independent CLONES at different paths still do NOT collide (repo_id differs)', () => {
  const ws = makeWorkspace();
  writeRun(ws, 'M-aaa', touchedOk([{ name: 'freyr', path: '/w/one/freyr', repo_id: '/w/one/freyr/.git', files: ['src/a.ts'] }]));
  writeRun(ws, 'M-bbb', touchedOk([{ name: 'freyr', path: '/w/two/freyr', repo_id: '/w/two/freyr/.git', files: ['src/a.ts'] }]));

  const result = computeOverlap(collectRunTouches(ws, {}));
  noteReasons(result);
  assertEqual(result.verdict, 'clean', 'clones independentes têm object stores distintos — não são o mesmo repo');
  assertEqual(result.pairs_compared, 1, 'e o par ainda foi confrontado, não pulado');
});

test('R1f: repo_id NEVER degrades to name-only — apps/norns and services/norns stay distinct', () => {
  // The failure mode explicitly rejected in review: matching by name alone
  // would have "fixed" R1d too, at the cost of collapsing the operator's
  // default-case basename collision into one repo.
  const ws = makeWorkspace();
  writeRun(ws, 'M-aaa', touchedOk([{ name: 'norns', path: '/w/apps/norns', repo_id: '/w/apps/norns/.git', files: ['src/a.ts'] }]));
  writeRun(ws, 'M-bbb', touchedOk([{ name: 'norns', path: '/w/services/norns', repo_id: '/w/services/norns/.git', files: ['src/a.ts'] }]));

  const result = computeOverlap(collectRunTouches(ws, {}));
  noteReasons(result);
  assertEqual(result.verdict, 'clean', 'mesmo basename, repos diferentes — jamais uma colisão');
});

// ── R2 — clean, with proof of work ──────────────────────────────────────────

test('R2: disjoint touches yield "clean" AND pairs_compared >= 1', () => {
  const ws = makeWorkspace();
  writeRun(ws, 'M-aaa', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }]));
  writeRun(ws, 'M-bbb', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/b.ts'] }]));

  const result = computeOverlap(collectRunTouches(ws, {}));
  noteReasons(result);

  // The two assertions belong TOGETHER: `clean` is a claim about work done,
  // so the count of work done is part of what makes it true.
  assertEqual(result.verdict, 'clean', 'toques disjuntos devem dar clean');
  assert(result.pairs_compared >= 1, 'clean só é alcançável tendo comparado ao menos um par');
  assertEqual(result.pairs_compared, 1, 'exatamente um par para duas runs');
  assertEqual(result.files_compared, 2, 'os dois caminhos foram efetivamente confrontados');
  assertEqual(result.overlaps.length, 0, 'nenhuma sobreposição');
});

test('R2b: a run recorded with zero files still participates (note, not skip)', () => {
  const ws = makeWorkspace();
  writeRun(ws, 'M-aaa', touchedOk([{ name: 'freyr', path: '/w/freyr', files: [] }]));
  writeRun(ws, 'M-bbb', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/b.ts'] }]));

  const result = computeOverlap(collectRunTouches(ws, {}));
  noteReasons(result);

  assertEqual(result.verdict, 'clean', 'recorded-and-empty é uma resposta comparável');
  assertEqual(result.pairs_compared, 1, 'a run vazia entra no laço de pares');
  assertEqual(result.runs_with_touch_data, 2, 'ambas contam como tendo dado de toque');
  const noted = result.notes.filter((n) => n.reason === 'touch-record-empty-but-recorded');
  assertEqual(noted.length, 1, 'a run vazia aparece em notes');
  assert(!result.skipped.some((s) => s.id === 'M-aaa'), 'recorded-and-empty NÃO é skip');
});

// ── R3 — the anti-silence floor ─────────────────────────────────────────────

/**
 * The floor assertions, factored out so R4 can run the EXACT same checks
 * against a mutated copy of the module and watch them go red. If these were
 * inlined, R4 would prove something adjacent instead of this.
 */
function assertFloor(mod) {
  // (i) zero runs carrying touch data
  const ws0 = makeWorkspace();
  writeRun(ws0, 'M-aaa', undefined);
  writeRun(ws0, 'M-bbb', undefined);
  const r0 = mod.computeOverlap(mod.collectRunTouches(ws0, {}));
  assertEqual(r0.pairs_compared, 0, 'nenhum par com zero runs comparáveis');
  assertEqual(r0.verdict, 'inconclusive', 'zero comparáveis deve dar inconclusive');
  assert(r0.verdict !== 'clean', 'zero comparáveis NUNCA pode dar clean');
  assert(r0.skipped.some((s) => s.reason === 'no-touch-record'), 'runs sem registro entram no censo com razão');

  // (ii) exactly one run carrying touch data
  const ws1 = makeWorkspace();
  writeRun(ws1, 'M-aaa', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }]));
  writeRun(ws1, 'M-bbb', undefined);
  const r1 = mod.computeOverlap(mod.collectRunTouches(ws1, {}));
  assertEqual(r1.pairs_compared, 0, 'uma run só não forma par');
  assertEqual(r1.verdict, 'inconclusive', 'uma run só deve dar inconclusive');
  assert(r1.verdict !== 'clean', 'uma run só NUNCA pode dar clean');
  assert(
    r1.skipped.some((s) => s.reason === 'not-comparable-single-run'),
    'a razão not-comparable-single-run tem que estar nomeada no censo',
  );

  // (iii) the reason must be on the FIRST line — a mute `inconclusive`
  //       repeats the defect it exists to prevent.
  const first = mod.formatOverlap(r1).split('\n')[0];
  assert(first.includes('inconclusive'), 'primeira linha deve trazer o veredicto');
  assert(first.length > 'forge-overlap: inconclusive'.length + 3, 'primeira linha deve trazer a razão junto');
  return { r0, r1 };
}

test('R3: zero and one comparable run both yield "inconclusive", never "clean"', () => {
  const { r0, r1 } = assertFloor(overlap);
  noteReasons(r0);
  noteReasons(r1);
});

test('R3b: inactive runs are excluded by name, and --all brings them back', () => {
  const ws = makeWorkspace();
  writeRun(ws, 'M-aaa', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }]));
  writeRun(ws, 'M-bbb', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }]), { active: false });

  const def = computeOverlap(collectRunTouches(ws, {}));
  noteReasons(def);
  assertEqual(def.verdict, 'inconclusive', 'só uma run ativa sobra — nada a comparar');
  assert(def.skipped.some((s) => s.id === 'M-bbb' && s.reason === 'run-inactive'), 'a inativa é nomeada, não sumida');

  const all = computeOverlap(collectRunTouches(ws, { all: true }));
  noteReasons(all);
  assertEqual(all.verdict, 'overlap', '--all traz a inativa de volta e a colisão aparece');
});

// ── R4 — the floor bites (mutation) ─────────────────────────────────────────

test('R4: mutating the floor to return "clean" turns R3 red', () => {
  const pristine = fs.readFileSync(MODULE);
  const src = pristine.toString('utf8').replace(/\r\n/g, '\n');

  const NEEDLE = "  if (pairs_compared === 0) {\n    verdict = 'inconclusive';";
  assert(src.includes(NEEDLE), 'o alvo da mutação precisa existir literalmente no fonte');
  const mutated = src.replace(NEEDLE, "  if (pairs_compared === 0) {\n    verdict = 'clean';");
  assert(mutated !== src, 'a mutação precisa ter mudado algo');

  // The mutant is a SEPARATE file in this same directory (so its relative
  // requires still resolve) — the real module is never written to, which is
  // what lets R6/R10's zero-write claims stay unqualified.
  const mutantPath = path.join(__dirname, '.forge-overlap.mutant.js');
  let sawRed = false;
  let redMessage = '';
  try {
    fs.writeFileSync(mutantPath, mutated, 'utf8');
    const mutant = require(mutantPath);
    try {
      assertFloor(mutant);
    } catch (e) {
      sawRed = true;
      redMessage = e.message;
    }
  } finally {
    delete require.cache[require.resolve(mutantPath)];
    try { fs.unlinkSync(mutantPath); } catch { /* best effort */ }
  }

  assert(sawRed, 'MUTATION SURVIVED: o piso devolveu "clean" e R3 continuou verde — o piso não está sendo testado');
  assert(/clean/.test(redMessage), `a falha deve apontar o clean indevido, veio: ${redMessage}`);

  // And the real module is byte-identical — the mutation never touched it.
  assert(fs.readFileSync(MODULE).equals(pristine), 'o fonte real deve permanecer byte-idêntico');
});

// ── R5 — advisory is behaviour: exit 0 WITH overlap present ─────────────────

test('R5: the CLI exits 0 even when it detects overlap', () => {
  const ws = makeWorkspace();
  writeRun(ws, 'M-aaa', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }]));
  writeRun(ws, 'M-bbb', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }]));

  const res = runCli(ws);
  assertEqual(res.status, 0, `exit deve ser 0 mesmo com sobreposição (stderr: ${res.stderr})`);
  assert(res.stdout.includes('overlap'), 'a saída deve trazer o flag de sobreposição');
  assert(res.stdout.includes('src/a.ts'), 'a saída deve trazer o arquivo');
  assert(res.stdout.includes('M-aaa') && res.stdout.includes('M-bbb'), 'a saída deve trazer os dois run ids');

  const asJson = runCli(ws, ['--json']);
  assertEqual(asJson.status, 0, 'exit 0 também em --json');
  const parsed = JSON.parse(asJson.stdout);
  assertEqual(parsed.verdict, 'overlap', 'JSON traz o mesmo veredicto');
  for (const k of ['runs_examined', 'runs_with_touch_data', 'pairs_compared', 'files_compared', 'skipped']) {
    assert(Object.prototype.hasOwnProperty.call(parsed, k), `o censo deve carregar ${k}`);
  }
});

// ── R6 — zero mutation of RunRecords ────────────────────────────────────────

test('R6: --check leaves every RunRecord byte-identical (SHA-256 before/after)', () => {
  const ws = makeWorkspace();
  writeRun(ws, 'M-aaa', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }]));
  writeRun(ws, 'M-bbb', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }]));
  writeRun(ws, 'M-ccc', undefined);

  const dir = path.join(ws, '.gsd', 'forge', 'runs');
  const hashAll = () => {
    const out = {};
    for (const f of fs.readdirSync(dir).sort()) {
      out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex');
    }
    return out;
  };

  const before = hashAll();
  assertEqual(Object.keys(before).length, 3, 'três records no fixture');

  const res = runCli(ws);
  assertEqual(res.status, 0, 'exit 0');
  const alsoAll = runCli(ws, ['--all']);
  assertEqual(alsoAll.status, 0, 'exit 0 com --all');

  const after = hashAll();
  assertEqual(Object.keys(after).join(','), Object.keys(before).join(','), 'nenhum arquivo criado ou removido');
  for (const f of Object.keys(before)) {
    assertEqual(after[f], before[f], `o record ${f} não pode ter sido mutado`);
  }
});

// ── R7 — the locked boundary, asserted rather than described ───────────────

/**
 * Strip `//` and block comments, tracking string/template state so a `//`
 * inside a literal is not mistaken for a comment. What remains is the code
 * the scan below is entitled to judge.
 *
 * The distinction matters and is the whole point of R7: the header of
 * `forge-overlap.js` DECLARES the excluded vocabulary in order to forbid it,
 * so a naive grep over the raw file would fire on the very comment that
 * states the boundary. Anchoring on code and on CLI output instead means the
 * assertion bites when someone adds real sequencing behaviour, and stays
 * quiet when someone merely writes about it.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (quote) {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && d === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Vocabulary of the product S07 explicitly refuses to become. Matched against
// CODE and OUTPUT only (see stripComments' note).
const PIPELINE_VOCAB = [
  /merge[\s_-]*queue/i,
  /\bqueue[sd]?\b/i,
  /\bspeculative\b/i,
  /\bblock(?:s|ed|ing)?\b/i,
  /\bbloquei?a?r?\b/i,
  /\border[\s_-]?first\b/i,
  /\bordena[rm]?\b/i,
  /\bpriorit/i,
];

test('R7: no integration-pipeline vocabulary in the code or the CLI output', () => {
  const code = stripComments(fs.readFileSync(MODULE, 'utf8'));

  // Sanity: the stripper must actually have removed the header that DOES
  // contain the vocabulary — otherwise this test would be trivially green
  // for the wrong reason (a stripper that deleted everything) or trivially
  // red (a stripper that removed nothing).
  assert(code.includes('function computeOverlap'), 'o stripper não pode ter comido o código');
  assert(!code.includes('speculative integration'), 'o stripper deve ter removido o comentário de fronteira');
  assert(code.length > 1500, 'sobrou código suficiente para a varredura ser significativa');

  for (const re of PIPELINE_VOCAB) {
    const m = code.match(re);
    assert(!m, `vocabulário de fila vazou para o código de forge-overlap.js: ${m && m[0]}`);
  }

  // And the same for what a human actually reads, under BOTH verdicts.
  const ws = makeWorkspace();
  writeRun(ws, 'M-aaa', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }]));
  writeRun(ws, 'M-bbb', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }]));
  const withOverlap = runCli(ws).stdout;
  const usage = spawnSync(process.execPath, [MODULE, '--help'], { encoding: 'utf8' }).stdout;

  for (const re of PIPELINE_VOCAB) {
    const a = withOverlap.match(re);
    assert(!a, `a saída da CLI recomendou/ordenou algo: ${a && a[0]}`);
    const b = usage.match(re);
    assert(!b, `o USAGE promete comportamento de fila: ${b && b[0]}`);
  }

  // Positive control: the scan is capable of firing. If this were silently
  // broken (a regex that matches nothing), every assertion above would pass
  // vacuously — the exact failure this milestone was bitten by three times.
  const fired = PIPELINE_VOCAB.some((re) => re.test('this module would block the merge queue and order first'));
  assert(fired, 'o próprio detector de vocabulário está morto — varredura vacuamente verde');
});

// ── R11 — THE CENTREPIECE: two real worktrees, end to end ──────────────────
//
// Every test above this line feeds `computeOverlap` a hand-written snapshot.
// This one builds two REAL `git worktree`s of ONE repo, lets the shipped
// `forge-touch` derive both snapshots from git, and asks the shipped
// comparator. It is the case that was impossible to construct before the
// review fixes, and it is impossible to pass with either of them missing:
//
//   - without R1 (forge-touch worktree awareness), both runs derive from the
//     same registered checkout: identical empty diffs, verdict `clean`;
//   - without R2 (repo_id in reposMatch), the two worktree PATHS differ, the
//     repos never match, verdict `clean`.
//
// Both spellings of the failure are the same lie — a confident `clean` over
// two runs headed for a merge conflict in `shared.ts`.

const { execFileSync } = require('child_process');
const touchMod = require('./forge-touch.js');

function gitIn(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('R11: two runs in two real worktrees of ONE repo, same file -> overlap (end to end)', () => {
  const tmp = mktmp('forge-overlap-e2e-');
  const home = path.join(tmp, 'home');
  const ws = path.join(home, 'Development', 'ws');
  const repo = path.join(ws, 'repo-a');
  fs.mkdirSync(path.join(ws, '.gsd'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.gsd', 'PROJECT.md'), '# fixture\n', 'utf8');

  fs.mkdirSync(repo, { recursive: true });
  gitIn(repo, ['init', '-q']);
  gitIn(repo, ['checkout', '-q', '-b', 'main']);
  gitIn(repo, ['config', 'user.email', 'fixture@example.com']);
  gitIn(repo, ['config', 'user.name', 'Fixture']);
  fs.writeFileSync(path.join(repo, 'shared.ts'), 'export const v = 0;\n', 'utf8');
  gitIn(repo, ['add', '.']);
  gitIn(repo, ['commit', '-q', '-m', 'init']);

  // Two runs, two worktrees, both editing shared.ts on their own branch —
  // the literal shape of two concurrent forge runs under S04's default mode.
  const wtRoot = path.join(ws, '.forge-worktrees');
  const runIds = ['M-w1', 'M-w2'];
  const wtPaths = {};
  for (const id of runIds) {
    const wt = path.join(wtRoot, id, 'repo-a');
    gitIn(repo, ['worktree', 'add', '-q', wt, '-b', `forge/${id}`, 'main']);
    gitIn(wt, ['config', 'user.email', 'fixture@example.com']);
    gitIn(wt, ['config', 'user.name', 'Fixture']);
    fs.writeFileSync(path.join(wt, 'shared.ts'), `export const v = '${id}';\n`, 'utf8');
    fs.writeFileSync(path.join(wt, `${id}-only.ts`), 'x\n', 'utf8');
    gitIn(wt, ['add', '.']);
    gitIn(wt, ['commit', '-q', '-m', `work in ${id}`]);
    wtPaths[id] = wt;

    fs.mkdirSync(path.join(ws, '.gsd', 'forge', 'runs'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.gsd', 'forge', 'runs', `${id}.json`), JSON.stringify({
      kind: 'milestone', id, session_id: `sess-${id}`, active: true,
      started_at: 1785763253000, last_heartbeat: 1785763253000,
      worker: null, worker_started: null,
      isolation_mode: 'worktree', branch: `forge/${id}`,
      worktrees: [{ repo, path: wt }],
      milestone_dir: `.gsd/milestones/${id}/`, cwd: ws,
    }, null, 2), 'utf8');
  }

  const regFile = path.join(home, '.claude', 'forge-gate-workspaces.json');
  fs.mkdirSync(path.dirname(regFile), { recursive: true });
  fs.writeFileSync(regFile, JSON.stringify({
    version: 1,
    roots: [{ path: '~/Development', primary: true }],
    entries: [{ path: 'ws', root: '~/Development', kind: 'workspace', repos: ['repo-a'] }],
    quarantine: [],
  }, null, 2), 'utf8');

  // PRECONDITION, asserted before any verdict is read (Section 88's floor):
  // a fixture that silently derived nothing would sail through the verdict
  // below while proving nothing.
  const snaps = runIds.map((id) => touchMod.recordTouched(ws, id, { home }));
  for (let i = 0; i < runIds.length; i++) {
    const r = snaps[i].repos[0];
    assertEqual(r.source, 'worktree', `${runIds[i]}: derived from the worktree, not the registered checkout`);
    assertEqual(r.path, wtPaths[runIds[i]], `${runIds[i]}: the path examined is this run's own worktree`);
    assert(r.files.includes('shared.ts'), `${runIds[i]}: the committed work is visible at all`);
    assert(r.repo_id, `${runIds[i]}: carries a repo identity`);
  }
  assertEqual(snaps[0].repos[0].repo_id, snaps[1].repos[0].repo_id,
    'both worktrees resolve to ONE repository identity');
  assert(snaps[0].repos[0].path !== snaps[1].repos[0].path,
    'and they are genuinely different working trees — otherwise this proves nothing');

  const result = computeOverlap(collectRunTouches(ws, {}));
  noteReasons(result);
  assertEqual(result.pairs_compared, 1, 'o par foi confrontado');
  assertEqual(result.verdict, 'overlap',
    'duas runs em worktrees do mesmo repo, mexendo no mesmo arquivo, DEVEM dar overlap');
  assertEqual(result.overlaps.length, 1, 'exatamente uma sobreposição');
  assertEqual(result.overlaps[0].files.join(','), 'shared.ts',
    'só o arquivo em comum — os arquivos exclusivos de cada run não são colisão');

  // And it is legible to the human it exists for.
  const out = formatOverlap(result);
  assert(out.includes('shared.ts') && out.includes('M-w1') && out.includes('M-w2'),
    'a saída legível nomeia o arquivo e as duas runs');
});

test('R11b: a run whose registered worktree is gone leaves a NAMED skip, and the verdict falls to the floor', () => {
  const ws = makeWorkspace();
  writeRun(ws, 'M-aaa', touchedOk([{ name: 'freyr', path: '/w/freyr', repo_id: '/w/freyr/.git', files: ['src/a.ts'] }]));
  writeRun(ws, 'M-bbb', touchedSkipped('freyr', 'worktree-path-missing'));

  const result = computeOverlap(collectRunTouches(ws, {}));
  noteReasons(result);
  assert(result.skipped.some((s) => s.reason === 'worktree-path-missing'),
    'a razão vinda do T01 chega ao censo com nome próprio');
  // The run itself leaves the comparison too, under its OWN name: a run whose
  // every repo was skipped knows nothing about its work, and letting it walk
  // the pair loop would manufacture the pair count that makes `clean` reachable.
  assert(result.skipped.some((s) => s.id === 'M-bbb' && s.reason === 'no-comparable-repo'),
    'a run inteira sai da comparação com razão nomeada, não como participante muda');
  assertEqual(result.runs_with_touch_data, 1, 'só uma run comparável restou');
  assertEqual(result.verdict, 'inconclusive',
    'sem a segunda run comparável o veredicto cai no piso — nunca em clean');
  assert(result.verdict !== 'clean', 'e explicitamente NÃO é clean');
});

// ── R8 — reasons crossed in both directions ────────────────────────────────

test('R8: every emitted reason is enumerated, and every enumerated reason is emitted', () => {
  // Drive the repo-level reasons, including the unclassified fallback.
  const ws = makeWorkspace();
  writeRun(ws, 'M-r1', touchedSkipped('freyr', 'repo-path-unresolved'));
  writeRun(ws, 'M-r2', touchedSkipped('skuld', 'repo-not-git'));
  writeRun(ws, 'M-r3', touchedSkipped('urd', 'git-command-failed'));
  writeRun(ws, 'M-r4', touchedSkipped(null, 'run-has-no-repos'));
  writeRun(ws, 'M-r5', touchedSkipped('verdandi', 'something-a-newer-forge-touch-invented'));
  const result = computeOverlap(collectRunTouches(ws, {}));
  noteReasons(result);

  // An unresolved repo SURFACES rather than vanishing — this is how the known
  // `discoverRepos` depth-1 gap (I-20260803060030) stays legible instead of
  // silently shrinking the comparison.
  assert(
    result.skipped.some((s) => s.reason === 'repo-path-unresolved'),
    'repo não resolvido tem que aparecer no censo, não sumir',
  );
  assert(
    result.skipped.some((s) => s.reason === 'repo-skip-unclassified'),
    'razão desconhecida vira repo-skip-unclassified, nunca descarte mudo',
  );

  // Direction 1: nothing emitted anywhere in this suite is outside the enum.
  for (const r of reasonsSeen) {
    assert(OVERLAP_REASONS.includes(r), `razão emitida fora de OVERLAP_REASONS: ${r}`);
  }
  // Direction 2: nothing in the enum is dead weight.
  for (const r of OVERLAP_REASONS) {
    assert(reasonsSeen.has(r), `razão enumerada que nenhum teste alcançou (entrada morta?): ${r}`);
  }
  assertEqual(new Set(OVERLAP_REASONS).size, OVERLAP_REASONS.length, 'OVERLAP_REASONS sem duplicatas');
});

// ── R9 — verdict domain + census accounts for every run ────────────────────

test('R9: verdict is always in VERDICTS and no run leaves the census unnamed', () => {
  assertEqual(VERDICTS.join(','), 'overlap,clean,inconclusive', 'domínio fechado de veredictos');

  const scenarios = [
    [],
    [['M-a', undefined]],
    [['M-a', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }])]],
    [['M-a', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }])],
      ['M-b', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }])]],
    [['M-a', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }])],
      ['M-b', touchedOk([{ name: 'freyr', path: '/w/freyr', files: ['src/b.ts'] }])],
      ['M-c', touchedSkipped('freyr', 'repo-not-git')]],
  ];

  for (const runsSpec of scenarios) {
    const ws = makeWorkspace();
    for (const [id, t] of runsSpec) writeRun(ws, id, t);
    const collected = collectRunTouches(ws, {});
    const result = computeOverlap(collected);
    noteReasons(result);

    assert(VERDICTS.includes(result.verdict), `veredicto fora do domínio: ${result.verdict}`);
    assertEqual(result.runs_examined, runsSpec.length, 'runs_examined conta o registry inteiro');

    // Every run is either comparable or named in `skipped` — the sum matches.
    const runLevelSkips = result.skipped.filter((s) => !String(s.id).includes('/')
      && s.reason !== 'not-comparable-single-run');
    assertEqual(
      collected.comparable.length + runLevelSkips.length,
      runsSpec.length,
      'toda run do registry aparece em comparable OU em skipped com razão',
    );

    // The floor, restated as an invariant over every scenario.
    if (result.pairs_compared === 0) {
      assertEqual(result.verdict, 'inconclusive', 'zero pares implica inconclusive, sempre');
    }
    if (result.verdict === 'clean') {
      assert(result.pairs_compared >= 1, 'clean implica ao menos um par confrontado, sempre');
    }
  }
});

test('R9b: computeOverlap is pure — the same input twice gives the same output', () => {
  const collected = {
    runs_examined: 2,
    comparable: [
      { id: 'M-a', repos: [{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }] },
      { id: 'M-b', repos: [{ name: 'freyr', path: '/w/freyr', files: ['src/a.ts'] }] },
    ],
    skipped: [],
    notes: [],
  };
  const frozen = JSON.stringify(collected);
  const one = computeOverlap(collected);
  const two = computeOverlap(collected);
  assertEqual(JSON.stringify(one), JSON.stringify(two), 'saída determinística');
  assertEqual(JSON.stringify(collected), frozen, 'a entrada não pode ser mutada pela função pura');
});

// ── R10 (closing half) — the operator's live data was never written ────────

test('R10: the REAL ~/.claude/forge-gate-workspaces.json was never touched', () => {
  assertEqual(liveRegistryStamp(), LIVE_BEFORE, 'mtime/size do registry vivo devem estar inalterados');
});

// ── summary ──────────────────────────────────────────────────────────────────
process.env.HOME = ORIGINAL_HOME;
if (ORIGINAL_USERPROFILE === undefined) delete process.env.USERPROFILE;
else process.env.USERPROFILE = ORIGINAL_USERPROFILE;

cleanup();
console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
