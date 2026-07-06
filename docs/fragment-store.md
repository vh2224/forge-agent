# Fragment Store + Projection

Reference documentation for the Forge Agent fragment-store architecture introduced in M001.

---

## Overview

The classic `.gsd/` layout keeps three mutable monoliths (`LEDGER.md`, `DECISIONS.md`,
`AUTO-MEMORY.md`) as single files that every concurrent writer must touch. Under multi-branch
or multi-developer workflows these files diverge and merge-conflict constantly.

The **fragment-store** solves this with a read/write split:

- **Writers** append a small per-unit fragment (one file per milestone / session / task).
- **Readers** never open fragments directly — they call `forge-projection.js` which
  reconstructs the full monolith on the fly.
- **Monoliths** live on disk as a `.gitignore`-d (or `svn:ignore`-d) projection cache,
  regenerated when stale. They are never committed.

The result is conflict-free by construction: each fragment is owned by exactly one unit of
work and therefore by exactly one developer/branch.

---

## Store Layout

```
.gsd/
├── ledger/              # one fragment per completed milestone
│   └── <milestone-id>.md
├── decisions/           # one fragment per milestone, slice, or ask-session
│   └── <id>.md
├── memory/              # one fragment per milestone or task where learning occurred
│   └── <id>.md
├── checker-memory/      # plan-checker learning entries (S04)
│   └── <id>.md
│
│   ── PROJECTION CACHE (gitignored / svn:ignored) ──
├── LEDGER.md            ← rendered by forge-projection --write-all
├── DECISIONS.md         ← rendered by forge-projection --write-all
└── AUTO-MEMORY.md       ← rendered by forge-projection --write-all
```

Fragment directories are created **lazily** on first write — `/forge-init` does not pre-create
them. The ignore rules that hide the projection cache files are written during `forge-init` by
`scripts/forge-ignore.js --apply`.

---

## Fragment Schema

Every fragment file carries a YAML frontmatter block followed by a markdown body:

```markdown
---
schema_version: 1
type: ledger | decisions | memory | checker-memory
id: <unit-id>            # milestone ID (M-<ts>-<slug> or M###) or ask-<session-id>
written_at: <ISO-8601>
# type-specific fields follow:
#   ledger:    title, slices_done, key_files, key_decisions
#   decisions: milestone, slice (optional)
#   memory:    category, confidence, hits, last_hit, decay_half_life_ms
---

<body — markdown prose>
```

The `schema_version` field enables `forge-doctor --check schema` to detect fragments written
by older or future versions and alert before incompatibilities cause silent data loss.

A `.gsd/SCHEMA-VERSION` file records the current schema version (integer) for the whole
working copy. `forge-doctor` and `forge-migrate.js` read this to decide whether migration is
needed.

---

## Layer-by-Layer Reference

### Layer 1 — Ignore rules (S01)

`scripts/forge-ignore.js --apply` detects the VCS (Git or SVN) and writes the appropriate
ignore entries for the three projection-cache paths:

- **Git:** appends to `.gsd/.gitignore`
- **SVN:** sets `svn:ignore` on `.gsd/`

This step runs automatically inside `/forge-init` (both Case A — existing project and
Case B — new project). Re-running is idempotent.

### Layer 2 — Fragment writers (S02)

Three modules, one per store, all following the same API contract:

| Module | CLI flag | Store dir |
|--------|----------|-----------|
| `scripts/forge-ledger.js` | `--write \| --read \| --list \| --validate` | `.gsd/ledger/` |
| `scripts/forge-decisions.js` | same flags | `.gsd/decisions/` |
| `scripts/forge-memory.js` | same flags | `.gsd/memory/` |

Each module exports: `writeFragment(cwd, entry)`, `readFragment(cwd, id)`,
`listFragments(cwd)`, `parseFragment(text)`. The `forge-completer` and `forge-memory` agents
call these functions when closing a milestone or extracting a memory.

Migration helpers for existing monoliths:
- `scripts/forge-ledger-migrate.js`
- `scripts/forge-decisions-migrate.js`
- `scripts/forge-memory-migrate.js`

### Layer 3 — Projection engine (S03)

`scripts/forge-projection.js` is the read-side of the paradigm.

**Library exports:**

```js
renderLedger(cwd)      // → string  LEDGER.md reconstructed from ledger/*.md
renderDecisions(cwd)   // → string  DECISIONS.md with derived # numbering
renderMemory(cwd)      // → string  AUTO-MEMORY.md with decay computed on-read
isStale(cwd)           // → { ledger:bool, decisions:bool, memory:bool }
writeAll(cwd)          // → { written:[string], skipped:[string] }
```

**CLI:**

```bash
node scripts/forge-projection.js --render ledger|decisions|memory [--cwd <dir>]
node scripts/forge-projection.js --stale  [--cwd <dir>]
node scripts/forge-projection.js --write-all [--cwd <dir>]
```

Staleness is determined by comparing the `mtime` of the projection cache file against the
newest fragment in its store directory. `isStale()` is cheap (stat-only); it is called by
agents that need to read a monolith — they call `writeAll()` first when stale.

