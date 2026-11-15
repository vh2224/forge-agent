'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-sweep-envelope-')));
const memory=require('./forge-memory'),checker=require('./forge-checker-memory');
try{
 fs.mkdirSync(path.join(lab,'.gsd'),{recursive:true});
 const text=fs.readFileSync(path.join(__dirname,'../skills/forge-sweep/SKILL.md'),'utf8');
 const examples=[...text.matchAll(/echo '(\{[^\n]+\})' \\/g)].map(m=>m[1]);
 const auto=JSON.parse(examples.find(x=>x.includes('mem_id')).replaceAll('<owning-unit-id>','T01').replaceAll('<mem_id>','MEM001').replaceAll('<ISO8601>','2026-11-15T00:00:00Z').replaceAll('<below-threshold|single-file-ref>','below-threshold'));
 const check=JSON.parse(examples.find(x=>x.includes('dimension')).replaceAll('<owning-milestone-id>','M001').replaceAll('<dimension>','security').replaceAll('<slice>','S01').replaceAll('<ISO8601>','2026-11-15T00:00:00Z'));
 memory.writeFragment(lab,{unit_id:'T01',milestone_id:'M001',facts:[{mem_id:'MEM001',category:'pattern',text:'Synthetic memory',created_at:'2026-10-01T00:00:00Z',source_unit:'T01'}],stats:[]});
 const qualified=memory.fragmentPath(lab,'T01',{milestoneId:'M001'});
 for(const [name,payload] of [['forge-memory',{...auto,milestone_id:'M001'}],['forge-memory',{...auto,unit_id:'T-20261115000000-standalone'}],['forge-checker-memory',check]]){
  const result=cp.spawnSync(process.execPath,[path.join(__dirname,name+'.js'),'--write','--cwd',lab],{input:JSON.stringify(payload),encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);
 }
 assert(fs.readFileSync(qualified,'utf8').includes('prune'));assert(!fs.existsSync(memory.fragmentPath(lab,'T01')),'milestone prune must not create standalone T01 fragment');
 assert(fs.readFileSync(checker.fragmentPath(lab,'M001'),'utf8').includes('prune'));
 console.log('PASS documented standalone and milestone AUTO-MEMORY envelopes and CHECKER-MEMORY prune CLI');
}finally{assert.equal(path.dirname(lab),fs.realpathSync.native(os.tmpdir()));fs.rmSync(lab,{recursive:true,force:true});}
