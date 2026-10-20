# Mandatory Forge procedures by phase

The manifest is an inventory and integrity contract, not a routing table.
T01 delivers the loader and core. T02 connects nine preparation/planning/completion
units through forge-prompt; later owners connect the remaining phase modules.
Pending entries have null hashes and cannot be composed, even if a file exists.
No pending file is a valid placeholder. The owning task must deliver real content,
update its canonical digest and exercise the actual consumers before marking ready.

## Phase matrix

| Phase | Mandatory modules | Real consumers | Integration owner/status | Preconditions | Postconditions | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| boot | core + personal | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md | T04; pending | Read-only personal snapshot and explicit own-work selection; Preserve accepted decisions and unresolved personal diagnostics | Only the selected own unit advances; no colleague discovery or implicit binding | scripts/forge-procedure-context.test.js, scripts/forge-procedure-callers.test.js |
| personal-selection | core + personal | skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md | T04; pending | Read-only personal snapshot and explicit own-work selection; Preserve accepted decisions and unresolved personal diagnostics | Only the selected own unit advances; no colleague discovery or implicit binding | scripts/forge-procedure-context.test.js, scripts/forge-procedure-callers.test.js |
| discuss-milestone | core + preparation | scripts/forge-prompt.js, scripts/forge-unit-sidecar.js | T02; ready | Matching project, scope and accepted decisions available; Functional pending questions retained by stable ID | Scoped discuss/research artifacts returned for owner validation/publication | scripts/forge-procedure-context.test.js, scripts/forge-prompt.test.js |
| discuss-slice | core + preparation | scripts/forge-prompt.js, scripts/forge-unit-sidecar.js | T02; ready | Matching project, scope and accepted decisions available; Functional pending questions retained by stable ID | Scoped discuss/research artifacts returned for owner validation/publication | scripts/forge-procedure-context.test.js, scripts/forge-prompt.test.js |
| research-milestone | core + preparation | scripts/forge-prompt.js, scripts/forge-unit-sidecar.js | T02; ready | Matching project, scope and accepted decisions available; Functional pending questions retained by stable ID | Scoped discuss/research artifacts returned for owner validation/publication | scripts/forge-procedure-context.test.js, scripts/forge-prompt.test.js |
| research-slice | core + preparation | scripts/forge-prompt.js, scripts/forge-unit-sidecar.js | T02; ready | Matching project, scope and accepted decisions available; Functional pending questions retained by stable ID | Scoped discuss/research artifacts returned for owner validation/publication | scripts/forge-procedure-context.test.js, scripts/forge-prompt.test.js |
| plan-milestone | core + planning | scripts/forge-prompt.js, scripts/forge-unit-sidecar.js | T02; ready | Matching scope, decisions and research are available; Required functional decisions have explicit answers before dependent planning | Phase-specific artifacts and full must-haves pass the applicable plan gate | scripts/forge-procedure-context.test.js, scripts/forge-prompt.test.js |
| plan-slice | core + planning | scripts/forge-prompt.js, scripts/forge-unit-sidecar.js | T02; ready | Matching scope, decisions and research are available; Required functional decisions have explicit answers before dependent planning | Phase-specific artifacts and full must-haves pass the applicable plan gate | scripts/forge-procedure-context.test.js, scripts/forge-prompt.test.js |
| plan-check | core + planning | scripts/forge-prompt.js, scripts/forge-unit-sidecar.js | T02; ready | Matching scope, decisions and research are available; Required functional decisions have explicit answers before dependent planning | Phase-specific artifacts and full must-haves pass the applicable plan gate | scripts/forge-procedure-context.test.js, scripts/forge-prompt.test.js |
| task-brainstorm | core + task-preparation | scripts/forge-task-preparation.js, skills/forge-task/SKILL.md | T03; pending | Standalone task identity and phase are validated by phaseContract; Required decisions remain pending by stable ID | Only the selected task phase artifact is returned for owner publication | scripts/forge-procedure-context.test.js, scripts/forge-task-preparation.test.js |
| task-discuss | core + task-preparation | scripts/forge-task-preparation.js, skills/forge-task/SKILL.md | T03; pending | Standalone task identity and phase are validated by phaseContract; Required decisions remain pending by stable ID | Only the selected task phase artifact is returned for owner publication | scripts/forge-procedure-context.test.js, scripts/forge-task-preparation.test.js |
| task-research | core + task-preparation | scripts/forge-task-preparation.js, skills/forge-task/SKILL.md | T03; pending | Standalone task identity and phase are validated by phaseContract; Required decisions remain pending by stable ID | Only the selected task phase artifact is returned for owner publication | scripts/forge-procedure-context.test.js, scripts/forge-task-preparation.test.js |
| task-plan | core + task-preparation | scripts/forge-task-preparation.js, skills/forge-task/SKILL.md | T03; pending | Standalone task identity and phase are validated by phaseContract; Required decisions remain pending by stable ID | Only the selected task phase artifact is returned for owner publication | scripts/forge-procedure-context.test.js, scripts/forge-task-preparation.test.js |
| execute-task | core + execution | scripts/forge-task-execution.js, scripts/forge-unit-sidecar.js, scripts/forge-prompt.js | T03; pending | Complete plan, security and plan gates accepted; Physical roots, nonempty claims/generation, model and effort validated | Every must-have verified in CODE_DIR; scoped output and criterion evidence returned | scripts/forge-procedure-context.test.js, scripts/forge-task-execution.test.js |
| execute-loose-task | core + execution | scripts/forge-task-execution.js, scripts/forge-unit-sidecar.js, scripts/forge-prompt.js | T03; pending | Complete plan, security and plan gates accepted; Physical roots, nonempty claims/generation, model and effort validated | Every must-have verified in CODE_DIR; scoped output and criterion evidence returned | scripts/forge-procedure-context.test.js, scripts/forge-task-execution.test.js |
| verification | core + verification | scripts/forge-verify.js, scripts/forge-verifier.js | T02; pending | Exact plan and actual code root identified; Concrete applicable checks resolved without inventing commands | Outcomes, skips and declared-artifact evidence captured independently | scripts/forge-procedure-context.test.js, scripts/forge-verify.test.js |
| complete-slice | core + completion | scripts/forge-prompt.js, scripts/forge-unit-sidecar.js | T02; ready | Task/slice summaries, deliveries and review findings preserved; Verification and protected branch guard remain applicable | Delivery facts, UAT gaps and canonical owner publication remain separate | scripts/forge-procedure-context.test.js, scripts/forge-prompt.test.js |
| complete-milestone | core + completion | scripts/forge-prompt.js, scripts/forge-unit-sidecar.js | T02; ready | Task/slice summaries, deliveries and review findings preserved; Verification and protected branch guard remain applicable | Delivery facts, UAT gaps and canonical owner publication remain separate | scripts/forge-procedure-context.test.js, scripts/forge-prompt.test.js |
| memory-selection | core + memory | scripts/forge-memory-context.js, scripts/forge-unit-sidecar.js, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md | T04; pending | Eligible problem/plan query and unit identity kept separate; Canonical memory selector and explicit availability retained | Extraction uses its own envelope; no inferred publication from provider success | scripts/forge-procedure-context.test.js, scripts/forge-procedure-callers.test.js |
| memory-extract | core + memory | scripts/forge-memory-context.js, scripts/forge-unit-sidecar.js, skills/forge-auto/SKILL.md, skills/forge-next/SKILL.md | T04; pending | Eligible problem/plan query and unit identity kept separate; Canonical memory selector and explicit availability retained | Extraction uses its own envelope; no inferred publication from provider success | scripts/forge-procedure-context.test.js, scripts/forge-procedure-callers.test.js |
| recovery | core + recovery | scripts/forge-attempt-recovery.js, scripts/forge-unit-sidecar.js, skills/forge-pause/SKILL.md | T04; pending | Inspect process and receipt before retry; Functional answers, live standing authority and historical budget preserved | Replay valid saved output or reconcile every writer root before an untried valid route | scripts/forge-procedure-context.test.js, scripts/forge-procedure-callers.test.js |
| pause | core + recovery | scripts/forge-attempt-recovery.js, scripts/forge-unit-sidecar.js, skills/forge-pause/SKILL.md | T04; pending | Inspect process and receipt before retry; Functional answers, live standing authority and historical budget preserved | Replay valid saved output or reconcile every writer root before an untried valid route | scripts/forge-procedure-context.test.js, scripts/forge-procedure-callers.test.js |
| restart | core + recovery | scripts/forge-attempt-recovery.js, scripts/forge-unit-sidecar.js, skills/forge-pause/SKILL.md | T04; pending | Inspect process and receipt before retry; Functional answers, live standing authority and historical budget preserved | Replay valid saved output or reconcile every writer root before an untried valid route | scripts/forge-procedure-context.test.js, scripts/forge-procedure-callers.test.js |
| handoff | core + recovery | scripts/forge-attempt-recovery.js, scripts/forge-unit-sidecar.js, skills/forge-pause/SKILL.md | T04; pending | Inspect process and receipt before retry; Functional answers, live standing authority and historical budget preserved | Replay valid saved output or reconcile every writer root before an untried valid route | scripts/forge-procedure-context.test.js, scripts/forge-procedure-callers.test.js |
| review-challenger | core + review | scripts/forge-xllm.js, shared/forge-review.md | T05; pending | Configured review models and scope resolved independently of execution tiers; Scoped correction claims and current findings retained | Sanitized diagnostic and actual verdict/correction outcomes preserved without invented fallback | scripts/forge-procedure-context.test.js, scripts/forge-xllm-review-cli.test.js |
| review-advocate | core + review | scripts/forge-xllm.js, shared/forge-review.md | T05; pending | Configured review models and scope resolved independently of execution tiers; Scoped correction claims and current findings retained | Sanitized diagnostic and actual verdict/correction outcomes preserved without invented fallback | scripts/forge-procedure-context.test.js, scripts/forge-xllm-review-cli.test.js |
| review-rebuttal | core + review | scripts/forge-xllm.js, shared/forge-review.md | T05; pending | Configured review models and scope resolved independently of execution tiers; Scoped correction claims and current findings retained | Sanitized diagnostic and actual verdict/correction outcomes preserved without invented fallback | scripts/forge-procedure-context.test.js, scripts/forge-xllm-review-cli.test.js |
| review-fix | core + review | scripts/forge-xllm.js, shared/forge-review.md | T05; pending | Configured review models and scope resolved independently of execution tiers; Scoped correction claims and current findings retained | Sanitized diagnostic and actual verdict/correction outcomes preserved without invented fallback | scripts/forge-procedure-context.test.js, scripts/forge-xllm-review-cli.test.js |
| distribution | core + distribution | scripts/forge-source-manifest.js, scripts/forge-codex-renderer.js, scripts/forge-instructions.js | T06; pending | Canonical source inventory and module digests validated; Both host renderers exercised only in temporary roots | Installed content resolves the same core/modules with explicit availability and hashes | scripts/forge-procedure-context.test.js, scripts/forge-source-manifest.test.js |

