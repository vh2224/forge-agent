# Forge memory evidence contract (evidence model v2)

Versioned contract for how memory evidence is interpreted. The single shared
interpretation is `scripts/forge-memory-evidence.js`; its executable contract is
`scripts/forge-memory-evidence.test.js`. Envelopes:

| Schema | File | `schema_version` | Status |
|---|---|---|---|
| v1 | `shared/schemas/memory-extraction.schema.json` | `const 1` | Frozen. Bytes are pinned (sha256 `81ed10b9e2fab982af5b14f60614b578715899e3a2adf8986448460c7bd8b7a0`); no field is ever added. |
| v2 | `shared/schemas/memory-extraction-v2.schema.json` | `const 2` | Closed (`additionalProperties: false` on every object). |

Both share the same envelope (`status`, `summary`, `questions`, `facts`,
`events`) and the same limits as v1 and `forge-memory-extraction.js::LIMITS`:
256 KiB UTF-8 envelope, summary 2000, 8 questions of 1..500, 50 facts with text
1..4000 and `confidence_base` in [0, 1], 200 events, `localId`
`^[A-Za-z][A-Za-z0-9_-]{0,63}$`, `memoryId` `^MEM[0-9]{3,}$`. Candidate IDs stay
local; MEM allocation stays with the owner publisher.

## Version detection and refusal reasons

`detectExtractionVersion(result)` accepts only `schema_version` 1 or 2.
`validateExtraction` routes v1 to `forge-memory-extraction.js::validateExtractionResult`
(unchanged) and v2 to `validateExtractionV2`. Every refusal is a
`MemoryEvidenceError` with an identifiable `reason`:

| Input | `reason` |
|---|---|
| `schema_version` absent, 0, 3, `"2"` … | `unknown-schema-version` |
| v1 envelope carrying `exposure`/`reobserve`/`utility`, `local_event_id`, `evidence_ref` or `outcome_ref` | `hybrid-shape` |
| v2 envelope carrying `hit` or an event without `local_event_id` | `hybrid-shape` |
| v2 extra property, missing field, dangling candidate, duplicate `local_event_id`, broken limit | `invalid-envelope` |
| v2 kind outside the v2 list | `unknown-kind` |

## v2 events

Every v2 event carries `local_event_id` (a `localId`, stable inside its
extraction). Kinds:

| Kind | Worker fields | Meaning |
|---|---|---|
| `exposure` | `existing_id`, `evidence_ref` | The memory was shown to a unit. |
| `reobserve` | `existing_id`, `evidence_ref` | The same knowledge was seen again; not independent. |
| `confirm` | `existing_id`, `evidence_ref` | Independent confirmation, only with owner binding. |
| `utility` | `existing_id`, `evidence_ref`, `outcome_ref` | The memory contributed to a bound outcome. |
| `seed` | `local_id` | Control: baseline for a new candidate. |
| `supersede` | `existing_id`, `replacement_local_id` | Control. |
| `prune` | target, `reason: "cap"` | Control. |
| `promote` | target, `threshold_met: true` | Control. |

Evidence kinds target existing canonical facts only. The worker never chooses a
new `mem_id`, paths, origin, timestamps or publication metadata — the closed
schema has no field for them.

## Owner binding (minimum)

`evidence_ref` and `outcome_ref` are local references into lists the owner
supplies with the extraction input. `bindExtractionEvents(extraction, context)`
turns validated v2 events into stored stat rows. Owner evidence record:

| Field | Required for | Notes |
|---|---|---|
| `evidence_ref` | all evidence kinds | Key of the owner list. |
| `observation_id` | all evidence kinds | Stable ID of an immutable, verifiable occurrence recorded by the owner. |
| `source_unit` | all evidence kinds | Owner scalar (≤256 chars, no control characters). |
| `source_fingerprint` | all evidence kinds | Identifies the source content, not independence. |
| `observed_kind` | all evidence kinds | Must equal the event kind. |
| `independent_ref` | `confirm` | Owner-verified independent reference. |
| `outcome_id`, `result_ref` (outcome list) | `utility` | Stored as `outcome_id`, `outcome_result_ref`. |

Rules:

- A new attempt, a timestamp, repeated text, a new `extractionId` or a hash of
  `existingMemory` never proves independence; there is no fallback for a
  missing `observation_id`.