Memory decay is computed **on-read**: confidence is adjusted by a 30-day half-life without
mutating the fragment. The cap of 50 active memories is enforced during projection, not during
write.

### Layer 4 — Migration + verification (S04)

`/forge-update` runs `scripts/forge-migrate.js` which:

1. Reads `.gsd/SCHEMA-VERSION` (or defaults to version `0` for pre-M001 working copies).
2. For each store below the target schema version, calls the matching migrate script to
   explode the monolith into per-unit fragments.
3. Keeps the original monolith as `<name>.bak` (e.g. `LEDGER.md.bak`).
4. Runs a verification step: renders the new projection and diffs it against the backup
   (modulo line-number prefixes). A mismatch is reported but does not abort — the `.bak` file
   is preserved so nothing is lost.
5. Writes the new `.gsd/SCHEMA-VERSION`.

Migration is **idempotent** — re-running it on an already-migrated working copy is a no-op
(fragments already exist; monolith backup is preserved unchanged).

### Layer 5 — Doctor checks (S05)

`forge-doctor` validates the fragment-store health:

```bash
/forge-doctor --check schema
/forge-doctor --check projection-versioned
```

- `--check schema` — verifies every fragment's `schema_version` matches the working copy
  SCHEMA-VERSION. Fragments written by a future version emit a warning; fragments below the
  current version are flagged for migration.
- `--check projection-versioned` — verifies the projection cache exists and is fresh (not
  stale). If stale, suggests running `node scripts/forge-projection.js --write-all`.

---

### Layer 6 — Maintenance / bucket rollup (2.0.0)

Introduced in milestone `M-20260706152250-maintenance-fragment`, this layer adds a second,
opt-in consolidation path on top of the projection cache described above: once a store
accumulates enough loose finalized fragments, an operator-confirmed **maintenance** pass fuses
them into a handful of immutable **rollup buckets**, closing the "thousands of tiny files"
scaling concern without ever touching the read/write split itself.

**Bucket layout** — three LOCKED targets, one per axis:

```
.gsd/
├── archive/
│   ├── milestones-rollup.md    ← fused milestone ledger fragments
│   └── tasks-rollup.md         ← fused task ledger fragments
└── decisions/
    └── _rollup-<YYYY-QN>.md    ← fused decisions fragments for one closed quarter
```

Filenames starting with `_` are reserved for the bucket namespace — readers treat them as a
single logical unit, never as individual fragments. Buckets are **closed and immutable** once
written: a bucket is never re-opened and rewritten, only produced fresh by a later baseline run.

**Deterministic merge (no LLM).** Every bucket is the output of `mergeBucket` (S01,
`scripts/forge-maintenance.js`) — a pure, byte-deterministic merge over normalized, sorted
fragment content. Identical inputs always fuse to an identical byte stream, regardless of
machine, timezone, or invocation order. This is a mechanical merge, never a summarization —
nothing is dropped, reworded, or reinterpreted; it purely reduces file count.

**Read compatibility {1.0.0, 2.0.0}.** `forge-doctor.js` accepts both `fragment-store@1.0.0`
(pre-maintenance, loose fragments only) and `fragment-store@2.0.0` (post-baseline, mixed loose
+ bucket) as valid schema stamps (`VALID_SCHEMAS`). `listFragments()` in `forge-ledger.js` /
`forge-decisions.js` is **unit-based**: it folds loose fragments and bucket units into the same
enumeration (bucket wins on id collision, mirroring write-path precedence), so
`forge-projection.js` renders `LEDGER.md`/`DECISIONS.md` byte-identically whether a given unit
is still loose, sitting in an in-store bucket, or has been moved to the archive rollup by a
baseline run. A working copy never needs to "finish migrating" — 1.0.0 and 2.0.0 fragments
coexist indefinitely.

**The 3 count triggers.** `detectTriggers(cwd)` (`scripts/forge-maintenance-baseline.js`) counts
loose, *finalized* units per axis and fires when a threshold is crossed:

| Axis | Threshold | Target bucket |
|------|-----------|----------------|
| `milestones` | 30 loose finalized milestone fragments | `.gsd/archive/milestones-rollup.md` |
| `tasks` | 30 loose finalized task fragments | `.gsd/archive/tasks-rollup.md` |
| `ledgerDecisions` | 100 loose decisions fragments in a **closed quarter** | `.gsd/decisions/_rollup-<YYYY-QN>.md` |

"Finalized" (the `isFinalized` predicate) means done-evidence exists (a ledger fragment or a
`SUMMARY.md`) **and** the unit is not currently active in `forge-runs.js`/`STATE.md` —
`ask-*` session ids are always considered finalized. A quarter is "closed" once its end date has
passed relative to the current date.

**The gate UX — nothing ever applies unattended.** Detection (`detectMode` /
`scripts/forge-maintenance-gate.js --detect`) is always safe to run non-interactively and never
writes anything. Applying a consolidation, however, always requires a live human handshake:

1. **Announce** — `SWEEP NORMAL` or `⚠ SWEEP PRECISA DE MAINTENANCE` (one line per fired axis),
   emitted by `/forge-sweep`, `forge-next`, and `forge-auto` alike at their own boundary.
