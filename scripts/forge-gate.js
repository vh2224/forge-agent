#!/usr/bin/env node
// forge-gate — Mailbox protocol for asking the human a question from headless runs
//
// WHY THIS EXISTS
// ---------------
// `AskUserQuestion` is NOT served to headless sessions (`claude -p`). Verified
// empirically: the tool is absent from the `system/init` tool list. That is a
// platform wall, not a pref — so an autonomous run literally cannot ask.
// Today that forces the choice documented in CLAUDE.md: autonomy OR interactive
// gates, never both (`review.ask_in_auto: defer` defers instead of asking).
//
// This module removes that trade-off with a file-based mailbox — the same shape
// Forge already uses three times over (`pause`, `compact-signal.json`,
// `handoff-request.json`):
//
//   1. Orchestrator drops a note in the mailbox  → openGate()
//   2. Orchestrator waits beside the mailbox     → waitForAnswerSync()
//   3. A responder (CLI today, native app later) → listPending() / answerGate()
//   4. Orchestrator reads the reply and resumes
//
// It depends on nothing but the filesystem, so no Claude Code API change can
// break it, and it behaves identically headless and interactive.
//
// NEVER BLOCKS FOREVER: every gate carries a timeout and a declared default.
// On expiry the gate resolves to that default with source `timeout-default`.
// A run must degrade to its documented fallback, never hang waiting on someone
// who went to lunch.
//
// Gate files live under .gsd/forge/gates/{id}.json
//
// Library exports:
//   gatesDir(cwd)                              → string
//   openGate(cwd, spec)                        → gate object (written to disk)
//   readGate(cwd, id)                          → gate | null   (status computed, not persisted)
//   listGates(cwd, opts?)                      → gate[]
//   listPending(cwd)                           → gate[]        (unanswered + unexpired)
//   answerGate(cwd, id, choiceKey, opts?)      → { ok, gate, reason? }
//   cancelGate(cwd, id, opts?)                 → { ok, gate, reason? }
//   waitForAnswerSync(cwd, id, opts?)          → resolution
//   ask(cwd, spec, opts?)                      → resolution    (open + wait, one-shot)
//   cleanupResolved(cwd, opts?)                → { removed }
//   notify(gate, opts?)                        → boolean       (best-effort desktop notification)
//
// A `resolution` is: { id, status, choice, label, source, notes, gate }
//   status: 'answered' | 'expired' | 'cancelled'
//   source: 'human' | 'timeout-default' | 'cancelled'
//
// CLI:
//   node forge-gate.js --open --question "..." --option "key:Label:Description" [...]
//                      [--default <key>] [--timeout <ms>] [--run <id>] [--unit <id>]
//                      [--context "..."] [--wait] [--json] [--no-notify]
//   node forge-gate.js --list [--json] [--all]
//   node forge-gate.js --show <id> [--json]
//   node forge-gate.js --answer <id> --choice <key> [--notes "..."] [--json]
//   node forge-gate.js --cancel <id> [--json]
//   node forge-gate.js --wait <id> [--json]
//   node forge-gate.js --cleanup [--max-age <ms>]
//   node forge-gate.js --demo

'use strict';

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS  = 30 * 60 * 1000;  // 30min — a human check-in window
const DEFAULT_POLL_MS     = 500;
const RESOLVED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NOTIFY_TIMEOUT_MS   = 5000;
const MAX_CREATE_ATTEMPTS = 32;

// ── Paths ────────────────────────────────────────────────────────────────────
function gatesDir(cwd) {
  return path.join(cwd, '.gsd', 'forge', 'gates');
}

