# SVN capability matrix (Phase 4 closure)

Phase 4 closes every inventoried surface with an executable or explicit VCS-neutral/limitation verdict. Human-readable details remain in `docs/svn-parity-evidence/phase-04-full-gates.md`; each matrix row selects the structured `svn-focused` claim from `docs/svn-parity-evidence/phase-04-full-gates.results.json`. Platform CI is never accepted as SVN evidence.

| ID | Surface | Primitive | Applicability | Probe | E2E | Verdict | Action |
|---|---|---|---|---|---|---|---|
| skill-forge-accounts | skill/accounts | skills/forge-accounts/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | no direct VCS primitive |
| skill-forge-add-slice | skill/planning | skills/forge-add-slice/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | delegates repository behavior to shared VCS layer |
| skill-forge-add-task | skill/planning | skills/forge-add-task/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | delegates repository behavior to shared VCS layer |
| skill-forge-ask | skill/conversation | skills/forge-ask/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | no direct VCS primitive |
| skill-forge-auto | skill/orchestration | skills/forge-auto/SKILL.md | applicable | smoke Sections 80/82 + full regression | phase-04-full-gates.results.json#claim=svn-focused | verified | shared SVN orchestration paths green |
| skill-forge-brainstorm | skill/planning | skills/forge-brainstorm/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | no direct VCS primitive |
| skill-forge-codebase | skill/quality | skills/forge-codebase/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | file-quality checks do not select a VCS backend |
| skill-forge-config | skill/configuration | skills/forge-config/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | host configuration is project-VCS independent |
| skill-forge-curate | skill/maintenance | skills/forge-curate/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | memory curation has no direct VCS primitive |
| skill-forge-discuss | skill/planning | skills/forge-discuss/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | no direct VCS primitive |
| skill-forge-doctor | skill/quality | scripts/forge-doctor.js | applicable | forge-doctor-projection-svn.test.js | phase-04-full-gates.results.json#claim=svn-focused | verified | live local SVN projection green |
| skill-forge-explain | skill/conversation | skills/forge-explain/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | artifact explanation has no direct VCS primitive |
| skill-forge-help | skill/conversation | skills/forge-help/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | catalog display has no direct VCS primitive |
| skill-forge-mcps | skill/integrations | skills/forge-mcps/SKILL.md | VCS-neutral | operational parity + full regression | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | host MCP projection is project-VCS independent |
| skill-forge-memories | skill/memory | skills/forge-memories/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | memory files do not select a VCS backend |
| skill-forge-new-milestone | skill/planning | skills/forge-new-milestone/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | delegates repository behavior to shared VCS layer |
| skill-forge-next | skill/orchestration | shared/forge-sidecar-next.md | applicable | smoke Section 82 mirror guard | phase-04-full-gates.results.json#claim=svn-focused | verified | SVN-002 retained; SVN isolation/telemetry smoke green |
| skill-forge-pause | skill/orchestration | skills/forge-pause/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | run-state operation has no direct VCS primitive |
| skill-forge-prefs | skill/configuration | skills/forge-prefs/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | preferences are project-VCS independent |
| skill-forge-probe | skill/quality | skills/forge-probe/SKILL.md | applicable | forge-completer-artifacts.test.js backend guard | phase-04-full-gates.results.json#claim=svn-focused | verified | SVN completion remains explicitly uncommitted |
| skill-forge-responsive | skill/quality | skills/forge-responsive/SKILL.md | applicable | forge-completer-artifacts.test.js VCS-aware fast-mode guard | phase-04-full-gates.results.json#claim=svn-focused | verified | VCS-aware fast mode retained |
| skill-forge-risk-radar | skill/quality | skills/forge-risk-radar/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | reads planning risk, no direct VCS primitive |
| skill-forge-scope-clarity | skill/planning | skills/forge-scope-clarity/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | no direct VCS primitive |
| skill-forge-security | skill/security | skills/forge-security/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | checklist surface has no direct VCS primitive |
| skill-forge-skills | skill/conversation | skills/forge-skills/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | catalog display has no direct VCS primitive |
| skill-forge-status | skill/orchestration | skills/forge-status/SKILL.md | VCS-neutral | full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | reads run state; no direct project VCS mutation |
| skill-forge-sweep | skill/maintenance | skills/forge-sweep/SKILL.md | VCS-neutral | full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | GSD retention is project-VCS independent |
| skill-forge-task | skill/orchestration | skills/forge-task/SKILL.md | applicable | smoke Sections 80/82 + full regression | phase-04-full-gates.results.json#claim=svn-focused | verified | shared SVN orchestration paths green |
| skill-forge-ui-review | skill/quality | skills/forge-ui-review/SKILL.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | UI review has no direct VCS primitive |
| agent-forge-advocate | agent/review | agents/forge-advocate.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | review role delegates diff behavior |
| agent-forge-completer | agent/orchestration | shared/forge-completer-slice.md | applicable | forge-completer-artifacts.test.js live SVN/no-VCS/Git guards | phase-04-full-gates.results.json#claim=svn-focused | verified | SVN artifact closure retained |
| agent-forge-discusser | agent/planning | agents/forge-discusser.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | no direct VCS primitive |
| agent-forge-executor | agent/execution | agents/forge-executor.md | applicable | shared VCS and verification focused gates | phase-04-full-gates.results.json#claim=svn-focused | verified | delegates repository operations to verified helpers |
| agent-forge-memory | agent/memory | agents/forge-memory.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | no direct VCS primitive |
| agent-forge-plan-checker | agent/quality | agents/forge-plan-checker.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | validates artifacts, no direct VCS primitive |
| agent-forge-planner | agent/planning | agents/forge-planner.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | no direct VCS primitive |
| agent-forge-researcher | agent/research | agents/forge-researcher.md | VCS-neutral | catalog + full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | no direct VCS primitive |
| agent-forge-reviewer | agent/review | shared/forge-review.md | applicable | forge-review-diff.test.js no-VCS guard | phase-04-full-gates.results.json#claim=svn-focused | verified | SVN-003 retained; scoped diff green |
| agent-forge-worker | agent/execution | agents/forge-worker.md | applicable | shared VCS focused gates | phase-04-full-gates.results.json#claim=svn-focused | verified | delegates repository operations to verified helpers |
| command-forge | command/orchestration | commands/forge.md | applicable | smoke Sections 80/82 + full regression | phase-04-full-gates.results.json#claim=svn-focused | verified | shared SVN orchestration paths green |
| command-forge-doctor | command/quality | scripts/forge-doctor.js | applicable | forge-doctor-projection-svn.test.js | phase-04-full-gates.results.json#claim=svn-focused | verified | SVN projection gate green |
| command-forge-init | command/setup | scripts/forge-init.js | applicable | full regression + existing SVN init tests | phase-04-full-gates.results.json#claim=svn-focused | verified | no new SVN gap |
| command-forge-update | command/maintenance | scripts/forge-update.js | Git-only | static contract | phase-04-full-gates.results.json#claim=svn-focused | declared-limitation | updater manages the Git-distributed Forge installation, not project SVN |
| operational-statusline | statusline | scripts/forge-statusline.js | VCS-neutral | full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | run telemetry is project-VCS independent |
| operational-accounts | accounts | scripts/forge-accounts.js | VCS-neutral | full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | account rotation is project-VCS independent |
| operational-app | app | app | macOS-only, VCS-neutral | static contract | phase-04-full-gates.results.json#claim=svn-focused | declared-limitation | unavailable on this Windows host; app contract has no project VCS primitive |
| operational-hooks | hooks | scripts/forge-hook.js | VCS-neutral | full regression gate | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | lifecycle hooks do not select the project VCS backend |
| operational-headless | headless | shared/forge-dispatch.md | applicable | smoke Sections 80/82 canonical/mirrors | phase-04-full-gates.results.json#claim=svn-focused | verified | SVN execute/plan and isolation telemetry green |
| operational-mcp | MCP | scripts/forge-mcp.js | VCS-neutral | forge-operational-parity.test.js (2 hosts x 3 platforms) | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | host projection is independent of project VCS |
| integration-claude-instructions | host/Claude | CLAUDE.md | VCS-neutral | instruction projection smoke + full regression | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | host instructions are project-VCS independent |
| integration-claude-settings | host/Claude | shared/templates/claude/settings.jsonc | VCS-neutral | forge-claude-renderer.test.js deterministic projection | phase-04-full-gates.results.json#claim=svn-focused | verified-neutral | declarative host integration has no VCS primitive |
| configuration-forge | configuration | forge-capabilities.json | applicable | forge-svn-audit.js | phase-04-full-gates.results.json#claim=svn-focused | verified | 52 expected/observed; zero missing, duplicate, or incomplete |
| family-vcs-primitives | internal family | scripts/forge-vcs.js | applicable | forge-vcs.test.js live SVN reset | phase-04-full-gates.results.json#claim=svn-focused | verified | status/diff/reset and SVN primitives green |
| family-review-diff | internal family | scripts/forge-review-diff.js | applicable | forge-review-diff.test.js | phase-04-full-gates.results.json#claim=svn-focused | verified | scoped diff and no-VCS guard green |
| family-touch | internal family | scripts/forge-touch.js | applicable | forge-touch.test.js live no-Git SVN WC | phase-04-full-gates.results.json#claim=svn-focused | verified | current WC delta reported honestly |
| family-unit-delta | internal family | scripts/forge-unit-delta.js | applicable | forge-unit-delta.test.js | phase-04-full-gates.results.json#claim=svn-focused | verified | SVN-aware unit delta gate green |
| family-isolation | internal family | scripts/forge-isolation.js | limited by VCS | forge-isolation.test.js explicit SVN shared/unmet guards | phase-04-full-gates.results.json#claim=svn-focused | declared-limitation | SVN has no Git worktree/branch equivalent; named shared degradation |
| family-ignore | internal family | scripts/forge-ignore.js | applicable | forge-vcs.test.js ignore/property fixtures | phase-04-full-gates.results.json#claim=svn-focused | verified | local SVN fixture coverage green |
| family-claims-recovery | internal family | scripts/forge-claim-release.js | applicable | claim release/recovery suites | phase-04-full-gates.results.json#claim=svn-focused | verified | 78 claim/recovery assertions green |

## Phase 4 closure counts

- Catalog capability IDs: 52.
- Observed catalog IDs: 52.
- Missing: 0.
- Duplicates: 0.
- Additional internal/public families: 7.
- Final rows left at `inventory`: 0.
- New reproducible SVN product gaps in Phase 4: 0.
- Overall gate verdict: not 100% green; see Phase 4 evidence for base-clean Windows/environment failures.
