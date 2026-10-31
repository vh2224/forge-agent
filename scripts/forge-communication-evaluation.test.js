#!/usr/bin/env node
'use strict';

// Read-only offline corpus validation. Renderers are called in memory; no host,
// provider, question tool, installer or controller is invoked by this suite.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const identity = require('./forge-sidecar-identity');
const recovery = require('./forge-recovery-diagnostic');
const delivery = require('./forge-delivery');

const ROOT = path.resolve(__dirname, '..');
const CONTRACT = 'shared/forge-communication.md';
const ARCHIVE = 'docs/communication-evaluation/skill-templates-before.md';
const LABELS = ['observado', 'renderizado-offline', 'modelo-da-skill', 'redigido'];
const ELEMENTS = ['resultado', 'fase', 'executor', 'proximo_passo', 'decisao_pendente'];
const VALUES = ['presente', 'ausente', 'desconhecido', 'nao-aplicavel'];
const HOSTS = ['claude-code-terminal', 'codex-vscode'];
const SCENARIOS = ['diagnostico', 'execucao-com-agente', 'falha-recuperavel', 'decisao-humana'];
const FILES = {
  formatIdentityLine: 'scripts/forge-sidecar-identity.js',
  formatHumanIdentity: 'scripts/forge-sidecar-identity.js',
  renderRecovery: 'scripts/forge-recovery-diagnostic.js',
  renderDeliveryMarkdown: 'scripts/forge-delivery.js',
};
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function volume(text) {
  return { lines: text ? text.replace(/\n$/, '').split('\n').length : 0, characters: Array.from(text).length };
}

