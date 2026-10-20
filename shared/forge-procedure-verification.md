# Verification

## Before checks

Identify the exact plan, artifact owner and actual CODE_DIR for each physical root.
Load the core and this complete procedure through the canonical manifest before
discovering commands, running checks or returning a policy/no-stack skip.
Loading a module proves its bytes and provenance, never a passing gate.
Resolve applicable checks from the existing plan/preferences/stack discovery chain.
Do not invent a command or reinterpret an operator's disabled verification choice.

## Outcomes

Verify static artifacts, available lint/format/syntax and the plan's tests/builds.
Check observable behavior with the strongest applicable verification tier.
Preserve exit codes, failures, timeouts, discovery source and command durations.
A disabled-by-pref or no-stack skip ran zero commands and must remain explicit.
Missing tools or environmental limits remain unverified; do not report tests passed.
The working directory may be a fresh worktree where dependencies may not be installed.
A missing module/package (`Cannot find module`, `Cannot find package`,
`ModuleNotFoundError` or `command not found`) is environmental and leaves the
related check unverified. Native workers may install dependencies only when the
plan explicitly authorizes it. Sidecar sandbox prohibitions take precedence:
do not install dependencies there; report the affected item as `"status": "unknown"`
and preserve the literal error in its `note`.
Declared-artifact existence is an independent enforcing check. Substantive/wired
heuristics remain advisory according to the existing verifier contract.
Legacy schema remains visible rather than becoming fabricated structured evidence.

## Evidence and delivery

Capture exact gate and verifier JSON contemporaneously in bounded source envelopes.
Bind unit, exact plan SHA-256, physical root, actual workspace/revision, exercised
environment and timestamp. Keep each root's evidence independent.
Bind every criterion/aspect explicitly to a concrete named behavioral check or
the matching artifact row/property; a global pass or generic wired row is insufficient.
Preserve verification_evidence_yaml exactly as emitted by the gate.
Failing enforcing gates prevent completion/commit under the existing contract.
Keep implementation, CI, review, merge, installation and human acceptance separate;
offline fixtures do not establish provider behavior or human UAT.
