'use strict';
// Hermetic real-CLI/native-adapter fixtures. No real provider/authentication.
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),crypto=require('crypto'),assert=require('assert/strict');
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-376-integration-'))),savedEnv={...process.env},children=[],results=[],cliJoins=[];
const home=path.join(lab,'home'),forge=path.join(home,'forge');fs.mkdirSync(forge,{recursive:true});fs.cpSync(path.resolve(__dirname,'../shared'),path.join(forge,'shared'),{recursive:true});
Object.assign(process.env,{HOME:home,USERPROFILE:home,APPDATA:path.join(home,'appdata'),LOCALAPPDATA:path.join(home,'local'),FORGE_HOME:forge,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(home,'no-global-config')});
delete process.env.CODEX_THREAD_ID;delete process.env.CODEX_SESSION_ID;delete process.env.FORGE_CLAUDE_OWNER_SESSION_ID;delete process.env.FORGE_CLAUDE_OWNER_SOURCE;
const realSpawn=cp.spawn,realFork=cp.fork;function observedChild(child,broker=false){const row={child,closed:false,exited:false,broker};children.push(row);child.once('close',()=>{row.closed=true;});child.once('exit',()=>{row.exited=true;});return child;}cp.spawn=function(...args){return observedChild(realSpawn.apply(this,args));};cp.fork=function(...args){return observedChild(realFork.apply(this,args),args[1]?.includes('--broker')===true);};
const joined=row=>row.closed||(row.broker&&row.exited&&row.child.exitCode===0);
const accounts=require('./forge-accounts'),realResolve=accounts.resolveLaunch;
accounts.resolveLaunch=()=>({name:'fixture376',token:'fixture-not-a-real-token'});
const prep=require('./forge-task-preparation'),unit=require('./forge-unit-sidecar'),windows=require('./forge-owner-transport-window'),runs=require('./forge-runs'),controller=require('./forge-unit-controller'),execution=require('./forge-task-execution');
accounts.resolveLaunch=realResolve;
const digest=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const selectors={native:'native live',distributed:'distributed native',legacy:'legacy separate',claude:'real production',raw:'unknown cleanup',broker:'cohort owner'},selector=process.argv[2];
if(selector&&!selectors[selector])throw new Error('unknown fixture selector');
process.once('beforeExit',()=>{if(results.length!==(selector?1:6)){process.exitCode=1;fs.writeFileSync(path.join(lab,'INCOMPLETE.json'),JSON.stringify({completed:results,children:children.map(row=>({pid:row.child.pid,closed:row.closed,exitCode:row.child.exitCode,connected:row.child.connected}))},null,2));}});
const summary=value=>JSON.stringify({ok:value?.ok,reason_code:value?.reason_code,diagnostic:value?.diagnostic});
function command(bin,args,cwd){const r=cp.spawnSync(bin,args,{cwd,encoding:'utf8',env:{...process.env},windowsHide:true,timeout:20000});assert.equal(r.status,0,r.stderr||String(r.error));return r.stdout;}
let seq=0;
function fixture(sharedOwner){const dir=path.join(lab,'case-'+(++seq)),cwd=path.join(dir,'code'),contextRoot=sharedOwner||path.join(dir,'owner');fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(path.join(contextRoot,'.gsd'),{recursive:true});fs.mkdirSync(path.join(dir,'channels'));command('git',['init','-q'],cwd);command('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','fixture'],cwd);
 if(!sharedOwner)fs.writeFileSync(path.join(contextRoot,'.gsd/forge-prefs.jsonc'),JSON.stringify({tier_models:Object.fromEntries(['light','standard','heavy','max'].map(k=>[k,'gpt-5.6-sol'])),effort:{'plan-slice':'medium'}}));
 const taskId='T-2026110900'+String(seq).padStart(4,'0')+'-fixture';windows.ensureTask(contextRoot,taskId);
 return{schema_version:1,scope:'standalone-task',phase:'brainstorm',taskId,cwd,contextRoot,hostRuntime:'codex',workflowId:'fixture376',dispatchId:crypto.randomUUID(),resultFile:path.join(dir,'channels/result.json'),constraints:{auto_commit:false,deploy:false},inputs:{brief:'Synthetic isolated task; no provider'},activeCapabilities:{available:true,tool:'collaboration.spawn_agent',source:'fixture-tool-schema',models:['gpt-5.6-sol'],reasoning_efforts:['medium','high'],fork_turns:['none']}};
}
function candidate(q){return{status:'done',summary:'Synthetic actual child response',questions:[],artifacts:[{path:prep.requiredArtifact(q),content:'# Brainstorm\n\n## Recommended Approach\nReuse canonical owner coordination.\n\n## Alternatives Considered\nPreserve strict snapshots.\n\n## Top Risks\nUnproved metadata writes.\n\n## Out of Scope\nReal providers.\n'}]};}
function attest(challenge){assert(children.every(joined),'actual observed children must all have joined');return{challenge_sha256:digest(challenge),joined:true,possible_writers:0,reference:'fixture ChildProcess.close or actual exit0 of canonical no-stdio/no-descendant signer'};}
function cli(args){const r=cp.spawnSync(process.execPath,[path.join(__dirname,'forge-task-preparation.js'),...args],{encoding:'utf8',env:{...process.env},windowsHide:true,timeout:20000,maxBuffer:1024*1024});cliJoins.push({mode:args[0],pid:r.pid,status:r.status,error:r.error?.code||null});return{status:r.status,pid:r.pid,value:JSON.parse(r.stdout.trim()),stderr:r.stderr};}
function recover(q){const seen=windows.observed(q.contextRoot);assert(seen);return windows.recover(q.contextRoot,seen,attest);}
async function run(name,action){if(selector&&!name.startsWith(selectors[selector]))return;const start=Date.now();await action();results.push({name,passed:true,duration_ms:Date.now()-start});console.log('ok - '+name);}
(async()=>{
 await run('native live handoff protects actual child lifetime and refuses real canonical bootstrap/run/controller before write',async()=>{
  const a=fixture(),b=fixture(a.contextRoot);runs.add(b.contextRoot,{id:b.taskId,kind:'task',session_id:'other-active-owner'});assert.equal(runs.get(b.contextRoot,b.taskId).active,true);
  const adapter=windows.createTransportAdapter(attest),handoff=await prep.startStandaloneTaskPreparation(a,{ownerTransportAdapter:adapter});assert.equal(handoff.action,'invoke-native');
  const worker=path.join(path.dirname(a.resultFile),'worker.cjs');fs.writeFileSync(worker,"process.stdout.write('ready\\n');process.stdin.once('data',()=>{process.stdout.write("+JSON.stringify(JSON.stringify(candidate(a)))+"+'\\n');process.stdin.pause();});");
  let started;const ready=new Promise(resolve=>{started=resolve;});let workerChild;
  const pending=handoff.invoke(async()=>{workerChild=cp.spawn(process.execPath,[worker],{env:{...process.env},stdio:['pipe','pipe','pipe'],windowsHide:true});let output='';workerChild.stdout.on('data',bytes=>{output+=bytes;if(output.includes('ready\n'))started();});await new Promise((resolve,reject)=>{workerChild.once('close',resolve);workerChild.once('error',reject);});return JSON.parse(output.trim().split('\n').at(-1));});
  await ready;const before=execution.protectedSnapshot(a.contextRoot);
  const B={id:'T-20261109999998-registry',kind:'task',session_id:'fixture-B'};
  assert.throws(()=>runs.add(b.contextRoot,B),e=>e.code==='owner-window-busy');assert.equal(runs.get(b.contextRoot,B.id),null);
  let entered=false;assert.throws(()=>controller.withOwnerBoundary(a.contextRoot,()=>{entered=true;}),e=>e.code==='owner-window-busy');assert.equal(entered,false);
  const refused=cp.spawnSync(process.execPath,[path.join(__dirname,'forge-owner-transport-window.js'),'--ensure-task',a.contextRoot,'T-20261109999999-new'],{env:{...process.env},encoding:'utf8',windowsHide:true,timeout:20000});assert.equal(refused.status,1);assert.equal(JSON.parse(refused.stdout).reason_code,'owner-window-busy');assert(!fs.existsSync(path.join(a.contextRoot,'.gsd/tasks/T-20261109999999-new')));
  assert.throws(()=>windows.writeBrief(b.contextRoot,b.taskId,Buffer.from('fixture brief')),e=>e.code==='owner-window-busy');assert(!fs.existsSync(path.join(b.contextRoot,'.gsd/tasks',b.taskId,b.taskId+'-BRIEF.md')));
  await assert.rejects(require('./forge-artifact-reconciliation').startBroker({owner:a.contextRoot,manifestFile:path.join(path.dirname(a.resultFile),'foreign-broker.json'),dispatchId:b.dispatchId,request_sha256:'b'.repeat(64)}),e=>e.code==='owner-window-busy');
  assert.deepEqual(execution.protectedSnapshot(a.contextRoot),before);workerChild.stdin.end('finish');const result=await pending;assert.equal(result.ok,true,summary(result));assert.equal(windows.observed(a.contextRoot),null);runs.add(b.contextRoot,B);assert(runs.get(b.contextRoot,B.id));
  assert.equal(controller.withOwnerBoundary(a.contextRoot,boundary=>boundary.noLeases()),true);windows.writeBrief(b.contextRoot,b.taskId,Buffer.from('fixture brief'));assert.equal(fs.readFileSync(path.join(b.contextRoot,'.gsd/tasks',b.taskId,b.taskId+'-BRIEF.md'),'utf8'),'fixture brief');
 });
 await run('distributed native CLI start and accept retain exact observed owner coordination until real host settlement',async()=>{
  const q=fixture();process.env.CODEX_THREAD_ID='fixture376-owner';runs.add(q.contextRoot,{id:q.taskId,kind:'task',session_id:process.env.CODEX_THREAD_ID,host_runtime:'codex'});
  const requestFile=path.join(path.dirname(q.resultFile),'request.json');fs.writeFileSync(requestFile,JSON.stringify(q));const start=cli(['--start',requestFile]);assert.equal(start.value.action,'invoke-native',JSON.stringify(start));const binding=windows.observed(q.contextRoot);assert(binding);assert.equal(binding.binding.dispatch_id,q.dispatchId);
  assert.equal(start.value.owner_window.status,'held');assert.equal(cli(['--start',requestFile]).value.reason_code,'owner-window-attempt-in-progress');
  assert.equal(require('./forge-lock').status(windows.controlRoot(q.contextRoot),'owner-transport-window').metadata.holder_pid,start.pid);
  const oldReceipt=digest(fs.readFileSync(q.resultFile+'.receipt.json'));
  const wrongRequest=path.join(path.dirname(q.resultFile),'wrong-request.json');fs.writeFileSync(wrongRequest,JSON.stringify({...q,dispatchId:crypto.randomUUID()}));assert.equal(cli(['--start',wrongRequest]).value.reason_code,'owner-window-coordination-mismatch');assert.equal(digest(fs.readFileSync(q.resultFile+'.receipt.json')),oldReceipt);
  const worker=path.join(path.dirname(q.resultFile),'response.cjs');fs.writeFileSync(worker,"process.stdout.write('ready\\n');process.stdin.once('data',()=>{process.stdout.write("+JSON.stringify(JSON.stringify(candidate(q)))+"+'\\n');process.stdin.pause();});");
  const external=cp.spawn(process.execPath,[worker],{env:{...process.env},stdio:['pipe','pipe','pipe'],windowsHide:true});let text='';await new Promise(resolve=>external.stdout.on('data',bytes=>{text+=bytes;if(text.includes('ready\n'))resolve();}));
  assert.throws(()=>recover(q),e=>e.code==='owner-window-writer-unproven');assert(windows.observed(q.contextRoot),'start parent exit does not prove the separately observed child stopped');external.stdin.end('finish');await new Promise(resolve=>external.once('close',resolve));const response=JSON.parse(text.trim().split('\n').at(-1));
  const packet={route:start.value.route,rawResult:response,invocationTelemetry:start.value.invocation.telemetry,providerCalled:true},packetFile=path.join(path.dirname(q.resultFile),'acceptance.json');fs.writeFileSync(packetFile,JSON.stringify(packet));
  process.env.CODEX_THREAD_ID='foreign-session';const denied=cli(['--accept-native',requestFile,packetFile]);assert.equal(denied.status,1);assert.equal(denied.value.reason_code,'owner-window-foreign-owner');assert.equal(denied.value.provider_called,'unknown');assert(!fs.existsSync(path.join(q.contextRoot,prep.requiredArtifact(q))));
  process.env.CODEX_THREAD_ID='fixture376-owner';const accepted=cli(['--accept-native',requestFile,packetFile]);assert.equal(accepted.status,0,JSON.stringify(accepted));assert.equal(accepted.value.ok,true);assert(windows.observed(q.contextRoot),'ready is not process-family settlement');
  assert.equal(accepted.value.owner_window.settlement,'live-host-join-required');
  const readyReceipt=digest(fs.readFileSync(q.resultFile+'.receipt.json')),initialRun=binding.binding.run_record_sha256,coord=windows.coordinatePreparation(prep.validateRequest(q),prep.preparationRequestFingerprint(prep.validateRequest(q)),{create:false});
  windows.withWindow(coord,()=>runs.update(q.contextRoot,q.taskId,{last_heartbeat:Date.now(),worker_pid:external.pid,root_continuation:'fixture-post-ready'}));
  assert.notEqual(crypto.createHash('sha256').update(fs.readFileSync(runs.runFile(q.contextRoot,q.taskId))).digest('hex'),initialRun);
  assert.equal(cli(['--accept-native',requestFile,packetFile]).value.ok,true,'canonical ready replay must survive volatile same-owner fields');assert.equal(digest(fs.readFileSync(q.resultFile+'.receipt.json')),readyReceipt);
  assert.throws(()=>windows.recover(q.contextRoot,binding,()=>({joined:false})),e=>e.code==='owner-window-writer-unproven');assert(windows.observed(q.contextRoot));
  await assert.rejects(windows.settlePreparation(q,{}),e=>e.code==='owner-window-live-host-required');
  await assert.rejects(windows.settlePreparation(q,windows.createTransportAdapter(()=>({joined:false}))),e=>e.code==='owner-window-writer-unproven');
  assert.throws(()=>windows.writeBrief(q.contextRoot,q.taskId,Buffer.from('after join')),e=>e.code==='owner-window-busy');
  await windows.settlePreparation(q,windows.createTransportAdapter(attest));assert.equal(windows.observed(q.contextRoot),null);
  windows.writeBrief(q.contextRoot,q.taskId,Buffer.from('after join'));
  // A new phase of the same task crosses two actual CLI closes and a real
  // synthetic child close, with all publication gates still canonical.
  const next={...q,phase:'discuss',dispatchId:crypto.randomUUID(),resultFile:path.join(path.dirname(q.resultFile),'next-result.json')};
  const nextFile=path.join(path.dirname(q.resultFile),'next-request.json'),nextPacket=path.join(path.dirname(q.resultFile),'next-acceptance.json');fs.writeFileSync(nextFile,JSON.stringify(next));
  await assert.rejects(windows.runCliPreparation(nextFile,{acceptanceFile:nextPacket,ownerTransportAdapter:windows.createTransportAdapter(attest)}),e=>e.code==='owner-window-live-host-required');assert.equal(windows.observed(q.contextRoot),null);
  const joins=[];const adapter=windows.createTransportAdapter(challenge=>{joins.push(challenge);return attest(challenge);});
  const nextResult=await windows.runCliPreparation(nextFile,{acceptanceFile:nextPacket,ownerTransportAdapter:adapter,invokeNative:async invocation=>{
   assert(Object.isFrozen(invocation.args));assert(invocation.args.model);assert.throws(()=>windows.writeBrief(q.contextRoot,q.taskId,Buffer.from('busy')),e=>e.code==='owner-window-busy');
   const child=cp.spawn(process.execPath,['-e','process.stdout.write("joined")'],{env:{...process.env},stdio:['ignore','pipe','pipe'],windowsHide:true});await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
   return{providerCalled:true,rawResult:{status:'done',summary:'Next phase fixture',questions:[],artifacts:[{path:prep.requiredArtifact(next),content:'# Context\n\n## Decisions\nPreserve owner coordination.\n\n## Open Questions\nNone.\n\n## Out of Scope\nReal providers.\n'}]}};
  }});
  assert.equal(nextResult.ok,true,JSON.stringify(nextResult));assert.equal(nextResult.owner_window.status,'closed');assert.equal(windows.observed(q.contextRoot),null);
  const settlement=joins.find(c=>c.operation==='settle-cli-preparation');assert(settlement);assert.deepEqual(settlement.cli_joins.map(c=>c.mode),['--start','--accept-native']);assert(settlement.cli_joins.every(c=>c.closed&&c.status===0));
  assert.equal(controller.withOwnerBoundary(q.contextRoot,b=>b.noLeases()),true);
  for(const mode of ['unknown','drift']){
   const negative=fixture();runs.add(negative.contextRoot,{id:negative.taskId,kind:'task',session_id:process.env.CODEX_THREAD_ID,host_runtime:'codex'});
   const file=path.join(path.dirname(negative.resultFile),'request.json'),packet=path.join(path.dirname(negative.resultFile),'packet.json');fs.writeFileSync(file,JSON.stringify(negative));
   const pending=windows.runCliPreparation(file,{acceptanceFile:packet,ownerTransportAdapter:windows.createTransportAdapter(mode==='unknown'?()=>({joined:false}):attest),invokeNative:async()=>{
    if(mode==='drift')fs.writeFileSync(path.join(negative.contextRoot,'.gsd/raw-foreign-write'),'unattributed');
    return{providerCalled:true,rawResult:candidate(negative)};
   }});
   if(mode==='unknown'){await assert.rejects(pending,e=>e.code==='owner-window-writer-unproven');assert(!fs.existsSync(packet));}
   else{const denied=await pending;assert.equal(denied.ok,false);assert.equal(denied.reason_code,'artifact-direct-write-detected');assert.equal(JSON.parse(fs.readFileSync(negative.resultFile+'.receipt.json')).phase,'failed');}
   assert(windows.observed(negative.contextRoot));assert.throws(()=>windows.writeBrief(negative.contextRoot,negative.taskId,Buffer.from('blocked')),e=>e.code==='owner-window-busy');recover(negative);
  }
  delete process.env.CODEX_THREAD_ID;
 });
 await run('legacy separate CLI contract remains accepted without inventing owner or saved anchors',async()=>{
  process.env.CODEX_THREAD_ID='fixture376-observed-no-run';
  const q=fixture(),requestFile=path.join(path.dirname(q.resultFile),'request.json');fs.writeFileSync(requestFile,JSON.stringify(q));const start=cli(['--start',requestFile]);assert.equal(start.value.action,'invoke-native');assert.equal(windows.observed(q.contextRoot),null);
  const packetFile=path.join(path.dirname(q.resultFile),'acceptance.json');fs.writeFileSync(packetFile,JSON.stringify({route:start.value.route,rawResult:candidate(q),invocationTelemetry:start.value.invocation.telemetry,providerCalled:true}));const result=cli(['--accept-native',requestFile,packetFile]);assert.equal(result.status,0,JSON.stringify(result));const receipt=JSON.parse(fs.readFileSync(q.resultFile+'.receipt.json'));assert.equal(receipt.phase,'ready');assert.equal(receipt.broker_manifest_sha256,undefined);
  const foreign=fixture();runs.add(foreign.contextRoot,{id:foreign.taskId,kind:'task',host_runtime:'codex',session_id:'some-other-real-owner'});process.env.CODEX_THREAD_ID='current-foreign-actor';const denied=await prep.startStandaloneTaskPreparation(foreign);assert.equal(denied.reason_code,'owner-window-foreign-owner');assert(!fs.existsSync(foreign.resultFile+'.receipt.json'));delete process.env.CODEX_THREAD_ID;
 });
 await run('real production Claude adapter with fake CLI and live close witness protects preparation',async()=>{
  const q=fixture();delete q.activeCapabilities;fs.writeFileSync(path.join(q.contextRoot,'.gsd/forge-prefs.jsonc'),JSON.stringify({tier_models:Object.fromEntries(['light','standard','heavy','max'].map(k=>[k,'claude-sonnet-5'])),effort:{'plan-slice':'medium'}}));
  const fake=path.join(path.dirname(q.resultFile),'fake-claude.js');fs.writeFileSync(fake,["const args=process.argv.slice(2);if(args.includes('--version')){console.log('2.1.310 (Claude Code)');process.exit(0);}","const out=value=>console.log(JSON.stringify(value));", "out({type:'stream_event',event:{type:'message_start',message:{id:'fixture',role:'assistant'}}});", "out({type:'stream_event',event:{type:'content_block_start',index:0,content_block:{type:'text',text:''}}});", "out({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'fixture'}}});", "out({type:'stream_event',event:{type:'content_block_stop',index:0}});out({type:'stream_event',event:{type:'message_stop'}});",'const model=args[args.indexOf("--model")+1];out({type:"result",subtype:"success",is_error:false,result:"fixture",structured_output:'+JSON.stringify(candidate(q))+',usage:{input_tokens:1,output_tokens:1},modelUsage:{[model]:{inputTokens:1,outputTokens:1}}});'].join('\n'));
  process.env.FORGE_XLLM_CLAUDE_BIN=fake;process.env.CODEX_THREAD_ID='fixture376-sidecar-owner';runs.add(q.contextRoot,{id:q.taskId,kind:'task',session_id:process.env.CODEX_THREAD_ID,host_runtime:'codex'});
  // Child CLI reads the isolated account files; its fake executable never
  // authenticates or calls a provider. Parent load-time monkeypatch is not inherited.
  process.env.FORGE_KEYCHAIN_DISABLED='1';const accountDir=path.join(home,'.claude');fs.mkdirSync(accountDir,{recursive:true});fs.writeFileSync(path.join(accountDir,'forge-accounts.json'),JSON.stringify({version:1,active:'fixture376',accounts:{fixture376:{store:'file'}}}));fs.writeFileSync(path.join(accountDir,'forge-accounts-tokens.json'),JSON.stringify({fixture376:'fixture-not-a-real-token'}),{mode:0o600});
  const requestFile=path.join(path.dirname(q.resultFile),'request.json');fs.writeFileSync(requestFile,JSON.stringify(q));let nativeCalls=0;const proofs=[];
  const value=await windows.runCliPreparation(requestFile,{acceptanceFile:path.join(path.dirname(q.resultFile),'acceptance.json'),invokeNative:async()=>{nativeCalls++;throw new Error('sidecar route must not call native');},ownerTransportAdapter:windows.createTransportAdapter(challenge=>{proofs.push(challenge);return attest(challenge);})});
  assert.equal(nativeCalls,0);assert.equal(value.ok,true,summary(value));assert.equal(value.transport,'sidecar');assert.equal(value.owner_window.status,'closed');assert.equal(windows.observed(q.contextRoot),null);assert(fs.existsSync(path.join(q.contextRoot,prep.requiredArtifact(q))));
  const proof=proofs.find(c=>c.operation==='settle-cli-preparation');assert(proof);assert.deepEqual(proof.cli_joins.map(c=>c.mode),['--start']);assert(proof.cli_joins.every(c=>c.closed&&c.status===0));
  windows.writeBrief(q.contextRoot,q.taskId,Buffer.from('sidecar closed'));assert.equal(controller.withOwnerBoundary(q.contextRoot,b=>b.noLeases()),true);
  delete process.env.FORGE_XLLM_CLAUDE_BIN;delete process.env.CODEX_THREAD_ID;
 });
 await run('unknown cleanup retains window and raw foreign bytes still fail canonical validation',async()=>{
  const q=fixture(),handoff=await prep.startStandaloneTaskPreparation(q,{ownerTransportAdapter:windows.createTransportAdapter(()=>({joined:false}))});assert.equal(handoff.action,'invoke-native');
  fs.writeFileSync(path.join(q.contextRoot,'.gsd/unknown-worker-write'),'not attested');await assert.rejects(handoff.invoke(async()=>candidate(q)),e=>e.code==='owner-window-writer-unproven');assert(windows.observed(q.contextRoot));const receipt=JSON.parse(fs.readFileSync(q.resultFile+'.receipt.json'));assert.equal(receipt.phase,'failed');assert.equal(receipt.failure.reason_code,'artifact-direct-write-detected');assert(receipt.saved_candidate);assert(!fs.existsSync(path.join(q.contextRoot,prep.requiredArtifact(q))));recover(q);
  assert.equal(receipt.preparation_surface_drift.attribution,'unproven');
 });
 await run('cohort owner window interlocks genuine broker before common snapshot and actual broker child join',async()=>{
  const q=fixture(),recon=require('./forge-artifact-reconciliation');q.unitType='plan-slice';q.route={host_runtime:'codex',resolved_worker_engine:'codex',worker_mode:'native'};const fingerprint=require('./forge-request-fingerprint').projectFingerprint(q,null),cap=windows.open(q.contextRoot,{kind:'artifact-preparation',task_id:q.taskId,dispatch_id:q.dispatchId,request_sha256:fingerprint});
  const broker=await windows.withWindow(cap,()=>recon.startBroker({owner:q.contextRoot,manifestFile:path.join(path.dirname(q.resultFile),'broker.json'),dispatchId:q.dispatchId,request_sha256:fingerprint}));q.ownerBroker=broker;
  windows.withWindow(cap,()=>unit.beginArtifactAttempt(q));await broker.append('.gsd/forge/events.jsonl',JSON.stringify({event:'fixture-owner-append'})+'\n');
  assert.equal((await windows.withWindow(cap,()=>unit.acceptArtifactResult(q,candidate(q),{providerCalled:true,enforceReadOnlySurface:true}))).record.phase,'ready');
  const exits=children.filter(row=>!joined(row)).map(row=>new Promise(resolve=>row.child.once(row.broker?'exit':'close',resolve)));await broker.close();fs.writeFileSync(path.join(lab,'BROKER-AFTER-CLOSE.json'),JSON.stringify(children.map(row=>({pid:row.child.pid,closed:row.closed,exited:row.exited,broker:row.broker,exitCode:row.child.exitCode,connected:row.child.connected})),null,2));
  let timer;try{await Promise.race([Promise.all(exits),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('fixture broker close event unobserved')),5000);})]);}finally{clearTimeout(timer);}windows.close(cap,attest);assert.equal(windows.observed(q.contextRoot),null);
 });
 const record={base:'a36033d41fd779cf4b1262d3e01455c54016786d',private_lab:lab,groups:results,actual_child_processes:children.length,all_child_processes_closed:children.every(row=>row.closed),all_child_processes_joined:children.every(joined),cli_joins:cliJoins,actual_provider_calls:0,legacy_native_packet_is_fixture_not_provider_attestation:true};fs.writeFileSync(path.join(lab,'RESULT.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({passed:results.length,lab,children:children.length}));
})().catch(e=>{fs.writeFileSync(path.join(lab,'ERROR.json'),JSON.stringify({code:e.code||null,message:e.message,stack:e.stack,groups:results},null,2));console.error(e.stack);console.error('fixture='+lab);process.exitCode=1;}).finally(async()=>{for(const row of children)if(!joined(row)){row.child.kill();await new Promise(resolve=>row.child.once(row.broker?'exit':'close',resolve));}cp.spawn=realSpawn;cp.fork=realFork;process.env=savedEnv;});
