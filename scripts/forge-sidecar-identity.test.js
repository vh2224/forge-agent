'use strict';

const assert = require('assert');
const { formatIdentityLine, createAnnouncer } = require('./forge-sidecar-identity');

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
assert(lines[1].includes(' pid=10 provider_called=true'));

const replay = createAnnouncer({ write: value => lines.push(value) });
assert.equal(replay('reaproveitado', { ...base, dispatch_id: 'd-2' }), true);
assert.equal(replay('solicitado', { ...base, dispatch_id: 'd-2' }), false);
console.log('forge-sidecar-identity tests passed');
