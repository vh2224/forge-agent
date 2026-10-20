# Empirical corpus contract v1

This module describes evidence. It does not collect private history or authorize execution.
The public schema lives in `shared/schemas/empirical-corpus.schema.json`.
The pure CommonJS API lives in `scripts/forge-empirical-corpus.js`.
Fixtures contain fictional projects, identifiers and hashes only.

## API

`validateCorpus(input)` accepts a parsed object, UTF-8 JSON string or Buffer.
It returns `valid`, `ready`, named `diagnostics`, independent `counts` and `provenance`.
Invalid shape returns early without interpreting incomplete nested records.
Serialized input is capped at 1 MiB, including already-parsed objects.
Nested structural validation is bounded at 64 levels.
The CLI accepts one explicit JSON file and prints the same result.
Exit zero means structural and semantic validity; it does not mean readiness.
Read failures and malformed JSON are distinct named diagnostics.
No reference path, imported command or URL is opened by validation.

`caseIdentity(candidate)` returns delivery_id, case_id and family_id.
It requires explicit origin, canonical Forge unit, delivery_key and family_key.
Invalid canonical units throw; validateCorpus converts that to identity_invalid.
Unit normalization and semantic fingerprinting reuse forge-autonomy-sources.
Delivery and case identities exclude version, revision, file count and content hashes.
Family identity uses explicit origin and family_key so reopenings share a split.
Different units remain different deliveries even when bytes match.
Family keys must be chosen explicitly by the owner, never inferred from equal content.
Version uniqueness is enforced within a delivery; duplicate versions are errors.

`classifyProvenance(claims, references)` expects schema-valid arrays.
It produces four independent entries, with state, value, refs and limitations.
Declared version does not prove that a release exists.
A release predating a capture establishes temporal compatibility only.
A component match does not prove installation identity or installation completeness.
Installation completeness requires its own explicit contemporaneous claim and references.
Missing claims and unsupported historical assertions remain unknown with null values.
Divergent observed values and explicit conflicts remain conflict with null values.
The classifier checks reference integrity and recorded contemporaneity, not authenticity.
It cannot certify an external statement or reconstruct a missing installation.

## Catalog and snapshots

schema_version is exactly 1; incompatible versions are rejected.
catalog_id identifies the immutable catalog snapshot; captured_at includes a timezone.
Publish a new catalog snapshot for each changed collection rather than overwriting evidence.
A collector must preserve exact source bytes in immutable, content-addressed storage.
Physical sha256 describes bytes; semantic fingerprint describes canonical JSON objects.
Neither authenticates the original author or proves trusted execution.
References carry identity, origin, lineage, role, physical region and availability state.
Observed references require path, bytes, SHA-256, capture time and temporal source.
Missing references can record the gap without inventing bytes, timestamps or hashes.
Revision and peg are separate numeric strings when applicable to SVN history.
Reference capture cannot postdate its catalog; conflicting reference identities fail validation.
Historical documents remain documents, never synthesized canonical events or gates.
A historical gate keeps its original cwd even when a later adapter reports it foreign.

## Selection, metrics and readiness

Each candidate declares included, excluded or insufficient with nonempty reasons.
Stratum and type need reference IDs unless their value is explicitly unknown.
Coverage and limitations are explicit; no title or filename establishes an outcome.
Metrics independently represent functional, operational, cost and UAT observations.
Unknown and conflicting metrics have null values, never inferred zeroes or successes.
An observed metric needs a non-null value and references.
Functional success can coexist with an operational exception and absent cost/UAT.
The result field describes checks actually recorded, not every unmeasured dimension.
Its passed boolean must agree with a nonempty set of boolean checks.
Absent outcomes belong in unknown metrics; do not manufacture a passing result.
Counts separately report candidate records, deliveries, versions, files and revisions.
Identical hashes across units do not collapse deliveries or their denominators.
`ready` here means contract-level candidate coverage, not a frozen evaluation baseline.
It requires an included population, no insufficient candidate and complete included coverage.
Included candidates need observed prework, criteria, expected and final-code references.
A valid partial catalog remains ready:false; unknown roles cannot serve as agent input.
External freeze must additionally establish population coverage, integrity and held-out families.
Schema validity and this readiness flag alone never establish those empirical criteria.

