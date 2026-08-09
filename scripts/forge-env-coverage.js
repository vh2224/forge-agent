#!/usr/bin/env node
'use strict';

/**
 * forge-env-coverage.js — the canonical coverage verdict for each of the 5
 * `ENV_REASON_ENUM` reasons (M018 S06 / IN-14): what runtime source, if any,
 * can corroborate a sidecar's `scope: environment` claim for that reason.
 *
 * Why THREE classes and not "covered / not covered".
 * ---------------------------------------------------
 * A binary would put `sandbox-exec-blocked` and `git-commit-required` in the
 * same bucket, and they are not the same kind of thing:
 *
 *   - `promotable`    — the runtime CAN speak. A4 class (b), measured
 *                       2026-08-05: the command runs and the runtime emits an
 *                       `exitCode` (the negative control of A2 came back with
 *                       `exitCode: 6` / `Could not resolve host`). The claim is
 *                       corroborated by an OBSERVED exit code.
 *   - `measured-gap`  — the runtime CANNOT speak *today*, and that was measured,
 *                       not assumed. A4 class (c): the denial exists only as
 *                       prose in `agentMessage.text`, with ZERO
 *                       `commandExecution` items. Keeping the textual heuristic
 *                       here is D10/IN-14 being HONORED (revoking without
 *                       coverage is forbidden), not inertia — and it is
 *                       re-testable when `codex` upgrades.
 *   - `categorical`   — the runtime can NEVER speak, in any version. The
 *                       evidence would be the ABSENCE of an action: the git
 *                       write command is never executed, the `.gsd/**` write
 *                       never happens. No event stream witnesses absence.
 *
 * What breaks if someone collapses `measured-gap` into `categorical` (or vice
 * versa): the distinction between "a gap a codex upgrade can close" and "an
 * impossibility no upgrade can close" is lost, and the next codex release
 * becomes a pretext to reopen BOTH — including the two that can never be
 * corroborated. That is why the distinction is carried by an executable field
 * (`retestable_on_upgrade`) that a test asserts, and not by prose in a cell
 * (DP5 of S06-PLAN.md).
 *
 * Anti-silence floor (DP6): a reason without a declared verdict is a FAILURE of
 * the artifact naming that reason, never an empty cell; a table that parses
 * zero rows is a FAILURE, never "passed clean". Direct precedent: S07's
 * `pairs_compared === 0` is `inconclusive`, never `clean`, and
 * `forge-evidence-admit.js`'s `rows.length === 0` floor.
 */

// The list of 5 is IMPORTED, never re-typed. Same locked convention as
// forge-env-promote.js:9 ("The allowlist is deliberately imported from
// forge-xllm.js: do not copy it into docs/mirrors"). A second literal copy is
// the exact way a map and its enum drift while both look well-formed.
// Requiring is side-effect free — forge-xllm.js's CLI sits behind
// `require.main === module`.
const fs = require('fs');
const path = require('path');
const { ENV_REASON_ENUM } = require('./forge-xllm.js');

// ── Closed verdict vocabulary ──────────────────────────────────────────────
//
// Exactly three, declared once. A fourth must be DECLARED here, never
// improvised at a call site, so the doc table and the map cannot diverge in
// vocabulary while both parsing cleanly.
const COVERAGE_VERDICTS = Object.freeze({
  PROMOTABLE: 'promotable',
  MEASURED_GAP: 'measured-gap',
  CATEGORICAL: 'categorical',
});

const VERDICT_VALUES = Object.freeze(Object.values(COVERAGE_VERDICTS));

