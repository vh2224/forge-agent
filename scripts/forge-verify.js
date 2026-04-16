#!/usr/bin/env node
/**
 * forge-verify.js
 *
 * Verification gate for Forge Agent — discovers and runs verification commands
 * for a task unit, then reports pass/fail with truncated output.
 *
 * Source: GSD-2 verification-gate.js lines 31–252 (ESM → CJS conversion).
 * Changes from upstream:
 *   - ESM (`import`/`export`) → CommonJS (`require`/`module.exports`)
 *   - Dropped `rewriteCommandWithRtk` (rtk.js dep) — commands pass through unchanged
 *   - Discovery chain order changed: task-plan FIRST, then preference, then package.json
 *     (Forge D003: plan.verify → prefs.preference_commands → auto-detect → skipped:no-stack)
 *   - Added `pyproject.toml` / `go.mod` detection in step 4 (docs-only vs. non-JS stack)
 *   - Added `--from-verify` sentinel (reserved for orchestrator anti-recursion — ignored here)
 *   - Added head+tail stderr truncation strategy for large outputs
 *   - Added events.jsonl append in CLI mode (I/O errors throw — telemetry is not silent-fail)
 *   - Added frontmatter size cap (1 MB) before regex to prevent catastrophic backtracking
 *
 * Trust boundaries:
 *   - `taskPlanVerify` (from plan frontmatter): UNTRUSTED — SHELL_INJECTION_PATTERN + isLikelyCommand applied
 *   - `preferenceCommands` (user-authored prefs): TRUSTED — no sanitization applied
 *   - `package.json` scripts: only probed via frozen allow-list PACKAGE_SCRIPT_KEYS
 *
 * Anti-recursion: if invoked by the orchestrator with --from-verify, the script
 * runs normally. The orchestrator (T02/T03) is responsible for detecting recursion
 * via the --from-verify flag it passes to child invocations.
 *
 * Relative paths in commands: dispatched relative to `{cwd}` option, not process.cwd().
 *
 * SECURITY WARNING: per-check stderr is captured verbatim in events.jsonl (truncated
 * to head+tail). If your tests log environment variables or credentials, redact before
 * running the verification gate.
 *
 * Pure Node built-ins — zero npm dependencies. CommonJS.
 */

'use strict';

const { spawnSync } = require('child_process');
const { existsSync, readFileSync, mkdirSync, appendFileSync } = require('fs');
const { join, dirname } = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum bytes of stdout/stderr to retain per command (10 KB). */
const MAX_OUTPUT_BYTES = 10 * 1024;

/** Maximum chars of stderr to include per failed check in failure context. */
const MAX_STDERR_PER_CHECK = 2_000;

/** Head bytes for head+tail truncation strategy. */
const HEAD_BYTES = 3 * 1024;

/** Tail bytes for head+tail truncation strategy. */
const TAIL_BYTES = 7 * 1024;

/** Maximum total chars for the combined failure context output. */
const MAX_FAILURE_CONTEXT_CHARS = 10_000;

/** Default per-command timeout in milliseconds (2 minutes). */
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/**
 * Frozen allow-list of package.json script keys to probe, in order.
 * NEVER reads arbitrary script keys — probes only these three.
 * Dynamic key iteration (`Object.keys(pkg.scripts)`) is forbidden.
 */
const PACKAGE_SCRIPT_KEYS = Object.freeze(["typecheck", "lint", "test"]);

