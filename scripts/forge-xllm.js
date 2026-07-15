#!/usr/bin/env node
/**
 * forge-xllm.js — zero-dep sidecar adapter for `codex exec`.
 *   • challenge / rebuttal : GPT review challenger/rebuttal (read-only sandbox, spawnSync).
 *   • execute              : run a T##-PLAN.md via codex under workspace-write, detached,
 *                            with heartbeat + process-group timeout, result-file only.
 *
 * Exports:
 *   runChallenge(opts)         → { objections: [...] }   (or throws)
 *   runRebuttal(opts)          → { verdicts: [...] }      (or throws)
 *   runExecute(opts)           → Promise<result object>   (or rejects) — writes result-file
 *   extractLastJsonBlock(text) → object|array|null
 *   validateObjections(obj)    → boolean
 *   validateVerdicts(obj)      → boolean
 *   validateExecuteResult(obj) → boolean
 *   deriveFilesChanged(cwd)    → [{status, path}]  (git READ-ONLY)
 *   readWorkersTimeout(dir)    → number|null       (prefs cascade)
 *
 * CLI usage:
 *   node scripts/forge-xllm.js --mode challenge --diff-cmd "git diff" [--model <id>] [--timeout 300] [--cwd <dir>]
 *   node scripts/forge-xllm.js --mode rebuttal --input <file> [--model <id>] [--timeout 300] [--cwd <dir>]
 *   node scripts/forge-xllm.js --mode execute --plan <T##-PLAN.md> --result-file <path> --cwd <repo> [--model <id>] [--timeout <secs>]
 *
 * Exit contract: 0 on success. For challenge/rebuttal the normalized JSON goes to stdout
 * (nothing else on stdout). For execute the result-file is the ONLY result channel —
 * stdout stays empty (LOCKED — M005-CONTEXT). ANY failure (bad args, missing binary,
 * non-zero exit, timeout, unparseable/invalid output, dirty tree, HEAD moved) →
 * process.exit(2), cause on stderr. NO RETRY on any path (LOCKED — S01-RISK.md blocker #4).
 * The orchestrator owns fallback behavior, not this adapter.
 *
 * Execute-mode contract (LOCKED — M005-CONTEXT / S01):
 *  - START_SHA ownership: the CALLER captures its own START_SHA BEFORE invoking the
 *    adapter and OWNS the post-failure reset (`git checkout {START_SHA} -- . && git
 *    clean -fd`, done in S02). The adapter exposes `start_sha` in the result JSON for
 *    audit ONLY — it NEVER resets, cleans, checks out, commits, or runs ANY git write.
 *  - no-commit invariant: if codex moves HEAD (commits) despite the prompt prohibition,
 *    the adapter detects HEAD ≠ START_SHA post-run and exits 2.
 *  - no-.gsd/ invariant: the prompt forbids touching `.gsd/**`; if derived changes still
 *    touch `.gsd/`, the adapter emits a stderr WARNING (advisory) — the orchestrator's
 *    file audit is the real safety net (S02).
 *  - workspace network is DISABLED under workspace-write: execute tasks must be
 *    self-contained (no installs / no network fetches). Documented limitation.
 *  - `--plan` / `--result-file` come SOLELY from the orchestrator (same trust class as
 *    `--diff-cmd`) — never from codex output or any untrusted source.
 *
 * Security notes:
 *  - `codex` is invoked EXCLUSIVELY via array args (spawnSync / spawn) — never shell:true.
 *  - `--diff-cmd` IS executed via execSync({shell:true}) because it legitimately needs
 *    pipes/redirection. This value must come ONLY from the orchestrator — never from
 *    codex output, --input file content, or any other untrusted source.
 *  - execute git introspection (status/diff/rev-parse) runs read-only via execSync with
 *    fixed args (no untrusted interpolation) — never a git write.
 *  - codex output is untrusted model output: parsed via JSON.parse only (never eval /
 *    new Function / dynamic require), then hand-validated field-by-field. --output-schema
 *    is a HINT, not a contract (codex#15451) — model-family guards can silently drop it
 *    (codex#4181), so we never assume the schema was honored.
 *  - Prompt-injection via the embedded diff/plan/objections text is a known, accepted
 *    limitation: output is strictly validated and verification is downstream — no attempt
 *    is made to "sanitize" the embedded text itself (mold M004).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn, execSync } = require('child_process');

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECS = 300;
const DEFAULT_EXECUTE_TIMEOUT_SECS = 1800; // 30 min — execute default (workers.timeout override)
const HEARTBEAT_INTERVAL_MS = 15000; // re-write the running heartbeat every 15s
const MAX_DIFF_LINES = 4000;
const MAX_BUFFER = 16 * 1024 * 1024; // 16MB — guards against runaway output (local DoS)
const MAX_STDERR_SNIPPET = 200; // only the tail of child stderr surfaces in an error cause
const SEVERITY_ENUM = ['critical', 'high', 'medium', 'low'];
const VERDICT_ENUM = ['maintained', 'withdrawn'];
const EXEC_STATUS_ENUM = ['done', 'partial', 'blocked'];
const MH_STATUS_ENUM = ['met', 'unmet', 'unknown'];

// Duplicated from shared/forge-review.md engine workflow script (challengeSchema).
// keep in sync with shared/forge-review.md
const challengeSchema = {
  type: 'object',
  required: ['objections'],
  additionalProperties: false,
  properties: {
    objections: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'path_line', 'claim', 'suggested_fix', 'challenge', 'severity'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Stable id R1, R2, ... severity-then-order' },
          path_line: { type: 'string' },
          claim: { type: 'string', description: 'Full text of the issue' },
          suggested_fix: { type: 'string' },
          challenge: { type: 'string', description: 'The one question that decides whether this is real' },
          severity: { type: 'string', enum: SEVERITY_ENUM },
        },
      },
    },
  },
};

// Duplicated from shared/forge-review.md engine workflow script (verdictSchema).
// keep in sync with shared/forge-review.md
function verdictSchema(allowed) {
  return {
    type: 'object',
    required: ['verdicts'],
    additionalProperties: false,
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'verdict', 'rationale'],
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            verdict: { type: 'string', enum: allowed },
            rationale: { type: 'string' },
          },
        },
      },
    },
  };
}

// Output schema HINT for execute mode (codex#15451/#4181 — a hint, not a contract;
// the real gate is validateExecuteResult below). additionalProperties:false at EVERY
// level (M004 UAT lesson — OpenAI returns 400 otherwise).
const executeSchema = {
  type: 'object',
  required: ['status', 'summary', 'must_haves_status', 'files_changed'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: EXEC_STATUS_ENUM },
    summary: { type: 'string' },
    must_haves_status: {
      type: 'array',
      items: {
        type: 'object',
        required: ['item', 'status', 'note'],
        additionalProperties: false,
        properties: {
          item: { type: 'string' },
          status: { type: 'string', enum: MH_STATUS_ENUM },
          note: { type: 'string' },
        },
      },
    },
    files_changed: { type: 'array', items: { type: 'string' } },
  },
};

// Output schema HINT for plan mode (same caveat as executeSchema — a hint, not a
// contract; the real gate is validatePlanResult + the in-sidecar must_haves check
// below). additionalProperties:false at EVERY level (OpenAI 400 otherwise — MEM).
// codex returns the full markdown CONTENT of each plan file; the orchestrator (T02/T03)
// materializes them under .gsd/. codex itself NEVER touches .gsd/ (read-only sandbox).
const planSchema = {
  type: 'object',
  required: ['status', 'summary', 'slice_plan', 'task_plans'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: EXEC_STATUS_ENUM },
    summary: { type: 'string' },
    slice_plan: {
      type: 'object',
      required: ['filename', 'content'],
      additionalProperties: false,
      properties: {
        filename: { type: 'string' },
        content: { type: 'string' },
      },
    },
    task_plans: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'filename', 'content'],
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          filename: { type: 'string' },
          content: { type: 'string' },
        },
      },
    },
  },
};

// ── Argument parsing ─────────────────────────────────────────────────────────

/**
 * Parse --kebab-case flags from argv (value = next argv token).
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

// ── Diff acquisition ──────────────────────────────────────────────────────────

/**
 * Run the orchestrator-supplied diff command and return its (possibly truncated) output.
 * diffCmd is trusted orchestrator input ONLY — never accept it from model output or files.
 * @param {string} diffCmd
 * @param {string} cwd
 * @returns {string}
 */
