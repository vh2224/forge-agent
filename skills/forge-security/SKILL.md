---
name: forge-security
description: "Checklist de seguranca por task/slice. Auto-invocada por keywords."
---

<objective>
Read a task or slice plan, identify which security domains are actually touched by this specific implementation, and produce a tight checklist of must-verify items. Generic advice is noise — every item must be traceable to something in the plan.
</objective>

<essential_principles>
- Only flag what's actually in scope. An auth task does not need a SQL injection checklist.
- Every item must be actionable and verifiable — not "handle errors gracefully" but "failed auth returns 401, not 500 with stack trace".
- A short focused checklist beats a comprehensive generic one. The executor reads this before coding, not after.
- If no security-sensitive scope is detected → write that explicitly. An empty checklist is valid.
</essential_principles>

<process>

## Step 1 — Read the plan

Parse args: `{M###} {S##} {T##}` (task-level) or `{M###} {S##}` (slice-level).

- Task-level: read `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}-PLAN.md`
- Slice-level: read `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-PLAN.md`
- Also read `.gsd/PROJECT.md` for stack context (language, framework, ORM, auth library)

## Step 2 — Identify active security domains

Map plan content to domains. Only activate domains where the plan explicitly mentions relevant keywords or describes relevant functionality:

| Domain | Activation keywords / description |
|--------|-----------------------------------|
| **Authentication** | auth, login, logout, jwt, oauth, session, token, credential, password, register, signup |
| **Authorization** | permission, role, rbac, acl, access control, admin, guard, middleware, policy |
| **Data handling** | encrypt, decrypt, hash, salt, crypto, sensitive data, pii, personal info, private key |
| **Input validation** | user input, form submission, query param, search, file upload, body parsing, sanitize |
| **Secrets management** | api key, secret, env var, .env, config, credential storage |
| **Injection (SQL/NoSQL/cmd)** | database query, raw sql, ORM bypass, exec, shell, subprocess, dynamic query |
| **Frontend XSS** | innerHTML, dangerouslySetInnerHTML, template rendering, user-generated content, markdown render |
| **Transport / headers** | http, cors, csp, security headers, certificate, tls, redirect |

Domains with zero keyword matches → exclude from output entirely.

## Step 3 — Classify items by confidence

For each active domain, generate items in two tiers:

**Blocker tier** — item directly triggered by a keyword or action explicitly named in the plan. Example: plan says "implement JWT refresh token rotation" → "Verify refresh token is invalidated on use (single-use)" is a Blocker.

**Check tier** — item implied by the domain but not directly named in the plan. These are high-value patterns for the domain that the executor should verify if applicable, but may not block completion if not relevant. Example: same plan → "Ensure token blacklist does not grow unbounded" might be a Check if the plan doesn't mention blacklisting.

Rule: if you're not sure which tier, default to Check. Fewer Blockers = checklist gets read. More Blockers = checklist gets ignored.

## Step 4 — Write the checklist

Save as:
- Task-level: `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}-SECURITY.md`
- Slice-level: `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-SECURITY.md`

```markdown
# Security Checklist — {T## or S##}: {title}

**Domains in scope:** {comma-separated list of active domains}
**Generated:** {date}
**Risk level:** HIGH | MEDIUM | LOW

*(HIGH = auth/authz/crypto in scope; MEDIUM = input validation or secrets; LOW = transport/headers only)*

## Blockers — resolve before marking complete
*(Directly triggered by explicit plan content — cannot skip)*

### Authentication *(if active and has Blocker items)*
- [ ] {Item directly tied to something the plan builds}

### Authorization *(if active and has Blocker items)*
- [ ] {Item}

### Data Handling *(if active and has Blocker items)*
- [ ] {Item}

### Input Validation *(if active and has Blocker items)*
- [ ] {Item}

### Secrets Management *(if active and has Blocker items)*
- [ ] No secrets or API keys appear in source files or committed `.env`
- [ ] All secrets loaded from environment variables — verified before commit

### Injection *(if active and has Blocker items)*
- [ ] {Item based on the ORM/DB layer in PROJECT.md}

### Frontend XSS *(if active and has Blocker items)*
- [ ] {Item}

### Transport / Headers *(if active and has Blocker items)*
- [ ] {Item}

## Also verify *(if applicable)*
*(Good-practice checks for the active domains — document rationale if skipping)*

- [ ] {Check-tier item — domain: Authentication}
- [ ] {Check-tier item — domain: ...}

## Anti-Patterns to Avoid
{2-3 specific anti-patterns for the stack in PROJECT.md — e.g., "Express: never use `res.json(err)` — leaks stack traces"}

## If You Find a Violation
Record it in T##-SUMMARY.md under `## Security Flags` with: file, line, pattern, and fix applied.
Do NOT mark the task complete until all Blocker items are resolved.
```

**If no domains are active:** write:
```markdown
# Security Checklist — {T##}: {title}
**Generated:** {date}
**Result:** No security-sensitive scope detected in this task. No checklist required.
```

</process>

<success_criteria>
- Every item references something actually in the plan — zero generic padding
- Risk level correctly reflects the domain mix (auth/authz = HIGH by default)
- Anti-patterns are stack-specific (Express, Django, Spring, etc.) not language-generic
- Executor can read this in under 60 seconds and know exactly what to verify
</success_criteria>