// `retestable_on_upgrade` is `null` — not `false` — for the two `promotable`
// reasons: they are already covered, so "would an upgrade reopen this?" does
// not apply. Coercing that n/a to `false` would put a covered reason in the
// same cell value as a categorical impossibility. Same posture as the locked
// comment on `exit_code: null` in forge-evidence-admit.js: `null` is an
// OBSERVED value ("not applicable"), never a synonym for `false`.
const REASON_COVERAGE = Object.freeze({
  'out-of-scope-test-failure': Object.freeze({
    verdict: COVERAGE_VERDICTS.PROMOTABLE,
    runtime_source: 'commandExecution.exitCode',
    retestable_on_upgrade: null,
    rationale: 'A4 classe (b): o runner roda e o runtime emite o exit code. Só a metade "o teste falhou" é promovida; "está fora do escopo do plano" continua vindo do check de path × planText (nenhum stream sabe o que o plano pedia).',
  }),
  'network-required': Object.freeze({
    verdict: COVERAGE_VERDICTS.PROMOTABLE,
    runtime_source: 'commandExecution.exitCode',
    retestable_on_upgrade: null,
    rationale: 'A4 classe (b): caso vivo medido — controle negativo de A2 com exitCode 6 / Could not resolve host.',
  }),
  'sandbox-exec-blocked': Object.freeze({
    verdict: COVERAGE_VERDICTS.MEASURED_GAP,
    runtime_source: 'nenhuma',
    retestable_on_upgrade: true,
    rationale: 'A4 classe (c) medida: a negação aparece só como prosa em agentMessage.text, com zero itens commandExecution. Manter a heurística textual aqui é o gate do D10/IN-14 sendo honrado, não inércia — e é re-testável num upgrade do codex.',
  }),
  'git-commit-required': Object.freeze({
    verdict: COVERAGE_VERDICTS.CATEGORICAL,
    runtime_source: 'nenhuma',
    retestable_on_upgrade: false,
    rationale: 'A evidência seria a ausência de uma ação: o comando de escrita git nunca é executado. Nenhum stream de eventos, em nenhuma versão, testemunha ausência. Não reabre com upgrade.',
  }),
  'gsd-write-refused': Object.freeze({
    verdict: COVERAGE_VERDICTS.CATEGORICAL,
    runtime_source: 'nenhuma',
    retestable_on_upgrade: false,
    rationale: 'Mesma classe: a escrita em .gsd/** nunca acontece. Reforçado pela TASK-020 R1 — uma suíte verde não toca .gsd/**, logo seu exit code não pode ser evidência disso.',
  }),
});

// ── Derived views (never a second literal list) ────────────────────────────
//
// DP1: the table drives the code. `promotableReasons()` is what T02 consumes to
// build its runtime-first set. Writing `['out-of-scope-test-failure',
// 'network-required']` a second time anywhere would make this map decoration:
// flipping a verdict here must change behaviour there.
function promotableReasons(coverage = REASON_COVERAGE) {
  return Object.keys(coverage).filter((r) => coverage[r].verdict === COVERAGE_VERDICTS.PROMOTABLE);
}

function coverageCounts(coverage = REASON_COVERAGE) {
  const counts = {};
  for (const verdict of VERDICT_VALUES) counts[verdict] = 0;
  for (const reason of Object.keys(coverage)) {
    const verdict = coverage[reason].verdict;
    counts[verdict] = (counts[verdict] || 0) + 1;
  }
  return counts;
}

