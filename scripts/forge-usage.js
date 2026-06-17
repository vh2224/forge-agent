#!/usr/bin/env node
'use strict';

// forge-usage.js — multi-account usage dashboard.
//
// Polls every registered account's 5h/weekly windows (via the same oat01-token
// header trick as forge-usage-poll.js) and prints, per account, how much
// headroom is left — so you can see at a glance which account to launch or hand
// off to. With 3 accounts you stop guessing: the one with the lowest weekly
// utilization is the one to use next.
//
// Each account costs ~9 tokens to probe (on that account). Read-only; touches
// no state. `--json` emits machine output for the handoff selector.
//
// Usage:
//   node forge-usage.js            # human table, recommendation marked
//   node forge-usage.js --json     # [{name, five_hour, seven_day}, ...]

const path = require('path');
const { execFileSync } = require('child_process');
const { fetchUsage } = require(path.join(__dirname, 'forge-usage-poll.js'));

const ENGINE = path.join(__dirname, 'forge-accounts.js');
const JSON_OUT = process.argv.includes('--json');

function listAccounts() {
  try {
    const out = execFileSync(process.execPath, [ENGINE, '--list', '--json'],
      { encoding: 'utf8' });
    const j = JSON.parse(out);
    const arr = Array.isArray(j) ? j : (j.accounts || []);
    return arr.filter(a => a && a.name && a.has_token).map(a => a.name);
  } catch { return []; }
}

function tokenFor(name) {
  try {
    return execFileSync(process.execPath, [ENGINE, '--token', name],
      { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

function fmtReset(epoch) {
  if (!epoch) return '';
  const secs = Math.round(epoch - Date.now() / 1000);
  if (secs <= 0) return 'now';
  const dd = Math.floor(secs / 86400);
  const hh = Math.floor((secs % 86400) / 3600);
  const mm = Math.floor((secs % 3600) / 60);
  if (dd > 0) return `${dd}d${hh}h`;
  if (hh > 0) return `${hh}h${mm}m`;
  return `${mm}m`;
}

async function main() {
  const names = listAccounts();
  if (!names.length) {
    if (JSON_OUT) { process.stdout.write('[]'); return; }
    console.log('Nenhuma conta com token registrada. Use: forge-accounts add <nome>');
    return;
  }

  const rows = await Promise.all(names.map(async (name) => {
    const tok = tokenFor(name);
    if (!tok) return { name, usage: null };
    return { name, usage: await fetchUsage(tok) };
  }));

  // Sort by weekly utilization ascending — most headroom first.
  const u7 = (r) => (r.usage && r.usage.seven_day && r.usage.seven_day.used_percentage) ?? Infinity;
  rows.sort((a, b) => u7(a) - u7(b));

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(rows.map(r => ({
      name: r.name,
      five_hour: r.usage && r.usage.five_hour || null,
      seven_day: r.usage && r.usage.seven_day || null,
    }))));
    return;
  }

  const pct = (w) => (w && typeof w.used_percentage === 'number')
    ? `${Math.round(w.used_percentage)}%`.padStart(4) : '   ?';
  const reachable = rows.filter(r => u7(r) !== Infinity);
  const best = reachable.length ? reachable[0].name : null;

  console.log('conta          5h     7d     reset(7d)');
  console.log('────────────────────────────────────────');
  for (const r of rows) {
    if (!r.usage) { console.log(`${r.name.padEnd(13)} (indisponível)`); continue; }
    const w7 = r.usage.seven_day;
    const u = w7 && w7.used_percentage || 0;
    const flag = u >= 90 ? '⛔' : u >= 70 ? '⚠️ ' : '✅';
    const star = r.name === best ? '  ◀ usar esta' : '';
    console.log(
      `${r.name.padEnd(13)} ${pct(r.usage.five_hour)}  ${pct(w7)} ${flag}  ${fmtReset(w7 && w7.resets_at).padEnd(7)}${star}`
    );
  }
}

main().catch(() => { process.exitCode = 0; });
