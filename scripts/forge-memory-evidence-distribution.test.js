#!/usr/bin/env node
'use strict';

// Local distribution evidence only: no real host/profile/provider is contacted.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const installer = require('./forge-installer');
const evidence = require('./forge-memory-evidence');
const { canonicalProcedureBytes, loadProcedureContext } = require('./forge-procedure-context');
const repo = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}

test('auto and next link the single selected payload to --expose and real dispatchId after positive delivery', () => {
  for (const skill of ['auto', 'next']) {
    const source = read(`skills/forge-${skill}/SKILL.md`);
    const section = source.slice(source.indexOf('**Selective memory injection**'), source.indexOf('**Fallback:**', source.indexOf('**Selective memory injection**')));
    assert.strictEqual((section.match(/_mem_json=\$\(node/g) || []).length, 1);
    assert(!section.includes('--hit'));
    assert(section.includes('--expose --event-id "$DISPATCH_ID"'));
    assert(section.includes('"$DELIVERY_CONFIRMED" = true'));
    assert(section.includes('actual dispatch returns positive evidence'));
    assert(section.includes('subset of `_mem_json.entries`'));
    assert(section.includes('dispatchId'));
    assert(section.includes('records zero'));
    assert(section.includes('matched_terms*100 + category_preference*10'));
  }
});

test('agent v2 example validates and requires owner references, reobserve, independent confirmation and outcome utility', () => {
  const agent = read('agents/forge-memory.md');
  const example = JSON.parse(agent.match(/```json\s*([\s\S]*?)```/)[1]);
  const validated = evidence.validateExtractionV2(example);
  assert.strictEqual(validated.schema_version, 2);
  assert.deepStrictEqual(validated.events.slice(0, 3).map(row => row.kind), ['reobserve', 'confirm', 'utility']);
  assert(agent.includes('shared/schemas/memory-extraction-v2.schema.json'));
  assert(agent.includes('at least three independent confirmations'));
  assert(agent.includes('Never invent a reference'));
  assert(agent.includes('omit the event'));
  assert(agent.includes('Legacy hits never satisfy'));
});

test('memory procedure digest matches final canonical bytes and loader consumes v2 rules', () => {
  const manifest = JSON.parse(read('shared/forge-procedures.json'));
  const memory = manifest.modules.find(row => row.id === 'memory');
  const digest = crypto.createHash('sha256').update(canonicalProcedureBytes(Buffer.from(read(memory.path)))).digest('hex');
  assert.strictEqual(memory.sha256, digest);
  const context = loadProcedureContext({ cwd: repo, forgeHome: repo, phase: 'memory-extract' });
  assert(context.content.includes('Duplicate observation becomes reobserve'));
  assert(context.content.includes('utility requires outcome'));
});

test('manifest source IDs and consumer inventory cover canonical memory distribution surfaces', () => {
  const manifest = JSON.parse(read('forge-source-manifest.json'));
  for (const id of ['agents', 'skills', 'procedures']) assert(manifest.sources.some(row => row.source_id === id));
  const inventory = read('shared/forge-memory-evidence.md');
  for (const surface of ['forge-memory-evidence.js', 'forge-memory.js', 'forge-memory-extraction.js',
    'forge-projection.js', 'forge-unit-sidecar.js', 'forge-worker-result-contract.js',
    'memory-extraction.schema.json', 'memory-extraction-v2.schema.json', 'agents/forge-memory.md',
    'forge-auto/SKILL.md', 'forge-next/SKILL.md', 'forge-memories/SKILL.md',
    'forge-procedure-memory.md', 'forge-procedures.json', 'forge-claude-renderer.js',
    'forge-codex-renderer.js', 'forge-installer.js', 'forge-source-manifest.json']) assert(inventory.includes(surface), surface);
});

test('memories management uses canonical projection, separates legacy/exposure/confirmation/utility and preserves additive ranking', () => {
  const skill = read('skills/forge-memories/SKILL.md');
  for (const text of ['forge-projection.js', 'legacy_ambiguous', 'exposures', 'reobservations',
    'independent_confirmation_count', 'outcome-bound utility', 'A hit is not proof of usefulness',
    'matched_terms*100 + category_preference*10 + confidence*max(1,hits)',
    'Exposure and utility never add ranking weight', 'preserve fragment history']) {
    assert(skill.includes(text), text);
  }
});

test('real installer projects both hosts, preserves external bytes and fresh installed runtime decodes v1/v2', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-distribution-'));
  try {
    const forgeHome = path.join(root, 'Forge Home');
    const claudeHome = path.join(root, 'Claude Home');
    const codexHome = path.join(root, 'Codex Home');
    const projectRoot = path.join(root, 'Project');
    const sentinel = Buffer.from('# user-owned\r\n<!-- user:memory:start -->\r\nexternal bytes\r\n<!-- user:memory:end -->\r\n');
    for (const home of [claudeHome, codexHome, projectRoot]) {
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, 'user-memory.md'), sentinel);
    }
    const options = { repo, forgeHome, claudeHome, codexHome, projectRoot,
      userHome: root, skipCapabilityCheck: true, runtime: 'both',
      codexQuestionBinary: 'fixture-codex', questionSpawnSync: () => ({ status: 0, stdout: '' }) };
    installer.install(options);
    installer.install({ ...options, update: true });
    for (const home of [claudeHome, codexHome, projectRoot]) {
      assert(fs.readFileSync(path.join(home, 'user-memory.md')).equals(sentinel));
    }
    for (const [host, home, suffix] of [['claude', claudeHome, 'md'], ['codex', codexHome, 'toml']]) {
      const agent = fs.readFileSync(path.join(home, 'agents', `forge-memory.${suffix}`), 'utf8');
      assert(agent.includes('schema_version'));
      assert(agent.includes('memory-extraction-v2.schema.json'));
      assert(agent.includes('reobserve'));
      for (const skill of ['auto', 'next', 'memories']) {
        const content = fs.readFileSync(path.join(home, 'skills', `forge-${skill}`, 'SKILL.md'), 'utf8');
        assert(content.includes(skill === 'memories' ? 'independent_confirmation_count' : '--expose --event-id'));
      }
      const child = spawnSync(process.execPath, ['-e', `
        const assert=require('assert'),path=require('path');
        const base=process.argv[1];
        const x=require(path.join(base,'scripts/forge-xllm'));
        const e=require(path.join(base,'scripts/forge-memory-evidence'));
        for(const version of [1,2]) {
          const name=version===1?'memory-extraction.schema.json':'memory-extraction-v2.schema.json';
          assert.strictEqual(x.loadSchemaFile(name).properties.schema_version.const,version);
          assert.strictEqual(e.validateExtraction({schema_version:version,status:'done',summary:'',questions:[],facts:[],events:[]}).schema_version,version);
        }
        const sidecar=require(path.join(base,'scripts/forge-unit-sidecar'));
        assert.strictEqual(sidecar.memorySchemaV2.properties.schema_version.const,2);
        const local={kind:'exposure',evidence_version:2,event_id:'local:v2:exposure',
          extraction_id:'local',local_event_id:'exposure',ts:'2026-10-25T00:00:00.000Z',
          mem_id:'MEM001',provenance:'legacy-invocation-only',invocation_id:'call-1'};
        assert.strictEqual(e.normalizeEvidenceEvent(local).origin,'v2');
        assert.strictEqual(e.normalizeEvidenceEvent(local).observation_id,null);
        assert.strictEqual(e.normalizeEvidenceEvent({...local,observation_id:'invented'}).origin,'invalid');
        const loader=require(path.join(base,'scripts/forge-procedure-context'));
        const c=loader.loadProcedureContext({cwd:base,forgeHome:base,phase:'memory-extract'});
        assert(c.content.includes('Duplicate observation becomes reobserve'));
        assert(c.content.includes('closed legacy-invocation-only exposure'));
        console.log('installed schemas v1/v2, decoder, sidecar and mandatory memory loader verified');
      `, forgeHome], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      assert.strictEqual(child.status, 0, child.stderr);
      assert(child.stdout.includes('installed schemas v1/v2'));
      console.log(`  ${host}: installed agent/skills, runtime schemas/decoder/loader and external bytes verified`);
    }
  } finally {
    // Delete only this suite's mkdtemp root after checking containment.
    assert(path.dirname(root) === os.tmpdir());
    fs.rmSync(root, { recursive: true, force: true });
  }
});

console.log(`${passed} distribution checks passed`);
