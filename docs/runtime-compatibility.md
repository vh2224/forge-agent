# Forge runtime compatibility

Forge is one package with one release line.

The product version comes from the Git tag and release workflow.

`forge-capabilities.json` versions its schema only.

It never declares an independent Claude or Codex product version.

Claude Code and Codex CLI are optional adapters of that same release.

This document describes the catalog contract, not an installer promise.

## Canonical matrix

For dated CLI/schema and host experience investigations, start with
[the host compatibility baseline](host-compatibility-baseline.json) and its
[2026-10-28 analysis](host-compatibility-2026-10-28.md). That baseline records
reviewed release ranges and open findings; it is not a replacement capability
matrix or a guarantee of live provider/UI compatibility. The analysis also
recorded discrepancies between this document's historical release posture and
the current Codex renderer, tracked in issue #280. The catalog posture below
was reclassified against the renderer as part of that work; the issue stays
open until its remaining report and freshness findings are verified.

The [current baseline pointer](host-compatibility-current.json) selects the
[2026-10-31 baseline](host-compatibility-baseline-2026-10-31.json) and
[delivery analysis](host-compatibility-2026-10-31.md). Its verified lineage
ends at the unchanged original import. Pending release-note review does not
advance the reviewed boundary; unchanged versions still require revalidation.

Generate the current matrix from the repository:

```text
node scripts/forge-capabilities.js --matrix --cwd .
```

For automation, request stable JSON:

```text
node scripts/forge-capabilities.js --matrix --json --cwd .
```

The JSON payload is deterministic.

Rows are ordered by `capability_id`.

Catalog paths always use `/`, including when the command runs on Windows.

The human table and the JSON payload come from the same catalog.

Do not copy either output into a separate compatibility spreadsheet.

## Availability vocabulary

The catalog schema is `1.1.0`. Its availability set is closed: a value outside
this list fails the audit.

`implemented` means the adapter currently ships and the cataloged probe exists.

`planned` means it is required or intentionally tracked, but not implemented for that host.

`conditional` means it is available only when its local host integration is configured.

`unavailable` means the release intentionally does not expose that capability on that host.

`common` means the surface is host-neutral and shared by every adapter.

`distributed` means the release projects the surface into that host, without demonstrated behavior there.

`demonstrated` means a cataloged probe or an observed execution proved the behavior, backed by versioned `evidence`.

`unknown` means the current state is not established; consumers never treat it as available.

These are host-specific classifications.

They do not create separate Forge products.

Every row includes both `claude` and `codex` statuses.

Every row also has an owner and a stable `capability_id`.

Some rows include an explicit `platforms` map when the surface is restricted
to an operating system. An omitted map means the catalog has no
platform-specific restriction for that surface.

An ID is kebab-case and must not be reused for another surface.

Consumers interpret the states as follows:

| State | `forge-maintenance` (operational kinds) | `forge-dispatch-policy` |
| --- | --- | --- |
| `implemented`, `common` | available when the probe exists | available |
| `demonstrated` | same as `implemented` | available |
| `distributed` | non-fatal finding `capability-not-demonstrated`, even when required | available |
| `conditional` | warning `conditional-capability-unavailable` | available |
| `planned`, `unavailable` | fatal when required, warning when optional | unavailable |
| `unknown` | fatal `required-capability-unknown` when required, warning when optional | unavailable (fail-closed) |

`distributed` describes projection only. It grants no execution authority and
does not bypass adapter capability checks, sandbox or approval contracts.

## Evidence

`evidence` is an optional object on a capability, keyed by host.

It is accepted only for a host whose status is `demonstrated`.

A `demonstrated` host without evidence for that same host fails validation.

Each value is a normalized relative POSIX path: no drive letter, leading `/`,
`.`/`..` or empty segment, and no backslash.

The audit additionally requires the evidence to be a regular file that resolves
physically inside the checkout, so a link that escapes the checkout fails.