function absolutePaths(text) {
  // Token boundaries include ordinary Markdown wrappers: inline code, links,
  // emphasis, angle brackets, braces, quotes and parentheses. Closing markup
  // and sentence punctuation are excluded from the path; internal underscores
  // remain filename characters. Relative files and URL slashes do not start
  // POSIX tokens. A drive after opening underscore emphasis is also a token.
  return [...text.matchAll(/(?:\b|(?<=_))([A-Za-z]:[\\/][^\s<>|"'`()\[\]{}]+)|(\\\\[^\\\s<>|"'`()\[\]{}]+\\[^\s<>|"'`()\[\]{}]+)|(?:^|[\s("'=|`[\]{}<>*_])(\/[^\s<>|"'`()\[\]{}]+)/gm)]
    .map(match => (match[1] || match[2] || match[3]).replace(/[.,;:*_]+$/, ''))
    // These exact slash commands are syntax, not filesystem paths. A child
    // path such as /forge-next/private.json is still detected and rejected.
    .filter(value => !/^\/forge-(?:auto|next|task|status)$/.test(value));
}

function dumps(text) {
  return {
    hashes: (text.match(/\b[\da-f]{64}\b/gi) || []).length,
    dispatch_or_receipt: (text.match(/\b(?:dispatch|receipt)(?:_id)?[=:]\s*(?:"[^"]+"|[^\s·,;]+)/gi) || []).length
      + (text.match(/\b(?:dispatch|receipt)-[a-z\d][a-z\d-]+\b/gi) || []).length,
    absolute_paths: absolutePaths(text).length,
    helper_lists: text.split('\n').filter(line => (line.match(/\bforge-[\w-]+\.js\b/g) || []).length >= 2).length,
    // The complete canonical identity includes ONE bounded navigation reference.
    // It is counted separately, never silently discarded from the detector.
    navigation_references: (text.match(/\bregistro técnico dispatch fixture-nav\b/g) || []).length,
  };
}

function bulkCount(metrics) {
  return metrics.hashes + metrics.dispatch_or_receipt + metrics.absolute_paths + metrics.helper_lists;
}

function reproduce(sample) {
  const { renderer, input, options, file } = sample.source;
  assert(Object.hasOwn(FILES, renderer), 'renderer outside the closed set');
  assert.strictEqual(file, FILES[renderer], 'renderer source mismatch');
  if (renderer === 'formatIdentityLine' || renderer === 'formatHumanIdentity') {
    return identity[renderer](input.stage, input.fields);
  }
  if (renderer === 'renderRecovery') return recovery.renderRecovery(input, options);
  return delivery.renderDeliveryMarkdown(input, options);
}

function extractHumanView(sample) {
  const { text } = sample;
  switch (sample.human_view.rule) {
    case 'complete-v1': return text;
    case 'identity-human-v1':
      assert.strictEqual(sample.source.renderer, 'formatHumanIdentity');
      assert(text.startsWith('[forge-agente] '));
      return text;
    case 'recovery-human-v1':
      assert.strictEqual(sample.source.renderer, 'renderRecovery');
      assert.notStrictEqual(sample.source.options.summary, false);
      assert(text.startsWith('Resumo da recuperação de '));
      // A Fonte line can contain semantic conflicts after its technical source
      // and hash. Keep that suffix attached to the preceding artifact record.
      return text.split('\n').flatMap(line => {
        if (/^\s*Fonte:/.test(line)) {
          const conflicts = line.match(/; (conflitos: .+)$/);
          return conflicts ? [`    ${conflicts[1]}`] : [];
        }
        if (/^\s*SHA-256:|^Observado em:/.test(line)
          || line === 'Fontes, SHA-256 e detalhes ficam no registro técnico abaixo.') return [];
        return [line];
      }).join('\n');
    case 'delivery-human-v1': {
      assert.strictEqual(sample.source.renderer, 'renderDeliveryMarkdown');
      assert.notStrictEqual(sample.source.options.summary, false);
      assert(text.includes('\nResumo: '));
      let facts = false;
      return text.split('\n').flatMap(line => {
        if (line.startsWith('Detalhe integral reconstruível:')) return [];
        if (line === '### Fatos independentes') facts = true;
        if (!line.startsWith('|')) return [line];
        const cells = line.split('|').slice(1, -1).map(cell => cell.trim());
        // Remove exact source references only. Keep each evidence outcome and
        // every escaped reason/limitation, including unknown context, in order.
        if (facts) return [`| ${cells[0]} | ${cells[1]} |`];
        for (const criterion of sample.source.input.criteria) {
          for (const evidence of criterion.evidence || []) {
            const source = delivery.escapeMarkdownCell(evidence.source);
            for (const outcome of ['ok', 'falha', 'limite']) {
              cells[2] = cells[2].split(`${outcome}: ${source}`).join(outcome);
            }
          }
        }
        return [`| ${cells.join(' | ')} |`];
      }).join('\n');
    }
    default: throw new Error('unknown human view rule');
  }
}

function samplesOf(entry) {
  const pairs = [['principal', entry]];
  for (const [name, pair] of Object.entries(entry.supporting || {})) pairs.push([name, pair]);
  return pairs.flatMap(([name, pair]) => ['before', 'after'].map(side => ({ name, side, sample: pair[side] })));
}

function validatePublishedText(text, allowSynthetic) {
  assert(!/\b(?:sk-[\w-]{16,}|Bearer\s+\S+|(?:password|api_key)\s*[:=]\s*\S+)/i.test(text), 'credential in sample');
  assert(!/[\w.+-]+@[\w.-]+\.[a-z]{2,}|[\\/]Users[\\/]|[\\/]home[\\/]|\b[MT]-20\d{12,}/i.test(text), 'personal data or real unit in sample');
  assert(!text.includes('\ufffd'), 'invalid Unicode replacement in sample');
  for (const absolute of absolutePaths(text)) {
    assert(allowSynthetic, 'absolute path in source metadata or non-rendered sample');
    const prefix = absolute.match(/^(?:C:\/synthetic-forge-fixture\/|\/synthetic-forge-fixture\/)/);
    assert(prefix && absolute.slice(prefix[0].length).split('/').every(part => /^[\w.-]+$/.test(part)
      && part !== '.' && part !== '..'), 'non-synthetic absolute path');
  }
}

function validateSource(sample) {
  const source = sample.source;
  const allowed = { 'renderizado-offline': ['file', 'reference', 'renderer', 'input', 'options', 'synthetic'],
    'modelo-da-skill': ['file', 'reference', 'sha256'], 'redigido': ['file', 'reference', 'synthetic'] };
  if (allowed[sample.label]) assert.deepStrictEqual(Object.keys(source).sort(), [...allowed[sample.label]].sort(), 'source metadata shape');
  assert(nonempty(source.file) && /^[a-z][a-z\d/-]*\/[\w.-]+\.(?:js|md)$/i.test(source.file)
    && !source.file.split('/').includes('..'), 'source file must be repository relative');
  assert(nonempty(source.reference) && source.reference.startsWith(source.file + '#')
    && /^[a-z\d][\w-]*$/i.test(source.reference.slice(source.file.length + 1)), 'source reference must be relative file#anchor');
  const visit = (value, allowSynthetic) => {
    if (typeof value === 'string') validatePublishedText(value, allowSynthetic);
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        validatePublishedText(key, false);
        visit(child, allowSynthetic);
      }
    }
  };
  for (const [key, value] of Object.entries(source)) {
    validatePublishedText(key, false);
    visit(value, sample.label === 'renderizado-offline' && ['input', 'options'].includes(key));
  }
}

function validateSample(sample, side) {
  assert.deepStrictEqual(Object.keys(sample).sort(), ['label', 'source', 'text', 'rubric', 'volume', 'dumps', 'human_view'].sort());
  assert(LABELS.includes(sample.label), 'unknown provenance label');
  // No real host trace was exercised. Reject a promoted observation before
  // interpreting reproduction-only fields under that different provenance.
  assert.notStrictEqual(sample.label, 'observado', 'observado requires a real sanitized trace; this corpus has none');
  assert(nonempty(sample.text) && nonempty(sample.source.reference), 'empty sample/source');
  validateSource(sample);
  assert.strictEqual(sample.rubric.assessment, 'author', 'rubric is not human acceptance');
  assert.deepStrictEqual(Object.keys(sample.rubric).filter(key => key !== 'assessment').sort(), [...ELEMENTS].sort());
  for (const key of ELEMENTS) assert(VALUES.includes(sample.rubric[key]), 'unknown rubric value');
  assert.deepStrictEqual(sample.volume, volume(sample.text), 'full volume drift');
  assert.deepStrictEqual(sample.dumps, dumps(sample.text), 'full dump metrics drift');
  if (sample.label === 'renderizado-offline') {
    assert.strictEqual(sample.source.synthetic, true);
    assert.strictEqual(sample.text, reproduce(sample), 'rendered bytes drift');
  } else if (sample.label === 'modelo-da-skill') {
    assert([ARCHIVE, ...['auto', 'next', 'task', 'status'].map(name => `skills/forge-${name}/SKILL.md`)].includes(sample.source.file));
    const bytes = read(sample.source.file);
    assert.strictEqual(sample.source.sha256, delivery.sha256(bytes), 'literal source drift');
    assert(bytes.includes(sample.text), 'not a literal skill quotation');
    assert.strictEqual(sample.human_view.rule, 'complete-v1');
  } else if (sample.label === 'redigido') {
    assert.strictEqual(sample.source.synthetic, true);
    assert([CONTRACT, 'shared/forge-interaction.md'].includes(sample.source.file));
    assert.strictEqual(sample.human_view.rule, 'complete-v1');
  }
  const human = sample.human_view;
  assert.deepStrictEqual(Object.keys(human).sort(), ['rule', 'text', 'volume', 'dumps'].sort());
  assert(nonempty(human.text), 'empty human view');
  assert.strictEqual(human.text, extractHumanView(sample), 'human extraction drift or omitted content');
  assert.deepStrictEqual(human.volume, volume(human.text), 'human volume drift');
  assert.deepStrictEqual(human.dumps, dumps(human.text), 'human dump metrics drift');
  if (side === 'after') assert.strictEqual(bulkCount(human.dumps), 0, 'bulk technical dump in after human view');
  validatePublishedText(sample.text, sample.label === 'renderizado-offline');
  assert(!/\bUAT\s+(?:visual\s+|de compreensão\s+)?aprovad[oa]|aceite humano\s*[:=]?\s*aprovad[oa]/i.test(sample.text), 'invented human acceptance');
}

function validateEvaluation(data, contractBytes = read(CONTRACT)) {
  assert.deepStrictEqual(Object.keys(data).sort(), ['schema_version', 'base_revision', 'contract_sha256',
    'skill_templates_before_sha256', 'rubric_elements', 'rubric_values', 'labels', 'human_acceptance', 'limits',
    'presentation_preferences', 'entries'].sort());
  assert.strictEqual(data.schema_version, 1);
  assert(/^[\da-f]{40}$/.test(data.base_revision));
  assert.strictEqual(data.contract_sha256, delivery.sha256(contractBytes), 'communication contract drift');
  assert.strictEqual(data.skill_templates_before_sha256, delivery.sha256(read(ARCHIVE)), 'archive drift');
  assert.deepStrictEqual(data.labels, LABELS);
  assert.deepStrictEqual(data.rubric_elements, ELEMENTS);
  assert.deepStrictEqual(data.rubric_values, VALUES);
  assert.deepStrictEqual(data.human_acceptance, { status: 'pending-final-round', reference: 'AUTONOMY-AUTHORIZATION.md', visual: 'pending', comprehension: 'pending' });
  assert.deepStrictEqual(data.limits, { provider_calls: false, real_host_rendering: false, human_uat_exercised: false });
  assert.strictEqual(data.presentation_preferences.suite, 'node scripts/forge-presentation-prefs.test.js');
  assert.strictEqual(data.presentation_preferences.offline, 'passed-in-completed-T06');
  assert.strictEqual(data.presentation_preferences.installed_before_after, 'runtime-pending');
  assert(nonempty(data.presentation_preferences.reference));
  assert.strictEqual(data.entries.length, 8);
  const ids = new Set();
  const pairs = new Set();
  const rendered = new Set();
  for (const entry of data.entries) {
    const entryKeys = ['id', 'host', 'scenario', 'channel', 'before', 'after', 'utility'];
    if (entry.supporting) entryKeys.push('supporting');
    assert.deepStrictEqual(Object.keys(entry).sort(), entryKeys.sort());
    assert(HOSTS.includes(entry.host) && SCENARIOS.includes(entry.scenario));
    assert(!ids.has(entry.id)); ids.add(entry.id);
    const pair = `${entry.host}/${entry.scenario}`;
    assert(!pairs.has(pair), 'duplicate host/scenario'); pairs.add(pair);
    assert(nonempty(entry.utility) && nonempty(entry.channel));
    const supportingNames = { diagnostico: [], 'execucao-com-agente': ['delivery', 'timeline'],
      'falha-recuperavel': ['partial', 'recovery'], 'decisao-humana': [] };
    assert.deepStrictEqual(Object.keys(entry.supporting || {}).sort(), supportingNames[entry.scenario]);
    for (const { side, sample } of samplesOf(entry)) {
      validateSample(sample, side);
      if (sample.label === 'renderizado-offline') rendered.add(`${sample.source.renderer}/${sample.source.options?.summary === false ? 'without-summary' : 'default'}`);
    }
    if (entry.scenario === 'diagnostico') assert(entry.after.human_view.text.includes('desconhecido'));
    if (entry.scenario === 'falha-recuperavel') assert(entry.after.human_view.text.includes('provedor chamado: desconhecido'));
    if (entry.scenario === 'decisao-humana') {
      assert(entry.after.text.includes('Decisão pendente: escolha-sintetica'));
      assert(entry.after.text.includes('aguardando decisão') && entry.after.text.includes('Próximo passo:'));
      assert(entry.after.text.includes('exposta e permitida para finalidade e modo'));
      assert(entry.after.text.includes('Silêncio, timeout, fechamento e resposta vazia'));
    }
  }
  for (const host of HOSTS) for (const scenario of SCENARIOS) assert(pairs.has(`${host}/${scenario}`));
  assert.deepStrictEqual([...rendered].sort(), ['formatHumanIdentity/default', 'formatIdentityLine/default',
    'renderDeliveryMarkdown/default', 'renderDeliveryMarkdown/without-summary', 'renderRecovery/default', 'renderRecovery/without-summary'].sort());
  return data;
}

function comparisonRow(entry) {
  const metrics = sample => `${sample.volume.lines}/${sample.volume.characters}; ${sample.human_view.volume.lines}/${sample.human_view.volume.characters}`;
  const rubric = sample => ELEMENTS.map(key => sample.rubric[key]).join('/');
  const dumpPair = sample => `${bulkCount(sample.dumps)}/${bulkCount(sample.human_view.dumps)}`;
  return `| ${entry.host} | ${entry.scenario} | ${entry.before.label} → ${entry.after.label} | ${rubric(entry.before)} → ${rubric(entry.after)} | ${metrics(entry.before)} → ${metrics(entry.after)} | ${dumpPair(entry.before)} → ${dumpPair(entry.after)} | ${entry.utility} |`;
}

function supportingRow(entry, name, pair) {
  return `| ${entry.host} | ${name} | ${pair.before.label} → ${pair.after.label} | ${pair.before.volume.lines}/${pair.before.volume.characters} → ${pair.after.volume.lines}/${pair.after.volume.characters} | ${pair.before.human_view.volume.lines}/${pair.before.human_view.volume.characters} → ${pair.after.human_view.volume.lines}/${pair.after.human_view.volume.characters} | ${bulkCount(pair.before.dumps)}/${bulkCount(pair.before.human_view.dumps)} → ${bulkCount(pair.after.dumps)}/${bulkCount(pair.after.human_view.dumps)} |`;
}

function run() {
  const data = JSON.parse(read('docs/communication-evaluation/samples.json'));
  const readme = read('docs/communication-evaluation/README.md');
  let passed = 0;
  const test = (name, fn) => { fn(); passed++; process.stdout.write(`PASS ${name}\n`); };
  const reject = (mutate, expected) => {
    const changed = clone(data); mutate(changed);
    assert.throws(() => validateEvaluation(changed), expected);
  };
  const find = (changed, scenario, name) => {
    const entry = changed.entries.find(item => item.scenario === scenario);
    return name ? entry.supporting[name].after : entry.after;
  };
  test('evaluation eight host-scenario pairs have closed labels sources author rubric volume dumps and utility', () => validateEvaluation(data));
  test('evaluation identity technical and human lines reproduce current canonical bytes', () => {
    for (const entry of data.entries.filter(item => ['execucao-com-agente', 'falha-recuperavel'].includes(item.scenario))) {
      assert.strictEqual(entry.before.text, identity.formatIdentityLine(entry.before.source.input.stage, entry.before.source.input.fields));
      assert.strictEqual(entry.after.text, identity.formatHumanIdentity(entry.after.source.input.stage, entry.after.source.input.fields));
      assert.strictEqual(entry.after.dumps.navigation_references, 1);
    }
  });
  for (const [renderer, scenario, name] of [['renderRecovery', 'diagnostico', null], ['renderDeliveryMarkdown', 'execucao-com-agente', 'delivery']]) {
    test(`evaluation ${renderer} with and without summary reproduces full output and rejects drift`, () => {
      for (const entry of data.entries.filter(item => item.scenario === scenario)) {
        const pair = name ? entry.supporting[name] : entry;
        assert.strictEqual(pair.before.source.options.summary, false);
        assert.notStrictEqual(pair.after.source.options.summary, false);
        for (const sample of [pair.before, pair.after]) assert.strictEqual(sample.text, reproduce(sample));
      }
      reject(changed => {
        const sample = find(changed, scenario, name); sample.text += ' adulterado';
        sample.volume = volume(sample.text); sample.dumps = dumps(sample.text);
      }, /rendered bytes drift/);
    });
  }
  test('evaluation skill templates are literal archived and current source quotations', () => {
    for (const entry of data.entries) for (const { sample } of samplesOf(entry)) {
      if (sample.label === 'modelo-da-skill') assert(read(sample.source.file).includes(sample.text));
    }
    reject(changed => { find(changed, 'execucao-com-agente', 'timeline').text += ' não literal';
      const sample = find(changed, 'execucao-com-agente', 'timeline'); sample.volume = volume(sample.text); sample.dumps = dumps(sample.text);
    }, /not a literal skill quotation/);
  });
  test('evaluation both views recalculate volume and all four dump signals with separate navigation count', () => {
    assert.deepStrictEqual(dumps(`${'f'.repeat(64)} dispatch=example receipt_id=example C:/synthetic-forge-fixture/file\nforge-one.js forge-two.js`),
      { hashes: 1, dispatch_or_receipt: 2, absolute_paths: 1, helper_lists: 1, navigation_references: 0 });
    assert.strictEqual(dumps('/synthetic-forge-fixture/file').absolute_paths, 1);
    assert.strictEqual(dumps('/workspace/private.json /private /forge-next/private.json').absolute_paths, 3);
    assert.strictEqual(dumps('\\\\server\\share\\file').absolute_paths, 1);
    assert.strictEqual(dumps('/forge-next. /forge-task').absolute_paths, 0);
    assert.strictEqual(volume('ação 🧪\n').characters, 7);
    for (const entry of data.entries) for (const { sample, side } of samplesOf(entry)) {
      assert.deepStrictEqual(sample.volume, volume(sample.text)); assert.deepStrictEqual(sample.dumps, dumps(sample.text));
      assert.deepStrictEqual(sample.human_view.volume, volume(sample.human_view.text));
      assert.deepStrictEqual(sample.human_view.dumps, dumps(sample.human_view.text));
      if (side === 'after') assert.strictEqual(bulkCount(sample.human_view.dumps), 0);
    }
  });
  test('evaluation deterministic views preserve unknown decisions next steps and every semantic recovery line', () => {
    for (const entry of data.entries) for (const { sample, side } of samplesOf(entry)) {
      assert.strictEqual(sample.human_view.text, extractHumanView(sample));
      if (side !== 'after') continue;
      if (sample.human_view.rule === 'recovery-human-v1') {
        for (const line of sample.text.split('\n').filter(line => line.trim()
          && !/^\s*(?:Fonte:|SHA-256:)/.test(line) && !/^Observado em:/.test(line)
          && line !== 'Fontes, SHA-256 e detalhes ficam no registro técnico abaixo.')) assert(sample.human_view.text.split('\n').includes(line));
        assert(sample.human_view.text.includes('escolha-sintetica: aguardar a inspeção do processo?'));
        assert(sample.human_view.text.includes('Próximo passo seguro:') && sample.human_view.text.includes('desconhecido'));
        assert(sample.dumps.hashes > 0 && sample.dumps.absolute_paths > 0);
      }
      if (sample.human_view.rule === 'delivery-human-v1') {
        for (const line of sample.text.split('\n').filter(line => line.startsWith('Resumo:'))) assert(sample.human_view.text.includes(line));
        for (const item of sample.source.input.criteria) assert(sample.human_view.text.includes(item.text));
        for (const fact of sample.source.input.facts) assert(sample.human_view.text.includes(fact.status));
        assert(sample.human_view.text.includes('pending-final-round'));
      }
    }
  });
  test('evaluation recovery artifact conflicts survive source removal and recalculated omission negatives fail', () => {
    for (const entry of data.entries) for (const { sample, side } of samplesOf(entry)) {
      if (side !== 'after' || sample.source.renderer !== 'renderRecovery') continue;
      // These expected facts are specified independently of extractHumanView.
      assert.strictEqual(sample.source.input.artifacts[0].conflicts, 2);
      assert.strictEqual(sample.source.input.artifacts[1].conflicts, 0);
      assert(sample.text.includes('; conflitos: 2') && sample.text.includes('; conflitos: 0'));
      assert(sample.human_view.text.includes('    conflitos: 2'));
      assert(sample.human_view.text.includes('    conflitos: 0'));
      assert(!sample.human_view.text.includes('Fonte:'));
    }
    for (const count of [2, 0]) reject(changed => {
      const sample = find(changed, 'diagnostico');
      sample.human_view.text = sample.human_view.text.replace(`    conflitos: ${count}\n`, '');
      sample.human_view.volume = volume(sample.human_view.text); sample.human_view.dumps = dumps(sample.human_view.text);
    }, /human extraction drift/);
  });
  test('evaluation delivery evidence ok failure limits and reasons survive source removal and recalculated omission negatives fail', () => {
    const semantics = ['ok &#91;synthetic-check-passed&#93;', 'falha &#91;synthetic-check-failed&#93;',
      'limite &#91;source&#95;context&#95;missing:environment, synthetic-coverage-unknown&#93;'];
    for (const entry of data.entries.filter(item => item.scenario === 'execucao-com-agente')) {
      const sample = entry.supporting.delivery.after;
      for (const expected of semantics) assert(sample.human_view.text.includes(expected), expected);
      assert(sample.text.includes('C:/synthetic-forge-fixture/verification.json'));
      assert.strictEqual(sample.human_view.dumps.absolute_paths, 0);
    }
    // Independent required tokens cover outcomes and each reason separately;
    // metrics are recomputed, so no incidental metric mismatch can pass this.
    for (const [token, replacement] of [['ok &#91;', '&#91;'], ['falha &#91;', '&#91;'], ['limite &#91;', '&#91;'],
      ['synthetic-check-passed', ''], ['synthetic-check-failed', ''],
      ['source&#95;context&#95;missing:environment', ''], ['synthetic-coverage-unknown', '']]) reject(changed => {
      const sample = find(changed, 'execucao-com-agente', 'delivery');
      assert(sample.human_view.text.includes(token));
      sample.human_view.text = sample.human_view.text.replace(token, replacement);
      sample.human_view.volume = volume(sample.human_view.text); sample.human_view.dumps = dumps(sample.human_view.text);
    }, /human extraction drift/);
  });
  test('evaluation altered full output extraction metrics hidden unknown and omitted human content are rejected', () => {
    reject(changed => { find(changed, 'execucao-com-agente').text += ' adulterado'; }, /full volume drift/);
    reject(changed => { find(changed, 'diagnostico').human_view.text = ''; }, /empty human view/);
    reject(changed => { find(changed, 'diagnostico').volume.characters++; }, /full volume drift/);
    reject(changed => { find(changed, 'diagnostico').dumps.hashes++; }, /full dump metrics drift/);
    reject(changed => { find(changed, 'diagnostico').human_view.volume.characters++; }, /human volume drift/);
    reject(changed => { find(changed, 'diagnostico').human_view.dumps.hashes++; }, /human dump metrics drift/);
    for (const word of ['desconhecido', 'Pendências de decisão:', 'Próximo passo seguro:', 'escolha-sintetica:']) {
      reject(changed => {
        const sample = find(changed, 'diagnostico');
        sample.human_view.text = sample.human_view.text.split('\n').filter(line => !line.includes(word)).join('\n');
        sample.human_view.volume = volume(sample.human_view.text); sample.human_view.dumps = dumps(sample.human_view.text);
      }, /human extraction drift/);
    }
    reject(changed => {
      const sample = find(changed, 'execucao-com-agente', 'delivery');
      sample.human_view.text = sample.human_view.text.split('\n').filter(line => !line.includes('Verificação sintética concluída')).join('\n');
      sample.human_view.volume = volume(sample.human_view.text); sample.human_view.dumps = dumps(sample.human_view.text);
    }, /human extraction drift/);
  });
  test('evaluation author assessments stay distinct from pending final visual and comprehension acceptance', () => {
    assert.strictEqual(data.human_acceptance.status, 'pending-final-round');
    assert(readme.includes('AUTONOMY-AUTHORIZATION.md') && readme.includes('avaliação do autor'));
    reject(changed => { changed.human_acceptance.visual = 'approved'; });
    reject(changed => { find(changed, 'diagnostico').rubric.assessment = 'human'; }, /rubric is not human acceptance/);
    reject(changed => { find(changed, 'diagnostico').label = 'observado'; }, /real sanitized trace/);
    reject(changed => { changed.entries[0].human_uat = 'approved'; });
  });
  test('evaluation contract hash drift and synthetic provenance violations fail closed', () => {
    assert.throws(() => validateEvaluation(data, read(CONTRACT) + '\nchanged contract'), /communication contract drift/);
    reject(changed => { changed.contract_sha256 = '0'.repeat(64); }, /communication contract drift/);
    reject(changed => { changed.skill_templates_before_sha256 = '0'.repeat(64); }, /archive drift/);
    reject(changed => { find(changed, 'diagnostico').source.synthetic = false; });
    // Mutations are fully re-rendered/re-measured: privacy is an independent
    // check, not an incidental failure of the byte/metric comparison.
    for (const source of ['C:/Users/example/private.json', 'C:/real-project/private.json', '/workspace/private.json', '\\\\server\\share\\private.json']) {
      reject(changed => {
        const sample = find(changed, 'diagnostico'); sample.source.input.sources[0].source = source;
        sample.text = reproduce(sample); sample.volume = volume(sample.text); sample.dumps = dumps(sample.text);
        sample.human_view.text = extractHumanView(sample); sample.human_view.volume = volume(sample.human_view.text); sample.human_view.dumps = dumps(sample.human_view.text);
      }, /personal data|non-synthetic absolute path/);
    }
    reject(changed => { find(changed, 'diagnostico').source.input.private_note = 'Bearer fixture-secret-token'; }, /credential in sample/);
  });
  test('evaluation source references reject drive UNC POSIX and synthetic absolute metadata with identical rendered bytes', () => {
    for (const value of ['C:/operator-private/project/trace.md', 'C:\\operator-private\\project\\trace.md',
      '\\\\server\\share\\trace.md', '/operator-private/project/trace.md', 'C:/synthetic-forge-fixture/trace.md']) {
      reject(changed => {
        const sample = find(changed, 'diagnostico'); sample.source.reference = value;
        assert.strictEqual(reproduce(sample), sample.text, 'reference is ignored by the renderer');
        assert.deepStrictEqual(sample.dumps, dumps(sample.text));
      }, /source reference must be relative file#anchor/);
    }
    reject(changed => { find(changed, 'diagnostico').source.file = 'C:/operator-private/renderer.js'; }, /source file must be repository relative/);
  });
  test('evaluation ignored nested inputs and options reject drive UNC POSIX private paths without changing rendered bytes', () => {
    const privatePaths = ['C:/operator-private/project/trace.md', 'C:\\operator-private\\project\\trace.md',
      '\\\\server\\share\\trace.md', '/operator-private/project/trace.md',
      'C:/synthetic-forge-fixture/../operator-private/trace.md', '/synthetic-forge-fixture/../operator-private/trace.md'];
    for (const field of ['input', 'options']) for (const value of privatePaths) reject(changed => {
      const sample = find(changed, 'diagnostico'); sample.source[field].ignored = { nested: [{ reference: value }] };
      assert.strictEqual(reproduce(sample), sample.text, 'nested metadata is ignored by the renderer');
      assert.deepStrictEqual(sample.dumps, dumps(sample.text));
    }, /non-synthetic absolute path/);
    for (const value of ['Bearer fixture-secret-token', 'person@example.invalid', 'M-20261028132636-real']) {
      reject(changed => { find(changed, 'diagnostico').source.options.ignored = { nested: [{ value }] }; }, /credential|personal data/);
    }
    reject(changed => { find(changed, 'diagnostico').source.input.ignored = { '/operator-private/trace.md': true }; }, /absolute path in source metadata/);
  });
  test('evaluation legitimate synthetic reproduction paths and relative skill commands remain accepted and counted', () => {
    for (const source of ['C:/synthetic-forge-fixture/report.json', '/synthetic-forge-fixture/report.json']) {
      const changed = clone(data);
      const sample = find(changed, 'diagnostico'); sample.source.input.sources[0].source = source;
      sample.text = reproduce(sample); sample.volume = volume(sample.text); sample.dumps = dumps(sample.text);
      sample.human_view.text = extractHumanView(sample); sample.human_view.volume = volume(sample.human_view.text); sample.human_view.dumps = dumps(sample.human_view.text);
      validateEvaluation(changed);
      assert(sample.dumps.absolute_paths > 0 && sample.human_view.dumps.absolute_paths === 0);
    }
    for (const command of ['/forge-auto', '/forge-next', '/forge-task', '/forge-status']) {
      const changed = clone(data); find(changed, 'diagnostico').source.options.ignored = { nested: [command] };
      validateEvaluation(changed);
    }
  });
  // Ten ordinary Markdown token boundaries, shared by the private/synthetic
  // matrices below. Expected path counts are explicit, not derived from the
  // detector or from an earlier run of the corpus.
  const pathWrappers = [['', ''], ['`', '`'], ['[', ']'], ['**', '**'], ['_', '_'],
    ['<', '>'], ['{', '}'], ["'", "'"], ['"', '"'], ['(', ')']];
  test('evaluation Markdown path matrix rejects private drive UNC POSIX and traversal paths in ignored inputs options keys and references with identical renderer bytes', () => {
    const paths = ['C:/operator-private/project/trace.md', 'C:\\operator-private\\project\\trace.md',
      '\\\\server\\share\\trace.md', '/operator-private/project/trace.md',
      'C:/synthetic-forge-fixture/../operator-private/trace.md', '/synthetic-forge-fixture/../operator-private/trace.md'];
    let values = 0;
    let keys = 0;
    let references = 0;
    for (const [open, close] of pathWrappers) for (const privatePath of paths) {
      const value = open + privatePath + close;
      assert.strictEqual(dumps(value).absolute_paths, 1, 'each formatted absolute path counts once');
      for (const field of ['input', 'options']) {
        reject(changed => {
          const sample = find(changed, 'diagnostico');
          sample.source[field].ignored = { nested: [{ reference: value }] };
          assert.strictEqual(reproduce(sample), sample.text, 'formatted nested value does not change rendered bytes');
          assert.deepStrictEqual(sample.dumps, dumps(sample.text));
        }, /non-synthetic absolute path/);
        values++;
        reject(changed => {
          const sample = find(changed, 'diagnostico');
          sample.source[field].ignored = { nested: [{ [value]: true }] };
          assert.strictEqual(reproduce(sample), sample.text, 'formatted nested key does not change rendered bytes');
        }, /absolute path in source metadata/);
        keys++;
      }
      for (const field of ['file', 'reference']) {
        reject(changed => {
          const sample = find(changed, 'diagnostico');
          sample.source[field] = value;
          if (field === 'reference') assert.strictEqual(reproduce(sample), sample.text);
        }, /source (?:file must be repository relative|reference must be relative file#anchor)/);
        references++;
      }
    }
    assert.strictEqual(values, 120);
    assert.strictEqual(keys, 120);
    assert.strictEqual(references, 120);
  });
  test('evaluation Markdown synthetic path matrix accepts exact prefixes counts complete paths and preserves dump-free human views', () => {
    let inputs = 0;
    let outputs = 0;
    for (const [open, close] of pathWrappers) for (const syntheticPath of [
      'C:/synthetic-forge-fixture/report_name.json', '/synthetic-forge-fixture/report_name.json']) {
      const value = open + syntheticPath + close;
      assert.strictEqual(dumps(value).absolute_paths, 1, 'formatted synthetic path counts once');
      for (const field of ['input', 'options']) {
        const changed = clone(data);
        const sample = find(changed, 'diagnostico');
        sample.source[field].ignored = { nested: [{ reference: value }] };
        assert.strictEqual(reproduce(sample), sample.text, 'formatted synthetic metadata does not change rendered bytes');
        validateEvaluation(changed);
        inputs++;
      }
      const changed = clone(data);
      const sample = find(changed, 'diagnostico');
      // Re-render just one source occurrence: its independent expected complete
      // count stays five, while the extracted human view stays at zero paths.
      sample.source.input.sources[0].source = value;
      sample.text = reproduce(sample); sample.volume = volume(sample.text); sample.dumps = dumps(sample.text);
      sample.human_view.text = extractHumanView(sample); sample.human_view.volume = volume(sample.human_view.text);
      sample.human_view.dumps = dumps(sample.human_view.text);
      assert(sample.text.includes(value), 'full renderer retains the formatted synthetic reference');
      assert.strictEqual(sample.dumps.absolute_paths, 5);
      assert.strictEqual(sample.human_view.dumps.absolute_paths, 0);
      validateEvaluation(changed);
      outputs++;
    }
    assert.strictEqual(inputs, 40);
    assert.strictEqual(outputs, 20);
  });
  test('evaluation Markdown slash-command matrix accepts only exact skill commands and rejects child paths without changing rendered bytes', () => {
    let commands = 0;
    let children = 0;
    for (const [open, close] of pathWrappers) for (const command of ['/forge-auto', '/forge-next', '/forge-task', '/forge-status']) {
      const formatted = open + command + close;
      assert.strictEqual(dumps(formatted).absolute_paths, 0, 'exact formatted skill command is not a path');
      const child = open + command + '/private.json' + close;
      assert.strictEqual(dumps(child).absolute_paths, 1, 'formatted slash command with child path counts once');
      for (const field of ['input', 'options']) {
        const changed = clone(data);
        const sample = find(changed, 'diagnostico');
        sample.source[field].ignored = { nested: [{ reference: formatted }] };
        assert.strictEqual(reproduce(sample), sample.text);
        validateEvaluation(changed);
        commands++;
        reject(mutated => {
          const target = find(mutated, 'diagnostico');
          target.source[field].ignored = { nested: [{ reference: child }] };
          assert.strictEqual(reproduce(target), target.text);
        }, /non-synthetic absolute path/);
        children++;
      }
    }
    assert.strictEqual(commands, 80);
    assert.strictEqual(children, 80);
  });
  test('evaluation Portuguese README compares each host scenario rubric both volumes dumps and utility', () => {
    for (const entry of data.entries) {
      assert(readme.includes(comparisonRow(entry)), `README comparison missing ${entry.id}`);
      for (const [name, pair] of Object.entries(entry.supporting || {})) assert(readme.includes(supportingRow(entry, name, pair)), `README supporting comparison missing ${entry.id}/${name}`);
    }
    for (const term of [...LABELS, 'resultado', 'fase', 'executor', 'próximo passo', 'decisão pendente', 'caracteres', 'saída completa', 'vista humana']) assert(readme.includes(term), term);
  });
  test('evaluation README separates prior offline preference evidence from pending installed runtime and human UAT', () => {
    for (const term of ['forge-presentation-prefs.test.js', 'preservadas offline', 'runtime pendente', 'sem chamada a provider',
      'sem host real renderizando', 'pending-final-round', 'rodada final', 'finalidade e modo']) assert(readme.includes(term), term);
    assert.deepStrictEqual(data.limits, { provider_calls: false, real_host_rendering: false, human_uat_exercised: false });
  });
  process.stdout.write(`${passed} evaluation groups passed\n`);
}

// Test-local pure utilities also support deliberate corpus authoring. The
// verifier never generates, rewrites or silently repairs samples or README.
module.exports = { volume, dumps, bulkCount, reproduce, extractHumanView, validateEvaluation, comparisonRow, supportingRow, samplesOf };
if (require.main === module) {
  try { run(); } catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }
}
