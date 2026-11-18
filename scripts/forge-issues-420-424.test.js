'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const lab=require('./forge-code-roots.test'),fixtures=require('./fixtures/completion-delivery.cjs');
const api=require('./forge-completion-delivery-recovery'),controller=require('./forge-unit-controller');
const runs=require('./forge-runs'),claims=require('./forge-write-claim'),roots=require('./forge-code-roots');
const loop=require('./forge-long-workflow-adapter');
let cases=0;
const git=(cwd,args)=>cp.execFileSync('git',args,{cwd,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
function repairCase(host,mode,stage){
 const f=lab.fixture(),oldEnv={...process.env};
 try{
  const home=path.join(f.dir,'home');fs.mkdirSync(home);Object.assign(process.env,{HOME:home,USERPROFILE:home,FORGE_HOME:path.join(home,'core')});
  function observe(session){if(host==='codex')process.env.CODEX_THREAD_ID=session;else Object.assign(process.env,{FORGE_CLAUDE_OWNER_SESSION_ID:session,FORGE_CLAUDE_OWNER_SOURCE:'claude-sessionstart-env-v1'});}
  observe('fixture-old');
  const milestone='M001',slice='S01',task='T01',unit='execute-task/T01',legacy='legacy-repair-token';
  fs.mkdirSync(path.join(f.owner,'.gsd/milestones',milestone),{recursive:true});fs.writeFileSync(path.join(f.owner,'.gsd/forge-prefs.jsonc'),'{}');
  require('./forge-state').write(f.owner,{milestone,phase:'idle',active_slice:slice,active_task:'—',auto_mode:'off'});
  const files=fixtures.prepare(f.owner,{milestone,slice,task,codeDir:f.a});
  runs.add(f.owner,{id:milestone,kind:'milestone',session_id:'fixture-old',owner_session_source:host==='codex'?'CODEX_THREAD_ID':'claude-sessionstart-env-v1',active:true,host_runtime:host,root:f.owner,cwd:f.owner});
  claims.recordClaim(f.owner,milestone,{unit,source:'manual',code_dir:f.a,paths:[files.source]});
  const inventory={roadmap_exists:true,context_exists:true,research_exists:true,slices:[{id:slice,checked:false,plan_exists:true,research_exists:true,tasks:[{id:task,checked:false}]}],milestone_complete:false};
  const prefsReader=()=>({ok:true,prefs:{workflow:{skip_discuss:true,skip_research:true}}});
  const base=Date.now()-10000;let now=base;const controllerOptions={prefsReader,inventoryReader:()=>inventory,now:()=>now};
  const key='forge-orchestrate-next:'+milestone+':'+unit+':'+slice;
  const begun=controller.begin(f.owner,{milestone,unit,slice,host_runtime:host,owner_token:legacy,idempotency_key:key,state_patch:{active_slice:slice}},controllerOptions);assert(begun.ok);
  now=base+100;
  controller.complete(f.owner,{milestone,unit,host_runtime:host,owner_token:legacy,generation:begun.generation,idempotency_key:key+':complete',result:{status:'succeeded'}},controllerOptions);
  const originalFiles=[controller.transactionFile(f.owner,key),controller.transactionFile(f.owner,key+':complete')];
  const originalBytes=originalFiles.map(file=>fs.readFileSync(file));
  const input={cwd:f.owner,milestone,workflow_id:'fixture-'+host+'-'+mode,prefsReader,inventory};
  const decision=loop.invoke(host,mode,'next',input,undefined,controllerOptions).result;assert.equal(decision.reason_code,'execution-delivery-recovery-required');
  let authority=true,stopped=true,questions=[];
  const options={cwd:f.owner,milestone,slice,task,runId:milestone,ownerToken:legacy,hostRuntime:host,beginKey:key,completionKey:key+':complete',executionContract:roots.validateContract({...f.contract,code_roots:[f.contract.code_roots[0]]}),controllerOptions,
    assertAuthority:()=>{if(!authority)throw Error('revoked');},attestStoppedWriter:()=>stopped,readPendingQuestions:()=>questions};
  now=base+1000;const oldRepair=api.createRepair(options);
  let started;
  if(stage==='no-baseline'){
   assert.equal(controller.lookupRecord(f.owner,'transaction',oldRepair.scope.begin_key),null);
  }else if(stage==='baseline-only'){
   const real=controller.beginSerial;controller.beginSerial=()=>{throw Error('fixture-stop-before-begin');};
   try{assert.throws(()=>oldRepair.start(),/fixture-stop-before-begin/);}finally{controller.beginSerial=real;}
   started={begin_key:oldRepair.scope.begin_key,completion_key:oldRepair.scope.begin_key+':complete'};
   assert.equal(controller.lookupRecord(f.owner,'transaction',started.begin_key),null);
  }else started=oldRepair.start();
  const baselineFile=path.join(path.dirname(files.planFile),'.delivery-verification-'+oldRepair.scope.original_sha256+'.json');
  let baselineBytes=fs.existsSync(baselineFile)?fs.readFileSync(baselineFile):null;
  if(stage==='no-baseline')assert.equal(baselineBytes,null);
  if(stage==='completed-released'){
   fixtures.publish(f.owner,{milestone,slice,task,codeDir:f.a,at:new Date(base+2000).toISOString()});now=base+3000;assert.equal(oldRepair.complete().outcome,'completed');
   assert(claims.releaseClaim(f.owner,milestone,{at:Date.now(),mechanism:'manual',evidence:{fixture:true}}).ok);
  }
  runs.update(f.owner,milestone,{active:false});observe('fixture-new');
  const bridge=()=>api.resumeAndCreateRepair({...options,ownerToken:'fixture-new',expectedSession:'fixture-new',expectedRecordSha256:roots.digest(fs.readFileSync(runs.runFile(f.owner,milestone))),confirmOwnerStopped:true,confirmWorkspaceQuiescent:true});
  const before=fs.readFileSync(runs.runFile(f.owner,milestone));
  questions=[{id:'pending-functional',status:'pending'}];assert.throws(bridge,/pending-questions/);questions=[];
  authority=false;assert.throws(bridge,/authority-required/);authority=true;
  stopped=false;assert.throws(bridge,/writer-not-stopped/);stopped=true;
  assert(fs.readFileSync(runs.runFile(f.owner,milestone)).equals(before));
  if(stage==='no-baseline'){
   assert(!fs.existsSync(baselineFile),'read-only preflight refusals cannot publish a baseline');
   assert.throws(()=>api.publishPreparedResumeBaseline(f.owner,runs.get(f.owner,milestone),{...options,approved:true},oldRepair.scope),/live-adapter-required/,'serialized flags cannot mint the private publication capability');
   if(host==='codex'&&mode==='auto'){
    const write=fs.writeFileSync;fs.writeFileSync=(target,...args)=>{if(typeof target==='string'&&path.resolve(target)===path.resolve(baselineFile))throw Object.assign(Error('fixture-baseline-publication-failed'),{code:'fixture-baseline-publication-failed'});return write(target,...args);};
    try{assert.throws(bridge,/fixture-baseline-publication-failed/);}finally{fs.writeFileSync=write;}
    assert(fs.readFileSync(runs.runFile(f.owner,milestone)).equals(before),'failed baseline publication must precede any owner mutation');
    assert(!fs.existsSync(baselineFile));
   }
  }
  if(stage==='open'){
   const lease=controller.dependencies.forgeLease;
   const leaseFile=lease.leaseFile(f.owner,unit),held=JSON.parse(fs.readFileSync(leaseFile,'utf8'));
   held.expires_at=Date.now()-10000;fs.writeFileSync(leaseFile,JSON.stringify(held));
   if(host==='codex'&&mode==='auto'){
    fs.writeFileSync(leaseFile,JSON.stringify({...held,generation:'foreign-generation'}));
    assert.throws(bridge,/retained-lease-invalid/,'expiry does not authorize a foreign generation');fs.writeFileSync(leaseFile,JSON.stringify(held));
    const bytes=fs.readFileSync(files.planFile);fs.appendFileSync(files.planFile,'\nchanged plan\n');assert.throws(bridge,/baseline-invalid/);fs.writeFileSync(files.planFile,bytes);
    const prior=claims.readClaim(runs.get(f.owner,milestone));claims.recordClaim(f.owner,milestone,{unit,source:'manual',code_dir:f.a,paths:['foreign.js']});
    assert.throws(bridge,/baseline-invalid/);runs.update(f.owner,milestone,{write_claim:prior});
    runs.update(f.owner,milestone,{worker:'execute-task/T99',worker_started:Date.now()});assert.throws(bridge,/worker-unreconciled/);runs.update(f.owner,milestone,{worker:null,worker_started:null});
   }
   const extra=lease.acquire(f.owner,'plan-slice/S02',{ownerToken:'foreign',hostRuntime:host});assert(extra.ok);
   assert.throws(bridge,/owner-resume-lease-present/);assert(lease.release(f.owner,'plan-slice/S02','foreign',extra.generation).ok);
   const source=path.join(f.a,files.source),bytes=fs.readFileSync(source);fs.appendFileSync(source,'// drift');assert.throws(bridge,/code-changed/);fs.writeFileSync(source,bytes);
  }
  assert.throws(()=>api.createRepair({...options,ownerToken:'fixture-new'}),error=>['delivery-repair-baseline-invalid','delivery-repair-claim-required'].includes(error.code),'direct imported owner does not adopt legacy identity');
  const repair=bridge();
  if(stage==='no-baseline'){
   started={begin_key:repair.scope.begin_key,completion_key:repair.scope.begin_key+':complete'};
   baselineBytes=fs.readFileSync(baselineFile);
   assert.equal(runs.get(f.owner,milestone).owner_resume_history.at(-1).boundary.delivery_repair.begin_key,started.begin_key,'history binds the already published baseline');
   assert.equal(controller.lookupRecord(f.owner,'transaction',started.begin_key),null,'owner transfer does not fake a repair begin');
   assert.equal(bridge().scope.begin_key,started.begin_key,'restart after transfer and before start retains the baseline');
  }
  assert.equal(repair.scope.begin_key,started.begin_key);
  const current=repair.start();assert.equal(current.begin_key,started.begin_key);
  if(stage!=='completed-released'){
   fixtures.publish(f.owner,{milestone,slice,task,codeDir:f.a,at:new Date(base+4000).toISOString()});now=base+5000;
   assert.equal(repair.complete().outcome,'completed');
  }else assert.equal(repair.complete().status,'completed');
  assert.equal(repair.start().status,'completed');
  // Same-owner restart and a second transfer preserve the same baseline and
  // admit completed/no-lease proof, including after canonical claim release.
  const same=bridge();assert.equal(same.start().status,'completed');
  observe('fixture-third');
  assert.throws(()=>same.start(),/authority-required/);
  const third=api.resumeAndCreateRepair({...options,ownerToken:'fixture-third',expectedSession:'fixture-third',expectedRecordSha256:roots.digest(fs.readFileSync(runs.runFile(f.owner,milestone))),confirmOwnerStopped:true,confirmWorkspaceQuiescent:true});
  assert.equal(third.start().status,'completed');assert.equal(third.complete().status,'completed');
  let resumedSnapshot;
  for(const ownerToken of [undefined,'fixture-third']){
   const resumed=loop.invoke(host,mode,'resume-delivery',{...input,...(ownerToken?{owner_token:ownerToken}:{}),repair_begin_key:started.begin_key},JSON.parse(JSON.stringify(decision.snapshot)),controllerOptions).result;
   assert.equal(resumed.outcome,'resumed',JSON.stringify(resumed));
   resumedSnapshot=resumed.snapshot;
  }
  const foreign=loop.invoke(host,mode,'resume-delivery',{...input,owner_token:'foreign',repair_begin_key:started.begin_key},decision.snapshot,controllerOptions).result;assert.equal(foreign.outcome,'blocked');
  const count=controller.readEvents(controller.eventsFile(f.owner,milestone)).filter(e=>e.action==='begin'&&e.unit===unit).length;
  const next=loop.invoke(host,mode,'next',input,resumedSnapshot,controllerOptions).result;
  assert.notEqual(next.reason_code,'execution-delivery-recovery-required');
  assert.equal(next.outcome,'dispatch_required',next.reason_code);
  assert.equal(next.unit.key,'complete-slice/S01');
  assert.equal(controller.readEvents(controller.eventsFile(f.owner,milestone)).filter(e=>e.action==='begin'&&e.unit===unit).length,count,'next never reruns the implementation');
  originalFiles.forEach((file,i)=>assert(fs.readFileSync(file).equals(originalBytes[i]),'immutable original transaction'));
  assert(fs.readFileSync(baselineFile).equals(baselineBytes),'immutable legacy baseline');
  console.log('PASS delivery repair '+host+'/'+mode+'/'+stage);cases++;
 }finally{process.env=oldEnv;f.cleanup();}
}
// Source-policy capture: real dirty blob persistence through the public
// verifier, no historical dependence on today's ignore file or working tree.
function policyCase(){
 const f=lab.fixture(),oldEnv={...process.env};try{
  const home=path.join(f.dir,'home');fs.mkdirSync(home);Object.assign(process.env,{HOME:home,USERPROFILE:home,FORGE_HOME:path.resolve(__dirname,'..')});
  const milestone='M001',slice='S01',task='T01';
  const files=fixtures.prepare(f.a,{milestone,slice,task});
  fs.writeFileSync(path.join(f.a,'.gitignore'),'node_modules/\n.gsd/\n');git(f.a,['add','.gitignore',files.source]);git(f.a,['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','policy fixture']);
  fs.writeFileSync(files.planFile,fs.readFileSync(files.planFile,'utf8').replace('writes: [src/T01.js]','writes: [src/**, node_modules/**]'));
  const initial=fixtures.publish(f.a,{milestone,slice,task});
  git(f.a,['config','core.autocrlf','true']);
  fs.writeFileSync(path.join(f.a,'.gitignore'),'node_modules/\r\n.gsd/\r\n.gsd/forge/evidence-*.jsonl\r\n');
  const hash=git(f.a,['hash-object','.gitignore']);assert.notEqual(cp.spawnSync('git',['cat-file','-e',hash],{cwd:f.a,stdio:'ignore',windowsHide:true}).status,0);
  const expand=require('./forge-delivery-source-scope').expand;
  assert.throws(()=>expand(f.a,{revision:git(f.a,['rev-parse','HEAD']),workspace:[{path:'.gitignore',hash}]},['src/**']),/delivery-source-inventory-unreadable/,'a reader cannot replace a missing historical policy with current bytes');
  assert.notEqual(cp.spawnSync('git',['cat-file','-e',hash],{cwd:f.a,stdio:'ignore',windowsHide:true}).status,0,'the failed read did not persist an object');
  const contract=roots.singleContract(f.a,f.a),plan=fs.readFileSync(files.planFile,'utf8');
  const captured=require('./forge-verify').captureRootDelivery(contract,plan,{unit:files.unit,commandsByRoot:{primary:['node -e "process.exit(require(\'./src/T01.js\')===1?0:1)"']}});
  assert(captured.passed);const envelope=captured.gate.roots[0];assert.equal(git(f.a,['cat-file','blob',hash]),'node_modules/\n.gsd/\n.gsd/forge/evidence-*.jsonl');
  for(const [suffix,value]of [['VERIFY-ENVELOPE',envelope],['ARTIFACT-ENVELOPE',captured.artifacts[0]]])fs.writeFileSync(path.join(f.a,files.base,task+'-'+suffix+'.json'),JSON.stringify(value));
  const input={...initial.input,schema_version:2,execution_contract:contract,bindings:initial.input.bindings.map(row=>({...row,root_id:'primary'}))};
  fs.writeFileSync(path.join(f.a,files.base,task+'-DELIVERY-INPUT.json'),JSON.stringify(input));
  const delivery=require('./forge-delivery').buildDelivery(input,{ownerRoot:f.a,codeDir:f.a});assert(delivery.criteria.every(row=>row.status==='verificado'),JSON.stringify(delivery.criteria.map(row=>({id:row.id,status:row.status,pending:row.pending}))));
  fs.writeFileSync(path.join(f.a,files.base,task+'-DELIVERY.json'),JSON.stringify(delivery));
  const clock=require('./forge-milestone-time-clock'),check={cwd:f.a,milestone,slice,task,begunAt:Date.now()-5000,completedAt:Date.now()+1000};
  assert.equal(clock.readCurrentTaskDelivery(check).status,'proven');assert.equal(clock.readHistoricalTaskDelivery(check).status,'proven');
  for(const current of [false,true])assert(expand(f.a,envelope,['src/**'],{current}).paths.includes(files.source));
  const link=path.join(f.a,'policy-hardlink');fs.linkSync(path.join(f.a,'.gitignore'),link);
  try{assert.throws(()=>require('./forge-delivery-source-policy').capture(f.a,require('./forge-surgical-reset').captureAttemptSnapshot(f.a)),/delivery-source-policy-unproven/);}finally{fs.unlinkSync(link);}
  fs.writeFileSync(path.join(f.a,'.gitignore'),'src/**\n');fs.unlinkSync(path.join(f.a,files.source));
  assert(expand(f.a,envelope,['src/**']).paths.includes(files.source));
  assert.equal(clock.readCurrentTaskDelivery(check).status,'unproven');assert.equal(clock.readHistoricalTaskDelivery(check).status,'proven');
  const irrelevant=require('./forge-delivery-source-policy').irrelevantRule;
  assert(irrelevant('.gsd/forge/evidence-*.jsonl','src/**'));
  assert(!irrelevant('build/','src/**'));assert(!irrelevant('!src/private/**','src/**'));assert(!irrelevant('src/priv\\ate/**','src/**'));
  for(const rule of ['src/private-*.js','*.js','build/','!src/**','src/priv\\ate/**','/src/']){
   fs.writeFileSync(path.join(f.a,'.gitignore'),rule+'\n');const capturedHash=git(f.a,['hash-object','-w','.gitignore']);
   assert.throws(()=>expand(f.a,{revision:envelope.revision,workspace:[{path:'.gitignore',hash:capturedHash}]},['src/**']),error=>['delivery-source-ignore-ambiguous','delivery-source-ignored-unproven'].includes(error.code),'a relevant/ambiguous captured rule still refuses: '+rule);
  }
  console.log('PASS dirty captured policy: real canonical capture, current/historical, disjoint generated rule and drift/ambiguity controls');cases++;
 }finally{process.env=oldEnv;f.cleanup();}
}
const roster=[];
for(const host of ['claude','codex'])for(const mode of ['auto','step'])for(const stage of ['no-baseline','baseline-only','open','completed-released'])roster.push({name:host+'/'+mode+'/'+stage,fn:()=>repairCase(host,mode,stage)});
roster.push({name:'captured-source-policy',fn:policyCase});
for(const row of require('./forge-ci-units').selectCases(roster))row.fn();
console.log('PASS '+cases+' integrated cases for issues420-424');
