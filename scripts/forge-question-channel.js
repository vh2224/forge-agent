#!/usr/bin/env node
'use strict';

const { plainText } = require('./forge-sidecar-identity');
const CHANNELS = Object.freeze(['claude-ask-user-question', 'codex-request-user-input-async', 'codex-request-user-input', 'text-fallback', 'worker-partial']);
const TOOLS = Object.freeze({ AskUserQuestion: CHANNELS[0], request_user_input_async: CHANNELS[1], request_user_input: CHANNELS[2] });
const RESTRICTIONS = ['plan-only', 'optional-only', 'approval-prohibited', 'not-permitted'];
function fail(code) { throw Object.assign(new Error(code), { code }); }
function waitPolicy(channel, preference = {}) {
  if (!CHANNELS.includes(channel)) fail('question-channel-invalid');
  return { action: channel === 'worker-partial' ? 'return-orchestrator'
    : ['claude-ask-user-question', 'codex-request-user-input'].includes(channel) ? 'await-native-return' : 'close-round',
  preference_source: preference.marker === 'present' ? 'personal' : 'forge-default' };
}
function selectChannel(session = {}) {
  const tools = Array.isArray(session.tools) ? session.tools : [];
  const ignored_tools = tools.filter(name => !Object.hasOwn(TOOLS, name));
  const purpose = session.purpose || 'required';
  let channel = 'text-fallback', tool = null, reason = 'no-permitted-tool';
  if (session.interactive === false) { channel = 'worker-partial'; reason = 'noninteractive'; }
  else if (!['codex', 'claude'].includes(session.host)) reason = 'unknown-host';
  else if (!['default', 'plan'].includes(session.mode)) reason = 'unknown-mode';
  else if (!['required', 'optional', 'approval'].includes(purpose)) reason = 'unknown-purpose';
  else {
    for (const name of session.host === 'claude' ? ['AskUserQuestion'] : ['request_user_input_async', 'request_user_input']) {
      if (!tools.includes(name)) continue;
      const value = session.restrictions?.[name] || [];
      const restrictions = Array.isArray(value) ? value : [value];
      if (restrictions.some(row => !RESTRICTIONS.includes(row)) || restrictions.includes('not-permitted')
          || restrictions.includes('plan-only') && session.mode !== 'plan'
          || restrictions.includes('optional-only') && purpose !== 'optional'
          || restrictions.includes('approval-prohibited') && purpose === 'approval') continue;
      tool = name; channel = TOOLS[name]; reason = 'exposed-permitted'; break;
    }
  }
  return { channel, tool, reason, ignored_tools, wait_policy: waitPolicy(channel, session.preference) };
}
function presentationId(id) {
  if (typeof id !== 'string' || require('./forge-attempt-telemetry').code(id) !== id) fail('decision-id-invalid');
  return `q_${Buffer.from(id, 'utf8').toString('hex')}`;
}
presentationId.decode = value => {
  if (typeof value !== 'string' || !/^q_(?:[a-f0-9]{2})+$/.test(value)) fail('decision-id-invalid');
  const id = Buffer.from(value.slice(2), 'hex').toString('utf8');
  if (presentationId(id) !== value) fail('decision-id-invalid');
  return id;
};
function decisionText(value, limit) {
  if (typeof value !== 'string') fail('decision-text-invalid');
  const text = plainText(value, { missing: '', limit: Math.max(limit + 1, value.length + 1) });
  if (!text || Array.from(text).length > limit) fail('decision-text-invalid');
  return text;
}
function normalizeDecision(decision, channel = 'text-fallback') {
  if (!CHANNELS.includes(channel) || !decision || typeof decision !== 'object' || Array.isArray(decision)) fail('decision-invalid');
  if (decision.multiSelect !== undefined && decision.multiSelect !== false) fail('decision-multiselect-sequential-required');
  presentationId(decision.id);
  const header = decisionText(decision.header, 12), question = decisionText(decision.question, 240);
  const options = decision.options === undefined ? [] : decision.options;
  if (!Array.isArray(options)) fail('decision-options-invalid');
  const max = ['codex-request-user-input', 'codex-request-user-input-async'].includes(channel) ? 3 : 4;
  if (options.length > max) fail('decision-options-regroup-required');
  if (options.length < 2 && !(channel === 'text-fallback' && options.length === 0)) fail('decision-options-required');
  let rows = options.map(option => ({ label: decisionText(option?.label, 80), description: decisionText(option?.description, 240) }));
  if (new Set(rows.map(row => row.label)).size !== rows.length || rows.some(row => /^(?:other|outro)$/i.test(row.label))) fail('decision-options-invalid');
  if (decision.recommended !== undefined) {
    const label = decisionText(decision.recommended, 80), index = rows.findIndex(row => row.label === label);
    if (index < 0) fail('decision-recommendation-invalid');
    const [recommended] = rows.splice(index, 1); rows = [{ ...recommended, label: `${recommended.label} (Recomendado)` }, ...rows];
  }
  return { id: decision.id, header, question, options: rows };
}
function presentDecision(decision, channel = 'text-fallback') {
  const normalized = normalizeDecision(decision, channel);
  if (channel === 'worker-partial') return { channel, status: 'partial', questions: [{ id: normalized.id, question: normalized.question }], pending: true };
  if (channel === 'codex-request-user-input-async') return { channel, schema: 'host-exposed', decision: normalized, handle_is_answer: false };
  if (channel === 'text-fallback') return { channel, message: [`Decisão ${normalized.id}: ${normalized.question}`,
    ...normalized.options.map((row, index) => `${index + 1}. ${row.label}: ${row.description}`),
    'Sem resposta explícita, a decisão continua pendente.'].join('\n') };
  const row = channel === 'claude-ask-user-question'
    ? { question: normalized.question, header: normalized.header, multiSelect: false, options: normalized.options }
    : { id: presentationId(normalized.id), header: normalized.header, question: normalized.question, options: normalized.options };
  return { channel, payload: { questions: [row] } };
}
function afterPresentation(channel, result = {}, preference = {}) {
  const policy = waitPolicy(channel, preference);
  const answered = result.outcome === 'answered' && result.explicit === true && result.accepted !== true && typeof result.answer === 'string' && !!result.answer.trim();
  return { action: answered ? 'record-answer' : 'close-round', pending: !answered, preference_source: policy.preference_source };
}
function inspectQuestionPreference(options = {}) {
  const fs = require('fs'), path = require('path');
  const { readBoundedStableFile } = require('./forge-autonomy-sources');
  const { digest } = require('./forge-code-roots');
  const homes = require('./forge-home').resolveForgePaths(options).runtimeHomes;
  const report = { writes: 0 };
  for (const host of options.runtimes || ['codex', 'claude']) {
    if (!['codex', 'claude'].includes(host)) fail('question-preference-host-invalid');
    const name = host === 'codex' ? 'AGENTS.md' : 'CLAUDE.md', file = path.join(homes[host], name);
    const row = { source: `<${host}-home>/${name}`, state: 'present', marker: 'absent', sha256: null }; report[host] = row;
    try {
      let cursor = file;
      for (;;) {
        if (fs.lstatSync(cursor).isSymbolicLink()) fail('question-preference-link');
        const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
      }
      const real = fs.realpathSync.native(file), read = readBoundedStableFile(file, 1024 * 1024, { expectedReal: real });
      if (read.error) { row.state = read.error === 'source_too_large' ? 'oversize' : 'unreadable'; continue; }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(read.buffer); } catch { row.state = 'invalid'; continue; }
      const start = '<!-- user:async-question-lifetime:start -->', end = '<!-- user:async-question-lifetime:end -->';
      const starts = text.split(start).length - 1, ends = text.split(end).length - 1;
      if (!starts && !ends && !text.includes('<!-- user:async-question-lifetime:')) continue;
      const markers = text.match(/<!-- user:async-question-lifetime:[^\r\n]*?-->/g) || [];
      if (starts !== 1 || ends !== 1 || markers.length !== 2 || text.indexOf(start) >= text.indexOf(end)) { row.marker = 'malformed'; continue; }
      row.marker = 'present'; row.sha256 = digest(Buffer.from(text.slice(text.indexOf(start), text.indexOf(end) + end.length)));
    } catch (error) { row.state = error.code === 'ENOENT' ? 'absent' : 'unreadable'; }
  }
  return report;
}
function main(argv = process.argv.slice(2), io = process) {
  const session = { tools: [], restrictions: {} }, options = {}; let action, json = false, channel, file;
  try {
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i];
      if (['--select', '--present', '--preference'].includes(flag)) { if (action) fail('question-channel-usage'); action = flag; }
      else if (flag === '--json') json = true;
      else if (flag === '--noninteractive') session.interactive = false;
      else {
        if (!['--host', '--mode', '--purpose', '--tool', '--restrict', '--channel', '--decision', '--codex-home', '--claude-home'].includes(flag)
            || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('question-channel-usage');
        const value = argv[++i];
        if (flag === '--tool') session.tools.push(value);
        else if (flag === '--restrict') { const [tool, restriction, extra] = value.split(':'); if (extra || !RESTRICTIONS.includes(restriction)) fail('question-channel-usage'); (session.restrictions[tool] ||= []).push(restriction); }
        else if (flag === '--channel') channel = value;
        else if (flag === '--decision') file = value;
        else if (flag.endsWith('-home')) options[flag === '--codex-home' ? 'codexHome' : 'claudeHome'] = value;
        else session[flag.slice(2)] = value;
      }
    }
    let result;
    if (action === '--select') result = selectChannel(session);
    else if (action === '--preference') result = inspectQuestionPreference(options);
    else if (action === '--present' && file && channel) {
      const fs = require('fs'), read = require('./forge-autonomy-sources').readBoundedStableFile(file, 256 * 1024, { expectedReal: fs.realpathSync.native(file) });
      if (fs.lstatSync(file).isSymbolicLink() || read.error) fail('decision-file-invalid');
      result = presentDecision(JSON.parse(read.buffer.toString('utf8')), channel);
    } else fail('question-channel-usage');
    io.stdout.write(json ? `${JSON.stringify(result)}\n` : `Canal de decisão: ${JSON.stringify(result)}\n`); return 0;
  } catch (error) { io.stderr.write(`Pergunta recusada: ${error.code || 'question-channel-invalid'}\n`); return 2; }
}
module.exports = { CHANNELS, selectChannel, normalizeDecision, presentDecision, presentationId, waitPolicy, afterPresentation, inspectQuestionPreference, main };
if (require.main === module) process.exitCode = main();
