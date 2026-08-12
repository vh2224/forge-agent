# Item read-back (consumption of `.gsd/items/` fragments)

## Escopo

**Read-back only.** This spec fixes, exactly once, the procedure a consumer follows to *consume* a `.gsd/items/` fragment (resolve it, read it, render its provenance, mark it `doing`, record `promoted_to`). It creates **no** items — capture is the closed side, documented once in `shared/forge-review.md § Item capture`. If you need to understand how an item gets created in the first place, that section is the only source; this one never restates it.

Two consumers reference this section instead of restating it:
- `skills/forge-task/SKILL.md` — `/forge-task <item-id>` intake.
- `skills/forge-new-milestone/SKILL.md` — open-items listing before brainstorm.

Both MUST reference `shared/forge-items-readback.md § <section>` rather than copy invocation rules into their own body — the same discipline that keeps `§ Item capture` canonical-once.

## Detecção de referência

A consumer decides an argument **is** an item reference only when the **whole** remaining argument matches the item-ID shape and nothing else: `I-` followed by 1 to 14 digits (a full timestamp or a genuinely unique prefix of one), optionally followed by `-` and a slug (`^I-\d{1,14}(-[a-z0-9-]*)?$`). A whole-string match cannot collide with ordinary free text (sentences contain spaces), so a short prefix like `I-2026072912` is always routed to `--resolve` rather than silently degrading into a free-text task title. This is the compact form only — there is no dashed alternate (`I-20260729-120000` is **not** a valid item shape; it classifies as `legacy` under `forge-ids.classify`, never as a timestamp-form item ID).

Anything that does not match this shape — free text, a partial word, a sentence — is ordinary input and is left untouched. The shape check happens **before** calling `--resolve`; do not call `--resolve` speculatively on arbitrary text and treat a resolver error as "not an item" — that would turn a real typo (e.g. a dropped character in a real item ID) into silent free-text fallthrough, masking a mistake instead of stopping loud.

## Resolução

Once an argument passes the shape guard, resolve it with:

```bash
node scripts/forge-items.js --resolve "$ARG" --cwd "$WORKING_DIR"
```

Any unique prefix resolves — including a prefix as short as the item's short SHA-equivalent leading digits. Exit codes: `0` success (stdout is the full resolved ID), `1` unknown or ambiguous prefix, `2` bad arguments.

**LOUD STOP on non-zero exit.** A resolution failure is never advisory. Re-emit the CLI's stderr **verbatim** — the resolver already names every ambiguous candidate in its error message (`Ambiguous item prefix "..." — N candidates: ...`) or states the prefix is unknown. Stop the unit.

**Anti-rule, explicit:** never guess which candidate was meant, and never fall through to treating the string as a free-text description or title. A mistyped/ambiguous item ID must produce a visible stop, not a task quietly created about the wrong (or no) item.

## Leitura + proveniência

After resolution, read the item:

```bash
node scripts/forge-items.js --read "$ITEM_ID" --cwd "$WORKING_DIR"
```

Exit `0` prints the item as JSON on stdout; exit `1` means the ID (already resolved, so this should not happen absent a race) no longer exists. Fields available: `id`, `title`, `origin`, `status`, `source`, `file`, `sha`, `milestone`, `promoted_to`, `body`, `created`, `updated`.

Render a `## Item de origem` block from that JSON with this exact shape:

```markdown
## Item de origem

- **ID:** {id}
- **Origem:** {source}
- **Arquivo:** {file}
- **SHA:** {sha}
- **Milestone:** {milestone}
- **Status:** {status}

{body}
```