## Bytes and integrity

Policy utf8-no-bom-lf-v1: strict UTF-8, optional initial BOM removed, CRLF and CR
normalized to LF, all other whitespace including final newline preserved.
A module digest covers precisely the canonical bytes subsequently inserted.
Composition order is core first, then declared phase order with depth-first
dependency expansion and first occurrence deduplication. Cycles and conflicting
module IDs/paths are errors; dependencies and phases must be mapped explicitly.
Each emitted block starts with <!-- forge-procedure:ID --> plus LF.
Blocks are joined with two LF bytes. composition_sha256 covers these exact UTF-8
bytes, including IDs, order, framing and content. It does not replace template_sha256,
final_prompt_sha256, or final telemetry metrics. Metadata hashes prove bytes, not execution.

## Trusted roots and failures

API options cwd/forgeHome are host-controlled and resolved by forge-home.js.
Never derive either root from imported prompt/module data. Project manifest wins;
a present but invalid project manifest never falls back to the installed copy.
Only relative shared Markdown paths are eligible, with realpath containment before
opening a module. Each input is capped at 512 KiB; composition at 8 MiB.
Invalid UTF-8, NUL, empty content, unreadable/nonregular/oversized files, integrity
mismatch, missing dependencies, cycles, unknown phases or pending modules throw.
Manifest validation finishes before any module read. No provider, shell, project JS
or .gsd writer is invoked by this utility. Optional context budgets do not enter
mandatory composition; callers must append optional material separately.

