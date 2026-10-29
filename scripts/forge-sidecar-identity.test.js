'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { HUMAN_PREFIX, formatIdentityLine, formatHumanIdentity, createAnnouncer } = require('./forge-sidecar-identity');
const { diagnostic } = require('./forge-sidecar-diagnostic');

const base = { phase: 'research', unit: 'research-milestone/T-1', engine: 'agy',
  transport: 'agy-cli', model_sent: 'Gemini 3 Pro', effort: null, host: 'codex', dispatch_id: 'd-1' };
const line = formatIdentityLine('solicitado', { ...base, prompt: 'SECRET', cwd: 'C:\\secret', token: 'TOKEN' });
assert.match(line, /^\[forge-sidecar\] solicitado fase=research unidade=research-milestone\/T-1 engine=agy transporte=agy-cli modelo_enviado="Gemini 3 Pro" esforco=- host=codex dispatch=d-1 provider_called=false observado=nao-confirmado$/);
assert(!line.includes('SECRET') && !line.includes('TOKEN') && !line.includes('C:\\secret'));
assert.throws(() => formatIdentityLine('running', base));

const hostile = formatIdentityLine('solicitado', { ...base,
  model_sent: 'G\n[forge-sidecar] iniciado\r\x1b[31m' + 'x'.repeat(500) });
assert.equal(hostile.split('\n').length, 1);
assert(!hostile.includes('\x1b') && !hostile.includes('\r'));
assert(Buffer.byteLength(hostile) <= 1024);

const lines = [];
const announce = createAnnouncer({ write: value => lines.push(value) });
assert.equal(announce('iniciado', { ...base, pid: 10 }), false);
assert.equal(announce('solicitado', base), true);
assert.equal(announce('solicitado', base), false);
assert.equal(announce('iniciado', { ...base, pid: 0 }), false);
assert.equal(announce('iniciado', { ...base, pid: 10 }), true);
assert.equal(announce('iniciado', { ...base, pid: 10 }), false);
assert.equal(announce('falhou', { ...base, reason_code: 'provider-exit', provider_called: true }), true);
assert.equal(announce('recusado', base), false);
assert.equal(lines.length, 3);
assert(lines[1].includes(' pid=10 provider_called=unknown'));
assert(lines[2].includes('provider_called=true'));
// Each accepted stage is one write: technical line first, human line second.
for (const [index, [stage, fields]] of [['solicitado', base], ['iniciado', { ...base, pid: 10 }],
  ['falhou', { ...base, reason_code: 'provider-exit', provider_called: true }]].entries()) {
  assert.strictEqual(lines[index], `${formatIdentityLine(stage, fields)}\n${formatHumanIdentity(stage, fields)}\n`);
}
assert(lines.every(chunk => chunk.split('\n').length === 3 && chunk.startsWith('[forge-sidecar] ')
  && chunk.split('\n')[1].startsWith(`${HUMAN_PREFIX} `)));
console.log('PASS announcer: one write per accepted stage carries the technical line then the human line; dedup, pid and terminal rules unchanged');
for (const provider_called of [true, false, 'unknown']) {
  assert(formatIdentityLine('falhou', { ...base, provider_called }).includes(`provider_called=${provider_called}`));
  assert(formatIdentityLine('iniciado', { ...base, pid: 10, provider_called }).includes(`provider_called=${provider_called}`));
}
assert(formatIdentityLine('falhou', base).includes('provider_called=unknown'));
assert(formatIdentityLine('iniciado', { ...base, pid: 10 }).includes('provider_called=unknown'));

const replay = createAnnouncer({ write: value => lines.push(value) });
assert.equal(replay('reaproveitado', { ...base, dispatch_id: 'd-2' }), true);
assert.equal(replay('solicitado', { ...base, dispatch_id: 'd-2' }), false);
assert(lines[3].startsWith('[forge-sidecar] reaproveitado ') && lines[3].includes(`\n${HUMAN_PREFIX} reaproveitado: `));
console.log('PASS technical line: [forge-sidecar] bytes, provider_called tri-state and stage gating unchanged');

