#!/usr/bin/env node
'use strict';
// Text-only S02/T07 checks. No provider, network, git or real owner writes.
// Renderer outputs stay in an exclusive temporary root, cleaned in finally.
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const renderer = require('./forge-codex-renderer');
const ROOT = path.resolve(__dirname, '..');
// Published changelog assertions retain their exact measured predecessor.
const read = file => file === 'CHANGELOG.md'
  ? require('./fixtures/issues-457-458/distribution.cjs').issue455View.issues451452View.projectRead(p => fs.readFileSync(path.join(ROOT, p)))(file).toString('utf8')
  : require('./fixtures/issues-457-458/distribution.cjs').projectRead(p => fs.readFileSync(path.join(ROOT, p)))(file).toString('utf8');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const DOC = 'docs/issue-440/recovery-abandon.md';
const document = read(DOC);
const SETS = [
  ['replay-refusal-v1', 'forge-replay-refusal', 'REASON_CODES'],
  ['process-tree', 'forge-process-tree', 'REASON_CODES'],
  ['abandonment', 'forge-attempt-abandon', 'REASON_CODES'],
  ['events', 'forge-attempt-abandon', 'EVENT_NAMES'],
  ['backup-reset', 'forge-surgical-reset', 'BACKUP_RESET_CODES'],
  ['successor', 'forge-unit-controller', 'ATTEMPT_SUCCESSOR_CODES'],
];
let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log('PASS ' + label);
}
function section(text, heading) {
  const marker = '### ' + heading + '\n';
  assert.equal(text.split(marker).length, 2, 'unique section ' + heading);
  return text.split(marker)[1].split(/^#{1,3} /m)[0];
}
function codes(text) {
  return [...text.matchAll(/^\| ([a-z][a-z0-9-]+) \|/gm)].map(match => match[1]);
}
function checkTable(text, id, moduleName, exportName) {
  const table = section(text, id);
  assert(table.includes('scripts/' + moduleName + '.js; export: ' + exportName));
  const values = require('./' + moduleName)[exportName];
  assert(Object.isFrozen(values), id + ' export is closed/frozen');
  const listed = codes(table);
  assert.equal(new Set(listed).size, listed.length, id + ' duplicate code');
  assert.deepEqual([...listed].sort(), [...values].sort(), id + ' exact exported set');
  const source = read('scripts/' + moduleName + '.js');
  for (const code of listed) assert(source.includes("'" + code + "'"), moduleName + ' literal ' + code);
}
for (const [id, moduleName, exportName] of SETS) {
  test('docs-' + id + '-equals-export-and-source-literals', () => checkTable(document, id, moduleName, exportName));
}
test('docs-table-validation-rejects-missing-extra-duplicate-and-wrong-module', () => {
  const code = require('./forge-replay-refusal').REASON_CODES[0];
  const row = document.split('\n').find(line => line.startsWith('| ' + code + ' |'));
  for (const changed of [document.replace(row + '\n', ''), document.replace(row, row + '\n' + row),
    document.replace(row, row + '\n| replay-refusal-invented | blocking |'),
    document.replace('scripts/forge-replay-refusal.js; export:', 'scripts/forge-process-tree.js; export:')]) {
    assert.throws(() => checkTable(changed, 'replay-refusal-v1', 'forge-replay-refusal', 'REASON_CODES'));
  }
});
test('docs-input-guards-have-separate-exact-literal-tables', () => {
  for (const [id, moduleName, code] of [
    ['reset-input-guard', 'forge-surgical-reset', 'reset-input-invalid'],
    ['abandon-input-guard', 'forge-attempt-abandon', 'abandon-input-invalid'],
  ]) {
    const table = section(document, id);
    assert(table.includes('scripts/' + moduleName + '.js; literal'));
    assert.deepEqual(codes(table), [code]);
    assert(read('scripts/' + moduleName + '.js').includes("'" + code + "'"));
    assert.throws(() => assert.deepEqual(codes(table.replace(code, code + '-invented')), [code]));
  }
});
test('docs-recovery-procedure-seven-English-lines-UTF8-LF-and-only-inventory-sha', () => {
  const file = 'shared/forge-procedure-recovery.md';
  const bytes = fs.readFileSync(path.join(ROOT, file));
  assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
  const text = bytes.toString('utf8');
  assert(!text.includes('\r'));
  const at = text.indexOf('\n\nReplay first:');
  assert(at > 0);
  const added = text.slice(at + 2).trimEnd().split('\n');
  assert(added.length <= 8);
  assert(added.every(line => /^[\x20-\x7e]+$/.test(line)));
  assert.equal(sha(text.slice(0, at + 1)), '47e906cd647767f8dec63df6a065d8faa99b14fafaf4924e00b41b0e23944d22');
  const inventoryText = read('shared/forge-procedures.json');
  const inventory = JSON.parse(inventoryText);
  // Find the actual module row without assuming a manifest wrapper name.
  const recovery = Object.values(inventory).filter(Array.isArray).flat().find(row => row.id === 'recovery');
  assert(recovery);
  assert.equal(recovery.sha256, sha(bytes));
  const originalInventory = inventoryText.replace(recovery.sha256, '47e906cd647767f8dec63df6a065d8faa99b14fafaf4924e00b41b0e23944d22');
  assert.equal(sha(originalInventory), '2fac89deff0f797988b4c02c1a5fca348a39b0261165a5b6d0002c12001e3fef');
  assert.equal(sha(fs.readFileSync(path.join(ROOT, 'forge-source-manifest.json'))), 'fd6c40c328f131e1d411d0b712bae1feef46b3a88fe066add22c859d4e8ce36e');
});
test('docs-four-canonical-texts-order-and-preimages-including-entire-sidecar-identity', () => {
  const cases = [
    ['shared/forge-dispatch.md', '### Replay, operational refusal, abandonment and new begin\n', '### Strategy table\n', 'c37bf4085d4d693f5e7dadf46fa9ff2d7a273284135c8785e327b31c704e6502'],
    ['shared/forge-bidirectional-sidecar.md', '#### Replay, recusa operacional, abandono e novo begin\n', '## Authorized continuity per unit\n', 'eacd50757df5785c78150e109cd110b6279d379bdb176bbaf21b3c8ca5d39e6f'],
    ['skills/forge-auto/SKILL.md', 'Receipt `failed` ou `started`:', '**Update timeline task**', 'e666557c979bc7cbb3f7a85e3ef91b166760d6e16aca06ece83e03dc33942d8c'],
    ['skills/forge-next/SKILL.md', 'Receipt `failed` ou `started`:', '**Update timeline task**', 'fe72edc9eedccfac3faa77dc9a619d0a0b98ee6fed052265dfd2700740a7d9e1'],
  ];
  for (const [file, start, end, original] of cases) {
    const text = read(file), at = text.indexOf(start), until = text.indexOf(end, at);
    assert(at > 0 && until > at, file);
    const addition = text.slice(at, until);
    assert(addition.includes('recoverUnitSidecar') && addition.includes('shared/forge-procedure-recovery.md'));
    assert(/replay[\s\S]*(?:operational refusal|recusa operacional)[\s\S]*(?:abandonment|abandono)[\s\S]*new begin|replay[\s\S]*recusa operacional[\s\S]*abandono[\s\S]*novo begin/.test(addition), file + ' order');
    assert(/same lease\/claim generation|mesma gera/.test(addition));
    assert(/by code|pelo código/.test(addition));
    assert.equal(sha(text.slice(0, at) + text.slice(until)), original, file + ' original bytes preserved');
  }
  const recovery = read('shared/forge-procedure-recovery.md');
  assert(/Replay first:[\s\S]*operational replay-refusal-v1[\s\S]*proved abandonment[\s\S]*new begin/.test(recovery));
  assert(recovery.includes('review-fix limits never enable abandonment'));
});
test('docs-real-Codex-render-preserves-both-recovery-instructions-in-private-root', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-440-docs-'));
  try {
    const projectRoot = path.join(temp, 'project');
    fs.mkdirSync(projectRoot);
    const report = renderer.render({ repo: ROOT, projectRoot,
      codexHome: path.join(temp, 'codex'), forgeHome: path.join(temp, 'forge'),
      ...renderer.PRODUCTION_DISPATCH_DIALECT });
    for (const name of ['forge-auto', 'forge-next']) {
      const artifact = report.artifacts.find(row => row.source.replace(/\\/g, '/').endsWith('skills/' + name + '/SKILL.md'));
      assert(artifact, name);
      assert(artifact.destination.startsWith(temp + path.sep));
      const instruction = artifact.content.slice(artifact.content.indexOf('Receipt `failed` ou `started`:')).split('**Update timeline task**')[0];
      assert(instruction.includes('recoverUnitSidecar') && instruction.includes('adaptador vivo de abandono'));
      assert(instruction.includes('replay → recusa operacional fechada → abandono'));
      assert(instruction.includes('novo begin na mesma geração') && instruction.includes('Nunca relance manualmente com dispatch id novo'));
      assert(instruction.includes('recusas pelo código'));
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test('docs-A7-historical-qualification-and-final-CI-remain-separate', () => {
  for (const text of ['CI44972867644', '4606de1ecac3ddee7bc957d9a8dea3207023d5b5/v4.51.14',
    '575 unidades únicas', '52 suítes-fonte/54 unidades CI', 'Node22.23.5',
    'forge-surgical-reset-backup.test.js (T03)', 'forge-issue-440-recovery.test.js (T06)',
    'gate OBRIGATÓRIO', 'permanece PENDENTE', 'perdeu167 de198 labels',
    '87 consumidores diretos e22 indiretos', 'Nenhum golden', 'revisão independente integral S02']) assert(document.includes(text), text);
  assert.equal((document.match(/\| pass \| PENDENTE \|/g) || []).length, 52);
  assert.equal((document.match(/^\| forge-.*\.test\.js \| 1 \|/gm) || []).length, 18);
});
test('docs-declared-artifacts-are-substantive-and-input-guards-never-authorize-reset', () => {
  assert(document.split('\n').length >= 120);
  assert(read('scripts/forge-issue-440-docs.test.js').split('\n').length >= 150);
  for (const text of ['process-tree-census-v1', 'nunca stopped', 'origem genuína viva',
    'reset-state/S0', 'review-fix', 'Standalone', 'pending-window', 'mock/sintéticas',
    'Recorded exige proveniência', 'CI final, merge, release, instalação e UAT humano permanecem pendentes']) assert(document.includes(text), text);
});
for (const [file, minLines] of [
  ['shared/forge-procedure-recovery.md', 77], ['shared/forge-procedures.json', 940],
  ['shared/forge-dispatch.md', 3310], ['shared/forge-bidirectional-sidecar.md', 1180],
  ['skills/forge-auto/SKILL.md', 2560], ['skills/forge-next/SKILL.md', 2042],
  [DOC, 120], ['scripts/forge-issue-440-docs.test.js', 150], ['CHANGELOG.md', 1647],
  ['scripts/forge-milestone-time-chain.test.js', 850], ['scripts/forge-review-policy-distribution.test.js', 432],
]) {
  test('docs-artifact-' + file + '-exists-substantive-without-stubs', () => {
    const text = read(file);
    assert(text.split('\n').length >= minLines, file);
    for (const stub of ['TO' + 'DO', 'TB' + 'D', 'FIX' + 'ME']) assert(!text.includes(stub), file);
  });
}
function withoutIssue440S03Entry(changelog) {
  const entries = changelog.split('\n').filter(line => line.startsWith("- E2E Windows host Claude → worker Codex e regressão do host Codex (#440, M-20261119115538-revisar-fluxo-execucao, S03):"));
  assert.equal(entries.length, 1, 'one declared #440 S03 entry');
  assert.equal(sha(entries[0] + '\n'), '4e5e159a44459a4b1cd4b029c78fe8365ebe020a6a06749fcb97a6eed967020d', 'declared #440 S03 entry matches measured bytes');
  return changelog.replace(entries[0] + '\n', '');
}
test('docs-S02-changelog-single-measured-line-preserves-every-historical-byte-and-wires-pins', () => {
  const changelog = withoutIssue440S03Entry(read('CHANGELOG.md')), entry = changelog.split('\n')[2];
  assert(entry.startsWith('- Recuperação replay-first e abandono seguro (#440, M-20261119115538-revisar-fluxo-execucao, S02):'));
  assert.equal(sha(entry + '\n'), '6cb3a2c48cf129ae8ac5e29fa79bbd514831057f8c29e774798d7a472a055e76');
  assert.equal(sha(changelog.replace(entry + '\n', '')), '68d384453f0766564d2738b4fa9171f171cb02768b482f77868fe0a5497da931');
  for (const file of ['scripts/forge-milestone-time-chain.test.js', 'scripts/forge-review-policy-distribution.test.js']) {
    const text = read(file);
    assert(text.includes('withoutIssue440Entry(withoutIssue440S02Entry('), file + ' composed filters');
    assert(text.includes('6cb3a2c48cf129ae8ac5e29fa79bbd514831057f8c29e774798d7a472a055e76'));
  }
});
test('docs-S03-changelog-rejects-altered-missing-duplicate', () => {
  const changelog = read('CHANGELOG.md'), entry = changelog.split('\n')[2];
  assert.throws(() => withoutIssue440S03Entry(changelog.replace(entry, entry + ' altered')), /measured bytes/);
  assert.throws(() => withoutIssue440S03Entry(changelog.replace(entry + '\n', '')), /one declared #440 S03 entry/);
  assert.throws(() => withoutIssue440S03Entry(changelog + entry + '\n'), /one declared #440 S03 entry/);
});
console.log(passed + '/' + passed + ' forge-issue-440-docs checks passed (offline, no provider)');
