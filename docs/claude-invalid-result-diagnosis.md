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

### Current decision (2026-10-01, Claude Code 2.1.286)

The text transport above is superseded. The sidecar now runs
`--output-format json` and treats stdout as one CLI result object; the
worker-result block is read from its `result` string by the unchanged framed
parser. The reason is model identity, not parsing: the text transport could not
show which model answered, and a classifier switch or availability fallback
could hand a different model's work to the unit validator. Only the result
object's `modelUsage` carries that proof.

- Admission requires exactly one well-formed `modelUsage` key byte-identical
  to `--model`; then `model_observed` is that id with source
  `claude-json-modelUsage`. A clearly different model is
  `claude-model-substituted`; absent, multiple (an auxiliary Haiku included),
  dated, `[1m]`, alias or neighbouring-version keys are
  `claude-model-unverified`. A dispatch without `--model` is
  `claude-model-required` with no spawn.
- Invocation settings add `switchModelsOnFlag:false` beside
  `disableAllHooks:true`, inline only, with `--setting-sources ''`, which
  excludes the user, project and local settings files; managed policy may still
  apply and is not bypassed, and no settings file is changed. That flag
  covers the classifier-driven switch only; an availability fallback is still
  possible and is caught after the turn by `modelUsage`. There is no pre-turn
  guarantee, no automatic reset and no fallback to another model.
- `effort_applied` remains unknown (`null`): the JSON result is not used as
  effort readback.
- Envelope errors, structured authentication (`api_error_status` 401/403),
  decoded-secret scanning and the unchanged 1 MiB stream cap are described in
  `shared/forge-bidirectional-sidecar.md § Claude CLI JSON transport and model
  identity`.

Official sources named for this decision: the Claude Code changelog entry for
2.1.286 (<https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md>),
headless/print-mode output formats (<https://code.claude.com/docs/en/headless>)
and model configuration (<https://code.claude.com/docs/en/model-config>). They
were not re-fetched while implementing this change (network disabled); the
local fixtures prove the adapter's handling of the documented shape, not live
provider behavior.

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
