# forge-state — Canonical state schema reference

This doc pins the file formats for multi-run state. All Forge agents, scripts and skills MUST read/write through `scripts/forge-state.js` and `scripts/forge-runs.js` — never parse these files ad-hoc.

---

## 1. `.gsd/milestones/M###/M###-STATE.md`

**Role:** Source of truth for a single milestone run. Replaces the workspace-level `.gsd/STATE.md` semantics in multi-run mode.

**Owner:** the orchestrator owning this run, plus `forge-completer` at slice/milestone close. No other agent writes.

**Lifecycle:** created on milestone activation, mutated on each phase transition, frozen on `complete-milestone`.

### Format

```markdown
---
milestone: M065
kind: milestone
created: 2026-05-20T19:30:00Z
last_updated: 2026-05-20T20:14:33Z
isolation_mode: shared
---

# M065 State

**Active Slice:** S03
**Active Task:** T02
**Phase:** execute-task
**Auto-mode:** on
**Next Action:** Dispatch forge-executor for T02 (Frenet adapter HTTP wrapper).

## Recent units (last 10)

- ✓ [2026-05-20T20:10:12Z] plan-slice S03 — 7 tasks decomposed
- ✓ [2026-05-20T20:12:45Z] execute-task T01 — adapter interface + types

## Notes (optional, human-readable)

(Free-form. Operators can append context here. Forge writers preserve.)
```

### Required frontmatter fields

| Field | Type | Notes |
|---|---|---|
| `milestone` | string — legacy `M###` or timestamp `M-<ts>-<slug>` | Must match parent directory name |
| `kind` | `"milestone"` | Always `milestone` for this file type |
| `created` | ISO-8601 UTC | When the file was first written |
| `last_updated` | ISO-8601 UTC | Bumped on every write |
| `isolation_mode` | `"shared"` \| `"branch"` \| `"worktree"` | From prefs at activation time |

### Required body fields (line-prefixed bold form)

| Prefix | Required | Value |
|---|---|---|
| `**Active Slice:**` | yes | `S##` or `—` if no slice scoped yet |
| `**Active Task:**` | yes | `T##` or `—` |
| `**Phase:**` | yes | One of: `idle`, `estimate-milestone`, `plan-milestone`, `discuss-milestone`, `research-milestone`, `plan-slice`, `research-slice`, `execute-task`, `complete-slice`, `complete-milestone`, `resume`, `blocked` |
| `**Auto-mode:**` | yes | `on` \| `off` |
| `**Next Action:**` | yes | Free-form one-paragraph imperative |

### Optional sections

- `## Recent units (last 10)` — rolling log, max 10 entries, oldest dropped on push
- `## Notes` — free-form, preserved by writers

### Parser rule

- Regex anchors: `^\*\*Active Slice:\*\*\s+(.+)$`, etc. (multiline)
- Missing required field → throw with diagnostic
- Frontmatter must be valid YAML; unknown keys ignored (forward-compat)

---

## 2. `.gsd/forge/runs/{id}.json`

**Role:** Process registry — one file per active run. The truth source for "who's running right now in this workspace".

**Owner:** the orchestrator of that run, plus hooks (heartbeat bumps only).

**Lifecycle:** created on activation, mutated on heartbeat/worker change, deleted on `active:false` finalization OR garbage-collected when stale > 30min.

### Schema (TypeScript-style)

