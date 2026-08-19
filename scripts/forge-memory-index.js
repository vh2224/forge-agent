'use strict';

// forge-memory-index.js — core of the file-source → facts index.
//
// Invariants (LOCKED — T02 renders on top of this, T03 asserts against it):
//   1. Citation extraction from `fact.text` prose is HEURISTIC. Any result this module
//      produces MUST carry the report of what it could not cover — a gate that does not
//      enumerate its own coverage/discard is an inert gate (Layer-3 forge-doctor precedent).
//   2. Paths found inside `fact.text` are UNTRUSTED STRINGS. Containment is checked
//      BEFORE any disk access (existsSync/basename lookup) — never a blind realpathSync.
//   3. `counts`/`coverage` numbers are ALWAYS derived by filtering the entries/facts
//      arrays — never incremented in a parallel counter (checkSymbols contract).
//
// This file exports the plain core (citation extraction, resolution, file walk,
// summarization, index building). The markdown renderer and CLI are added in T02 —
// intentionally absent here.

const fs = require('fs');
const path = require('path');

const { listFragments, parseFragment, memoryDir, readFragmentText } = require('./forge-memory');
const { guardReadAndWarn } = require('./forge-schema-guard');
const { buildUnitAxis, renderUnitAxis, buildSubjectAxis, renderSubjectAxis } = require('./forge-memory-axes');

// T02 default artifact path — LOCKED with T03 so the two never diverge.
const DEFAULT_INDEX_PATH = '.gsd/MEMORY-INDEX-BY-FILE.md';

// ── isWithin (molde de forge-prompt.js:75-78) ──────────────────────────────────
function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// ── CITATION_REGEXES ────────────────────────────────────────────────────────────
// Ordered registry — order IS precedence (first match for a given span wins).
// `name`s are LOCKED: T02 prints them, T03 asserts against them.
// Uses [ \t], never \s — do not cross newlines (MEM004 precedent). \Z does not exist in JS.
// Measured, narrow widening (2026-08-15): jsonl|jsonc|txt|swift added for real
// misses counted in the store (`events.jsonl` x3, `.gsd/forge-prefs.jsonc`,
// `seed.txt`, `GitActivity.swift` x2). citations_total moved 142 -> 150 on this
// workspace — no explosion (the 311 -> 972 precedent below was an ANY-suffix
// widening, not a closed-list addition). `jsonl|jsonc` sit before `json` for
// clarity only; the trailing guards already force the longest alternative.
// Measured, narrow widening (T01, 2026-08-19): less|ttf added to the closed
// list. Measured on `node scripts/forge-memory-index.js --json --cwd <cwd>`
// against this workspace's `.gsd/memory` store: citations_total stayed
// 37 -> 37 — no fragment in THIS repo's store currently mentions a `.less` or
// `.ttf` file, so there is no real miss here to recover (verified: zero
// `.less`/`.ttf` occurrences anywhere under `.gsd/memory`). The extraction and
// resolution behavior is proven instead by forge-memory-index.test.js, which
// exercises `mobile-reset.less` / `Roboto-Bold.ttf` via fixtures with a
// positive control (reverting `less|ttf` here turns those cases red).
const CODE_EXT = '(?:js|mjs|cjs|ts|tsx|jsx|jsonl|jsonc|json|md|sh|ps1|yml|yaml|vue|html|css|scss|aspx|svg|txt|swift|less|ttf)';

const CITATION_REGEXES = [
  {
    name: 'backticked-path',
    // `some/dir/file.ext` or `some/dir/file.ext:123`
    regex: new RegExp('`([\\w.\\-/@]+/[\\w.\\-@]+\\.' + CODE_EXT + ')(?::(\\d+))?`(?:[ \\t]+linha[ \\t]+(\\d+))?', 'g'),
    description: 'Caminho com barra entre crases, extensão de código/markdown, sufixo :linha opcional.',
  },
  {
    name: 'bare-path',
    // some/dir/file.ext outside backticks
    // #107: `~/...` é caminho relativo ao home. O lookbehind bloqueava `/`,
    // então NENHUM padrão via a menção: nem este (a extensão está lá, mas a
    // varredura só podia começar depois do `/`, que é caractere bloqueado) nem
    // `bare-basename` (o `/` imediatamente antes do nome também o bloqueia).
    // O prefixo entra explícito em vez de `~` entrar na classe geral: assim a
    // única forma nova aceita é a que foi medida, e `a~b/c.js` não vira caso.
    regex: new RegExp('(?<![`\\w./\\-@~])((?:~/)?[\\w.\\-@]+(?:/[\\w.\\-@]+)+\\.' + CODE_EXT + ')(?::(\\d+))?(?:[ \\t]+linha[ \\t]+(\\d+))?(?![`\\w])', 'g'),
    description: 'Caminho com barra e extensão de código/markdown fora de crases.',
  },
  {
    name: 'backticked-basename',
    // `file.ext` — no slash, inside backticks
    regex: new RegExp('`([\\w.\\-]+\\.' + CODE_EXT + ')`', 'g'),
    description: 'Nome de arquivo (sem barra) só com extensão, entre crases.',
  },
  {
    name: 'bare-basename',
    // file.ext loose in prose — dominant case in this repo's real fragment.
    //
    // Classe FP T02: `T##-PLAN.md` (token de plano, não arquivo). Sem `#` no
    // lookbehind, a regex começava no hífen e emitia o pedaço `-PLAN.md`, uma
    // citação permanentemente not-found. O delimitador entra na guarda para
    // avaliar o token inteiro; `T01-PLAN.md` continua uma citação legítima.
    regex: new RegExp('(?<![`#\\w./\\-@])([\\w.\\-]+\\.' + CODE_EXT + ')(?![`\\w])', 'g'),
    description: 'Nome de arquivo solto na prosa, sem crases e sem barra.',
  },
  {
    name: 'bare-path-traversal',
    // Extensionless slash-joined tokens are ordinary prose ("e/ou", "N/A",
    // "2026/08/04") far more often than they are a path — accepting the span
    // itself would poison citations_total (measured: 311 -> 972, see T01
    // repair). Only a candidate that actually contains a literal ".." path
    // segment is traversal-shaped; `filter` (applied below, in the main loop)
    // restricts extraction to that case, so the span is retained ONLY to
    // report the containment rejection.
    //
    // S06 R6: the invariant that actually holds is CONTAINMENT, not "no disk
    // access" — a retained span whose `..` segments stay inside the root (e.g.
    // `scripts/../scripts/foo`) does reach realpathSync/existsSync in
    // resolveCitation, and that is fine. What can never happen is a probe
    // OUTSIDE the root: `resolveCitation` rejects with `outside-root` before any
    // disk call, and re-checks containment on the REAL paths afterwards.
    regex: new RegExp('(?<![`\\w./\\-@])([\\w.\\-@]+(?:/(?:[\\w.\\-@]+|\\.{1,2}))+)(?![`\\w])', 'g'),
    description: 'Caminho solto sem extensao contendo segmento ".." mantido para reportar traversal.',
    filter: (candidatePath) => candidatePath.split('/').includes('..'),
  },
  {
    name: 'package-ref',
    // `name@version` is a package/directory reference, not a file citation.
    // Choice (a): enumerate it with a named reason instead of probing the disk
    // or reporting a misleading generic not-found result. Version MUST be
    // digit-led (`acme@1.2.0`) — an unanchored `[\w-]+` after `@` also matches
    // ordinary prose ("dev@empresa e mais"), see T01 repair.
    //
    // S06 R10: the digit anchor alone still matched prose handles with a year
    // ("suporte@2024"), so the version MUST also carry at least one dot
    // (`\d[\w-]*(?:\.[\w-]+)+`) — a real version always does.
    // S06 R1: a versioned path (`services@1.2.0/src/index.js`) is already read
    // whole by `bare-path`; without a trailing guard the same span was ALSO
    // counted here, manufacturing a permanently-UNRESOLVED phantom citation
    // that inflated the published citations_total denominator. `/` and `@` join
    // the trailing guard, and `(?!\.[\w\-])` blocks the backtracking escape in
    // which the version group gives back its last `.N` to satisfy the guard.
    regex: new RegExp('(?<![`\\w./\\-@])([\\w-]+@\\d[\\w\\-]*(?:\\.[\\w\\-]+)+)(?![`\\w/@])(?!\\.[\\w\\-])', 'g'),
    description: 'Referencia nome@versao (versao iniciada por digito, com ponto), enumerada como pacote/diretorio.',
  },
];

