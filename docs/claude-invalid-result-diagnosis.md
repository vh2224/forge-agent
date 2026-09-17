# Claude sidecar rejection: investigation and correction

Date: 2026-09-17. Scope: Forge sources only.
Incident evidence was read-only; the affected project's execution, product,
routing preferences, checkpoint and installed runtime were not changed.
No provider request, deploy or installation was performed.

## What the evidence establishes

The supplied attempt was `research-milestone`, Codex host to Claude sidecar,
`claude-sonnet-5`, effort `medium`, with dispatch allowed. Its saved result says
`claude-invalid-result`, class `terminal`; its receipt only says `started` with
the original fingerprint and baselines. Neither preserves the response or the
failing validation step. The exact cause cannot be reconstructed. In particular,
there is no evidence establishing truncation, malformed JSON, artifact schema
failure, or a token in output. The earlier account failure is a separate attempt.

Before edits, the canonical and installed copies were byte-identical for
`forge-claude-sidecar.js`, `forge-unit-sidecar.js`, `forge-worker-result.js`,
`unit-artifacts.schema.json` and the research-milestone dispatch template.
The saved request supplies a rendered prompt. That base prompt contains the
research context and worker marker; the delivery envelope is appended by the
unit adapter at runtime, so its absence in the saved base prompt is expected.

## Reproduced defects and changes

The installed adapter rejects a complete valid research payload whose Markdown
quotes `---GSD-WORKER-RESULT---`: the legacy classifier chooses that substring
inside the JSON string as the final envelope marker. It also rejects a complete
pretty-printed JSON payload through its line-oriented scalar parser. The latter
was outside the old single-line transport instruction, but can be recovered
unambiguously without another provider turn. Both fixtures pass the patched
parser and full artifact validation. These reproductions do not establish the
cause of the historical incident.

The sidecar now uses a dedicated framed JSON parser; the general worker
classifier and its legacy scalar/list/salvage behavior remain unchanged. The
parser requires an explicit matching status and a closing marker, consumes the
whole JSON value and never repairs partial JSON or falls back to an older
successful block. Artifact gates still enforce allowed paths, uniqueness,
required artifacts, nonblank content, questions, exact fields and byte limits.
The schema now advertises nonempty strings and the artifact-count limit; the
prompt separately states byte budgets that JSON Schema cannot express as UTF-8
byte lengths. Claude's combined compact JSON is capped at 900 KiB beneath the existing
1 MiB per-stream transport cap; pretty-print overhead and prose still count
toward that stream cap. Codex does not inherit this Claude-specific payload cap.

A full rendered-prompt fixture also exposed a separate defect: the adapter's
no-`promptFile` path omitted the required description and passed effort under
the wrong renderer option. It now forwards `description` and `unitEffort`.
This was not the original incident, which supplied `promptFile`.

Diagnostics distinguish envelope, JSON, schema, artifact paths/duplicates/
missing files/limits, questions on done, status mismatch, secret/control-data
barriers, provider failures and publication failures. Only closed codes and
numeric counts/timing are persisted. No stdout/stderr, parser messages, account
data, environment or artifact content is added to failure diagnostics. The
secret barrier also checks successful stderr and decoded JSON (escaped tokens).

Failed receipts preserve the sanitized rejection and replay it without a new
provider invocation. Ready receipts preserve validated work even if publication
fails; identical requests resume publication, retaining conflict checks. Partial
and blocked worker outcomes remain intact and publish no artifacts. Recovery
does not acquire leases, change routes, or authorize fallback. No raw diagnostic
capture feature was added.

## Installed CLI alternatives

Only local `claude --version` and `claude --help` were run: installed Claude Code
reports version **2.1.273**, with `--json-schema` and `--output-format` supporting
JSON/stream JSON. These offer a possible future structured transport, but help
output alone does not verify its response envelope, error variants or budget
behavior. The patch does not enable a second, unvalidated protocol or perform a
paid capability probe. It keeps the existing account, route and one-turn text
transport, with strict local recovery of complete JSON.

## Offline validation

`scripts/forge-sidecar-diagnostic.test.js` exercises the real research prompt,
adapter, fixture child process, validator, event/result/receipt persistence and
publication. Account lookup is stubbed; a fixture executable replaces Claude.
Cases include Markdown, Unicode/CRLF, embedded markers, multiline JSON,
repeated blocks, missing/truncated envelopes and JSON, status mismatch, schema
and artifact failures, questions, byte limits, token in stdout/stderr/escaped
JSON, worker partial/blocked, interrupted publication, conflicts and replay.
Replay assertions verify exactly one provider invocation per attempt.

Run the related suites with an isolated test home:

```powershell
node scripts/run-tests.js --match forge-sidecar-diagnostic --match forge-claude-sidecar --match forge-bidirectional-sidecar --match forge-worker-result --match forge-xllm-claude --match forge-prompt --match forge-schema-pin --match forge-schema-guard
git diff --check
```

Validation result: all nine selected suites passed (39.39 seconds), including
the ten diagnostic test groups. After restricting the aggregate byte budget to
Claude only, both affected suites (`forge-sidecar-diagnostic` and
`forge-bidirectional-sidecar`) passed again. `git diff --check` passed.

The standalone installed-versus-patched parser comparison also reproduced the
marker rejection against the actual pre-change installed adapter. Fixtures are
not evidence of a live Claude response and no live round trip was performed.

## Synchronization after review

Do not update a shared runtime while another active session is using it. Once
the diff has been reviewed and that execution is at a safe boundary, use the
repository installer from the Forge source checkout:

```powershell
.\install.ps1 -Runtime both -DryRun -NoModelProbe
.\install.ps1 -Runtime both -NoModelProbe
```

The first command previews; the second installs and must only be run when the
operator intends to apply this reviewed source tree. Use the configured runtime
selection if only one host is installed. Sync the complete bundle: the new
diagnostic helper, both adapters, worker-result module, schema and shared
bidirectional contract must travel together. The skill entrypoints reference
that shared contract; they need no behavioral source edits but should be
materialized by the normal installer, not hand-copied one at a time. No update
command was run during this investigation.

For the next failure, inspect `diagnostic.stage`, `diagnostic.reason`, byte
counts, duration and `recovery` in the result, plus the matching dispatch event
and receipt. Keep those local workflow files out of commits. Historical receipts
that only say `started` do not gain retrospective evidence from this patch and
must not be reset or replayed as if they held a validated response.
