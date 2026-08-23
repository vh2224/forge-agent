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
const { join, dirname, resolve, basename } = require('path');
const { resolveOwner } = require('./forge-workspace.js');

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
 *   4. Stack probe via forge-reverify's resolveVerifyCommand (go.mod,
 *      Cargo.toml, pytest configs, Makefile test target, CODING-STANDARDS.md
 *      § Test line) — source:"stack-probe"
 *   5. None found — returns source:"none" (docs-only repo signal)
 *
 * "Docs-only skip" now means: every step above came back empty, INCLUDING the
 * stack probe → source:"none" → runVerificationGate returns skipped:"no-stack".
 *
 * @param {{ preferenceCommands?: string[], taskPlanVerify?: string, cwd: string, gsdDir?: string }} options
 * @returns {{ commands: string[], source: "task-plan"|"preference"|"package-json"|"stack-probe"|"none" }}
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

  // 4. Stack probe fallback — reuse forge-reverify's resolveVerifyCommand
  // (go.mod, Cargo.toml, pytest configs, Makefile test target, and the
  // CODING-STANDARDS.md § Test line). This closed the measured hole where the
  // gate ran 133/133 times with commands:[] in a repo with 200+ test suites:
  // steps 1-3 only knew package.json, so every non-npm stack was "docs-only".
  // Lazy require, narrowed to MODULE_NOT_FOUND of that module: an installed
  // copy missing the sibling degrades to the pre-existing "none", any other
  // throw is a real defect and must surface.
  try {
    const { resolveVerifyCommand } = require("./forge-reverify.js");
    const argv = resolveVerifyCommand(cwd, options.gsdDir || undefined);
    if (Array.isArray(argv) && argv.length > 0) {
      // argv is guaranteed shell-safe by resolveVerifyCommand (it rejects any
      // command needing shell parsing), so a lossless space-join is exact.
      return { commands: [argv.join(" ")], source: "stack-probe" };
    }
  } catch (error) {
    const missingSelf = error && error.code === "MODULE_NOT_FOUND"
      && /forge-reverify\.js/.test(String(error.message || ""));
    if (!missingSelf) throw error;
  }

  // 5. Nothing found anywhere — genuine docs-only repo signal.
  return { commands: [], source: "none" };
}

// ── Resource wiring (S04/T02) ───────────────────────────────────────────────
//
// `forge-verify.js` is a THIN consumer (D10) of `forge-resources.js` /
// `forge-command-rewrite.js` — it computes ZERO worker/heap/ceiling numbers
// itself. The molde for this shape is `forge-hook.js:731-838` (S03's
// command-rewrite branch): pure lexical gate first (zero I/O), lazy require
// of the resolver only for a candidate command, W5 release-on-every-path,
// and a MEM008 outer guard so a missing/throwing resources module degrades
// the gate to exactly its pre-wiring behavior — same command, same verdict,
// process exit 0.
//
// D5: nothing here suspends, kills, or reprioritizes an already-running
// spawn — the clamp only ever shapes the NEXT spawnSync call.

/**
 * Attempt to acquire a resource-pool lease and a rewritten command for one
 * verification command. Returns byte-identical passthrough on every failure
 * mode (module missing, module throws, non-runner command, unrecognized
 * runner form) — never throws.
 *
 * @param {{
 *   command: string, cwd: string, timeoutMs: number, session?: string,
 *   gsdDir?: string|null,
 *   requireResources?: () => object, requireCommandRewrite?: () => object,
 * }} opts
 * @returns {{ command: string, env: object|null, handle: object|null, resourcesMod: object|null }}
 */
