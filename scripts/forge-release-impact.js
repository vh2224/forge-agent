'use strict';

const IMPACT_VERSION = 1;
const SURFACES = Object.freeze(['cli', 'schema', 'prefs', 'worker', 'receipt', 'migration', 'procedure']);
const KINDS = Object.freeze(['removal', 'new-requirement', 'meaning-change', 'compatible-addition', 'compatible-correction', 'internal']);
const KIND_BUMP = Object.freeze({
  removal: 'major', 'new-requirement': 'major', 'meaning-change': 'major',
  'compatible-addition': 'minor', 'compatible-correction': 'patch', internal: 'none',
});
const LIMITS = Object.freeze({
  max_declarations_per_commit: 16, max_ref_code_points: 160,
  max_diagnostics: 64, max_result_bytes: 131072,
});
const BUMPS = Object.freeze(['none', 'patch', 'minor', 'major']);

function parseImpact(message) {
  const declarations = [];
  const invalid = [];
  if (typeof message !== 'string') {
    return { declarations, invalid: [{ reason: 'impact-message-invalid', line_index: null }] };
  }
  let candidates = 0;
  let excess = null;
  const lines = message.split(/\r?\n/);
  for (let line_index = 1; line_index < lines.length; line_index++) {
    const line = lines[line_index];
    if (!/^forge-impact\s*:/i.test(line)) continue;
    candidates++;
    if (candidates > LIMITS.max_declarations_per_commit) {
      if (!excess) {
        excess = { reason: 'impact-declarations-exceeded', line_index, excess_count: 0 };
        invalid.push(excess);
      }
      excess.excess_count++;
      continue;
    }
    const candidate = /^Forge-Impact: ([a-z]+)\/([a-z-]+); (.+)$/.exec(line);
    const match = candidate && candidate[0].length === line.length ? candidate : null;
    // Capture empty/control refs separately so they retain their specific reason.
    const fields = match || /^Forge-Impact: ([a-z]+)\/([a-z-]+); ([\s\S]*)$/.exec(line);
    let reason = null;
    if (!fields) reason = /^Forge-Impact: [a-z]+\/[a-z-]+; ?$/.test(line)
      ? 'impact-ref-missing' : 'impact-trailer-malformed';
    else if (!SURFACES.includes(fields[1])) reason = 'impact-surface-unknown';
    else if (!KINDS.includes(fields[2])) reason = 'impact-kind-unknown';
    else if (!fields[3]) reason = 'impact-ref-missing';
    else if ([...fields[3]].length > LIMITS.max_ref_code_points) reason = 'impact-ref-too-long';
    else if (/[\u0000-\u001f\u007f]/.test(fields[3])) reason = 'impact-ref-control';
    else if (!match) reason = 'impact-trailer-malformed';
    if (reason) invalid.push({ reason, line_index });
    else declarations.push({ surface: fields[1], kind: fields[2], bump: KIND_BUMP[fields[2]], ref: fields[3] });
  }
  return { declarations, invalid };
}

function evaluateImpact(input = {}, options = {}) {
  const { commits, label_bump, head_tagged, classify } = input || {};
  // This override is a test seam only; production consumers use the fixed LIMITS.
  const limits = { ...LIMITS, ...(options && options.limits) };
  const result = {
    version: IMPACT_VERSION, status: 'consistent', required: 'none', label_bump: 'none',
    declared_commits: 0, undeclared_commits: 0, invalid_count: 0, conflict_count: 0,
    diagnostics: [], diagnostics_omitted: 0, reason: null,
  };
  if (head_tagged) {
    result.status = 'not-evaluated';
    result.reason = 'head-tagged';
  } else {
    if (!Array.isArray(commits) || !BUMPS.includes(label_bump) || typeof classify !== 'function') {
      const error = new Error('impact-input-invalid: commits, rótulo ou classificador inválido');
      error.code = 'impact-input-invalid';
      throw error;
    }
    result.label_bump = label_bump;
    const invalidDiagnostics = [];
    const conflicts = [];
    const understated = [];
    for (const commit of commits) {
      const message = typeof commit === 'string' ? commit : commit && commit.message;
      const candidateSha = commit && typeof commit === 'object' ? commit.sha : null;
      const sha = typeof candidateSha === 'string' && (candidateSha.length === 40 || candidateSha.length === 64)
        && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(candidateSha)
        ? candidateSha : null;
      const parsed = parseImpact(message);
      if (parsed.declarations.length) result.declared_commits++;
      else result.undeclared_commits++;
      result.invalid_count += parsed.invalid.length;
      for (const item of parsed.invalid) invalidDiagnostics.push({ code: 'impact-invalid', sha, ...item });
      // Only a declared message needs its individual label evaluated.
      let commitLabel = 'none';
      if (parsed.declarations.length) {
        try { commitLabel = classify(message); } catch (_) {
          const error = new Error('impact-input-invalid: classificador recusou a mensagem');
          error.code = 'impact-input-invalid';
          throw error;
        }
        if (!BUMPS.includes(commitLabel)) {
          const error = new Error('impact-input-invalid: classificador retornou rótulo inválido');
          error.code = 'impact-input-invalid';
          throw error;
        }
      }
      for (const declaration of parsed.declarations) {
        const rank = BUMPS.indexOf(declaration.bump);
        if (rank > BUMPS.indexOf(result.required)) result.required = declaration.bump;
        const detail = { sha, surface: declaration.surface, kind: declaration.kind, ref: declaration.ref,
          required: declaration.bump };
        if (rank > BUMPS.indexOf(label_bump)) {
          result.conflict_count++;
          conflicts.push({ code: 'impact-label-conflict', ...detail, label: label_bump });
        }
        if (rank > BUMPS.indexOf(commitLabel)) {
          understated.push({ code: 'commit-understated', ...detail, label: commitLabel });
        }
      }
    }
    if (result.invalid_count) result.status = 'invalid';
    else if (result.conflict_count) result.status = 'conflict';
    else if (result.undeclared_commits) result.status = 'partial';
    for (const diagnostic of invalidDiagnostics) {
      diagnostic.conflict_count = result.conflict_count;
      diagnostic.message = `Declaração inválida; conflitos no intervalo: ${result.conflict_count}`;
    }
    result.diagnostics = [...invalidDiagnostics, ...conflicts, ...understated];
    if (result.declared_commits && BUMPS.indexOf(label_bump) > BUMPS.indexOf(result.required)) {
      result.diagnostics.push({ code: 'label-exceeds-impact', required: result.required, label: label_bump });
    }
  }
  result.diagnostics_omitted = Math.max(0, result.diagnostics.length - limits.max_diagnostics);
  result.diagnostics = result.diagnostics.slice(0, limits.max_diagnostics);
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > limits.max_result_bytes) {
    if (!result.diagnostics.length) {
      const error = new Error('impact-result-too-large: envelope obrigatório excede o limite');
      error.code = 'impact-result-too-large';
      throw error;
    }
    result.diagnostics.pop();
    result.diagnostics_omitted++;
  }
  return result;
}

module.exports = { IMPACT_VERSION, SURFACES, KINDS, KIND_BUMP, LIMITS, parseImpact, evaluateImpact };