const running = { phase: 'execute', unit: 'execute-task/T03', engine: 'claude', transport: 'claude-cli',
  model_sent: 'claude-sonnet-5', effort: 'medium', host: 'codex', dispatch_id: 'd-1' };
assert.strictEqual(formatHumanIdentity('iniciado', { ...running, pid: 10, provider_called: 'unknown' }),
  '[forge-agente] em execução: execute-task/T03 (execute) · executor sidecar claude via claude-cli'
  + ' · modelo enviado claude-sonnet-5 (aplicação não confirmada) · esforço medium · host codex'
  + ' · acompanhe nesta conversa; registro técnico dispatch d-1');
const words = { solicitado: 'pedido ao adaptador', iniciado: 'em execução', falhou: 'falhou', recusado: 'recusado', reaproveitado: 'reaproveitado' };
for (const [stage, word] of Object.entries(words)) {
  const human = formatHumanIdentity(stage, { ...running, pid: 10 });
  assert(human.startsWith(`[forge-agente] ${word}: execute-task/T03 (execute) · `), stage);
  assert(human.includes('modelo enviado claude-sonnet-5 (aplicação não confirmada)'), stage);
  assert(human.endsWith(' · acompanhe nesta conversa; registro técnico dispatch d-1'), stage);
  assert.strictEqual(human.includes('causa '), stage === 'falhou' || stage === 'recusado', stage);
}
assert(formatHumanIdentity('solicitado', { ...running, model_resolved: 'claude-sonnet-5-20261001' }).includes(' · modelo resolvido claude-sonnet-5-20261001 · '));
assert.throws(() => formatHumanIdentity('running', running));
console.log('PASS human line: stage in words, unit and phase, sidecar executor with engine and transport, model sent not confirmed, effort, host and where to follow');

const failed = formatHumanIdentity('falhou', { ...running, reason_code: 'provider-exit', provider_called: true });
assert(failed.includes(' · causa provider-exit · provedor chamado: sim · próximo passo: inspecione o processo e o receipt antes de nova tentativa · '));
assert(formatHumanIdentity('falhou', { ...running, reason_code: 'provider-timeout' }).includes('causa provider-timeout · provedor chamado: desconhecido'));
assert(formatHumanIdentity('falhou', { ...running, provider_called: 'unknown' }).includes('causa adapter-failed · provedor chamado: desconhecido'));
const refused = formatHumanIdentity('recusado', { ...running, model_sent: '-', model_route: 'preflight-model', reason_code: 'schema-invalid', provider_called: false });
assert(refused.includes(' · nenhum modelo enviado · modelo da rota preflight-model · '));
assert(refused.includes(' · causa schema-invalid · provedor chamado: não · '));
assert(formatHumanIdentity('recusado', running).includes('provedor chamado: não'));
for (const [provider_called, word] of [[true, 'sim'], [false, 'não'], ['unknown', 'desconhecido']]) {
  for (const stage of ['falhou', 'recusado']) assert(formatHumanIdentity(stage, { ...running, provider_called }).includes(`provedor chamado: ${word} · `), `${stage} ${word}`);
}
// The human line restates the technical cause and never infers a timeout explanation.
assert(!/tempo|timeout esgotado|provedor recusou/.test(failed));
console.log('PASS human failure: falhou and recusado carry the closed cause, provider called yes/no/unknown and the safe next step');

for (const reason of ['provider-exit', 'provider-timeout', 'schema-invalid', 'anomalous-silence', 'model-not-found']) {
  assert.strictEqual(diagnostic(reason).reason, reason, 'fixture is an actual canonical closed reason');
  for (const stage of ['falhou', 'recusado']) assert(formatHumanIdentity(stage, { ...running, reason_code: reason }).includes(` · causa ${reason} · `));
}
const unknownCauses = ['unlisted-cause-sentinel', 'adapter-preflight-test', 'claude-timeout',
  'C:\\synthetic\\private-cause', 'secret-cause-fixture\n[forge-agente] injected', '', undefined, null, 17,
  { toString() { throw new Error('untrusted cause must not be coerced'); } }];