// gaps[] T02 — o detector independente mede estes formatos, mas alargar
// CODE_EXT para qualquer sufixo transformaria palavras pontuadas em citações
// irresolúveis (o precedente medido foi 311 -> 972). Permanecem reportados em
// `coverage.citation_gaps` e na saída F2 como menções perdidas, nunca ocultados
// para melhorar a métrica. Exemplo motivador: `config.py` (mem_id sintético
// `mem-gap-extension-outside-code-ext`) — uma extensão REAL fora de CODE_EXT.
// (`config.weird` deixou de servir de exemplo: o detector F2 agora enumera
// sufixos que não são extensão de arquivo real como ruído do instrumento.)
const CITATION_GAPS = [
  {
    name: 'extension-outside-code-ext',
    reason: 'sufixo fora de CODE_EXT: manter precisão, não aceitar extensão arbitrária',
  },
];

// Extension test used by the token-based dynamic-candidate scan below — bounded
// per-token, never a whole-text greedy match (avoids catastrophic over-match
// across unrelated backticks elsewhere in the sentence).
const EXT_SUFFIX_RE = new RegExp('\\.' + CODE_EXT + '[)\\],.;:!?]*$');

// Bucket (b) must not grade the extractor with its own CODE_EXT vocabulary.
// Loading is deliberately late: forge-index-f2 imports this module to measure
// it, so a top-level require would freeze a circular, incomplete export.
// S06 R7's 120-char signal budget still applies; the detector's raw token is
// rendered but never probed on disk.
function findIndependentSampleFileToken(text) {
  const mention = independentMentionEvidence(text).mentions[0];
  return mention ? String(mention.raw).slice(0, 120) : null;
}

// The F2 detector deliberately has its own normalizer. Keep comparison logic
// here limited to the stable basename representation: importing CODE_EXT or a
// registry pattern into this boundary would turn the independent observation
// back into self-evaluation. These helpers are also deliberately total: a
// malformed detector return becomes an empty observation rather than a new
// exception in the index read path.
function citationComparableBasename(value) {
  return String(value || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

function detectIndependentMentions(text) {
  try {
    // Key link T02: the measurement detector is the source for bucket (b).
    // S02 R1 (review-fix): consumir a lista JÁ filtrada do ruído conhecido do
    // detector (versão nua, `e/ou`, abreviação com barra). O bucket (b) e a
    // medição F2 passam a classificar pelo mesmo critério; antes, um fato cuja
    // única menção era ruído entrava em `missed_by_extractor`.
    const { detectSignalMentions } = require('./forge-index-f2');
    const mentions = detectSignalMentions(text);
    return Array.isArray(mentions) ? mentions : [];
  } catch (_) {
    // A measurement helper must not make core index reads fail. This is only a
    // classification aid; extraction/resolution remains available on its own.
    return [];
  }
}

function independentMentionEvidence(text, citations) {
  const mentions = detectIndependentMentions(text);
  const extracted = Array.isArray(citations) ? citations : extractCitations(text);
  const citedNames = new Set(extracted.map((citation) => citationComparableBasename(citation.path || citation.raw)));
  const unmatched = mentions.filter((mention) => !citedNames.has(citationComparableBasename(mention.normalized || mention.raw)));
  return {
    mentions,
    unmatched,
    // Keep this name descriptive instead of calling it "valid": the detector
    // intentionally reports file-shaped noise so its false positives remain
    // auditable in F2. Bucket (b) means "detected but unextracted", not proof
    // that the token names a real file.
    detector_observed: mentions.length > 0,
  };
}

function classifyNoCitationFact(text) {
  const evidence = independentMentionEvidence(text, []);
  const first = evidence.mentions[0];
  if (!first) {
    return {
      bucket: 'no_file_mention',
      sample_token: null,
      detector_mentions: 0,
    };
  }
  return {
    bucket: 'missed_by_extractor',
    sample_token: String(first.raw || '').slice(0, 120),
    detector_mentions: evidence.mentions.length,
  };
}

function citationGapCoverage() {
  // Copy the public report shape on every result so a caller cannot mutate the
  // registry used by later index runs. `reason` is prose, not a control value.
  return CITATION_GAPS.map((gap) => ({ name: gap.name, reason: gap.reason }));
}

function citationGapNames(gaps) {
  return (Array.isArray(gaps) ? gaps : [])
    .map((gap) => String(gap && gap.name || ''))
    .filter(Boolean);
}

function hasNamedCitationGap(gaps, name) {
  return citationGapNames(gaps).includes(String(name || ''));
}

function isKnownCitationGap(name) {
  return hasNamedCitationGap(CITATION_GAPS, name);
}

function sumUnresolvedCoverage(unresolved) {
  return (Array.isArray(unresolved) ? unresolved : [])
    .reduce((total, item) => total + Number((item && item.count) || 0), 0);
}

function hasCitationCoverageIdentity(coverage) {
  const safe = coverage || {};
  return Number(safe.citations_resolved || 0) + sumUnresolvedCoverage(safe.unresolved) === Number(safe.citations_total || 0);
}

// Produce a compact, serializable comparison for diagnostics and tests. It is
// deliberately a snapshot, never a second extraction pass over the store. The
// extractor owns citations; F2 owns what looks like a mention; this helper only
// makes the boundary between their two observations explicit.
function citationDetectionBreakdown(text, citations) {
  const extracted = Array.isArray(citations) ? citations : extractCitations(text);
  const evidence = independentMentionEvidence(text, extracted);
  const observedNames = independentMentionNames(evidence.mentions);
  const extractorOnly = citationsWithoutIndependentMention(extracted, observedNames);
  return {
    detector_mentions: evidence.mentions.length,
    detector_unmatched: evidence.unmatched.map((mention) => mention.raw),
    extractor_only: extractorOnly,
  };
}

function independentMentionNames(mentions) {
  const names = new Set();
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const name = citationComparableBasename(mention && (mention.normalized || mention.raw));
    if (name) names.add(name);
  }
  return names;
}

function citationNames(citations) {
  const names = new Set();
  for (const citation of Array.isArray(citations) ? citations : []) {
    const name = citationComparableBasename(citation && (citation.path || citation.raw));
    if (name) names.add(name);
  }
  return names;
}

function citationsWithoutIndependentMention(citations, mentionNames) {
  const observed = mentionNames instanceof Set ? mentionNames : new Set();
  return (Array.isArray(citations) ? citations : [])
    .filter((citation) => !observed.has(citationComparableBasename(citation && (citation.path || citation.raw))))
    .map((citation) => citation.raw);
}

function mentionsWithoutCitation(mentions, citations) {
  const cited = citationNames(citations);
  return (Array.isArray(mentions) ? mentions : [])
    .filter((mention) => !cited.has(citationComparableBasename(mention && (mention.normalized || mention.raw))));
}

function formatCitationGap(gap) {
  const name = String(gap && gap.name || 'unnamed-gap');
  const reason = String(gap && gap.reason || 'sem motivo declarado');
  return `${name} (${reason})`;
}

function renderCitationGapLines(gaps) {
  const safe = Array.isArray(gaps) ? gaps : [];
  if (safe.length === 0) return ['- citation_gaps: nenhum'];
  const lines = ['- citation_gaps:'];
  for (const gap of safe) lines.push(`  - ${formatCitationGap(gap)}`);
  return lines;
}

function citationCoverageSummary(coverage) {
  const safe = coverage || {};
  const total = Number(safe.citations_total || 0);
  const resolved = Number(safe.citations_resolved || 0);
  const unresolved = sumUnresolvedCoverage(safe.unresolved);
  return {
    total,
    resolved,
    unresolved,
    identity_holds: resolved + unresolved === total,
    gaps: citationGapNames(citationGapCoverage()),
  };
}

function citationCoverageIsPrecise(before, after) {
  const previous = citationCoverageSummary(before);
  const current = citationCoverageSummary(after);
  return current.unresolved <= previous.unresolved;
}

function citationCoverageGaps(coverage) {
  const safe = coverage || {};
  return citationGapCoverage().filter((gap) => {
    const reported = Array.isArray(safe.citation_gaps) ? safe.citation_gaps : [];
    return hasNamedCitationGap(reported, gap.name);
  });
}

function citationGapCount(coverage) {
  return citationCoverageGaps(coverage).length;
}

function hasCitationGaps(coverage) {
  return citationGapCount(coverage) > 0;
}

// ── findDynamicCandidates ────────────────────────────────────────────────────
// Token-bounded scan (never a single greedy regex over the whole text) for
// candidates that embed a template-literal `${`, a wildcard `*`, or an
// INTERNAL backtick (one that is not merely the token's own wrapping pair)
// before an accepted extension. Always discarded as pattern:'dynamic' — never
// silenced; enumerated, per step 4 of T01-PLAN.
function findDynamicCandidates(text) {
  const results = [];
  const tokenRe = /\S+/g;
  let tm;
  while ((tm = tokenRe.exec(text)) !== null) {
    const token = tm[0];

    // S02 R2: strip ONE wrapping backtick pair BEFORE the extension test.
    // EXT_SUFFIX_RE anchors on `$`, so a trailing backtick used to block the
    // match entirely — a wrapped `scripts/forge-${name}.js` was never even
    // TESTED for `${` and vanished from coverage (silent discard, forbidden by
    // invariant #1). The original token is kept as `raw` so the report shows
    // exactly what the fact wrote.
    const core = (token.length >= 2 && token[0] === '`' && token[token.length - 1] === '`')
      ? token.slice(1, -1)
      : token;

    if (!EXT_SUFFIX_RE.test(core)) continue;

    const hasTemplate = core.includes('${');
    const hasWildcard = core.includes('*');
    // After removing the single wrapping pair, ANY remaining backtick is by
    // definition internal (a plain `path/file.js` is already handled by the
    // ordered backtick patterns above and leaves no backtick in `core`).
    const hasInternalBacktick = core.includes('`');

    if (hasTemplate || hasWildcard || hasInternalBacktick) {
      results.push({ raw: token, path: core, line: null, pattern: 'dynamic', index: tm.index });
    }
  }
  return results;
}

// ── extractCitations ─────────────────────────────────────────────────────────
// Extracts file citations from free-prose fact.text.
// Returns Array<{ raw, path, line, pattern }>, deduplicated by path
// (first occurrence wins, including its line), preserving order of appearance.
//
// Candidates containing `${`, an internal backtick, or `*` are discarded as
// "dynamic" citations — the caller keeps them enumerable via resolveCitation
// returning UNRESOLVED/dynamic, rather than silently dropping them.
function extractCitations(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const found = []; // { raw, path, line, pattern, index }
  for (const { name, regex, filter } of CITATION_REGEXES) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const raw = m[0];
      const rawPath = m[1];
      const lineCapture = m[2] || m[3];
      const line = lineCapture ? parseInt(lineCapture, 10) : null;

      if (filter && !filter(rawPath)) {
        if (regex.lastIndex === m.index) regex.lastIndex++;
        continue;
      }

      found.push({
        raw,
        path: rawPath,
        line,
        pattern: name,
        index: m.index,
      });

      // Guard against zero-width infinite loop (should not happen with these patterns).
      if (regex.lastIndex === m.index) regex.lastIndex++;
    }
  }

  // Dynamic candidates (${, *, internal backtick) — bounded per-token scan.
  found.push(...findDynamicCandidates(text));

  // Preserve order of appearance across all patterns combined.
  found.sort((a, b) => a.index - b.index);

  // Dedup by path — first occurrence wins (keeps its line).
  const seen = new Map();
  const ordered = [];
  for (const c of found) {
    if (seen.has(c.path)) continue;
    seen.set(c.path, true);
    ordered.push({ raw: c.raw, path: c.path, line: c.line, pattern: c.pattern });
  }

  return ordered;
}

