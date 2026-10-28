'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');
const parent=fs.realpathSync.native(os.tmpdir()),lab=fs.realpathSync.native(fs.mkdtempSync(path.join(parent,'forge-fixture-maintenance-')));
const prior={GIT_CONFIG_GLOBAL:process.env.GIT_CONFIG_GLOBAL,GIT_TRACE2_EVENT:process.env.GIT_TRACE2_EVENT};
let harness;
const git=(cwd,args)=>cp.execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true});
const events=file=>fs.readFileSync(file,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const maintenance=rows=>rows.filter(row=>row.event==='child_start'&&row.argv?.some(value=>value==='maintenance'||value==='gc'));
try{
 const config=path.join(lab,'global-config');
 fs.writeFileSync(config,'[maintenance]\n auto = true\n autoDetach = false\n[gc]\n auto = 1\n autoDetach = false\n');
 process.env.GIT_CONFIG_GLOBAL=config;
 const control=path.join(lab,'control');fs.mkdirSync(control);
 const controlTrace=path.join(lab,'control.jsonl');process.env.GIT_TRACE2_EVENT=controlTrace;
 git(control,['init','-q']);fs.writeFileSync(path.join(control,'source.txt'),'control\n');git(control,['add','.']);
 git(control,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','control']);
 assert(maintenance(events(controlTrace)).length>0,'positive control actually launches automatic maintenance');
 const trace=path.join(lab,'fixture.jsonl');process.env.GIT_TRACE2_EVENT=trace;
 harness=require('./fixtures/forge-native-execution').createFixtureHarness();
 const a=harness.setup(),b=harness.setup();
 for(const f of [a,b]){
  assert.equal(git(f.cwd,['config','--local','--bool','maintenance.auto']).trim(),'false');
  assert.equal(git(f.cwd,['config','--local','gc.auto']).trim(),'0');
  assert.equal(fs.readFileSync(path.join(f.cwd,'src.js'),'utf8'),'before\n');
  assert.equal(fs.readFileSync(path.join(f.cwd,'dirty.txt'),'utf8'),'user dirty\n');
 }
 assert.equal(maintenance(events(trace)).length,0,'fixture setup has no asynchronous maintenance writer');
 assert.notEqual(fs.realpathSync.native(path.join(a.cwd,'.git')),fs.realpathSync.native(path.join(b.cwd,'.git')));
 console.log('PASS private fixture maintenance: real Git positive control, no maintenance child in two complete isolated copies, local policy retained');
}finally{
 if(harness)harness.close(true);
 for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 assert.equal(path.dirname(fs.realpathSync.native(lab)),parent);assert(!fs.lstatSync(lab).isSymbolicLink());
 fs.rmSync(lab,{recursive:true,force:true});
}