function ensureGatesDir(cwd) {
  const dir = gatesDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function gateFile(cwd, id) {
  return path.join(gatesDir(cwd), `${id}.json`);
}

// ── ID ───────────────────────────────────────────────────────────────────────
// G-<YYYYMMDDHHMMSS>-<rand4>. Timestamp-first so gates sort by creation, and a
// random suffix to reduce collisions; exclusive publication resolves duplicates.
function makeGateId(now) {
  const d = now instanceof Date ? now : new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ts = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
             `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `G-${ts}-${crypto.randomBytes(2).toString('hex')}`;
}

// ── Atomic IO ────────────────────────────────────────────────────────────────
// tmp + rename so a reader never observes a half-written gate.
function writeGateFile(cwd, gate) {
  ensureGatesDir(cwd);
  const target = gateFile(cwd, gate.id);
  const tmp    = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(gate, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

// Publish a complete file without replacing any existing mailbox. A hard link
// is atomic and fails with EEXIST even when another process wins the same ID.
function createGateFile(cwd, gate) {
  const dir = ensureGatesDir(cwd);
  const temporaryDir = fs.mkdtempSync(path.join(dir, '.create-'));
  const temporary = path.join(temporaryDir, 'gate.json');
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(gate, null, 2)}\n`, 'utf8');
    fs.linkSync(temporary, gateFile(cwd, gate.id));
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function readGateFile(cwd, id) {
  try { return JSON.parse(fs.readFileSync(gateFile(cwd, id), 'utf8')); }
  catch { return null; }
}

// ── Status ───────────────────────────────────────────────────────────────────
// Expiry is computed on read, never eagerly persisted: nobody may be watching
// when a gate lapses, so `pending + past expires_at` must still read `expired`.
function effectiveStatus(gate, nowMs) {
  if (!gate) return null;
  if (gate.status !== 'pending') return gate.status;
  if (gate.expires_at && nowMs >= gate.expires_at) return 'expired';
  return 'pending';
}

function withEffectiveStatus(gate, nowMs) {
  if (!gate) return null;
  return { ...gate, status: effectiveStatus(gate, nowMs) };
}

// ── Options ──────────────────────────────────────────────────────────────────
function normalizeOptions(options) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('gate requires at least one option');
  }
  return options.map((o, i) => {
    if (typeof o === 'string') return { key: o, label: o, description: '' };
    const key = o.key || o.value || o.label;
    if (!key) throw new Error(`option[${i}] needs a key or label`);
    return {
      key: String(key),
      label: String(o.label || key),
      description: String(o.description || ''),
    };
  });
}

function findOption(gate, key) {
  if (!key) return null;
  const k = String(key).toLowerCase();
  return (gate.options || []).find(o => o.key.toLowerCase() === k) || null;
}

// ── Open ─────────────────────────────────────────────────────────────────────
function openGate(cwd, spec) {
  spec = spec || {};
  if (!spec.question) throw new Error('gate requires a question');

  const options = normalizeOptions(spec.options);
  const now     = Date.now();

  // The default is the documented fallback used when nobody answers in time.
  // Explicit spec.default wins; otherwise the LAST option, which by convention
  // is the conservative "leave it alone" choice.
  const dflt = findOption({ options }, spec.default)
    || options[options.length - 1];

  const timeoutMs = spec.timeout_ms === null || spec.timeout_ms === 0
    ? null                                    // wait indefinitely (documented, discouraged)
    : Number(spec.timeout_ms || DEFAULT_TIMEOUT_MS);

  const gate = {
    id:         spec.id || makeGateId(new Date(now)),
    schema:     1,
    run_id:     spec.run_id  || null,
    unit_id:    spec.unit_id || null,
    origin:     spec.origin  || null,          // e.g. 'plan-gate', 'review-triage'
    cwd,
    question:   String(spec.question),
    context:    spec.context ? String(spec.context) : '',
    options,
    default:    dflt.key,
    status:     'pending',
    answer:     null,
    created_at: now,
    expires_at: timeoutMs ? now + timeoutMs : null,
  };

  for (let attempt = 0; ; attempt++) {
    try {
      createGateFile(cwd, gate);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || spec.id) throw error;
      if (attempt + 1 >= MAX_CREATE_ATTEMPTS) {
        throw Object.assign(new Error('gate-id-collision-limit'), { code: 'gate-id-collision-limit' });
      }
      gate.id = makeGateId(new Date(now));
    }
  }
  if (spec.notify !== false) notify(gate);
  return gate;
}

// ── Read ─────────────────────────────────────────────────────────────────────
function readGate(cwd, id) {
  return withEffectiveStatus(readGateFile(cwd, id), Date.now());
}

function listGates(cwd, opts) {
  opts = opts || {};
  const dir = gatesDir(cwd);
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  const out = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .map(g => withEffectiveStatus(g, now))
    // Tie-break on id: two gates opened in the same millisecond would otherwise
    // fall back to readdir order, making the listing non-deterministic.
    .sort((a, b) =>
      (a.created_at || 0) - (b.created_at || 0) ||
      String(a.id).localeCompare(String(b.id)));
  if (opts.status) return out.filter(g => g.status === opts.status);
  return out;
}