// ── listRepoFiles ────────────────────────────────────────────────────────────
// Single bounded walk of the repository. Skips .git, node_modules, dist, build,
// .next, .forge-worktrees. Returns paths normalized with '/' for stable output
// across Windows and POSIX. Caps at opts.limit (default 20000) files — the cap
// itself is a reported fact in coverage, never a silent truncation.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.forge-worktrees']);

function listRepoFiles(root, opts) {
  opts = opts || {};
  const limit = typeof opts.limit === 'number' ? opts.limit : 20000;

  const files = [];
  const byBasename = new Map();
  let capped = false;

  const stack = [root];
  while (stack.length > 0) {
    if (capped) break;
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (capped) break;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      if (files.length >= limit) {
        capped = true;
        break;
      }

      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      files.push(rel);

      const basename = entry.name;
      if (!byBasename.has(basename)) byBasename.set(basename, []);
      byBasename.get(basename).push(rel);
    }
  }

  return { files, byBasename, capped };
}

// ── resolveCitation ──────────────────────────────────────────────────────────
// Non-binary resolution. NEVER throws (total try/catch).
// Order: dynamic → containment (outside-root, BEFORE any existsSync) →
//        exact disk match → basename match (1 candidate = RESOLVED, ≥2 = ambiguous) →
//        not-found.
function resolveCitation(citation, cwd, index) {
  try {
    if (!citation || typeof citation.path !== 'string' || citation.path.length === 0) {
      return { state: 'UNRESOLVED', reason: 'not-found' };
    }

    if (citation.pattern === 'dynamic') {
      return { state: 'UNRESOLVED', reason: 'dynamic' };
    }

    if (citation.pattern === 'package-ref') {
      return { state: 'UNRESOLVED', reason: 'package-ref' };
    }

    const root = path.resolve(cwd);
    const candidatePath = citation.path;

    // #107: `~/...` é relativo ao HOME, nunca ao workspace. Sem esta linha o
    // caminho cai em `path.resolve(root, '~/x')` — lexicamente dentro da raiz —
    // e termina em `not-found`, que AFIRMA que um arquivo está faltando quando
    // ele nunca deveria estar aqui. Pior: o casamento por basename poderia
    // resolvê-lo para um arquivo homônimo do repo, citando o arquivo errado.
    // `outside-root` é a razão que já existe e já significa exatamente isto —
    // o relatório a agrupa em "por design não são arquivo", junto de
    // package-ref e dynamic.
    if (/^~[\/]/.test(candidatePath)) {
      return { state: 'UNRESOLVED', reason: 'outside-root' };
    }

    // Absolute path or path escaping the root → outside-root, before any disk access.
    if (path.isAbsolute(candidatePath)) {
      return { state: 'UNRESOLVED', reason: 'outside-root' };
    }
    const resolved = path.resolve(root, candidatePath);
    if (!isWithin(root, resolved)) {
      return { state: 'UNRESOLVED', reason: 'outside-root' };
    }

    // Lexical containment is not enough: existsSync/statSync FOLLOW symlinks, so
    // a link inside the repo that points outside would otherwise be stat'd and
    // resolved. Re-establish containment on the REAL paths.
    //   • real root vs real candidate — never real-vs-lexical: this repo itself
    //     runs from a worktree under .forge-worktrees, and comparing a real
    //     candidate against a lexical root would reject that legitimate layout.
    //   • realpathSync throws ENOENT for a path that does not exist; a missing
    //     citation must keep falling through to its 'not-found' reason, so a
    //     failed realpath is simply "nothing to check here", never a rejection.
    let realRoot = root;
    try { realRoot = fs.realpathSync(root); } catch (_) { realRoot = root; }
    let realCandidate = null;
    try { realCandidate = fs.realpathSync(resolved); } catch (_) { realCandidate = null; }
    if (realCandidate !== null && !isWithin(realRoot, realCandidate)) {
      return { state: 'UNRESOLVED', reason: 'outside-root' };
    }

    // Exact match against the disk (relative to root).
    const relNormalized = path.relative(root, resolved).split(path.sep).join('/');
    let existsExact = false;
    try {
      existsExact = fs.existsSync(resolved) && fs.statSync(resolved).isFile();
    } catch (_) {
      existsExact = false;
    }
    if (existsExact) {
      return { state: 'RESOLVED', file: relNormalized, how: 'path' };
    }

    // Basename match, only meaningful for bare-basename / backticked-basename patterns
    // (candidatePath without a slash) but harmless to try generally.
    const basename = path.basename(candidatePath);
    const byBasename = index && index.byBasename;
    const candidates = byBasename ? byBasename.get(basename) : null;

    if (candidates && candidates.length === 1) {
      return { state: 'RESOLVED', file: candidates[0], how: 'basename' };
    }
    if (candidates && candidates.length >= 2) {
      return { state: 'UNRESOLVED', reason: 'ambiguous-basename', candidates: candidates.slice() };
    }

    return { state: 'UNRESOLVED', reason: 'not-found' };
  } catch (_) {
    return { state: 'UNRESOLVED', reason: 'not-found' };
  }
}

