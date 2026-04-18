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

## Run — 2026-04-18T19:27:02.257Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 18.3 ms (10 rows)
- **Warm pass:** 6.2 ms
- **Hot pass:** 5.2 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
## Run — 2026-04-18T19:27:04.242Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 9.1 ms (10 rows)
- **Warm pass:** 5.8 ms
- **Hot pass:** 5.3 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
## Run — 2026-04-18T19:27:04.365Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 11.1 ms (10 rows)
- **Warm pass:** 7.4 ms
- **Hot pass:** 5.9 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
## Run — 2026-04-18T19:27:04.478Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 4.9 ms (10 rows)
- **Warm pass:** 3.5 ms
- **Hot pass:** 2.9 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
## Run — 2026-04-18T19:27:06.309Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 9.2 ms (10 rows)
- **Warm pass:** 5.8 ms
- **Hot pass:** 4.8 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
## Run — 2026-04-18T19:27:06.425Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 9.3 ms (10 rows)
- **Warm pass:** 6.3 ms
- **Hot pass:** 6.1 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
## Run — 2026-04-18T19:27:06.508Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 6.3 ms (10 rows)
- **Warm pass:** 3.9 ms
- **Hot pass:** 3.1 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
## Run — 2026-04-18T19:27:09.474Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 5.8 ms (10 rows)
- **Warm pass:** 3.7 ms
- **Hot pass:** 2.7 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
## Run — 2026-04-18T19:27:09.561Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 5.0 ms (10 rows)
- **Warm pass:** 3.4 ms
- **Hot pass:** 2.7 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
## Run — 2026-04-18T19:27:09.649Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 6.6 ms (10 rows)
- **Warm pass:** 3.9 ms
- **Hot pass:** 3.0 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
## Run — 2026-04-18T19:27:12.645Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 4.8 ms (10 rows)
- **Warm pass:** 3.2 ms
- **Hot pass:** 2.6 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
## Run — 2026-04-18T19:27:12.723Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 5.1 ms (10 rows)
- **Warm pass:** 4.0 ms
- **Hot pass:** 2.8 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
## Run — 2026-04-18T19:27:12.802Z

- **Node:** v24.14.0
- **Platform:** win32 10.0.19045
- **Artifacts:** 10
- **Cold pass:** 6.5 ms (10 rows)
- **Warm pass:** 3.7 ms
- **Hot pass:** 2.6 ms
- **Budget:** 2000 ms (hot cache)
- **Hot within budget:** ✓

---