function acquireClampForCommand(opts) {
  const passthrough = { command: opts.command, env: null, handle: null, resourcesMod: null };
  let rewriteMod;
  try {
    rewriteMod = typeof opts.requireCommandRewrite === "function"
      ? opts.requireCommandRewrite()
      : require("./forge-command-rewrite.js");
  } catch {
    // Module missing/broken — fail-open, zero lease attempted (MEM008).
    return passthrough;
  }

  try {
    if (typeof rewriteMod.looksLikeRunnerCommand !== "function" ||
        !rewriteMod.looksLikeRunnerCommand(opts.command)) {
      // Pure lexical gate says "not a candidate" — no require of the
      // resolver, no lease taken (mirrors forge-hook.js B1).
      appendResourceEvent(opts.cwd, opts.gsdDir, "resource-clamp-skipped", {
        reason: "intact:not-runner-command",
      });
      return passthrough;
    }
  } catch {
    return passthrough;
  }

  // Candidate command — require the resolver lazily (fail-open if missing).
  let resourcesMod;
  try {
    resourcesMod = typeof opts.requireResources === "function"
      ? opts.requireResources()
      : require("./forge-resources.js");
    if (!resourcesMod || typeof resourcesMod.acquireCommandBudget !== "function" ||
        typeof resourcesMod.releaseCommandBudget !== "function") {
      throw new Error("forge-resources.js missing acquireCommandBudget/releaseCommandBudget");
    }
  } catch {
    return passthrough;
  }

  let handle = null;
  try {
    const contract = resourcesMod.acquireCommandBudget({
      cwd: opts.cwd,
      commandTimeoutMs: opts.timeoutMs,
      session: opts.session,
    });
    if (contract && contract.pool && contract.pool.handle &&
        Array.isArray(contract.pool.handle.slots) && contract.pool.handle.slots.length) {
      handle = contract.pool.handle;
    }

    if (contract && contract.enforcement === "off") {
      // `resources.enforcement: off` (S06/T03). The pref is documented as
      // "everything advisory/off" and S06's measurement matrix needs the
      // control-off half to be REAL — before this bypass the field travelled
      // in the contract and no consumer read it, so `off` clamped exactly
      // like `clamp`. Checked BEFORE `admit === false` so the emitted reason
      // names the operator's toggle, not the pressure that happened to
      // coincide with it. FAIL-SAFE: only the exact string `off` bypasses —
      // any other/unknown value leaves the control ON. D10: this reads the
      // value the resolver already returns; it derives nothing.
      if (handle) {
        try { resourcesMod.releaseCommandBudget(handle, { cwd: opts.cwd }); } catch { /* MEM008 */ }
      }
      appendResourceEvent(opts.cwd, opts.gsdDir, "resource-clamp-skipped", {
        reason: "intact:enforcement-off",
      });
      return passthrough;
    }

    if (contract && contract.admit === false) {
      // Critical pressure: admission refused. D3 is LOCKED — never refuse
      // the spawn. Skip the rewrite entirely and run the command
      // byte-identical rather than hand a zero-worker contract to the
      // planner (which would silently produce full parallelism, since
      // `--maxWorkers=0`/`VITEST_MAX_FORKS=0` are falsy to the runners).
      if (handle) {
        try { resourcesMod.releaseCommandBudget(handle, { cwd: opts.cwd }); } catch { /* MEM008 */ }
      }
      appendResourceEvent(opts.cwd, opts.gsdDir, "resource-clamp-skipped", {
        reason: "intact:admission-refused-advisory",
      });
      return passthrough;
    }

    const plan = rewriteMod.planRewrite(opts.command, contract, { cwd: opts.cwd });

    if (plan.outcome !== "rewritten") {
      // Unrecognized/refused form — release immediately (W5, non-error
      // intact path) and run the original command byte-identical.
      if (handle) {
        try { resourcesMod.releaseCommandBudget(handle, { cwd: opts.cwd }); } catch { /* MEM008 */ }
      }
      appendResourceEvent(opts.cwd, opts.gsdDir, "resource-clamp-skipped", {
        reason: `intact:${plan.reason}`,
      });
      return passthrough;
    }

    // Overlay: NODE_OPTIONS is never overwritten if the parent already
    // defines it — a human's choice always wins (same rule S03 conceded
    // three times, R3/R4).
    const overlay = {};
    let nodeOptionsReason = null;
    let rewrittenCommand = plan.command;
    if (process.env.NODE_OPTIONS) {
      nodeOptionsReason = "node-options-preserved-parent-defined";
      // forge-command-rewrite.js's vitest env-prefix embeds a LITERAL
      // `NODE_OPTIONS='...'` assignment directly in the rewritten command
      // STRING (not just spawnSync's `env` option) — a shell-level
      // per-command env assignment on the command line always wins over
      // the inherited/spawnSync-passed environment (`sh -c "NODE_OPTIONS=X
      // cmd"` sets NODE_OPTIONS=X for that exec regardless of what env was
      // passed in). Neutralizing the embedded assignment is the only way
      // this module (D10: it never reimplements forge-command-rewrite.js's
      // rewrite decision, it only refuses to let ITS OWN wiring override a
      // parent-defined NODE_OPTIONS) can honor the truth above for the
      // vitest runner. jest/playwright rewrite via argv flags only — they
      // never touch NODE_OPTIONS, so this is a no-op for them.
      if (plan.runner === "vitest") {
        rewrittenCommand = rewrittenCommand.replace(/NODE_OPTIONS='[^']*' /, "");
      }
    } else {
      overlay.NODE_OPTIONS = "--max-old-space-size=" + contract.heapMb;
    }

    appendResourceEvent(opts.cwd, opts.gsdDir, "resource-clamp-applied", {
      reason: plan.reason,
      runner: plan.runner,
      workers: contract.workers,
      ...(nodeOptionsReason ? { node_options_reason: nodeOptionsReason } : {}),
    });

    return { command: rewrittenCommand, env: overlay, handle, resourcesMod };
  } catch {
    // W5: release-on-error — a lease acquired above MUST be released here
    // before falling through with the command byte-identical.
    if (handle) {
      try { resourcesMod.releaseCommandBudget(handle, { cwd: opts.cwd }); } catch { /* MEM008 */ }
    }
    return passthrough;
  }
}

