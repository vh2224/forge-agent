'use strict';

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
  const provider = stage === 'iniciado' || fields.provider_called === true ? 'true' : 'false';
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
      write(line + '\n');
      state.stages.add(stage);
      if (TERMINAL.has(stage)) state.terminal = true;
      states.set(id, state);
      return true;
    } catch { return false; }
  };
}

function createStderrAnnouncer() { return createAnnouncer({ write: line => process.stderr.write(line) }); }

module.exports = { formatIdentityLine, createAnnouncer, createStderrAnnouncer };
