# Worktree milestone checkup — issues 457 and 458

Baseline: Forge4.52.2, commit `c28568951f060f631527470a975af181113e69e7`.
The operator supplied the complementary TromManagement checkup. Its findings
were checked against the published source and hermetic fixtures; no consumer
milestone, external WDMA checkout or retained consumer attempt was operated.

The corrected comment on457 is authoritative for the reproduction: a subsequent
task's claim already invalidated the repair in one session. Owner transfer is a
second trigger; subsequent changes to an earlier delivered source are a third.

## Scope and evidence

Implementation, local regression tests, independent review, CI, installation and
consumer acceptance have separate evidence. A simulated native callback or
sidecar protocol process exercises the owner contract without proving a live
provider or the consumer's product tests. The integrated regression must finish
the actual controller loop through `complete-milestone` before it is called a
passing workflow test.

Historical completion reads keep the committed begin/complete/event lineage,
exact original plan and captured delivery. Active repair and new completion
continue to require current authority, current claims and strict current-source
verification. A historical read never grants a writer capability. Unknown
writers, changed protected metadata and unverified functional decisions retain
their existing refusal.

## Numbered checkup map

|458 item|Behavior and validation boundary|
|---|---|
|1 /457|Separate historical repaired completion from the live repair actor. Preserve the immutable baseline and authenticated controller lineage; report the original refusal cause. Later claims and sessions must not reselect a completed task.|
|2|Allow a retained dirty claim at an ordinary between-unit owner transfer only after exact terminal-unit, authenticated plan-write scope, claim birth, controller/event, historical-delivery and quiescence validation. Refuse newer claims reusing an older completion and ambiguous repeated local task IDs across slices. Preserve the claim bytes; unrelated legacy plan fields are not re-admitted as a new writer gate.|
|3|Bind a bounded contemporaneous ignored-source inventory to the captured Git revision and dirty workspace. Common ignore patterns no longer make a source glob ambiguous by themselves. An unbound ignored matching source still refuses; historical reads never consult today's ignore inventory. Legacy ambiguous captures remain conservative.|
|4|Read authenticated historical delivery when projecting an earlier repaired completion. A later authorized rewrite does not invalidate the earlier historical result; a new completion still checks current bytes.|
|5|Give fresh native milestone execution an explicit owner-side entry using the existing strict native delivery protocol, real invocation binding, guarded return, verification and publication. Auto-deferred plan gates require the existing real scoped adapter and live reattestation. The actual executor role and rendered prompt distinguish worker return from owner publication; worker instructions no longer request protected owner writes. Retained results keep their original manifests/receipts.|
|6|Run commands in the physical `CODE_DIR`, with `--gsd-dir` pointing to the artifact owner's `.gsd`. The current verifier already attributes telemetry to that explicit owner; no blanket telemetry/snapshot exemption is introduced.|
|7|New acceptance checkpoints must use stable question/decision evidence rather than a mutable STATE or projected decisions file. Keep strict stale detection. Reconcile older stale captures against the already accepted decision with attributable evidence; do not silently rebind or request the same acceptance again.|
|8|Use DELIVERY-INPUT schema1 for an existing prose slice plan. Preserve schema2 execution-contract validation for structured plans. A prose plan does not acquire structured criteria by changing a version number.|
|9|On Windows, promote only supported leading literal environment assignments to the supervised child environment. Preserve the original evidence command and join semantics. Unsupported expansion/substitution or assignment-prefixed command chains refuse before spawn, including percent/delayed expansion in the remaining command that could introduce operators after the literal scan. The established path without an assignment prefix is unchanged.|
|10|New execution windows bind the original observed host/session, request, external channel and committed begin. Their orphan adapter measures receipt/result/manifest, begin/lease/claim/plan, every physical root and index, and requires live joins/reconciliation plus a fresh comparison under the publication fence. Recovery releases coordination only. A missing holder PID is never a join; legacy unbound windows remain explicitly unsupported rather than acquiring a guessed original actor. The preparation adapter is preserved.|
|11|The proof size/file-count limits are real; the report does not establish that the consumer snapshot exceeds them. Preserve the safety limits. Measure the actual artifact and declare bounded parts/sources before a delivery that could exceed them. A size refusal must retain its originating cause.|
|12|Verification timeout is already configurable and sealed with provenance. Declare the command's required timeout in the request/runtime or applicable verification preference before sealing. No automatic global increase is made.|
|13|External data paths and required live checks are product requirements. Declare the literal environment and an observable required success in the plan/request. A skipped test does not prove a behavioral criterion; the strict delivery builder continues to refuse unobserved evidence. No external path is inferred from this report.|
|14|Use a persistent operator-owned channel outside owner and every code root, retained through replay/ACK/closure. Exteriority alone does not prove future durability. Preserve the original paths and bytes of existing receipts rather than moving them during recovery.|
|15|Review the physical code root including staged, unstaged and nonignored untracked files, without staging or committing them. Untracked reads use descriptor-bound byte limits and stable physical identity; growth/substitution refuses before emitting a diff. Keep VCS scope and link/binary refusals. Owner-only artifact diffs do not cover new product code.|
|16|A native challenger fallback resolves an explicit compatible native reviewer model and validates the actual invocation. Definition and observer rereads are bounded and stable while preserving source fingerprints. Preserve the external challenger model as history; never send a GPT model to a Claude leg or inherit an omitted model.|
|17|Use installed script paths; research precedes slice planning unless explicitly skipped; do not rewrite consumer CLAUDE state; report uncommitted output truthfully; reconcile an existing step run's owner before reuse; treat PowerShell's valueless `--args` as empty only for that option.|

## Consumer validation

The default cross-platform test inventory includes
`forge-issues-457-458-integration.test.js` (real uncommitted worktree and controller
closure), `forge-completion-root-bindings.test.js` (historical plan/claim/root
scope), `forge-native-milestone.test.js` (owner-managed invocation/gates/prompt),
and `forge-owner-execution-window-recovery.test.js` (actual private process
joins/races on both host identities). Existing source-scope, verification,
supervisor, review-diff and model-binding tests retain their independent
refusal checks. Windows uses the same discovered suites; no live model service
or external WDMA dataset is required by these hermetic tests.
The simulated Codex transport records the policy actually sent. The existing
Windows single-root profile sends `dangerFullAccess`; this test does not claim
operating-system sandbox enforcement. Native diagnostics retain hashes and
closed provenance fields, with normalized returned candidates stored separately
from the packaged prompt.

After a published update, the consumer can first inspect next-unit selection,
historical/current delivery and completion preconditions without writing. The
expected next task and external-data checks depend on that consumer's actual
state. Repository tests do not constitute consumer UAT or authority to transfer
its owner, release a retained window, repair a delivery or change its plans.
