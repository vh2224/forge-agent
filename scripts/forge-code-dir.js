#!/usr/bin/env node
// forge-code-dir — Pure per-unit CODE_DIR resolver for multi-repo workspaces
//
// The sidecar (codex/agy execute path) assumes ONE CODE_DIR that is a git repository:
// `forge-surgical-reset.js --state-init`, `git rev-parse HEAD` (START_SHA) and the
// post-run diff all take a single `--cwd`. In a workspace with N repos the isolation
// result carries N worktrees, and the historical blind pick
// `repos.find(x => x.worktree && x.status !== 'error')` silently returned repos[0] —
// which may be a repo the unit never touches, and whose parent `.forge-worktrees/{RUN}/`
// root is not a git repo at all.
//
// This module resolves the ONE worktree the unit's DECLARED paths belong to, or refuses.
// It is pure: it reads only the isolation-result JSON it is handed plus the plan file.
// It makes read-only fs.existsSync probes only in the second pass; ZERO git calls, ZERO
// subprocesses, and ZERO filesystem mutation (D1). That keeps Section 63 fixture-cheap.
//
// Library exports:
//   resolveCodeDir({ isoResult, planPath, cwd, run }) → { status, code_dir, repo, repos_touched,
//                                                         paths_considered, paths_unmatched,
//                                                         source, resolution, run, reason,
//                                                         multi_repo_root, hint }
//   hintFor({ status, declared_repo, declared_repo_status, repos_touched }) → string (pt-BR)
//   frontmatterOf(text) → string
//   parseDeclaredPaths(planText) → { paths: string[], source: 'writes+expected_output'|'files-to-change'|'none' }
//   parseFilesToChange(planText) → string[]
//   attributeRepo(absPath, repos) → repo|null   (longest-prefix, boundary-aware)
//   parseListField(fm, key) → string[]|null     (copied from forge-parallelism.js — see below)
//   parseScalarField(fm, key) → string|null
//   matchDeclaredRepo(value, usable, cwd, repoIndex) → { repo, status, path }
//   scorePath(root, repoPath) → number
//   normalizePath(p) → string
//
// CLI:
//   node forge-code-dir.js --resolve --iso-result <json|@file|-> --plan <plan-path> [--cwd <dir>] [--run <id>] [--json]
//                          [--no-repo-index] [--home <dir>] [--registry-file <path>]
//
// ── The repo index (S05/T05), and why it enters by INJECTION ────────────────
//
// TASK-021: four tasks fell to Claude because `repo: freyr` matched nothing. The
// cause was not the declaration — it was the lookup. `matchDeclaredRepo` compares
// the declaration against `usable`, which comes from `forge-repos.discoverRepos`,
// and that walk goes ONE level down while `freyr` sits at `services/freyr`, two
// down. The answer could not be in the list being searched, so the `hint` that
// said "declare `repo: freyr`" pointed at a fix that would have produced
// `declared_repo_status: unknown` all the same.
//
// The fix gives the matcher a FOURTH source: the name→path index built from the
// registry by `forge-repo-index.js`. It arrives as `repoIndex`, injected — never
// required or read from inside these functions — so the purity contract stated
// above survives intact: the registry read lives at the CLI boundary (the
// `require.main` block), and `resolveCodeDir` is still a function of its inputs.
// That is also what lets the three orchestrator mirrors inherit the fix with ZERO
// edits under `skills/`: they all shell out to `--resolve`, and the CLI builds the
// index by default.
//
// `repoIndex` is a RESOLVER, not a data structure: either a function
// `(name, { cwd }) → { status, path }` or an object exposing `.resolve` of that
// shape. Injecting behaviour rather than the index keeps `forge-repo-index.js`'s
// matching rules in `forge-repo-index.js` — a second resolver reimplemented here
// is a second resolver that disagrees with the first.
//
// SCOPE, declared: this fixes ADDRESSING, not isolation scoping. A name that
// resolves to a repo with no worktree in the current run is still a REFUSAL —
// same reason (`sidecar-code-dir-undeclared`), same exit code 5. Only the `hint`
// changes, to one that names the resolved absolute path. Resolved name is not
// isolated repo, and the operator has to see both.
//
// Exit codes (semantic, consumed by the three orchestrator mirrors):
//   0  status ok | shared
//   4  status cross-repo   → reason sidecar-multirepo-unsupported
//   5  status undeclared   → reason sidecar-code-dir-undeclared
//   2  usage / parse error
//
// `hint` is PURELY informational (TASK-018): actionable pt-BR prose in a single source that
// the three orchestrator mirrors print next to the refusal warning. It NEVER changes a
// verdict, a status or an exit code — same refusal, better explanation. Additive: it is on
// every result with default '' and nothing reads it to decide anything.
//
// NOTE: `parseListField` / `normalizePath` are COPIED from scripts/forge-parallelism.js
// rather than required: that module calls main() at top level with no `require.main`
// guard, so requiring it would print JSON into our stdout and process.exit().