function listPending(cwd) {
  return listGates(cwd, { status: 'pending' });
}

// ── Answer ───────────────────────────────────────────────────────────────────
// First writer wins. Two responders (CLI + app) can race; whoever reads a
// `pending` gate and renames first owns the answer, and the loser is told why.
function answerGate(cwd, id, choiceKey, opts) {
  opts = opts || {};
  const raw = readGateFile(cwd, id);
  if (!raw) return { ok: false, gate: null, reason: 'not-found' };

  const status = effectiveStatus(raw, Date.now());
  if (status !== 'pending') {
    return { ok: false, gate: withEffectiveStatus(raw, Date.now()), reason: `already-${status}` };
  }

  const opt = findOption(raw, choiceKey);
  if (!opt) {
    const valid = raw.options.map(o => o.key).join(', ');
    return { ok: false, gate: withEffectiveStatus(raw, Date.now()), reason: `invalid-choice (valid: ${valid})` };
  }

  const gate = {
    ...raw,
    status: 'answered',
    answer: {
      key:    opt.key,
      label:  opt.label,
      source: opts.source || 'human',
      notes:  opts.notes ? String(opts.notes) : '',
      at:     Date.now(),
    },
  };
  writeGateFile(cwd, gate);
  return { ok: true, gate };
}

function cancelGate(cwd, id, opts) {
  opts = opts || {};
  const raw = readGateFile(cwd, id);
  if (!raw) return { ok: false, gate: null, reason: 'not-found' };

  const status = effectiveStatus(raw, Date.now());
  if (status !== 'pending') {
    return { ok: false, gate: withEffectiveStatus(raw, Date.now()), reason: `already-${status}` };
  }
  const gate = {
    ...raw,
    status: 'cancelled',
    answer: { key: null, label: null, source: 'cancelled', notes: opts.notes || '', at: Date.now() },
  };
  writeGateFile(cwd, gate);
  return { ok: true, gate };
}

// ── Wait ─────────────────────────────────────────────────────────────────────
// Synchronous sleep with no dependency and no busy-spin. Atomics.wait on a
// SharedArrayBuffer parks the thread; the orchestrator calls this through the
// CLI and genuinely needs to block.
function sleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function resolutionFrom(gate) {
  const a = gate.answer || {};
  return {
    id:     gate.id,
    status: gate.status,
    choice: a.key   || null,
    label:  a.label || null,
    source: a.source || null,
    notes:  a.notes  || '',
    gate,
  };
}

// ── Lapse resolution ─────────────────────────────────────────────────────────
// Persisting the declared default when a gate lapses is what makes the mailbox
// safe: the caller always gets an actionable choice instead of a dead end.
//
// Until now the ONLY code that did it lived inside `waitForAnswerSync`, which
// means resolution was a side effect of one process staying alive until the
// expiry moment. It does not stay alive. The real call site
// (`shared/forge-review.md`, `--open --wait --timeout 1800000`) runs inside an
// orchestrator tool call whose budget is minutes, not the gate's 30 — so the
// waiter is killed long before the gate expires and the gate is left `pending`
// forever. A later reader then sees `expired` with `answer: null`, which is
// byte-identical to a gate that was never given a window at all. That is the
// shape reported in item I-20260814111723, and the surviving artifact
// `G-20260814042121-3d46.json` shows it exactly: `expires_at - created_at` is
// the requested 1800000 to the millisecond, yet 6.4h later nothing had
// resolved it.
//
// So resolution is now a function of the FILE, callable by anyone at any later
// time — never a property of a process that has to survive.
function resolveLapsedGate(cwd, id) {
  const raw = readGateFile(cwd, id);
  if (!raw) return { ok: false, reason: 'not-found', gate: null };

  if (effectiveStatus(raw, Date.now()) !== 'expired') {
    return { ok: false, reason: 'not-lapsed', gate: withEffectiveStatus(raw, Date.now()) };
  }
  // Already carries a resolution (a waiter got there, or a previous sweep did).
  if (raw.answer) return { ok: false, reason: 'already-resolved', gate: raw };

  const opt  = findOption(raw, raw.default) || raw.options[0];
  const gate = {
    ...raw,
    status: 'expired',
    answer: {
      key: opt.key, label: opt.label,
      source: 'timeout-default', notes: '', at: Date.now(),
    },
  };
  // A human may have answered between our read and this write — never clobber.
  const current = readGateFile(cwd, id);
  if (current && current.status === 'answered') {
    return { ok: false, reason: 'answered-meanwhile', gate: current };
  }
  writeGateFile(cwd, gate);
  return { ok: true, reason: 'timeout-default', gate };
}