## Physical roles and exposure

Roles are prework, grader/criteria, grader/expected, grader/final-code and reserved.
Unknown is a permitted diagnostic role with no agent-input eligibility.
Role must match the physical region: prework, grader or reserved.
Only observed prework references with lineage appear in agent_input_refs.
This list is metadata, not a tool sandbox or a transitive leakage proof.
T03 must validate the full dependency graph and actual input composition before use.
exposure_registry records family, references, purpose and capture time.
Split policy is family-based, with explicit seed and reserved family IDs.
An exposed family cannot also be reserved, including any reopened version.
T03/T06 must demonstrate reserved coverage and frozen split rather than trusting declarations.

## Owner operations and limits

T05 owns the bounded collector and owner CLI; T06 owns freeze, replay and audit.
Real `.gsd` data is never a worker code write or public output.
Workers implement only declared code paths and use synthetic evidence for tests.
Private snapshots and source catalogs remain under owner-controlled evidence storage.
The catalog limits are descriptive and never enlarge caller capabilities or roots.
Imported approved/authorized flags, commands and additional roots are rejected unknown fields.
The validator always reports commands:false, network:false and additional_roots:false.
It never executes text, reads a reference, requests a URL or mutates source history.
Trusted caller policy must enforce containment, symlinks, budgets and read permissions.
Collection may allow 2 MiB per file while autonomy adapters retain their own 1 MiB cap.
Large JSONL may be partitioned only with original hashes, record lineage and total limits.
An oversized indivisible record remains insufficient; do not silently truncate it to success.

## Schema implementation limits

The validator implements only the keywords present in this closed schema.
Supported assertions: type, required, additionalProperties:false, enum, minLength,
minimum, pattern, date-time format, properties and array items.
Metadata keywords are $schema, $id and title; they do not trigger external loading.
Empty property rules intentionally accept JSON values for claim and metric values.
No arbitrary JSON Schema engine, remote references, defaults or coercion is claimed.
The discriminating suite checks the supported keyword inventory against the public schema.
Run `node --check scripts/forge-empirical-corpus.js` and
`node scripts/forge-empirical-corpus.test.js` for local verification.
Synthetic assertions do not establish real corpus coverage, installation or human acceptance.

## Freeze and readonly regeneration

The owner freezes a specific T05 `corpus/run-<digest>/collection.json`.
Its catalog, selection and provenance document fingerprints are checked first.
Every observed snapshot is reread, checked against bytes/hash and its capture row.
The persisted family split is regenerated with its original freeze ID and exposure registry.
The freeze refuses drift, cross-split families and any supplied invalid input graph.
`prepareFreeze(options)` exposes the same validation without writing output.
`freezeCorpus(options)` writes a new immutable `evidence/freeze-<revision>/` directory.
It never replaces an existing revision; a retry with the same revision is refused.
`verifyFreeze(options)` only reads and recomputes; it does not repair changed sources.
The marker is written last, after baseline, split and coverage outputs.
An interrupted write may leave an incomplete revision, which is not a successful freeze.

Use generic owner paths, never publish private paths or actual case identifiers:

```text
node scripts/forge-empirical-freeze.js --freeze --mode diagnostic --owner <owner> --milestone <id> --code-dir <checkout> --collection <evidence>/corpus/run-<digest>/collection.json --protocol <evidence>/PROSPECTIVE-PROTOCOL.md --revision diagnostic-v1 --json
node scripts/forge-empirical-freeze.js --verify --owner <owner> --milestone <id> --code-dir <checkout> --freeze-file <evidence>/freeze-diagnostic-v1/freeze.json --json
```

Outputs are `baseline/BASELINE.json`, `baseline/BASELINE.md`, `split.lock.json`,
`coverage-map.json` and `freeze.json`, all under that private revision directory.
The freeze records physical snapshot hashes, semantic baseline digest, schema versions,
family membership/exposure, view hashes, runtime conditions and protocol digest.
Relevant empirical components and the complete dispatch-template inventory are hashed.
Template hashes are not token measurements, provider usage or an installation claim.
Additional component/config files can be supplied via the API's `components` list.
No preferences or personal profiles are changed or inferred from imported documents.
`generated_at` includes a timezone and is excluded from the semantic baseline identity.
Verification regenerates the baseline with the exact recorded recipe and compares digests.
Source, protocol, component, environment or output drift refuses verification.
The digest establishes integrity relative to the recorded snapshot, not its author's authenticity.