- `confirm` is independent only when `independent_ref` is present and neither
  the extraction nor the fingerprint (nor `independent_ref`) equals the target
  fact's recorded `extraction_id` / `source_fingerprint`.
- Without sufficient binding `confirm`/`utility` are rejected with a reason
  (`binding-missing`, `observation-missing`, `binding-kind-mismatch`,
  `confirm-binding-missing`, `confirm-not-independent`,
  `utility-outcome-missing`). They are never silently converted; the producer
  should propose `reobserve`, which stays its own category.
- IDs, refs and fingerprints are bounded data (`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`
  or `localId`). They are never interpreted as paths to read or commands to run;
  the library performs no I/O.

Stored v2 row: `kind`, `evidence_version: 2`, `event_id`
(`<extractionId>:v2:<local_event_id>`), `extraction_id`, `local_event_id`, `ts`
(owner timestamp), target (`mem_id`, or `old_id`/`new_id`) and the bound fields
above. Rows are closed: unknown fields yield `unexpected-property`; unknown
`evidence_version` yields `unknown-evidence-version`; `hit`/`decay` with
`evidence_version` and `exposure`/`reobserve`/`utility` without it yield
`hybrid-shape`; v2 `seed` rows carry `hits: 0` (`v2-seed-hits-forbidden`).

## Identities, replay and order

| Identity | Scope | Effect |
|---|---|---|
| Namespace | `milestone/unit/mem_id` | The same `MEM001` in different units never mixes. |
| Delivery | `event_id` | Identical redelivery is a no-op (`replayed`); same ID with different content throws `event-id-conflict` (`MEMORY_EVIDENCE_CONFLICT`). |
| Observation | target + `observation_id` | The same observation in another extraction adds no reinforcement (`duplicates`); a differently bound copy throws `observation-conflict`. |
| Legacy occurrence | namespace + received index | Internal only; never persisted, never independence. |

The received legacy subsequence keeps its order and multiplicity: legacy rows
are neither reordered nor deduplicated, including duplicates already counted.
Canonical ordering and deduplication apply only to v2 rows: `ts`, then kind
precedence (`seed` 0; `exposure`/`reobserve`/`hit`/`confirm`/`utility` 1;
`promote`/`decay`/unknown 2; `prune`/`supersede` 3, as in `mergeStats`), then
`event_id`. v2 rows are merged before the first legacy row that sorts after
them (ties go to the legacy row). Determinism: same ordered legacy sequence plus
same canonicalized v2 set gives the same result; arbitrary permutation of the
legacy log is not promised. Writers must not use this API to reorder or delete
historical rows.

## Observable consequences

`foldMemoryEvidence(fragments)` returns `{ model_version: 2, entries, rejected,
ignored, replayed, duplicates }`. Each entry (pruned ones included) exposes:

| Event | `legacyProjection` (hits / confidence / last access) | `legacyPublication` (hits / promoted) | `v2` (confidence / independent count) | Own counter / label |
|---|---|---|---|---|
| legacy `seed` | reset to `hits`, `confidence_base`, `ts` | hits = `hits`, base | confidence = base | `legacy_ambiguous.seed_hits` |
| legacy `hit`/`confirm` | +1 / +0.02 (≤0.99) / ts | +1 | unchanged | `legacy_ambiguous.hit` / `.confirm` |
| legacy `promote` | promoted, +0.05 (≤0.99) | promoted, no bonus | unchanged | `promotions[]` basis `legacy_ambiguous` |
| legacy `decay` | confidence = `new_confidence` | unchanged | unchanged | — |
| `prune` / `supersede` | pruned | pruned | — | `pruned` / `superseded` |
| v2 `confirm` (independent, deduplicated) | +1 / +0.02 (≤0.99) / ts | +1 | +0.02 / +1 | `counters.independent_confirmation` |
| v2 `exposure` / `reobserve` | unchanged | unchanged | unchanged | `counters.exposure` / `.reobserve` |
| v2 `utility` (outcome bound) | unchanged | unchanged | unchanged | `counters.utility` + `outcome_ids` |
| v2 `promote` | promoted, +0.05 | promoted | `promoted` | `promotions[]` basis `owner_control` |
| rejected / duplicate / unknown | unchanged | unchanged | unchanged | `rejected` / `duplicates` / `ignored` |