function acquireDiff(diffCmd, cwd) {
  let out = '';
  try {
    out = execSync(diffCmd, { cwd, shell: true, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  } catch (e) {
    // Command may exit non-zero on some diff tools (e.g. git diff --exit-code) —
    // treat stdout captured so far as best-effort; empty diff is a valid outcome.
    out = (e && e.stdout) ? String(e.stdout) : '';
  }
  const lines = out.split('\n');
  if (lines.length > MAX_DIFF_LINES) {
    return lines.slice(0, MAX_DIFF_LINES).join('\n') + '\n[diff truncated at 4000 lines]\n';
  }
  return out;
}

// ── Defensive JSON extraction ─────────────────────────────────────────────────

/**
 * Scan text for the LAST balanced JSON block ({...} or [...]) that JSON.parse succeeds on.
 * Never trusts --output-schema conformance — this is the defensive parse path.
 * @param {string} text
 * @returns {object|Array|null}
 */
function extractLastJsonBlock(text) {
  if (typeof text !== 'string' || !text.length) return null;

  let best = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') continue;
    const open = ch;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (c === '\\') {
          escaped = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          try {
            const parsed = JSON.parse(candidate);
            best = parsed; // keep overwriting — last valid top-level block wins
          } catch (e) {
            // not valid JSON — ignore this candidate
          }
          // Skip past this balanced block so nested brackets inside it are never
          // rescanned as separate (spurious) top-level candidates.
          i = j;
          break;
        }
      }
    }
  }

  return best;
}

// ── Hand-rolled validation ────────────────────────────────────────────────────

/**
 * Validate a parsed challenge response. ANY deviation → invalid (return false).
 * @param {*} obj
 * @returns {boolean}
 */
function validateObjections(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.objections)) return false;
  for (const item of obj.objections) {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.id !== 'string' || !item.id) return false;
    if (typeof item.path_line !== 'string') return false;
    if (typeof item.claim !== 'string') return false;
    if (typeof item.suggested_fix !== 'string') return false;
    if (typeof item.challenge !== 'string') return false;
    if (!SEVERITY_ENUM.includes(item.severity)) return false;
  }
  return true;
}

/**
 * Validate a parsed rebuttal response. ANY deviation → invalid (return false).
 * @param {*} obj
 * @returns {boolean}
 */
function validateVerdicts(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.verdicts)) return false;
  for (const item of obj.verdicts) {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.id !== 'string' || !item.id) return false;
    if (!VERDICT_ENUM.includes(item.verdict)) return false;
    if (typeof item.rationale !== 'string') return false;
  }
  return true;
}

/**
 * Validate a parsed execute response from codex. ANY deviation → invalid (return false).
 * @param {*} obj
 * @returns {boolean}
 */
function validateExecuteResult(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!EXEC_STATUS_ENUM.includes(obj.status)) return false;
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) return false;
  if (!Array.isArray(obj.must_haves_status)) return false;
  for (const item of obj.must_haves_status) {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.item !== 'string') return false;
    if (!MH_STATUS_ENUM.includes(item.status)) return false;
    if (typeof item.note !== 'string') return false;
  }
  if (!Array.isArray(obj.files_changed)) return false;
  for (const f of obj.files_changed) {
    if (typeof f !== 'string') return false;
  }
  return true;
}

/**
 * Validate a parsed plan response from codex. ANY deviation → invalid (return false).
 * Field-by-field — the --output-schema is a hint, never trusted (codex#15451/#4181).
 * The must_haves content of each task_plan is validated separately, in-sidecar, via
 * forge-must-haves.js (see runPlan) — this only checks the transport shape.
 * @param {*} obj
 * @returns {boolean}
 */