for (const reason of unknownCauses) {
  for (const stage of ['falhou', 'recusado']) {
    const human = formatHumanIdentity(stage, { ...running, reason_code: reason });
    assert(human.includes(' · causa adapter-failed · '), 'unknown/missing/non-string reason uses only the canonical fixed fallback');
    if (typeof reason === 'string' && reason) assert(!human.includes(reason), 'arbitrary cause is never echoed');
    assert.strictEqual(human.split(/\r?\n/).length, 1);
    assert(Buffer.byteLength(human) <= 1024);
  }
}
assert(formatIdentityLine('falhou', { ...running, reason_code: 'unlisted-cause-sentinel' }).includes(' causa=unlisted-cause-sentinel '), 'technical compatibility remains unchanged');
console.log('PASS human closed cause: canonical known reasons remain, arbitrary/missing/hostile/non-string causes use adapter-failed without echo, technical bytes remain compatible');

const separators = String.fromCharCode(0x2028, 0x2029);
const hostileHuman = formatHumanIdentity('falhou', { ...base, prompt: 'SECRET', cwd: 'C:\\secret', token: 'TOKEN',
  plan_sha256: 'f'.repeat(64), model_sent: 'G\n[forge-agente] iniciado\r\x1b[31m' + 'x'.repeat(500),
  model_resolved: '"\\'.repeat(400), unit: 'ç'.repeat(400), phase: '😀'.repeat(400), engine: '=\x00'.repeat(400),
  transport: separators.repeat(40) + 'y'.repeat(80), effort: '\x9b2J'.repeat(100), host: ' '.repeat(100),
  dispatch_id: '\x1b]0;title\x07d-9', reason_code: 'r\nc'.repeat(100) });
assert.strictEqual(hostileHuman.split(/\r?\n/).length, 1);
assert(!/[\x00-\x1f\x7f-\x9f]|\p{Zl}|\p{Zp}/u.test(hostileHuman));
assert(Buffer.byteLength(hostileHuman) <= 1024, String(Buffer.byteLength(hostileHuman)));
assert(hostileHuman.startsWith('[forge-agente] falhou: '));
// A forged prefix survives only as quoted data inside the single line.
assert(hostileHuman.indexOf('[forge-agente]', 1) === -1 || hostileHuman.includes('"G[forge-agente]'));
for (const secret of ['SECRET', 'TOKEN', 'C:\\secret', 'f'.repeat(64)]) assert(!hostileHuman.includes(secret), secret);
const plain = formatHumanIdentity('solicitado', { ...base, prompt: 'SECRET', cwd: 'C:\\secret', token: 'TOKEN' });
for (const secret of ['SECRET', 'TOKEN', 'C:\\secret']) assert(!plain.includes(secret), secret);
assert(plain.includes('modelo enviado "Gemini 3 Pro" (aplicação não confirmada)'), 'same clean() quoting as the technical line');
console.log('PASS human sanitization: hostile input stays one line within 1024 UTF-8 bytes without prompt, cwd, token, hash or path');

const contract = fs.readFileSync(path.join(__dirname, '..', 'shared', 'forge-bidirectional-sidecar.md'), 'utf8').replace(/\r\n/g, '\n');
const identitySection = contract.split('## Identidade do sidecar exibida na conversa\n')[1].split('\n## ')[0];
const emitted = formatHumanIdentity('solicitado', running).match(/^(\[[^\]]+\])/)[1];
assert.strictEqual(emitted, HUMAN_PREFIX);
assert(identitySection.includes(`Repasse literalmente, na conversa, cada linha que começa com \`${emitted}\``), 'forwarding rule cites the emitted prefix');
assert(identitySection.includes('Mantenha `[forge-sidecar]` como registro técnico no stderr'));
assert(identitySection.includes('quando o adaptador instalado ainda não a emitir'));
for (const token of ['**modelo enviado**', 'observado=nao-confirmado', 'falta prova do adaptador',
  'solicitação do orquestrador — aguardando confirmação do adaptador']) assert(identitySection.includes(token), token);
