'use strict';
// Genuine canonical owner test. No channel/profile/callback capability is mocked.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
function createOwnerFixture({root=null,legacy=false,workflow='M901',mode='step',securityScope=false}={}){
 if(root){root=fs.realpathSync.native(root);for(const key of ['HOME','USERPROFILE','CODEX_HOME','CLAUDE_CONFIG_DIR']){const rel=path.relative(root,path.resolve(process.env[key]||''));if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('fixture homes must be isolated before Forge imports');}}
 const controller=require('./forge-unit-controller'),runs=require('./forge-runs'),claims=require('./forge-write-claim'),lab=require('./forge-code-roots.test');
 const put=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof text==='string'?text:JSON.stringify(text));};
 let f;
 if(!root)f=lab.fixture();else{
 const dir=fs.realpathSync.native(fs.mkdtempSync(path.join(root,'owner-fixture-'))),mark=crypto.randomBytes(16).toString('hex');fs.writeFileSync(path.join(dir,'OWNED'),mark);
 const owner=path.join(dir,'owner');fs.mkdirSync(owner);const a=lab.checkout(path.join(dir,'alpha')),b=lab.checkout(path.join(dir,'beta'));
 const contract=require('./forge-code-roots').validateContract({schema_version:2,owner,primary_root_id:'alpha',code_roots:[{id:'alpha',path:a},{id:'beta',path:b}]});
 f={dir,owner,a,b,contract,cleanup(){assert.equal(path.dirname(fs.realpathSync.native(dir)),root);assert(!fs.lstatSync(dir).isSymbolicLink());assert.equal(fs.readFileSync(path.join(dir,'OWNED'),'utf8'),mark);fs.rmSync(dir,{recursive:true,force:true});}};
 }
 const milestone='M901',slice='S01',task='T01',base=path.join(f.owner,'.gsd/milestones',milestone,'slices',slice),planFile=path.join(base,'tasks',task,task+'-PLAN.md');
 const plan=lab.plan(f.contract).replace('id: T-roots','id: T01').replace('effort: medium','effort: high').replace('must_haves:',"verify:\n  - node check.cjs\nmust_haves:")+(securityScope?'\nFixture security scope: sessionToken.\n':'');
 put(planFile,plan);put(planFile.replace('-PLAN.md','-PLAN-GATE.md'),'status: approved\nplan_sha256: '+crypto.createHash('sha256').update(plan).digest('hex')+'\n');
 const securityFile=planFile.replace('-PLAN.md','-SECURITY.md'),securitySpec=fs.readFileSync(path.join(__dirname,'../shared/forge-dispatch.md'),'utf8'),
   securityScan=require('./forge-native-host-request').scanSecurityPlan(plan,securitySpec);
 let securitySha256=null;
 if(securityScan.required){
  const skill=fs.readFileSync(path.join(__dirname,'../skills/forge-security/SKILL.md'),'utf8'),
    templates=[...skill.matchAll(/```markdown\r?\n(# Security Checklist \u2014 [\s\S]*?)\r?\n```/g)].map(match=>match[1]);
  assert.equal(templates.length,2,'both canonical security checklist templates remain available');
  const checklist=templates[0].replaceAll('{T## or S##}',task).replaceAll('{T##}',task).replaceAll('{title}','Native fixture');
  put(securityFile,checklist);securitySha256=crypto.createHash('sha256').update(checklist).digest('hex');
 }
 put(path.join(base,slice+'-PLAN.md'),'# Slice\n- [ ] **T01** — fixture\n');put(path.join(base,slice+'-CONTEXT.md'),'# Context\n## Decisions\nPreserve exact claimed files.\n');
 put(path.join(f.owner,'.gsd/milestones',milestone,milestone+'-ROADMAP.md'),'# Roadmap\n- [ ] **S01: Native** '+String.fromCharCode(96)+'depends:[]'+String.fromCharCode(96)+'\n');
 put(path.join(f.owner,'.gsd/forge-prefs.jsonc'),{tier_models:{standard:['claude-sonnet-5-5']},effort:{'execute-task':'high'},auto_commit:false});
 for(const root of f.contract.code_roots)put(path.join(root.path,'check.cjs'),"require('assert').equal(require('fs').readFileSync('same.txt','utf8'),'after\\n');console.log('PASS native463 claimed root content');\n");
 runs.add(f.owner,{id:milestone,kind:'milestone',host_runtime:'claude',session_id:'fixture-native463'});
 claims.recordClaim(f.owner,milestone,{schema_version:2,source:'plan-writes',unit:'execute-task/T01',execution_contract:f.contract,paths:f.contract.code_roots.map(r=>({root_id:r.id,path:'same.txt'}))});
 require('./forge-state').write(f.owner,{milestone,phase:'idle',active_slice:slice,active_task:'—',auto_mode:'on'});
 const key='native463-original-begin';controller.beginSerial(f.owner,{milestone,unit:'execute-task/T01',slice,host_runtime:'claude',owner_token:'fixture-native463-owner',session:'fixture-native463',idempotency_key:key,ttl_ms:300000},legacy?{}:{workflow:{mode,workflow_id:workflow,remaining_steps:12}});
 const begin=controller.lookupRecord(f.owner,'transaction',key),input={schema_version:1,owner:f.owner,run_id:milestone,milestone_id:milestone,slice_id:slice,task_id:task,begin_key:key,expected_begin_sha256:controller.recordChecksum(begin),workflow_id:null,dispatch_id:null,verification_bindings:[
 {root_id:'alpha',criterion:{kind:'truth',index:0},aspect:'default',coverage:'behavioral',source:{kind:'verification',check_index:0}},
 {root_id:'beta',criterion:{kind:'truth',index:0},aspect:'default',coverage:'behavioral',source:{kind:'verification',check_index:0}},
 {root_id:'alpha',criterion:{kind:'artifact',index:0},aspect:'declared-property',coverage:'structural',source:{kind:'verification',check_index:0}},
 {root_id:'beta',criterion:{kind:'artifact',index:1},aspect:'declared-property',coverage:'structural',source:{kind:'verification',check_index:0}}]};
 return{...f,milestone,workflow,base,planFile,input,begin,key,securityFile,securityScan,securitySha256};
}
module.exports={createOwnerFixture};
function assertSynchronousReadPrelude(){
 const Module=require('node:module'),saved={...process.env},root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-native-prelude-'))),marker=crypto.randomBytes(16).toString('hex');
 fs.writeFileSync(path.join(root,'OWNED'),marker);
 for(const key of ['HOME','USERPROFILE','CODEX_HOME','CLAUDE_CONFIG_DIR','FORGE_HOME']){process.env[key]=path.join(root,key.toLowerCase());fs.mkdirSync(process.env[key]);}
 const owner=path.join(root,'owner'),spool=path.join(root,'spool');fs.mkdirSync(owner);fs.mkdirSync(path.join(owner,'.gsd'));fs.mkdirSync(spool);
 const contextFile=path.join(spool,'context.md'),text='TEST ONLY: no live authority';fs.writeFileSync(contextFile,text);
 const filename=require.resolve('./forge-native-host-request'),raw=fs.readFileSync(filename,'utf8'),hash=x=>crypto.createHash('sha256').update(x).digest('hex'),copy=new Module(filename+'#prelude-data',module);copy.filename=filename;copy.paths=Module._nodeModulePaths(path.dirname(filename));
 const context={},handle={},profile={},badProfile={},request={contextFile,resultFile:path.join(spool,'result'),dispatchId:'TEST-ONLY',verification:{bindings:[1]}},state={generation:1},calls={inspect:0,profile:0,builder:0,sidecar:0};let action=null,active=false;
 const initial={owner,actor:{sessionId:'TEST-ONLY'},gates:{plan:'approved'},claim_generation:1};let api;
 const actualRequire=copy.require.bind(copy),fakeProfile={
  assertSynchronousReadBinding(p,c,h){assert.equal(p,profile);assert.equal(c,context);assert.equal(h,handle);return true;},
  invocationOptions(p,h){calls.profile++;assert(api.synchronousReadPreludeActive(h,p));for(let i=0;i<8;i++)assert.equal(api.assertOwnerContext(context).claim_generation,1);if(action)action();return{nativeHostIntent:p,nativeHostRequest:request};},
  assertCapabilityAdmission(){assert.equal(api.assertOwnerContext(context).claim_generation,1);return{};},
  assertActivityAdmission(p,r){assert.equal(p,profile);assert.deepEqual(r,request);assert.notEqual(r,request);assert(api.synchronousReadPreludeActive(handle,p));for(let i=0;i<8;i++)api.assertOwnerContext(context);if(action)return action();return{test_only:true};}
 };
 copy.require=id=>{
  if(id==='./forge-native-host-profile')return fakeProfile;
  if(id==='./forge-native-invocation')return{buildNativeInvocation(){calls.builder++;api.assertOwnerContext(context);return{ok:true};}};
  if(id==='./forge-unit-sidecar')return{validateRecoveryRequest(){calls.sidecar++;api.assertOwnerContext(context);return{supported:true};}};
  return actualRequire(id);
 };
 copy._compile(raw+String.raw`
 module.exports.__preludeTest={seed(v){
  inspect=()=>{v.inspect();return{facts:{...v.initial,claim_generation:v.state.generation},stamp:digest({...v.initial,claim_generation:v.state.generation})};};
  contexts.set(v.context,{input:{},initial:{facts:v.initial,stamp:digest(v.initial)},request:v.handle});
  requests.set(v.handle,{context:v.context,request:v.request,sha256:digest(v.request),context_sha256:hash(v.text),renderSources:[],channel:{}});
  channelState=()=>({result_file:v.request.resultFile,context_file:v.request.contextFile,dispatch_id:v.request.dispatchId,admission:{}});
 },clear(){return [...[]];}};
 `,filename);api=copy.exports;
 api.__preludeTest.seed({context,handle,request,initial,state,text,inspect(){calls.inspect++;}});
 const windows=actualRequire('./forge-owner-transport-window');
 const run=()=>api.runSynchronousReadPrelude(handle,profile,'execute-owner-preflight');
 const refusal=(code,fn)=>assert.throws(fn,e=>e.code===code);
 try{
  const start=calls.inspect,value=run();assert.deepEqual(value.request,request);assert.equal(calls.inspect-start,2,'many internal inspections borrow only inside the closed fenced operation');assert.equal(calls.builder,1);assert.equal(calls.sidecar,1);
  assert.equal(api.synchronousReadPreludeActive(handle,profile),false);assert.equal(windows.currentPublicationGuard(owner,true),undefined);
  const outside=calls.inspect;api.assertOwnerContext(context);api.assertOwnerContext(context);assert.equal(calls.inspect-outside,2,'no reuse survives EXIT');
  const second=calls.inspect;run();assert.equal(calls.inspect-second,2,'next boundary must revalidate ENTRY and EXIT');
  assert.deepEqual(api.runSynchronousReadPrelude(handle,profile,'activity-admission',request),{test_only:true});
  refusal('native-host-request-handle-required',()=>api.runSynchronousReadPrelude({},profile,'execute-owner-preflight'));
  assert.throws(()=>api.runSynchronousReadPrelude(handle,badProfile,'execute-owner-preflight'));
  refusal('native-host-read-prelude-operation',()=>api.runSynchronousReadPrelude(handle,profile,()=>{}));
  refusal('native-host-read-prelude-operation',()=>api.runSynchronousReadPrelude(handle,profile,'execute-owner-preflight',request));
  let getterCalls=0,insideCallbacks=0;const getterBindings=[1];Object.defineProperty(getterBindings,'0',{enumerable:true,get(){getterCalls++;if(api.synchronousReadPreludeActive(handle,profile))insideCallbacks++;return 1;}});
  const getterRequest={...request,verification:{bindings:getterBindings}};assert.deepEqual(api.runSynchronousReadPrelude(handle,profile,'activity-admission',getterRequest),{test_only:true});assert.equal(getterCalls,1);assert.equal(insideCallbacks,0,'getter executes only before the fenced frame exists');
  let mapCalls=0;const ownMap=[1];ownMap.map=()=>{mapCalls++;if(api.synchronousReadPreludeActive(handle,profile))insideCallbacks++;return[1];};assert.throws(()=>api.runSynchronousReadPrelude(handle,profile,'activity-admission',{...request,verification:{bindings:ownMap}}),e=>e.name==='DataCloneError');assert.equal(mapCalls,0);
  const proxyRequest=new Proxy(request,{ownKeys(){if(api.synchronousReadPreludeActive(handle,profile))insideCallbacks++;return Reflect.ownKeys(request);}});assert.throws(()=>api.runSynchronousReadPrelude(handle,profile,'activity-admission',proxyRequest),e=>e.name==='DataCloneError');assert.equal(insideCallbacks,0);assert.equal(api.synchronousReadPreludeActive(handle,profile),false);
  const sentinel=new Error('TEST_BODY_SENTINEL');action=()=>{throw sentinel;};assert.throws(run,e=>e===sentinel);action=null;assert.equal(api.synchronousReadPreludeActive(handle,profile),false);
  action=()=>api.runSynchronousReadPrelude(handle,profile,'execute-owner-preflight');refusal('native-host-read-prelude-nested',run);action=null;
  action=()=>({then(){}});refusal('native-host-read-prelude-sync-required',()=>api.runSynchronousReadPrelude(handle,profile,'activity-admission',request));action=null;
  action=()=>{state.generation++;};refusal('native-host-owner-authority-changed',run);state.generation=1;action=null;assert.equal(api.synchronousReadPreludeActive(handle,profile),false);
  const target=path.join(owner,'.gsd','TEST-ONLY-TAMPER');action=()=>fs.writeFileSync(target,'intrusion');refusal('native-host-read-prelude-owner-changed',run);action=null;fs.unlinkSync(target);
  assert.equal(api.synchronousReadPreludeActive(handle,profile),false);assert.equal(windows.currentPublicationGuard(owner,true),undefined);run();
  assert.equal(hash(fs.readFileSync(filename)),hash(raw),'test private module leaves Source unchanged');
  console.log('PASS closed synchronous Native prelude: real owner fence/snapshot ENTRY EXIT, bounded inspection reuse, no cross-boundary reuse, genuine-handle binding, throw/nested/thenable/generation/tamper refusal; TEST DATA only');
 }finally{process.env=saved;assert.equal(fs.readFileSync(path.join(root,'OWNED'),'utf8'),marker);assert(!fs.lstatSync(root).isSymbolicLink());assert.equal(path.dirname(fs.realpathSync.native(root)),fs.realpathSync.native(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
}

function main({autoOnly=false}={}){
const saved={...process.env},privateRoot=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-native463-request-'))),marker=crypto.randomBytes(16).toString('hex');
fs.writeFileSync(path.join(privateRoot,'OWNED'),marker);
for(const [key,rel]of Object.entries({HOME:'home',USERPROFILE:'home',CODEX_HOME:'home/codex',CLAUDE_CONFIG_DIR:'home/claude',FORGE_HOME:'forge'})){process.env[key]=path.join(privateRoot,rel);fs.mkdirSync(process.env[key],{recursive:true});}
process.env.FORGE_CLAUDE_OWNER_SESSION_ID='fixture-native463';process.env.FORGE_CLAUDE_OWNER_SOURCE='claude-sessionstart-env-v1';
const put=(file,text)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof text==='string'||Buffer.isBuffer(text)?text:JSON.stringify(text));};
const source=path.resolve(__dirname,'..'),procedures=JSON.parse(fs.readFileSync(path.join(source,'shared/forge-procedures.json'),'utf8'));
for(const rel of ['shared/forge-procedures.json',...procedures.modules.filter(r=>r.status==='ready').map(r=>r.path)])put(path.join(process.env.FORGE_HOME,rel),fs.readFileSync(path.join(source,rel)));
put(path.join(process.env.FORGE_HOME,'forge-agent-prefs.jsonc'),{});
// Exact-parent isolation is refused before any Forge import or lifecycle call.
const isolation=path.join(privateRoot,'isolation-root');fs.mkdirSync(isolation);
const homes=Object.fromEntries(['HOME','USERPROFILE','CODEX_HOME','CLAUDE_CONFIG_DIR'].map(key=>[key,process.env[key]]));
for(const bad of Object.keys(homes)){
 for(const key of Object.keys(homes)){process.env[key]=path.join(isolation,key.toLowerCase());fs.mkdirSync(process.env[key],{recursive:true});}
 process.env[bad]=privateRoot;const before=fs.readdirSync(isolation).sort();
 try{assert.throws(()=>createOwnerFixture({root:isolation}),/fixture homes must be isolated before Forge imports/);assert.deepEqual(fs.readdirSync(isolation).sort(),before);}
 finally{Object.assign(process.env,homes);}
}
const accounts=require('./forge-accounts'),oldLaunch=accounts.resolveLaunch;accounts.resolveLaunch=()=>({name:'isolated-native463-fixture',token:'fixture-only-not-a-credential'});
const request=require('./forge-native-host-request'),controller=require('./forge-unit-controller'),runs=require('./forge-runs'),claims=require('./forge-write-claim'),questions=require('./forge-pending-questions'),lab=require('./forge-code-roots.test');
const fixture=options=>createOwnerFixture(options);
function code(name,fn){assert.throws(fn,error=>typeof error.code==='string'&&error.code.includes(name));}
function assertAutoPlanGateOwner(){const auto=fixture({mode:'auto'});try{
 const gateFile=auto.planFile.replace('-PLAN.md','-PLAN-GATE.md');fs.unlinkSync(gateFile);
 const context=request.buildOwnerContext(auto.input),facts=request.assertOwnerContext(context),adapters=request.ownerAdapters(context);
 assert.equal(facts.gates.plan,'skipped');assert.equal(facts.gates.planSkipReason,'auto-defer');
 assert.equal(facts.gates.authorizationReference,'native-host-auto/'+auto.input.expected_begin_sha256);
 assert.equal(fs.existsSync(gateFile),false,'auto creates no human approval marker');
 assert(adapters.executionPlanGate&&Object.isFrozen(adapters.executionPlanGate));
 const execution=require('./forge-task-execution'),r={phase:'execute',scope:'milestone',unitType:'execute-task',cwd:facts.execution_contract.code_roots.find(v=>v.id===facts.execution_contract.primary_root_id).path,contextRoot:facts.owner,milestoneId:facts.milestone_id,sliceId:facts.slice_id,taskId:facts.task_id,workflowId:facts.workflow_id,dispatchId:'unissued-fixture-dispatch',route:facts.route,planFile:facts.plan_file,execution_contract:facts.execution_contract,gates:facts.gates};
 code('auto-plan-gate-request-required',()=>execution.withAutoPlanGateAdapterSync(adapters.executionPlanGate,r,()=>assert.fail('unissued channel must not grant execution')));
 for(const foreign of [{},JSON.parse(JSON.stringify(adapters.executionPlanGate))])code('auto-gate-adapter-required',()=>execution.withAutoPlanGateAdapterSync(foreign,r,()=>assert.fail('JSON is not gate authority')));
 put(auto.planFile,fs.readFileSync(auto.planFile,'utf8')+'\nChanged plan after adapter production.\n');
 assert.throws(()=>request.ownerAdapters(context),'current plan drift refuses the old context');
 }finally{auto.cleanup();}}

try{
 if(autoOnly){assertAutoPlanGateOwner();console.log('forge-native-host-request auto owner context/closed adapter regressions passed; full-channel positive remains integration evidence');return;}
 const f=fixture();try{
  const context=request.buildOwnerContext(f.input),one=request.assertOwnerContext(context),two=request.assertOwnerContext(context);
  assert.deepEqual(two,one,'complete real canonical owner and route remain stable');
  assert.equal(one.workflow_id,f.workflow);assert.equal(one.gates.security,f.securityScan.required?'passed':'not-applicable');assert.equal(one.input_hashes.security,f.securitySha256);
  const {workflow_id,dispatch_id,...withoutSelectors}=f.input;assert.equal(request.assertOwnerContext(request.buildOwnerContext(withoutSelectors)).workflow_id,f.workflow);
  code('verification-declarations-schema',()=>request.normalizeOwnerInput({...f.input,verification_bindings:[{...f.input.verification_bindings[0],approved:true}]}));
  code('verification-declarations-schema',()=>request.normalizeOwnerInput({...f.input,verification_bindings:[{...f.input.verification_bindings[0],status:'met'}]}));
  code('verification-declarations-schema',()=>request.normalizeOwnerInput({...f.input,verification_bindings:[{...f.input.verification_bindings[0],source:{kind:'verification',check_index:0,passed:true}}]}));
  const declared=request.normalizeOwnerInput(f.input);assert.deepEqual(declared.verification_bindings,f.input.verification_bindings);
  const missing={...f.input};delete missing.verification_bindings;
  const noDeclarations=request.buildOwnerContext(missing);code('verification-bindings-required',()=>request.buildExecutionRequest(noDeclarations,{}));
  const verify=require('./forge-verify'),delivery=require('./forge-delivery'),text=fs.readFileSync(f.planFile,'utf8'),
    seal=verify.normalizeExecutionVerification(f.contract,text,{preferenceCommands:[],commandTimeoutMs:30000},{},{}),
    unit={type:'task',id:'T01',milestone:f.milestone,slice:'S01'};
  assert.equal(delivery.validateExecutionBindings(text,f.contract,unit,declared.verification_bindings,seal).bindings,4);
  for(const change of [rows=>{rows[0].root_id='foreign';},rows=>{rows[0].source.check_index=999;},
    rows=>{rows[0].criterion.index=999;},rows=>{rows.pop();}]){
    const rows=structuredClone(declared.verification_bindings);change(rows);assert.throws(()=>delivery.validateExecutionBindings(text,f.contract,unit,rows,seal));
  }
  assert.equal(one.route.model_resolved,'claude-sonnet-5-5');assert.equal(one.route.effort,'high');
  code('owner-context-required',()=>request.assertOwnerContext({...request.describeOwnerContext(context)}));
  code('request-handle-required',()=>request.readExecutionRequest({}));
  code('publication-request-required',()=>request.assertOwnerContext(context,{publicationAttemptWitness:{}}));
  code('owner-context-options',()=>request.assertOwnerContext(context,{publicationAttemptWitness:{},publicationWitness:{}}));
  let runtimeCalls=0;
  const forgedRuntime=Object.freeze({kind:'native-execution',projectPublicationLease(){runtimeCalls++;return{};}});
  for(const key of ['runtime','publicationRuntime'])code('owner-context-options',()=>request.assertOwnerContext(context,{[key]:forgedRuntime}));
  assert.equal(runtimeCalls,0,'runtime cannot enter through options or function-shaped JSON');
  assert.deepEqual(request.assertOwnerContext(context),one,'failed pending brand/options cannot replace initial authority');
 }finally{f.cleanup();}
 const securitySpec=fs.readFileSync(path.join(source,'shared/forge-dispatch.md'),'utf8');
 assert.equal(request.scanSecurityPlan('Neutral fixture scope.',securitySpec).required,false);
 assert.equal(request.scanSecurityPlan('Fixture scope: sessionToken.',securitySpec).required,true);
 const sensitive=fixture({securityScope:true});try{
  assert.equal(sensitive.securityScan.required,true,'literal scope is scanned in the actual owner plan');
  const checklist=fs.readFileSync(sensitive.securityFile),context=request.buildOwnerContext(sensitive.input);
  assert.equal(request.assertOwnerContext(context).gates.security,'passed');
  assert.equal(request.assertOwnerContext(context).input_hashes.security,sensitive.securitySha256);
  fs.unlinkSync(sensitive.securityFile);code('execution-security-required',()=>request.buildOwnerContext(sensitive.input));
  assert.throws(()=>request.assertOwnerContext(context),'removing required evidence invalidates an existing context');
  put(sensitive.securityFile,'');code('execution-security-required',()=>request.buildOwnerContext(sensitive.input));
  put(sensitive.securityFile,'unstructured text cannot mean readiness');code('security-checklist-unready',()=>request.buildOwnerContext(sensitive.input));
  put(sensitive.securityFile,checklist);assert.equal(request.assertOwnerContext(request.buildOwnerContext(sensitive.input)).gates.security,'passed');
 }finally{sensitive.cleanup();}
 for(const [name,mutate]of[
  ['actor',f=>runs.update(f.owner,f.milestone,{session_id:'foreign-session'})],
  ['claim',f=>{const claim=claims.readClaim(runs.get(f.owner,f.milestone));claims.recordClaim(f.owner,f.milestone,{...claim,paths:[{root_id:f.contract.primary_root_id,path:'other.txt'}]});}],
  ['lease',f=>{const a=require('./forge-unit-lease'),file=a.leaseFile(f.owner,'execute-task/T01'),v=JSON.parse(fs.readFileSync(file,'utf8'));v.generation='foreign-generation';put(file,v);}],
  ['begin',f=>{const file=controller.transactionFile(f.owner,f.key),v=JSON.parse(fs.readFileSync(file,'utf8'));v.workflow_binding.workflow_id='M999';put(file,v);}],
  ['plan',f=>fs.appendFileSync(f.planFile,'\nChanged after context creation.\n')],
  ['gate',f=>put(f.planFile.replace('-PLAN.md','-PLAN-GATE.md'),'status: refused\n')],
  ['security',f=>put(f.planFile.replace('-PLAN.md','-SECURITY.md'),'unstructured text cannot mean readiness')],
  ['context',f=>fs.appendFileSync(path.join(f.base,'S01-CONTEXT.md'),'changed\n')],
  ['prefs/route',f=>put(path.join(f.owner,'.gsd/forge-prefs.jsonc'),{tier_models:{standard:['claude-opus-4-8']},effort:{'execute-task':'high'},auto_commit:false})],
  ['root',f=>fs.renameSync(f.contract.code_roots[0].path,f.contract.code_roots[0].path+'-moved')],
 ]){const f=fixture();try{const context=request.buildOwnerContext(f.input);mutate(f);assert.throws(()=>request.assertOwnerContext(context),undefined,name+' change must refuse');}finally{f.cleanup();}}
 const q=fixture();try{
  const foreign=questions.openQuestions({cwd:q.owner,unit:'research-slice/S99',workflow_id:'M902',decision_set:'foreign-only',questions:[{id:'foreign-q',question:'Pergunta não relacionada 測試?',status:'pending'}]});
  const scoped=request.buildOwnerContext(q.input);assert.equal(request.assertOwnerContext(scoped).workflow_id,'M901');
  const pending=questions.openQuestions({cwd:q.owner,unit:'research-slice/S99',workflow_id:q.workflow,decision_set:'workflow-only',questions:[{id:'original-q',question:'Decisão obrigatória do fluxo: correção 測試?',status:'pending'}]});
  code('pending-questions',()=>request.assertOwnerContext(scoped));code('pending-questions',()=>request.buildOwnerContext(q.input));
  questions.answer({cwd:q.owner,identity:pending.identity_sha256,answers:[{id:'original-q',answer:'Resposta explícita de fixture: sim 測試',source:'user-text'}]});
  assert.equal(request.assertOwnerContext(request.buildOwnerContext(q.input)).workflow_id,q.workflow);
  code('selector-mismatch',()=>request.buildOwnerContext({...q.input,workflow_id:'M902'}));assert.equal(foreign.status,'pending');
 }finally{q.cleanup();}
 for(const mode of ['auto','task','step']){const off=fixture({mode});try{
  put(path.join(off.owner,'.gsd/forge-prefs.jsonc'),{tier_models:{standard:['claude-sonnet-5-5']},effort:{'execute-task':'high'},auto_commit:false,plan_gate:{interactive:'off'}});
  fs.unlinkSync(off.planFile.replace('-PLAN.md','-PLAN-GATE.md'));
  const context=request.buildOwnerContext(off.input);assert.equal(request.assertOwnerContext(context).gates.plan,'skipped');assert.equal(request.assertOwnerContext(context).gates.planSkipReason,'interactive-off');
 }finally{off.cleanup();}}
 const skill=fs.readFileSync(path.join(source,'skills/forge-security/SKILL.md'),'utf8'),
   securityTemplates=[...skill.matchAll(/```markdown\r?\n(# Security Checklist \u2014 [\s\S]*?)\r?\n```/g)].map(match=>match[1]);
 assert.equal(securityTemplates.length,2,'both actual canonical checklist templates are exercised');
 for(const template of securityTemplates){const security=fixture();try{
   const checklist=template.replaceAll('{T## or S##}','T01').replaceAll('{T##}','T01').replaceAll('{title}','Native fixture');
   put(security.planFile.replace('-PLAN.md','-SECURITY.md'),checklist);
   assert.equal(request.assertOwnerContext(request.buildOwnerContext(security.input)).gates.security,'passed','readiness accepts the real canonical em-dash header');
   put(security.planFile.replace('-PLAN.md','-SECURITY.md'),checklist.replace('\u2014','?'));
   code('security-checklist-unready',()=>request.buildOwnerContext(security.input));
 }finally{security.cleanup();}}
 assertAutoPlanGateOwner();
 const legacy=fixture({legacy:true});try{code('workflow-binding-unavailable',()=>request.buildOwnerContext(legacy.input));assert(!Object.hasOwn(controller.lookupRecord(legacy.owner,'transaction',legacy.key),'workflow_binding'));}finally{legacy.cleanup();}
 for(const workflow of ['fluxo-corre\u00e7\u00e3o-\u6e2c\u8a66','fluxo-correc\u0327a\u0303o-\u6e2c\u8a66']){const unicode=fixture({workflow});try{
  const bytes=fs.readFileSync(controller.transactionFile(unicode.owner,unicode.key));
  controller.beginSerial(unicode.owner,{milestone:unicode.milestone,unit:'execute-task/T01',slice:'S01',host_runtime:'claude',owner_token:'fixture-native463-owner',idempotency_key:unicode.key},{workflow:{mode:'step',workflow_id:workflow,remaining_steps:1}});
  assert(fs.readFileSync(controller.transactionFile(unicode.owner,unicode.key)).equals(bytes));
  assert(Buffer.from(controller.lookupRecord(unicode.owner,'transaction',unicode.key).workflow_binding.workflow_id).equals(Buffer.from(workflow)));
  code('workflow-question-scope-unsupported',()=>request.buildOwnerContext({...unicode.input,workflow_id:workflow}));
 }finally{unicode.cleanup();}}
 console.log('forge-native-host-request canonical owner tests passed; full-request positive is exercised by real Bridge CLI tests');
}finally{
 accounts.resolveLaunch=oldLaunch;process.env=saved;assert.equal(fs.readFileSync(path.join(privateRoot,'OWNED'),'utf8'),marker);assert(!fs.lstatSync(privateRoot).isSymbolicLink());assert.equal(path.dirname(fs.realpathSync.native(privateRoot)),fs.realpathSync.native(os.tmpdir()));fs.rmSync(privateRoot,{recursive:true,force:true});
}

}
if(require.main===module){const args=process.argv.slice(2);assert(args.length===0||args.length===1&&['--auto-plan-gate-only','--synchronous-prelude-only'].includes(args[0]),'unknown request test selector');assertSynchronousReadPrelude();if(args[0]!=='--synchronous-prelude-only')main({autoOnly:args.length===1});}