## Current release posture

The checked-in skills, agents, and slash commands are Claude implementations.

They are cataloged as `implemented` for Claude Code.

Their Codex projections are `distributed`: the Codex renderer writes the skills,
agent TOML files and commands into `CODEX_HOME`, but that behavior is not demonstrated
by versioned evidence for Codex.

Headless dispatch is implemented for Claude and `distributed` for Codex: the
dispatch templates are projected into `CODEX_HOME/templates/dispatch`; the
templates are not demonstrated Codex execution.

The statusline is conditional on both hosts because it depends on local
configuration. The Codex renderer only adds a default `status_line` when none
exists and preserves an explicit selection.

Accounts are conditional for Claude and `planned` for Codex; there is no Codex
projection.

Forge.app is conditional for Claude on macOS only. Its platform matrix marks
Windows and Linux unavailable; it is unavailable for Codex on every platform.

Hooks are implemented for Claude and `planned` for Codex.

MCP management is implemented for Claude and `planned` for Codex.

No entry is `demonstrated` in this release.

Planned is deliberately not rendered as green, and neither is distributed.

This preserves a truthful path toward parity.

## VS Code panel posture

The local Forge TreeView is `conditional` for Codex in VS Code and
`unavailable` for Claude. Claude Code receives the terminal surfaces; a VS Code
extension is not a Claude terminal panel. See the
[extension contract](../extensions/forge-vscode/README.md) and the
[dated delivery evidence](host-compatibility-2026-10-31.evidence.json).

The panel is read-only: it displays the current owner's canonical personal
work, agents, pending questions and evidence. Refresh only rereads. It cannot
answer a question, release a gate, adopt work or execute workspace code.
An isolated technical mount on signed VS Code 1.144.0 proved activation and
matching source data. Installation in the operator profile remains pending,
as does the final human visual/comprehension acceptance round. The historical
1.143.1 synthetic mount remains a separate proof with unchanged bytes.

## Capability probes and floors

Forge detects capabilities; it does not pin an exact CLI version in this catalog.

A probe is the observable prerequisite a capability needs.

The current catalog uses filesystem probes for repository-owned surfaces.

Node keeps an explicit `minimum_version` of `18.0.0`, checked by executing the
selected Node binary.

Claude Code and Codex CLI have no generic floor. A version number alone does
not prove a modern feature, so their runtime entries declare no
`minimum_version` and report the observed version with `minimum_version: null`.

A catalog may still declare an explicit `minimum_version` for a host runtime;
detection then reports `unsupported` with reason `minimum-version` below it.

Each host runtime instead declares `capability_probes`: an `id`, an argv array
`args` and optional `expect_output` tokens.

| Runtime | Probe | argv | Observed when |
| --- | --- | --- | --- |
| codex | `codex-app-server` | `app-server --help` | exit 0 |
| codex | `codex-exec-json` | `exec --help` | exit 0 and output contains `--json` |
| claude | `claude-stream-json` | `--help` | exit 0 and output contains `--output-format` and `--input-format` |

Capability probes run only for a selected runtime whose behavior probe passed.
They use the same timeout and argv invocation without a shell, never contact a
network or a provider, and never spawn a host that was not selected.

An argv identical to one already executed for the same executable reuses that
result instead of spawning again.

Each result is `observed`, `absent` or `inconclusive`, with reason
`capability-observed`, `capability-absent` or a probe failure code such as
`exit-nonzero`, `permission-denied`, `inconclusive` or `not-selected`.

A token is matched as a whole option name, so `--json-schema` never satisfies
`--json`. Raw help output is not retained in the result.

Capability probes are informational: they never change the runtime status,
`ok` or `required_failures`.

An observed help token is not proof that a feature works in a live session.

An exact version is only useful as an operator diagnostic.

It is not the compatibility contract.

This avoids false failures on patched or vendor-packaged builds.

