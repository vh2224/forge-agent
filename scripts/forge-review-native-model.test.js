'use strict';
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const api = require('./forge-review-native-model');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-review-native-model-'));
try {
  const agentPath = path.join(dir, 'reviewer.md');
  const write = model => fs.writeFileSync(agentPath, `---\nname: forge-reviewer\nmodel: ${model}\neffort: medium\n---\nRead-only review.\n`);
  const binding = () => ({ agentType: 'forge-reviewer', agentPath,
    sourceFingerprint: crypto.createHash('sha256').update(fs.readFileSync(agentPath)).digest('hex') });
  const capabilities = { available: true, tool: 'Agent', source: 'observed-fixture-schema',
    model_aliases: ['sonnet'], effort_transports: ['agent-frontmatter'] };
  write('claude-sonnet-5');
  const options = { binding: binding(), capabilities, prefs: {}, externalModel: 'gpt-5.6-sol' };
  const result = api.resolve(options);
  assert.equal(result.ok, true); assert.equal(result.model, 'claude-sonnet-5');
  assert.equal(result.model_argument, 'sonnet'); assert.equal(result.external_model, 'gpt-5.6-sol');
  assert.equal(result.provider_called, false);
  assert.equal(api.resolve({ ...options, capabilities: { ...capabilities, model_aliases: [] } }).ok, false);
  assert.equal(api.resolve({ ...options, prefs: { review: { challenge_effort: 'high' } } }).ok, false);
  write('gpt-5.6-sol'); assert.equal(api.resolve({ ...options, binding: binding() }).reason_code, 'review-native-model-incompatible');
  write('claude-sonnet-5'); fs.appendFileSync(agentPath, 'changed\n');
  assert.equal(api.resolve(options).ok, false, 'changed exact definition must refuse before a tool call');
  assert.equal(api.resolve({ ...options, binding: { ...binding(), agentType: 'forge-advocate' } }).ok, false);
  for (const trigger of [1, 2]) {
    write('claude-sonnet-5'); const current={...options,binding:binding()},saved={open:fs.openSync,read:fs.readSync,readFile:fs.readFileSync};
    let fd,count=0,changed=false,total=0;
    fs.openSync=function(file,...args){const actual=saved.open.call(this,file,...args),reading=args[0]==='r'||typeof args[0]==='number'&&(args[0]&3)===fs.constants.O_RDONLY;if(path.resolve(String(file))===agentPath&&reading){count++;fd=actual;}return actual;};
    fs.readFileSync=function(file,...args){assert.notEqual(typeof file==='string'?path.resolve(file):null,agentPath,'all actual observer/preflight reads must remain bounded');return saved.readFile.call(this,file,...args);};
    fs.readSync=function(descriptor,...args){if(descriptor===fd&&count===trigger&&!changed){changed=true;fs.appendFileSync(agentPath,Buffer.alloc(1024*1024+4096,65));}const n=saved.read.call(this,descriptor,...args);if(descriptor===fd&&count===trigger)total+=n;return n;};
    try{const refused=api.resolve(current);assert.equal(refused.ok,false);assert(changed);assert(total>0&&total<=1024*1024+1);}
    finally{fs.openSync=saved.open;fs.readSync=saved.read;fs.readFileSync=saved.readFile;}
  }
  console.log('PASS fallback source growth: first bounded read and subsequent canonical observation refuse with at most1MiB+1 read per descriptor');
  console.log('PASS native review fallback: explicit observed reviewer model, compatible argument, preserved external history, stale/family/capability/effort refusals');
} finally {
  assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(dir, { recursive: true, force: true });
}
