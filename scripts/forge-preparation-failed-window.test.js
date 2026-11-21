'use strict';
// Real CLI handles, local synthetic repositories, no provider or account access.
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-failed-preparation-'))),saved={...process.env};
process.env.HOME=process.env.USERPROFILE=path.join(lab,'home');fs.mkdirSync(process.env.HOME);
const windows=require('./forge-owner-transport-window'),runs=require('./forge-runs'),prep=require('./forge-task-preparation'),roots=require('./forge-code-roots'),doctor=require('./forge-doctor');
const owners=[];let seq=0,passed=0,providerCalls=0;
function command(bin,args,cwd){const r=cp.spawnSync(bin,args,{cwd,encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024});assert.equal(r.status,0,r.stderr);return r.stdout;}
function fixture(host){
 const base=path.join(lab,'case-'+(++seq)),owner=path.join(base,'owner'),code=path.join(base,'code');fs.mkdirSync(path.join(owner,'.gsd'),{recursive:true});fs.mkdirSync(code,{recursive:true});owners.push(owner);
 command('git',['init','-q'],code);command('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','base'],code);
 process.env.CODEX_THREAD_ID='fixture-codex';process.env.FORGE_CLAUDE_OWNER_SESSION_ID='fixture-claude';process.env.FORGE_CLAUDE_OWNER_SOURCE='claude-sessionstart-env-v1';
 const model=host==='codex'?'gpt-5.6-sol':'claude-sonnet-5-5';
 fs.writeFileSync(path.join(owner,'.gsd/forge-prefs.jsonc'),JSON.stringify({tier_models:Object.fromEntries(['light','standard','heavy','max'].map(t=>[t,model])),effort:{'plan-slice':'medium'}}));
 const task='T-2026111900'+String(seq).padStart(4,'0')+'-fixture',actor=runs.observeHostSession(host,process.env.FORGE_CLAUDE_OWNER_SESSION_ID);
 windows.ensureTask(owner,task);runs.add(owner,{id:task,kind:'task',host_runtime:host,session_id:actor.sessionId,owner_session_source:actor.source,cwd:owner,root:owner});
 const q={schema_version:1,scope:'standalone-task',phase:'brainstorm',taskId:task,cwd:code,contextRoot:owner,hostRuntime:host,workflowId:'fixture442',dispatchId:'dispatch442-'+seq,resultFile:path.join(base,'result.json'),constraints:{auto_commit:false,deploy:false},inputs:{brief:'Isolated no-invocation settlement fixture'},activeCapabilities:host==='codex'?{available:true,tool:'collaboration.spawn_agent',source:'fixture-schema',models:[model],reasoning_efforts:['medium','high'],fork_turns:['none']}:{available:true,tool:'Agent',source:'fixture-schema',model_aliases:['sonnet'],effort_transports:['agent-argument'],reasoning_efforts:['medium','high']}};
 const file=path.join(base,'request.json');fs.writeFileSync(file,JSON.stringify(q));return{q,file,base,owner,host,cliJoins:[]};
}
function cli(f,args){const r=cp.spawnSync(process.execPath,[path.join(__dirname,'forge-task-preparation.js'),...args],{encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024});f.cliJoins.push({pid:r.pid,status:r.status,closed:true});assert(!r.error);return JSON.parse(r.stdout.trim());}
function refused(f){const first=cli(f,['--start',f.file]);assert.equal(first.action,'invoke-native',JSON.stringify(first));const packet=path.join(f.base,'acceptance.json');fs.writeFileSync(packet,JSON.stringify({route:first.route,nativeFailure:{reason_code:'fixture-not-invoked',provider_called:false}}));const result=cli(f,['--accept-native',f.file,packet]);assert.equal(result.ok,false);assert(windows.observed(f.owner));return fs.readFileSync(f.q.resultFile+'.receipt.json');}
function facts(f,extra={}){assert(f.cliJoins.every(row=>row.closed));return{coverage_complete:true,no_invocation_observed:true,unmeasured_code_contents_acknowledged:true,writers:f.cliJoins.map(row=>({state:'joined',reference:'actual spawnSync close '+row.pid})),joined:true,possible_writers:0,reference:'fixture observed all actual CLI closes and never invoked a provider',...extra};}
function adapter(f,extra={},reconcile=()=>({reconciled:true,reference:'fixture reconciled exact controls and physical roots; contents explicitly unmeasured'})){
 return doctor.createPreparationSettlementAdapter({hostRuntime:f.host,observeWriters:()=>facts(f,extra),reconcile});
}
async function test(name,body){await body();passed++;console.log('ok - '+name);}
(async()=>{
 for(const host of ['codex','claude']){
  await test(host+' manual failed acceptance settles with a live adapter and immutable receipt',async()=>{
   const f=fixture(host),before=refused(f),inspection=doctor.inspectOwnerWindow({owner:f.owner,request:f.q});
   assert.equal(inspection.measurement_profile,'preparation-no-invocation-v1');assert.equal(inspection.coverage.code_contents,'unmeasured');
   await assert.rejects(doctor.settleFailedPreparation(f.q,{}),/owner-window-live-host-required/);
   for(const bad of [{no_invocation_observed:false},{coverage_complete:false},{unmeasured_code_contents_acknowledged:false},{possible_writers:1},{writers:[{state:'active',reference:'actual unjoined fixture'}]}]){
    await assert.rejects(doctor.settleFailedPreparation(f.q,adapter(f,bad)),/owner-window-(?:writer|no-invocation)-unproven/);assert(windows.observed(f.owner));
   }
   const changed=path.join(f.owner,'.gsd/tasks',f.q.taskId,f.q.taskId+'-PLAN.md');
   await assert.rejects(doctor.settleFailedPreparation(f.q,adapter(f,{},()=>{fs.writeFileSync(changed,'unexpected owner change');return{reconciled:true,reference:'injected race'};})),/owner-window-recovery-conflict/);
   assert(windows.observed(f.owner));fs.unlinkSync(changed);
   const taskDir=path.dirname(changed),backup=taskDir+'-retained',foreign=path.join(f.base,'foreign-controls');fs.mkdirSync(foreign);
   assert(taskDir.startsWith(lab+path.sep)&&backup.startsWith(lab+path.sep));fs.renameSync(taskDir,backup);fs.symlinkSync(foreign,taskDir,'junction');
   try{await assert.rejects(doctor.settleFailedPreparation(f.q,adapter(f)),/owner-window-evidence-link/);assert(windows.observed(f.owner));}
   finally{assert(fs.lstatSync(taskDir).isSymbolicLink());fs.rmSync(taskDir);fs.renameSync(backup,taskDir);}
   const result=await doctor.settleFailedPreparation(f.q,adapter(f));assert.equal(result.closed,true);assert.equal(windows.observed(f.owner),null);assert(fs.readFileSync(f.q.resultFile+'.receipt.json').equals(before));
   windows.writeBrief(f.owner,f.q.taskId,Buffer.from('owner mutation admitted only after actual settlement'));
  });
  await test(host+' CLI wrapper settles its second failed return without provider invocation',async()=>{
   const f=fixture(host);let callbacks=0;const challenges=[];
   const a=doctor.createPreparationSettlementAdapter({hostRuntime:host,observeWriters:challenge=>{challenges.push(challenge);if(challenge.cli_joins)assert(challenge.cli_joins.every(row=>row.closed));return facts(f);},reconcile:()=>({reconciled:true,reference:'fixture reconciled controls and identities'})});
   const result=await windows.runCliPreparation(f.file,{acceptanceFile:path.join(f.base,'native-failure.json'),ownerTransportAdapter:a,invokeNative:async()=>{callbacks++;throw Object.assign(new Error('host refused before invoking an agent'),{code:'fixture-not-invoked',provider_called:false});}});
   assert.equal(callbacks,1,'bridge called, no actual worker/provider was invoked');assert.equal(result.ok,false);assert.equal(result.owner_window.status,'closed',JSON.stringify(result));assert.equal(windows.observed(f.owner),null);
   const failure=challenges.find(row=>row.operation==='settle-cli-preparation-failure');assert(failure);assert.deepEqual(failure.cli_joins.map(row=>row.mode),['--start','--accept-native']);
   const receipt=JSON.parse(fs.readFileSync(f.q.resultFile+'.receipt.json'));assert.equal(receipt.phase,'failed');assert.equal(receipt.failure.provider_called,false);
  });
  await test(host+' CLI wrapper settles a replayed first failure and never invokes native',async()=>{
   const f=fixture(host),before=refused(f);let nativeCalls=0;
   const result=await windows.runCliPreparation(f.file,{acceptanceFile:path.join(f.base,'unused.json'),ownerTransportAdapter:adapter(f),invokeNative:async()=>{nativeCalls++;throw Error('must not enter');}});
   assert.equal(nativeCalls,0);assert.equal(result.ok,false);assert.equal(result.owner_window.status,'closed',JSON.stringify(result));assert(fs.readFileSync(f.q.resultFile+'.receipt.json').equals(before));
  });
  await test(host+' executable documented decline uses actual in-process CLI observations',async()=>{
   const f=fixture(host);f.q.workerMode='native';fs.writeFileSync(f.file,JSON.stringify(f.q));
   const document=fs.readFileSync(path.join(__dirname,'../shared/forge-owner-recovery.md'),'utf8'),section=document.split('<!-- forge:preparation-native-decline-example:start -->')[1]?.split('<!-- forge:preparation-native-decline-example:end -->')[0];
   assert(section);const source=/```javascript\n([\s\S]+?)\n```/.exec(section)?.[1];assert(source);
   const script=path.join(f.base,'documented-decline.cjs');fs.writeFileSync(script,source);
   const run=cp.spawnSync(process.execPath,[script,__dirname,f.file,path.join(f.base,'documented-acceptance.json')],{encoding:'utf8',windowsHide:true,maxBuffer:2*1024*1024});
   assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout.trim());assert.equal(result.ok,false);assert.equal(result.owner_window.status,'closed',JSON.stringify(result));assert.equal(windows.observed(f.owner),null);
   const receipt=JSON.parse(fs.readFileSync(f.q.resultFile+'.receipt.json'));assert.equal(receipt.phase,'failed');assert.equal(receipt.failure.provider_called,false);
  });
  await test(host+' retained candidates and unknown provider state never use limited settlement',async()=>{
   const f=fixture(host),before=refused(f),file=f.q.resultFile+'.receipt.json';
   for(const delta of [{saved_candidate:{sha256:'retained'}},{failure:{provider_called:true}},{failure:{provider_called:'unknown'}}]){
    fs.writeFileSync(file,JSON.stringify({...JSON.parse(before),...delta}));await assert.rejects(doctor.settleFailedPreparation(f.q,adapter(f)),/owner-window-no-invocation-scope-required/);assert(windows.observed(f.owner));
   }
   fs.writeFileSync(file,before);
   for(const [channel,content] of [[f.q.resultFile+'.returned.json','{}'],[f.q.resultFile,JSON.stringify({status:'done',artifacts:[]})],[f.q.resultFile,'{unparseable retained channel']]){
    const previous=fs.existsSync(channel)?fs.readFileSync(channel):null;fs.writeFileSync(channel,content);
    const observation=doctor.inspectOwnerWindow({owner:f.owner,request:f.q});assert.equal(observation.measurement_profile,undefined,'retained/unknown candidates keep the strict full path');
    const scope=require('./forge-owner-window-recovery').capture({owner:f.owner,request:f.q}).scope;assert(scope.code_states[0].start_sha);assert.equal(scope.retained_candidate_channels.candidate,true);
    await assert.rejects(doctor.settleFailedPreparation(f.q,adapter(f)),/owner-window-saved-candidate-retained/);assert(windows.observed(f.owner));
    fs.appendFileSync(channel,' ');assert.notEqual(doctor.inspectOwnerWindow({owner:f.owner,request:f.q}).observation_sha256,observation.observation_sha256,'full candidate observation binds exact channel bytes');
    if(previous)fs.writeFileSync(channel,previous);else fs.unlinkSync(channel);
   }
   await doctor.settleFailedPreparation(f.q,adapter(f));
  });
 }
 assert.equal(providerCalls,0);console.log(JSON.stringify({passed,failed:0,provider_calls:providerCalls}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(()=>{for(const owner of owners){const seen=windows.observed(owner);if(seen)try{windows.recover(owner,seen,challenge=>({challenge_sha256:roots.digest(challenge),joined:true,possible_writers:0,reference:'fixture cleanup: every actual synchronous CLI closed; no provider invoked'}));}catch{process.exitCode=1;}}for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
