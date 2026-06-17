#!/usr/bin/env node
'use strict';

// forge-usage-poll.js — recover the 5h/weekly usage indicator under token auth.
//
// When a session is launched with ANTHROPIC_AUTH_TOKEN (the multi-account
// path), Claude Code authenticates via the token and does NOT populate the
// statusline's `rate_limits` field — so the ⏱/📅 usage bars vanish and the
// proactive exhaustion handoff goes blind. The data itself is still reachable:
// a Messages API call with the account's oat01 token returns the windows in
// response headers (`anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}`).
//
// This poller makes one cheap `max_tokens:1` request (~9 tokens), reads those
// headers, and writes the same `forge-ratelimit-<session>.json` bridge that the
// statusline (display fallback) and forge-auto (handoff) already consume. It
// self-throttles on the bridge's age, with an adaptive cadence keyed to the
// last-known utilization (cheap when far from any limit, precise near it).
//
// `fetchUsage()` is exported for the multi-account dashboard (forge-usage.js).
//
// Best-effort (MEM008): any failure is swallowed; the process exits 0 — a poll
// error must never disrupt the host session.

const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');

// Fetch the unified 5h/7d windows for one account token. Resolves to
// { five_hour, seven_day } (each {used_percentage 0..100, resets_at epoch|null}
// or null), or null on any failure. Never rejects.
function fetchUsage(token, model = 'claude-haiku-4-5') {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = https.request({
      method: 'POST',
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'authorization': `Bearer ${token}`,
        'content-length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (res) => {
      res.on('data', () => {}); // drain — only the headers matter
      res.on('end', () => {
        try {
          const h = res.headers;
          const win = (prefix) => {
            const util  = h[`anthropic-ratelimit-unified-${prefix}-utilization`];
            const reset = h[`anthropic-ratelimit-unified-${prefix}-reset`];
            if (util === undefined) return null;
            const pct = Math.max(0, Math.min(100, parseFloat(util) * 100));
            if (!Number.isFinite(pct)) return null;
            const r = reset !== undefined ? parseInt(reset, 10) : null;
            return { used_percentage: pct, resets_at: Number.isFinite(r) ? r : null };
          };
          const five_hour = win('5h');
          const seven_day = win('7d');
          resolve((five_hour || seven_day) ? { five_hour, seven_day } : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const token = process.env.ANTHROPIC_AUTH_TOKEN || '';
  // Only token-auth sessions need this. Keychain-mode sessions get rate_limits
  // from Claude Code directly, so polling would be redundant — no-op.
  if (!token) return;

  const sessionId = (arg('session', '') || process.env.FORGE_SESSION_ID || '').trim();
  if (!sessionId) return;

  const account = (process.env.FORGE_ACCOUNT || '').trim() || null;
  const model   = arg('model', 'claude-haiku-4-5');
  // --min-interval forces a fixed cadence (seconds); otherwise cadence is
  // adaptive on the last-known usage (cheap when far from any limit, precise
  // near it). Each poll costs ~9 tokens, so this is request hygiene more than
  // token spend.
  const forced = arg('min-interval', '');

  const bridge = path.join(os.tmpdir(), `forge-ratelimit-${sessionId}.json`);

  // Self-throttle on the existing bridge's age + last-known utilization.
  try {
    const prev = JSON.parse(fs.readFileSync(bridge, 'utf8'));
    if (prev && typeof prev.ts === 'number') {
      const maxUtil = Math.max(
        prev.five_hour && prev.five_hour.used_percentage || 0,
        prev.seven_day && prev.seven_day.used_percentage || 0,
      );
      // Adaptive cadence: <50% → 15min, 50–70% → 5min, ≥70% → 2min.
      const interval = (forced !== '')
        ? parseInt(forced, 10) * 1000
        : maxUtil >= 70 ? 120000 : maxUtil >= 50 ? 300000 : 900000;
      if (Date.now() - prev.ts < interval) return;
    }
  } catch { /* no/old bridge — proceed */ }

  const usage = await fetchUsage(token, model);
  if (!usage) return; // headers absent (e.g. API-key auth) / request failed
  try {
    fs.writeFileSync(bridge, JSON.stringify({
      five_hour: usage.five_hour,
      seven_day: usage.seven_day,
      account,
      ts: Date.now(),
      source: 'poll',
    }), 'utf8');
  } catch { /* best-effort */ }
}

module.exports = { fetchUsage };

if (require.main === module) {
  main().catch(() => {}); // best-effort — never throw
}