/**
 * Best-effort event append for the resource-clamp wiring, mirroring the
 * owner-resolution used by the CLI's `verify` event (never plants `.gsd/`
 * in a repo that doesn't own the run). Silent-fail (MEM008) — event
 * logging never affects the gate's verdict.
 */
function appendResourceEvent(cwd, gsdDirOpt, kind, payload) {
  try {
    const cwdAbs = resolve(cwd);
    const ownerGsd = gsdDirOpt ? resolve(gsdDirOpt) : null;
    const ownerRoot = ownerGsd ? dirname(ownerGsd) : resolveOwner(cwdAbs);
    const eventsDir = ownerGsd ? join(ownerGsd, "forge")
                    : ownerRoot ? join(ownerRoot, ".gsd", "forge")
                    : null;
    if (!eventsDir) return;
    mkdirSync(eventsDir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), kind, ...payload });
    appendFileSync(join(eventsDir, "events.jsonl"), line + "\n", "utf-8");
  } catch {
    /* MEM008 — silent-fail */
  }
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
    gsdDir: options.gsdDir,
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

    // Resource wiring (S04/T02, D10 zero sizing rules here): fail-open,
    // byte-identical passthrough when the resolver is unavailable, not a
    // candidate, or refuses to rewrite.
    let commandToRun = command;
    let overlay = null;
    let leaseHandle = null;
    let leaseMod = null;
    try {
      const clamp = acquireClampForCommand({
        command,
        cwd: options.cwd,
        timeoutMs,
        session: options.session,
        gsdDir: options.gsdDir,
        requireResources: options.requireResources,
        requireCommandRewrite: options.requireCommandRewrite,
      });
      commandToRun = clamp.command;
      overlay = clamp.env;
      leaseHandle = clamp.handle;
      leaseMod = clamp.resourcesMod;
    } catch {
      // Outer MEM008 guard — acquireClampForCommand already fails open
      // internally, but a caller-side surprise never escapes to the spawn.
      commandToRun = command;
      overlay = null;
      leaseHandle = null;
      leaseMod = null;
    }

    // Platform branch hardcoded — no user-controlled shell binary
    const shellBin = process.platform === "win32" ? "cmd" : "sh";
    const shellArgs = process.platform === "win32" ? ["/c", commandToRun] : ["-c", commandToRun];

    // env: explicit process.env + overlay (additive at this established
    // call site — before S04 this option was absent, inheriting
    // process.env by Node default; that default is preserved verbatim,
    // only the overlay is new).
    const env = overlay ? { ...process.env, ...overlay } : process.env;

    let result;
    try {
      // shell: false — explicit argv binary + args (avoids Node DEP0190, prevents injection)
      result = spawnSync(shellBin, shellArgs, {
        cwd: options.cwd,  // --cwd is a spawnSync option, never shell-interpolated
        stdio: "pipe",
        encoding: "utf-8",
        timeout: timeoutMs,
        env,
      });
    } finally {
      // W5: released on EVERY exit path of this spawn — success, failure,
      // timeout, or spawnSync throwing outright.
      if (leaseHandle && leaseMod && typeof leaseMod.releaseCommandBudget === "function") {
        try { leaseMod.releaseCommandBudget(leaseHandle, { cwd: options.cwd }); } catch { /* MEM008 */ }
      }
    }

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