It also allows an adapter to support a newer CLI without a catalog rewrite.

## Question capability

Question support is a probe, not an availability state in this catalog.

On Codex, `adapters.codex.questions` in the installation manifest only records
the feature-flag probe of the local CLI.

On Claude, `AskUserQuestion` is the documented contract in
`shared/forge-interaction.md`.

Neither the Codex feature-flag probe nor the documented `AskUserQuestion`
contract proves that a question tool is available in a given session: a flag
or a documented contract does not prove session availability.

An asynchronous handle or an accepted presentation is not an answer; a
required decision stays pending until an explicit answer is recorded.

## Audit gate

Run the mechanical coverage audit before releasing changes to published surfaces:

```text
node scripts/forge-capabilities.js --check --cwd .
```

The audit loads both the catalog and its schema.

It compares the schema host enum with `scripts/forge-runtime.js`.

It discovers Forge skills from `skills/*/SKILL.md`.

It discovers Forge agents from `agents/forge-*.md`.

It discovers Forge commands from `commands/forge*.md`.

Every discovered surface must have exactly one catalog probe.

The kind in the catalog must match the discovered kind.

The audit rejects duplicate IDs.

The audit rejects duplicate probe paths.

The audit rejects invalid hosts, platform keys, and availability values.

The audit rejects unknown capability and runtime keys.

The audit rejects a `demonstrated` host without same-host evidence and evidence
for a host that is not `demonstrated`.

The audit rejects evidence paths that are not normalized, do not exist, are not
files or escape the checkout.

The audit rejects malformed capability probes.

The audit rejects a missing owner.

The audit rejects a required capability without a probe.

The audit rejects a required probe whose path is missing.

The audit rejects product versions declared outside the Git release workflow.

The audit rejects adapters that are not optional.

## Operating-system behavior

The loader is plain Node.js and has no package dependency.

It is intended to run on Windows, macOS, and Linux.

Filesystem access uses Node `fs` and `path` rather than shell globbing.

Rendered paths use `/` on every operating system.

Sorting is performed on stable capability IDs.

The test suite compares repeated JSON output to protect determinism.

Use `--cwd` to audit another checkout.

The working directory may be absolute or relative.

The catalog itself remains rooted at that checkout.

## Adding a surface

Add the real published surface first.

Add exactly one capability entry to `forge-capabilities.json`.

Choose a stable ID based on the surface, not an implementation detail.

Set the accountable owner.

Classify Claude and Codex separately.

Use `distributed` when the release only projects the surface into a host.

Never mark a host `demonstrated` without versioned `evidence` for that host.

Use `unknown` rather than guessing; it is fail-closed for dispatch.

Declare whether the capability is required.

Add a normalized probe path.

Run the audit.

Add a negative fixture when the new validation rule needs coverage.

Update this document if the release posture changes.

Do not use the catalog as an installation manifest.

Do not add a runtime-specific product version.

Do not call a planned or distributed Codex capability implemented before its
behavior is demonstrated.

## Verification

Run the standalone suite:

```text
node scripts/forge-capabilities.test.js
node scripts/forge-native-runtime.test.js
node scripts/forge-maintenance.test.js
node scripts/forge-dispatch-policy.test.js
```

Then run the release-oriented commands:

```text
node scripts/forge-capabilities.js --check --cwd .
node scripts/forge-capabilities.js --matrix --json --cwd .
```

The capability suite also spawns both commands and compares two matrix runs
byte for byte.

It renders the Codex projection in a temporary root and checks that each
skill, agent and command is `distributed` exactly when the renderer emits it.

It checks that this document lists exactly the catalog availability values.

The native runtime regression confirms existing Claude contracts stay cataloged.

It also prevents hooks, headless execution, and MCP from being mislabeled as
Codex implementations.

Future slices may generate or install adapters.

They must update the host status and probe evidence in this one matrix.

They must not fork Forge into a Claude release and a Codex release.