// Sweep every lapsed-but-unresolved gate. Reports a census rather than a bare
// count: a sweep that says nothing about what it skipped is indistinguishable
// from a sweep that examined nothing (this repo's anti-silence floor).
function resolveLapsed(cwd) {
  const all      = listGates(cwd);
  const resolved = [];
  const skipped  = [];
  for (const g of all) {
    if (g.status !== 'expired') continue;
    const r = resolveLapsedGate(cwd, g.id);
    if (r.ok) resolved.push(r.gate);
    else skipped.push({ id: g.id, reason: r.reason });
  }
  return { examined: all.length, resolved, skipped };
}

function waitForAnswerSync(cwd, id, opts) {
  opts = opts || {};
  const pollMs   = Number(opts.poll_ms || DEFAULT_POLL_MS);
  const deadline = opts.max_wait_ms ? Date.now() + Number(opts.max_wait_ms) : null;

  for (;;) {
    const raw = readGateFile(cwd, id);
    if (!raw) throw new Error(`gate not found: ${id}`);

    const status = effectiveStatus(raw, Date.now());

    if (status === 'answered' || status === 'cancelled') {
      return resolutionFrom({ ...raw, status });
    }

    if (status === 'expired') {
      // Single resolution path, shared with the `--resolve-lapsed` sweep: the
      // waiter is now one of several possible resolvers, not the only one.
      const r = resolveLapsedGate(cwd, id);
      return resolutionFrom(r.gate || raw);
    }

    if (deadline && Date.now() >= deadline) {
      return { id, status: 'pending', choice: null, label: null, source: 'wait-timeout', notes: '', gate: withEffectiveStatus(raw, Date.now()) };
    }
    sleepSync(pollMs);
  }
}

function ask(cwd, spec, opts) {
  const gate = openGate(cwd, spec);
  return waitForAnswerSync(cwd, gate.id, opts);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
function cleanupResolved(cwd, opts) {
  opts = opts || {};
  const maxAge = Number(opts.max_age_ms || RESOLVED_MAX_AGE_MS);
  const now    = Date.now();
  let removed  = 0;
  for (const g of listGates(cwd)) {
    if (g.status === 'pending') continue;
    const at = (g.answer && g.answer.at) || g.created_at || 0;
    if (now - at < maxAge) continue;
    try { fs.unlinkSync(gateFile(cwd, g.id)); removed++; } catch {}
  }
  return { removed };
}

// ── Notification ─────────────────────────────────────────────────────────────
// Best-effort and always silent-fail (MEM008): a desktop notification is a
// courtesy, never a dependency. If it fails the gate is still on disk and the
// CLI still lists it.
//
// macOS `display notification` has no inline buttons — answering happens in the
// CLI today. Inline action buttons need a native app (or terminal-notifier);
// that is exactly the upgrade path this protocol is designed to accept without
// any change here.
function notify(gate, opts) {
  opts = opts || {};
  if (process.env.FORGE_GATE_NO_NOTIFY === '1') return false;
  if (opts.dryRun || process.env.FORGE_GATE_NOTIFY_DRYRUN === '1') return true;

  const title = 'Forge precisa de você';
  const sub   = [gate.run_id, gate.unit_id].filter(Boolean).join(' · ') || 'gate';
  const body  = String(gate.question).replace(/\s+/g, ' ').slice(0, 180);

  try {
    if (process.platform === 'darwin') {
      const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `display notification "${esc(body)}" with title "${esc(title)}" subtitle "${esc(sub)}" sound name "Submarine"`;
      const child = spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true });
      child.unref();
      return true;
    }
    if (process.platform === 'linux') {
      const child = spawn('notify-send', [`${title} — ${sub}`, body], { stdio: 'ignore', detached: true });
      child.unref();
      return true;
    }
  } catch { /* silent — see above */ }
  return false;
}