function validatePlanResult(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (!EXEC_STATUS_ENUM.includes(obj.status)) return false;
  if (typeof obj.summary !== 'string' || !obj.summary.trim()) return false;
  const sp = obj.slice_plan;
  if (!sp || typeof sp !== 'object' || Array.isArray(sp)) return false;
  if (typeof sp.filename !== 'string' || !sp.filename.trim()) return false;
  if (typeof sp.content !== 'string' || !sp.content.trim()) return false;
  if (!Array.isArray(obj.task_plans)) return false;
  // 1–7 tasks per slice (iron rule: each task fits one context window).
  if (obj.task_plans.length < 1 || obj.task_plans.length > 7) return false;
  for (const tp of obj.task_plans) {
    if (!tp || typeof tp !== 'object' || Array.isArray(tp)) return false;
    if (typeof tp.id !== 'string' || !tp.id.trim()) return false;
    if (typeof tp.filename !== 'string' || !tp.filename.trim()) return false;
    if (typeof tp.content !== 'string' || !tp.content.trim()) return false;
    // Path-traversal guard: id/filename are UNTRUSTED codex output that Branch D
    // concatenates into a filesystem path with mkdir -p. Reject anything that
    // isn't a bare task id (T + digits) or a plain .md basename — no `/`, no `\`,
    // no `..`. This validator is the gate; the orchestrator re-derives the path
    // from the validated id alone (see shared/forge-dispatch.md § Branch D).
    if (!/^T\d+$/.test(tp.id)) return false;
    if (!/^[A-Za-z0-9._-]+\.md$/.test(tp.filename)) return false;
  }
  return true;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildChallengePrompt(diffText) {
  return [
    'You are an adversarial senior code reviewer. Review the diff below and return',
    'structured findings only. Assign each finding a stable id (R1, R2, ... in',
    'severity-then-order sequence). For each finding include: id, path_line',
    '("path:line"), claim (full issue text), suggested_fix, challenge (the one',
    'question that decides whether this is real), severity (critical|high|medium|low).',
    '',
    'Respond with ONLY a single JSON object of the exact shape:',
    '{ "objections": [ { "id", "path_line", "claim", "suggested_fix", "challenge", "severity" } ] }',
    'No prose outside the JSON. Empty objections array is a valid outcome if the diff has no issues.',
    '',
    '--- DIFF START ---',
    diffText,
    '--- DIFF END ---',
  ].join('\n');
}

function buildRebuttalPrompt(inputText) {
  return [
    'You are re-litigating your own prior review objections after seeing the author\'s',
    'defense. For each objection, decide ONLY "maintained" (defense did not hold) or',
    '"withdrawn" (defense holds). No other verdict values are allowed.',
    '',
    'Respond with ONLY a single JSON object of the exact shape:',
    '{ "verdicts": [ { "id", "verdict": "maintained"|"withdrawn", "rationale" } ] }',
    'No prose outside the JSON.',
    '',
    '--- OBJECTIONS + DEFENSES START ---',
    inputText,
    '--- OBJECTIONS + DEFENSES END ---',
  ].join('\n');
}

function buildExecutePrompt(planText) {
  return [
    'You are a senior software engineer executing a single, fully-specified task plan.',
    'The task plan (a T##-PLAN.md) is embedded verbatim below between delimiters.',
    '',
    'Your job:',
    ' 1. Implement the plan\'s Steps completely.',
    ' 2. Treat the `must_haves` (truths / artifacts / key_links) as a VERIFIABLE',
    '    CONTRACT — every truth must hold, every artifact must exist and be substantive',
    '    and wired, every key_link must be real.',
    ' 3. Treat the plan\'s `## Standards` section as MANDATORY (directory placement,',
    '    naming, reuse, lint expectations).',
    '',
    'HARD PROHIBITIONS (violating any of these fails the task):',
    ' (a) NEVER run any `git` command — no commit, no add, no checkout, no clean, no reset,',
    '     no stash. Leave version control entirely alone.',
    ' (b) NEVER create or modify anything under `.gsd/` — that tree belongs to the',
    '     orchestrator, not to you.',
    ' (c) NEVER write outside the working directory you were started in.',
    ' (d) The network is DISABLED — the task must be self-contained. Do not attempt any',
    '     install, fetch, clone, or other network access.',
    '',
    'When you are done, respond with ONLY a single JSON object of this exact shape',
    '(no prose before or after the JSON):',
    '{',
    '  "status": "done" | "partial" | "blocked",',
    '  "summary": "<one-paragraph description of what you did>",',
    '  "must_haves_status": [ { "item": "<must-have text>", "status": "met"|"unmet"|"unknown", "note": "<evidence or reason>" } ],',
    '  "files_changed": [ "<relative path>", ... ]',
    '}',
    'Rules for the JSON: files_changed lists the relative paths you created or modified;',
    'must_haves_status has one entry per must_have in the plan.',
    '',
    '--- TASK PLAN START ---',
    planText,
    '--- TASK PLAN END ---',
  ].join('\n');
}

function buildPlanPrompt(contextText) {
  return [
    'You are a senior software planner decomposing ONE slice of work into an executable',
    'plan. The planning context (goal, decisions, research, standards, acceptance criteria)',
    'is embedded verbatim below between delimiters. You may READ the codebase to reason,',
    'but you must NOT change anything.',
    '',
    'Your job:',
    ' 1. Decompose the slice into 1–7 tasks. Each task must fit in a single context window',
    '    and own its files (one-owner-per-file across tasks).',
    ' 2. Produce ONE slice plan file (S##-PLAN.md) and ONE task plan file (T##-PLAN.md)',
    '    per task. Return the FULL markdown content of every file — you write NOTHING to',
    '    disk; the orchestrator materializes your output.',
    ' 3. Every T##-PLAN.md MUST carry a YAML frontmatter block with this exact structured',
    '    schema (the executor enforces it — a missing or malformed block fails the task):',
    '      must_haves:',
    '        truths: [ "<observable truth that must hold>", ... ]',
    '        artifacts:',
    '          - path: "<relative path>"',
    '            provides: "<what this file provides>"',
    '            min_lines: <integer>',
    '            stub_patterns: [ "<optional regex to reject stubs>", ... ]',
    '        key_links:',
    '          - from: "<path>"',
    '            to: "<path>"',
    '            via: "<how they connect — import/call/require>"',
    '      expected_output: [ "<relative path the task writes>", ... ]',
    '      depends: [ "<task id this depends on>", ... ]',
    '      writes: [ "<relative path this task owns>", ... ]',
    '    (artifacts[].min_lines is REQUIRED and must be a number. truths/artifacts/key_links',
    '     are all required arrays. Omitting any required field fails the enforcing gate.)',
    '',
    'HARD PROHIBITIONS (violating any of these fails the task):',
    ' (a) NEVER write, create, or modify ANY file — you are in a READ-ONLY sandbox.',
    ' (b) NEVER run any `git` command.',
    ' (c) NEVER touch anything under `.gsd/` — that tree belongs to the orchestrator.',
    ' (d) The network is DISABLED. Reason only from the embedded context + the codebase.',
    '',
    'When you are done, respond with ONLY a single JSON object of this exact shape',
    '(no prose before or after the JSON):',
    '{',
    '  "status": "done" | "partial" | "blocked",',
    '  "summary": "<one-paragraph description of the decomposition>",',
    '  "slice_plan": { "filename": "S##-PLAN.md", "content": "<full markdown of the slice plan>" },',
    '  "task_plans": [ { "id": "T##", "filename": "T##-PLAN.md", "content": "<full markdown, incl. frontmatter must_haves>" } ]',
    '}',
    'Rules for the JSON: content fields hold the COMPLETE markdown of each file (frontmatter',
    'included); task_plans has one entry per task (1–7 total).',
    '',
    '--- PLANNING CONTEXT START ---',
    contextText,
    '--- PLANNING CONTEXT END ---',
  ].join('\n');
}

// ── Codex invocation ──────────────────────────────────────────────────────────

/**
 * Resolve a directly-spawnable codex command, keeping shell:false on every platform.
 *
 * POSIX: npm installs `codex` as an executable shebang shim — spawn it by name.
 * Windows: npm installs only `codex` (a bash script), `codex.cmd` and `codex.ps1`.
 * spawnSync does not apply PATHEXT, and Node refuses to spawn .cmd/.bat without
 * shell:true (CVE-2024-27980) — so spawning 'codex' by name fails with ENOENT.
 * Resolve the real entry point instead: a `codex.exe` on PATH if one exists, else
 * the npm shim's sibling `node_modules/@openai/codex/bin/codex.js`, launched with
 * the current Node binary — which is what codex.cmd does internally anyway.
 *
 * @returns {{cmd: string, prefixArgs: string[]}}
 */
function resolveCodexCommand() {
  if (process.platform !== 'win32') {
    return { cmd: 'codex', prefixArgs: [] };
  }

  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const exe = path.join(dir, 'codex.exe');
    if (fs.existsSync(exe)) {
      return { cmd: exe, prefixArgs: [] };
    }
    if (fs.existsSync(path.join(dir, 'codex.cmd'))) {
      const js = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(js)) {
        return { cmd: process.execPath, prefixArgs: [js] };
      }
    }
  }

  // Nothing resolvable — spawn by name so the caller surfaces the usual ENOENT.
  return { cmd: 'codex', prefixArgs: [] };
}