2. **RED warning** — `renderRedWarning(detection)` renders a bold-red, boxed banner before any
   confirmation is requested; it is never summarized or truncated.
3. **First confirm** — one `AskUserQuestion` ("Prosseguir com a maintenance?").
4. **Per-axis double-confirm** — a **separate** confirmation for each fired axis
   (`milestones`/`tasks`/`ledgerDecisions`); declining one axis excludes only that axis, never
   all-or-nothing.
5. **`forge-auto` STOP.** The autonomous loop never applies a consolidation inline — on
   `mode == maintenance` it renders the announce + RED warning and **halts** (the sanctioned
   AUTONOMY-RULE exception), delegating the actual apply to `/forge-sweep` or an interactive
   `forge-next` session. Headless `bin/forge-run` defers instead of blocking.

The full step-by-step procedure (VCS collision handling, events schema, per-consumer postures)
is authoritatively specified in [`shared/forge-maintenance.md`](../shared/forge-maintenance.md)
— this section only summarizes the store-layer shape; that document is the source of truth for
the gate's behavior.

**Opt-in per repo.** The entire maintenance gate is **inert by default** —
`detectMode(cwd, opts)` reads `maintenance.enabled` from the standard 3-file prefs cascade
(default `false`) and short-circuits to `{ mode: 'normal', firedAxes: [] }` without even running
the dry-run trigger plan when disabled. A repo must explicitly set `maintenance.enabled: true`
(`forge-agent-prefs.md § Maintenance Settings`) to activate detection, the RED warning, and the
`forge-auto` STOP behavior at all.

**Schema bump on first baseline.** `.gsd/SCHEMA-VERSION` stays untouched at `1.0.0` until the
**first successful maintenance apply that actually consolidates something** — `runBaseline`'s
success path calls `stampBucketSchema(cwd)` (upgrade-only: it never overwrites an existing
`2.0.0` stamp, and a dry-run or a no-op apply — nothing left to consolidate — never touches the
file) to write `fragment-store@2.0.0`. A working copy where `maintenance.enabled` stays `false`
therefore never bumps its schema stamp; the bump is entirely a byproduct of the opt-in gate
being exercised for real, not a separate migration step.

**Known limitations (under review, not resolved):**

- `isFinalized`'s active-unit exclusion trusts `forge-runs.js`'s `active` flag with no
  TTL/staleness check — a crashed session could, in principle, leave a stale `active: true`
  record that indefinitely excludes an otherwise-finalized unit from triggers/baseline. Flagged
  for milestone-end triage, not yet resolved.
- `baselineAvailable = anyLoose && !anyBucket` has no threshold: a brand-new project's very
  first finalized unit (before any axis crosses its count threshold) already reports
  `mode: "maintenance"`, which forces a `forge-auto` STOP at the very next unit boundary and
  repeats until an operator seeds a bucket. Whether this should be downgraded to a non-blocking
  informational note is an open product decision, deferred to milestone triage — not fixed.

---

## Projection Cache — .bak Guarantee

The migration step always preserves `LEDGER.md.bak`, `DECISIONS.md.bak`, and
`AUTO-MEMORY.md.bak` alongside the migrated fragments. These backups are kept indefinitely
(also gitignored) and serve as the ground truth for verifying migration correctness.

To manually verify a projection matches its backup:

```bash
node scripts/forge-projection.js --render ledger --cwd /your/project > /tmp/ledger-new.md
diff /your/project/.gsd/LEDGER.md.bak /tmp/ledger-new.md
```

A clean diff confirms the migration was lossless.

---

## Related Files

- [`scripts/forge-projection.js`](../scripts/forge-projection.js) — projection engine
- [`scripts/forge-ledger.js`](../scripts/forge-ledger.js) — ledger fragment writer
- [`scripts/forge-decisions.js`](../scripts/forge-decisions.js) — decisions fragment writer
- [`scripts/forge-memory.js`](../scripts/forge-memory.js) — memory fragment writer
- [`scripts/forge-ignore.js`](../scripts/forge-ignore.js) — VCS ignore rules (Layer 1)
- [`scripts/forge-migrate.js`](../scripts/forge-migrate.js) — migration orchestrator
- [`scripts/forge-doctor.js`](../scripts/forge-doctor.js) — health checks + `VALID_SCHEMAS`/`BUCKET_SCHEMA`
- [`scripts/forge-maintenance.js`](../scripts/forge-maintenance.js) — deterministic bucket-merge primitive (Layer 6)
- [`scripts/forge-maintenance-baseline.js`](../scripts/forge-maintenance-baseline.js) — count triggers + `runBaseline` (Layer 6)
- [`scripts/forge-maintenance-gate.js`](../scripts/forge-maintenance-gate.js) — opt-in detect/announce gate (Layer 6)
- [`scripts/forge-maintenance-vcs.js`](../scripts/forge-maintenance-vcs.js) — VCS concurrency guard for bucket commits (Layer 6)
- [`shared/forge-maintenance.md`](../shared/forge-maintenance.md) — authoritative maintenance gate spec (Layer 6)
