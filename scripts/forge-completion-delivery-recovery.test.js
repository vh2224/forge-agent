'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const lab=require('./forge-code-roots.test'),fixtures=require('./fixtures/completion-delivery.cjs');
const controller=require('./forge-unit-controller'),orchestrate=require('./forge-orchestrate'),clock=require('./forge-milestone-time-clock');
const api=require('./forge-completion-delivery-recovery'),claims=require('./forge-write-claim'),runs=require('./forge-runs');
let count=0;
for(const host of ['claude','codex'])for(const mode of ['auto','step']){
 const f=lab.fixture(),oldEnv={...process.env};try{
  const home=path.join(f.dir,'home');fs.mkdirSync(home);Object.assign(process.env,{HOME:home,USERPROFILE:home,FORGE_HOME:path.join(home,'core')});
  fs.mkdirSync(path.join(f.owner,'.gsd'),{recursive:true});fs.writeFileSync(path.join(f.owner,'.gsd/forge-prefs.jsonc'),'{}');
  const milestone='M001',slice='S01',task='T01',unit='execute-task/T01',ownerToken='fixture-owner',runId='T-20261116000000-delivery-fixture';
  const inventory={roadmap_exists:true,context_exists:true,research_exists:true,slices:[{id:slice,checked:false,plan_exists:true,research_exists:true,tasks:[{id:task,checked:false}]}],milestone_complete:false};
  const prefsReader=()=>({ok:true,prefs:{workflow:{skip_discuss:true,skip_research:true}}}),base=Date.now()-10000;
  let now=base;const controllerOptions={prefsReader,inventoryReader:()=>inventory,now:()=>now};
  fs.mkdirSync(path.join(f.owner,'.gsd/milestones',milestone),{recursive:true});
  require('./forge-state').write(f.owner,{milestone,phase:'idle',active_slice:slice,active_task:'—',auto_mode:'off'});
  const files=fixtures.prepare(f.owner,{milestone,slice,task,codeDir:f.a});
  runs.add(f.owner,{id:runId,kind:'task',session_id:'fixture-'+host+'-'+mode,active:true,host_runtime:host,root:f.owner,cwd:f.owner});
  claims.recordClaim(f.owner,runId,{unit,source:'manual',code_dir:f.a,paths:[files.source]});
  const key=`forge-orchestrate-next:${milestone}:${unit}:${slice}`;
  const begin=controller.begin(f.owner,{milestone,unit,slice,host_runtime:host,owner_token:ownerToken,idempotency_key:key,state_patch:{active_slice:slice}},controllerOptions);assert(begin.ok);
  const input={cwd:f.owner,milestone,unit,host_runtime:host,owner_token:ownerToken,begin_key:key,result:{status:'done'}};
  now=base+100;
  if(!process.argv.includes('--restart-only')){
   fixtures.publish(f.owner,{milestone,slice,task,codeDir:f.a,at:new Date(base-1).toISOString()});
   assert.equal(orchestrate.run('complete',input,controllerOptions).reason_code,'execution-delivery-required','prior capture must not complete a new begin');
   fixtures.publish(f.owner,{milestone,slice,task,codeDir:f.a,at:new Date(base+50).toISOString()});
   const source=path.join(f.a,files.source),bytes=fs.readFileSync(source);fs.appendFileSync(source,'// after verification\n');
   assert.equal(orchestrate.run('complete',input,controllerOptions).reason_code,'execution-delivery-required','changed current source must not use a stale verification');fs.writeFileSync(source,bytes);
   for(const name of ['DELIVERY.json','DELIVERY-INPUT.json','VERIFY-ENVELOPE.json','ARTIFACT-ENVELOPE.json']){
    const target=path.resolve(f.owner,files.base,task+'-'+name);assert(target.startsWith(path.resolve(f.owner)+path.sep));fs.unlinkSync(target);
   }
   count+=2;
  }
  const refused=orchestrate.run('complete',input,controllerOptions);assert.equal(refused.reason_code,'execution-delivery-required');assert.equal(controller.lookupRecord(f.owner,'transaction',key+':complete'),null);assert(controller.dependencies.forgeLease.observe(f.owner,unit).lease);count++;
  // Reproduce the immutable completion an older release could commit.
  controller.complete(f.owner,{milestone,unit,host_runtime:host,owner_token:ownerToken,generation:begin.generation,idempotency_key:key+':complete',result:{status:'succeeded'}},controllerOptions);
  const original=JSON.stringify(controller.lookupRecord(f.owner,'transaction',key+':complete'));
  const loop=require('./forge-long-workflow-adapter'),decision=loop.invoke(host,mode,'next',{cwd:f.owner,milestone,workflow_id:'repair-'+host+'-'+mode,owner_token:ownerToken,prefsReader,inventory},undefined,controllerOptions).result;
  assert.equal(decision.reason_code,'execution-delivery-recovery-required');count++;
  const loopInput={cwd:f.owner,milestone,workflow_id:'repair-'+host+'-'+mode,owner_token:ownerToken,prefsReader,inventory};
  assert.equal(loop.invoke(host,mode,'resume-delivery',{...loopInput,repair_begin_key:'forged'},decision.snapshot,controllerOptions).result.outcome,'blocked');count++;
  const contract=require('./forge-code-roots').validateContract({...f.contract,code_roots:[f.contract.code_roots[0]]});
  let stopped=true,questions=[],authority=true;
  const options={cwd:f.owner,milestone,slice,task,runId,ownerToken,hostRuntime:host,beginKey:key,completionKey:key+':complete',executionContract:contract,controllerOptions,
   assertAuthority:()=>{if(!authority)throw Error('fixture-authority-revoked');},attestStoppedWriter:()=>stopped,readPendingQuestions:()=>questions};
  assert.throws(()=>api.createRepair({...options,attestStoppedWriter:undefined}),/live-adapter-required/);
  assert.throws(()=>api.createRepair({...options,assertAuthority:()=>({approved:true})}),/authority-required/);count++;
  stopped=false;assert.throws(()=>api.createRepair(options),/writer-not-stopped/);stopped=true;
  questions=[{id:'needed',status:'pending'}];assert.throws(()=>api.createRepair(options),/pending-questions/);questions=[];count+=3;
  now=base+1000;const repair=api.createRepair(options),started=repair.start();assert.equal(started.action,'verify-only');assert.notEqual(started.begin_key,key);
  const baselineFile=path.resolve(f.owner,files.base,'.delivery-verification-'+repair.scope.original_sha256+'.json');assert(baselineFile.startsWith(path.resolve(f.owner)+path.sep));
  const baselineBytes=fs.readFileSync(baselineFile);fs.unlinkSync(baselineFile);
  assert.throws(()=>api.createRepair(options),/baseline-missing/);fs.writeFileSync(baselineFile,baselineBytes,{flag:'wx'});
  const replaced=JSON.parse(baselineBytes);replaced.created_at=new Date(Date.parse(replaced.created_at)+1).toISOString();fs.writeFileSync(baselineFile,JSON.stringify(replaced));
  assert.throws(()=>api.createRepair(options),/baseline-changed/);fs.writeFileSync(baselineFile,baselineBytes);
  assert.throws(()=>api.createRepair({...options,ownerToken:'foreign-owner'}),/baseline-invalid/);count++;
  const alias=baselineFile+'.alias';fs.linkSync(baselineFile,alias);assert.throws(()=>api.createRepair(options),/baseline-invalid/);fs.unlinkSync(alias);count+=3;
  assert.throws(()=>repair.complete(),/current-capture-required/);
  stopped=false;assert.throws(()=>repair.complete(),/writer-not-stopped/);stopped=true;
  questions=[{id:'late-question',status:'pending'}];assert.throws(()=>repair.complete(),/pending-questions/);questions=[];
  authority=false;assert.throws(()=>repair.complete(),/authority-required/);authority=true;
  const sourceFile=path.join(f.a,files.source),sourceBytes=fs.readFileSync(sourceFile);fs.appendFileSync(sourceFile,'// foreign writer\n');
  assert.throws(()=>repair.complete(),/code-changed/);
  assert.throws(()=>api.createRepair(options),/code-changed/,'restart must revalidate the original persisted baseline');fs.writeFileSync(sourceFile,sourceBytes);count++;
  assert.equal(api.createRepair(options).start().begin_key,started.begin_key,'unchanged host restart resumes the same original baseline');count++;
  const oldFile=controller.transactionFile(f.owner,key+':complete'),oldBytes=fs.readFileSync(oldFile),foreign=JSON.parse(oldBytes);foreign.result.output={foreign:true};fs.writeFileSync(oldFile,JSON.stringify(foreign));
  assert.throws(()=>repair.complete(),error=>['delivery-repair-original-changed','record-conflict'].includes(error.code));fs.writeFileSync(oldFile,oldBytes);
  assert.equal(controller.lookupRecord(f.owner,'transaction',started.completion_key),null);count+=6;
  fixtures.publish(f.owner,{milestone,slice,task,codeDir:f.a,at:new Date(base+2000).toISOString()});
  assert.equal(clock.readHistoricalTaskDelivery({cwd:f.owner,milestone,slice,task,completedAt:base+100}).reason,'delivery-capture-time-invalid');
  now=base+3000;assert.equal(repair.complete().outcome,'completed');
  const ownerProof=controller.lookupRecord(f.owner,'transaction',started.completion_key).result.output.owner_delivery_proof;
  assert.equal(ownerProof.begin_key,started.begin_key);assert.equal(ownerProof.current_source_conformity,'matched');count++;
  assert.equal(JSON.stringify(controller.lookupRecord(f.owner,'transaction',key+':complete')),original);
  assert.equal(clock.readHistoricalTaskDelivery({cwd:f.owner,milestone,slice,task,completedAt:now}).status,'proven');count+=4;
  assert.equal(repair.start().status,'completed');count++;
  const pendingSnapshot={...decision.snapshot,pending_questions:[{id:'functional',question:'Still needed',status:'pending'}]};
  assert.equal(loop.invoke(host,mode,'resume-delivery',{...loopInput,repair_begin_key:started.begin_key},pendingSnapshot,controllerOptions).result.reason_code,'pending-questions');count++;
  const cli=require('child_process').spawnSync(process.execPath,[path.join(__dirname,'forge-orchestrate.js'),'--resume-delivery','--json',JSON.stringify({...loopInput,host_runtime:host,delivery_block:decision.snapshot.delivery_block,repair_begin_key:started.begin_key})],{encoding:'utf8',windowsHide:true});
  assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).reason_code,'delivery-recovery-ready');count++;
  const resumed=loop.invoke(host,mode,'resume-delivery',{...loopInput,repair_begin_key:started.begin_key},JSON.parse(JSON.stringify(decision.snapshot)),controllerOptions).result;
  assert.equal(resumed.outcome,'resumed');assert.equal(resumed.snapshot.lifecycle,'idle');assert.equal(resumed.snapshot.workflow_id,decision.snapshot.workflow_id);
  assert.equal(resumed.snapshot.step_count,decision.snapshot.step_count);assert.equal(resumed.snapshot.max_steps,decision.snapshot.max_steps);count++;
 }finally{process.env=oldEnv;f.cleanup();}
}
console.log(`PASS ${count} completion-delivery controls: both hosts/auto/step, pre-intent refusal, retained lease, immutable old completion, stopped-writer/questions and fresh verification-only successor`);