/**
 * Invoke `codex exec` headless with a strict, minimal flag set. No retry.
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {object} opts.schema
 * @param {string} opts.cwd
 * @param {string} [opts.model]
 * @param {number} opts.timeoutSecs
 * @returns {string} raw content of the -o (last-message) file
 * @throws {Error} on any invocation/parse failure — cause in message
 */
function invokeCodex(opts) {
  const { prompt, schema, cwd, model, timeoutSecs } = opts;

  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-xllm-'));
  } catch (e) {
    throw new Error(`failed to create tmpdir: ${e.message}`);
  }

  const lastMsgFile = path.join(tmpDir, 'last-message.txt');
  const schemaFile = path.join(tmpDir, 'schema.json');

  try {
    fs.writeFileSync(schemaFile, JSON.stringify(schema), 'utf8');

    const args = [
      'exec',
      '--sandbox', 'read-only',
      '-C', cwd,
      '-o', lastMsgFile,
      '--output-schema', schemaFile,
    ];
    if (model) {
      args.push('-m', model);
    }
    args.push(prompt);

    const { cmd, prefixArgs } = resolveCodexCommand();
    const res = spawnSync(cmd, [...prefixArgs, ...args], {
      timeout: timeoutSecs * 1000,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    });

    if (res.error) {
      // ENOENT (missing binary), ETIMEDOUT, etc.
      throw new Error(`codex spawn failed: ${res.error.code || res.error.message}`);
    }
    if (res.signal === 'SIGKILL') {
      throw new Error(`codex killed after exceeding timeout (${timeoutSecs}s)`);
    }
    if (res.status !== 0) {
      const stderrSnippet = (res.stderr ? String(res.stderr) : '').trim().slice(0, 200);
      throw new Error(`codex exited ${res.status}${stderrSnippet ? `: ${stderrSnippet}` : ''}`);
    }

    let content;
    try {
      content = fs.readFileSync(lastMsgFile, 'utf8');
    } catch (e) {
      throw new Error(`codex -o file missing or unreadable: ${e.message}`);
    }
    if (!content || !content.trim()) {
      throw new Error('codex -o file is empty');
    }

    return content;
  } finally {
    // Best-effort cleanup — the -o file may contain diff excerpts.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      // ignore — best-effort
    }
  }
}

/**
 * Invoke `codex exec --sandbox workspace-write` DETACHED for execute mode.
 *
 * Why detached + spawn (not spawnSync): the heartbeat must be re-written WHILE codex
 * runs (S01-RISK blocker #2), which is mechanically impossible under the blocking
 * spawnSync. detached:true gives codex its own process group so a timeout can SIGKILL
 * the WHOLE group (`process.kill(-pid)`) — orphaned children never survive (codex#7852).
 * stdio: stdin closed (codex#20919), stdout NEVER held on a pipe (result comes from the
 * -o file — codex#7852 mitigation), stderr piped with a small cap.
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {object} opts.schema
 * @param {string} opts.cwd
 * @param {string} [opts.model]
 * @param {number} opts.timeoutSecs
 * @param {(pid:number)=>void} [opts.onHeartbeat] called at start and every HEARTBEAT_INTERVAL_MS
 * @param {'read-only'|'workspace-write'} [opts.sandbox] codex sandbox; default 'workspace-write'
 *        (execute). Plan mode passes 'read-only' — codex only reasons, never writes.
 * @returns {Promise<string>} raw content of the -o (last-message) file
 */
