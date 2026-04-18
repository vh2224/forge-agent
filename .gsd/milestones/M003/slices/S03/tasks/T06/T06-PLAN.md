---
id: T06
slice: S03
milestone: M003
tag: docs
title: "Perf smoke — cold/warm/hot measurements on Windows + SUMMARY appendix"
status: planned
planned: 2026-04-16
must_haves:
  truths:
    - "A perf-harness script at `.gsd/milestones/M003/slices/S03/perf/run-perf.js` times the verifier over 10 synthetic artifacts, running 3 passes: cold (post-cache-flush), warm (second run), hot (third+ run)."
    - "Measurements captured in `.gsd/milestones/M003/slices/S03/perf/PERF-RESULTS.md` with wall-clock ms per pass + candidates_scanned counter from walker."
    - "Results cited in `S03-SUMMARY.md` under `## Performance` appendix: hot-cache timing, warm-cache timing, cold-cache timing, all three against the ≤ 2s/10-artifact budget (C8)."
    - "If hot-cache timing exceeds 2s → explicitly document in SUMMARY as a budget miss with a follow-up ticket note, do NOT silently pass."
    - "Perf harness tolerates being run without elevated permissions — no admin/root required."
    - "Windows-specific caveats documented: Defender real-time scan, antivirus interception, NTFS stat overhead — recorded in PERF-RESULTS.md narrative."
  artifacts:
    - path: .gsd/milestones/M003/slices/S03/perf/run-perf.js
      provides: "Synthetic 10-artifact workload + 3-pass timer. CommonJS, zero deps. Generates scratch fixtures, invokes verifyArtifact directly, measures process.hrtime.bigint() around the call, aggregates per-pass ms."
      min_lines: 60
    - path: .gsd/milestones/M003/slices/S03/perf/PERF-RESULTS.md
      provides: "Human-readable perf report: environment (OS, Node version, antivirus), 10-artifact timings per pass, candidates_scanned counts, interpretation vs budget."
      min_lines: 30
  key_links:
    - from: .gsd/milestones/M003/slices/S03/perf/run-perf.js
      to: scripts/forge-verifier.js
      via: "require('../../../../../../scripts/forge-verifier') — invokes verifyArtifact directly"
expected_output:
  - .gsd/milestones/M003/slices/S03/perf/run-perf.js
  - .gsd/milestones/M003/slices/S03/perf/PERF-RESULTS.md
---

# T06: Perf smoke — cold/warm/hot measurements

**Slice:** S03  **Milestone:** M003  **Tag:** docs

## Goal

Measure the verifier's wall-clock cost on a 10-artifact synthetic workload across three cache states (cold / warm / hot) on the actual Windows development environment. Record results in a perf artifact and cite them in the slice SUMMARY against the C8 budget (≤ 2s/10-artifact hot cache).

## Must-Haves

### Truths
- Running `node .gsd/milestones/M003/slices/S03/perf/run-perf.js` from the repo root:
  - Generates 10 scratch JS files on disk (each ≥ 15 lines, mutually referencing via require to exercise the walker).
  - Invokes `verifyArtifact` 3 times, measuring `process.hrtime.bigint()` per call.
  - Prints per-pass ms to stdout and writes a summary block to `PERF-RESULTS.md`.
  - Cleans up scratch files at the end.
- `PERF-RESULTS.md` has at least 3 timing entries (cold/warm/hot), environment block, and verdict vs budget.
- `S03-SUMMARY.md` (written later by completer) cites the hot-cache timing explicitly.

### Artifacts
- `.gsd/milestones/M003/slices/S03/perf/run-perf.js` — CommonJS harness, ≥ 60 lines.
- `.gsd/milestones/M003/slices/S03/perf/PERF-RESULTS.md` — narrative report, ≥ 30 lines.

### Key Links
- `perf/run-perf.js` → `scripts/forge-verifier.js` via `require` of the verifier module.

## Steps

1. Create `.gsd/milestones/M003/slices/S03/perf/` directory.