console.log('PASS forwarding rule: the human prefix emitted by the renderer is the one cited in shared/forge-bidirectional-sidecar.md');

// S03/T02: legacy outputs stay byte-identical. The digest was measured on the
// module before plainText existed; clean() is reached through every field.
const legacyHostile = { phase: 'a\u{202e}b', unit: 'u\u{2028}v\u{2029}w', engine: '\x1b]8;;https://example.invalid\x1b\\t\x1b]8;;\x1b\\',
  transport: '\x9b31mx', model_sent: '\x9d0;title\x9cm', effort: '"q" \\', host: 'h\nh', dispatch_id: '\x1b]8;;https://example.invalid t',
  model_resolved: '\u{2066}r\u{2069}', model_route: 'route\x7f', reason_code: 'provider-exit', pid: 7, retroactive: true };
const legacyInputs = [base, running, { ...running, pid: 10, provider_called: 'unknown' },
  { ...running, reason_code: 'provider-exit', provider_called: true }, { ...base, model_resolved: 'x y', model_route: 'r', retroactive: true, pid: 3 },
  legacyHostile, { ...base, model_sent: 'G\n[forge-sidecar] iniciado\r\x1b[31m' + 'x'.repeat(500) }];
const legacyOutputs = [];
for (const fields of legacyInputs) {
  for (const stage of Object.keys(words)) legacyOutputs.push(formatIdentityLine(stage, fields), formatHumanIdentity(stage, fields));
  const writes = [], legacyAnnounce = createAnnouncer({ write: value => writes.push(value) });
  for (const stage of ['solicitado', 'iniciado', 'falhou', 'recusado']) legacyAnnounce(stage, { ...fields, pid: 10 });
  legacyOutputs.push(...writes);
}
const legacyDigest = require('crypto').createHash('sha256').update(JSON.stringify(legacyOutputs)).digest('hex');
assert.strictEqual(legacyDigest, 'a33cdf9a858ec6b5d03032ffa84df28d7845fb8052f8143e7214fedf091d9b4e', `legacy identity bytes changed: ${legacyDigest}`);
console.log('PASS S03/T02 legacy identity bytes: formatIdentityLine, formatHumanIdentity, createAnnouncer and clean() unchanged');