function invokeCodexDetached(opts) {
  const { prompt, schema, cwd, model, timeoutSecs, onHeartbeat, sandbox } = opts;

  return new Promise((resolve, reject) => {
    let tmpDir;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-xllm-exec-'));
    } catch (e) {
      reject(new Error(`failed to create tmpdir: ${e.message}`));
      return;
    }

    const lastMsgFile = path.join(tmpDir, 'last-message.txt');
    const schemaFile = path.join(tmpDir, 'schema.json');

    let heartbeatTimer = null;
    let timeoutTimer = null;
    let timedOut = false;
    let settled = false;
    let stderrBuf = '';

    const cleanup = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* best-effort — the -o file may contain work excerpts */ }
    };

    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };

    let child;
    try {
      fs.writeFileSync(schemaFile, JSON.stringify(schema), 'utf8');

      const args = [
        'exec',
        '--sandbox', sandbox || 'workspace-write',
        '-C', cwd,
        '-o', lastMsgFile,
        '--output-schema', schemaFile,
      ];
      if (model) {
        args.push('-m', model);
      }
      args.push(prompt);

      // Windows-safe binary resolution (spawn ENOENT for .cmd/.bat shims):
      // route through resolveCodexCommand() exactly as invokeCodex does.
      // POSIX → { cmd: 'codex', prefixArgs: [] } (byte-identical to a bare spawn).
      const { cmd, prefixArgs } = resolveCodexCommand();
      child = spawn(cmd, [...prefixArgs, ...args], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (e) {
      settle(reject, new Error(`codex spawn failed: ${e.message}`));
      return;
    }

    child.on('error', (err) => {
      // ENOENT (missing binary), EACCES, etc.
      settle(reject, new Error(`codex spawn failed: ${err.code || err.message}`));
    });

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf8');
        // Keep only the tail — never buffer the whole child stderr.
        if (stderrBuf.length > MAX_STDERR_SNIPPET * 4) {
          stderrBuf = stderrBuf.slice(-MAX_STDERR_SNIPPET * 4);
        }
      });
    }

    // Heartbeat: fire immediately (pid known) then on interval.
    if (typeof onHeartbeat === 'function' && child.pid) {
      try { onHeartbeat(child.pid); } catch { /* heartbeat is best-effort */ }
      heartbeatTimer = setInterval(() => {
        try { onHeartbeat(child.pid); } catch { /* best-effort */ }
      }, HEARTBEAT_INTERVAL_MS);
    }

    // Timeout: kill the whole process group, then the child as a fallback.
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group gone */ }
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, timeoutSecs * 1000);

    child.on('close', (code, signal) => {
      if (timedOut) {
        settle(reject, new Error(`codex killed after exceeding timeout (${timeoutSecs}s)`));
        return;
      }
      if (signal) {
        settle(reject, new Error(`codex terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        const snippet = stderrBuf.trim().slice(-MAX_STDERR_SNIPPET);
        settle(reject, new Error(`codex exited ${code}${snippet ? `: ${snippet}` : ''}`));
        return;
      }

      let content;
      try {
        content = fs.readFileSync(lastMsgFile, 'utf8');
      } catch (e) {
        settle(reject, new Error(`codex -o file missing or unreadable: ${e.message}`));
        return;
      }
      if (!content || !content.trim()) {
        settle(reject, new Error('codex -o file is empty'));
        return;
      }
      settle(resolve, content);
    });
  });
}

// ── Normalization ─────────────────────────────────────────────────────────────

function splitPathLine(pathLine) {
  const idx = pathLine.lastIndexOf(':');
  if (idx === -1) return { file: pathLine, line: null };
  const file = pathLine.slice(0, idx);
  const lineStr = pathLine.slice(idx + 1);
  const lineNum = Number(lineStr);
  if (!lineStr || Number.isNaN(lineNum)) return { file: pathLine, line: null };
  return { file, line: lineNum };
}

function normalizeChallenge(obj) {
  return {
    objections: obj.objections.map((o) => {
      const { file, line } = splitPathLine(o.path_line);
      return {
        id: o.id,
        severity: o.severity,
        file,
        line,
        issue: o.claim,
        fix: o.suggested_fix,
        challenge: o.challenge,
      };
    }),
  };
}

function normalizeRebuttal(obj) {
  return {
    verdicts: obj.verdicts.map((v) => ({
      id: v.id,
      verdict: v.verdict,
      reason: v.rationale,
    })),
  };
}

// ── Execute helpers (git READ-ONLY + prefs) ────────────────────────────────────

/**
 * Derive the list of changed files from git, READ-ONLY. Never trust codex's self-
 * declared files_changed. `git diff --name-status HEAD` alone misses untracked files
 * (the most common outcome of a task), so we union it with `git status --porcelain`.
 * All git calls are read-only with fixed args — no untrusted interpolation, no writes.
 * @param {string} cwd
 * @returns {{status:'A'|'M'|'D', path:string}[]}
 */
function deriveFilesChanged(cwd) {
  const byPath = new Map(); // path → status ('A' | 'M' | 'D')

  const setStatus = (p, s) => {
    if (!p) return;
    // Prefer a concrete A/M/D; don't let a later blank overwrite.
    if (!byPath.has(p)) byPath.set(p, s);
  };

  // 1. Porcelain — catches untracked (??) and staged/unstaged working-tree changes.
  let porcelain = '';
  try {
    porcelain = execSync('git status --porcelain', { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  } catch { /* not a repo / git failure — fall through, best-effort */ }
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    const xy = line.slice(0, 2);
    let rest = line.slice(3);
    if (xy === '??') {
      setStatus(rest, 'A');
      continue;
    }
    // Renames/copies appear as "R  old -> new" (or C) — treat the new path as added.
    if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
      const arrow = rest.indexOf(' -> ');
      if (arrow !== -1) rest = rest.slice(arrow + 4);
      setStatus(rest, 'A');
      continue;
    }
    const code = xy.includes('D') ? 'D' : (xy.includes('A') ? 'A' : 'M');
    setStatus(rest, code);
  }

  // 2. name-status against HEAD — catches committed-vs-worktree M/D/A that porcelain
  //    already largely covers, but keeps parity with staged diffs.
  let nameStatus = '';
  try {
    nameStatus = execSync('git diff --name-status HEAD', { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  } catch { /* no HEAD yet / git failure — best-effort */ }
  for (const line of nameStatus.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0][0];
    // Rename/copy lines carry an extra column; the last column is the target path.
    const p = parts[parts.length - 1];
    if (code === 'R' || code === 'C') setStatus(p, 'A');
    else if (code === 'D') setStatus(p, 'D');
    else if (code === 'A') setStatus(p, 'A');
    else setStatus(p, 'M');
  }

  const derived = Array.from(byPath.entries()).map(([p, s]) => ({ status: s, path: p }));

  // Advisory warning — the orchestrator file audit is the real safety net (RISK #3).
  const gsdTouched = derived.filter((d) => d.path.startsWith('.gsd/')).map((d) => d.path);
  if (gsdTouched.length) {
    process.stderr.write(`forge-xllm: WARNING codex touched .gsd/**: ${gsdTouched.join(', ')}\n`);
  }

  return derived;
}

/**
 * Read workers.timeout from the merged prefs cascade (user → repo → local, last wins).
 * Mold: readEvidenceMode (forge-hook.js) — regex only, [ \t] never \s, never \Z.
 * baseDir is the adapter's invocation dir (where `.gsd/` lives), NOT the --cwd
 * (CODE_DIR may lack `.gsd/` in worktree mode). Silent default (null) on any error.
 * @param {string} baseDir
 * @returns {number|null} positive integer seconds, or null when unset/invalid
 */
function readWorkersTimeout(baseDir) {
  const files = [
    path.join(os.homedir(), '.claude', 'forge-agent-prefs.md'),
    path.join(baseDir, '.gsd', 'claude-agent-prefs.md'),
    path.join(baseDir, '.gsd', 'prefs.local.md'),
  ];
  let timeout = null;
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const m = raw.match(/^workers:[ \t]*\n(?:[ \t]+\w+:.*\n)*?[ \t]+timeout:[ \t]*(\d+)/m);
      if (m) {
        const n = parseInt(m[1], 10);
        if (Number.isInteger(n) && n > 0) timeout = n;
      }
    } catch { /* missing file — skip */ }
  }
  return timeout;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run challenge mode: acquire diff via diffCmd, invoke codex, validate, normalize.
 * @param {object} opts
 * @param {string} opts.diffCmd
 * @param {string} opts.cwd
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutSecs]
 * @returns {{objections: object[]}}
 * @throws {Error} on any failure — cause in message
 */
function runChallenge(opts) {
  const cwd = opts.cwd || process.cwd();
  const timeoutSecs = opts.timeoutSecs || DEFAULT_TIMEOUT_SECS;
  if (!opts.diffCmd) throw new Error('challenge mode requires --diff-cmd');

  const diffText = acquireDiff(opts.diffCmd, cwd);
  const prompt = buildChallengePrompt(diffText);
  const rawContent = invokeCodex({ prompt, schema: challengeSchema, cwd, model: opts.model, timeoutSecs });

  const parsed = extractLastJsonBlock(rawContent);
  if (parsed === null) throw new Error('no parseable JSON block found in codex output');
  if (!validateObjections(parsed)) throw new Error('codex output failed objections validation');

  return normalizeChallenge(parsed);
}

/**
 * Run rebuttal mode: read objections+defenses from --input file, invoke codex, validate, normalize.
 * @param {object} opts
 * @param {string} opts.inputFile
 * @param {string} opts.cwd
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutSecs]
 * @returns {{verdicts: object[]}}
 * @throws {Error} on any failure — cause in message
 */
function runRebuttal(opts) {
  const cwd = opts.cwd || process.cwd();
  const timeoutSecs = opts.timeoutSecs || DEFAULT_TIMEOUT_SECS;
  if (!opts.inputFile) throw new Error('rebuttal mode requires --input <file>');

  let inputText;
  try {
    inputText = fs.readFileSync(opts.inputFile, 'utf8');
  } catch (e) {
    throw new Error(`failed to read --input file: ${e.message}`);
  }

  const prompt = buildRebuttalPrompt(inputText);
  const rawContent = invokeCodex({
    prompt,
    schema: verdictSchema(VERDICT_ENUM),
    cwd,
    model: opts.model,
    timeoutSecs,
  });

  const parsed = extractLastJsonBlock(rawContent);
  if (parsed === null) throw new Error('no parseable JSON block found in codex output');
  if (!validateVerdicts(parsed)) throw new Error('codex output failed verdicts validation');

  return normalizeRebuttal(parsed);
}

// ── Execute driver ──────────────────────────────────────────────────────────────

/** Atomic write: tmp file in the same dir + rename (the S02 poller never reads a
 *  half-written JSON). @param {string} file @param {object} obj */
function writeJsonAtomic(file, obj) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

/** Run one read-only git command in cwd, trimmed. Throws with a clear cause. */
function gitRead(gitArgs, cwd, what) {
  try {
    return execSync(`git ${gitArgs}`, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER }).trim();
  } catch (e) {
    const snippet = (e && e.stderr ? String(e.stderr) : e.message).trim().slice(0, MAX_STDERR_SNIPPET);
    throw new Error(`${what} failed: ${snippet}`);
  }
}

/**
 * Run execute mode: guards → prompt → codex (workspace-write, detached, heartbeat,
 * timeout) → no-commit check → validate → derive files_changed → normalized result-file.
 * The result-file is the ONLY result channel. No git writes, ever.
 * @param {object} opts
 * @param {string} opts.planFile     path to a T##-PLAN.md
 * @param {string} opts.resultFile   path OUTSIDE the workspace for the result JSON
 * @param {string} opts.cwd          the workspace (CODE_DIR) — a clean git repo
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutSecs]
 * @returns {Promise<object>} the normalized result object (also written to resultFile)
 */
async function runExecute(opts) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const timeoutSecs = opts.timeoutSecs || DEFAULT_EXECUTE_TIMEOUT_SECS;

  if (!opts.planFile) throw new Error('execute mode requires --plan <file>');
  if (!opts.resultFile) throw new Error('execute mode requires --result-file <path>');

  const resultFile = path.resolve(opts.resultFile);

  // Guard: result-file must live OUTSIDE the workspace (never in the repo being written).
  if (resultFile === cwd || resultFile.startsWith(cwd + path.sep)) {
    throw new Error('result-file must live outside the workspace');
  }

  let planText;
  try {
    planText = fs.readFileSync(opts.planFile, 'utf8');
  } catch (e) {
    throw new Error(`failed to read --plan file: ${e.message}`);
  }
  if (!planText.trim()) throw new Error('--plan file is empty');

  // Guard: cwd must be a git work tree.
  const insideRepo = gitRead('rev-parse --is-inside-work-tree', cwd, 'git repo check');
  if (insideRepo !== 'true') throw new Error(`--cwd is not inside a git work tree: ${cwd}`);

  // Dirty guard (BEFORE anything else) — never start on someone else's uncommitted work.
  const dirty = execSync('git status --porcelain', { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (dirty.trim()) {
    throw new Error(`working tree dirty at ${cwd} — refusing to start (will never clean someone else's work)`);
  }

  const startSha = gitRead('rev-parse HEAD', cwd, 'git rev-parse HEAD');
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  // Initial heartbeat — pid unknown until the child spawns.
  writeJsonAtomic(resultFile, {
    status: 'running',
    pid: null,
    adapter_pid: process.pid,
    start_sha: startSha,
    started_at: startedAt,
    updated_at: startedAt,
  });

  const onHeartbeat = (pid) => {
    writeJsonAtomic(resultFile, {
      status: 'running',
      pid,
      adapter_pid: process.pid,
      start_sha: startSha,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
    });
  };

  const prompt = buildExecutePrompt(planText);
  const rawContent = await invokeCodexDetached({
    prompt,
    schema: executeSchema,
    cwd,
    model: opts.model,
    timeoutSecs,
    onHeartbeat,
  });

  // No-commit invariant: codex must not have moved HEAD.
  const headSha = gitRead('rev-parse HEAD', cwd, 'git rev-parse HEAD (post-run)');
  if (headSha !== startSha) {
    throw new Error('codex moved HEAD (committed) — no-commit invariant violated');
  }

  const parsed = extractLastJsonBlock(rawContent);
  if (parsed === null) throw new Error('no parseable JSON block found in codex output');
  if (!validateExecuteResult(parsed)) throw new Error('codex output failed execute-result validation');

  const derived = deriveFilesChanged(cwd);
  const finishedAt = new Date().toISOString();

  const result = {
    status: parsed.status,
    summary: parsed.summary,
    must_haves_status: parsed.must_haves_status,
    files_changed: derived,
    files_changed_declared: parsed.files_changed,
    start_sha: startSha,
    head_sha: headSha,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_secs: Math.round((Date.now() - startedMs) / 1000),
  };

  writeJsonAtomic(resultFile, result);
  return result;
}

/**
 * Run plan mode: guards → prompt → codex (READ-ONLY, detached, heartbeat, timeout) →
 * validate shape → validate each task_plan's must_haves IN-SIDECAR → normalized result-file.
 *
 * Read-only profile (LOCKED — S03-PLAN design): codex only READS the codebase + the
 * planning context to reason, and returns the full markdown CONTENT of each plan file in
 * the result JSON. It writes NOTHING — so there is NO dirty-tree guard, NO START_SHA
 * reset, NO no-commit check, NO deriveFilesChanged (all of which exist in runExecute
 * precisely because execute is workspace-write). The orchestrator (T02/T03) materializes
 * the returned content under `.gsd/`; codex never touches `.gsd/`.
 *
 * The must_haves of every returned T##-PLAN.md is validated in-sidecar via
 * forge-must-haves.js BEFORE exit 0 — this is the enforcing gate (S03 requirement #1):
 * a legacy or malformed plan aborts with a throw → exit 2 → orchestrator falls back to
 * the Claude planner. The must_haves check runs on the CONTENT string directly (no temp
 * file — parseMustHaves accepts a string).
 *
 * @param {object} opts
 * @param {string} opts.planContextFile  path to the planning-context markdown
 * @param {string} opts.resultFile       path OUTSIDE the workspace for the result JSON
 * @param {string} opts.cwd              the workspace (CODE_DIR) — a git repo, read only
 * @param {string} [opts.model]
 * @param {number} [opts.timeoutSecs]
 * @returns {Promise<object>} the normalized result object (also written to resultFile)
 */
async function runPlan(opts) {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const timeoutSecs = opts.timeoutSecs || DEFAULT_EXECUTE_TIMEOUT_SECS;

  if (!opts.planContextFile) throw new Error('plan mode requires --plan-context <file>');
  if (!opts.resultFile) throw new Error('plan mode requires --result-file <path>');

  const resultFile = path.resolve(opts.resultFile);

  // Guard: result-file must live OUTSIDE the workspace (never in the repo being read).
  if (resultFile === cwd || resultFile.startsWith(cwd + path.sep)) {
    throw new Error('result-file must live outside the workspace');
  }

  let contextText;
  try {
    contextText = fs.readFileSync(opts.planContextFile, 'utf8');
  } catch (e) {
    throw new Error(`failed to read --plan-context file: ${e.message}`);
  }
  if (!contextText.trim()) throw new Error('--plan-context file is empty');

  // Guard: cwd must be a git work tree (read-only check).
  const insideRepo = gitRead('rev-parse --is-inside-work-tree', cwd, 'git repo check');
  if (insideRepo !== 'true') throw new Error(`--cwd is not inside a git work tree: ${cwd}`);

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  // Initial heartbeat — pid unknown until the child spawns.
  writeJsonAtomic(resultFile, {
    status: 'running',
    pid: null,
    adapter_pid: process.pid,
    started_at: startedAt,
    updated_at: startedAt,
  });

  const onHeartbeat = (pid) => {
    writeJsonAtomic(resultFile, {
      status: 'running',
      pid,
      adapter_pid: process.pid,
      started_at: startedAt,
      updated_at: new Date().toISOString(),
    });
  };

  const prompt = buildPlanPrompt(contextText);
  const rawContent = await invokeCodexDetached({
    prompt,
    schema: planSchema,
    cwd,
    model: opts.model,
    timeoutSecs,
    onHeartbeat,
    sandbox: 'read-only',
  });

  const parsed = extractLastJsonBlock(rawContent);
  if (parsed === null) throw new Error('no parseable JSON block found in codex output');
  if (!validatePlanResult(parsed)) throw new Error('codex output failed plan-result validation');

  // In-sidecar must_haves validation (ENFORCING gate — S03 requirement #1). Every
  // returned T##-PLAN must carry a structured, well-formed must_haves block or we abort
  // BEFORE exit 0 so the orchestrator falls back to the Claude planner.
  const { hasStructuredMustHaves, parseMustHaves } = require('./forge-must-haves.js');
  for (const tp of parsed.task_plans) {
    if (!hasStructuredMustHaves(tp.content)) {
      throw new Error(`${tp.id} is legacy — GPT plan must carry a structured must_haves block`);
    }
    try {
      parseMustHaves(tp.content);
    } catch (e) {
      throw new Error(`${tp.id} must_haves invalid: ${e.message}`);
    }
  }

  const finishedAt = new Date().toISOString();
  const result = {
    status: parsed.status,
    summary: parsed.summary,
    slice_plan: parsed.slice_plan,
    task_plans: parsed.task_plans,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_secs: Math.round((Date.now() - startedMs) / 1000),
  };

  writeJsonAtomic(resultFile, result);
  return result;
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  runChallenge,
  runRebuttal,
  runExecute,
  runPlan,
  extractLastJsonBlock,
  validateObjections,
  validateVerdicts,
  validateExecuteResult,
  validatePlanResult,
  buildPlanPrompt,
  deriveFilesChanged,
  readWorkersTimeout,
};

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode;

  if (mode !== 'challenge' && mode !== 'rebuttal' && mode !== 'execute' && mode !== 'plan') {
    process.stderr.write('Usage: forge-xllm.js --mode challenge|rebuttal|execute|plan [--diff-cmd <cmd>] [--input <file>] [--plan <file>] [--plan-context <file>] [--result-file <path>] [--model <id>] [--timeout <secs>] [--cwd <dir>]\n');
    process.exit(2);
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
  const model = typeof args.model === 'string' ? args.model : undefined;

  if (mode === 'plan') {
    // Timeout precedence: --timeout flag > workers.timeout pref > default. Prefs read
    // from the ADAPTER invocation dir (where .gsd/ lives), not --cwd (CODE_DIR).
    const flagTimeout = args.timeout ? Number(args.timeout) : null;
    const timeoutSecs =
      (flagTimeout && flagTimeout > 0 ? flagTimeout : null)
      || readWorkersTimeout(process.cwd())
      || DEFAULT_EXECUTE_TIMEOUT_SECS;
    const resultFile = typeof args['result-file'] === 'string' ? args['result-file'] : null;

    runPlan({ planContextFile: args['plan-context'], resultFile, cwd, model, timeoutSecs })
      .then(() => process.exit(0)) // result-file is the ONLY channel — nothing on stdout
      .catch((e) => {
        // Best-effort adapter-failed marker in the result-file (if we have a path).
        if (resultFile) {
          try {
            writeJsonAtomic(path.resolve(resultFile), {
              status: 'adapter-failed',
              reason: e.message,
              failed_at: new Date().toISOString(),
            });
          } catch { /* best-effort — never mask the real error */ }
        }
        process.stderr.write(`forge-xllm: ${e.message}\n`);
        process.exit(2);
      });
    return;
  }

  if (mode === 'execute') {
    // Timeout precedence: --timeout flag > workers.timeout pref > default.
    // Prefs are read from the ADAPTER invocation dir (where .gsd/ lives), not --cwd.
    const flagTimeout = args.timeout ? Number(args.timeout) : null;
    const timeoutSecs =
      (flagTimeout && flagTimeout > 0 ? flagTimeout : null)
      || readWorkersTimeout(process.cwd())
      || DEFAULT_EXECUTE_TIMEOUT_SECS;
    const resultFile = typeof args['result-file'] === 'string' ? args['result-file'] : null;

    runExecute({ planFile: args.plan, resultFile, cwd, model, timeoutSecs })
      .then(() => process.exit(0)) // result-file is the ONLY channel — nothing on stdout
      .catch((e) => {
        // Best-effort adapter-failed marker in the result-file (if we have a path).
        if (resultFile) {
          try {
            let startSha;
            try {
              startSha = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER }).trim();
            } catch { /* no repo / detached — omit */ }
            writeJsonAtomic(path.resolve(resultFile), {
              status: 'adapter-failed',
              reason: e.message,
              ...(startSha ? { start_sha: startSha } : {}),
              failed_at: new Date().toISOString(),
            });
          } catch { /* best-effort — never mask the real error */ }
        }
        process.stderr.write(`forge-xllm: ${e.message}\n`);
        process.exit(2);
      });
    return;
  }

  // Synchronous modes (challenge / rebuttal) — unchanged flow, JSON on stdout.
  const timeoutSecs = args.timeout ? Number(args.timeout) : DEFAULT_TIMEOUT_SECS;
  try {
    let result;
    if (mode === 'challenge') {
      result = runChallenge({ diffCmd: args['diff-cmd'], cwd, model, timeoutSecs });
    } else {
      result = runRebuttal({ inputFile: args.input, cwd, model, timeoutSecs });
    }
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exit(0);
  } catch (e) {
    process.stderr.write(`forge-xllm: ${e.message}\n`);
    process.exit(2);
  }
}