2. **run-perf.js** — structure:
   ```javascript
   'use strict';
   const fs = require('fs');
   const path = require('path');
   const os = require('os');
   const { verifyArtifact } = require(path.resolve(__dirname, '../../../../../../scripts/forge-verifier'));

   const SCRATCH_DIR = path.join(os.tmpdir(), 'forge-verifier-perf-' + Date.now());
   const N_ARTIFACTS = 10;

   function setup() {
     fs.mkdirSync(SCRATCH_DIR, { recursive: true });
     const artifacts = [];
     for (let i = 0; i < N_ARTIFACTS; i++) {
       const filename = `mod-${i}.js`;
       const imports = i > 0 ? `const prev = require('./mod-${i - 1}');\n` : '';
       const content = `'use strict';\n${imports}module.exports = { value: ${i}, label: 'mod-${i}', plus: (x) => x + ${i}, minus: (x) => x - ${i}, times: (x) => x * ${i}, divide: (x) => x / ${i || 1}, mod: (x) => x % (${i} || 1) };\n// filler line 1\n// filler line 2\n// filler line 3\n// filler line 4\n// filler line 5\n// filler line 6\n// filler line 7\n// filler line 8\n`;
       fs.writeFileSync(path.join(SCRATCH_DIR, filename), content);
       artifacts.push({ path: path.relative(process.cwd(), path.join(SCRATCH_DIR, filename)), provides: 'x', min_lines: 10 });
     }
     return artifacts;
   }

   function teardown() {
     try { fs.rmSync(SCRATCH_DIR, { recursive: true, force: true }); } catch {}
   }

   function timePass(mustHaves) {
     const t0 = process.hrtime.bigint();
     const result = verifyArtifact(mustHaves, [], { cwd: process.cwd() });
     const t1 = process.hrtime.bigint();
     return { ms: Number(t1 - t0) / 1e6, rows: result.rows.length };
   }

   try {
     const artifacts = setup();
     const mustHaves = { artifacts, key_links: [] };

     const passes = {};
     // "cold" — first call after fresh scratch generation (best approximation of cold cache without reboot)
     passes.cold = timePass(mustHaves);
     passes.warm = timePass(mustHaves);
     passes.hot = timePass(mustHaves);

     const report = {
       node_version: process.version,
       platform: process.platform + ' ' + os.release(),
       n_artifacts: N_ARTIFACTS,
       scratch_dir: SCRATCH_DIR,
       passes,
       budget_ms: 2000,
       hot_within_budget: passes.hot.ms <= 2000
     };
     console.log(JSON.stringify(report, null, 2));

     // Append to PERF-RESULTS.md
     const mdPath = path.join(__dirname, 'PERF-RESULTS.md');
     // (writer block — see step 3)
   } finally {
     teardown();
   }
   ```

3. Extend `run-perf.js` with a writer that appends a timestamped run block to `PERF-RESULTS.md`:
   ```javascript
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
     ``
   ].join('\n');
   // If PERF-RESULTS.md doesn't exist, write header first (see step 4); else append.
   ```

4. **PERF-RESULTS.md** seed — pre-create with header:
   ```markdown
   # S03 Verifier — Perf Measurements

   **Purpose:** Empirical record of `scripts/forge-verifier.js` wall-clock
   cost across cache states on Windows, measured against the C8 budget
   (≤ 2000 ms / 10 artifacts / hot cache).

   **Methodology:**
   - 10 synthetic JS modules generated in `os.tmpdir()`
   - Each module ≥ 15 lines, imports its predecessor (mod-i requires mod-(i-1))
   - `verifyArtifact` invoked 3 times in sequence: cold / warm / hot
   - Cold ≈ first call after scratch-file creation (best approximation
     without full reboot). True cold cache (post-reboot, post-Defender-scan)
     will exceed these numbers — documented as caveat below.
   - Warm ≈ second call; OS cache seeded.
   - Hot ≈ third call; all files hot in pagecache + Node module cache.

   **Windows-specific caveats:**
   - Windows Defender real-time scanning adds 50–200 ms per file read
     on initial access; subsequent reads hit the in-memory cache.
   - Corporate AV (CrowdStrike, SentinelOne, etc.) may interpose on
     syscalls; measurement assumes standard consumer Defender only.
   - NTFS stat cost is higher than ext4 by 2–3× for the same file.

   **Budget interpretation:** The C8 budget is assumed for hot cache (the
   typical case — complete-slice runs once per slice, after the slice's
   own file I/O has warmed the cache). Cold/warm are recorded for
   transparency but not gated by the budget.

   ---
   ```

5. Run the perf harness. Capture stdout JSON. Let the writer append a `## Run — ...` block to PERF-RESULTS.md.

