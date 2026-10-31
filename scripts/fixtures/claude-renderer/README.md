# Claude renderer golden fixtures

`claude-4.18.1.golden.json` and `claude-4.19.0.golden.json` are historical snapshots. Preserve their bytes; a current-source change does not rewrite history. The 4.19.0 file SHA256 is `f2b3e910445d2557f50aa4ced9e1b31498debc6b1cdd1ed05b452d8141b4307f`, pinned by both current renderer acceptance consumers.

`claude-memory-v2.golden.json` is the active canonical-source baseline after the accepted S03/T04 memory-v2 changes, reviewed instruction reconciliation in #254, and planning correction in #203. It is a separate fixture, not a claim that historical 4.19.0 emitted current source. All nine surface identities/targets and five surface hashes equal 4.19.0. The changed surfaces are `agents`, `skills`, `dispatch-templates`, and `claude-instructions`. Prior audited sources are `agents/forge-memory.md`, `skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md`, `skills/forge-memories/SKILL.md`, and `CLAUDE.md`; the additional planning sources are listed below.

Expected hashes are fixed reviewed values. The tests render current sources, group artifacts by source_id, sort by source with localeCompare, normalize only `version=MAJOR.MINOR.PATCH` to `version=<dynamic>`, join each source and content with NUL separators, and compare SHA256 against the stored baseline. They do not regenerate expected values from the renderer under test. Origin-marker/newline behavior and all other renderer assertions remain in force.

The scoped #203 planning follow-up updates `agents`, `skills`, and `dispatch-templates`
for `agents/forge-planner.md`, `skills/forge-new-milestone/SKILL.md`, and
`shared/templates/dispatch/plan-milestone.md`: milestone
planning no longer requires 4–10 slices. Historical snapshots and the other six
active surface hashes stay unchanged relative to the #254 baseline. The historical-to-current surface set is
`agents`, `skills`, `dispatch-templates`, and `claude-instructions`.

The source-guard test separately retains the older skills-only repin comparison within historical data, checks that the historical-to-current change is exactly agents, skills, dispatch-templates, and claude-instructions, and compares current rendered output against all nine active hashes. Future intentional source changes need a scoped reviewed baseline update; drift remains a failure.

The #268 fresh-task creation correction updates only the active `skills` hash for
`skills/forge-task/SKILL.md`; the other eight active hashes and all historical
snapshots remain unchanged. It removes unrelated personal selection and legacy
migration from explicit fresh creation, preserving explicit resume and isolation.

The S02 communication update (M-20261028132636-experiencia, S02/T05) changes only
the active `skills` and `claude-instructions` hashes. Its sources are
`skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md`,
`skills/forge-task/SKILL.md` and `skills/forge-status/SKILL.md` (pointer to
`shared/forge-communication.md`, human relay line and message templates), plus
`CLAUDE.md`, re-synced by `forge-instructions.js` so its managed block carries the
communication contract. Both hashes were measured through the render path with
the assertion formula above, before and after the edits: the other seven active
hashes and all historical snapshots stay unchanged, and the historical-to-current
surface set asserted by `forge-dispatch-source-guard.test.js` is still `agents`,
`skills`, `dispatch-templates`, `claude-instructions`, and `configuration`.

The S03 agent-identity update (M-20261028132636-experiencia, S03/T07) changes only
the active `skills` hash, from
`62926097a5d24d2d1b637900971324425930bb8d1f437422812ab8cdb8d16e99` to
`de4f137d05d37fbee993ba3adfc4a11372ea1c972f158cceddc5ae7e8ce02981`. Its sources are
`skills/forge-auto/SKILL.md`, `skills/forge-next/SKILL.md` and
`skills/forge-task/SKILL.md` (per-attempt native dispatch id, human task name,
host-returned agent identity ordered by the owner's protected windows, and the
Codex read-only guard around the plan-checker and read-only native units), plus
`skills/forge-status/SKILL.md` (personal agent view) and
`skills/forge-config/SKILL.md` (explicit `subagents on|off`). The value before was
measured at revision `06f7d5a` and the value after on the final skill bytes, both
through the render path with the assertion formula above. The other eight active
hashes and all historical snapshots stay unchanged; the historical-to-current
surface set is still `agents`, `skills`, `dispatch-templates`,
`claude-instructions`, and `configuration`.

The S03 review R1 correction uses the executable flow's `unit_type`/`unit_id`
in forge-auto and forge-next and fails closed on missing Codex identity. A scoped
before/after measurement retained all 248 dispatch registry entries, classifications,
and emitter/builder counts; only the two single-unit emitter windows changed.
Only the active `skills` surface changed from
`de4f137d05d37fbee993ba3adfc4a11372ea1c972f158cceddc5ae7e8ce02981` to
`28410c1f6ac4bf55ec693e379bc76328e77277bbfb9676f2b6f5fe564d7e37b7`.
The other eight active surfaces and historical golden bytes remain unchanged.

## S04/T03 remeasurement (2026-10-30)

Measured before and after with forge-claude-renderer.render, sorting artifacts by source,
joining source + NUL + content (version normalized to <dynamic>) with NUL, then SHA-256,
exactly as forge-claude-renderer.test.js. Sources changed: skills/forge-discuss/SKILL.md
and the managed forge:interaction block of CLAUDE.md (shared/forge-interaction.md).

- skills: `28410c1f6ac4bf55ec693e379bc76328e77277bbfb9676f2b6f5fe564d7e37b7` to `0ba4bf99be2a459df9aee5fa657e35c94d8c05e7c0cb093c37173f24c5b618cd`.
- claude-instructions: `f2c7e2e5c25e0815a41e05c91d840c48c5c00da8903f83bee1db319c5075ec8a` to `7997a0ef19dcd6479b90fc48eaa732cd12a7337d54c6332ac11c6c6ddb257ffb`.

The other seven active surfaces and immutable Claude 4.19.0 golden remain unchanged.
The historical-to-current changed surface set remains agents, skills, dispatch-templates,
claude-instructions and configuration. Distribution does not establish host UI or human acceptance.