```ts
type RunRecord = {
  kind: "milestone" | "task";
  id: string;                       // "M065" or "M-<ts>-<slug>" for milestones, "T-<ts>-<slug>" for tasks
  session_id: string;               // Claude Code session_id from hook payload
  active: boolean;                  // true while loop is alive
  started_at: number;               // Unix ms
  last_heartbeat: number;           // Unix ms; bumped by hooks + orchestrator
  worker: string | null;            // "unit_type/UNIT_ID" e.g. "execute-task/T03"; null when between dispatches
  worker_started: number | null;    // Unix ms when worker dispatched
  isolation_mode: "shared" | "branch" | "worktree";
  milestone_dir: string | null;     // ".gsd/milestones/M065/" for kind=milestone; null for kind=task
  cwd: string;                      // Working directory of the orchestrator (worktree path if worktree mode)

  // Address fields — additive, optional, default null. See "Addressing" below.
  branch: string | null;            // git branch this run owns ("forge/{id}" under branch/worktree)
  root: string | null;              // declared root containing this run's project (path, ~-anchored path, or root name)
  project: string | null;           // owning project — the nearest ".gsd/" (ABSOLUTE path)

  // Task-only fields (kind=task; absent for kind=milestone)
  task_description?: string;        // The original user prompt for /forge-task
  pending_decisions?: Array<{       // Buffered for merge at complete-task
    ts: string;                     // ISO-8601
    id: string;                     // "D-<task-id>-{n}" where <task-id> is the T-<ts>-<slug> id
    decision: string;
    rationale?: string;
  }>;
  pending_memories?: Array<{        // Buffered for merge at complete-task
    name: string;
    description: string;
    body: string;
    category: string;
    confidence: number;
  }>;
};
```

### Examples

**Milestone run:**
```json
{
  "kind": "milestone",
  "id": "M065",
  "session_id": "abc-123",
  "active": true,
  "started_at": 1779203140063,
  "last_heartbeat": 1779203195000,
  "worker": "execute-task/T03",
  "worker_started": 1779203180000,
  "isolation_mode": "branch",
  "milestone_dir": ".gsd/milestones/M065/",
  "cwd": "C:/DEV/lookchina/whatsapp-omnichannel",
  "branch": "forge/M065",
  "root": "~/Development",
  "project": "C:/DEV/lookchina/whatsapp-omnichannel"
}
```

**Task run:**
```json
{
  "kind": "task",
  "id": "T-20260522143012-fix-typo-readme",
  "session_id": "def-456",
  "active": true,
  "started_at": 1779203140063,
  "last_heartbeat": 1779203150000,
  "worker": "execute-task/adhoc",
  "worker_started": 1779203145000,
  "isolation_mode": "shared",
  "milestone_dir": null,
  "cwd": "C:/DEV/lookchina/whatsapp-omnichannel",
  "branch": null,
  "root": null,
  "project": null,
  "task_description": "Fix typo in README — 'recieve' → 'receive'",
  "pending_decisions": [],
  "pending_memories": []
}
```

### Addressing (`branch`, `root`, `project`)

These three fields are what make a run **addressable** rather than merely present. Without them, two runs on the same project in different branches carry a **byte-identical `cwd`** and nothing else distinguishes them — they are separable only by the accident of two different filenames in `.gsd/forge/runs/`, which is not an address.

| Field | Type | Meaning | Written by |
|---|---|---|---|
| `branch` | string \| null | The git branch this run owns. `forge/{id}` under isolation `branch`/`worktree`; `null` under `shared`. | Orchestrator at run registration (`forge-runs.js --branch`) |
| `root` | string \| null | The declared root containing this run's project. Accepts an absolute path, a `~`-anchored path, or the **name** of a declared root (matched against the basename of `roots[]` in the workspace registry). | Orchestrator (`--root`); usually left `null` and derived |
| `project` | string \| null | The project owning the run — the nearest `.gsd/` above the run's `cwd`. **Must be absolute**; a relative value is reported as `record-project-unanchored` and never resolved against the caller's cwd. | Orchestrator (`--project`); usually left `null` and derived |

**Additive, with an explicit `null` default.** Every record written before these fields existed loads unchanged and is **not migrated** — `scripts/forge-runs.js` applies the `null` default on *read* (`withAddressDefaults`) rather than rewriting files. `null` and not `undefined` deliberately: `undefined` disappears through `JSON.stringify`, so a legacy record would serialise with no `branch` key at all, making "no value" indistinguishable from "this field does not exist".

**Recorded beats derived.** `scripts/forge-runs.js` records these verbatim and derives nothing. Resolution is `scripts/forge-run-address.js`:

```
node scripts/forge-run-address.js --address <run-id> [--json] [--cwd <path>]
```

`resolveRunAddress(cwd, runId)` returns the full `run → root → project → repo` chain, composing `findContainingRoot` (root containment), `resolveOwner` / `resolveRole` (ownership), and `buildRepoIndex` (repos). A field present on the record is authoritative; derivation runs only where the field is `null`. Every leg carries its own `source` (`record` \| `derived` \| `null`) and a `reason` when it could not resolve — a leg **never** reports an invented path, and only an unknown run id throws.

