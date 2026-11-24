'use strict';const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const clock=require('./forge-milestone-time-clock'),fixture=require('./fixtures/completion-delivery.cjs');let passed=0,failed=0;
function test(name,fn){const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'forge-glob-delivery-'));try{fn(cwd);passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+' '+e.stack);}finally{fs.rmSync(cwd,{recursive:true,force:true});}}
function git(cwd,args){return cp.execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true}).trim();}
function setup(cwd,writes,ignore='node_modules/\n.gsd/\n'){const o={milestone:'M001',slice:'S01',task:'T01'},f=fixture.prepare(cwd,o);fs.writeFileSync(path.join(cwd,'.gitignore'),ignore);git(cwd,['add','.gitignore','src/T01.js']);git(cwd,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture sources']);let text=fs.readFileSync(f.planFile,'utf8').replace('writes: [src/T01.js]','writes: ['+writes+']');fs.writeFileSync(f.planFile,text);const begunAt=Date.now()-1000;fixture.publish(cwd,{...o,at:new Date().toISOString()});return{cwd,...o,begunAt,completedAt:Date.now()+1000};}
function withInventory(cwd,o){
 const f=fixture.prepare(cwd,o),snapshot=require('./forge-surgical-reset').captureAttemptSnapshot(cwd),inventory=require('./forge-delivery-source-policy').capture(cwd,snapshot);
 for(const suffix of ['VERIFY-ENVELOPE','ARTIFACT-ENVELOPE']){const file=path.join(cwd,f.base,o.task+'-'+suffix+'.json'),envelope=JSON.parse(fs.readFileSync(file,'utf8'));Object.assign(envelope,{revision:snapshot.start_sha,workspace:snapshot.pre_dirty,source_inventory:inventory});fs.writeFileSync(file,JSON.stringify(envelope));}
 const input=JSON.parse(fs.readFileSync(path.join(cwd,f.base,o.task+'-DELIVERY-INPUT.json'),'utf8'));
 fs.writeFileSync(path.join(cwd,f.base,o.task+'-DELIVERY.json'),JSON.stringify(require('./forge-delivery').buildDelivery(input,{ownerRoot:cwd,codeDir:cwd})));
 return{f,inventory,snapshot};
}
test('ignored install glob is admitted while concrete source remains strict',cwd=>{const o=setup(cwd,'src/T01.js, node_modules/**');fs.mkdirSync(path.join(cwd,'node_modules/pkg'),{recursive:true});fs.writeFileSync(path.join(cwd,'node_modules/pkg/index.js'),'ignored dependency');const r=clock.readCurrentTaskDelivery(o);assert.equal(r.status,'proven',JSON.stringify(r));fs.appendFileSync(path.join(cwd,'src/T01.js'),'//changed');assert.equal(clock.readCurrentTaskDelivery(o).status,'unproven');});
test('source glob binds concrete captured files and detects new files/removal',cwd=>{const o=setup(cwd,'src/**');assert.equal(clock.readCurrentTaskDelivery(o).status,'proven');fs.writeFileSync(path.join(cwd,'src/new.js'),'new');assert.equal(clock.readCurrentTaskDelivery(o).status,'unproven');fs.unlinkSync(path.join(cwd,'src/new.js'));fs.unlinkSync(path.join(cwd,'src/T01.js'));assert.equal(clock.readCurrentTaskDelivery(o).status,'unproven');assert.equal(clock.readHistoricalTaskDelivery(o).status,'proven','history uses captured universe, never current glob expansion');});
test('empty unproved glob and traversal are refused',cwd=>{let o=setup(cwd,'src/T01.js, missing/**');assert.equal(clock.readCurrentTaskDelivery(o).status,'unproven');const f=fixture.prepare(cwd,o);fs.writeFileSync(f.planFile,fs.readFileSync(f.planFile,'utf8').replace('missing/**','../outside/**'));assert.throws(()=>fixture.publish(cwd,o),/fixture-delivery-unproven/);assert.equal(clock.readCurrentTaskDelivery(o).status,'unproven');});
test('changed ignore policy cannot exclude new source',cwd=>{const o=setup(cwd,'src/T01.js, node_modules/**');fs.writeFileSync(path.join(cwd,'.gitignore'),'.gsd/\n');assert.equal(clock.readCurrentTaskDelivery(o).status,'unproven');});
test('added source during proof is caught by final universe recheck',cwd=>{const o=setup(cwd,'src/**, node_modules/**');let changed=false;const revisionBlobReader=(root,revision,relative)=>{if(!changed){changed=true;fs.writeFileSync(path.join(cwd,'src/race.js'),'raced');}return{ok:true,hash:git(root,['rev-parse',revision+':'+relative])};};assert.equal(clock.readCurrentTaskDelivery({...o,revisionBlobReader}).status,'unproven');assert.equal(changed,true);});
test('ignored concrete required source is never excluded',cwd=>{const o=setup(cwd,'src/T01.js, node_modules/required.js');assert.equal(clock.readCurrentTaskDelivery(o).status,'unproven');});
test('ignored secret glob cannot bypass concrete coverage',cwd=>{const o=setup(cwd,'src/T01.js, secret/**');fs.appendFileSync(path.join(cwd,'.gitignore'),'secret/\n');fs.mkdirSync(path.join(cwd,'secret'));fs.writeFileSync(path.join(cwd,'secret/key.js'),'source');assert.equal(clock.readCurrentTaskDelivery(o).status,'unproven');});
test('mixed visible and ignored source glob requires all concrete bindings',cwd=>{const o=setup(cwd,'src/**');fs.appendFileSync(path.join(cwd,'.gitignore'),'src/private.js\n');fs.writeFileSync(path.join(cwd,'src/private.js'),'not captured');assert.equal(clock.readCurrentTaskDelivery(o).status,'unproven');});
test('captured ignore inventory admits common basename and wildcard rules in source globs',cwd=>{
 const o=setup(cwd,'src/**, node_modules/**','node_modules/\n.gsd/\n*.tsbuildinfo\ncoverage/\n');
 assert.equal(clock.readHistoricalTaskDelivery(o).status,'unproven','legacy ambiguous capture remains fail closed');
 withInventory(cwd,o);assert.equal(clock.readCurrentTaskDelivery(o).status,'proven');assert.equal(clock.readHistoricalTaskDelivery(o).status,'proven');
 fs.writeFileSync(path.join(cwd,'src/cache.tsbuildinfo'),'new hidden source');
 assert.equal(clock.readCurrentTaskDelivery(o).status,'unproven','new ignored source is not silently excluded');
 assert.equal(clock.readHistoricalTaskDelivery(o).status,'proven','history never consults current ignored source');
});
test('inventory captures matching ignored source and refuses its missing binding',cwd=>{
 const o=setup(cwd,'src/**','node_modules/\n.gsd/\n*.tsbuildinfo\ncoverage/\n');fs.writeFileSync(path.join(cwd,'src/cache.tsbuildinfo'),'hidden');
 const {inventory}=withInventory(cwd,o);assert.deepEqual(inventory.ignored,['src/cache.tsbuildinfo']);
 assert.equal(clock.readCurrentTaskDelivery(o).status,'unproven');assert.equal(clock.readHistoricalTaskDelivery(o).status,'unproven');
});
test('captured inventory binds exact revision, overlay and digest without consulting live ignores',cwd=>{
 const o=setup(cwd,'src/**','node_modules/\n.gsd/\n*.tsbuildinfo\ncoverage/\n'),{snapshot,inventory}=withInventory(cwd,o);
 const envelope={revision:snapshot.start_sha,workspace:snapshot.pre_dirty,source_inventory:inventory},expand=require('./forge-delivery-source-scope').expand;
 assert(expand(cwd,envelope,['src/**']).paths.includes('src/T01.js'));
 for(const changed of [{...inventory,ignored:['src/hidden.js']},{...inventory,revision:'a'.repeat(40)},{...inventory,workspace_sha256:'0'.repeat(64)}])assert.throws(()=>expand(cwd,{...envelope,source_inventory:changed},['src/**']),/delivery-source-inventory-invalid/);
 fs.writeFileSync(path.join(cwd,'.gitignore'),'src/**\n');fs.unlinkSync(path.join(cwd,'src/T01.js'));
 assert.equal(clock.readHistoricalTaskDelivery(o).status,'proven');assert.equal(clock.readCurrentTaskDelivery(o).status,'unproven');
});
test('inventory capture excludes install/control trees and refuses a raced source snapshot',cwd=>{
 const o=setup(cwd,'src/**','node_modules/\n.gsd/\n*.tsbuildinfo\ncoverage/\n');
 fs.mkdirSync(path.join(cwd,'node_modules/pkg'),{recursive:true});fs.writeFileSync(path.join(cwd,'node_modules/pkg/ignored.js'),'installation');
 fs.mkdirSync(path.join(cwd,'coverage'),{recursive:true});fs.writeFileSync(path.join(cwd,'coverage/result.txt'),'diagnostic');
 const snapshot=require('./forge-surgical-reset').captureAttemptSnapshot(cwd),policy=require('./forge-delivery-source-policy');
 assert.deepEqual(policy.capture(cwd,snapshot).ignored,['coverage/result.txt']);
 fs.appendFileSync(path.join(cwd,'.gitignore'),'src/hidden.js\n');
 assert.throws(()=>policy.capture(cwd,snapshot),/delivery-source-policy-unproven/);
});
console.log(JSON.stringify({passed,failed}));if(failed)process.exitCode=1;
