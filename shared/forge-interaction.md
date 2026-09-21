# Forge interaction contract

This contract applies to ordinary analysis as well as skills, agents, commands and dispatch.
The host's actual tool availability, purpose, mode and schema restrictions take precedence.
Existing authorization remains valid: do not reopen accepted decisions or invent approval gates.

## Decision handling

- Distinguish a required human decision from an optional clarification before asking.
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

- Claude: use native `AskUserQuestion` when exposed and permitted, retaining its supported batches and multiSelect semantics.
- Codex: select an actually exposed and permitted `request_user_input` or `request_user_input_async`. A configured feature flag does not establish availability in this session.
- Never call a Plan-only tool outside Plan mode, an optional-only tool for a required gate, or an approval-prohibited tool for approval. Use the separate-text-and-wait fallback for required input when restricted; do not change modes merely to bypass restrictions.
- For synchronous Codex input, obey its actual schema: 1–3 questions per batch, stable snake_case `id`, short `header` (at most 12 characters), `question`, and 2–3 mutually exclusive `options`, each with `label` and `description`. Prefer one question. Put the recommended choice first and label it as recommended; recommendation does not select it. Do not add an Other option when the client supplies free-form input.
- Split larger Claude batches into multiple permitted batches, retaining stable decision identities and every unresolved decision. Four options must be regrouped through follow-up questions without dropping alternatives.
- Convert Claude multiSelect into sequential per-item decisions or use a native alternative only if its exposed schema truly supports multiple selections. Never send `multiSelect` to a schema without that field.
- Async uses its own exposed schema, not the synchronous schema by assumption. A returned pending handle is not an answer: keep the decision pending, use the host's answer collection mechanism, and explicitly await a resolved answer before dependent work. Follow the host's rules when a response is cancelled or empty.
- A round limit bounds questioning effort, not consent: unresolved required decisions stay pending or return to the orchestrator. Only optional gaps may become documented assumptions.

Forge enforces these instructions in its distributed prompts. Client tabs and a locked input field are not guaranteed, and prompt tests do not demonstrate client UI behavior.

Installation probes `codex features list` locally with a bounded timeout before adding an absent supported default. Explicit user settings and ambiguous TOML remain untouched. Dry runs skip this probe (`questions-probe-dry-run`): capability and the prospective feature edit remain unresolved until apply; dry-run is not a guarantee of session tool availability.