// ── summarizeFact ─────────────────────────────────────────────────────────────
// First sentence of fact.text, normalized (collapse line breaks/whitespace),
// truncated at opts.maxChars (default 160) with an ellipsis. Deterministic, no
// wallclock.
function summarizeFact(fact, opts) {
  opts = opts || {};
  const maxChars = typeof opts.maxChars === 'number' ? opts.maxChars : 160;

  const text = (fact && typeof fact.text === 'string') ? fact.text : '';
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return '';

  // First sentence: up to first '. ' (followed by space/end) or full string if none.
  const sentenceMatch = collapsed.match(/^(.+?[.!?])(?:\s|$)/);
  let sentence = sentenceMatch ? sentenceMatch[1] : collapsed;

  if (sentence.length > maxChars) {
    sentence = sentence.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
  }

  return sentence;
}

// ── listSkippedFragmentFiles ──────────────────────────────────────────────────
// Dogfood fix (real store, 144 files on disk → 116 returned): `listFragments`
// silently drops every `.md` in `.gsd/memory/` whose name does not parse as a
// valid storage key. 19% of that store was absent from the index and mentioned
// NOWHERE — exactly the failure class invariant #1 exists to forbid.
//
// This function only REPORTS the gap; it never closes it. `listFragments`
// behavior is deliberately untouched (it is consumed system-wide).
//
// Compares by FILENAME ON DISK, never by re-reading through the store API:
// listFragments can return an entry (`legacy-orphan`) that readFragment then
// rejects by throwing, so a re-read would turn a report into a crash path.
// Total try/catch: an absent/unreadable memory dir yields [] exactly as before.
function listSkippedFragmentFiles(cwd, fragments) {
  try {
    const dir = memoryDir(cwd);
    const onDisk = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name);

    const returned = new Set(
      (Array.isArray(fragments) ? fragments : [])
        .map((f) => (f && typeof f.path === 'string' ? path.basename(f.path) : null))
        .filter((n) => n !== null)
    );

    return onDisk
      .filter((name) => !returned.has(name))
      .sort((a, b) => a.localeCompare(b, 'en')); // determinism: byte-identical reruns
  } catch (_) {
    return [];
  }
}