'use strict';

const fs   = require('fs');
const path = require('path');
const { hasStructuredMustHaves, parseMustHaves } = require('./forge-must-haves.js');

const REASON_CROSS_REPO  = 'sidecar-multirepo-unsupported';
const REASON_UNDECLARED  = 'sidecar-code-dir-undeclared';
const FS_PROBE_FLOOR = 2;

// ── path helpers (copied from forge-parallelism.js:74-76) ───────────────────
function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

// Parse either inline (`key: [a, b]`) or block (`key:\n  - a\n  - b`) YAML list.
// Returns array (possibly empty) or null if key not present.
// (copied from forge-parallelism.js:137-160)
function parseListField(fm, key) {
  const inlineRe = new RegExp('^' + key + ':\\s*\\[([^\\]]*)\\]\\s*$', 'm');
  const mi = fm.match(inlineRe);
  if (mi) {
    const raw = mi[1].trim();
    if (!raw) return [];
    return raw.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  // Form A-inplace (S03/T05): the repetition terminator must accept CRLF. `.` in
  // JavaScript excludes \r as a line terminator, so on a CRLF plan `.+` stops
  // before the \r and the optional `\n?` cannot bridge it — the repetition ends
  // after the FIRST item and every later declared path is silently dropped.
  // Measured: a two-entry CRLF `writes:` parsed to one entry, which made a
  // cross-repo plan look single-repo (forge-code-dir-repo.test.js "R12 — exit 4"
  // came back 0). Silent under-reporting of declared paths, not a parse error.
  const blockRe = new RegExp('^' + key + ':[ \\t]*\\r?\\n((?:[ \\t]+-[ \\t]+.+\\r?\\n?)+)', 'm');
  const mb = fm.match(blockRe);
  if (mb) {
    const items = [];
    for (const line of mb[1].split(/\r?\n/)) {
      const mm = line.match(/^[ \t]+-[ \t]+(.+?)\s*$/);
      if (mm) items.push(mm[1].replace(/^["']|["']$/g, ''));
    }
    return items;
  }
  const emptyRe = new RegExp('^' + key + ':\\s*$', 'm');
  if (emptyRe.test(fm)) return [];
  return null;
}

// Parse a simple YAML scalar, accepting quotes and stripping an inline comment.
// This deliberately is not a general YAML parser: plan frontmatter uses plain scalars.
function parseScalarField(fm, key) {
  const re = new RegExp('^' + key + ':\\s*(.*?)\\s*$', 'm');
  const m = String(fm || '').match(re);
  if (!m) return null;
  let value = m[1].replace(/\s+#.*$/, '').trim();
  value = value.replace(/^["']|["']$/g, '').trim();
  return value || null;
}

// A glob is not a path: truncate at the first segment containing a wildcard so that
// `src/auth/**` attributes as `src/auth` and `services/*/x.ts` as `services`.
function globRoot(p) {
  const norm = normalizePath(p);
  if (!norm) return '';
  const segs = norm.split('/');
  const out = [];
  for (const s of segs) {
    if (s.includes('*') || s.includes('?')) break;
    out.push(s);
  }
  return out.join('/');
}

// `.gsd/**` artifacts ALWAYS live under the original workspace regardless of isolation
// mode (shared/forge-dispatch.md § Isolation Header Convention). They are never evidence
// of which repo a unit touches, and must never make a plan look cross-repo (D4).
function isArtifactPath(p) {
  const norm = normalizePath(p);
  return norm === '.gsd' || norm.startsWith('.gsd/') || norm.includes('/.gsd/');
}

function frontmatterOf(text) {
  const m = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : '';
}

// ── declared-path parsing (D3) ──────────────────────────────────────────────

// Free-text fallback: `## Files to Change` section. Accepts `- ` bullets AND `N. `
// numbered entries. Captures ONLY the first backticked token of the line — the reason
// text routinely carries backticked line-refs like `:827` that a greedy capture would
// swallow. With no backticks, take the first whitespace-delimited token before the
// em-dash / hyphen. Stops at the next `## `.
function parseFilesToChange(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inSection = /^##\s+Files\s+to\s+Change\s*$/i.test(line.trim());
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
    if (!m) continue;
    const rest = m[1];
    let token = null;
    const tick = rest.match(/`([^`]+)`/);
    if (tick) {
      token = tick[1].trim();
    } else {
      const plain = rest.split(/\s+—|\s+--|\s+-\s|\s/)[0];
      token = (plain || '').trim();
    }
    token = token.replace(/^\*\*|\*\*$/g, '').trim();
    if (token) out.push(token);
  }
  return out;
}

// Union of `writes:` (frontmatter) + `expected_output:` (must_haves schema) — union and
// not precedence, because for cross-repo DETECTION more declared paths is strictly safer
// (a path omitted from the union is a path that could silently make the unit cross-repo).
// Falls back to `## Files to Change` only when BOTH structured keys are absent/empty.
function parseDeclaredPaths(text) {
  const content = String(text || '');
  const fm = frontmatterOf(content);

  const writes = fm ? parseListField(fm, 'writes') : null;

  let expected = null;
  try {
    // parseMustHaves THROWS on legacy plans and on malformed schema — gate + catch.
    if (hasStructuredMustHaves(content)) {
      const mh = parseMustHaves(content);
      if (mh && Array.isArray(mh.expected_output)) expected = mh.expected_output;
    }
  } catch (_) {
    expected = null; // degrade to "no expected_output", never crash
  }

  const union = [];
  const seen = new Set();
  for (const p of [].concat(writes || [], expected || [])) {
    const norm = normalizePath(p);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    union.push(norm);
  }

  if (union.length) return { paths: union, source: 'writes+expected_output' };

  const free = parseFilesToChange(content);
  const freeUnion = [];
  const seen2 = new Set();
  for (const p of free) {
    const norm = normalizePath(p);
    if (!norm || seen2.has(norm)) continue;
    seen2.add(norm);
    freeUnion.push(norm);
  }
  if (freeUnion.length) return { paths: freeUnion, source: 'files-to-change' };

  return { paths: [], source: 'none' };
}

// ── attribution (D5) ────────────────────────────────────────────────────────

// Longest-prefix, boundary-aware. Longest-prefix is mandatory, not cosmetic: when the
// workspace root itself is a repo, `repos[].path === cwd` is a prefix of EVERY other
// repo and a naive startsWith would attribute everything to it. Boundary-awareness keeps
// `/w/api` from claiming `/w/api-v2`.
function attributeRepo(absPath, repos) {
  const target = normalizePath(absPath);
  let best = null;
  let bestLen = -1;
  for (const r of repos || []) {
    const rp = normalizePath(r && r.path);
    if (!rp) continue;
    if (target !== rp && !target.startsWith(rp + '/')) continue;
    if (rp.length > bestLen) { best = r; bestLen = rp.length; }
  }
  return best;
}

function pathSegments(p) {
  return normalizePath(p).split('/').filter(Boolean).length;
}

// A path contributes the depth that can actually be observed in a source repo.
function scorePath(root, repoPath) {
  const normalizedRoot = normalizePath(root);
  if (!normalizedRoot || !repoPath) return 0;
  if (fs.existsSync(path.join(repoPath, normalizedRoot))) return pathSegments(normalizedRoot) + 1;
  const parent = normalizePath(path.dirname(normalizedRoot));
  if (parent && parent !== '.' && fs.existsSync(path.join(repoPath, parent))) return pathSegments(parent);
  return 0;
}

// Normalise the injected resolver to one callable, accepting both shapes. Anything
// else (including a bare index object with no `.resolve`) is treated as "no index"
// — degrading to the three historical strategies is always safe.
function resolverOf(repoIndex) {
  if (typeof repoIndex === 'function') return repoIndex;
  if (repoIndex && typeof repoIndex.resolve === 'function') return repoIndex.resolve.bind(repoIndex);
  return null;
}

// Order matters and is not arbitrary: the three historical strategies run FIRST,
// so a repo that is genuinely isolated in this run always wins. The index is
// consulted only where the old code had already given up — it can turn an
// `unknown` into an answer, and it can never change an answer that already worked.
function matchDeclaredRepo(value, usable, cwd, repoIndex) {
  const declared = String(value || '').trim();
  if (!declared) return { repo: null, status: 'unknown' };
  const normalized = normalizePath(declared);
  const byAbsolute = usable.filter(r => normalizePath(r.path) === normalized);
  if (byAbsolute.length === 1) return { repo: byAbsolute[0], status: 'ok' };
  const relative = normalizePath(path.resolve(cwd, declared));
  const byRelative = usable.filter(r => normalizePath(r.path) === relative);
  if (byRelative.length === 1) return { repo: byRelative[0], status: 'ok' };
  const declaredLower = declared.toLowerCase();
  const byBasename = usable.filter(r => path.basename(normalizePath(r.path)).toLowerCase() === declaredLower);
  if (byBasename.length === 1) return { repo: byBasename[0], status: 'ok' };
  if (byBasename.length > 1) return { repo: null, status: 'ambiguous' };

  // Fourth strategy — the registry index (S05/T05). This is the branch TASK-021
  // needed and did not have.
  const resolve = resolverOf(repoIndex);
  if (resolve) {
    let res = null;
    try {
      res = resolve(declared, { cwd });
    } catch (_) {
      res = null; // a resolver that throws degrades to the old verdict, never crashes a dispatch
    }
    if (res && res.status === 'ok' && res.path) {
      const resolved = normalizePath(res.path);
      // Compare by PATH, not by name: the worktree of a repo may carry a different
      // basename than the repo itself, and the point of resolving is the path.
      const byIndex = usable.filter(r => normalizePath(r.path) === resolved);
      if (byIndex.length === 1) {
        return { repo: byIndex[0], status: 'ok', path: resolved, source: 'repo-index' };
      }
      // Resolved, but this repo has no worktree in the current isolation. Addressing
      // succeeded; scoping did not. Refuse — with the path, so the hint can say so.
      return { repo: null, status: 'unisolated', path: resolved };
    }
    if (res && res.status === 'ambiguous') return { repo: null, status: 'ambiguous' };
  }

  return { repo: null, status: 'unknown' };
}

// ── actionable prose (TASK-018) ─────────────────────────────────────────────
//
// Pure: given the fields of a refusal, return ONE pt-BR sentence naming the cause and the
// exact fix. It lives here (and not in the three mirrors) because prose duplicated across
// three files is prose that drifts. The reason codes (`sidecar-code-dir-undeclared`) point
// at the resolver; the cause is usually in the PLAN, and that is what the operator needs
// to read. Nothing here writes anything: `repo:` is never filled automatically (D3) — the
// declaration is TRUSTED by the resolver, so a guessed value would be worse than none.
function hintFor(info) {
  const o = info || {};
  const status = String(o.status || '');
  const declared = String(o.declared_repo || '');
  const declaredStatus = String(o.declared_repo_status || '');
  const touched = (Array.isArray(o.repos_touched) ? o.repos_touched : []).join(', ');

  if (status === 'cross-repo') {
    return `Os paths declarados no plano cruzam mais de um repo (${touched || 'vários'}). `
      + 'O sidecar exige um único repo por unidade: divida a unidade em uma task por repo '
      + '(cada uma com seu `repo:` e seus `writes:`).';
  }

  if (status !== 'undeclared') return '';

  if (declaredStatus === 'unknown') {
    return `\`repo: ${declared}\` não casa com nenhum repo do workspace. `
      + 'Corrija para o nome do diretório (ou o caminho) de um repo existente — '
      + '`/forge-doctor` lista os planos afetados.';
  }
  // Resolved by the registry index, but with no worktree in this run. The operator
  // must see BOTH facts — the name was right, and the repo still is not isolated
  // here — or they will "fix" a declaration that was never wrong (TASK-021 again).
  if (declaredStatus === 'unisolated') {
    const abs = String(o.declared_repo_path || '');
    return `\`repo: ${declared}\` resolve para \`${abs}\`, mas esse repo não tem worktree nesta run `
      + '(a descoberta de repos da isolation não o alcançou). O nome está correto — o que falta é escopo. '
      + 'Declare o caminho completo do repo, ou rode a unidade no workspace que o contém.';
  }
  if (declaredStatus === 'ambiguous') {
    return `\`repo: ${declared}\` casa com mais de um repo do workspace. `
      + 'Declare o caminho completo do repo pretendido em vez do nome curto.';
  }
  if (declaredStatus === 'conflict') {
    return `\`repo: ${declared}\` contradiz os paths declarados (atribuídos a ${touched || 'outro repo'}). `
      + 'Corrija `repo:` **ou** `writes:`/`expected_output:` para que apontem ao mesmo repo.';
  }

  if (!declared) {
    return 'O plano não declara `repo:` e os paths declarados não bastam para atribuir um único repo. '
      + 'Declare `repo: <nome-do-repo>` no frontmatter do `T##-PLAN.md` (o nome do diretório do repo '
      + 'dentro do workspace). Rode `/forge-doctor` para listar todos os planos afetados. '
      + 'Nada preenche esse campo automaticamente — a declaração é confiada pelo resolvedor, '
      + 'então um valor adivinhado seria pior que ausente.';
  }

  return '';
}

// ── resolution ──────────────────────────────────────────────────────────────
function emptyResult(extra) {
  return Object.assign({
    status: 'shared',
    code_dir: '',
    repo: '',
    repos_touched: [],
    paths_considered: 0,
    paths_unmatched: 0,
    source: 'none',
    resolution: '',
    run: '',
    reason: '',
    multi_repo_root: '',
    repo_roots: [],
    writable_roots: [],
    declared_repo: '',
    declared_repo_status: '',
    // Additive (S05/T05) — defaults keep every existing reader byte-identical.
    declared_repo_source: '',
    declared_repo_path: '',
    probe: '',
    probe_scores: {},
    hint: '',
  }, extra || {});
}

// The single directory that contains EVERY usable worktree.
//
// `code_dir` stays EMPTY on a refusal because the SIDECAR contract demands one
// git repo and there isn't one. The Claude executor has no such constraint — it
// reads and writes across repos fine — yet on refusal it inherited the bootstrap
// `WORKTREE_DIR`, i.e. the blind `repos.find(...)` first pick, and so ran inside
// whichever repo happened to come first. This field gives that consumer (and
// only that consumer) somewhere honest to stand.
//
// Derived from the literal worktree values, never recomputed from prefs: the
// worktree root differs between single- and multi-repo workspaces. Offered only
// when 2+ worktrees genuinely share a parent — with a single repo the bootstrap
// value is already correct, and its parent would not even be a git repository.
function commonWorktreeRoot(usable) {
  const list = Array.isArray(usable) ? usable : [];
  if (list.length < 2) return '';
  const parents = list.map((r) => normalizePath(path.dirname(String(r.worktree || ''))));
  if (parents.some((p) => p === '' || p === '.')) return '';
  return parents.every((p) => p === parents[0]) ? parents[0] : '';
}

function resolveCodeDir(opts) {
  const o        = opts || {};
  const cwd      = o.cwd || process.cwd();
  const run      = o.run ? String(o.run) : '';
  const planPath = o.planPath || '';
  const iso      = o.isoResult || {};

  // 1. shared / no isolation → not an error, just "no CODE_DIR to resolve".
  const repos = Array.isArray(iso.repos) ? iso.repos : [];
  if (iso.mode === 'shared' || repos.length === 0) {
    return emptyResult({ run });
  }

  // 2. Usable repo list — the exact predicate the blind find() used, so the candidate
  //    set is unchanged. Empty → shared; the bootstrap guard (not this resolver) owns
  //    the all-repos-failed STOP.
  const usable = repos.filter(r => r && r.worktree && r.status !== 'error');
  if (usable.length === 0) return emptyResult({ run });

  // 3. D6 short-circuit, unconditional: exactly one usable repo → byte-identical to the
  //    legacy blind pick, WITHOUT opening the plan. A legacy plan with no `writes:` can
  //    never lose the sidecar in the single-repo common case.
  if (usable.length === 1) {
    return emptyResult({
      status: 'ok',
      code_dir: usable[0].worktree,
      repo: usable[0].path || '',
      repos_touched: [usable[0].path || ''],
      run,
    });
  }

  // 4. Multi-repo → read the plan. A missing/unreadable plan is NOT a crash: it degrades
  //    to zero declared paths → undeclared.
  let planText = '';
  try {
    if (planPath && fs.existsSync(planPath)) planText = fs.readFileSync(planPath, 'utf8');
  } catch (_) {
    planText = '';
  }

  // 5. Declared paths (D3).
  const { paths, source } = parseDeclaredPaths(planText);
  const fm = frontmatterOf(planText);
  const declaredRepo = parseScalarField(fm, 'repo') || '';

  // 6. Filter `.gsd/**` BEFORE attribution (D4).
  const considered = paths.filter(p => !isArtifactPath(p));

  // 7. Attribution (D5) — absolute, normalized, longest-prefix.
  const touched = new Map();
  let unmatched = 0;
  let unmatchedAbsolute = 0;
  for (const p of considered) {
    const root = globRoot(p);
    if (!root) { unmatched++; continue; }
    const abs = normalizePath(path.resolve(cwd, root));
    const repo = attributeRepo(abs, usable);
    if (!repo) {
      unmatched++;
      const lexical = path.posix.normalize(normalizePath(root));
      const escapesWorkspace = lexical === '..' || lexical.startsWith('../');
      if (path.isAbsolute(root) || /^[A-Za-z]:[\\/]/.test(root) || /^[\\/]{2}/.test(root) || escapesWorkspace) {
        unmatchedAbsolute++;
      }
      continue;
    }
    touched.set(normalizePath(repo.path), repo);
  }

  // D3: repo-relative declared paths are not under repo.path, so normal attribution
  // finds none. Probe repo.path (not worktree) because declarations describe source
  // repos; a worktree may not yet contain a newly declared file. Limitation C3: when
  // cwd itself is a repo, attribution already claims every relative path and this
  // deliberately does not reinterpret that first-pass result.
  // P1: a cross-repo unit is routable only when `repo:` names the primary cwd and
  // every declared non-artifact path was attributed. Additional worktrees become
  // app-server writableRoots; no first-repo guess is permitted.
  if (touched.size >= 2) {
    const touchedPaths = Array.from(touched.keys());
    if (!declaredRepo || unmatched > 0) {
      return emptyResult({ status: 'cross-repo', repos_touched: touchedPaths, paths_considered: considered.length,
        paths_unmatched: unmatched, source, run, reason: REASON_CROSS_REPO, multi_repo_root: commonWorktreeRoot(usable),
        declared_repo: declaredRepo,
        hint: hintFor({ status: 'cross-repo', declared_repo: declaredRepo, repos_touched: touchedPaths }) });
    }
    const primary = matchDeclaredRepo(declaredRepo, usable, cwd, o.repoIndex);
    if (primary.status !== 'ok' || !touched.has(normalizePath(primary.repo.path))) {
      return emptyResult({ status: 'undeclared', repos_touched: touchedPaths, paths_considered: considered.length,
        paths_unmatched: unmatched, source, run, reason: REASON_UNDECLARED, multi_repo_root: commonWorktreeRoot(usable),
        declared_repo: declaredRepo, declared_repo_status: primary.status === 'ok' ? 'conflict' : primary.status,
        declared_repo_path: primary.path || '',
        hint: hintFor({ status: 'undeclared', declared_repo: declaredRepo,
          declared_repo_status: primary.status === 'ok' ? 'conflict' : primary.status, repos_touched: touchedPaths }) });
    }
    const repoRoots = Array.from(touched.values()).map(repo => path.resolve(repo.worktree));
    const primaryRoot = path.resolve(primary.repo.worktree);
    return emptyResult({ status: 'ok', code_dir: primaryRoot, repo: primary.repo.path || '',
      repos_touched: touchedPaths, repo_roots: repoRoots,
      writable_roots: repoRoots.filter(root => normalizePath(root) !== normalizePath(primaryRoot)),
      paths_considered: considered.length, paths_unmatched: 0, source, resolution: 'multi-repo-declared', run,
      declared_repo: declaredRepo, declared_repo_status: 'ok', declared_repo_source: primary.source || '',
      declared_repo_path: primary.path || '' });
  }

  // P2–P4: a declaration is validated before it can select a worktree and never falls through.
  if (declaredRepo) {
    const match = matchDeclaredRepo(declaredRepo, usable, cwd, o.repoIndex);
    if (match.status !== 'ok') {
      // `unisolated` refuses exactly like `unknown` did: same top-level status, same
      // reason, same exit code 5. Three orchestrator mirrors consume those codes, and
      // an unseen value would break all three in silence — the failure class this
      // milestone exists to end. Only the hint improves.
      return emptyResult({ status: 'undeclared', paths_considered: considered.length, paths_unmatched: unmatched, source, run,
        reason: REASON_UNDECLARED, multi_repo_root: commonWorktreeRoot(usable), declared_repo: declaredRepo,
        declared_repo_status: match.status,
        declared_repo_path: match.path || '',
        hint: hintFor({ status: 'undeclared', declared_repo: declaredRepo, declared_repo_status: match.status,
          declared_repo_path: match.path || '' }) });
    }
    // A partially attributed declaration is not a single-repo plan. Accepting the
    // known subset would omit the unknown scope from writableRoots, snapshots and
    // reset. Relative-only plans with no attributed root retain the historical
    // declared-repo path below; mixed known/unknown scope always fails closed.
    if (unmatched > 0 && (touched.size > 0 || unmatchedAbsolute > 0)) {
      const touchedPaths = Array.from(touched.keys());
      return emptyResult({ status: 'cross-repo', repos_touched: touchedPaths,
        paths_considered: considered.length, paths_unmatched: unmatched, source, run,
        reason: REASON_CROSS_REPO, multi_repo_root: commonWorktreeRoot(usable),
        declared_repo: declaredRepo, declared_repo_status: 'partial-scope',
        declared_repo_path: match.path || '',
        hint: hintFor({ status: 'cross-repo', declared_repo: declaredRepo, repos_touched: touchedPaths }) });
    }
    if (touched.size === 1 && normalizePath(touched.keys().next().value) !== normalizePath(match.repo.path)) {
      return emptyResult({ status: 'undeclared', paths_considered: considered.length, paths_unmatched: unmatched, source, run,
        reason: REASON_UNDECLARED, multi_repo_root: commonWorktreeRoot(usable), declared_repo: declaredRepo,
        declared_repo_status: 'conflict',
        hint: hintFor({ status: 'undeclared', declared_repo: declaredRepo, declared_repo_status: 'conflict',
          repos_touched: Array.from(touched.keys()) }) });
    }
    return emptyResult({ status: 'ok', code_dir: match.repo.worktree, repo: match.repo.path || '',
      repos_touched: [match.repo.path || ''], paths_considered: considered.length, paths_unmatched: unmatched, source,
      resolution: 'declared', run, declared_repo: declaredRepo, declared_repo_status: 'ok',
      declared_repo_source: match.source || '', declared_repo_path: match.path || '' });
  }

  let resolution = touched.size > 0 ? 'attribution' : '';
  let probe = '';
  const probeScores = {};
  if (touched.size === 0 && considered.length > 0) {
    const totals = new Map(usable.map(repo => [normalizePath(repo.path), 0]));
    let discardedWeak = false;
    for (const p of considered) {
      const root = globRoot(p);
      const scored = usable.map(repo => ({ repo, score: scorePath(root, repo.path) }));
      const max = Math.max(0, ...scored.map(item => item.score));
      const winners = scored.filter(item => item.score === max && max > 0);
      if (winners.length === 1) totals.set(normalizePath(winners[0].repo.path), totals.get(normalizePath(winners[0].repo.path)) + max);
      else if (winners.length >= 2 && max >= FS_PROBE_FLOOR) {
        for (const winner of winners) totals.set(normalizePath(winner.repo.path), totals.get(normalizePath(winner.repo.path)) + max);
      } else if (winners.length >= 2) discardedWeak = true;
    }
    for (const repo of usable) probeScores[normalizePath(repo.path)] = totals.get(normalizePath(repo.path));
    const candidates = usable.filter(repo => probeScores[normalizePath(repo.path)] > 0);
    if (!candidates.length) probe = discardedWeak ? 'weak' : 'none';
    else {
      const bestScore = Math.max(...candidates.map(repo => probeScores[normalizePath(repo.path)]));
      const winners = candidates.filter(repo => probeScores[normalizePath(repo.path)] === bestScore);
      if (winners.length === 1) {
        touched.set(normalizePath(winners[0].path), winners[0]);
        resolution = 'fs-probe';
        probe = 'winner';
      } else probe = 'tie';
    }
  }

  const reposTouched = Array.from(touched.keys());

  // 8. Verdict.
  if (touched.size === 1) {
    const repo = touched.values().next().value;
    return emptyResult({
      status: 'ok',
      // NEVER recompute a worktree path — the worktree root differs between single-repo
      // and multi-repo workspaces (see the isolation setup module). Always the literal value.
      code_dir: repo.worktree,
      repo: repo.path || '',
      repos_touched: reposTouched,
      paths_considered: considered.length,
      paths_unmatched: unmatched,
      source,
      resolution,
      run,
      probe,
      probe_scores: probeScores,
    });
  }

  return emptyResult({
    status: 'undeclared',
    code_dir: '',
    repo: '',
    repos_touched: [],
    paths_considered: considered.length,
    paths_unmatched: unmatched,
    source,
    run,
    reason: REASON_UNDECLARED,
    multi_repo_root: commonWorktreeRoot(usable),
    probe,
    probe_scores: probeScores,
    hint: hintFor({ status: 'undeclared', declared_repo: '', declared_repo_status: '' }),
  });
}

function exitCodeFor(status) {
  if (status === 'cross-repo') return 4;
  if (status === 'undeclared') return 5;
  return 0;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; }
    else { args[key] = true; }
  }
  return args;
}

function readIsoArg(raw) {
  if (raw === '-' ) return fs.readFileSync(0, 'utf8');
  if (typeof raw === 'string' && raw.startsWith('@')) return fs.readFileSync(raw.slice(1), 'utf8');
  return raw;
}

function cliMain() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.resolve) {
    process.stderr.write(`forge-code-dir error: --resolve is required

Usage:
  node forge-code-dir.js --resolve --iso-result <json|@file|-> --plan <plan-path> [--cwd <dir>] [--run <id>] [--json]
                         [--no-repo-index] [--home <dir>] [--registry-file <path>]

Exit: 0 ok/shared · 4 cross-repo · 5 undeclared · 2 usage/parse error
`);
    process.exit(2);
  }

  const rawIso = args['iso-result'];
  if (!rawIso || rawIso === true) {
    process.stderr.write('forge-code-dir error: --iso-result is required\n');
    process.exit(2);
  }

  let isoResult;
  try {
    isoResult = JSON.parse(readIsoArg(rawIso));
  } catch (e) {
    process.stderr.write(`forge-code-dir error: could not parse --iso-result: ${e.message}\n`);
    process.exit(2);
  }
  if (!isoResult || typeof isoResult !== 'object') {
    process.stderr.write('forge-code-dir error: --iso-result must be a JSON object\n');
    process.exit(2);
  }

  // ── The one registry read, at the boundary (S05/T05) ─────────────────────
  //
  // Built here and NOWHERE else: the library stays pure, and because all three
  // orchestrator mirrors reach this resolver through this CLI, they inherit the
  // fix without a single edit under `skills/`. Failure to build the index —
  // absent registry, unreadable file, malformed marker — DEGRADES to the previous
  // behaviour (no index, three strategies). An addressing improvement must never
  // be able to take down a dispatch that used to work.
  let repoIndex = null;
  if (!args['no-repo-index']) {
    try {
      const home = typeof args.home === 'string'
        ? args.home
        : (process.env.HOME || process.env.USERPROFILE || '');
      const cwd = typeof args.cwd === 'string' ? args.cwd : process.cwd();
      if (home) {
        // eslint-disable-next-line global-require
        const { buildRepoIndex, resolveRepoName } = require('./forge-repo-index.js');
        const registryFile = typeof args['registry-file'] === 'string' ? args['registry-file'] : undefined;
        const index = buildRepoIndex({ home, registryFile, cwd });
        repoIndex = (name, o) => resolveRepoName(name, { index, cwd: (o && o.cwd) || cwd });
      }
    } catch (_) {
      repoIndex = null;
    }
  }

  let out;
  try {
    out = resolveCodeDir({
      isoResult,
      repoIndex,
      planPath: typeof args.plan === 'string' ? args.plan : '',
      cwd: typeof args.cwd === 'string' ? args.cwd : process.cwd(),
      // --run is echoed for auditability ONLY; it never triggers any re-derivation.
      run: typeof args.run === 'string' ? args.run : '',
    });
  } catch (e) {
    process.stderr.write(`forge-code-dir error: ${e.message}\n`);
    process.exit(2);
  }

  // --json is accepted and is a no-op (output is always JSON) — convention parity.
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(exitCodeFor(out.status));
}

if (require.main === module) cliMain();

module.exports = {
  resolveCodeDir,
  parseDeclaredPaths,
  parseFilesToChange,
  attributeRepo,
  parseListField,
  parseScalarField,
  matchDeclaredRepo,
  resolverOf,
  hintFor,
  frontmatterOf,
  normalizePath,
  globRoot,
  scorePath,
  isArtifactPath,
  exitCodeFor,
  REASON_CROSS_REPO,
  REASON_UNDECLARED,
  FS_PROBE_FLOOR,
};