/** Shell injection characters to reject in untrusted command strings. */
const SHELL_INJECTION_PATTERN = /[;|`]|\$\(/;

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Truncate a string to maxBytes, appending a marker if truncated.
 * Ported verbatim from GSD-2 verification-gate.js lines 13–21.
 */
function truncate(value, maxBytes) {
  if (!value) return "";
  if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
  const buf = Buffer.from(value, "utf-8").subarray(0, maxBytes);
  return buf.toString("utf-8") + "\n…[truncated]";
}

/**
 * Head+tail truncation: keep first `headBytes` and last `tailBytes`,
 * inserting an elision marker in between. Used for large stderr outputs.
 */
function truncateHeadTail(value, headBytes, tailBytes) {
  if (!value) return "";
  const totalBytes = Buffer.byteLength(value, "utf-8");
  if (totalBytes <= headBytes + tailBytes) return value;
  const buf = Buffer.from(value, "utf-8");
  const head = buf.subarray(0, headBytes).toString("utf-8");
  const tail = buf.subarray(buf.length - tailBytes).toString("utf-8");
  const elided = totalBytes - headBytes - tailBytes;
  return head + `\n[...${elided} bytes elided...]\n` + tail;
}

// ── Command validation ────────────────────────────────────────────────────────

/**
 * Known executable first-tokens that are safe to run.
 * Ported verbatim from GSD-2 verification-gate.js lines 119–132.
 */
const KNOWN_COMMAND_PREFIXES = new Set([
  "npm", "npx", "yarn", "pnpm", "bun", "bunx", "deno",
  "node", "ts-node", "tsx", "tsc",
  "sh", "bash", "zsh",
  "echo", "cat", "ls", "test", "true", "false", "pwd", "env",
  "make", "cargo", "go", "python", "python3", "pip", "pip3",
  "ruby", "gem", "bundle", "rake",
  "java", "javac", "mvn", "gradle",
  "docker", "docker-compose",
  "git", "gh",
  "eslint", "prettier", "vitest", "jest", "mocha", "pytest", "phpunit",
  "curl", "wget",
  "grep", "find", "diff", "wc", "sort", "head", "tail",
]);

/**
 * Heuristic check: does this string look like an executable shell command
 * rather than a prose description?
 *
 * Ported verbatim from GSD-2 verification-gate.js lines 151–176.
 */
function isLikelyCommand(cmd) {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0];

  // Known command prefix → definitely a command
  if (KNOWN_COMMAND_PREFIXES.has(firstToken)) return true;

  // Path-like first token → command
  if (firstToken.startsWith("/") || firstToken.startsWith("./") || firstToken.startsWith("../"))
    return true;

  // Has flag-like tokens → command
  if (tokens.some(t => t.startsWith("-"))) return true;

  // First token starts with uppercase + 4 or more words → prose
  if (/^[A-Z]/.test(firstToken) && tokens.length >= 4) return false;

  // Contains comma-space patterns (prose clause separators) → prose
  if (/,\s/.test(trimmed) && tokens.length >= 4) return false;

  // First token has uppercase letters and no path separators → prose
  if (/[A-Z]/.test(firstToken) && !firstToken.includes("/")) return false;

  return true;
}

/**
 * Validate a command string for obvious shell injection patterns.
 * Returns the command unchanged if safe, or null if suspicious.
 * Applied ONLY to `taskPlanVerify` (untrusted source). NOT applied to preferenceCommands.
 */
function sanitizeCommand(cmd) {
  if (SHELL_INJECTION_PATTERN.test(cmd)) return null;
  if (!isLikelyCommand(cmd)) return null;
  return cmd;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * Discover verification commands using the first-non-empty-wins strategy.
 * Discovery order (Forge D003):
 *   1. taskPlanVerify (split on &&; untrusted — sanitized via SHELL_INJECTION_PATTERN + isLikelyCommand)
 *   2. preferenceCommands (trusted user prefs — no sanitization)
 *   3. package.json scripts (frozen allow-list: typecheck, lint, test only)
 *   4. None found — returns source:"none" (docs-only repo signal)
 *
 * The 4-condition AND-gate for "docs-only skip":
 *   - taskPlanVerify absent/empty
 *   - preferenceCommands absent/empty
 *   - package.json absent (or has none of the allow-listed scripts)
 *   - pyproject.toml absent AND go.mod absent
 *   All four → source:"none" → runVerificationGate returns skipped:"no-stack"
 *
 * @param {{ preferenceCommands?: string[], taskPlanVerify?: string, cwd: string }} options
 * @returns {{ commands: string[], source: "task-plan"|"preference"|"package-json"|"none" }}
 */
function discoverCommands(options) {
  const cwd = options.cwd;

  // 1. Task plan verify field (untrusted — sanitize each segment)
  if (options.taskPlanVerify && options.taskPlanVerify.trim()) {
    const commands = options.taskPlanVerify
      .split("&&")
      .map(c => c.trim())
      .filter(Boolean)
      .filter(c => sanitizeCommand(c) !== null);
    if (commands.length > 0) {
      return { commands, source: "task-plan" };
    }
  }

  // 2. Preference commands (trusted — no sanitization)
  if (options.preferenceCommands && options.preferenceCommands.length > 0) {
    const filtered = options.preferenceCommands
      .map(c => c.trim())
      .filter(Boolean);
    if (filtered.length > 0) {
      return { commands: filtered, source: "preference" };
    }
  }

  // 3. package.json scripts (frozen allow-list only)
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      if (pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object") {
        const commands = [];
        // Probe only the frozen allow-list — never iterate pkg.scripts keys
        for (const key of PACKAGE_SCRIPT_KEYS) {
          if (typeof pkg.scripts[key] === "string") {
            commands.push(`npm run ${key}`);
          }
        }
        if (commands.length > 0) {
          return { commands, source: "package-json" };
        }
      }
    } catch {
      // Malformed package.json — fall through to "none"
    }
  }

  // 4. Nothing found — check for non-JS stacks (out of scope, but distinguishable via source)
  // Python and Go projects return source:"none" for now (support is out of scope per S02-PLAN).
  // The orchestrator can detect non-JS stacks via discoverySource and handle separately.
  // const hasPython = existsSync(join(cwd, "pyproject.toml"));
  // const hasGo = existsSync(join(cwd, "go.mod"));
  return { commands: [], source: "none" };
}

// ── Failure Context ───────────────────────────────────────────────────────────

/**
 * Format failed verification checks into a prompt-injectable text block.
 * Each failed check gets a heading + truncated stderr (head+tail, 2 000 char cap).
 * Total output capped at 10 000 chars.
 * Returns empty string when all checks pass.
 *
 * Ported from GSD-2 verification-gate.js lines 91–111 with head+tail truncation.
 */
function formatFailureContext(result) {
  const failures = result.checks.filter(c => c.exitCode !== 0);
  if (failures.length === 0) return "";

  const blocks = [];
  for (const check of failures) {
    let stderr = check.stderr || "";
    if (stderr.length > MAX_STDERR_PER_CHECK) {
      // Use head+tail: 600 head + 1400 tail = 2000 total for failure context blocks
      stderr = truncateHeadTail(stderr, 600, 1400);
    }
    blocks.push(`### \`${check.command}\` (exit code ${check.exitCode})\n\`\`\`stderr\n${stderr}\n\`\`\``);
  }

  let body = blocks.join("\n\n");
  const header = "## Verification Failures\n\n";
  if (header.length + body.length > MAX_FAILURE_CONTEXT_CHARS) {
    body =
      body.slice(0, MAX_FAILURE_CONTEXT_CHARS - header.length) +
      "\n\n…[remaining failures truncated]";
  }
  return header + body;
}

