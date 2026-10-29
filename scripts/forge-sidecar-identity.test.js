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
console.log('forge-sidecar-identity tests passed');
