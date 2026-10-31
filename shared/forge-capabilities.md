# Forge capability catalog and probes

`forge-capabilities.json` is the versioned, closed inventory for the Forge
Agent surface. It is runtime-neutral: the same catalog is consumed by Claude
Code and Codex CLI, and it does not read either CLI's home as a source of
truth. The schema is `schemas/forge-capabilities.schema.json`, version `1.1.0`.

## Catalog contract

Each published surface has a unique `capability_id`, owner, required/optional
flag, host classifications, and a normalized POSIX-style filesystem probe.
`common`, `conditional`, and `unavailable` describe portability of a surface.
Host statuses use one closed availability set:

| State | Meaning |
| --- | --- |
| `implemented` | the adapter ships the surface and its probe exists |
| `planned` | tracked or required, not implemented for that host |
| `conditional` | available only when the local host integration is configured |
| `unavailable` | intentionally not exposed on that host |
| `common` | host-neutral surface shared by every adapter |
| `distributed` | projected into the host by the release, behavior not demonstrated |
| `demonstrated` | behavior proven by a probe or observed execution with versioned `evidence` |
| `unknown` | state not established; never available, fail-closed |

`distributed` describes projection only: it grants no execution authority and
does not bypass adapter capability, sandbox or approval checks. A
`demonstrated` host requires an `evidence` entry for that same host; evidence
for a host that is not `demonstrated` is rejected. Evidence is a normalized
relative path, and the audit requires a regular file that resolves physically
inside the checkout. Consumers apply the states as documented in
`docs/runtime-compatibility.md`: `forge-maintenance` reports `distributed` as
the non-fatal `capability-not-demonstrated` and a required `unknown` as the
fatal `required-capability-unknown`; `forge-dispatch-policy` denies `unknown`.

`runtimes` describes Node, Claude Code, and Codex CLI. Node keeps an explicit
`minimum_version` floor. Claude Code and Codex CLI have no generic floor; they
declare `capability_probes` instead. Product releases continue to be derived
from Git tags, never from this catalog's schema version.

Audit is closed-world: duplicate IDs or probe paths, unknown hosts/kinds,
unknown capability or runtime keys, missing required files, unknown reason
codes, malformed capability probes and invalid evidence fail. Run it offline
with:

```text
node scripts/forge-capabilities.js --check
node scripts/forge-capabilities.js --matrix --json
```

## Safe detection

`detect(cwd, { runtime })` probes Node plus only the selected host(s):
`claude`, `codex`, or `both`. Omitting `runtime` preserves the S01
Claude-first default. A non-selected CLI is never spawned and is
reported as `inconclusive` with reason `not-selected`. CLI probes use argv and
`shell:false`; no shell interpolation, login, network, package manager, or
cross-host fallback is attempted. Windows resolution considers `.cmd` and
`.exe`; POSIX paths and Windows paths containing spaces or Unicode are passed
as one argv element. Tests can inject a fake executable through
`{ binaries: { claude: { command, args } } }` without changing `PATH`.

A runtime `minimum_version` is a CLI-version floor, not a Forge product
version, and it is enforced only when declared. Claude Code and Codex CLI
report the observed `version` with `minimum_version: null`.

Both version and behavior probes return one of four stable statuses:

| Status | Meaning |
| --- | --- |
| `available` | version meets any declared floor and behavior probe exited zero |
| `missing` | selected executable could not be resolved |
| `unsupported` | a version was reported but is below a declared floor |
| `inconclusive` | permission, timeout, invalid output, or non-zero behavior |

`reason_code` is one of `available`, `missing`, `unsupported`,
`inconclusive`, `permission-denied`, `not-selected`, `invalid-output`,
`exit-nonzero`, `minimum-version`, `capability-observed`, or
`capability-absent`. Required failures are Node plus each selected host CLI.
Optional/non-selected probes are warnings only.

## Capability probes

Each host runtime lists `capability_probes` (`id`, argv `args`, optional
`expect_output` tokens): `codex-app-server` (`app-server --help`),
`codex-exec-json` (`exec --help`, token `--json`) and `claude-stream-json`
(`--help`, tokens `--output-format` and `--input-format`). They run after the
behavior probe, only for a selected runtime that is `available`, with the same
timeout and argv invocation. An identical argv already executed for the same
executable is reused, so no extra spawn happens for `--help`.

Results appear under `probes.<runtime>.capabilities.<id>` with status
`observed` (`capability-observed`), `absent` (`capability-absent`, listing
`missing_tokens`) or `inconclusive` (a probe failure code). When the runtime is
not selected or not available, each probe is listed as `inconclusive` without
running. Tokens match whole option names; raw help output is not retained.
Capability probes are informational and never change `ok` or
`required_failures`; an observed help token does not prove live session
support.

Examples:

```text
node scripts/forge-capabilities.js --detect --runtime claude --json
node scripts/forge-doctor.js --check capabilities --runtime both --json
```

The JSON shape is deterministic (fixed runtime order and sorted matrix), so it
is suitable for installers and CI. `forge-doctor --check all` includes this
check; it fails only when a required selected probe is unavailable or a fatal
catalog finding exists, and never tries to install or silently switch
runtimes.