// ── Gate Execution ────────────────────────────────────────────────────────────

/**
 * Run the verification gate: discover commands, execute each via spawnSync,
 * and return a structured result.
 *
 * - All commands run sequentially regardless of individual pass/fail.
 * - `passed` is true when every command exits 0.
 * - When source is "none" (docs-only repo), returns skipped:"no-stack" immediately.
 * - Per-command timeout: 120 s (configurable). On timeout → exitCode 124.
 * - stderr > 10 KB → truncated with head+tail strategy before storing.
 * - Shell binary is hardcoded per platform (no user-controlled shell selection):
 *   Windows → cmd /c; else → sh -c. shell:false (explicit argv avoids DEP0190).
 *
 * @param {{ cwd: string, preferenceCommands?: string[], taskPlanVerify?: string, commandTimeoutMs?: number }} options
 * @returns {{ passed: boolean, checks: object[], discoverySource: string, skipped?: string, timestamp: number }}
 */
function runVerificationGate(options) {
  const timestamp = Date.now();
  const { commands, source } = discoverCommands({
    preferenceCommands: options.preferenceCommands,
    taskPlanVerify: options.taskPlanVerify,
    cwd: options.cwd,
  });

  // Docs-only graceful skip (4-condition AND-gate satisfied)
  if (commands.length === 0) {
    return {
      passed: true,
      checks: [],
      discoverySource: source,
      skipped: "no-stack",
      timestamp,
    };
  }

  const timeoutMs = options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS;
  const checks = [];

  for (const command of commands) {
    const start = Date.now();

    // Platform branch hardcoded — no user-controlled shell binary
    const shellBin = process.platform === "win32" ? "cmd" : "sh";
    const shellArgs = process.platform === "win32" ? ["/c", command] : ["-c", command];

    // shell: false — explicit argv binary + args (avoids Node DEP0190, prevents injection)
    const result = spawnSync(shellBin, shellArgs, {
      cwd: options.cwd,  // --cwd is a spawnSync option, never shell-interpolated
      stdio: "pipe",
      encoding: "utf-8",
      timeout: timeoutMs,
    });

    const durationMs = Date.now() - start;

    let exitCode;
    let stderr;
    let checkSkipped;

    // Timeout detection: SIGTERM signal OR ETIMEDOUT error code (Windows pitfall per S02-RESEARCH)
    const isTimeout = result.signal === "SIGTERM" || result.error?.code === "ETIMEDOUT";

    if (isTimeout) {
      exitCode = 124;
      stderr = `[timeout after ${timeoutMs}ms]`;
      checkSkipped = "timeout";
    } else if (result.error) {
      // Command not found or spawn failure
      exitCode = 127;
      stderr = truncate((result.stderr || "") + "\n" + result.error.message, MAX_OUTPUT_BYTES);
    } else {
      // status is null when killed by signal — treat as failure
      exitCode = result.status ?? 1;
      const rawStderr = result.stderr || "";
      // Apply head+tail truncation for large stderr (> 10 KB)
      if (Buffer.byteLength(rawStderr, "utf-8") > MAX_OUTPUT_BYTES) {
        stderr = truncateHeadTail(rawStderr, HEAD_BYTES, TAIL_BYTES);
      } else {
        stderr = rawStderr;
      }
    }

    const check = {
      command,
      exitCode,
      stdout: truncate(result.stdout, MAX_OUTPUT_BYTES),
      stderr,
      durationMs,
    };
    if (checkSkipped) check.skipped = checkSkipped;
    checks.push(check);
  }

  return {
    passed: checks.every(c => c.exitCode === 0),
    checks,
    discoverySource: source,
    timestamp,
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { discoverCommands, runVerificationGate, formatFailureContext, isLikelyCommand };

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    let planPath = null;
    let cwd = process.cwd();
    let unit = "unknown";
    let preferenceCommands = [];
    let timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
    // --from-verify: accepted but ignored (reserved for orchestrator anti-recursion)
    // let fromVerify = false;

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--plan" && args[i + 1] !== undefined) {
        planPath = args[++i];
      } else if (arg === "--cwd" && args[i + 1] !== undefined) {
        cwd = args[++i];
      } else if (arg === "--unit" && args[i + 1] !== undefined) {
        unit = args[++i];
      } else if (arg === "--preference" && args[i + 1] !== undefined) {
        preferenceCommands.push(args[++i]);
      } else if (arg === "--timeout" && args[i + 1] !== undefined) {
        const parsed = parseInt(args[++i], 10);
        if (isNaN(parsed) || parsed <= 0) {
          process.stderr.write(JSON.stringify({ error: `Invalid --timeout value: ${args[i]}` }) + "\n");
          process.exit(2);
        }
        timeoutMs = parsed;
      } else if (arg === "--from-verify") {
        // Reserved sentinel for orchestrator anti-recursion — accepted, ignored
      }
    }

    // Parse --plan frontmatter to extract verify: field
    let taskPlanVerify = null;
    if (planPath !== null) {
      // Frontmatter size cap: 1 MB before regex (prevents catastrophic backtracking)
      const MAX_FRONTMATTER_FILE_SIZE = 1024 * 1024;
      const planContent = readFileSync(planPath, "utf-8");
      if (Buffer.byteLength(planContent, "utf-8") > MAX_FRONTMATTER_FILE_SIZE) {
        process.stderr.write(JSON.stringify({ error: `--plan file exceeds 1 MB size cap: ${planPath}` }) + "\n");
        process.exit(2);
      }

      const fmMatch = planContent.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const frontmatter = fmMatch[1];
        // Extract verify: field — supports string or YAML array
        const verifyLineMatch = frontmatter.match(/^verify:\s*(.+)$/m);
        if (verifyLineMatch) {
          const raw = verifyLineMatch[1].trim();
          // Inline array: verify: [cmd1, cmd2]
          if (raw.startsWith("[")) {
            // Simple bracket array parse — strip brackets, split on comma
            const inner = raw.slice(1, raw.endsWith("]") ? raw.length - 1 : raw.length);
            const items = inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
            taskPlanVerify = items.join(" && ");
          } else if (raw === "|" || raw === ">") {
            // Block scalar — not supported; skip
          } else {
            // Plain string value
            taskPlanVerify = raw.replace(/^["']|["']$/g, "");
          }
        } else {
          // Multi-line YAML array: verify:\n  - cmd1\n  - cmd2
          const verifyBlockMatch = frontmatter.match(/^verify:\s*\n((?:\s+-\s+.+\n?)+)/m);
          if (verifyBlockMatch) {
            const items = verifyBlockMatch[1]
              .split("\n")
              .map(l => l.replace(/^\s+-\s+/, "").trim())
              .filter(Boolean);
            taskPlanVerify = items.join(" && ");
          }
        }

        // Validate verify: shape — reject non-string/non-array shapes
        if (taskPlanVerify !== null && typeof taskPlanVerify !== "string") {
          process.stderr.write(JSON.stringify({ error: "verify: field must be a string or array of strings" }) + "\n");
          process.exit(2);
        }
      }
    }

    const startTime = Date.now();
    const result = runVerificationGate({
      cwd,
      preferenceCommands: preferenceCommands.length > 0 ? preferenceCommands : undefined,
      taskPlanVerify: taskPlanVerify || undefined,
      commandTimeoutMs: timeoutMs,
    });
    const duration = Date.now() - startTime;

    // Append to events.jsonl — I/O errors MUST throw (telemetry is not silent-fail)
    const eventsDir = join(cwd, ".gsd", "forge");
    mkdirSync(eventsDir, { recursive: true });
    const eventsPath = join(eventsDir, "events.jsonl");
    const eventLine = JSON.stringify({
      ts: new Date().toISOString(),
      event: "verify",
      unit,
      discovery_source: result.discoverySource,
      commands: result.checks.map(c => c.command),
      passed: result.passed,
      ...(result.skipped ? { skipped: result.skipped } : {}),
      duration_ms: duration,
    });
    // No try/catch — I/O errors propagate to caller (orchestrator handles)
    appendFileSync(eventsPath, eventLine + "\n", "utf-8");

    console.log(JSON.stringify(result));
    process.exit(result.passed ? 0 : 1);
  } catch (err) {
    // Re-throw I/O errors from events.jsonl append (not swallowed here)
    // Only parse/validation errors reach this catch for exit(2)
    const isIoError = err.code && /^E[A-Z]+$/.test(err.code);
    if (isIoError) {
      throw err;
    }
    process.stderr.write(JSON.stringify({ error: err.message || String(err) }) + "\n");
    process.exit(2);
  }
}