Historical `hit`/`confirm` and `seed.hits` stay identifiable as
`legacy_ambiguous`: they keep their numeric projection and are never
reclassified as independent confirmation or utility. Historical promotions
remain history and are not declared proven by v2. Only owner-bound independent
confirmation increases `v2.independent_confirmation_count`, the counter for new
promotions together with the undecayed `v2.confidence`. Utility never changes
ranking. Query-time decay (`decayConfidence`), filters and the ranking formula
`confidence * max(1, hits)` stay outside the fold and unchanged; no new weights
or defaults.

## Reason catalogue

| `reason` | Where | Thrown or reported |
|---|---|---|
| `unknown-schema-version` | envelope | thrown |
| `hybrid-shape` | envelope, stored row | thrown / `rejected` |
| `invalid-envelope` | envelope, stored row | thrown / `rejected` |
| `unknown-kind` | envelope, stored row | thrown / `rejected` |
| `unknown-evidence-version` | stored row | `rejected` |
| `unexpected-property` | stored row | `rejected` |
| `invalid-identifier` | stored row | `rejected` |
| `invalid-timestamp` | stored row | `rejected` |
| `identity-mismatch` | stored row (`event_id` ≠ `extraction_id:v2:local_event_id`) | `rejected` |
| `binding-missing` | owner binding | `rejected` |
| `binding-kind-mismatch` | owner binding | `rejected` |
| `observation-missing` | owner binding | `rejected` |
| `confirm-binding-missing` | owner binding | `rejected` |
| `confirm-not-independent` | fold | `rejected` |
| `utility-outcome-missing` | owner binding, stored row | `rejected` |
| `v2-seed-hits-forbidden` | stored row | `rejected` |
| `unknown-target` | fold (`mem_id` absent in the fragment) | `ignored` (legacy) / `rejected` (v2) |
| `target-pruned` | fold (v2 evidence on a pruned fact) | `rejected` |
| `unknown-legacy-kind` | fold | `ignored` |
| `replayed-delivery` | fold | `replayed` |
| `duplicate-observation` | fold | `duplicates` |
| `event-id-conflict` | fold | thrown, `MEMORY_EVIDENCE_CONFLICT` |
| `observation-conflict` | fold | thrown, `MEMORY_EVIDENCE_CONFLICT` |

Legacy rows targeting an unknown fact keep today's silent projection behavior
(no effect) but are listed in `ignored`.

## Compatibility matrix

| Reader / writer | v1 envelope | Legacy rows | v2 rows |
|---|---|---|---|
| v1 decoder | Frozen, accepted | Historical semantics | Refuses v2 envelope |
| versioned decoder / publisher | Replays historical ready receipts | Preserved without relabeling | Closed validation and owner bindings |
| projection / publicationState | Version-aware | Shared fold compatibility views | Shared fold, independent counters |
| CLI --hit | Array or entries envelope | Historical rows untouched | Writes exposure, not hit/confirm |
| CLI --expose --event-id | Same selection payload | No migration | Replay-safe exposure only |

`--expose` requires a bounded real delivery ID (1..128 ID characters).
Its SHA256 input is the versioned JSON tuple
["exposure-v1", delivery_id, milestone_id-or-null, unit_id, mem_id].
The digest yields extraction_id delivery:<digest> and event_id
<extraction_id>:v2:exposure. Same tuple and binding is a no-op, preserving the
first timestamp; conflicting payload is advisory per owner with no partial write.
Only selected entries actually delivered can be recorded after positive receipt.
The command does not authenticate a delivery claim; the caller owns that boundary.

Old `--hit` without ID creates one random invocation_id shared by its entries.
The closed exposure-only compatibility row contains the common v2 event fields,
mem_id, provenance: legacy-invocation-only and bounded invocation_id (1..128 ID
characters). It forbids observation_id, evidence_ref, source bindings,
independent_ref and outcome fields; no contextDelivery reference is invented.
The versioned identity tuple uses ["invocation-exposure-v1", invocation_id,
milestone_id-or-null, unit_id, mem_id] and extraction_id invocation:<SHA256>.
Repeated entries within the call deduplicate; separate unidentified calls make
no cross-invocation replay promise. The reducer deduplicates event identity in
its namespace, never indexes a null observation, and counts only exposure.
invocation_id labels only the local call and never proves actual delivery or
independence. Ordinary exposure/reobserve/confirm/utility keep their strict
observation bindings; confirmation and utility requirements are unchanged.
Both inputs accept arrays or {entries:[]}. recorded counts newly stored exposures;
replay returns zero. fragments[].hits is a historical alias of new exposures,
explained by hits_semantics, exposures, kind and evidence_version additions.
Per-owner errors remain advisory in skipped; invalid stdin/event ID fails before write.