## Offline interfaces

node scripts/forge-procedure-context.js --validate --cwd <trusted-project>
node scripts/forge-procedure-context.js --phase execute-task --cwd <trusted-project>
--forge-home <trusted-install> selects installation fallback only when local is absent.
validateProcedureManifest(manifest) validates shape/graph without reading modules.
loadProcedureContext({phase,cwd,forgeHome}) returns content and composition metadata.
--validate validates inventory, not availability/integrity of every pending module.
Composition validates the selected transitive modules and fails closed before callers
may invoke a provider. T02-T06 own those caller integrations; T01 does not assert them.

## Source responsibilities

Core obligations come from forge-dispatch, forge-interaction, forge-bidirectional-sidecar,
forge-delivery and forge-personal-context; their original contracts remain authoritative.
Review retains its configured model source and sanitized diagnostics (T05).
Memory remains informational and selected through the existing canonical selector (T04).
Recovery retains live authority, pending decisions, receipt/process inspection and the
historical sidecar clock (T04). T06 owns host distribution in temporary installations.

Standalone task IDs use task-<phase> to preserve the separate standalone scope;
T03 maps the actual brainstorm/discuss/research/plan phaseContract into these IDs.
Schema covers closed structure; the loader additionally validates graph references,
root containment, uniqueness, file limits, encoding and content integrity.

## Prompt integration (T02)

The nine discuss/research/plan/check/complete units load mandatory composition
before optional selection, then render it once with the template parameters.
The procedure_context metadata identifies canonical modules and pre-parameterization
composition bytes; template_sha256 continues to cover only the original template.
final_prompt_sha256 and input_tokens cover the final rendered body after isolation
and pending context; token_method remains heuristic-chars-4, not observed tokens.
Materialized prompt frontmatter retains these hashes and module metadata.
Zero optional memory/standards/ledger budgets never remove mandatory procedures.
Missing or invalid mandatory modules fail before optional providers/publication.
Execution modules and the standalone verification consumer remain pending for their
respective later integration; the verification entry is not claimed ready here.
Complete-slice requires owner snapshot immediately before dispatch and consuming
verify after the completer, same run/unit/owner/CODE_DIR. Inconclusive is advisory,
never clean; no historical snapshot is manufactured or reclassified as valid.