// ── assertReasonCoverage ───────────────────────────────────────────────────
//
// Confronts the map's keys with ENV_REASON_ENUM in BOTH directions, throwing
// with the DIVERGENT NAMES — never a bare count. "expected 5, got 6" sends a
// reviewer on an archaeology trip; "unclassified in map: quantum-thing" does
// not. The literal 5 is never trusted without this confrontation.
function assertReasonCoverage(reasonEnum = ENV_REASON_ENUM, coverage = REASON_COVERAGE) {
  const names = Array.isArray(reasonEnum) ? reasonEnum : [];

  // Anti-silence floor: an empty enum means the import stopped working, not
  // that there are no reasons. Passing here would make every later comparison
  // vacuously agreeable — a coverage checker reporting "5 of 5" over nothing.
  if (names.length === 0) {
    const error = new Error('anti-silence floor: ENV_REASON_ENUM yielded 0 reasons');
    error.code = 'REASON_ENUM_EMPTY';
    throw error;
  }

  // S06 review R2. Every comparison below is SET-based, so a duplicated member
  // passes coverage in both directions while `enum_size` (which counts the raw
  // array) and the reason count disagree — the enum says 6 reasons exist, the
  // map classifies 5, and nothing objects. Inert as measured today (5 entries, 5
  // unique), which is exactly when it is cheap to close. Same class and same
  // treatment as the duplicate ThreadItem discriminator in
  // forge-evidence-admit.js:pinVariantNames — name the repeats, never a count.
  const seen = new Set();
  const duplicates = [];
  for (const name of names) {
    if (seen.has(name)) { if (!duplicates.includes(name)) duplicates.push(name); }
    else seen.add(name);
  }
  if (duplicates.length > 0) {
    const error = new Error(
      `ENV_REASON_ENUM is internally inconsistent: duplicate reason(s): ${duplicates.join(', ')}`
    );
    error.code = 'REASON_ENUM_DUPLICATE';
    error.duplicates = duplicates;
    throw error;
  }

  const enumSet = new Set(names);
  const mapNames = Object.keys(coverage);
  const mapSet = new Set(mapNames);

  const missingInMap = names.filter((n) => !mapSet.has(n));
  const missingInEnum = mapNames.filter((n) => !enumSet.has(n));

  if (missingInMap.length > 0 || missingInEnum.length > 0) {
    const parts = [];
    if (missingInMap.length > 0) parts.push(`unclassified in map: ${missingInMap.join(', ')}`);
    if (missingInEnum.length > 0) parts.push(`absent from ENV_REASON_ENUM: ${missingInEnum.join(', ')}`);
    const error = new Error(`environment reason coverage diverges — ${parts.join('; ')}`);
    error.code = 'REASON_COVERAGE_DIVERGED';
    error.missingInMap = missingInMap;
    error.missingInEnum = missingInEnum;
    throw error;
  }

  // Each entry must carry a verdict from the closed vocabulary AND a non-empty
  // rationale. A verdict without a stated reason is the omission DP6 forbids —
  // caught here so it can never reach the doc table looking well-formed.
  for (const reason of mapNames) {
    const entry = coverage[reason];
    if (!VERDICT_VALUES.includes(entry.verdict)) {
      const error = new Error(`'${reason}' has verdict '${entry.verdict}' outside the closed vocabulary (${VERDICT_VALUES.join(', ')})`);
      error.code = 'UNKNOWN_VERDICT';
      throw error;
    }
    if (typeof entry.rationale !== 'string' || entry.rationale.trim().length === 0) {
      const error = new Error(`'${reason}' has an empty rationale`);
      error.code = 'MISSING_RATIONALE';
      throw error;
    }
    // The non-collapse is enforced structurally, not just documented: a
    // `measured-gap` MUST be re-testable and a `categorical` MUST NOT be. If a
    // future edit flips one of these, this throws instead of silently merging
    // "a gap an upgrade can close" with "an impossibility no upgrade closes".
    const expected = entry.verdict === COVERAGE_VERDICTS.MEASURED_GAP
      ? true
      : (entry.verdict === COVERAGE_VERDICTS.CATEGORICAL ? false : null);
    if (entry.retestable_on_upgrade !== expected) {
      const error = new Error(
        `'${reason}' is ${entry.verdict} but retestable_on_upgrade=${JSON.stringify(entry.retestable_on_upgrade)} (expected ${JSON.stringify(expected)}) — the three classes must not collapse`
      );
      error.code = 'CLASS_COLLAPSE';
      throw error;
    }
  }

  return {
    ok: true,
    reasons: mapNames.length,
    enum_size: names.length,
    counts: coverageCounts(coverage),
    verdicts: mapNames.reduce((acc, r) => { acc[r] = coverage[r].verdict; return acc; }, {}),
  };
}