// ── buildFileIndex ────────────────────────────────────────────────────────────
// Orchestrator: reads all memory fragments via listFragments/parseFragment,
// extracts + resolves citations per fact, and aggregates entries by resolved
// file plus a coverage block whose numbers are always derived by filtering the
// same lists that produced entries — never a parallel counter.
function buildFileIndex(cwd, opts) {
  opts = opts || {};
  const root = path.resolve(cwd);

  // Guarded read (T02): wired HERE, at the single entry point that reads the
  // fragment store, so `result.partial` is set for every caller (direct API
  // and CLI alike) instead of being duplicated at each call site.
  // `forge-memory.listFragments` already calls the guard internally to decide
  // whether IT should degrade — but it does not hand `partial` back to us, so
  // this explicit call exists purely so the ARTIFACT can mark itself partial.
  // Do not remove this as "duplicate of listFragments' internal guard call" —
  // it is a second, deliberate call for a different purpose.
  let guardPartial = false;
  let guardUnavailable = false;
  try {
    const g = guardReadAndWarn(cwd, opts.schemaGuard || {});
    guardPartial = !!(g && g.partial);
  } catch (_) {
    // S01 R1 (known fragility, not fixed here): if the guard fails to load or
    // throws, degrade to partial:false — but that degradation itself must be
    // visible, never silent, so it is recorded below as a coverage entry.
    guardPartial = false;
    guardUnavailable = true;
  }

  const fileIndex = listRepoFiles(root, opts.listRepoFiles || {});

  const unreadableFragments = [];
  const allFacts = []; // { fact, fragment }
  const facts = [];

  // S02 R3: an enumeration failure used to yield fragments_read:0 with an empty
  // unreadable_fragments and partial untouched — BYTE-IDENTICAL to a genuinely
  // empty store. The per-fragment read failure right below is enumerated; that
  // same discipline now covers the enumeration step itself. A consumer must be
  // able to tell "could not read the store" from "the store is empty".
  let fragments;
  let fragmentListingFailed = null;
  try {
    fragments = listFragments(cwd, opts.listFragments || {});
  } catch (e) {
    fragments = [];
    fragmentListingFailed = (e && e.message) ? e.message : 'list-error';
  }

  // Files present in .gsd/memory/ that the store did NOT hand back — see
  // listSkippedFragmentFiles. Their facts are absent from this index.
  const fragmentsSkippedByStore = listSkippedFragmentFiles(cwd, fragments);

  for (const fragment of fragments) {
    let parsed;
    try {
      const text = readFragmentText(cwd, fragment);
      parsed = parseFragment(text);
    } catch (e) {
      unreadableFragments.push({
        storageKey: fragment.storageKey,
        path: fragment.path,
        reason: (e && e.message) ? e.message : 'read-error',
      });
      continue;
    }

    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    for (const fact of facts) {
      allFacts.push({ fact, fragment });
    }
  }

  // entries keyed by resolved file path.
  const entriesByFile = new Map();

  // Per-citation resolution results, kept for coverage aggregation.
  const resolvedCitations = []; // { citation, resolution }
  const factsWithoutCitation = []; // { mem_id, storage_key }
  const factsUnresolvedOnly = []; // { mem_id, storage_key }
  const factClassifications = []; // { mem_id, storage_key, bucket, sample_token? }

  for (const { fact, fragment } of allFacts) {
    const memId = fact && fact.mem_id ? fact.mem_id : null;
    const storageKey = fragment.storageKey;

    const citations = extractCitations(fact && fact.text);
    let factCitationsResolved = 0;

    if (citations.length === 0) {
      const classification = classifyNoCitationFact(fact && fact.text);
      const record = { mem_id: memId, storage_key: storageKey };
      factsWithoutCitation.push(record);
      factClassifications.push({
        mem_id: memId,
        storage_key: storageKey,
        bucket: classification.bucket,
        ...(classification.sample_token ? { sample_token: classification.sample_token } : {}),
      });
      continue;
    }

    let anyResolved = false;
    // S02 R5: citations are deduped by RAW TEXT upstream, but two distinct
    // citations in one fact can resolve to the SAME target file (e.g.
    // `scripts/foo.js` via how:'path' and the unique basename `foo.js` via
    // how:'basename'). Pushing per citation emitted two identical rows under
    // one file. Dedup per fact by the RESOLVED file, keeping the first
    // citation's line.
    const seenFilesForFact = new Set();

    for (const citation of citations) {
      const resolution = resolveCitation(citation, cwd, fileIndex);
      resolvedCitations.push({ citation, resolution, mem_id: memId });

      if (resolution.state === 'RESOLVED') {
        anyResolved = true;
        factCitationsResolved++;
        const file = resolution.file;
        if (seenFilesForFact.has(file)) continue;
        seenFilesForFact.add(file);
        if (!entriesByFile.has(file)) {
          entriesByFile.set(file, { file, facts: [] });
        }
        entriesByFile.get(file).facts.push({
          mem_id: memId,
          category: fact && fact.category ? fact.category : null,
          summary: summarizeFact(fact, opts.summarize || {}),
          source_unit: fact && fact.source_unit ? fact.source_unit : null,
          unit_id: fragment.unitId,
          storage_key: storageKey,
          line: citation.line,
        });
      }
    }

    if (!anyResolved) {
      const record = { mem_id: memId, storage_key: storageKey };
      record.citation_reasons = citations.map((item) => resolveCitation(item, cwd, fileIndex).reason).filter(Boolean);
      factsUnresolvedOnly.push(record);
      factClassifications.push({ mem_id: memId, storage_key: storageKey, bucket: 'unresolved_only' });
    } else {
      factClassifications.push({ mem_id: memId, storage_key: storageKey, bucket: 'with_resolved' });
    }

    facts.push({
      mem_id: memId,
      category: fact && fact.category ? fact.category : null,
      summary: summarizeFact(fact, opts.summarize || {}),
      unit_id: fragment.unitId || null,
      storage_key: storageKey || null,
      milestone_id: fragment.milestoneId || null,
      source_unit: fact && fact.source_unit ? fact.source_unit : null,
      text: fact && typeof fact.text === 'string' ? fact.text : '',
      citations_total: citations.length,
      citations_resolved: factCitationsResolved,
      citations_resolved_count: factCitationsResolved,
    });
  }

  // entries ordered by file (localeCompare('en')); facts ordered by storage_key then mem_id.
  const entries = [...entriesByFile.values()]
    .sort((a, b) => a.file.localeCompare(b.file, 'en'))
    .map((entry) => ({
      file: entry.file,
      facts: entry.facts.slice().sort((a, b) => {
        const sk = String(a.storage_key).localeCompare(String(b.storage_key), 'en');
        if (sk !== 0) return sk;
        return String(a.mem_id).localeCompare(String(b.mem_id), 'en');
      }),
    }));

  // unresolved — aggregated by raw+reason → { raw, reason, count, example_mem_id, candidates? },
  // ordered by count desc then raw.
  const unresolvedMap = new Map(); // key: `raw` + NUL + `reason` (NUL cannot occur in either part)
  for (const { citation, resolution } of resolvedCitations) {
    if (resolution.state !== 'UNRESOLVED') continue;
    const key = `${citation.raw}\0${resolution.reason}`;
    if (!unresolvedMap.has(key)) {
      unresolvedMap.set(key, {
        raw: citation.raw,
        reason: resolution.reason,
        count: 0,
        example_mem_id: null,
        candidates: resolution.candidates,
      });
    }
    const agg = unresolvedMap.get(key);
    agg.count += 1;
  }
  // Attach an example_mem_id per aggregate (first occurrence).
  for (const { citation, resolution } of resolvedCitations) {
    if (resolution.state !== 'UNRESOLVED') continue;
    const key = `${citation.raw}\0${resolution.reason}`;
    const agg = unresolvedMap.get(key);
    if (agg && agg.example_mem_id === null) {
      // Find owning fact for this citation among allFacts — best effort, first match.
      for (const { fact } of allFacts) {
        const memId = fact && fact.mem_id ? fact.mem_id : null;
        const citations = extractCitations(fact && fact.text);
        if (citations.some((c) => c.raw === citation.raw)) {
          agg.example_mem_id = memId;
          break;
        }
      }
    }
  }

  const unresolved = [...unresolvedMap.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return String(a.raw).localeCompare(String(b.raw), 'en');
  });

  const citationsTotal = resolvedCitations.length;
  const citationsResolved = resolvedCitations.filter((r) => r.resolution.state === 'RESOLVED').length;

  const coverage = {
    fragments_read: fragments.length - unreadableFragments.length,
    facts_total: allFacts.length,
    facts_with_resolved: factClassifications.filter((f) => f.bucket === 'with_resolved').length,
    facts_unresolved_only: factsUnresolvedOnly,
    facts_without_citation: factsWithoutCitation,
    facts_no_file_mention: factClassifications.filter((f) => f.bucket === 'no_file_mention'),
    facts_missed_by_extractor: factClassifications.filter((f) => f.bucket === 'missed_by_extractor'),
    files_indexed: entries.length,
    citations_total: citationsTotal,
    citations_resolved: citationsResolved,
    unresolved,
    unreadable_fragments: unreadableFragments,
    // Additive (dogfood fix): fragment FILES the store dropped before we ever
    // saw them. Distinct from unreadable_fragments (which the store returned
    // and we failed to read). Never feeds the citation sum invariant.
    fragments_skipped_by_store: fragmentsSkippedByStore,
    citation_gaps: citationGapCoverage(),
    scan_capped: fileIndex.capped,
    guard_unavailable: guardUnavailable,
    fragment_listing_failed: fragmentListingFailed,
  };

  // R4: classify existing (c) facts from the citation census. A file-missing
  // reason dominates when a fact also contains a by-design citation.
  const causes = { por_design_nao_e_arquivo: [], citacao_de_arquivo_nao_localizada: [] };
  const reasonsByFact = new Map();
  for (const item of resolvedCitations) {
    if (!reasonsByFact.has(item.mem_id)) reasonsByFact.set(item.mem_id, []);
    if (item.resolution && item.resolution.reason) reasonsByFact.get(item.mem_id).push(item.resolution.reason);
  }
  for (const item of factsUnresolvedOnly) {
    const reasons = reasonsByFact.get(item.mem_id) || item.citation_reasons || [];
    const missing = reasons.some((reason) => reason === 'not-found' || reason === 'ambiguous-basename');
    causes[missing ? 'citacao_de_arquivo_nao_localizada' : 'por_design_nao_e_arquivo'].push(item);
  }
  if (causes.por_design_nao_e_arquivo.length + causes.citacao_de_arquivo_nao_localizada.length !== factsUnresolvedOnly.length) throw new Error('identidade de causas do balde (c) não fecha');
  coverage.unresolved_cause_counts = {
    por_design_nao_e_arquivo: causes.por_design_nao_e_arquivo.length,
    citacao_de_arquivo_nao_localizada: causes.citacao_de_arquivo_nao_localizada.length,
  };
  coverage.unresolved_cause_facts = causes;

  return { entries, facts, coverage, partial: guardPartial || fragmentListingFailed !== null, _cwd: root };
}

// ── renderIndex ────────────────────────────────────────────────────────────────
// Deterministic markdown renderer. No wallclock anywhere in the output — two
// runs over the same store produce byte-identical strings. `coverage` field
// names come from T01 and are LOCKED: rendered verbatim, never renamed.
// S02 R6: every value interpolated into markdown is UNTRUSTED — `raw` comes
// from free prose scanned as `\S+` tokens (so `a|b*.js` is reachable) and
// `mem_id` comes from fragment frontmatter. An unescaped `|` turns a 4-column
// row into a 6-column one, corrupting the one section whose entire purpose is
// being trustworthy.
//
// cell()     — safe for a table cell: no raw pipes, no line breaks.
// codeCell() — cell() + code-formatted; uses a `` fence when the value itself
//              contains a backtick, so the span never breaks.
// prose()    — neutralizes raw HTML for free-text rendered outside a table.
function cell(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|');
}

function codeCell(value) {
  const s = cell(value);
  if (s.length === 0) return '';
  if (s.includes('`')) return '`` ' + s + ' ``';
  return '`' + s + '`';
}

