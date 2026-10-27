'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const impact = require('./forge-release-impact.js');
const { IMPACT_VERSION, SURFACES, KINDS, KIND_BUMP, LIMITS, parseImpact, evaluateImpact } = impact;
let count = 0;
function check(name, fn) {
  count++;
  try { fn(); console.log(`ok ${count} - CHECK-IMPACT-${name}`); }
  catch (error) {
    console.log(`not ok ${count} - CHECK-IMPACT-${name}`);
    console.error(error.stack);
    process.exitCode = 1;
  }
}
const declaration = (kind, ref = 'contrato', surface = 'cli') => `Forge-Impact: ${surface}/${kind}; ${ref}`;
const message = (kind, subject = 'fix: exemplo', ref = 'contrato') => `${subject}\n\n${declaration(kind, ref)}`;
// Fixtures inject literal labels; the production classifier belongs to T03.
const classify = text => ({ 'fix: exemplo': 'patch', 'feat: exemplo': 'minor', 'major: exemplo': 'major' }[text.split('\n')[0]] || 'none');
const evaluate = (commits, label_bump = 'major', options) => evaluateImpact({ commits, label_bump, classify }, options);
const sha40 = 'a'.repeat(40);
const sha64 = 'b'.repeat(64);

check('PUBLIC-API', () => {
  assert.deepStrictEqual(Object.keys(impact).sort(), [
    'IMPACT_VERSION', 'KINDS', 'KIND_BUMP', 'LIMITS', 'SURFACES', 'evaluateImpact', 'parseImpact',
  ].sort());
  assert.strictEqual(IMPACT_VERSION, 1);
  assert.deepStrictEqual(SURFACES, ['cli', 'schema', 'prefs', 'worker', 'receipt', 'migration', 'procedure']);
  assert.deepStrictEqual(KINDS, ['removal', 'new-requirement', 'meaning-change', 'compatible-addition', 'compatible-correction', 'internal']);
  assert.deepStrictEqual(KIND_BUMP, { removal: 'major', 'new-requirement': 'major', 'meaning-change': 'major',
    'compatible-addition': 'minor', 'compatible-correction': 'patch', internal: 'none' });
  assert.deepStrictEqual(LIMITS, { max_declarations_per_commit: 16, max_ref_code_points: 160,
    max_diagnostics: 64, max_result_bytes: 131072 });
  for (const value of [SURFACES, KINDS, KIND_BUMP, LIMITS]) assert(Object.isFrozen(value));
});

check('PARSE-BODY-ONLY', () => {
  assert.deepStrictEqual(parseImpact(declaration('removal')), { declarations: [], invalid: [] });
  const body = `assunto\n\n${declaration('removal', '--old')}\n${declaration('internal', 'ref', 'schema')}`;
  const expected = { declarations: [
    { surface: 'cli', kind: 'removal', bump: 'major', ref: '--old' },
    { surface: 'schema', kind: 'internal', bump: 'none', ref: 'ref' },
  ], invalid: [] };
  assert.deepStrictEqual(parseImpact(body), expected);
  assert.deepStrictEqual(parseImpact(body.replace(/\n/g, '\r\n')), expected);
  assert.deepStrictEqual(parseImpact(`assunto\r${declaration('removal')}`), { declarations: [], invalid: [] });
});

check('PARSE-COLUMN', () => {
  assert.deepStrictEqual(parseImpact(`assunto\n ${declaration('removal')}\n\t${declaration('removal')}`),
    { declarations: [], invalid: [] });
  for (const line of ['forge-impact: cli/removal; x', 'Forge-Impact:cli/removal; x',
    'Forge-Impact : cli/removal; x', 'Forge-Impact:  cli/removal; x']) {
    assert.deepStrictEqual(parseImpact(`assunto\n${line}`), {
      declarations: [], invalid: [{ reason: 'impact-trailer-malformed', line_index: 1 }],
    });
  }
});