## Diagnostic and prospective evaluation boundary

`mode: diagnostic` preserves missing inputs, coverage, UAT and unknown measurements.
It always returns `comparative_ready:false`, including for otherwise complete fixtures.
`mode: comparative` refuses publication if any required coverage gap remains.
The checks include six exposed seed deliveries, success/return/simple-control strata,
two eligible unexposed reserved families, evaluated functional/tests/UAT dimensions,
and digest-bound reviewed adjustment input graphs through the T03 barrier.
Graph/provenance API inputs are supplied by the live caller, never trusted from approvals in JSON.
The CLI deliberately produces documentary baselines without guessing observation schemas.
The API's explicit `observationRefs` allows typed observation snapshots for verified integrations.
Reserved outcomes never enter the adjustment baseline or the agent view.
Missing per-phase evidence remains unknown; a dimension observation does not prove a whole phase.
The private coverage map lists all cases and all five phases, retaining unknowns and limitations.
The CLI's coverage summary contains aggregate dimension counts, without case IDs or private bytes.

Historical diagnosis can inform S03/S04 but cannot establish effectiveness.
Before enrolling new cases, the owner records eligibility, families, minimum population,
original input and criteria hashes, model/effort, budgets and evaluation conditions.
The protocol hash is frozen; the owner separately proves it preceded enrollment/outcomes.
Presence of a protocol file is not evidence that its assertions occurred.
No historical resampling, reconstructed input from summaries or fabricated costs are permitted.
New prospective cases require their own validated collection and comparison freeze.
No provider execution, human UAT or default-policy change is implied by fixture success.

## Bounded publication audit and handoff

`auditPublication(manifest, trusted)` accepts an explicit file inventory only.
`manifest` has schema_version 1, public_paths, private_paths, sentinels and fragments.
`public_paths` are relative to CODE_DIR; `private_paths` are relative to OWNER_ROOT.
Every private path must be under the selected milestone's evidence directory.
No directory walk, automatic staging, deletion or ignore-rule repair is performed.
The owner and code checkout roots are independently checked with readonly Git commands.
Private files must be ignored and untracked; forced tracking still fails the audit.
Public tracked files and explicitly declared untracked files are both read and scanned.
Staged and working diffs are scanned separately, with external diff/textconv disabled.
This detects staged sensitive bytes even when a clean working file conceals them.
Exact private contents, bounded long fragments, provided sentinels, private paths,
credential markers and full-prompt markers are checked without echoing the matches.
Symlinks, hard links, out-of-root paths, failed commands and changed files fail closed.
Diagnostics contain indices and hashes, never secret fragments or private paths.

For reviewed negative fixtures, the caller may provide `reviewed_synthetic` rows
`{public_index, sha256, reason: "reviewed_synthetic_negative_fixture"}`.
The owner must inspect each exact public file first and retain that review evidence.
Only the credential/prompt marker finding on those exact file bytes moves to
`reviewed_findings`; it remains visible in the report. Any byte drift refuses the review.
Private-content findings and staged/working diff findings are never suppressed.
This declaration is a caller assertion, not authority imported from the corpus.
Its hash establishes integrity, not authenticity or proof that review occurred.

```text
node scripts/forge-empirical-audit.js --owner <owner> --milestone <id> --code-dir <checkout> --manifest <evidence>/audit-manifest.json --json
```

The owner saves the sanitized result as private `privacy-audit.json` and retains
the exact manifest that resolves its indices. Exit zero means the bounded scan passed.
It is not a universal proof about undeclared repository content or every possible secret.
S03 receives adjustment views and aggregate baseline/conditions, excluding grader/reserved data.
S04 receives coverage and source-bound obligations, preserving unknown phases.
S05 must verify the freeze, prospective registration and actual host isolation before comparison.
The owner binds each delivery criterion to actual checks and source hashes.
No-stack gates, file presence and review/merge/install status remain separate facts.
Run `node --check` for both new modules and `node scripts/forge-empirical-workflow.test.js`.