/**
 * Extract the `verify:` field from a plan's YAML frontmatter.
 *
 * Supports three shapes:
 *   - Plain string:    verify: npm test
 *   - Inline array:    verify: [npm test, npm run lint]
 *   - Multi-line list: verify:\n  - npm test\n  - npm run lint
 *
 * Returns the commands joined with " && ", or null if there is no frontmatter
 * or no `verify:` field. Throws (message consumed by the CLI catch → exit 2) if
 * the field resolves to a non-string shape.
 *
 * NOTE: the single-line regex anchors trailing whitespace to `[ \t]*` (NOT
 * `\s*`). `\s` matches `\n`, so `\s*` let the single-line pattern span the
 * newline into a multi-line YAML list and capture its first "- item" as a plain
 * string (e.g. taskPlanVerify = "- npm test"), which never reached the
 * multi-line branch below and produced spurious verification failures.
 */
function parsePlanVerify(planContent) {
  // Normalize CRLF/CR to LF at entry, before the frontmatter match — the
  // multi-line branch below re-scans `frontmatter`, which descends from this
  // match, so normalizing here (not per-shape) fixes all three shapes at once.
  const src = String(planContent).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const fmMatch = src.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const frontmatter = fmMatch[1];

  let taskPlanVerify = null;
  // Same-line whitespace only ([ \t]*) — must not cross into a YAML list.
  // (\S.*) forces the captured value to start with a non-space char, so a
  // `verify:` line that is blank except for trailing spaces (the multi-line
  // list header) does NOT match here and falls through to the block branch.
  const verifyLineMatch = frontmatter.match(/^verify:[ \t]*(\S.*)$/m);
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
    const verifyBlockMatch = frontmatter.match(/^verify:[ \t]*\n((?:\s+-\s+.+\n?)+)/m);
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
    throw new Error("verify: field must be a string or array of strings");
  }
  return taskPlanVerify;
}

// ── Verify policy (verify.mode / verify.timeout_ms) ──────────────────────────
//
// Per-task tests are the defense against self-reported "done", but on a tight
// machine they can blow memory and the operator may prefer not to pay them on
// an exploratory run. The decision is the operator's, taken at milestone
// activation (verify.mode: ask) or by preference — and an "off" NEVER reads as
// a pass: the gate reports skipped:"disabled-by-pref" and the executor must
// surface it in the SUMMARY and the result block.
//
// Precedence: --mode flag > run-scoped decision file (written by forge-auto's
// activation ask) > prefs verify.mode > 'auto'. An unresolved 'ask' that
// reaches the gate (forge-next, loose task, headless) degrades to 'auto' —
// skipping tests must be an explicit choice, never a fallthrough.

