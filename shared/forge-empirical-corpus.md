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