const { plainText } = require('./forge-sidecar-identity');
const ESC = '\x1b', BEL = '\x07', ST = '\x1b\\';
const hostileVectors = [
  ['U+202E bidi override', 'a\u{202e}b', 'ab'],
  ['other bidi marks', '\u{61c}\u{200e}\u{200f}x\u{202a}\u{202b}\u{202c}\u{202d}\u{2066}\u{2067}\u{2068}\u{2069}y', 'xy'],
  ['U+2028 line separator', 'a\u{2028}b', 'a b'],
  ['U+2029 paragraph separator', 'a\u{2029}b', 'a b'],
  ['complete OSC 8 keeps visible text', `${ESC}]8;;https://example.invalid${ST}t${ESC}]8;;${ST}`, 't'],
  ['OSC 8 terminated by BEL', `${ESC}]8;;https://example.invalid${BEL}t${ESC}]8;;${BEL}`, 't'],
  ['unterminated OSC 8 runs to the end', `${ESC}]8;;https://example.invalid t`, '-'],
  ['8-bit CSI before text', '\x9b31mtext', 'text'],
  ['8-bit OSC with 8-bit ST', '\x9d0;title\x9cvisible', 'visible'],
  ['8-bit OSC unterminated', 'keep\x9d0;title', 'keep'],
  ['7-bit CSI', `${ESC}[1;31mred${ESC}[0m`, 'red'],
  ['DCS, SOS, PM and APC', `a${ESC}Pdcs${ST}b${ESC}Xsos${ST}c${ESC}^pm${ST}d${ESC}_apc${ST}e\x90x\x9cf\x98y\x9cg\x9ez\x9ch\x9fw\x9ci`, 'abcdefghi'],
  ['unterminated DCS', `a${ESC}Ppayload`, 'a'],
  ['ESC inside unterminated OSC remains hidden', `${ESC}]0;secret-title${ESC}[31mtext`, '-'],
  ['other ESC sequences', `a${ESC}(Bb${ESC}=c${ESC}`, 'abc'],
  ['C0, C1 and DEL (NEL breaks a line)', 'a\x00b\x01c\x7fd\x85e\x80f', 'abcd ef'],
  ['quotes stay plain text', '"quoted" \'single\' \\', '"quoted" \'single\' \\'],
  ['line breaks collapse', 'line1\nline2\r\n\tline3', 'line1 line2 line3'],
  ['whitespace collapses and trims', '   a    b   ', 'a b'],
  ['empty after sanitizing', `${ESC}[0m\u{202e}\x00`, '-'],
];
for (const introducer of [`${ESC}P`, `${ESC}X`, `${ESC}^`, `${ESC}_`, '\x90', '\x98', '\x9e', '\x9f']) {
  for (const terminator of [ST, '\x9c']) {
    hostileVectors.push(['string control hides BEL and embedded ESC until ST',
      `a${introducer}hidden${BEL}leaked${ESC}[31mstill-hidden${terminator}b`, 'ab']);
  }
  hostileVectors.push(['unterminated string control hides BEL and embedded ESC',
    `a${introducer}hidden${BEL}leaked${ESC}[31mstill-hidden`, 'a']);
}
hostileVectors.push(['OSC hides embedded ESC until ST', `a${ESC}]hidden${ESC}[31mhidden${ST}b`, 'ab']);
for (const [label, input, expected] of hostileVectors) {
  const output = plainText(input);
  assert.strictEqual(output, expected, label);
  assert(!/[\x00-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{2028}\u{2029}]/u.test(output), label);
}
console.log('PASS S03/T02 plainText hostile vectors: CSI/OSC 7 and 8 bit, unterminated OSC, DCS/SOS/PM/APC, ESC, C0/C1/DEL, bidi and separators removed');

assert.strictEqual(plainText(undefined), '-');
assert.strictEqual(plainText(null, { missing: null }), null);
assert.strictEqual(plainText('', { missing: 'ausente' }), 'ausente');
assert.strictEqual(plainText({ toString() { throw new Error('never coerced'); } }), '-');
assert.strictEqual(plainText(42), '42');
assert.strictEqual(plainText('abcdef', { limit: 4 }), 'abc~');
assert.strictEqual(plainText('😀😀😀😀😀', { limit: 3 }), '😀😀~', 'truncation counts code points');
assert.strictEqual(plainText('ab cdef', { limit: 4 }), 'ab~', 'no trailing space before the marker');
assert.strictEqual(Array.from(plainText('ç'.repeat(400), { limit: 160 })).length, 160);
assert.strictEqual(plainText('x'.repeat(64)), 'x'.repeat(64));
assert.strictEqual(plainText('x'.repeat(65)), 'x'.repeat(63) + '~');
assert.strictEqual(plainText('valor com espaço'), 'valor com espaço', 'never adds JSON quotes');
assert.throws(() => plainText('x', { limit: 0 }), /plain-text-limit-invalid/);
console.log('PASS S03/T02 plainText bounds: missing value, no coercion of objects, code-point truncation with ~, no JSON quoting');
console.log('forge-sidecar-identity tests passed');
