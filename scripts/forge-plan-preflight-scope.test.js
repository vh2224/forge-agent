#!/usr/bin/env node
'use strict';
// Hermetic scope regression: synthetic responses, no native/provider invocation.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-plan-scope-')));
const old={HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE};
process.env.HOME=process.env.USERPROFILE=path.join(lab,'profile');fs.mkdirSync(process.env.HOME);
const unit=require('./forge-unit-sidecar'),prep=require('./forge-task-preparation');
const original=prep.preflightPlan;let calls=0;
prep.preflightPlan=()=>{calls++;throw Object.assign(new Error('fixture-standalone-plan-refused'),{code:'fixture-standalone-plan-refused'});};
const plan='---\ntier: standard\neffort: medium\ndepends: []\nwrites: [scripts/x.js]\nexpected_output: [scripts/x.js]\nmust_haves:\n  truths: [Observable result]\n  artifacts: []\n  key_links: []\n---\n\n## Steps\nImplement the scoped output.\n## Must-Haves\nObservable result.\n## Standards\nReuse helpers.\n## Files to Change\nscripts/x.js\n';
function fixture(scope,phase,label){
 const owner=path.join(lab,label,'owner'),code=path.join(lab,label,'code'),out=path.join(lab,label,'out');
 for(const p of [path.join(owner,'.gsd'),code,out])fs.mkdirSync(p,{recursive:true});
 const request={unitType:'plan-milestone',scope,phase,milestoneId:'M001',cwd:code,contextRoot:owner,workflowId:label,dispatchId:label,resultFile:path.join(out,'result.json')};
 if(scope==='standalone-task'){delete request.milestoneId;Object.assign(request,{taskId:'T-20261119000000-fixture',hostRuntime:'codex'});}
 const target=unit.locations(request).required[0];
 const content=scope==='standalone-task'?plan:'# M001: Scope fixture\n\n## Slices\n\n- [ ] **S01: Observable output** `risk:low` `depends:[]`\n\n## Boundary Map\n\nS01 produces the observable output.\n';
 return{request,target,content,response:{status:'done',summary:'Synthetic scoped plan.',questions:[],artifacts:[{path:target,content}]}};
}
(async()=>{
 try{
  for(const phase of ['plan',undefined]){
   const f=fixture('milestone',phase,'milestone-'+(phase||'implicit'));unit.beginArtifactAttempt(f.request);
   const accepted=await unit.acceptArtifactResult(f.request,f.response,{providerCalled:true});
   assert.equal(accepted.record.phase,'ready');assert.equal(calls,0,'milestone cannot invoke standalone execution preflight');
   assert.equal(fs.readFileSync(path.join(f.request.contextRoot,f.target),'utf8'),f.content);
   const replayed=await unit.replayArtifactAttempt(f.request);assert.equal(replayed.replayed,true);assert.equal(calls,0);
   console.log('PASS milestone '+(phase||'implicit')+' publication and ready replay preserve scope');
  }
  const f=fixture('standalone-task','plan','standalone');unit.beginArtifactAttempt(f.request);
  await assert.rejects(unit.acceptArtifactResult(f.request,f.response,{providerCalled:true}),e=>e.code==='fixture-standalone-plan-refused');
  assert.equal(calls,1);assert.equal(fs.existsSync(path.join(f.request.contextRoot,f.target)),false);
  assert.equal(JSON.parse(fs.readFileSync(f.request.resultFile+'.receipt.json')).phase,'started');
  console.log('PASS standalone preflight refusal stays enforcing before publication');
 }finally{
  prep.preflightPlan=original;for(const [k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  const physical=fs.realpathSync.native(lab);assert.equal(path.dirname(physical),fs.realpathSync.native(os.tmpdir()));assert(path.basename(physical).startsWith('forge-plan-scope-'));fs.rmSync(physical,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
