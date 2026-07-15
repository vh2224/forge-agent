#!/usr/bin/env node
/**
 * forge-xllm.js — zero-dep sidecar adapter for `codex exec` (GPT review challenger/rebuttal).
 *
 * Exports:
 *   runChallenge(opts)         → { objections: [...] }   (or throws)
 *   runRebuttal(opts)          → { verdicts: [...] }      (or throws)
 *   extractLastJsonBlock(text) → object|array|null
 *   validateObjections(obj)    → boolean
 *   validateVerdicts(obj)      → boolean
 *
 * CLI usage:
 *   node scripts/forge-xllm.js --mode challenge --diff-cmd "git diff" [--model <id>] [--timeout 300] [--cwd <dir>]
 *   node scripts/forge-xllm.js --mode rebuttal --input <file> [--model <id>] [--timeout 300] [--cwd <dir>]
 *
 * Exit contract: 0 on success (normalized JSON on stdout, nothing else on stdout).
 * ANY failure (bad args, missing binary, non-zero exit, timeout, unparseable/invalid
 * output) → process.exit(2), cause logged to stderr. NO RETRY on any path (LOCKED —
 * see S01-RISK.md blocker #4). The orchestrator owns fallback behavior, not this adapter.
 *
 * Security notes:
 *  - `codex` is invoked EXCLUSIVELY via spawnSync with array args — never shell:true.
 *  - `--diff-cmd` IS executed via execSync({shell:true}) because it legitimately needs
 *    pipes/redirection. This value must come ONLY from the orchestrator — never from
 *    codex output, --input file content, or any other untrusted source.
 *  - codex output is untrusted model output: parsed via JSON.parse only (never eval /
 *    new Function / dynamic require), then hand-validated field-by-field. --output-schema
 *    is a HINT, not a contract (codex#15451) — model-family guards can silently drop it
 *    (codex#4181), so we never assume the schema was honored.
 *  - Prompt-injection via the embedded diff/objections text is a known, accepted
 *    limitation: sandbox is read-only, output is strictly validated, and review is
 *    advisory-only downstream — no attempt is made to "sanitize" the diff text itself.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execSync } = require('child_process');

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_SECS = 300;
const MAX_DIFF_LINES = 4000;
const MAX_BUFFER = 16 * 1024 * 1024; // 16MB — guards against runaway output (local DoS)
const SEVERITY_ENUM = ['critical', 'high', 'medium', 'low'];
const VERDICT_ENUM = ['maintained', 'withdrawn'];

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
      // Allow running outside a Git repository (e.g. SVN working copies). Codex
      // otherwise aborts with "Not inside a trusted directory and --skip-git-repo-check
      // was not specified", and a non-git dir can never become a "trusted directory"
      // (no config/trust bypasses it — only this flag). The read-only sandbox already
      // bounds the blast radius, so this does not weaken isolation. See docs/xllm-review-svn-gap.md.
      '--skip-git-repo-check',
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

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  runChallenge,
  runRebuttal,
  extractLastJsonBlock,
  validateObjections,
  validateVerdicts,
};

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode;

  if (mode !== 'challenge' && mode !== 'rebuttal') {
    process.stderr.write('Usage: forge-xllm.js --mode challenge|rebuttal [--diff-cmd <cmd>] [--input <file>] [--model <id>] [--timeout <secs>] [--cwd <dir>]\n');
    process.exit(2);
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
  const timeoutSecs = args.timeout ? Number(args.timeout) : DEFAULT_TIMEOUT_SECS;
  const model = typeof args.model === 'string' ? args.model : undefined;

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