check('PARSE-INVALID', () => {
  const cases = [
    ['Forge-Impact: unknown/removal; x', 'impact-surface-unknown'],
    ['Forge-Impact: cli/unknown; x', 'impact-kind-unknown'],
    ['Forge-Impact: cli/removal; ', 'impact-ref-missing'],
    ['Forge-Impact: cli/removal;', 'impact-ref-missing'],
    [declaration('removal', '\u{1f600}'.repeat(161)), 'impact-ref-too-long'],
    [declaration('removal', 'x\u0000y'), 'impact-ref-control'],
    [declaration('removal', 'x\u007fy'), 'impact-ref-control'],
    [declaration('removal', 'x\ry'), 'impact-ref-control'],
    [declaration('removal', 'x\r'), 'impact-ref-control'],
    ['Forge-Impact: cli/removal x', 'impact-trailer-malformed'],
  ];
  for (const [line, reason] of cases) assert.deepStrictEqual(parseImpact(`assunto\n${line}`), {
    declarations: [], invalid: [{ reason, line_index: 1 }],
  });
  const ref = '\u{1f600}'.repeat(160);
  assert.strictEqual(parseImpact(`assunto\n${declaration('removal', ref)}`).declarations[0].ref, ref);
  for (const value of [42, null, undefined, {}, [], Symbol('mensagem')]) {
    assert.deepStrictEqual(parseImpact(value), { declarations: [], invalid: [{ reason: 'impact-message-invalid', line_index: null }] });
  }
  const seventeen = parseImpact(`assunto\n${Array(17).fill(declaration('internal')).join('\n')}`);
  assert.strictEqual(seventeen.declarations.length, 16);
  assert.deepStrictEqual(seventeen.invalid, [{ reason: 'impact-declarations-exceeded', line_index: 17, excess_count: 1 }]);
  const nineteen = parseImpact(`assunto\n${Array(19).fill(declaration('internal')).join('\n')}`);
  assert.deepStrictEqual(nineteen.invalid, [{ reason: 'impact-declarations-exceeded', line_index: 17, excess_count: 3 }]);
});

check('REQUIRED-LEVELS', () => {
  for (const [kind, required] of [['removal', 'major'], ['new-requirement', 'major'], ['meaning-change', 'major'],
    ['compatible-addition', 'minor'], ['compatible-correction', 'patch'], ['internal', 'none']]) {
    assert.strictEqual(evaluate([message(kind)]).required, required);
  }
  const result = evaluate([message('compatible-correction'), message('removal'), message('compatible-addition')]);
  assert.strictEqual(result.required, 'major');
  assert.strictEqual(result.declared_commits, 3);
  // Every pair discriminates the exact strict conflict boundary, including none.
  for (const [kind, conflicts] of [['internal', []], ['compatible-correction', ['none']],
    ['compatible-addition', ['none', 'patch']], ['removal', ['none', 'patch', 'minor']]]) {
    for (const label of ['none', 'patch', 'minor', 'major']) {
      assert.strictEqual(evaluate([message(kind)], label).conflict_count, conflicts.includes(label) ? 1 : 0);
    }
  }
});

check('STATUS-PRECEDENCE', () => {
  const result = evaluate([`${message('removal')}\nForge-Impact: cli/unknown; x`, 'docs: sem evidência'], 'patch');
  assert.strictEqual(result.status, 'invalid');
  assert.deepStrictEqual([result.required, result.declared_commits, result.undeclared_commits, result.invalid_count, result.conflict_count],
    ['major', 1, 1, 1, 1]);
  assert.deepStrictEqual(result.diagnostics.map(item => item.code), ['impact-invalid', 'impact-label-conflict', 'commit-understated']);
  assert.strictEqual(result.diagnostics[0].conflict_count, 1);
  assert(result.diagnostics[0].message.includes('1'));
  assert.deepStrictEqual(evaluate([], 'none'), {
    version: 1, status: 'consistent', required: 'none', label_bump: 'none', declared_commits: 0,
    undeclared_commits: 0, invalid_count: 0, conflict_count: 0, diagnostics: [], diagnostics_omitted: 0, reason: null,
  });
  assert.strictEqual(evaluate([message('compatible-correction')], 'patch').status, 'consistent');
  assert.strictEqual(evaluate([message('removal'), 'docs: ausente'], 'patch').status, 'conflict');
});

