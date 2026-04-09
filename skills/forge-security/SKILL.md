---
name: forge-security
description: Security analysis for GSD tasks and slices. Detects security-sensitive scope in a plan and produces a focused, implementation-specific checklist the executor must verify. Auto-invoked by the orchestrator when security keywords are detected in T##-PLAN.md.
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

## Step 3 — Write the checklist

Save as:
- Task-level: `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/tasks/{T##}-SECURITY.md`
- Slice-level: `{WORKING_DIR}/.gsd/milestones/{M###}/slices/{S##}/{S##}-SECURITY.md`

```markdown
# Security Checklist — {T## or S##}: {title}

**Domains in scope:** {comma-separated list of active domains}
**Generated:** {date}
**Risk level:** HIGH | MEDIUM | LOW

*(HIGH = auth/authz/crypto in scope; MEDIUM = input validation or secrets; LOW = transport/headers only)*

## Must-Verify Before Marking Task Complete

{For each active domain, list 2-5 specific, actionable items tailored to THIS plan.}

### Authentication *(if active)*
- [ ] {Specific item for what this task builds — not a generic rule}

### Authorization *(if active)*
- [ ] {Specific item}

### Data Handling *(if active)*
- [ ] {Specific item}

### Input Validation *(if active)*
- [ ] {Specific item}

### Secrets Management *(if active)*
- [ ] No secrets or API keys appear in source files or committed `.env`
- [ ] All secrets loaded from environment variables — verified before commit

### Injection *(if active)*
- [ ] {Specific item based on the ORM/DB layer detected in PROJECT.md}

### Frontend XSS *(if active)*
- [ ] {Specific item}

### Transport / Headers *(if active)*
- [ ] {Specific item}

## Anti-Patterns to Avoid
{2-3 specific anti-patterns for the stack in PROJECT.md — e.g., "Express: never use `res.json(err)` — leaks stack traces"}

## If You Find a Violation
Record it in T##-SUMMARY.md under `## Security Flags` with: file, line, pattern, and fix applied.
Do NOT mark the task complete until all HIGH/MEDIUM items are resolved.
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
