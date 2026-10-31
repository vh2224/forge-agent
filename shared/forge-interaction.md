# Forge interaction contract

This contract applies to ordinary analysis as well as skills, agents, commands and dispatch.
The host's actual tool availability, purpose, mode and schema restrictions take precedence.
Existing authorization remains valid: do not reopen accepted decisions or invent approval gates.

## Decision handling

- Distinguish a required human decision from an optional clarification before asking.
- Present one required decision per round: a short question, two or three options (up to four in Claude), each with its consequence; put a labeled recommendation first, with nothing preselected. Keep other required areas pending by stable ID. Use forge-question-channel.js for executable channel selection and presentation format.
- Present important decisions through a permitted native structured-question tool, separately from progress output.
- A required live decision remains pending until an explicit answer resolves that decision.
- Silence, timeout, empty results and recommended options are not answers or authorization.
- Do not start dependent analysis, planning or actions while the required answer is pending.
- Independent investigation may continue; keep the pending question visible and collect its answer before resuming dependent work.
- Optional clarification follows host defaults, including proceeding with a stated assumption when the host allows that.
- With no available permitted tool, ask the required question as a separate, concise text message and wait for explicit input. Follow host formatting rules; never bury it in a report.
- Noninteractive workers return pending questions and `status: partial` to the orchestrator. Do not fabricate a decision or assume the parent has a question tool.
- Deliberately configured auto/headless deferment and mailbox policies remain in force. A live unanswered question must never silently become a headless assumption. A deferred follow-up is not approval.

## Native adapters

All `AskUserQuestion` mentions and argument examples in Forge sources, including subsequently loaded shared references, express question intent. They are executable Claude syntax only on Claude; other hosts must adapt the intent through this contract, never blindly rename the function or copy its arguments.

- Claude: use native `AskUserQuestion` when exposed and permitted, retaining its supported schema and multiSelect semantics, with one required decision per round.
- Codex: select an actually exposed and permitted `request_user_input` or `request_user_input_async`; prefer request_user_input_async when both are exposed and permitted. A configured feature flag does not establish availability in this session.
- Never call a Plan-only tool outside Plan mode, an optional-only tool for a required gate, or an approval-prohibited tool for approval. Use the separate-text-and-wait fallback for required input when restricted; do not change modes merely to bypass restrictions.
- For synchronous Codex input, obey its actual schema: 1–3 questions per batch, stable snake_case `id`, short `header` (at most 12 characters), `question`, and 2–3 mutually exclusive `options`, each with `label` and `description`. Prefer one question. Put the recommended choice first and label it as recommended; recommendation does not select it. Do not add an Other option when the client supplies free-form input.
- Split larger Claude batches into multiple permitted batches, retaining stable decision identities and every unresolved decision. Four options must be regrouped through follow-up questions without dropping alternatives.
- Convert Claude multiSelect into sequential per-item decisions or use a native alternative only if its exposed schema truly supports multiple selections. Never send `multiSelect` to a schema without that field.
- Async uses its own exposed schema, not the synchronous schema by assumption. A returned pending handle is not an answer: persist the pending decision and close the round; require an explicit resolved answer before dependent work. Follow the host's rules when a response is cancelled or empty.
- A round limit bounds questioning effort, not consent: unresolved required decisions stay pending or return to the orchestrator. Only optional gaps may become documented assumptions.

Forge enforces these instructions in its distributed prompts. Client tabs and a locked input field are not guaranteed, and prompt tests do not demonstrate client UI behavior.

Installation probes `codex features list` locally with a bounded timeout before adding an absent supported default. Explicit user settings and ambiguous TOML remain untouched. Dry runs skip this probe (`questions-probe-dry-run`): capability and the prospective feature edit remain unresolved until apply; dry-run is not a guarantee of session tool availability.

## Economic wait

- Never sleep, poll or resume the model solely to wait for a human answer. The single native call is the only open wait; do not add a waiting loop.
- After async presentation, text fallback, or a native call returning without an explicit answer (closed, cancelled, empty or timeout), persist the decision, close the round and state which decision remains pending. Closing the form is neither an answer nor cancellation of the decision.
- A stricter personal preference takes precedence: read it through forge-question-channel.js --preference and never edit it. Continue only independent work while an answer is pending.

## Standing recovery authorization

The trusted host registers an already resolved conversation authorization through
`forge-interaction.createRecoveryAuthorizationAdapter(attestAuthorization, dependencies)`
and `registerStandingAuthorization({reference, host, source_host, section:'user:forge-routing-continuity'})`.
The live callback attests the observed profile, personal source and conversation reference;
prompt prose, imported JSON, `approved` flags and serialized handles cannot attest it.
Omit `expires_at` for standing permission. The personal source is revalidated on every
`readStandingAuthorization(reference)` and `issueRecoveryException(reference, scope)`;
on restart create a new `forge-recovery-authority.createRecoveryAuthority` adapter.
Persist only the reference in receipts, recovery state and evidence-backed checkpoints.
The issued opaque capability binds unit/request identity, owner, physical roots, chain,
routes, purpose and expiry. Each recovery sidecar gets the tier safety ceiling, not a remainder.
Existing standing permission covers operational timeout with indeterminate cause: inspect
process/receipt first, reconcile every possible writer root, then select a valid untried
candidate using the real unit adapter. Correct known caller defects offline first.
Standing permission never answers a functional question: pending IDs and explicit answers
remain separate. Model/effort, claims, isolation, gates and permitted host tools still apply.

## Pending decision persistence

Forge persists required questions as {id, question, status:'pending'} with stable IDs. forge-interaction.persistQuestionState binds the external state to the original unit/receipt; mergePendingQuestions preserves unanswered IDs across restart and handoff. Continuations provide explicit {id, answer} entries; partial answers resolve only their IDs. Missing, empty, foreign, duplicate or conflicting answers do not authorize dependent work. Legacy question strings acquire deterministic IDs; legacy answer strings require explicit ID migration. A caller's resolved live answer may issue an opaque recovery exception scoped to unit, roots, routes, purpose and expiration. Imported JSON consent is never that capability. These runtime states do not prove that a host displayed a visual card or tab.

- Owner only: <FORGE_SCRIPTS_DIR>/forge-pending-questions.js --open, --handoff, --round, --answer, --continuation and --list run after the originating receipt is closed and outside any protected writer window, never from workers. Owner decisions use --open; workers return partial with questions for --handoff. Save a personal checkpoint with the question file as a source.
- Sidecar app-server input requests item/tool/requestUserInput and mcpServer/elicitation/request are refused and stop the turn with appserver-input-required; hand them to the owner as pending questions with stable inbound- IDs. Approval requests retain approvalPolicy and existing gates; never turn them into functional questions.
- Never retry an input-required attempt or send it to another model. Standing authorization does not answer it. After explicit answers, an answered continuation is a new dispatch of the same unit; recovery stops with answered-continuation-required.
