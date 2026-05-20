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
| `milestone` | string `M###` | Must match parent directory name |
| `kind` | `"milestone"` | Always `milestone` for this file type |
| `created` | ISO-8601 UTC | When the file was first written |
| `last_updated` | ISO-8601 UTC | Bumped on every write |
| `isolation_mode` | `"shared"` \| `"branch"` \| `"worktree"` | From prefs at activation time |

### Required body fields (line-prefixed bold form)

| Prefix | Required | Value |
|---|---|---|
| `**Active Slice:**` | yes | `S##` or `—` if no slice scoped yet |
| `**Active Task:**` | yes | `T##` or `—` |
| `**Phase:**` | yes | One of: `idle`, `plan-milestone`, `discuss-milestone`, `research-milestone`, `plan-slice`, `research-slice`, `execute-task`, `complete-slice`, `complete-milestone`, `resume`, `blocked` |
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
  id: string;                       // "M065" for milestones, "task-{slug}-{shortuuid4}" for tasks
  session_id: string;               // Claude Code session_id from hook payload
  active: boolean;                  // true while loop is alive
  started_at: number;               // Unix ms
  last_heartbeat: number;           // Unix ms; bumped by hooks + orchestrator
  worker: string | null;            // "unit_type/UNIT_ID" e.g. "execute-task/T03"; null when between dispatches
  worker_started: number | null;    // Unix ms when worker dispatched
  isolation_mode: "shared" | "branch" | "worktree";
  milestone_dir: string | null;     // ".gsd/milestones/M065/" for kind=milestone; null for kind=task
  cwd: string;                      // Working directory of the orchestrator (worktree path if worktree mode)

  // Task-only fields (kind=task; absent for kind=milestone)
  task_description?: string;        // The original user prompt for /forge-task
  pending_decisions?: Array<{       // Buffered for merge at complete-task
    ts: string;                     // ISO-8601
    id: string;                     // "D-task-{slug}-{n}"
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
  "isolation_mode": "shared",
  "milestone_dir": ".gsd/milestones/M065/",
  "cwd": "C:/DEV/lookchina/whatsapp-omnichannel"
}
```

**Task run:**
```json
{
  "kind": "task",
  "id": "task-fix-typo-readme-a3f2",
  "session_id": "def-456",
  "active": true,
  "started_at": 1779203140063,
  "last_heartbeat": 1779203150000,
  "worker": "execute-task/adhoc",
  "worker_started": 1779203145000,
  "isolation_mode": "shared",
  "milestone_dir": null,
  "cwd": "C:/DEV/lookchina/whatsapp-omnichannel",
  "task_description": "Fix typo in README — 'recieve' → 'receive'",
  "pending_decisions": [],
  "pending_memories": []
}
```

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
  metadata.json   { acquired_at, holder_pid, holder_run_id, ttl_ms }
```

- TTL default 30s, configurable per acquire call
- Stale (mtime > TTL): next acquirer can `rmdir` + `mkdir` to steal (with a warning log)
- Released by removing the directory (`rmdir` after deleting metadata.json)
- No file locks (`fcntl`/`LockFileEx`) — directory locks are cross-platform and crash-resilient
