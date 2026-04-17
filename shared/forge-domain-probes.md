# Forge Domain Probes — Targeted Questions by Domain

Reference used by `forge-discusser` when a dimension scores below threshold and the scope touches a recognized domain. Each domain lists 4–6 concrete questions. Use them as seed material for `AskUserQuestion` — rephrase for the project's concrete context rather than asking verbatim.

**How to use:** Match the milestone/slice scope to one or more domains. Draw at most 1–2 questions per domain (never exhaust a list in one round — that's interrogation, not discussion). Each question must have 2–4 concrete options derived from the project stack; probes give you the question, not the options.

---

## Auth / Identity

| Question | Why it matters |
|---|---|
| Session model — stateless JWT, server sessions, or provider-hosted (Auth0/Clerk/Cognito)? | Determines storage, revocation, and mobile/API friction |
| Where do refresh tokens live — HttpOnly cookie, mobile secure storage, or no refresh? | Security posture + UX of "stay logged in" |
| Password rules — MFA required, optional, or not supported? | Compliance + onboarding friction |
| Account recovery — email link, security questions, admin-only, or no recovery? | Support burden + security trade-off |
| Who owns the user record — this service, or an external IdP? | Data ownership + SSO feasibility |
| Is there multi-tenant isolation (orgs/workspaces), and at what level (row-level, schema, instance)? | Shapes every query downstream |

## Authorization / Permissions

| Question | Why it matters |
|---|---|
| RBAC (roles), ABAC (attributes), or per-resource ACLs? | Query complexity + audit story |
| Where are permissions enforced — DB policies, middleware, per-endpoint, or client-side hints only? | Defense-in-depth boundary |
| Can a user belong to multiple orgs/teams with different roles? | Join cardinality + token shape |
| Are there "system" actions that bypass the permission model (cron, admin tools)? | Where to draw the trusted/untrusted line |

## Data / Database

| Question | Why it matters |
|---|---|
| Single database or per-service/per-tenant? | Transaction boundaries + ops complexity |
| Migration strategy — forward-only, reversible, or blue/green? | Rollback cost + deploy risk |
| Soft-delete, hard-delete, or append-only audit trail? | Compliance + recovery story |
| Expected cardinality for the biggest tables (order of magnitude)? | Index strategy, pagination, archiving |
| Read-heavy, write-heavy, or balanced — and are reads eventually consistent OK? | Replica + cache shape |
| Schema owner — migrations live in code, or DBA-managed? | CI pipeline + who deploys what |

## API / Integration

| Question | Why it matters |
|---|---|
| REST, GraphQL, RPC, or mixed? | Client complexity + tool ergonomics |
| Versioning strategy — URL (`/v2`), header, or never break contract? | Deprecation cost |
| Who consumes it — only this project's frontend, partners, or public? | Rate-limits, docs, auth model |
| How strict is the contract — OpenAPI/schema-generated or prose docs? | Drift detection + client generation |
| Idempotency — required, optional via `Idempotency-Key`, or not at all? | Retry safety for mutations |

## Realtime / WebSockets

| Question | Why it matters |
|---|---|
| Pub/sub fan-out — single-instance, Redis-backed, or managed service (Ably/Pusher)? | Horizontal scale story |
| Connection model — persistent WS, long-poll, or SSE? | Mobile/proxy friction |
| Message ordering — required globally, per-channel, or best-effort? | Backend complexity |
| Reconnect gaps — replay from log, "missed message" fetch, or ignore? | Client correctness |
| Authorization — token on connect, per-message, or channel-bound? | Broadcast safety |

## Background Jobs / Queues

| Question | Why it matters |
|---|---|
| At-least-once or exactly-once delivery expectation? | Idempotency discipline |
| Queue backing — in-process, Redis, SQS, Kafka, or DB-backed? | Ops + retry semantics |
| Max acceptable job latency (seconds, minutes, hours)? | Worker concurrency + alerting |
| Retry/backoff policy — fixed, exponential, or DLQ after N failures? | Observability surface |
| Does job ordering matter per user/entity? | Partition strategy |

## File Storage / Uploads

| Question | Why it matters |
|---|---|
| Direct-to-bucket (presigned URL) or proxy through the app? | Upload cost + virus scanning |
| Max file size and accepted types — enforced where? | DoS surface |
| Public, signed, or private access — and how long do signed URLs live? | CDN strategy |
| Storage class — hot, cold/archive, lifecycle rules? | Cost over time |
| Retention — forever, until user deletes, or policy-based? | GDPR/compliance |

## Search / Filtering

| Question | Why it matters |
|---|---|
| Database full-text (Postgres `tsvector`/MySQL `FULLTEXT`), dedicated engine (Meilisearch/Elasticsearch/Typesense), or provider-hosted (Algolia)? | Index cost + stemming quality |
| Are filters faceted (multi-select aggregation) or flat? | Index shape |
| Relevance tuning — out-of-the-box, synonym lists, or learned ranking? | Iteration cadence |
| Index freshness requirement — seconds, minutes, or nightly? | Ingestion pipeline |
| Typo tolerance — required, per-locale, or off? | UX quality |

## Payments / Billing

| Question | Why it matters |
|---|---|
| Processor — Stripe, Adyen, provider-integrated, or manual invoice? | Compliance scope (PCI) |
| Subscription, one-off, usage-based, or hybrid? | Billing engine complexity |
| Who owns the pricing catalog — config file, DB, or processor dashboard? | Change velocity |
| Webhook idempotency — handled where? | Double-charge/double-provision safety |
| Refunds/credits — self-serve, admin-only, or manual-only? | Support tooling |

## Caching

| Question | Why it matters |
|---|---|
| Cache scope — per-request, per-user, shared, or CDN edge? | Invalidation complexity |
| Invalidation — TTL only, event-driven, or manual bust? | Staleness risk |
| What gets cached — objects, query results, rendered HTML, or API responses? | Hit-rate ceiling |
| Stale-while-revalidate OK, or must always be fresh? | Latency vs correctness |

## Observability

| Question | Why it matters |
|---|---|
| Logs — structured (JSON), where shipped (stdout, Loki, Datadog)? | Search story + PII risk |
| Metrics — Prometheus, StatsD, provider-hosted? | Alert tooling |
| Tracing — enabled, sampled how, which propagation headers? | Cross-service debugging |
| Error tracking — Sentry, self-hosted, or logs-only? | Triage speed |
| Retention — how long do logs/metrics live? | Compliance + cost |

## Dashboard / Admin UI

| Question | Why it matters |
|---|---|
| Who uses it — internal team only, customer admins, or both? | Permission model |
| Real-time refresh or on-demand reload? | Backend load pattern |
| Table strategy — server-side pagination/sort, or client-side for small datasets? | UX ceiling |
| Export (CSV/PDF) — needed, and how large? | Streaming vs in-memory |
| Audit log visibility — per-record history, global feed, or none? | Support value |

---

## When no domain matches

If the scope doesn't fit any domain above, fall back to the generic dimension probes:
- **Scope:** What specifically is NOT in this milestone/slice?
- **Acceptance:** What observable outcome proves this is done?
- **Tech constraints:** Any specific library, version, or infra requirement?
- **Dependencies:** What must already exist before this starts?
- **Risk:** What's the single biggest way this could go wrong?

Treat these as last resort — domain-specific questions almost always produce better plans than generic ones.