6. Inspect the result:
   - If hot ≤ 2000 ms → record `within budget` in SUMMARY (for the completer to cite later).
   - If hot > 2000 ms → add a note at the top of PERF-RESULTS.md:
     ```markdown
     **⚠ Budget exceeded:** hot-cache pass measured <N> ms, exceeding
     the 2000 ms budget. Candidate causes: <hypothesis>. Follow-up
     ticket required before M003 closes.
     ```
     Do NOT silently let this slide; the RISK card (warning 4) was explicit.

7. Re-run 3–5 times to confirm stability (hot passes should cluster within ±20%). Record each run as a separate `## Run — ...` block in PERF-RESULTS.md.

8. Do NOT commit scratch files — harness cleans up `SCRATCH_DIR` via `teardown()`. Commit only `run-perf.js` + `PERF-RESULTS.md`.

9. Cite hot-cache number in this task's `T06-SUMMARY.md` so `forge-completer` can pull it into `## Performance` appendix of `S03-SUMMARY.md` automatically.

## Standards

- **Target directory:** `.gsd/milestones/M003/slices/S03/perf/` — ad-hoc benchmark artifacts live inside the slice, not `scripts/` (benchmarks aren't shipped tooling).
- **Reuse:** `verifyArtifact` from `scripts/forge-verifier.js`. `fs`, `path`, `os` built-ins. `process.hrtime.bigint` for timing.
- **Naming:** `run-perf.js` (descriptive one-purpose script), `PERF-RESULTS.md` (human-readable record). No `forge-` prefix — this is slice-local scratch, not a general-purpose tool.
- **Lint command:** `node --check .gsd/milestones/M003/slices/S03/perf/run-perf.js`.
- **Pattern:** ad-hoc perf benchmark — no existing pattern to follow; keep it simple and self-contained.
- **Path handling:** `path.join` / `path.resolve` throughout; `os.tmpdir()` for scratch.
- **Error handling:** top-level try/finally around `setup/teardown` to ensure scratch cleanup even on harness crash. Non-blocking: harness exit 0 on success, exit 1 on measurement error (but teardown runs either way).
- **Zero deps.**

## Context

- **Read first:** `scripts/forge-verifier.js` (T01–T03 output) — confirm `verifyArtifact` signature and cwd handling.
- **Read:** S03-RISK.md warning 4 + executor note 8 ("research-slice should run 3 measurements: cold, warm, hot — reportable in SUMMARY; orchestrator assumes hot salvo nota contrária"). T06 operationalises this.
- **Prior decisions to respect:**
  - C8 budget: 2s/10 artifacts. Hot-cache is the assumed baseline.
  - RISK warning 4: cold-cache is 5–10× slower; recorded for transparency, not gated.
  - M002 zero-deps: no `benchmark.js`, no `perf_hooks` imports needed — `process.hrtime.bigint` is built-in.
- **Known caveat:** "Cold" in this task is approximated by first-run-after-scratch-gen, not true post-reboot cold. True cold requires OS-level actions beyond the Node script scope. Documented in PERF-RESULTS.md methodology.
- **Non-goals:**
  - Full CI perf regression infra (deferred; this is a point-in-time audit).
  - Measuring on Linux/macOS (forge-agent is developed on Windows; other OSes are inherited caveats).
  - Micro-benchmarking individual regex patterns (scope is end-to-end `verifyArtifact`).