**Omission rule.** Any field that is absent (`undefined`, `null`, or empty string) in the JSON is **omitted entirely** from the block — the whole bullet line disappears. Never emit a placeholder (`unknown`, `n/a`, empty value after the colon) for a missing field. Both consumers render this block identically so provenance reads the same wherever it lands (e.g. inlined into a `{TASK_ID}-BRIEF.md`'s `## Task Brief`).

## Transição para `doing`

Fires once, at the moment the consuming unit actually starts (task registration for `/forge-task`; after the operator picks items for `/forge-new-milestone`):

```bash
node scripts/forge-items.js --set-status "$ITEM_ID" doing --cwd "$WORKING_DIR"
```

`--set-status` on an item **already** `doing` is a harmless no-op (it re-validates and rewrites the same status, bumping `updated`) — this is what makes it safe to call again on `/forge-task --resume`. Resume does **not** re-derive the item ID from anything but the `item:` frontmatter key already written into the BRIEF; re-running `--set-status doing` on resume is allowed but not required, never a re-intake.

## Promoção

```bash
node scripts/forge-items.js --promote "$ITEM_ID" "$TARGET_ID" --cwd "$WORKING_DIR"
```

Fires once, at registration for `/forge-task` (`$TARGET_ID` = the new `T-…`) or after the operator's selection for `/forge-new-milestone` (`$TARGET_ID` = the new `M-…`). Fresh runs only — never re-issued on resume (the record already exists from the original registration).

Targets are validated through `forge-ids.isValid` + `entityKind` on the store side (`isValidPromotionTarget` — kind must be `milestone` or `task`, never another item); a malformed or wrong-kind target exits `1` rather than writing garbage into the item.

## Itens `done`/`dropped`

A consumer that resolves an item already in status `done` or `dropped` refuses deterministically, with this exact operator hint:

```
Item {id} está {status} — reabra com: node scripts/forge-items.js --set-status {id} triaged
```

Never an `AskUserQuestion` here — this path must behave identically whether a human is present or the run is headless.

## Listagem de itens abertos

```bash
node scripts/forge-items.js --list --json --cwd "$WORKING_DIR"
```

Filter the returned array to `status` in `inbox` or `triaged` (sorted as the store returns — ascending by ID, the store's own order; do not re-sort). This is the listing `/forge-new-milestone` prints before brainstorm.

**Zero-items silent skip.** When the filtered list is empty, add **no** step, no prompt, no line of output — a flow with an empty backlog must look exactly like a flow that never had item support at all.

## Postura de falha

Split deliberately, matching the posture already established in `shared/forge-review.md § Item capture`:

- **Resolution failure = LOUD.** Covered above — stop the unit, re-emit stderr verbatim, never guess or degrade.
- **Mutation failure = advisory.** If `--set-status` or `--promote` exits non-zero, log **one warning line** and continue — a bookkeeping write failing must never throw away work already in motion (the task/milestone still gets created; only the item's own status/`promoted_to` field silently lags).

## Consumidores

- `skills/forge-task/SKILL.md` — item-ID intake at argument parsing: resolve → read/provenance into `{TASK_ID}-BRIEF.md` → `doing` → `promoted_to: T-…`. References this file; does not restate the resolver contract, the provenance block shape, or the failure posture.
- `skills/forge-new-milestone/SKILL.md` — lists open items (`inbox`/`triaged`) before brainstorm, lets the operator pick, promotes picked items to `promoted_to: M-…`. References this file for the listing filter, the zero-items skip, and the promotion rule.

## Cross-references

- `shared/forge-review.md § Item capture` — the capture-side counterpart (closed list of sources, `--add` invocation, argv-builder discipline). This file never restates it.
- `scripts/forge-items.js` — the only read/write path for `.gsd/items/`; `cliMain` is the CLI contract this spec documents (`--resolve`, `--read`, `--list --json`, `--set-status`, `--promote`, exit codes `0`/`1`/`2`).
- `scripts/forge-ids.js` — `isValid`/`entityKind`/`classify`, the ID-shape functions `resolveItemId` and `isValidPromotionTarget` route through.

## Installer verdict

No installer change needed. `shared/*.md` is glob-installed by both installers:
- `install.sh` (`shared` copy loop, ~line 427) — globs `*.md` inside `shared/`.
- `install.ps1` (`Join-Path … 'shared'` block, ~line 360) — same glob, PowerShell form.

This file lands in `${FORGE_HOME:-$HOME/.forge-agent}/shared/` on the next `./install.sh` / `install.ps1` run without any script edit. Confirmed by inspection of both loops (see task step 5).