**The address is cwd-invariant.** Resolving the same run from the project root, from a nested subdirectory, and from a tmpdir outside the tree returns a byte-identical answer. `cwd` says which `.gsd/` to consult and is echoed back as `resolved_from` for audit only; it never enters the identity. This matters because under isolation `worktree` the orchestrator's cwd is `<root>/.forge-worktrees/{RUN}/<repo>` — outside the workspace tree entirely, which is exactly where a cwd-derived address goes wrong.

### Forward compatibility

**Unknown keys are ignored, never dropped.** A reader encountering a field it does not know preserves it through a read/write round-trip. This is what lets an older Forge and a newer one share a workspace without either silently erasing the other's state — the same rule §1's frontmatter parser follows.

### Lifecycle states

| State | Meaning | Reachable from |
|---|---|---|
| Created (`active:true`, fresh heartbeat) | Run is alive | initial activation |
| Stale-warning (`active:true`, `last_heartbeat` > 3min) | Statusline shows yellow; still considered alive | normal flow + no recent dispatch |
| Stale (`active:true`, `last_heartbeat` > 5min) | Statusline shows red; CLI considers dead; auto-mode boot will offer takeover | unexpected hang / kill |
| Inactive (`active:false`) | Run finalized cleanly | `complete-milestone`/`complete-task`/`/forge-pause` |
| Garbage-collected (file deleted) | `active:true` + `last_heartbeat` > 30min | next `/forge-*` boot |

### Concurrency

