# Forge capability catalog and probes

`forge-capabilities.json` is the versioned, closed inventory for the Forge
Agent surface. It is runtime-neutral: the same catalog is consumed by Claude
Code and Codex CLI, and it does not read either CLI's home as a source of
truth. The schema is `schemas/forge-capabilities.schema.json`.

## Catalog contract

Each published surface has a unique `capability_id`, owner, required/optional
flag, host classifications, and a normalized POSIX-style filesystem probe.
`common`, `conditional`, and `unavailable` describe portability of a surface;
the older `implemented`/`planned` host statuses remain valid for compatibility
with the S01 catalog. `runtimes` adds detectable floors for Node, Claude Code,
and Codex CLI. Product releases continue to be derived from Git tags, never
from this catalog's schema version.

Audit is closed-world: duplicate IDs or probe paths, unknown hosts/kinds,
missing required files, unknown reason codes, and unknown runtime keys fail.
Run it offline with:

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

Runtime `minimum_version` values are CLI-version floors, not Forge product
versions. For example, the current Claude Code floor is `2.0.0`, while the
Forge package release proposed by this integration is `4.8.0`.

Both version and behavior probes return one of four stable statuses:

| Status | Meaning |
| --- | --- |
| `available` | version meets the floor and behavior probe exited zero |
| `missing` | selected executable could not be resolved |
| `unsupported` | a version was reported but is below the floor |
| `inconclusive` | permission, timeout, invalid output, or non-zero behavior |

`reason_code` is one of `available`, `missing`, `unsupported`,
`inconclusive`, `permission-denied`, `not-selected`, `invalid-output`,
`exit-nonzero`, or `minimum-version`. Required failures are Node plus each
selected host CLI. Optional/non-selected probes are warnings only.

Examples:

```text
node scripts/forge-capabilities.js --detect --runtime claude --json
node scripts/forge-doctor.js --check capabilities --runtime both --json
```

The JSON shape is deterministic (fixed runtime order and sorted matrix), so it
is suitable for installers and CI. `forge-doctor --check all` includes this
check; it fails only when a required selected probe is unavailable and never
tries to install or silently switch runtimes.