// ── Rendering ────────────────────────────────────────────────────────────────
function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}min`;
  return `${(m / 60).toFixed(1)}h`;
}

function renderGate(gate, opts) {
  opts = opts || {};
  const L = [];
  const head = [gate.run_id, gate.unit_id, gate.origin].filter(Boolean).join(' · ');
  L.push(`${gate.id}${head ? `  (${head})` : ''}`);
  L.push(`  ${gate.question}`);
  if (gate.context && opts.full) {
    for (const line of String(gate.context).split('\n')) L.push(`    ${line}`);
  }
  for (const o of gate.options) {
    const mark = o.key === gate.default ? '*' : ' ';
    L.push(`   ${mark} ${o.key.padEnd(12)} ${o.label}${o.description ? ` — ${o.description}` : ''}`);
  }
  if (gate.status === 'pending') {
    const left = gate.expires_at ? fmtAge(gate.expires_at - Date.now()) : '∞';
    L.push(`  status: pendente · expira em ${left} → default "${gate.default}"`);
  } else {
    const a = gate.answer || {};
    L.push(`  status: ${gate.status} · escolha "${a.key || '—'}" (${a.source || '—'})${a.notes ? ` · ${a.notes}` : ''}`);
  }
  return L.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgv(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) o[key] = true;
      else {
        if (key === 'option') { (o.option = o.option || []).push(next); }
        else o[key] = next;
        i++;
      }
    } else o._.push(a);
  }
  return o;
}

// "key:Label:Description" → {key, label, description}
function parseOptionSpec(s) {
  const parts = String(s).split(':');
  return {
    key:         (parts[0] || '').trim(),
    label:       (parts[1] || parts[0] || '').trim(),
    description: parts.slice(2).join(':').trim(),
  };
}

function usage() {
  return [
    'forge-gate — mailbox para o Forge perguntar ao humano em runs headless',
    '',
    'Uso:',
    '  --open --question "..." --option "key:Label:Desc" [--option ...]',
    '         [--default <key>] [--timeout <ms>] [--run <id>] [--unit <id>]',
    '         [--origin <nome>] [--context "..."] [--wait] [--json] [--no-notify]',
    '  --list [--all] [--json]         lista gates (default: só pendentes)',
    '  --show <id> [--json]',
    '  --answer <id> --choice <key> [--notes "..."] [--json]',
    '  --cancel <id> [--json]',
    '  --wait <id> [--json] [--max-wait <ms>]',
    '                                  bloqueia até resposta/expiração;',
    '                                  --max-wait limita o bloqueio ao orçamento',
    '                                  de quem chama (source: wait-timeout)',
    '  --resolve-lapsed [--json]       resolve para o default declarado todo gate',
    '                                  que expirou sem ninguém para persistir o',
    '                                  lapso (não depende de waiter sobrevivente)',
    '  --cleanup [--max-age <ms>]',
    '  --demo                          abre um gate de exemplo e espera',
    '',
    'Env: FORGE_GATE_NO_NOTIFY=1 desliga notificação',
  ].join('\n');
}

// A blocking wait must be boundable to the CALLER's budget, which is routinely
// far shorter than the gate's own timeout. Without this, `--open --wait` blocks
// for the full timeout and gets killed mid-block, leaving the gate unresolved.
// Returns undefined when unset — preserving the historical block-to-expiry
// behaviour for anyone who genuinely wants it.
function maxWaitMs(a) {
  return a['max-wait'] !== undefined ? Number(a['max-wait']) : undefined;
}

function main(argv) {
  const a   = parseArgv(argv);
  const cwd = a.cwd ? path.resolve(a.cwd) : process.cwd();
  const json = !!a.json;
  const out = (obj, text) => {
    if (json) console.log(JSON.stringify(obj, null, 2));
    else console.log(text);
  };

  if (a.help || argv.length === 0) { console.log(usage()); return 0; }

  if (a.open || a.demo) {
    let spec;
    if (a.demo) {
      spec = {
        run_id: 'DEMO', unit_id: 'S02', origin: 'demo',
        question: 'A slice 2 mexe em autenticação e o plano não trata expiração de token. Como seguir?',
        context: 'Detectado pelo security gate. Nenhuma task cobre refresh/expiry.',
        options: [
          { key: 'treat', label: 'Tratar agora', description: 'Adiciona uma task de expiração antes de executar' },
          { key: 'skip',  label: 'Seguir assim', description: 'Mantém o plano como está' },
        ],
        default: 'skip',
        timeout_ms: 10 * 60 * 1000,
      };
    } else {
      if (!a.question) { console.error('forge-gate: --open requer --question'); return 2; }
      const opts = (a.option || []).map(parseOptionSpec).filter(o => o.key);
      if (!opts.length) { console.error('forge-gate: --open requer ao menos um --option "key:Label:Desc"'); return 2; }
      spec = {
        run_id: a.run || null, unit_id: a.unit || null, origin: a.origin || null,
        question: a.question, context: a.context || '',
        options: opts,
        default: a.default || null,
        timeout_ms: a.timeout !== undefined ? Number(a.timeout) : undefined,
        notify: !a['no-notify'],
      };
    }

    const gate = openGate(cwd, spec);

    if (a.wait || a.demo) {
      const capMs = maxWaitMs(a);
      if (!json) {
        console.log(renderGate(gate, { full: true }));
        console.log('');
        console.log(`  Responda com:  forge-gate answer ${gate.id} <key>`);
        console.log('  (aguardando…)');
      }
      const res = waitForAnswerSync(cwd, gate.id, { max_wait_ms: capMs });
      out(res, `\n→ ${res.status}: "${res.choice}" (${res.source})${res.notes ? ` · ${res.notes}` : ''}`);
      return res.status === 'answered' ? 0 : 0;
    }
    out(gate, renderGate(gate, { full: true }));
    return 0;
  }

  if (a.list) {
    const gates = a.all ? listGates(cwd) : listPending(cwd);
    if (json) { console.log(JSON.stringify(gates, null, 2)); return 0; }
    if (!gates.length) { console.log(a.all ? 'Nenhum gate.' : 'Nenhum gate pendente.'); return 0; }
    console.log(gates.map(g => renderGate(g)).join('\n\n'));
    return 0;
  }

  if (a.show) {
    const g = readGate(cwd, a.show);
    if (!g) { console.error(`forge-gate: gate não encontrado: ${a.show}`); return 1; }
    out(g, renderGate(g, { full: true }));
    return 0;
  }

  if (a.answer) {
    if (!a.choice) { console.error('forge-gate: --answer requer --choice <key>'); return 2; }
    const r = answerGate(cwd, a.answer, a.choice, { notes: a.notes });
    if (!r.ok) { console.error(`forge-gate: ${r.reason}`); return 1; }
    out(r.gate, `✓ ${r.gate.id} respondido: "${r.gate.answer.key}" (${r.gate.answer.label})`);
    return 0;
  }

  if (a.cancel) {
    const r = cancelGate(cwd, a.cancel, { notes: a.notes });
    if (!r.ok) { console.error(`forge-gate: ${r.reason}`); return 1; }
    out(r.gate, `✓ ${r.gate.id} cancelado`);
    return 0;
  }

  if (a['resolve-lapsed']) {
    const r = resolveLapsed(cwd);
    out(r, [
      `✓ ${r.resolved.length} gate(s) lapso(s) resolvido(s) para o default declarado`,
      `  examinados: ${r.examined} · pulados: ${r.skipped.length}`,
      ...r.skipped.map(s => `  - ${s.id}: ${s.reason}`),
      ...r.resolved.map(g => `  → ${g.id}: "${g.answer.key}" (timeout-default)`),
    ].join('\n'));
    return 0;
  }

  if (a.wait) {
    const res = waitForAnswerSync(cwd, a.wait, { max_wait_ms: maxWaitMs(a) });
    out(res, `→ ${res.status}: "${res.choice}" (${res.source})`);
    return 0;
  }

  if (a.cleanup) {
    const r = cleanupResolved(cwd, { max_age_ms: a['max-age'] ? Number(a['max-age']) : undefined });
    out(r, `✓ ${r.removed} gate(s) removido(s)`);
    return 0;
  }

  console.log(usage());
  return 0;
}

module.exports = {
  gatesDir, gateFile, makeGateId,
  openGate, readGate, listGates, listPending,
  answerGate, cancelGate,
  waitForAnswerSync, ask,
  resolveLapsedGate, resolveLapsed,
  cleanupResolved, notify, renderGate,
  DEFAULT_TIMEOUT_MS,
};

if (require.main === module) {
  try { process.exit(main(process.argv.slice(2))); }
  catch (e) { console.error(`forge-gate: ${e.message}`); process.exit(1); }
}