- Writes are last-write-wins. Multiple writers (orchestrator + hooks) must read-merge-write within one `fs.writeFileSync` call.
- No lockfile for runs/*.json — each file is per-run, no sharing.
- For multi-write atomicity, helpers in `scripts/forge-runs.js` use a temp-file-and-rename pattern.

---

## 3. `.gsd/STATE.md` raiz (dashboard)

**Role:** Read-only workspace dashboard. Auto-generated. Operators read it; agents read it; **no one writes ad-hoc** — only `scripts/forge-dashboard.js` writes, under a lock.

**Owner:** `scripts/forge-dashboard.js`, called by orchestrators on boot/exit/phase-change.

**Format:** strict markdown, regenerated end-to-end on each refresh.

### Format

```markdown
<!-- AUTO-GENERATED by scripts/forge-dashboard.js — do not edit by hand -->
<!-- Last regen: 2026-05-20T20:14:33Z -->

# GSD Dashboard

## Active runs (2)

- **M065** — milestone · phase: execute-task · worker: T03 · heartbeat: 5s ago · isolation: shared · session: abc-123
- **M066** — milestone · phase: plan-slice · worker: S04 · heartbeat: 12s ago · isolation: shared · session: def-456

## Recently completed

- [2026-05-19T17:30Z] M064 — Inbound media rendering (6 slices)
- [2026-05-19T13:10Z] M063 — shipping-quotes Wave 1 (7 slices)

(See `.gsd/LEDGER.md` for full history.)

## Recently activity (last 5 units, across all runs)

- ✓ [20:14:30] M065/execute-task/T03 — done (forge-executor)
- ⚡ [20:14:12] M066/plan-slice/S04 — dispatching (forge-planner)
- ✓ [20:13:55] M065/execute-task/T02 — done
- ✓ [20:13:22] M065/execute-task/T01 — done
- 🪶 [20:12:50] M065/complete-slice/S02 — done (forge-completer)

(See `.gsd/milestones/M###/M###-events.jsonl` for per-run history.)
```

### Empty / single-run dashboards

**Zero active runs:**

```markdown
<!-- AUTO-GENERATED ... -->

# GSD Dashboard

No active runs. Last completed: M064 (2026-05-19T17:30Z).

Run `/forge-auto <M###>` to start.
```

**One active run** — same as legacy STATE.md single-active block, but with `<!-- AUTO-GENERATED -->` header. Operators on workspaces that never go multi-run see basically no change.

### Lock

`scripts/forge-dashboard.js` acquires `.gsd/.locks/STATE.md/` via `scripts/forge-lock.js` before each regen. TTL 5s (regen is fast). On lock-busy: skip — another orchestrator just regenerated, our pending data will be included next time (idempotent regen reads runs/*.json fresh).

---

## 4. Legacy compatibility

Workspaces with pre-M004 STATE.md (single-run with `**Active Milestone:**` field):

- `scripts/forge-state.js --read-legacy` parses old format
- `scripts/forge-runs.js --migrate-legacy` on first multi-run boot:
  1. Reads legacy STATE.md
  2. If `Active Milestone: M###` present and `M###/` dir exists → writes `M###-STATE.md` mirroring the single-run state
  3. Calls `scripts/forge-dashboard.js` to regenerate STATE.md as dashboard
  4. Old STATE.md is overwritten (no backup — git tracks it)

Detection rule: STATE.md without `<!-- AUTO-GENERATED -->` first line = legacy. Once dashboard regenerates, the marker is present.

**Task ID retrocompat:** Legacy task run files with IDs of the form `task-{slug}-{hex}` remain readable by `scripts/forge-runs.js`. New task runs use `T-<ts>-<slug>` (emitted by `makeTaskId()` in `scripts/forge-ids.js`). The slug portion is optional — when the description reduces to an empty slug, the ID is `T-<ts>` with no trailing segment.

---

## 5. Auto-mode.json (legacy alias)

`.gsd/forge/auto-mode.json` is kept as a **mirror** of the first active run (by `started_at` ascending) for backward compatibility with external scripts/integrations. It MUST NOT be the source of truth for any new logic — read `runs/*.json` instead.

Mirror schema (subset of RunRecord):

```json
{
  "active": true,
  "started_at": 1779203140063,
  "last_heartbeat": 1779203195000,
  "worker": "execute-task/T03",
  "worker_started": 1779203180000
}
```

Writer: `scripts/forge-runs.js --refresh-legacy-alias` is called after any `runs/*.json` mutation. When zero active runs remain, writes `{"active":false}`.

---

## 6. Lock files (`.gsd/.locks/{name}/`)

Used by `scripts/forge-lock.js`. Path is a **directory** (created via `mkdir` for atomic semantics on POSIX and NTFS). Inside the directory:

```
.gsd/.locks/DECISIONS.md/
  metadata.json   { generation, owner_token, acquired_at, renewed_at, ttl_ms }
  owner-<token>/  ownership marker
```

- TTL default 30s, configurable per acquire call
- A stale contender first claims the old owner marker, then quarantines the
  directory before removing it. An old release cannot remove a successor
  (ABA-safe).
- Release and renewal require the opaque owner token plus generation. PID and
  run identifiers are diagnostic metadata only.
- No file locks (`fcntl`/`LockFileEx`) — directory locks are cross-platform and crash-resilient

---

## 7. Atomic, runtime-neutral persistence (S02/T02)

`forge-state.js` and `forge-runs.js` are the executable compatibility boundary
for durable Forge state. Consumers must use their public update APIs rather
than writing `STATE.md` or `runs/*.json` directly.

### Publication rule

Every canonical state or run mutation follows this sequence:

1. Acquire the owner-scoped `forge-lock` mutex for `state-{milestone}` or
   `run-{id}`.
2. Re-read the durable file while holding that mutex.
3. Merge only the supplied patch fields onto the freshly-read record.
4. Write the complete replacement to a uniquely named temporary file in the
   target directory.
5. Rename that file over the target, then release the same owner token.

The temporary file and destination live on the same filesystem. `rename` is
therefore the publication point on Windows, macOS and Linux: readers see the
old complete document or the new complete document, never an incomplete JSON
or Markdown body. A failed canonical write is an error. Temporary files are
not a recovery protocol and must not be treated as a competing source of truth.

### STATE metadata

Per-milestone STATE frontmatter may additionally carry the following optional
fields:

| Field | Meaning | Semantic effect |
| --- | --- | --- |
| `owner` | opaque writer or lease-owner label | audit only |
| `host_runtime` | `claude` or `codex` | validated when supplied; no phase change |
| `worker_engine` | requested worker engine | audit/routing input only |
| `session` | provider-neutral opaque session reference | correlation only |
| `heartbeat` | durable heartbeat value | liveness metadata only |
| `expires_at` | optional expiry value | consumed by later lease code |

These fields do not select a task, calculate `phase`, or alter `next_action`.
`host_runtime` is normalized by `forge-runtime.js` only when supplied. Unknown
values fail with its normal `invalid-host-runtime` diagnostic. Omission means
legacy input remains Claude-first at the runtime normalization boundary; it does
not cause `host_runtime: claude` to be written back to a legacy file.

### RunRecord metadata and aliases

Run records retain `session_id` because 3.1.4 readers use it. New callers may
supply `session`; the registry stores it as additive neutral metadata and keeps
`session_id` as a compatibility alias. No code infers a provider from the value
or shape of either field. `owner`, `host_runtime`, `heartbeat`, and `expires_at`
are likewise optional additive fields. Unknown record keys survive an update so
future writers can extend the schema without a migration race.

`auto-mode.json` remains a best-effort legacy mirror only. It is atomically
published for reader safety, but it is never used to choose a run, establish
ownership, or make a lease decision. If refreshing that alias fails, the
canonical state/run mutation remains successful.

### Compatibility examples

A 3.1.4 record without new metadata stays valid after an unrelated update:

```json
{"id":"M065","kind":"milestone","session_id":"legacy-value","active":true}
```

A neutral record may add metadata without changing selection behavior:

```json
{"id":"M065","session":"opaque","host_runtime":"codex","owner":"token"}
```

Neither example references a provider home directory, a CLI command, or a
provider-specific session-id grammar. Session identifiers are opaque text.

### Concurrency and callers

Heartbeat, worker, and ordinary state patches are independent merge patches.
Each operation re-reads under its granular mutex, so a heartbeat update cannot
erase a worker patch that was already persisted, and vice versa. Callers should
submit only fields they own; whole-record replacement outside these APIs is not
supported. The lock is a short persistence mutex, not a unit lease and not an
authorization to execute work.

The implementation uses only Node `fs`, `path`, and relative module imports.
It does not read `~/.claude`, `~/.codex`, environment-specific commands, or
provider configuration. This keeps the same durable files portable across all
supported hosts and operating systems.

---

## 8. Persistent unit leases (S02/T03)

`scripts/forge-unit-lease.js` is the durable authorization boundary for one
logical unit. It is deliberately separate from the short mutex in §6, the run
registry in §2, and the path defence in `forge-filelock.js`. Holding a mutex,
having an active run, or editing a protected file never grants permission to
execute a unit.

### Canonical location and identity

Each lease lives at:

```text
.gsd/forge/leases/<base64url(normalized-unit-key)>.json
```

The unit key is either a non-empty logical string or `{ type, id }`, rendered
as `type/id`, trimmed and normalized to Unicode NFC. It is not a filesystem
path. The encoded filename and SHA-256-derived mutex name are both calculated
from that same normalized key, so object and string forms cannot create
parallel lease records. This supports spaces and Unicode on Windows, macOS and
Linux without relying on shell quoting or host path rules.

### Storage record

The versioned canonical record contains:

```json
{
  "protocol_version": "1.0.0",
  "unit": "execute-task/T03",
  "owner_token": "opaque-write-credential",
  "host_runtime": "codex",
  "session": "opaque-correlation-value",
  "request_id": "optional-idempotency-key",
  "generation": "opaque-generation",
  "acquired_at": 1770000000000,
  "heartbeat_at": 1770000000000,
  "expires_at": 1770000030000,
  "grace_ms": 5000
}
```

`owner_token` and `request_id` are credentials/correlation values and must not
be emitted by `observe`. The public status has `owner: "redacted"`, preserves
only useful audit metadata (`host_runtime`, opaque `session`, generation and
timestamps), and tells observers whether the record is expired or recoverable.
No provider-specific session format has semantic meaning.

### Lifecycle and authorization

1. `acquire(cwd, unit, options)` takes the per-unit short mutex, re-reads the
   record, and atomically publishes exactly one new generation when absent.
2. A current record denies a different owner with `lease-active`; it remains
   owned regardless of host runtime, PID, process liveness, or run status.
3. Retrying acquire with the same owner token and request id returns
   `already-acquired` and the same generation, rather than creating a second
   record.
4. `heartbeat(cwd, unit, ownerToken, generation, options)` can renew only the
   exact active credential pair and returns `owner-mismatch` to every other
   caller.
5. `release(cwd, unit, ownerToken, generation)` likewise compares both values,
   quarantines then removes only its own record, and returns `already-released`
   on a safe repeated release.

The acquisition owner receives its opaque token in the acquire result. It must
store that token only in a trusted caller boundary; status output, run records,
and logs must not become a source of authorization.

### Expiry, grace, and recovery

Expiry does not itself select a new owner. A record is merely expired after
`expires_at`, and is eligible for stale recovery only when the injected clock
is strictly later than `expires_at + grace_ms`. Before that point recovery and
competing acquisition return `expired-awaiting-grace`. The current owner can
heartbeat while its generation remains installed; once another caller has
recovered and acquired a successor, the prior token/generation can no longer
renew or release it.

`recover` is idempotent: it removes one record that passed the expiry-plus-
grace test, returns `recovered`, and later repeats return `already-released`.
PID checks, `process.kill`, run heartbeat, account name, and provider session
shape are forbidden as takeover authorization. They may appear only in a
separate diagnostic layer.

### Atomicity and crash recovery

Every mutation happens beneath the T01 owner-safe mutex. It writes a complete
replacement to a uniquely named temporary file in the lease directory and
renames it over the canonical record. Rename is the publication point. A crash
before rename leaves the old record (or no record) canonical; a crash after
rename leaves the new complete record canonical. Orphan temporary files are
deleted during a later mutating operation and are never promoted as ownership.

Malformed or incomplete canonical records are quarantined under the same
mutex, then treated as recoverable absence. Release/recovery also quarantine
before deletion, preventing an old callback from deleting a new generation.
At all stable observation points a unit has zero or one parseable lease record,
never two active owners.

### Stable results

The API/schema reason codes are: `acquired`, `already-acquired`,
`lease-active`, `owner-mismatch`, `renewed`, `released`, `already-released`,
`expired-awaiting-grace`, `recovered`, `contended-recovery`, `invalid-request`,
and `guard-busy`. Callers should branch on those stable codes rather than
English or Portuguese prose. A temporary guard contention is not a lease
decision and can be retried by the caller.

### Operational boundaries

`forge-runs` may mirror owner/heartbeat metadata for visibility, but it is not
read to authorize acquisition, renewal, release, or recovery. `forge-filelock`
protects a named edited path and does not create a unit lease. `forge-lock`
protects only the few filesystem operations necessary to change a lease. The
unit lease is the sole proof that a worker may execute that unit. Normal lease
mutations do not steal an expiring short mutex; only the explicit lease
`recover` operation may reclaim a stale guard. This fencing rule prevents a
paused publisher from resuming after a successor has taken over the guard.

Tests use `process.execPath`, argument arrays, `shell:false`, a filesystem
barrier, a temporary directory containing spaces and Unicode, and real Claude
and Codex metadata contenders. This exercises the durable result rather than
assuming any scheduler order or POSIX-only behavior.

---

## 9. Provider-neutral unit controller (S02/T04)

`scripts/forge-unit-controller.js` is the single workflow API consumed by
future CLI adapters. It coordinates selection, unit leases, durable
transitions, results, events, STATE projection and handoff. Claude and Codex
call the same functions and pass only the explicit `host_runtime` value; the
controller never selects a provider from a model family, a session prefix, or
the caller's home directory.

### Selection boundary

`selectNextUnit(input)` is pure after the orchestrator supplies `state`, the
roadmap inventory and resolved preferences. The ordered decision is:

1. missing roadmap → `estimate-milestone` only for a new enrolled milestone that needs options; pending choice → `time-option-pending`; attested choice → `plan-milestone`. Without enrollment the existing `plan-milestone` behavior remains;
2. missing milestone context → `discuss-milestone` unless skip is resolved;
3. missing milestone research → `research-milestone` unless skip is resolved;
4. missing active slice plan/research → `plan-slice` or `research-slice`;
5. first unchecked task → `execute-task`;
6. planned slice without summary → `complete-slice`;
7. remaining unchecked slice → its next plan/task;
8. otherwise → `complete-milestone` or `no-next-unit`.

The controller reads the canonical preference resolver and status/roadmap
parser. It does not copy their defaults, regular expressions, model tables or
provider branches. A preference parse error is loud-stop: no lease, intent,
STATE, event or result is created.

New milestone bootstraps create phase `estimate-milestone` through `forge-state.js`
and enroll before first selection. `init` alone stays legacy. The named
`resume-time-option` command resumes the same snapshot after an explicitly answered,
live-attested selection; it never hand-edits STATE or fabricates completion.

### Transaction protocol

Every mutating action has an idempotency key. The canonical intent is stored
at `.gsd/forge/transactions/<encoded-key>.json` before any side effect. A
transaction advances only through these durable phases:

```text
intent
  → result-published
  → event-published
  → boundary-pending
  → state-published
  → lease-release-pending
  → lease-released
  → boundary-ready
  → committed
```

Each result, event, boundary and transaction uses temp-file-plus-rename. The
event JSONL is read, validated, rebuilt and atomically published under the
short owner-safe mutex; concurrent append is never used. Existing records with
the same idempotency key are accepted only when their stable content matches,
otherwise the controller fails loudly rather than silently forking history.

The recorded `before` and `after` snapshots contain logical STATE checksums.
Runtime/session fields are excluded from the logical projection, while the
durable transaction can retain host/runtime audit data. A crash before a
phase marker leaves an earlier phase and `resume` replays the missing
publication. Before releasing a terminal-action lease, the controller
durably records `lease-release-pending`; if the process then dies, recovery
either proves the original owner and releases it or observes that the marked
release already removed the lease. It never infers authorization from a
missing lease for earlier phases. A crash after publication sees the existing
idempotent artifact and advances without duplication. Orphan temporary files
are ignored and removed by the underlying writer on the next mutation.

### Transition and result rules

`begin`, `running`, `persist-result`, `complete`, `pause`, `fail` and
`expired-safe` are the closed action set. `begin` acquires a T03 lease with
the caller's owner token and records the generation in the intent. Every
subsequent transition proves that exact token/generation; run ID, PID,
file-lock ownership and host runtime do not authorize execution.

Terminal actions normalize results through `forge-runtime`, publish the
normalized result and event, project only the owned state patch, and release
the lease owner-scoped. The boundary is marked handoff-ready only after the
lease is absent and all prior writes are durable. A failed release or an
unexpected lease owner leaves the transaction pending and blocks handoff.

Result payloads are JSON-safe and reject cycles, functions, symbols, bigint,
credentials, conversation transcripts and token-like fields. Worker claims
such as `files_changed` are therefore data to validate, never an authorization
or source-of-truth shortcut.

### Transferable handoff boundary

Only `completed`, `paused`, `failed-persisted` and `expired-safe` boundaries
are transferable. Handoff denies by default when a boundary is absent,
uncommitted, has a pending transaction, or observes any lease record (even an
expired one awaiting grace/recovery). A successful handoff response carries
only the unit, milestone, boundary kind, outcome, checksums, timestamp and
next host runtime. It never carries owner tokens, credentials, provider
session contents, transcript or conversational context.

The next host starts by selecting/acquiring normally. It does not inherit a
mid-unit process, a Claude conversation, a Codex context window, or an
adapter-specific session. Thus Claude→Codex and Codex→Claude have identical
logical STATE, result and event projections while retaining explicit runtime
metadata for audit.

### Resume and recovery

`resume` enumerates only non-committed intents, reuses their idempotency keys,
and re-enters the phase machine. It first observes the same lease generation;
if the old generation was safely recovered, the caller must acquire a new
lease before continuing. Already published result/event/boundary files are
content-compared and not duplicated. A pending transaction is a durable
recovery obligation, so new begin/transition/handoff requests fail with
`transaction-pending` until resume or explicit recovery finishes it.

The controller is intentionally small and provider-neutral. CLI commands,
skills, account rotation, sidecars and conversation orchestration remain
adapters outside this boundary. This keeps the `.gsd` files portable across
Windows, macOS and Linux and makes the same core callable from both Claude
Code and Codex CLI.

The schema and conformance suite are the executable reference for these
ordering and handoff guarantees.
