'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process');
const runs=require('./forge-runs'),saved={...process.env};
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-step-run-')));
try{
 for(const host of ['codex','claude']){
  const cwd=path.join(lab,host);fs.mkdirSync(path.join(cwd,'.gsd'),{recursive:true});
  Object.assign(process.env,{CODEX_THREAD_ID:'step-'+host,FORGE_CLAUDE_OWNER_SESSION_ID:'step-'+host,FORGE_CLAUDE_OWNER_SOURCE:'claude-sessionstart-env-v1'});
  const first=runs.ensureStepRun(cwd,'M001',host);assert.equal(first.kind,'milestone');assert.equal(first.host_runtime,host);
  runs.update(cwd,'M001',{worktrees:[{path:'preserved-metadata'}]});
  const before=fs.readFileSync(runs.runFile(cwd,'M001'));
  runs.ensureStepRun(cwd,'M001',host);assert(fs.readFileSync(runs.runFile(cwd,'M001')).equals(before));
  const result=cp.spawnSync(process.execPath,[path.join(__dirname,'forge-runs.js'),'--heartbeat','--observed-owner','--host-runtime',host,
    ...(host==='claude'?['--expected-owner-session',process.env.FORGE_CLAUDE_OWNER_SESSION_ID]:[]),'--run','M001','--worker','estimate-milestone/M001','--cwd',cwd],{encoding:'utf8',windowsHide:true,env:{...process.env}});
  assert.equal(result.status,0,result.stderr);assert.equal(runs.get(cwd,'M001').worker,'estimate-milestone/M001');
  const held=fs.readFileSync(runs.runFile(cwd,'M001'));process.env.CODEX_THREAD_ID='foreign';process.env.FORGE_CLAUDE_OWNER_SESSION_ID='foreign';
  assert.throws(()=>runs.ensureStepRun(cwd,'M001',host),/step-run-owner-mismatch/);assert(fs.readFileSync(runs.runFile(cwd,'M001')).equals(held));
 }
 console.log('PASS both hosts bootstrap first step run/heartbeat, preserve metadata and refuse foreign owners');
}finally{process.env=saved;assert.equal(path.dirname(lab),fs.realpathSync.native(os.tmpdir()));fs.rmSync(lab,{recursive:true,force:true});}