function prose(value) {
  return cell(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── factLine ──────────────────────────────────────────────────────────────────
// Single source of truth for the fact-line format. Extracted from renderIndex's
// loop (T01 step 2) — renderIndex and renderQuery (T01 step 6) both consume this;
// neither owns a second copy of the format. Mirrors the renderLedgerBlock
// precedent (one source for the shape of a block).
function factLine(fact) {
  const memId = fact.mem_id ? codeCell(fact.mem_id) : '(sem mem_id)';
  const category = fact.category ? prose(fact.category) : '(sem categoria)';
  const summary = fact.summary ? prose(fact.summary) : '(sem resumo)';
  const unit = (fact.unit_id || fact.storage_key)
    ? codeCell(fact.unit_id || fact.storage_key)
    : '(unidade desconhecida)';
  const source = fact.source_unit ? ` — source_unit: ${codeCell(fact.source_unit)}` : '';
  return `- ${memId} (${category}) — ${summary} — origem: ${unit}${source}`;
}

// S02 R2 (review-fix): a chave do cache é o OBJETO `result` desta render, não o
// `cwd`. Cacheado por cwd, um segundo render no mesmo processo devolvia o número
// de uma medição anterior enquanto o rótulo afirmava "medida nesta execução" —
// afirmação de medição que ninguém fez naquela render (classe TASK-021/S07).
// O WeakMap existe só para evitar medir duas vezes DENTRO da mesma render.
const PARTIAL_CAPTURE_CACHE = new WeakMap();
function partialCaptureCount(result) {
  const key = result && typeof result === 'object' ? result : null;
  if (key && PARTIAL_CAPTURE_CACHE.has(key)) return PARTIAL_CAPTURE_CACHE.get(key);
  const cwd = (result && result._cwd) || process.cwd();
  let value;
  try {
    const { measureF2 } = require('./forge-index-f2');
    const report = measureF2(cwd);
    value = Array.isArray(report.facts_missed_partial) ? report.facts_missed_partial.length : 0;
  } catch (error) {
    value = `não medida nesta execução (${error && error.message ? error.message : String(error)})`;
  }
  if (key) PARTIAL_CAPTURE_CACHE.set(key, value);
  return value;
}

function renderIndex(result, opts) {
  opts = opts || {};
  const entries = Array.isArray(result && result.entries) ? result.entries : [];
  const coverage = (result && result.coverage) || {};
  const partial = !!(result && result.partial);

  const lines = [];

  lines.push('# Índice de memória por arquivo-fonte');
  lines.push('');
  lines.push('_Este arquivo é derivado e regenerável — nunca edite à mão. Para regenerar:_');
  lines.push('`node scripts/forge-memory-index.js --write`');
  lines.push('');
  lines.push('_Consulta sob demanda: este arquivo não é injetado em nenhum prompt._');
  lines.push('');

  if (partial) {
    lines.push('> ⚠️ **Índice parcial** — o dado em `.gsd/SCHEMA-VERSION` está à frente da tooling local.');
    lines.push('> Este índice pode estar incompleto até a tooling ser atualizada (`/forge-update`).');
    lines.push('');
  }

  lines.push('## Índice por arquivo-fonte');
  lines.push('');
  if (entries.length === 0) {
    lines.push('_Nenhum fragmento de memória encontrado._');
    lines.push('');
  } else {
    for (const entry of entries) {
      lines.push(`### ${codeCell(entry.file)}`);
      lines.push('');
      for (const fact of entry.facts) {
        lines.push(factLine(fact));
      }
      lines.push('');
    }
  }

  const unitAxis = buildUnitAxis(result);
  lines.push(renderUnitAxis(unitAxis));
  const { buildSubjectAxis, renderSubjectAxis } = require('./forge-memory-axes');
  lines.push(renderSubjectAxis(buildSubjectAxis(result)));

  // ── Cobertura e descarte — INCONDICIONAL (never omitted, never skipped). ──
  lines.push('## Cobertura e descarte');
  lines.push('');
  // S02 R3: an enumeration failure must NEVER read as an empty store.
  if (coverage.fragment_listing_failed) {
    lines.push(`> 🛑 **Não foi possível LER o store de memória** (\`fragment_listing_failed\`): ${prose(coverage.fragment_listing_failed)}`);
    lines.push('> Os números abaixo são zerados por FALHA DE LEITURA, não porque o store esteja vazio. Índice marcado como parcial.');
    lines.push('');
  }
  lines.push(`- fragments_read: ${coverage.fragments_read || 0}`);
  lines.push(`- facts_total: ${coverage.facts_total || 0}`);
  lines.push(`- facts_with_resolved: ${coverage.facts_with_resolved || 0}`);
  const noFileMention = Array.isArray(coverage.facts_no_file_mention) ? coverage.facts_no_file_mention : [];
  const missedByExtractor = Array.isArray(coverage.facts_missed_by_extractor) ? coverage.facts_missed_by_extractor : [];
  const unresolvedOnly = Array.isArray(coverage.facts_unresolved_only) ? coverage.facts_unresolved_only : [];
  lines.push(`- (a) fatos sem menção reconhecida pelo vocabulário do detector independente: ${noFileMention.length} — fronteira do detector de T01/T02; não permite afirmar ausência de defeito fora dela.`);
  lines.push(`- (b) fatos cuja citação de arquivo não foi capturada inteiramente pelo extrator: ${missedByExtractor.length} — o detector reconhece a menção; captura PARCIAL não incluída neste total, medida nesta execução: ${partialCaptureCount(result)}.`);
  const causes = coverage.unresolved_cause_counts || { por_design_nao_e_arquivo: 0, citacao_de_arquivo_nao_localizada: 0 };
  lines.push(`- (c) fatos com citações extraídas, mas nenhuma resolvida a um arquivo: ${unresolvedOnly.length} — por design não são arquivo (package-ref/dynamic/outside-root): ${causes.por_design_nao_e_arquivo}; citação de arquivo não localizada (not-found/ambiguous-basename): ${causes.citacao_de_arquivo_nao_localizada}. A segunda categoria domina quando ambas aparecem; a soma é exatamente (c).`);
  lines.push(`- citations_total: ${coverage.citations_total || 0}`);
  lines.push(`- citations_resolved: ${coverage.citations_resolved || 0}`);
  lines.push(`- files_indexed: ${coverage.files_indexed || 0}`);
  const citationGaps = Array.isArray(coverage.citation_gaps) ? coverage.citation_gaps : [];
  lines.push(...renderCitationGapLines(citationGaps));
  lines.push('');

  lines.push('### Citações não resolvidas');
  lines.push('');
  const unresolved = Array.isArray(coverage.unresolved) ? coverage.unresolved : [];
  if (unresolved.length === 0) {
    lines.push('_Nenhuma citação não resolvida._');
  } else {
    lines.push('| citação | motivo | ocorrências | exemplo mem_id |');
    lines.push('|---|---|---|---|');
    for (const u of unresolved) {
      const raw = codeCell(u.raw) || '(vazio)';
      const example = u.example_mem_id ? codeCell(u.example_mem_id) : '(nenhum)';
      lines.push(`| ${raw} | ${cell(u.reason)} | ${cell(u.count)} | ${example} |`);
    }
  }
  lines.push('');

  lines.push('### Fatos com apenas citações irresolúveis');
  lines.push('');
  if (unresolvedOnly.length === 0) {
    lines.push('_Nenhum fato com apenas citações irresolúveis._');
  } else {
    for (const f of unresolvedOnly) lines.push(`- ${f.mem_id ? codeCell(f.mem_id) : '(sem mem_id)'} (${f.storage_key ? codeCell(f.storage_key) : '(unidade desconhecida)'})`);
  }
  lines.push('');

  lines.push('### Fatos cuja citação de arquivo não foi capturada inteiramente pelo extrator (defeito, captura parcial não incluída)');
  lines.push('');
  if (missedByExtractor.length === 0) {
    lines.push('_Nenhum fato neste balde._');
  } else {
    lines.push('| mem_id | storage_key | token de amostra |');
    lines.push('|---|---|---|');
    for (const f of missedByExtractor) {
      lines.push(`| ${f.mem_id ? codeCell(f.mem_id) : '(sem mem_id)'} | ${f.storage_key ? codeCell(f.storage_key) : '(unidade desconhecida)'} | ${f.sample_token ? codeCell(f.sample_token) : '(nenhum)'} |`);
    }
  }
  lines.push('');

  lines.push('### Fatos sem menção reconhecida pelo vocabulário do extrator (parte desconhecida)');
  lines.push('');
  if (noFileMention.length === 0) {
    lines.push('_Nenhum fato neste balde._');
  } else {
    for (const f of noFileMention) lines.push(`- ${f.mem_id ? codeCell(f.mem_id) : '(sem mem_id)'} (${f.storage_key ? codeCell(f.storage_key) : '(unidade desconhecida)'})`);
  }
  lines.push('');

  // S06 R9: this legacy bucket is reconstituted EXACTLY by the two sections
  // above ((a) + (b)), so enumerating it again printed every no-citation fact
  // twice — 421 duplicated lines on the real store, in a report whose whole
  // purpose is legibility. The COUNT stays (it anchors the identity proof and
  // the "Antes" column of the diagnostic doc); only the listing is dropped.
  // The `facts_without_citation` FIELD is untouched in the JSON envelope.
  const withoutCitation = Array.isArray(coverage.facts_without_citation) ? coverage.facts_without_citation : [];
  lines.push('### Fatos sem nenhuma citação');
  lines.push('');
  lines.push(`- facts_without_citation: ${withoutCitation.length} — este balde é a soma exata de (a) + (b); a enumeração está nas duas seções acima e não é repetida aqui.`);
  lines.push('');

  lines.push('### Fragmentos ilegíveis');
  lines.push('');
  const unreadable = Array.isArray(coverage.unreadable_fragments) ? coverage.unreadable_fragments : [];
  if (unreadable.length === 0) {
    lines.push('_Nenhum fragmento ilegível._');
  } else {
    for (const u of unreadable) lines.push(`- ${codeCell(u.storageKey || u.path)} — ${prose(u.reason)}`);
  }
  lines.push('');

  lines.push('### Fragmentos descartados pelo store');
  lines.push('');
  const skipped = Array.isArray(coverage.fragments_skipped_by_store) ? coverage.fragments_skipped_by_store : [];
  if (skipped.length === 0) {
    lines.push('_Nenhum arquivo de `.gsd/memory/` foi descartado pelo store._');
  } else {
    lines.push(`⚠️ ${skipped.length} arquivo(s) em \`.gsd/memory/\` não foram devolvidos pelo store (nome não parseável como storage key). **Os fatos desses fragmentos estão AUSENTES deste índice.**`);
    lines.push('');
    lines.push('| arquivo |');
    lines.push('|---|');
    // Filenames are uncontrolled input — same table-cell escaping as R6.
    for (const name of skipped) lines.push(`| ${codeCell(name)} |`);
  }
  lines.push('');

  if (coverage.scan_capped) {
    lines.push('> ⚠️ A varredura de arquivos do repositório atingiu o limite (`scan_capped`) — a resolução de citações por basename pode estar incompleta.');
    lines.push('');
  }

  if (coverage.guard_unavailable) {
    lines.push('> ⚠️ O guard de schema não pôde ser carregado nesta execução — leitura degradou para `partial:false` sem checagem de direção.');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('_A extração de citações é heurística (regex sobre prosa livre). A seção acima é o contrato de honestidade do gerador: tudo que não pôde ser resolvido está listado, nunca omitido em silêncio._');

  return lines.join('\n') + '\n';
}

// ── writeIndex ────────────────────────────────────────────────────────────────
// Writes the rendered markdown to `opts.out` (resolved against cwd, contained
// under root via isWithin — same containment discipline as citation
// resolution). Returns { path, bytes, changed }; `changed:false` when the
// content on disk is already identical (same economy as
// forge-memory.js writeFragment's pre-write comparison).
function writeIndex(result, cwd, opts) {
  opts = opts || {};
  const root = path.resolve(cwd);
  const outRel = typeof opts.out === 'string' && opts.out ? opts.out : DEFAULT_INDEX_PATH;
  const outAbs = path.resolve(root, outRel);

  if (!isWithin(root, outAbs)) {
    throw new Error(`--out escapes cwd: ${outRel}`);
  }

  const md = renderIndex(result, opts);

  let unchanged = false;
  try {
    // The economy check compares CONTENT, so it must not be an end-of-line guard
    // by accident: on a checkout where the index on disk carries CRLF, a strict
    // `===` against the LF render reports `changed` every single call and rewrites
    // a file nothing changed in. Normalising both sides at this read keeps the
    // comparison about content and leaves the operator's bytes alone.
    const sameContent = (a, b) => a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');
    if (fs.existsSync(outAbs) && sameContent(fs.readFileSync(outAbs, 'utf8'), md)) unchanged = true;
  } catch (_) {
    unchanged = false;
  }

  if (!unchanged) {
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, md, 'utf8');
  }

  return { path: outAbs, bytes: Buffer.byteLength(md, 'utf8'), changed: !unchanged };
}

// ── normalizeQueryPath ──────────────────────────────────────────────────────────
// Same normalization for the requested path AND for entry.file (T01 must-have:
// "a normalização é a mesma para o pedido e para entry.file") — a single
// function, called on both sides at the comparison site, never two divergent
// implementations.
function normalizeQueryPath(p) {
  if (typeof p !== 'string') return '';
  let n = p.split('\\').join('/');
  if (n.startsWith('./')) n = n.slice(2);
  return n;
}

// ── queryIndex ────────────────────────────────────────────────────────────────
// Filters `result.entries` by one or more requested files. Exact match against
// entry.file (both sides normalized) first; if nothing matches, basename match
// (can match more than one entry — all are returned, per T01 step 5). Never a
// parallel counter: `matched`/`unmatched` are always derived by filtering the
// `requested` array itself (invariant 3 at the top of this file).
//
// The `reason` on each unmatched request is derived from the COMPLETENESS of the
// result, never from the mere fact that nothing matched (S03 R1). "Não achei
// fato" só é evidência de ausência quando o índice está completo; se a listagem
// de fragmentos falhou, ou se o resultado é parcial por schema à frente, a
// ausência NÃO é estabelecível e a razão tem de dizer isso — mesmo invariante
// que a correção de S02 R3 escreveu neste arquivo (um consumidor tem de
// distinguir "não consegui ler o store" de "o store está vazio") e a regra
// durável do repo: inconclusivo nunca colapsa em limpo.
function unmatchedReason(result) {
  const coverage = (result && result.coverage) || {};
  if (coverage.fragment_listing_failed) return 'index-unavailable';
  if (result && result.partial) return 'index-partial-no-match';
  return 'no-facts-for-file';
}

function queryIndex(result, files) {
  const entries = Array.isArray(result && result.entries) ? result.entries : [];
  const requested = Array.isArray(files) ? files : [];
  const reason = unmatchedReason(result);

  const byExact = new Map(); // normalized entry.file -> entry
  const byBasename = new Map(); // basename -> entries[]
  for (const entry of entries) {
    const norm = normalizeQueryPath(entry.file);
    byExact.set(norm, entry);
    const base = norm.split('/').pop();
    if (!byBasename.has(base)) byBasename.set(base, []);
    byBasename.get(base).push(entry);
  }

  const matched = [];
  const unmatched = [];

  for (const req of requested) {
    const normReq = normalizeQueryPath(req);
    const exact = byExact.get(normReq);
    if (exact) {
      matched.push({ requested: req, entries: [exact] });
      continue;
    }
    const base = normReq.split('/').pop();
    const byBase = byBasename.get(base);
    if (byBase && byBase.length > 0) {
      matched.push({ requested: req, entries: byBase.slice() });
      continue;
    }
    unmatched.push({ requested: req, reason });
  }

  return { requested, matched, unmatched };
}

// ── renderQuery ───────────────────────────────────────────────────────────────
// Short markdown for stdout: one `### <file>` per matched entry (fact lines via
// the SAME factLine helper renderIndex uses — never a second copy of the
// format), and an UNCONDITIONAL "## Arquivos sem fato" section enumerating the
// unmatched requests (same anti-silence floor as renderIndex's "Cobertura e
// descarte"). When the underlying result is partial/failed-listing, the top of
// the output carries the read-failure warning and the body does NOT claim
// absence of facts — same posture as renderIndex:718-724, not a second wording.
function renderQuery(result, query) {
  const coverage = (result && result.coverage) || {};
  const partial = !!(result && result.partial);
  const matched = (query && Array.isArray(query.matched)) ? query.matched : [];
  const unmatched = (query && Array.isArray(query.unmatched)) ? query.unmatched : [];

  const lines = [];

  lines.push('# Consulta ao índice de memória por arquivo-fonte');
  lines.push('');

  if (coverage.fragment_listing_failed) {
    lines.push(`> 🛑 **Não foi possível LER o store de memória** (\`fragment_listing_failed\`): ${prose(coverage.fragment_listing_failed)}`);
    lines.push('> Os arquivos abaixo listados como "sem fato" podem simplesmente não ter sido lidos — isto NÃO é evidência de ausência.');
    lines.push('');
  } else if (partial) {
    lines.push('> ⚠️ **Índice parcial** — o dado em `.gsd/SCHEMA-VERSION` está à frente da tooling local.');
    lines.push('> Esta consulta pode estar incompleta até a tooling ser atualizada (`/forge-update`).');
    lines.push('');
  }

  for (const m of matched) {
    for (const entry of m.entries) {
      lines.push(`### ${codeCell(entry.file)}`);
      lines.push('');
      for (const fact of entry.facts) {
        lines.push(factLine(fact));
      }
      lines.push('');
    }
  }

  lines.push('## Arquivos sem fato');
  lines.push('');
  if (unmatched.length === 0) {
    lines.push('_Todos os arquivos pedidos têm fato._');
  } else if (coverage.fragment_listing_failed) {
    lines.push('_O store não pôde ser lido — os arquivos abaixo NÃO foram confirmados como "sem fato", apenas não casaram com o índice (possivelmente vazio por falha de leitura):_');
    lines.push('');
    for (const u of unmatched) lines.push(`- ${codeCell(u.requested)} — ${cell(u.reason)}`);
  } else if (partial) {
    // Resultado parcial (schema à frente) — a ausência NÃO é estabelecível, então
    // o corpo não pode afirmar "o índice foi lido e nenhum fato cita" duas linhas
    // abaixo do aviso de leitura incompleta (S03 R1).
    lines.push('_O índice está INCOMPLETO — os arquivos abaixo NÃO foram confirmados como "sem fato", apenas não casaram com a porção do índice que a tooling local conseguiu ler:_');
    lines.push('');
    for (const u of unmatched) lines.push(`- ${codeCell(u.requested)} — ${cell(u.reason)}`);
  } else {
    lines.push('_O índice foi lido e nenhum fato cita estes arquivos:_');
    lines.push('');
    for (const u of unmatched) lines.push(`- ${codeCell(u.requested)} — ${cell(u.reason)}`);
  }
  lines.push('');

  return lines.join('\n') + '\n';
}

module.exports = {
  CITATION_REGEXES,
  CITATION_GAPS,
  detectIndependentMentions,
  independentMentionEvidence,
  classifyNoCitationFact,
  citationDetectionBreakdown,
  citationCoverageSummary,
  citationCoverageIsPrecise,
  citationCoverageGaps,
  citationGapCount,
  hasCitationCoverageIdentity,
  renderCitationGapLines,
  extractCitations,
  resolveCitation,
  listRepoFiles,
  summarizeFact,
  buildFileIndex,
  renderIndex,
  writeIndex,
  factLine,
  cell,
  codeCell,
  prose,
  normalizeQueryPath,
  queryIndex,
  renderQuery,
  buildUnitAxis,
  renderUnitAxis,
  DEFAULT_INDEX_PATH,
};

// ── CLI ──────────────────────────────────────────────────────────────────────
// node forge-memory-index.js [--write] [--json] [--out <path>] [--cwd <dir>]
// Molde: forge-symbol-check.js (argv manual, JSON de 1 linha em stdout,
// {error} em stderr, exits 0/1/2). Exit 2 rejeita args inválidos explicitamente
// (S01's guard CLI took a review objection precisely for accepting bad args).
function parseCliArgs(argv) {
  const KNOWN = new Set(['--write', '--json', '--out', '--cwd', '--file', '--unit', '--subject']);
  const out = { write: false, json: false, out: undefined, cwd: undefined, files: [], units: [], subjects: [], valid: true };
  // Uma opção que pede valor nunca consome a PRÓXIMA OPÇÃO como se fosse valor
  // (S03 R2): `--file --json` viraria consulta por um arquivo chamado `--json`,
  // engolindo em silêncio o modo pedido e devolvendo exit 0 com alegação falsa de
  // ausência. Valor ausente OU próximo token conhecido → args inválidos (exit 2).
  const takesValue = (arg, i) => {
    const next = argv[i + 1];
    if (next === undefined) return null;
    if (KNOWN.has(next)) return null;
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!KNOWN.has(arg)) { out.valid = false; return out; }
    if (arg === '--write') { out.write = true; continue; }
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--out' || arg === '--cwd' || arg === '--file' || arg === '--unit' || arg === '--subject') {
      const value = takesValue(arg, i);
      if (value === null) { out.valid = false; return out; }
      i++;
      if (arg === '--out') out.out = value;
      else if (arg === '--cwd') out.cwd = value;
      else if (arg === '--file') out.files.push(value);
      else if (arg === '--unit') out.units.push(value);
      else out.subjects.push(value);
      continue;
    }
  }
  // --write grava o índice COMPLETO em .gsd/MEMORY-INDEX-BY-FILE.md; escrever um
  // índice filtrado por cima do completo destruiria o artefato sem nenhum sinal
  // (T01 step 3) — recusado nos args, antes de qualquer leitura do store.
  if ((out.files.length > 0 || out.units.length > 0 || out.subjects.length > 0) && out.write === true) { out.valid = false; return out; }
  return out;
}