// ── checkDocTable ──────────────────────────────────────────────────────────
//
// Parses the markdown table under `## Cobertura por reason (IN-14)` and
// confronts it with the map: reason set, verdict per reason, re-testability
// per reason, and non-empty runtime-source/rationale cells. In-process, `fs`
// only, never a shell-out — the mold is forge-evidence-admit.js:508, whose own
// ancestor defect (forge-doc-claims) was a `grep` that honored `.gitignore` and
// therefore never saw the file it policed.
//
// The signature takes MARKDOWN AS A STRING, not a path: that is what lets the
// paired suite and the smoke prove bite on a fixture without depending on
// `.gsd/` — which the CODE_DIR worktree does not have (measured: ENOENT).
const DOC_SECTION_HEADING = '## Cobertura por reason (IN-14)';

function normalizeCell(cell) {
  return String(cell == null ? '' : cell).replace(/[`*]/g, '').trim();
}

function normalizeVerdict(cell) {
  const text = normalizeCell(cell).toLowerCase();
  if (text.length === 0) return { state: 'empty', value: null };
  if (VERDICT_VALUES.includes(text)) return { state: 'ok', value: text };
  return { state: 'unknown', value: text };
}

function normalizeRetestable(cell) {
  const text = normalizeCell(cell).toLowerCase();
  if (text.length === 0) return { state: 'empty', value: null };
  if (text === 'true' || text === 'sim') return { state: 'ok', value: true };
  if (text === 'false' || text === 'nao' || text === 'não') return { state: 'ok', value: false };
  // "n/a (coberto)" and friends: not applicable because the reason is already
  // covered. Mapped to null, never to false — see the REASON_COVERAGE comment.
  if (text.startsWith('n/a')) return { state: 'ok', value: null };
  return { state: 'unknown', value: text };
}

function parseDocRows(markdown) {
  const lines = String(markdown == null ? '' : markdown).split('\n');
  const rows = [];
  let inSection = false;

  for (const line of lines) {
    if (line.startsWith('## ')) {
      inSection = line.trim() === DOC_SECTION_HEADING;
      continue;
    }
    if (!inSection) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;

    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    // Two cells is enough to be a row under audit. Requiring all five would
    // turn a row whose cells were DELETED (not emptied) into silence — the
    // exact failure mode this checker exists to catch. Missing cells are read
    // as empty below and reported by name.
    if (cells.length < 2) continue;
    if (/^:?-{2,}:?$/.test(cells[0])) continue; // separator row
    const first = normalizeCell(cells[0]).toLowerCase();
    if (first === 'reason' || first === 'razao' || first === 'razão') continue; // header

    rows.push({
      reason: normalizeCell(cells[0]),
      verdict: cells[1],
      runtime_source: cells[2],
      retestable: cells[3],
      rationale: cells[4],
    });
  }
  return rows;
}

function checkDocTable(markdown, coverage = REASON_COVERAGE) {
  const rows = parseDocRows(markdown);
  const problems = [];

  // Anti-silence floor (DP6), same shape as forge-evidence-admit.js:515 and
  // forge-doc-claims' `scanned === 0`: parsing nothing is a FAILURE. A doc
  // checker that reports "clean" after reading zero rows is indistinguishable
  // from a broken detector — the origin defect of this whole milestone.
  if (rows.length === 0) {
    return {
      ok: false,
      parsed: 0,
      problems: [{ kind: 'anti-silence', detail: `no table rows parsed under "${DOC_SECTION_HEADING}"` }],
      reason: `anti-silence floor: 0 rows parsed under "${DOC_SECTION_HEADING}"`,
    };
  }

  const seen = new Map();
  for (const row of rows) {
    if (seen.has(row.reason)) {
      problems.push({ kind: 'duplicate', reason: row.reason, detail: `reason '${row.reason}' listed more than once` });
      continue;
    }
    seen.set(row.reason, row);

    const entry = Object.prototype.hasOwnProperty.call(coverage, row.reason) ? coverage[row.reason] : null;
    if (!entry) {
      problems.push({ kind: 'unknown-reason', reason: row.reason, detail: `'${row.reason}' is not one of the classified ENV_REASON_ENUM reasons` });
      continue;
    }

    const verdict = normalizeVerdict(row.verdict);
    if (verdict.state === 'empty') {
      // The erased-cell case, reported BY NAME: a blank verdict must never be
      // read as agreement with the map.
      problems.push({ kind: 'missing-verdict', reason: row.reason, detail: `'${row.reason}' has an empty verdict cell` });
    } else if (verdict.state === 'unknown') {
      problems.push({ kind: 'unknown-verdict', reason: row.reason, detail: `'${row.reason}' has verdict '${verdict.value}' outside the closed vocabulary (${VERDICT_VALUES.join(', ')})` });
    } else if (verdict.value !== entry.verdict) {
      problems.push({ kind: 'verdict-mismatch', reason: row.reason, detail: `'${row.reason}' is documented '${verdict.value}' but the map says '${entry.verdict}'` });
    }

    const retestable = normalizeRetestable(row.retestable);
    if (retestable.state === 'empty') {
      problems.push({ kind: 'missing-retestable', reason: row.reason, detail: `'${row.reason}' has an empty re-testable cell` });
    } else if (retestable.state === 'unknown') {
      problems.push({ kind: 'unknown-retestable', reason: row.reason, detail: `'${row.reason}' has an unreadable re-testable value '${retestable.value}'` });
    } else if (retestable.value !== entry.retestable_on_upgrade) {
      // This is where a doc-side collapse of measured-gap into categorical
      // gets caught: the column carries the distinction, so flipping it in
      // prose fails here instead of quietly rewriting the classification.
      problems.push({
        kind: 'retestable-mismatch', reason: row.reason,
        detail: `'${row.reason}' documents retestable=${JSON.stringify(retestable.value)} but the map says ${JSON.stringify(entry.retestable_on_upgrade)}`,
      });
    }

    // S06 review R4/R1: the runtime-source cell is the column that carries the
    // WHOLE distinction this table exists to state ("which runtime source, if
    // any, can speak for this reason"). Checking it only for non-emptiness made
    // it the one column nothing confronts: a doc claiming `agentMessage.text`
    // against the map's `commandExecution.exitCode` passed --check-doc clean.
    // Presence-only on the column that carries the claim is the milestone's own
    // origin defect in miniature, so the VALUE is compared, case-insensitively
    // (cell decoration is stripped by normalizeCell; the map's values are
    // identifiers, not prose).
    const docSource = normalizeCell(row.runtime_source);
    if (docSource.length === 0) {
      problems.push({ kind: 'missing-runtime-source', reason: row.reason, detail: `'${row.reason}' has an empty runtime-source cell` });
    } else if (docSource.toLowerCase() !== String(entry.runtime_source).trim().toLowerCase()) {
      problems.push({
        kind: 'runtime-source-mismatch', reason: row.reason,
        detail: `'${row.reason}' documents runtime source '${docSource}' but the map says '${entry.runtime_source}'`,
      });
    }
    // "Nenhuma célula vazia" (DP6): a row stating a verdict without a reason is
    // the omission the milestone forbids.
    if (normalizeCell(row.rationale).length === 0) {
      problems.push({ kind: 'missing-rationale', reason: row.reason, detail: `'${row.reason}' has an empty rationale cell` });
    }
  }

  for (const reason of Object.keys(coverage)) {
    if (!seen.has(reason)) {
      problems.push({ kind: 'missing-row', reason, detail: `'${reason}' is classified in the map but absent from the table` });
    }
  }

  return {
    ok: problems.length === 0,
    parsed: rows.length,
    problems,
    reason: problems.length === 0 ? 'clean' : `${problems.length} table divergence(s)`,
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const USAGE = `forge-env-coverage.js — coverage verdict per ENV_REASON_ENUM reason (M018 S06 / IN-14)

  --check-enum            confront REASON_COVERAGE with ENV_REASON_ENUM (both directions)
  --check-doc <file>      confront a markdown file's IN-14 table with the map
  --json                  machine-readable output
  --help                  this text

exit 0 = ok, 1 = problems found, 2 = usage/IO error
`;

function parseArgs(argv) {
  const out = { mode: null, json: false, doc: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // Contradictory modes are REJECTED, never resolved by "last wins": a caller
    // that passes both asked for two checks and silently got one, and the exit
    // code it reads back names neither. Same posture as forge-evidence-admit.
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--check-enum') {
      if (out.mode && out.mode !== 'enum') return { error: '--check-enum and --check-doc are mutually exclusive' };
      out.mode = 'enum';
    } else if (arg === '--check-doc') {
      if (out.mode && out.mode !== 'doc') return { error: '--check-enum and --check-doc are mutually exclusive' };
      out.mode = 'doc';
      const value = argv[i + 1];
      // The path is EXPLICIT, by argv. Deriving `.gsd/` from cwd or walking up
      // is forbidden: the CODE_DIR worktree has no `.gsd/` (measured ENOENT),
      // and walk-up would silently check some other milestone's file — the
      // lesson of TASK-020's chained --gsd-dir.
      if (!value || value.startsWith('--')) return { error: '--check-doc requires a markdown file path' };
      out.doc = value;
      i += 1;
    } else if (arg === '--json') out.json = true;
    else return { error: `unknown argument: ${arg}` };
  }
  if (!out.help && !out.mode) return { error: 'one of --check-enum or --check-doc <file> is required' };
  return out;
}

function main() {
  // Arg guards run before any I/O: exit 2 is reserved for "you called me
  // wrong", so a caller can tell it apart from exit 1, "what I checked is wrong".
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    process.stderr.write(`forge-env-coverage: ${args.error}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  if (args.mode === 'enum') {
    let result;
    try {
      result = assertReasonCoverage();
    } catch (error) {
      const payload = {
        ok: false,
        error: error.message,
        code: error.code || 'COVERAGE_UNCHECKABLE',
        missing_in_map: error.missingInMap || [],
        missing_in_enum: error.missingInEnum || [],
      };
      if (args.json) process.stdout.write(`${JSON.stringify(payload)}\n`);
      process.stderr.write(`forge-env-coverage: ${error.message}\n`);
      process.exit(1);
    }
    if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(`ok: ${result.reasons} of ${result.enum_size} ENV_REASON_ENUM reasons carry a verdict\n`);
      for (const verdict of VERDICT_VALUES) process.stdout.write(`  ${verdict}: ${result.counts[verdict]}\n`);
    }
    process.exit(0);
  }

  // args.mode === 'doc'
  let markdown;
  try {
    markdown = fs.readFileSync(path.resolve(args.doc), 'utf8');
  } catch (error) {
    process.stderr.write(`forge-env-coverage: cannot read ${args.doc}: ${error.message}\n`);
    process.exit(2);
  }
  const result = checkDocTable(markdown);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ...result, doc: args.doc })}\n`);
  } else {
    process.stdout.write(`parsed: ${result.parsed} rows\n`);
    for (const problem of result.problems) process.stdout.write(`  [${problem.kind}] ${problem.detail}\n`);
    process.stdout.write(`${result.ok ? 'clean' : `FAIL: ${result.reason}`}\n`);
  }
  if (!result.ok) process.stderr.write(`forge-env-coverage: ${result.reason}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) main();

module.exports = {
  COVERAGE_VERDICTS,
  VERDICT_VALUES,
  REASON_COVERAGE,
  DOC_SECTION_HEADING,
  promotableReasons,
  coverageCounts,
  assertReasonCoverage,
  parseDocRows,
  checkDocTable,
};
