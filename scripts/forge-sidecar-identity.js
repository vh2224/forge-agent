'use strict';

const { diagnostic } = require('./forge-sidecar-diagnostic');

const STAGES = new Set(['solicitado', 'iniciado', 'recusado', 'falhou', 'reaproveitado']);
const TERMINAL = new Set(['recusado', 'falhou', 'reaproveitado']);

function clean(value, missing = '-', limit = 64) {
  if (value === undefined || value === null || value === '') return missing;
  const safe = String(value)
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|.)/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '');
  if (!safe) return missing;
  const bounded = safe.length > limit ? `${safe.slice(0, limit - 1)}~` : safe;
  return /[\s="\\]/.test(bounded) ? JSON.stringify(bounded) : bounded;
}

function formatIdentityLine(stage, fields = {}) {
  if (!STAGES.has(stage)) throw new Error(`unknown sidecar identity stage: ${stage}`);
  const values = {
    fase: clean(fields.phase), unidade: clean(fields.unit), engine: clean(fields.engine),
    transporte: clean(fields.transport), modelo_enviado: clean(fields.model_sent, 'ausente', 256),
    esforco: clean(fields.effort), host: clean(fields.host), dispatch: clean(fields.dispatch_id),
  };
  const optional = [];
  if (stage !== 'recusado' && fields.model_resolved !== undefined && clean(fields.model_resolved, '-', 256) !== values.modelo_enviado) {
    optional.push(['modelo_resolvido', clean(fields.model_resolved, '-', 256)]);
  }
  if (stage === 'recusado' && fields.model_route !== undefined) optional.push(['modelo_rota', clean(fields.model_route, '-', 256)]);
  if (Number.isInteger(fields.pid) && fields.pid > 0) optional.push(['pid', clean(fields.pid)]);
  if (fields.retroactive === true) optional.push(['retroativo', 'sim']);
  if (fields.reason_code !== undefined) optional.push(['causa', clean(fields.reason_code)]);
  // A local pid proves process creation only. Keep remote call evidence separate.
  const provider = typeof fields.provider_called === 'boolean' ? String(fields.provider_called)
    : ['solicitado', 'recusado', 'reaproveitado'].includes(stage) && fields.provider_called === undefined ? 'false' : 'unknown';
  const render = () => `[forge-sidecar] ${stage} fase=${values.fase} unidade=${values.unidade} engine=${values.engine}`
    + ` transporte=${values.transporte} modelo_enviado=${values.modelo_enviado}`
    + optional.map(([key, value]) => ['modelo_resolvido', 'modelo_rota'].includes(key) ? ` ${key}=${value}` : '').join('')
    + ` esforco=${values.esforco} host=${values.host} dispatch=${values.dispatch}`
    + optional.filter(([key]) => !['modelo_resolvido', 'modelo_rota'].includes(key)).map(([key, value]) => ` ${key}=${value}`).join('')
    + ` provider_called=${provider} observado=nao-confirmado`;
  // Values are bounded separately. Preserve the complete quoted value syntax
  // when the aggregate exceeds the presentation target.
  return render();
}

const HUMAN_PREFIX = '[forge-agente]';
const HUMAN_STAGES = { solicitado: 'pedido ao adaptador', iniciado: 'em execução', falhou: 'falhou',
  recusado: 'recusado', reaproveitado: 'reaproveitado' };
const HUMAN_MAX_BYTES = 1024;
const PROVIDER_WORDS = { true: 'sim', false: 'não', unknown: 'desconhecido' };

// Human companion of formatIdentityLine: same accepted fields and sanitizer,
// one pt-BR line. It restates the technical evidence and never upgrades it.
function formatHumanIdentity(stage, fields = {}) {
  if (!STAGES.has(stage)) throw new Error(`unknown sidecar identity stage: ${stage}`);
  const render = (limit, modelLimit) => {
    // Same clean() as the technical line; Unicode line and paragraph
    // separators are also dropped so chat renderers keep one line.
    const value = (field, missing = '-', bound = limit) => clean(typeof field === 'string'
      ? field.replace(/\p{Zl}|\p{Zp}/gu, '') : field, missing, bound);
    const sent = value(fields.model_sent, '-', modelLimit);
    const parts = [`${HUMAN_PREFIX} ${HUMAN_STAGES[stage]}: ${value(fields.unit)} (${value(fields.phase)})`,
      `executor sidecar ${value(fields.engine)} via ${value(fields.transport)}`,
      sent === '-' ? 'nenhum modelo enviado' : `modelo enviado ${sent} (aplicação não confirmada)`];
    if (stage !== 'recusado' && fields.model_resolved !== undefined && value(fields.model_resolved, '-', modelLimit) !== sent) {
      parts.push(`modelo resolvido ${value(fields.model_resolved, '-', modelLimit)}`);
    }
    if (stage === 'recusado' && fields.model_route !== undefined) parts.push(`modelo da rota ${value(fields.model_route, '-', modelLimit)}`);
    parts.push(`esforço ${value(fields.effort)}`, `host ${value(fields.host)}`);
    if (fields.retroactive === true) parts.push('anúncio retroativo');
    if (stage === 'falhou' || stage === 'recusado') {
      const provider = typeof fields.provider_called === 'boolean' ? String(fields.provider_called)
        : stage === 'recusado' && fields.provider_called === undefined ? 'false' : 'unknown';
      // Reuse the canonical closed diagnostic vocabulary. Unknown input must
      // not become human-facing prose or imply an observed provider cause.
      const cause = diagnostic(typeof fields.reason_code === 'string' ? fields.reason_code : undefined).reason;
      parts.push(`causa ${value(cause)}`, `provedor chamado: ${PROVIDER_WORDS[provider]}`,
        'próximo passo: inspecione o processo e o receipt antes de nova tentativa');
    }
    parts.push(`acompanhe nesta conversa; registro técnico dispatch ${value(fields.dispatch_id)}`);
    return parts.join(' · ');
  };
  // Hostile values are already one line; shrink value bounds so the whole
  // line stays within the presentation limit without splitting a value.
  for (const [limit, modelLimit] of [[64, 256], [32, 64], [12, 16]]) {
    const line = render(limit, modelLimit);
    if (Buffer.byteLength(line) <= HUMAN_MAX_BYTES) return line;
  }
  return render(4, 4);
}

function createAnnouncer({ write } = {}) {
  const states = new Map();
  return (stage, fields = {}) => {
    if (!STAGES.has(stage)) throw new Error(`unknown sidecar identity stage: ${stage}`);
    try {
      const id = String(fields.dispatch_id || '-');
      const state = states.get(id) || { stages: new Set(), terminal: false };
      if (state.stages.has(stage) || state.terminal || (TERMINAL.has(stage) && state.terminal)
        || (stage === 'iniciado' && (!state.stages.has('solicitado') || !Number.isInteger(fields.pid) || fields.pid <= 0))) return false;
      const line = formatIdentityLine(stage, fields);
      // One write per accepted stage keeps the technical line first for
      // positional readers; the human line follows in the same chunk.
      write(line + '\n' + formatHumanIdentity(stage, fields) + '\n');
      state.stages.add(stage);
      if (TERMINAL.has(stage)) state.terminal = true;
      states.set(id, state);
      return true;
    } catch { return false; }
  };
}

function createStderrAnnouncer() { return createAnnouncer({ write: line => process.stderr.write(line) }); }

module.exports = { HUMAN_PREFIX, formatIdentityLine, formatHumanIdentity, createAnnouncer, createStderrAnnouncer };