function resolveVerifyPolicy(options) {
  const opts = options || {};
  const valid = (v) => v === "auto" || v === "off";
  let mode = null;
  let source = "default";
  if (valid(opts.cliMode)) { mode = opts.cliMode; source = "cli"; }
  if (mode === null && opts.gsdDir) {
    try {
      const raw = JSON.parse(readFileSync(join(opts.gsdDir, "forge", "verify-mode.json"), "utf-8"));
      const fileMode = raw && String(raw.mode || "").toLowerCase();
      if (valid(fileMode)) { mode = fileMode; source = "run-file"; }
    } catch { /* absent/unreadable → next layer */ }
  }
  let timeoutMs = Number.isInteger(opts.cliTimeoutMs) && opts.cliTimeoutMs > 0 ? opts.cliTimeoutMs : null;
  if (mode === null || timeoutMs === null) {
    try {
      const { readPrefs } = require("./forge-prefs.js");
      const prefs = (readPrefs(opts.cwd || process.cwd()) || {}).prefs || {};
      const v = prefs.verify || {};
      const prefMode = String(v.mode || "").toLowerCase();
      if (mode === null && valid(prefMode)) { mode = prefMode; source = "prefs"; }
      if (mode === null && prefMode === "ask") { mode = "auto"; source = "prefs-ask-degraded"; }
      if (timeoutMs === null && Number.isInteger(v.timeout_ms) && v.timeout_ms > 0) timeoutMs = v.timeout_ms;
    } catch (error) {
      const missingSelf = error && error.code === "MODULE_NOT_FOUND"
        && /forge-prefs\.js/.test(String(error.message || ""));
      if (!missingSelf) throw error;
    }
  }
  return { mode: mode || "auto", source, timeoutMs: timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS };
}

// ── Verification evidence emission ────────────────────────────────────────────
//
// The executor's `verification_evidence:` block used to be hand-derived by the
// worker (command/exit_code recalled from conversation, matched_line from a
// manual grep) — the single biggest measured fabrication source in the system.
// The gate already holds every value: it ran the commands (checks[]) and the
// evidence-log file set is resolvable deterministically. Emit the finished
// block from here so the worker's only job is to paste it.

/**
 * Build verification_evidence entries from the gate's own checks[].
 *
 * matched_line semantics mirror the completer's classifier exactly (substring
 * of the log line's `cmd` field, case-sensitive, first 80 chars of the claimed
 * command): first hit across the resolved file set wins; no hit → 0 with the
 * last file checked named, so the zero stays diagnosable.
 *
 * @param {{ checks: object[], ownerRoot: string|null, milestone?: string|null, slice?: string|null, unit?: string|null }} options
 * @returns {{ entries: object[]|null, files?: string[], reason?: string }}
 */
function buildVerificationEvidence(options) {
  const checks = Array.isArray(options.checks) ? options.checks : [];
  if (!options.ownerRoot) return { entries: [], files: [], reason: "no-owner-root" };
  let resolveEvidenceFiles;
  try {
    ({ resolveEvidenceFiles } = require("./forge-evidence-path.js"));
  } catch (error) {
    const missingSelf = error && error.code === "MODULE_NOT_FOUND"
      && /forge-evidence-path\.js/.test(String(error.message || ""));
    if (!missingSelf) throw error;
    return { entries: null, reason: "evidence-path-module-missing" };
  }
  const resolved = resolveEvidenceFiles(options.ownerRoot, {
    milestone: options.milestone || null,
    slice: options.slice || null,
    unit: options.unit || null,
  });
  const files = (resolved && resolved.files) || [];
  // Empty resolved SET → verification_evidence: [] — the one legitimate
  // trigger for the completer's evidence_log_missing classification.
  if (files.length === 0) return { entries: [], files: [] };
  const dir = join(options.ownerRoot, ".gsd", "forge");
  const fileLines = files.map((f) => {
    try { return { name: f.name, lines: readFileSync(join(dir, f.name), "utf-8").split(/\r?\n/) }; }
    catch { return { name: f.name, lines: [] }; }
  });
  const entries = [];
  for (const check of checks) {
    const needle = String(check.command || "").slice(0, 80);
    let matchedLine = 0;
    let evidenceFile = fileLines[fileLines.length - 1].name;
    outer: for (const file of fileLines) {
      for (let i = 0; i < file.lines.length; i++) {
        if (!file.lines[i]) continue;
        let cmd = "";
        try { cmd = String(JSON.parse(file.lines[i]).cmd || ""); } catch { continue; }
        if (needle && cmd.includes(needle)) { matchedLine = i + 1; evidenceFile = file.name; break outer; }
      }
    }
    entries.push({
      command: check.command,
      exit_code: check.exitCode,
      matched_line: matchedLine,
      evidence_file: evidenceFile,
    });
  }
  return { entries, files: files.map((f) => f.name) };
}