function runCli(argv) {
  const args = parseCliArgs(argv);
  if (!args.valid) {
    process.stderr.write(JSON.stringify({ error: 'Usage: forge-memory-index.js [--write] [--json] [--out <path>] [--cwd <dir>] [--file <path>]…' }) + '\n');
    return 2;
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
  const isQuery = args.files.length > 0 || args.units.length > 0 || args.subjects.length > 0;
  // Sem flag de saída explícita → default --write (step 6 do plano) — EXCETO em
  // modo consulta: `--file` sozinho nunca escreve (T01 step 4; sem isto, o
  // default implícito sobrescreveria o artefato completo com um índice filtrado
  // — a mesma armadilha que o guard de args do step 3 fecha, pelo outro lado).
  const doWrite = args.write || (!args.json && !isQuery);

  try {
    const result = buildFileIndex(cwd, {});

    if (isQuery) {
      if (args.subjects.length > 0) {
        const axis = buildSubjectAxis(result);
        if (args.json) process.stdout.write(JSON.stringify({ partial: result.partial, coverage: result.coverage, subject_axis: axis, subjects: args.subjects, out: null }) + '\n');
        else process.stdout.write(renderSubjectAxis(axis, { requested: args.subjects }));
        return 0;
      }
      if (args.units.length > 0) {
        const axis = buildUnitAxis(result);
        if (args.json) {
          process.stdout.write(JSON.stringify({
            partial: result.partial,
            counts: { facts_total: result.coverage.facts_total, facts_with_unit: axis.coverage.facts_with_unit },
            coverage: result.coverage,
            unit_axis: axis,
            units: args.units,
            out: null,
          }) + '\n');
        } else {
          process.stdout.write(renderUnitAxis(axis, { requested: args.units }));
        }
        return 0;
      }
      const query = queryIndex(result, args.files);

      if (args.json) {
        const envelope = {
          partial: result.partial,
          counts: {
            fragments_read: result.coverage.fragments_read,
            facts_total: result.coverage.facts_total,
            facts_with_resolved: result.coverage.facts_with_resolved,
            facts_no_file_mention: Array.isArray(result.coverage.facts_no_file_mention) ? result.coverage.facts_no_file_mention.length : 0,
            facts_missed_by_extractor: Array.isArray(result.coverage.facts_missed_by_extractor) ? result.coverage.facts_missed_by_extractor.length : 0,
            facts_unresolved_only: Array.isArray(result.coverage.facts_unresolved_only) ? result.coverage.facts_unresolved_only.length : 0,
            citations_total: result.coverage.citations_total,
            citations_resolved: result.coverage.citations_resolved,
          },
          coverage: result.coverage,
          files_indexed: result.coverage.files_indexed,
          query,
          out: null,
        };
        process.stdout.write(JSON.stringify(envelope) + '\n');
      } else {
        process.stdout.write(renderQuery(result, query));
      }

      return 0;
    }

    let writeInfo = null;
    if (doWrite) {
      writeInfo = writeIndex(result, cwd, { out: args.out });
    }

    if (args.json) {
      const envelope = {
        partial: result.partial,
        counts: {
          fragments_read: result.coverage.fragments_read,
          facts_total: result.coverage.facts_total,
          facts_with_resolved: result.coverage.facts_with_resolved,
          facts_no_file_mention: Array.isArray(result.coverage.facts_no_file_mention) ? result.coverage.facts_no_file_mention.length : 0,
          facts_missed_by_extractor: Array.isArray(result.coverage.facts_missed_by_extractor) ? result.coverage.facts_missed_by_extractor.length : 0,
          facts_unresolved_only: Array.isArray(result.coverage.facts_unresolved_only) ? result.coverage.facts_unresolved_only.length : 0,
          citations_total: result.coverage.citations_total,
          citations_resolved: result.coverage.citations_resolved,
        },
        coverage: result.coverage,
        files_indexed: result.coverage.files_indexed,
        out: writeInfo ? writeInfo.path : null,
      };
      process.stdout.write(JSON.stringify(envelope) + '\n');
    }

    return 0;
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err && err.message ? err.message : String(err) }) + '\n');
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = runCli(process.argv.slice(2));
}
