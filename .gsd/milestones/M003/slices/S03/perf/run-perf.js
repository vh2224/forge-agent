#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Require forge-verifier module — resolves relative to this script's location.
// Path: .gsd/milestones/M003/slices/S03/perf/ → scripts/forge-verifier.js is 5 hops up + 1 down.
const verifierPath = path.resolve(__dirname, '../../../../../../scripts/forge-verifier');
const { verifyArtifact } = require(verifierPath);

// ── Configuration ─────────────────────────────────────────────────────────────

const SCRATCH_DIR = path.join(os.tmpdir(), 'forge-verifier-perf-' + Date.now());
const N_ARTIFACTS = 10;
const BUDGET_MS = 2000;

// ── Setup: Generate synthetic 10-artifact workload ──────────────────────────

function setup() {
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  const artifacts = [];

  for (let i = 0; i < N_ARTIFACTS; i++) {
    const filename = `mod-${i}.js`;
    const filepath = path.join(SCRATCH_DIR, filename);

    // Each module is ≥ 15 lines:
    // - Header comment
    // - 'use strict'
    // - Optional require of predecessor
    // - module.exports with functions
    // - Filler comments to reach 15+ lines
    const imports = i > 0 ? `const prev = require('./mod-${i - 1}');\n` : '';
    const content = (
      `'use strict';\n` +
      imports +
      `module.exports = {\n` +
      `  value: ${i},\n` +
      `  label: 'mod-${i}',\n` +
      `  plus: (x) => x + ${i},\n` +
      `  minus: (x) => x - ${i},\n` +
      `  times: (x) => x * ${i},\n` +
      `  divide: (x) => x / ${i || 1},\n` +
      `  mod: (x) => x % (${i} || 1),\n` +
      `};\n` +
      `// filler line 1\n` +
      `// filler line 2\n` +
      `// filler line 3\n` +
      `// filler line 4\n` +
      `// filler line 5\n` +
      `// filler line 6\n` +
      `// filler line 7\n`
    );

    fs.writeFileSync(filepath, content);

    // Relative path for artifact declaration (from current working directory)
    const relPath = path.relative(process.cwd(), filepath);
    artifacts.push({
      path: relPath,
      provides: 'synthetic module',
      min_lines: 10,
    });
  }

  return artifacts;
}

// ── Teardown: Clean up scratch directory ──────────────────────────────────

function teardown() {
  try {
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  } catch (e) {
    // Silently ignore cleanup errors
  }
}

// ── Time a single verification pass ──────────────────────────────────────────

function timePass(mustHaves) {
  // Use process.hrtime.bigint() for precise nanosecond timing.
  // Per MEM067: distinguish in-script work time from wall-clock measurement.
  const t0 = process.hrtime.bigint();
  const result = verifyArtifact(mustHaves, [], { cwd: process.cwd() });
  const t1 = process.hrtime.bigint();

  // Convert nanoseconds to milliseconds
  const durationNs = t1 - t0;
  const durationMs = Number(durationNs) / 1e6;

  // Count rows verified
  const rowsScanned = (result && result.rows) ? result.rows.length : 0;

  return {
    ms: durationMs,
    rows: rowsScanned,
  };
}

// ── Main: Run 3 passes (cold / warm / hot) ──────────────────────────────────

try {
  const artifacts = setup();
  const mustHaves = {
    artifacts,
    key_links: [],
  };

  // Per MEM073: per-invocation file cache is cleared at verifyArtifact entry.
  // For accurate cold measurement, we invoke the harness for the first time here
  // (fresh scratch directory, not warmed by prior runs).
  const passes = {};

  // Cold pass: first invocation after scratch file creation
  passes.cold = timePass(mustHaves);

  // Warm pass: second invocation, OS page cache seeded
  passes.warm = timePass(mustHaves);

  // Hot pass: third+ invocation, all files in memory cache
  passes.hot = timePass(mustHaves);

  // ── Generate report ───────────────────────────────────────────────────────
  const report = {
    node_version: process.version,
    platform: process.platform + ' ' + os.release(),
    n_artifacts: N_ARTIFACTS,
    scratch_dir: SCRATCH_DIR,
    passes,
    budget_ms: BUDGET_MS,
    hot_within_budget: passes.hot.ms <= BUDGET_MS,
  };

  // Log JSON to stdout for machine-readable inspection
  console.log(JSON.stringify(report, null, 2));

  // ── Append timestamped run block to PERF-RESULTS.md ─────────────────────
  const mdPath = path.join(__dirname, 'PERF-RESULTS.md');
  const runBlock = [
    `## Run — ${new Date().toISOString()}`,
    ``,
    `- **Node:** ${report.node_version}`,
    `- **Platform:** ${report.platform}`,
    `- **Artifacts:** ${report.n_artifacts}`,
    `- **Cold pass:** ${report.passes.cold.ms.toFixed(1)} ms (${report.passes.cold.rows} rows)`,
    `- **Warm pass:** ${report.passes.warm.ms.toFixed(1)} ms`,
    `- **Hot pass:** ${report.passes.hot.ms.toFixed(1)} ms`,
    `- **Budget:** ${report.budget_ms} ms (hot cache)`,
    `- **Hot within budget:** ${report.hot_within_budget ? '✓' : '✗'}`,
    ``,
    `---`,
    ``,
  ].join('\n');

  // Check if PERF-RESULTS.md exists; if not, prepend header
  const headerBlock = (
    `# S03 Verifier — Perf Measurements\n` +
    `\n` +
    `**Purpose:** Empirical record of \`scripts/forge-verifier.js\` wall-clock\n` +
    `cost across cache states on Windows, measured against the C8 budget\n` +
    `(≤ 2000 ms / 10 artifacts / hot cache).\n` +
    `\n` +
    `**Methodology:**\n` +
    `- 10 synthetic JS modules generated in \`os.tmpdir()\`\n` +
    `- Each module ≥ 15 lines, imports its predecessor (mod-i requires mod-(i-1))\n` +
    `- \`verifyArtifact\` invoked 3 times in sequence: cold / warm / hot\n` +
    `- Cold ≈ first call after scratch-file creation (best approximation\n` +
    `  without full reboot). True cold cache (post-reboot, post-Defender-scan)\n` +
    `  will exceed these numbers — documented as caveat below.\n` +
    `- Warm ≈ second call; OS cache seeded.\n` +
    `- Hot ≈ third call; all files hot in pagecache + Node module cache.\n` +
    `\n` +
    `**Windows-specific caveats:**\n` +
    `- Windows Defender real-time scanning adds 50–200 ms per file read\n` +
    `  on initial access; subsequent reads hit the in-memory cache.\n` +
    `- Corporate AV (CrowdStrike, SentinelOne, etc.) may interpose on\n` +
    `  syscalls; measurement assumes standard consumer Defender only.\n` +
    `- NTFS stat cost is higher than ext4 by 2–3× for the same file.\n` +
    `\n` +
    `**Budget interpretation:** The C8 budget is assumed for hot cache (the\n` +
    `typical case — complete-slice runs once per slice, after the slice's\n` +
    `own file I/O has warmed the cache). Cold/warm are recorded for\n` +
    `transparency but not gated by the budget.\n` +
    `\n` +
    `---\n` +
    `\n`
  );

  if (!fs.existsSync(mdPath)) {
    fs.writeFileSync(mdPath, headerBlock + runBlock, 'utf-8');
  } else {
    fs.appendFileSync(mdPath, runBlock, 'utf-8');
  }

} finally {
  teardown();
}
