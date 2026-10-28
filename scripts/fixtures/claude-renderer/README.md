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