/**
 * Render entries as the exact YAML block T##-SUMMARY.md frontmatter expects.
 * Applies the executor's command string rules (≤180 chars, single line,
 * double-quoted) so the output is paste-ready with zero model judgement.
 */
function formatEvidenceYaml(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "verification_evidence: []";
  const lines = ["verification_evidence:"];
  for (const entry of entries) {
    const command = String(entry.command || "").replace(/\s+/g, " ").trim().slice(0, 180);
    lines.push(`  - command: ${JSON.stringify(command)}`);
    lines.push(`    exit_code: ${Number.isInteger(entry.exit_code) ? entry.exit_code : 1}`);
    lines.push(`    matched_line: ${Number.isInteger(entry.matched_line) ? entry.matched_line : 0}`);
    lines.push(`    evidence_file: ${JSON.stringify(String(entry.evidence_file || ""))}`);
  }
  return lines.join("\n");
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = { discoverCommands, runVerificationGate, formatFailureContext, isLikelyCommand, parsePlanVerify, buildVerificationEvidence, formatEvidenceYaml, resolveVerifyPolicy };

// ── CLI entrypoint ────────────────────────────────────────────────────────────

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    let planPath = null;
    let cwd = process.cwd();
    let unit = "unknown";
    let preferenceCommands = [];
    let timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
    let timeoutFromCli = null;
    let gsdDir = null;
    let milestone = null;
    let slice = null;
    let emitEvidence = false;
    let cliMode = null;
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
      } else if (arg === "--gsd-dir" && args[i + 1] !== undefined) {
        // Explicit owner. The orchestrator knows which project this run belongs
        // to; in worktree isolation mode `.gsd/` is not under CODE_DIR at all,
        // so walking up from --cwd cannot find it.
        gsdDir = args[++i];
      } else if (arg === "--milestone" && args[i + 1] !== undefined) {
        milestone = args[++i];
      } else if (arg === "--slice" && args[i + 1] !== undefined) {
        slice = args[++i];
      } else if (arg === "--emit-evidence") {
        // Attach verification_evidence + verification_evidence_yaml to the
        // output so the worker pastes the block instead of deriving it.
        emitEvidence = true;
      } else if (arg === "--mode" && args[i + 1] !== undefined) {
        // Explicit policy override (auto|off). 'ask' is never a gate value —
        // it resolves at milestone activation, upstream of this CLI.
        cliMode = String(args[++i]).toLowerCase();
        if (cliMode !== "auto" && cliMode !== "off") {
          process.stderr.write(JSON.stringify({ error: `Invalid --mode value: ${cliMode} (auto|off)` }) + "\n");
          process.exit(2);
        }
      } else if (arg === "--preference" && args[i + 1] !== undefined) {
        preferenceCommands.push(args[++i]);
      } else if (arg === "--timeout" && args[i + 1] !== undefined) {
        const parsed = parseInt(args[++i], 10);
        if (isNaN(parsed) || parsed <= 0) {
          process.stderr.write(JSON.stringify({ error: `Invalid --timeout value: ${args[i]}` }) + "\n");
          process.exit(2);
        }
        timeoutMs = parsed;
        timeoutFromCli = parsed;
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

      taskPlanVerify = parsePlanVerify(planContent);
    }

    const startTime = Date.now();
    // Operator policy (verify.mode / verify.timeout_ms) — resolved before the
    // gate so an "off" run executes nothing at all, and a prefs timeout applies
    // when the CLI did not pass one.
    const policy = resolveVerifyPolicy({ cliMode, cliTimeoutMs: timeoutFromCli, gsdDir, cwd });
    const result = policy.mode === "off"
      ? {
          // Anti-silence: this is an operator choice, not a verified pass —
          // the executor surfaces it in the SUMMARY and the result block.
          passed: true,
          checks: [],
          discoverySource: "policy-off",
          skipped: "disabled-by-pref",
          policy_source: policy.source,
          timestamp: Date.now(),
        }
      : runVerificationGate({
          cwd,
          preferenceCommands: preferenceCommands.length > 0 ? preferenceCommands : undefined,
          taskPlanVerify: taskPlanVerify || undefined,
          commandTimeoutMs: timeoutFromCli !== null ? timeoutFromCli : policy.timeoutMs,
          gsdDir,
        });
    const duration = Date.now() - startTime;

    // Telemetry is recorded against the project that *owns* the work, never
    // against whatever repo the commands happened to run in.
    //
    // This was `mkdirSync(join(cwd, ".gsd", "forge"), { recursive: true })`,
    // and the `-p` semantics planted a `.gsd/` in every repo a run reached
    // into — the exact marker the app uses to detect projects. Measured: 5 of
    // 18 registered projects on the author's machine were repos this line
    // enrolled; `asgard`, `saga` and `skuld` held nothing but the events.jsonl
    // written here. See `scripts/forge-workspace.js` for the full account.
    //
    // Owner resolution: `--gsd-dir` when the orchestrator passed one (required
    // under worktree isolation, where `.gsd/` is not below CODE_DIR at all),
    // otherwise the nearest ancestor that is a real project. No owner means no
    // record: skipping loses one telemetry line, while writing would create a
    // phantom project that outlives the run by months.
    const cwdAbs = resolve(cwd);
    const ownerGsd = gsdDir ? resolve(gsdDir) : null;
    const ownerRoot = ownerGsd ? dirname(ownerGsd) : resolveOwner(cwdAbs);
    const eventsDir = ownerGsd ? join(ownerGsd, "forge")
                    : ownerRoot ? join(ownerRoot, ".gsd", "forge")
                    : null;

    if (eventsDir) {
      const eventLine = JSON.stringify({
        ts: new Date().toISOString(),
        event: "verify",
        unit,
        // Present only when the verified repo is not the owner — that is the
        // cross-repo fact the old layout expressed by scattering directories.
        ...(ownerRoot && cwdAbs !== ownerRoot
            ? { repo: basename(cwdAbs), repo_path: cwdAbs }
            : {}),
        discovery_source: result.discoverySource,
        commands: result.checks.map(c => c.command),
        passed: result.passed,
        ...(result.skipped ? { skipped: result.skipped } : {}),
        duration_ms: duration,
      });
      // `.gsd/` exists by construction here, so this only creates `forge/`.
      mkdirSync(eventsDir, { recursive: true });
      // No try/catch — I/O errors propagate to caller (orchestrator handles)
      appendFileSync(join(eventsDir, "events.jsonl"), eventLine + "\n", "utf-8");
    } else {
      // Visible, not silent: an unrecorded verify must be arguable with.
      process.stderr.write(JSON.stringify({
        warning: `no owning Forge project at or above ${cwdAbs} — verify event not recorded`,
      }) + "\n");
    }

    if (emitEvidence) {
      // Evidence axes use the unit's task token (evidence~M~S~T##.jsonl),
      // while --unit carries the dispatch form ("execute-task/T##").
      const unitToken = unit.includes("/") ? unit.split("/").pop() : unit;
      const evidence = buildVerificationEvidence({
        checks: result.checks || [],
        ownerRoot,
        milestone,
        slice,
        unit: unitToken,
      });
      result.verification_evidence = evidence.entries;
      result.verification_evidence_yaml = formatEvidenceYaml(evidence.entries || []);
      if (evidence.reason) result.verification_evidence_note = evidence.reason;
    }

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
