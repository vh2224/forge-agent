'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const api=require('./forge-owner-window-recovery'),doctor=require('./forge-doctor'),windows=require('./forge-owner-transport-window'),runs=require('./forge-runs'),roots=require('./forge-code-roots');
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-window-recovery-'))),saved={...process.env},children=[],owners=[];
const put=(p,s)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);};
const command=(bin,args,cwd)=>{const r=cp.spawnSync(bin,args,{cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout;};
const actor=(host,name)=>{process.env.CODEX_THREAD_ID=name;process.env.FORGE_CLAUDE_OWNER_SESSION_ID=name;process.env.FORGE_CLAUDE_OWNER_SOURCE='claude-sessionstart-env-v1';};
(async()=>{
 for(const host of ['codex','claude']){
  const owner=path.join(lab,host,'owner'),code=path.join(lab,host,'code');
  fs.mkdirSync(path.join(owner,'.gsd'),{recursive:true});fs.mkdirSync(code,{recursive:true});
  owners.push(owner);
  command('git',['init','-q'],code);put(path.join(code,'index.txt'),'base\n');command('git',['add','index.txt'],code);command('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','base'],code);put(path.join(code,'index.txt'),'retained working change\n');
  actor(host,'previous-'+host);const previous=runs.observeHostSession(host,process.env.FORGE_CLAUDE_OWNER_SESSION_ID),task='T-20261115221000-recovery-'+host;
  windows.ensureTask(owner,task);runs.add(owner,{id:task,kind:'task',session_id:previous.sessionId,host_runtime:host,owner_session_source:previous.source,cwd:owner,root:owner});
  const q={schema_version:1,scope:'standalone-task',phase:'brainstorm',taskId:task,cwd:code,contextRoot:owner,hostRuntime:host,workflowId:'fixture399',dispatchId:'dispatch-'+host,resultFile:path.join(lab,host,'channel/result.json'),inputs:{brief:'Isolated recovery fixture'},constraints:{auto_commit:false,deploy:false}};
  fs.mkdirSync(path.dirname(q.resultFile));const validated=require('./forge-task-preparation').validateRequest(q),fingerprint=require('./forge-task-preparation').preparationRequestFingerprint(validated);
  // The factor is the existing canonical root/state census, with equal explicit
  // or implicit representations. DATA alone never grants settlement authority.
  const codeBefore=api.measurePreparationCodeState({owner,request:q}),explicitCode=api.measurePreparationCodeState({owner,request:{...q,execution_contract:roots.singleContract(owner,code)}});
  assert.deepEqual(explicitCode,codeBefore);assert.equal(codeBefore.code_states[0].path,fs.realpathSync.native(code));assert(codeBefore.code_states[0].pre_dirty.some(x=>x.path==='index.txt'));
  const beforeMarker=path.join(code,'before-factor-change.txt');put(beforeMarker,'private changed file');assert.notDeepEqual(api.measurePreparationCodeState({owner,request:q}),codeBefore);fs.unlinkSync(beforeMarker);assert.deepEqual(api.measurePreparationCodeState({owner,request:q}),codeBefore);
  const receiptFile=q.resultFile+'.receipt.json';put(receiptFile,JSON.stringify({phase:'failed',dispatch_id:q.dispatchId,request_fingerprint:fingerprint,failure:{reason_code:'artifact-direct-write-detected'}}));const receiptBefore=fs.readFileSync(receiptFile);
  const binding={kind:'artifact-preparation',coordination:'observed-host-session-v1',task_id:task,dispatch_id:q.dispatchId,request_sha256:fingerprint,host_runtime:host,host_session_sha256:roots.digest(previous.sessionId)};
  const qfile=path.join(lab,host,'binding.json');put(qfile,JSON.stringify(binding));
  // Real old custody process exits without releasing its window.
  command(process.execPath,['-e',`const w=require(process.argv[1]);w.open(process.argv[2],JSON.parse(require('fs').readFileSync(process.argv[3])));process.exit(0);`,path.join(__dirname,'forge-owner-transport-window.js'),owner,qfile],owner);
  const held=windows.observed(owner);assert(held);
  let closed=false;const writer=cp.spawn(process.execPath,['-e','process.stdin.resume();'],{stdio:['pipe','ignore','ignore'],windowsHide:true});
  const joined=new Promise(resolve=>writer.once('close',()=>{closed=true;resolve();}));
  children.push({writer,joined});
  actor(host,'current-'+host);
  const observe=challenge=>({challenge_sha256:roots.digest(challenge),scope_sha256:challenge.scope_sha256,observation_kind:'live-host-writer-census',coverage_complete:true,
   previous_session_sha256:challenge.scope.previous_host_session_sha256,writers:[{state:closed?'joined':'active',reference:'actual separately tracked child'}],
   previous_owner_stopped:true,joined:closed,possible_writers:closed?0:1,reference:'observed actual old custody exit and worker ChildProcess.close'});
  const reconcile=challenge=>({scope_sha256:challenge.scope_sha256,reconciled:true,reference:'fixture reconciled exact owner and every code snapshot'});
  const adapter=doctor.createOwnerRecoveryAdapter({hostRuntime:host,observeWriters:observe,reconcile});
  const inspect=()=>api.inspect({owner,request:q});let initial=inspect();assert.equal(initial.status,'held');assert.equal(initial.holder_state,'absent');
  const requestFile=path.join(lab,host,'request.json');put(requestFile,JSON.stringify(q));
  const preview=JSON.parse(command(process.execPath,[path.join(__dirname,'forge-doctor.js'),'--owner-window','--cwd',owner,'--request',requestFile,'--json'],owner));assert.equal(preview.status,'held');
  const refused=cp.spawnSync(process.execPath,[path.join(__dirname,'forge-doctor.js'),'--owner-window','--cwd',owner,'--request',requestFile,'--apply','--json'],{encoding:'utf8',windowsHide:true});assert.equal(refused.status,2);assert.equal(JSON.parse(refused.stdout).reason_code,'owner-window-live-host-required');
  assert.equal(windows.observed(owner).sha256,held.sha256,'inspection and apply flag cannot mutate the window');
  await assert.rejects(api.recover({owner,request:q,expected:initial.observation_sha256,adapter:{}}),/owner-window-live-host-required/);
  await assert.rejects(api.recover({owner,request:q,expected:initial.observation_sha256,adapter}),/owner-window-writer-unproven/);
  assert.equal(windows.observed(owner).sha256,held.sha256,'dead holder must not release a live writer');
  writer.stdin.end();await joined;
  const forged=api.createHostAdapter({hostRuntime:host,observeWriters:()=>({joined:true,possible_writers:0,previous_owner_stopped:true,reference:'unbound JSON'}),reconcile});
  await assert.rejects(api.recover({owner,request:q,expected:initial.observation_sha256,adapter:forged}),/owner-window-writer-unproven/);
  for(const override of [{coverage_complete:false},{previous_owner_stopped:false},{previous_session_sha256:'0'.repeat(64)},{writers:[{state:'active',reference:'still active despite a zero count'}]}]){
   const invalid=doctor.createOwnerRecoveryAdapter({hostRuntime:host,observeWriters:ch=>({...observe(ch),...override}),reconcile});
   await assert.rejects(api.recover({owner,request:q,expected:initial.observation_sha256,adapter:invalid}),/owner-window-writer-unproven/);
  }
  const foreign=api.createHostAdapter({hostRuntime:host==='codex'?'claude':'codex',observeWriters:observe,reconcile});
  await assert.rejects(api.recover({owner,request:q,expected:initial.observation_sha256,adapter:foreign}),/owner-window-cross-host-unsupported/);
  actor(host,'changed-session-'+host);await assert.rejects(api.recover({owner,request:q,expected:initial.observation_sha256,adapter}),/owner-window-host-session-changed/);actor(host,'current-'+host);
  const indexRace=doctor.createOwnerRecoveryAdapter({hostRuntime:host,observeWriters:observe,reconcile:ch=>{command('git',['add','index.txt'],code);return reconcile(ch);}});
  await assert.rejects(api.recover({owner,request:q,expected:initial.observation_sha256,adapter:indexRace}),/owner-window-recovery-conflict/,'index-only change must invalidate the reconciled scope');
  command('git',['restore','--staged','--','index.txt'],code);
  initial=inspect();
  const raced=doctor.createOwnerRecoveryAdapter({hostRuntime:host,observeWriters:observe,reconcile:ch=>{put(path.join(code,'raced.txt'),'retained race');return reconcile(ch);}});
  await assert.rejects(api.recover({owner,request:q,expected:initial.observation_sha256,adapter:raced}),/owner-window-recovery-conflict/);
  assert.equal(fs.readFileSync(path.join(code,'raced.txt'),'utf8'),'retained race');fs.unlinkSync(path.join(code,'raced.txt'));
  const write=fs.writeFileSync;fs.writeFileSync=function(file,...args){if(path.basename(path.dirname(String(file)))==='owner-window-recovery')throw Object.assign(new Error('fixture denied'),{code:'EACCES'});return write.call(this,file,...args);};
  try{await assert.rejects(api.recover({owner,request:q,expected:initial.observation_sha256,adapter}),error=>error.code==='owner-window-audit-write-failed'&&error.cause_code==='EACCES');}finally{fs.writeFileSync=write;}
  assert(windows.observed(owner),'audit failure before release must retain custody');
  put(path.join(owner,'.gsd','changed.txt'),'changed');
  await assert.rejects(api.recover({owner,request:q,expected:initial.observation_sha256,adapter}),/owner-window-recovery-conflict/);
  fs.unlinkSync(path.join(owner,'.gsd','changed.txt'));
  const before=require('./forge-task-execution').protectedSnapshot(owner);
  const result=await doctor.recoverOwnerWindow({owner,request:q,expected:inspect().observation_sha256,adapter});assert.equal(result.recovered,true);assert.equal(windows.observed(owner),null);
  assert.deepEqual(require('./forge-task-execution').protectedSnapshot(owner),before,'recovery must not publish artifacts, adopt run or replace protected metadata');
  assert(fs.readFileSync(receiptFile).equals(receiptBefore),'failed producer receipt remains immutable');
  const audit=JSON.parse(fs.readFileSync(result.audit_file));assert.equal(audit.outcome,'recovered');assert.equal(audit.scope.binding_sha256,held.sha256);assert.equal(audit.actor.host_runtime,host);
  assert.equal(runs.get(owner,task).session_id,previous.sessionId,'recovery does not silently transfer old task ownership');
  const repeat=await api.recover({owner,request:q,expected:initial.observation_sha256,adapter});assert.equal(repeat.status,'already-absent');
  if(host==='codex'){
   const next={...q,dispatchId:'second-orphan',resultFile:path.join(lab,host,'channel/second.json')},nextFingerprint=require('./forge-task-preparation').preparationRequestFingerprint(require('./forge-task-preparation').validateRequest(next));
   put(next.resultFile+'.receipt.json',JSON.stringify({phase:'failed',dispatch_id:next.dispatchId,request_fingerprint:nextFingerprint}));
   put(qfile,JSON.stringify({...binding,dispatch_id:next.dispatchId,request_sha256:nextFingerprint}));
   command(process.execPath,['-e',`const w=require(process.argv[1]);w.open(process.argv[2],JSON.parse(require('fs').readFileSync(process.argv[3])));process.exit(0);`,path.join(__dirname,'forge-owner-transport-window.js'),owner,qfile],owner);
   const expected=api.inspect({owner,request:next}).observation_sha256;
   fs.writeFileSync=function(file,...args){if(path.basename(path.dirname(String(file)))==='owner-window-recovery'&&args[1]?.flag!=='wx')throw Object.assign(new Error('fixture final audit denied'),{code:'EACCES'});return write.call(this,file,...args);};
   let partialAudit;try{partialAudit=await api.recover({owner,request:next,expected,adapter});}finally{fs.writeFileSync=write;}
   assert.equal(partialAudit.recovered,true);assert.equal(partialAudit.audit_saved,false);assert.equal(windows.observed(owner),null,'post-release audit failure must not claim the old window is held');
  }
 }
 console.log('PASS real orphan custody across both hosts; alive/forged/stale negatives; joined recovery, immutable owner/run and external audit');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
 for(const child of children)child.writer.stdin.end();await Promise.all(children.map(child=>child.joined));
 for(const owner of owners){const held=windows.observed(owner);if(held)windows.recover(owner,held,challenge=>({challenge_sha256:roots.digest(challenge),joined:true,possible_writers:0,reference:'fixture cleanup after all actual child close events'}));
  const control=windows.controlRoot(owner);assert.equal(fs.realpathSync.native(path.dirname(control)),fs.realpathSync.native(os.tmpdir()));if(fs.existsSync(control)){assert(!fs.lstatSync(control).isSymbolicLink());fs.rmSync(control,{recursive:true,force:true});}}
 process.env=saved;assert.equal(path.dirname(lab),fs.realpathSync.native(os.tmpdir()));fs.rmSync(lab,{recursive:true,force:true});
});