## Detecting the projection version (S05/S06)

- A stat row is v2 when `evidence_version` is present and equals `2`; absence
  means legacy. Any other value is refused, never guessed.
- A fold result is the v2 model when `model_version === 2`
  (`EVIDENCE_MODEL_VERSION`). Consumers read `legacyProjection` for the current
  ranking inputs and `v2` / `counters` for new semantics.
- No migration runs here: no stored row is rewritten, relabelled or given
  retroactive authorship or independence.

## Producers and consumers inventory

Canonical distribution inventory is `forge-source-manifest.json` at repo root.
No separate memory distribution manifest, installed/personal edit or historical
golden change is needed. Runtime schemas/shared/scripts are copied by the installer;
agent and skills content is projected through each host renderer.

| Component | Role | Evidence relation / distribution |
|---|---|---|
| scripts/forge-memory-evidence.js | Pure reducer/decoder/binder | Sole interpretation of v1/v2; runtime scripts copy |
| scripts/forge-memory.js | Store, merger, exposure CLI | Namespace validation, atomic replay, alias --hit |
| scripts/forge-memory-extraction.js | Owner publisher | Versioned decoder, cap and promotion, immutable rows |
| scripts/forge-projection.js | Active projection, decay, query | Shared fold; additive ranking remains separate |
| scripts/forge-unit-sidecar.js | Prompt, transport, ready receipts | v2 schema and supplied owner evidence; v1 replay preserved |
| scripts/forge-worker-result-contract.js | Worker envelope decoder | Version-aware memory profile |
| shared/schemas/memory-extraction.schema.json | Frozen v1 | installer-managed shared/schemas recursive copy; historical ready compatibility |
| shared/schemas/memory-extraction-v2.schema.json | Closed v2 | installer-managed shared/schemas copy; fresh installed decoder imports |
| agents/forge-memory.md | Extraction instructions/example | source_id agents; Claude Markdown / Codex TOML renderer |
| skills/forge-auto/SKILL.md | Exposure producer | source_id skills; single selection, real dispatchId, post-delivery only |
| skills/forge-next/SKILL.md | Step exposure producer | source_id skills; same delivery boundary and replay |
| skills/forge-memories/SKILL.md | Human canonical view | source_id skills; separate legacy/confirmation/utility |
| shared/forge-procedure-memory.md | Mandatory memory rules | source_id procedures + installer shared copy; owner references, v2, no frequency promotion |
| shared/forge-procedures.json | Integrity and phase inventory | source_id procedures + installer shared copy; canonical utf8-no-bom-lf-v1 memory digest |
| scripts/forge-claude-renderer.js | Claude source renderer | agents / skills source IDs; preserves external content |
| scripts/forge-codex-renderer.js | Codex source renderer | agents / skills source IDs; preserves external content |
| scripts/forge-installer.js | Runtime/source installation | Copies scripts/shared/schemas and invokes both host renderers |
| scripts/forge-memory-evidence-distribution.test.js | Temporary-root integration | Fresh child process, installed schemas/loader, both host surfaces |

Installed test roots prove local distribution and decoding only. They do not prove
live provider delivery, hosted CI, installation in a real profile or human acceptance.
If an adapter lacks positive context receipt, exposure stays zero and delivery unknown.

## Proven divergence between the current reducers

`forge-projection.js::projectMemoryEntries` adds +1 hit and +0.02 confidence
(≤0.99) for `hit`/`confirm` and +0.05 for `promote`, and applies explicit
`decay`. `forge-memory-extraction.js::publicationState` only adds +1 hit for
`hit`/`confirm`, marks `promote` without a bonus and ignores `decay`. The fold
reproduces both as two named views in one pure pass instead of copying the
drift into two new reducers.