check('CONFLICT-RANGE', () => {
  const commits = [{ sha: sha40, message: message('removal') }];
  const conflict = evaluate(commits, 'patch');
  assert.strictEqual(conflict.status, 'conflict');
  assert.deepStrictEqual(conflict.diagnostics[0], { code: 'impact-label-conflict', sha: sha40, surface: 'cli',
    kind: 'removal', ref: 'contrato', required: 'major', label: 'patch' });
  const covered = evaluate([...commits, 'major: exemplo'], 'major');
  assert.strictEqual(covered.status, 'partial');
  assert.strictEqual(covered.conflict_count, 0);
  assert.deepStrictEqual(covered.diagnostics.map(item => item.code), ['commit-understated']);
  assert.strictEqual(covered.label_bump, 'major');
});

check('D2-NONE-LABEL', () => {
  const result = evaluate([message('compatible-correction', 'docs: exemplo')], 'none');
  assert.strictEqual(result.status, 'conflict');
  assert.strictEqual(result.required, 'patch');
  assert.strictEqual(result.conflict_count, 1);
  assert.strictEqual(result.label_bump, 'none');
});

check('UNKNOWN', () => {
  const result = evaluate(['docs: texto', { sha: sha40, message: '' }], 'none');
  assert.strictEqual(result.status, 'partial');
  assert.strictEqual(result.required, 'none');
  assert.strictEqual(result.undeclared_commits, 2);
  assert.strictEqual(result.declared_commits, 0);
  assert.deepStrictEqual(result.diagnostics, []);
});

check('ADVISORY', () => {
  const result = evaluate([message('compatible-addition', 'feat: exemplo')], 'major');
  assert.strictEqual(result.status, 'consistent');
  assert.strictEqual(result.label_bump, 'major');
  assert.strictEqual(result.conflict_count, 0);
  assert.deepStrictEqual(result.diagnostics, [{ code: 'label-exceeds-impact', required: 'minor', label: 'major' }]);
  const understated = evaluate([message('compatible-addition')], 'major');
  assert.deepStrictEqual(understated.diagnostics.map(item => item.code), ['commit-understated', 'label-exceeds-impact']);
});

check('HEAD-TAGGED', () => {
  assert.deepStrictEqual(evaluateImpact({ head_tagged: true, label_bump: 'tagged' }), {
    version: 1, status: 'not-evaluated', required: 'none', label_bump: 'none', declared_commits: 0,
    undeclared_commits: 0, invalid_count: 0, conflict_count: 0, diagnostics: [], diagnostics_omitted: 0, reason: 'head-tagged',
  });
});

check('BOUNDARY', () => {
  for (const input of [null, undefined, {}, { commits: [], classify, label_bump: 'tagged' },
    { commits: 'texto', classify, label_bump: 'none' }, { commits: [], label_bump: 'none' }]) {
    assert.throws(() => evaluateImpact(input), error => error instanceof Error && error.code === 'impact-input-invalid');
  }
  assert.doesNotThrow(() => parseImpact(42));
  for (const value of [null, 42, false, Symbol('commit'), {}]) {
    const result = evaluate([value], 'none');
    assert.strictEqual(result.status, 'invalid');
    assert.strictEqual(result.diagnostics[0].reason, 'impact-message-invalid');
  }
  for (const sha of [null, undefined, 42, '', 'a'.repeat(39), 'A'.repeat(40), `${sha40}\n`]) {
    assert.strictEqual(evaluate([{ sha, message: message('removal') }], 'patch').diagnostics[0].sha, null);
  }
  assert.strictEqual(evaluate([{ sha: sha64, message: message('removal') }], 'patch').diagnostics[0].sha, sha64);
});

