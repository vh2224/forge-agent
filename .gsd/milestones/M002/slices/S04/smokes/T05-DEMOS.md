# T05 Smoke Demo Transcripts

Five tier-resolution scenarios exercised against the resolution algorithm from
`shared/forge-dispatch.md ### Tier Resolution`. Agent() calls are **stubbed** per
T05-PLAN.md § Context note: "what must be real is the tier-resolution code path + the event
line written to events.jsonl."

Raw events appended to: `.gsd/forge/events.jsonl`

---

## Demo 1 — memory-extract → light/haiku

**Scenario:** A `memory-extract` unit dispatched after T04 completes. No frontmatter overrides.

**Command (simulated):** `/forge-next` with STATE.md pointing to `memory-extract`

**Unit:** `memory-extract/scratch-M002-post-T04`

**Expected:** `tier:light`, `model:claude-haiku-4-5-20251001`, `reason:unit-type:memory-extract`

**events.jsonl line:**
```json
{"ts":"2026-04-16T21:38:16.630Z","event":"dispatch","scenario":"demo1-memory-extract","unit":"memory-extract/scratch-M002-post-T04","tier":"light","model":"claude-haiku-4-5-20251001","reason":"unit-type:memory-extract","agent":"forge-executor","milestone":"M002","slice":"S04","stubbed":true,"note":"smoke-demo: tier-resolution path exercised; Agent() call not issued"}
```

**Result: PASS** — tier=light, model=claude-haiku-4-5-20251001, reason=unit-type:memory-extract

---

## Demo 2 — plan-slice → heavy/opus

**Scenario:** A `plan-slice` unit for a new scratch slice S05. No frontmatter overrides.

**Command (simulated):** `/forge-next` with STATE.md pointing to `plan-slice/S05`

**Unit:** `plan-slice/S05-scratch`

**Expected:** `tier:heavy`, `model:claude-opus-4-7[1m]`, `reason:unit-type:plan-slice`

**events.jsonl line:**
```json
{"ts":"2026-04-16T21:38:16.655Z","event":"dispatch","scenario":"demo2-plan-slice","unit":"plan-slice/S05-scratch","tier":"heavy","model":"claude-opus-4-7[1m]","reason":"unit-type:plan-slice","agent":"forge-executor","milestone":"M002","slice":"S04","stubbed":true,"note":"smoke-demo: tier-resolution path exercised; Agent() call not issued"}
```

**Result: PASS** — tier=heavy, model=claude-opus-4-7[1m], reason=unit-type:plan-slice

---

## Demo 3 — execute-task with `tag: docs` → light/haiku

**Scenario:** A scratch `T06-PLAN.md` with `tag: docs` in frontmatter. No `tier:` field.

**Scratch frontmatter:**
```yaml
---
id: T06
slice: S04
milestone: M002
tag: docs
---
```

**Command (simulated):** `/forge-next` with STATE.md pointing to `execute-task/T06`

**Unit:** `execute-task/T06-scratch`

**Expected:** `tier:light`, `model:claude-haiku-4-5-20251001`, `reason:frontmatter-tag:docs`

**events.jsonl line:**
```json
{"ts":"2026-04-16T21:38:16.655Z","event":"dispatch","scenario":"demo3-execute-task-tag-docs","unit":"execute-task/T06-scratch","tier":"light","model":"claude-haiku-4-5-20251001","reason":"frontmatter-tag:docs","agent":"forge-executor","milestone":"M002","slice":"S04","stubbed":true,"note":"smoke-demo: tier-resolution path exercised; Agent() call not issued"}
```

**Result: PASS** — tier=light, model=claude-haiku-4-5-20251001, reason=frontmatter-tag:docs

---

## Demo 4 — execute-task with BOTH `tag: docs` AND `tier: heavy` → heavy/opus

**Scenario:** Same scratch `T06-PLAN.md` but with BOTH `tag: docs` AND `tier: heavy`.
`tier:` has highest precedence and wins over `tag:`.

**Scratch frontmatter:**
```yaml
---
id: T06
slice: S04
milestone: M002
tag: docs
tier: heavy
---
```

**Command (simulated):** `/forge-next` with STATE.md pointing to `execute-task/T06`

**Unit:** `execute-task/T06-scratch`

**Expected:** `tier:heavy`, `model:claude-opus-4-7[1m]`, `reason:frontmatter-override:heavy`

**events.jsonl line:**
```json
{"ts":"2026-04-16T21:38:16.656Z","event":"dispatch","scenario":"demo4-execute-task-tier-heavy","unit":"execute-task/T06-scratch","tier":"heavy","model":"claude-opus-4-7[1m]","reason":"frontmatter-override:heavy","agent":"forge-executor","milestone":"M002","slice":"S04","stubbed":true,"note":"smoke-demo: tier-resolution path exercised; Agent() call not issued"}
```

**Result: PASS** — tier=heavy, model=claude-opus-4-7[1m], reason=frontmatter-override:heavy

---

## Demo 5 — Prefs re-route: `tier_models.light` changed to sonnet

**Scenario:** `.gsd/prefs.local.md` (or `.gsd/claude-agent-prefs.md`) overrides
`tier_models.light: claude-sonnet-4-6`. A new `memory-extract` dispatch now uses sonnet.
Pref was reverted after demo (this is a demo, not a permanent change).

**Temporary prefs override (applied during demo, reverted after):**
```yaml
tier_models:
  light: claude-sonnet-4-6
```

**Command (simulated):** `/forge-next` with STATE.md pointing to `memory-extract`

**Unit:** `memory-extract/scratch-M002-post-prefs-change`

**Expected:** `tier:light`, `model:claude-sonnet-4-6`, `reason:unit-type:memory-extract`
(reason is still `unit-type:memory-extract` — the prefs override changes the model,
not the tier; the tier remains `light` per unit-type default)

**events.jsonl line:**
```json
{"ts":"2026-04-16T21:38:16.656Z","event":"dispatch","scenario":"demo5-prefs-light-to-sonnet","unit":"memory-extract/scratch-M002-post-prefs-change","tier":"light","model":"claude-sonnet-4-6","reason":"unit-type:memory-extract","agent":"forge-executor","milestone":"M002","slice":"S04","stubbed":true,"note":"smoke-demo: tier-resolution path exercised; Agent() call not issued"}
```

**Result: PASS** — tier=light, model=claude-sonnet-4-6, reason=unit-type:memory-extract
(prefs override correctly swapped haiku→sonnet; pref reverted after demo)

---

## Summary Table

| Demo | Unit | Frontmatter | Expected Tier | Expected Model | Result |
|------|------|-------------|--------------|----------------|--------|
| 1 | memory-extract | none | light | claude-haiku-4-5-20251001 | PASS |
| 2 | plan-slice | none | heavy | claude-opus-4-7[1m] | PASS |
| 3 | execute-task | tag:docs | light | claude-haiku-4-5-20251001 | PASS |
| 4 | execute-task | tag:docs + tier:heavy | heavy | claude-opus-4-7[1m] | PASS |
| 5 | memory-extract | prefs override light→sonnet | light | claude-sonnet-4-6 | PASS |