check('BOUNDS', () => {
  const commits = Array.from({ length: 1000 }, (_, index) => ({
    sha: index.toString(16).padStart(40, '0'), message: message('removal', 'fix: exemplo', '\u{1f600}'.repeat(160)),
  }));
  const result = evaluate(commits, 'patch');
  assert.strictEqual(result.diagnostics.length, 64);
  assert.strictEqual(result.diagnostics_omitted, 1936);
  assert.strictEqual(result.conflict_count, 1000);
  assert.strictEqual(result.declared_commits, 1000);
  result.diagnostics.forEach((item, index) => {
    assert.strictEqual(item.code, 'impact-label-conflict');
    assert.strictEqual(item.sha, index.toString(16).padStart(40, '0'));
    assert.strictEqual(item.ref, '\u{1f600}'.repeat(160));
  });
  assert(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 131072);
  const reduced = evaluate(commits, 'patch', { limits: { max_result_bytes: 1500 } });
  assert.strictEqual(reduced.diagnostics.length, 1);
  assert.strictEqual(reduced.diagnostics_omitted, 1999);
  assert.deepStrictEqual(reduced.diagnostics, result.diagnostics.slice(0, 1));
  const empty = evaluate(commits, 'patch', { limits: { max_result_bytes: 300 } });
  assert.deepStrictEqual(empty.diagnostics, []);
  assert.strictEqual(empty.diagnostics_omitted, 2000);
  assert.strictEqual(empty.conflict_count, 1000);
  assert.strictEqual(empty.required, 'major');
  assert(Buffer.byteLength(JSON.stringify(empty), 'utf8') <= 300);
  assert.throws(() => evaluate(commits, 'patch', { limits: { max_result_bytes: 1 } }),
    error => error.code === 'impact-result-too-large');
  const limited = evaluate(commits, 'patch', { limits: { max_diagnostics: 2 } });
  assert.strictEqual(limited.diagnostics.length, 2);
  assert.strictEqual(limited.diagnostics_omitted, 1998);
  assert.strictEqual(evaluateImpact({ commits, label_bump: 'patch', classify, limits: { max_diagnostics: 2 } }).diagnostics.length, 64);
});

check('PURITY', () => {
  const input = Object.freeze({ commits: Object.freeze([
    Object.freeze({ sha: sha40, message: message('removal') }), message('internal'),
  ]), label_bump: 'major', classify });
  const options = Object.freeze({ limits: Object.freeze({ max_diagnostics: 2 }) });
  const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const before = fingerprint({ input, options });
  const first = evaluateImpact(input, options);
  assert.deepStrictEqual(evaluateImpact(input, options), first);
  assert.strictEqual(fingerprint({ input, options }), before);
  const source = fs.readFileSync(path.join(__dirname, 'forge-release-impact.js'), 'utf8');
  assert.deepStrictEqual([...source.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1]), []);
  assert(!/\bprocess\s*\.\s*env\b|\bDate\b/.test(source));
});

check('DOC-SYNC', () => {
  // Structural audit only: these assertions do not review impact semantics.
  const doc = fs.readFileSync(path.join(__dirname, '..', 'shared', 'forge-release-impact.md'), 'utf8');
  for (const token of SURFACES) assert(doc.includes(`\`${token}\``), token);
  for (const token of KINDS) assert(doc.includes(`\`${token}\``), token);
  for (const token of ['max_declarations_per_commit = 16', 'max_ref_code_points = 160',
    'max_diagnostics = 64', 'max_result_bytes = 131072']) assert(doc.includes(token), token);
  assert.deepStrictEqual([LIMITS.max_declarations_per_commit, LIMITS.max_ref_code_points,
    LIMITS.max_diagnostics, LIMITS.max_result_bytes], [16, 160, 64, 131072]);
});
