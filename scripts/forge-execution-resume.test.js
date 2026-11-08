'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const prefsReader=()=>({ok:true,prefs:{workflow:{skip_discuss:true,skip_research:true}}});
function child(){const i=JSON.parse(fs.readFileSync(0,'utf8'));const result=require('./forge-long-workflow-adapter').invoke(i.host,i.mode,i.command,i.input,i.snapshot,{prefsReader,...(i.stop?{failpoint:name=>name===i.stop}:{}),...(i.at!==undefined?{now:()=>i.at}:{}),...(i.questionIdentity?{inspectAttempt:({cwd})=>{const state=require('./forge-pending-questions').listPendingQuestions({cwd,filter:{type:'milestone',id:i.input.milestone}});assert(Array.isArray(state.questions));return{pending_questions:state.questions};}}:{})}).result;process.stdout.write(JSON.stringify(result)+'\n');}
function invoke(f,command,input,snapshot,stop,at,questionIdentity){const r=cp.spawnSync(process.execPath,[__filename,'--child'],{input:JSON.stringify({host:input.host_runtime||f.host,mode:f.mode,command,input,snapshot,stop,at,questionIdentity}),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1048576});assert.equal(r.status,0,r.stderr||r.error?.message);return JSON.parse(r.stdout.trim());}
function write(root,relative,value){const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}
function delivery(f){const roots=require('./forge-code-roots'),verify=require('./forge-verify'),d=require('./forge-delivery');
 const prefix=`.gsd/milestones/${f.milestone}/slices/S03/tasks/T01/T01`,plan=`---\nid: T01\ndepends: []\nwrites:\n  - scripts/result.js\nmust_haves:\n  truths:\n    - resumed task behavior is verified\n  artifacts: []\n  key_links: []\nexpected_output:\n  - scripts/result.js\nverify:\n  - node scripts/check.js\n---\n`;
 write(f.cwd,prefix+'-PLAN.md',plan);const contract=roots.singleContract(f.cwd,f.cwd),unit={type:'task',id:'T01',slice:'S03',milestone:f.milestone};const sha=crypto.createHash('sha256').update(plan).digest('hex');
 const gate=verify.runRootVerification(contract,{unit,planFingerprint:sha,taskPlanVerify:verify.parsePlanVerify(plan),commandTimeoutMs:3000});assert.equal(gate.passed,true);write(f.cwd,prefix+'-VERIFY-ENVELOPE.json',JSON.stringify(gate.roots[0])+'\n');
 const input={schema_version:2,execution_contract:contract,unit,plan:prefix+'-PLAN.md',plan_fingerprint:sha,bindings:[{criterion:{kind:'truth',index:0},aspect:'default',coverage:'behavioral',source:{kind:'verification',path:prefix+'-VERIFY-ENVELOPE.json',check_index:0}}]};
 write(f.cwd,prefix+'-DELIVERY-INPUT.json',JSON.stringify(input)+'\n');const built=d.buildDelivery(input,{ownerRoot:f.cwd,codeDir:f.cwd});assert.deepEqual(built.diagnostics,[]);assert(built.criteria.every(c=>c.status==='verificado'));write(f.cwd,prefix+'-DELIVERY.json',JSON.stringify(built)+'\n');return prefix;
}
function pauseResumeRounds(helper,roots){
 const f=helper.fixture('codex','auto',true);roots.push(f);
 const controller=require('./forge-unit-controller'),lease=require('./forge-unit-lease'),questions=require('./forge-pending-questions');
 const git=args=>{const r=cp.spawnSync('git',args,{cwd:f.cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);};
 write(f.cwd,'.gitignore','.gsd/\n');write(f.cwd,'scripts/result.js','module.exports = 1;\n');write(f.cwd,'scripts/check.js',"if(require('./result')!==1)process.exit(1);\n");
 git(['init','-q']);git(['add','.']);git(['-c','user.email=fixture@example.invalid','-c','user.name=Fixture','commit','-qm','fixture']);
 const args=(host,owner,extra={})=>({...f.input,host_runtime:host,owner_token:owner,...extra});
 const paused1=invoke(f,'pause',args('codex','fixture-owner'),f.selected.snapshot);
 const a=invoke(f,'resume',args('claude','fixture-owner',{resume_intent:'execute'}),paused1.snapshot);
 assert.equal(a.outcome,'dispatch_required');delivery(f); // Genuine delivery, but stale for every later begin.
 const opened=questions.openQuestions({cwd:f.cwd,milestone:f.milestone,unit:a.unit.key,decision_set:'functional-rounds',questions:[{id:'real-choice',question:'Escolha funcional da fixture?'}]});
 const questionFile=path.join(f.cwd,'.gsd/forge/questions',opened.identity_sha256+'.json'),questionBytes=fs.readFileSync(questionFile);
 const paused2=invoke(f,'pause',args('claude','fixture-owner'),a.snapshot);
 assert.equal(paused2.lifecycle,'paused');assert.equal(lease.observe(f.cwd,a.unit.key).lease,null,'second pause must release the CURRENT resumed lease');
 assert.notEqual(paused2.boundary.idempotency_key,paused1.boundary.idempotency_key,'each pause round has its own canonical transition');
 const count=()=>controller.readEvents(controller.eventsFile(f.cwd,f.milestone)).length;
 const before=count(),again=invoke(f,'pause',args('claude','fixture-owner'),a.snapshot);
 assert.deepEqual(again.boundary,paused2.boundary);assert.equal(count(),before);assert(fs.readFileSync(questionFile).equals(questionBytes));
 const unresolved=invoke(f,'resume',args('codex','fixture-owner-B',{resume_intent:'execute',approved:true}),paused2.snapshot,undefined,undefined,opened.identity_sha256);
 assert.equal(unresolved.reason_code,'pending-questions','imported approved cannot answer a real pending question');assert.equal(unresolved.snapshot.lifecycle,'paused');assert(fs.readFileSync(questionFile).equals(questionBytes));
 questions.answer({cwd:f.cwd,identity:opened.identity_sha256,answers:[{id:'real-choice',answer:'prosseguir',source:'user-text'}]});
 const b=invoke(f,'resume',args('codex','fixture-owner-B',{resume_intent:'execute'}),paused2.snapshot,undefined,undefined,opened.identity_sha256);
 assert.equal(b.outcome,'dispatch_required');assert.equal(b.host_runtime,'codex');assert.notEqual(b.controller_result.details.transaction.idempotency_key,a.controller_result.details.transaction.idempotency_key);
 assert.notEqual(b.controller_result.details.transaction.generation,a.controller_result.details.transaction.generation);
 const stalePause=invoke(f,'pause',args('claude','fixture-owner'),a.snapshot);
 assert.equal(stalePause.outcome,'blocked');assert.equal(stalePause.snapshot.lifecycle,'dispatch_required');assert.equal(lease.observe(f.cwd,b.unit.key).lease.generation,b.controller_result.details.transaction.generation,'stale pause never releases a successor lease');
 const tampered=JSON.parse(JSON.stringify(b.snapshot));tampered.last_decision.controller_result.details.transaction.generation='foreign-generation';
 assert.equal(invoke(f,'pause',args('codex','fixture-owner-B'),tampered).reason_code,'unit-identity-mismatch');
 const failed3=invoke(f,'pause',args('codex','fixture-owner-B'),b.snapshot,'after-intent');
 assert.equal(failed3.outcome,'blocked','pause after-intent must expose a recoverable transition');assert.equal(failed3.snapshot.lifecycle,'dispatch_required');
 assert.equal(lease.observe(f.cwd,b.unit.key).lease.generation,b.controller_result.details.transaction.generation);
 const paused3=invoke(f,'pause',args('codex','fixture-owner-B'),b.snapshot);assert.equal(paused3.lifecycle,'paused');assert.equal(lease.observe(f.cwd,b.unit.key).lease,null);
 assert.notEqual(paused3.boundary.idempotency_key,paused2.boundary.idempotency_key);
 const c=invoke(f,'resume',args('claude','fixture-owner-C',{resume_intent:'execute'}),paused3.snapshot);assert.equal(c.outcome,'dispatch_required');
 const failed4=invoke(f,'pause',args('claude','fixture-owner-C'),c.snapshot,'after-lease-released');assert.equal(failed4.outcome,'blocked');assert.equal(failed4.snapshot.lifecycle,'dispatch_required');assert.equal(lease.observe(f.cwd,c.unit.key).lease,null);
 const paused4=invoke(f,'pause',args('claude','fixture-owner-C'),c.snapshot);assert.equal(paused4.lifecycle,'paused');assert.equal(lease.observe(f.cwd,c.unit.key).lease,null);
 assert.notEqual(paused4.boundary.idempotency_key,paused3.boundary.idempotency_key);assert(paused4.boundary.idempotency_key.length<256,'round keys stay bounded');
 const d=invoke(f,'resume',args('codex','fixture-owner-D',{resume_intent:'execute'}),paused4.snapshot);assert.equal(d.outcome,'dispatch_required');
 const last=d.controller_result.details.transaction;assert.notEqual(last.idempotency_key,c.controller_result.details.transaction.idempotency_key);
 assert.equal(invoke(f,'complete',args('codex','fixture-owner-D',{result:{status:'done'}}),d.snapshot).reason_code,'execution-resume-delivery-required','capture from an earlier resumed begin is stale for the LAST begin');
 delivery(f);const done=invoke(f,'complete',args('codex','fixture-owner-D',{result:{status:'done'}}),d.snapshot);assert.equal(done.outcome,'completed');assert.equal(lease.observe(f.cwd,d.unit.key).lease,null);assert.equal(controller.lookupRecord(f.cwd,'transaction',last.idempotency_key+':complete').phase,'committed');
 assert.equal(invoke(f,'resume',args('codex','fixture-owner-D',{resume_intent:'execute'}),paused4.snapshot).lifecycle,'idle');
 assert.equal(questions.continuation({cwd:f.cwd,identity:opened.identity_sha256}).questions.find(q=>q.id==='real-choice').answer,'prosseguir');
}
function main(){const helper=require('./forge-loop-failure.test'),controller=require('./forge-unit-controller'),lease=require('./forge-unit-lease'),roots=[];
 try{
  for(const mode of ['auto','task']){
   const f=helper.fixture('codex',mode,true);roots.push(f);const git=args=>{const r=cp.spawnSync('git',args,{cwd:f.cwd,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);};
   write(f.cwd,'.gitignore','.gsd/\n');write(f.cwd,'scripts/result.js','module.exports = 1;\n');write(f.cwd,'scripts/check.js',"if(require('./result')!==1)process.exit(1);\n");git(['init','-q']);git(['-c','user.email=fixture@example.invalid','-c','user.name=Fixture','add','.']);git(['-c','user.email=fixture@example.invalid','-c','user.name=Fixture','commit','-qm','fixture']);
   if(mode==='task')delivery(f); // Genuine capture from BEFORE authorization is still insufficient for the resumed begin.
   const paused=invoke(f,'pause',f.input,f.selected.snapshot);assert.equal(paused.lifecycle,'paused');const eventsBefore=controller.readEvents(controller.eventsFile(f.cwd,f.milestone)).length;
   const response=invoke(f,'resume',{...f.input,response:{choice:'continue'}},paused.snapshot);assert.equal(response.reason_code,'execution-resume-intent-required');assert.equal(response.snapshot.lifecycle,'paused','a refused intent stays resumable');assert.equal(controller.readEvents(controller.eventsFile(f.cwd,f.milestone)).length,eventsBefore);
   const ambiguous=invoke(f,'resume',{...f.input,resume_intent:'execute',response:{value:'done'}},paused.snapshot);assert.equal(ambiguous.reason_code,'execution-resume-intent-invalid');
   const contested=lease.acquire(f.cwd,paused.unit.key,{ownerToken:'competing-owner',requestId:'competing-fixture',hostRuntime:'codex'});assert.equal(contested.ok,true);assert.equal(invoke(f,'resume',{...f.input,resume_intent:'execute',host_runtime:'claude'},paused.snapshot).reason_code,'lease-active');assert.equal(lease.release(f.cwd,paused.unit.key,'competing-owner',contested.generation).ok,true);
   if(mode==='task'){const interrupted=invoke(f,'resume',{...f.input,resume_intent:'execute',host_runtime:'claude'},paused.snapshot,'after-intent');assert.equal(interrupted.outcome,'blocked');assert.equal(interrupted.snapshot.lifecycle,'paused');}
   const resumed=invoke(f,'resume',{...f.input,resume_intent:'execute',host_runtime:'claude'},paused.snapshot);assert.equal(resumed.outcome,'dispatch_required',JSON.stringify(resumed));assert.equal(resumed.unit.key,paused.unit.key);assert.equal(resumed.snapshot.step_count,paused.snapshot.step_count);assert.equal(resumed.host_runtime,'claude');
   const binding=resumed.controller_result.details.transaction;const begin=controller.lookupRecord(f.cwd,'transaction',binding.idempotency_key);assert.equal(begin.after.state.active_slice,'S03');assert.equal(controller.lookupRecord(f.cwd,'transaction',binding.idempotency_key+':complete'),null);
   const repeated=invoke(f,'resume',{...f.input,resume_intent:'execute',host_runtime:'claude'},paused.snapshot);assert.equal(repeated.outcome,'dispatch_required');assert.deepEqual(repeated.controller_result.details.transaction,binding);
   const normal=invoke(f,'next',{...f.input,host_runtime:'claude'},resumed.snapshot);assert.equal(normal.outcome,'dispatch_required');assert.equal(normal.unit.key,paused.unit.key);
   const wrong=invoke(f,'resume',{...f.input,resume_intent:'execute',host_runtime:'claude',owner_token:'foreign-owner'},paused.snapshot);assert.equal(wrong.outcome,'blocked');
   const missing=invoke(f,'complete',{...f.input,host_runtime:'claude',result:{status:'done'}},resumed.snapshot);assert.equal(missing.reason_code,'execution-resume-delivery-required');assert.equal(missing.snapshot.lifecycle,'dispatch_required');assert.equal(controller.lookupRecord(f.cwd,'transaction',binding.idempotency_key+':complete'),null,'authorization and claimed result cannot create success');
   const prefix=delivery(f),deliv=path.join(f.cwd,prefix+'-DELIVERY.json'),bytes=fs.readFileSync(deliv);fs.writeFileSync(deliv,'{}\n');assert.equal(invoke(f,'complete',{...f.input,host_runtime:'claude',result:{status:'done'}},resumed.snapshot).reason_code,'execution-resume-delivery-required');fs.writeFileSync(deliv,bytes);
   if(mode==='task'){const interrupted=invoke(f,'complete',{...f.input,host_runtime:'claude',result:{status:'done'}},resumed.snapshot,'after-intent');assert.equal(interrupted.outcome,'blocked');assert.equal(controller.lookupRecord(f.cwd,'transaction',binding.idempotency_key+':complete').phase,'intent');fs.writeFileSync(deliv,'later mutable source after verified completion intent\n');}
   const finished=invoke(f,'complete',{...f.input,host_runtime:'claude',result:{status:'done'}},resumed.snapshot);assert.equal(finished.outcome,'completed',JSON.stringify(finished));assert.equal(finished.snapshot.lifecycle,mode==='task'?'completed':'idle');assert.equal(controller.lookupRecord(f.cwd,'transaction',binding.idempotency_key+':complete').phase,'committed');
   fs.writeFileSync(deliv,'later mutable source\n');assert.equal(invoke(f,'complete',{...f.input,host_runtime:'claude',result:{status:'done'}},resumed.snapshot).outcome,'completed','canonical committed delivery replays without reproving later sources');
   const oldSnapshot=invoke(f,'resume',{...f.input,resume_intent:'execute',host_runtime:'claude'},paused.snapshot);assert.equal(oldSnapshot.snapshot.lifecycle,mode==='task'?'completed':'idle','stale paused snapshot never launches a completed execution again');assert.equal(oldSnapshot.action,mode==='task'?'stop':'continue');
   assert.equal(lease.observe(f.cwd,paused.unit.key).lease,null);
  }
  pauseResumeRounds(helper,roots);
  {
   const f={cwd:fs.mkdtempSync(path.join(require('os').tmpdir(),'forge-resume-cap-')),milestone:'M-20261108000000-resume-cap',host:'codex',mode:'auto'};roots.push(f);f.input={cwd:f.cwd,milestone:f.milestone,workflow_id:'resume-cap-fixture',owner_token:'fixture-owner',max_steps:4};write(f.cwd,'.gsd/forge/.fixture','fixture');const time=require('./forge-milestone-time'),questions=require('./forge-pending-questions'),base=Date.now();
   const payload={schema_version:1,milestone:f.milestone,clock_policy:{id:'forge-milestone-time-clock',version:1},option:{id:'balanced',options_sha256:'a'.repeat(64),label:'Entrega verificada'},activated_at:new Date(base).toISOString(),preselection_started_at:new Date(base-5).toISOString(),ceiling_ms:1000,endpoint:{kind:'verified-integrated-delivery',items:Object.fromEntries(time.ENDPOINT_ITEMS.map(k=>[k,'pending']))},allocation:null,linked_task:null,chain_forecast:null};
   const opened=questions.openQuestions({cwd:f.cwd,milestone:f.milestone,unit:'milestone-time/resume-cap',decision_set:'milestone-time-activation',questions:[{id:'resume-cap',question:'Ativar contrato da fixture?'}]});questions.answer({cwd:f.cwd,identity:opened.identity_sha256,answers:[{id:'resume-cap',answer:'option:balanced',source:'user-text'}]});
   const live={reference:'fixture-resume-cap',status:'resolved',answer:'option:balanced',source:'user-text',resolved_at:new Date(base).toISOString(),question:{identity_sha256:opened.identity_sha256,id:'resume-cap'}};
   const handle=time.createDecisionAuthority(()=>live).issue(live.reference,{milestone:f.milestone,kind:'activation',request_sha256:require('./forge-code-roots').digest(payload),expires_at:Date.now()+60000},()=>base);
   time.activateContract({cwd:f.cwd,milestone:f.milestone,contract:payload,now:base,handle});
   write(f.cwd,`.gsd/milestones/${f.milestone}/${f.milestone}-ROADMAP.md`,'# Roadmap\n- [ ] **S03: Task** `depends:[]`\n');write(f.cwd,`.gsd/milestones/${f.milestone}/slices/S03/S03-PLAN.md`,'# Plan\n- [ ] **T01: Task**\n');require('./forge-state').write(f.cwd,{milestone:f.milestone,kind:'milestone',phase:'idle',active_slice:'S03',active_task:'—',auto_mode:'on'});
   const selected=invoke(f,'next',f.input,null,undefined,base+1);assert.equal(selected.unit.type,'execute-task');const paused=invoke(f,'pause',f.input,selected.snapshot,undefined,base+2000);
   const refused=invoke(f,'resume',{...f.input,resume_intent:'execute'},paused.snapshot,undefined,base+2001);assert.equal(refused.reason_code,'milestone-budget-exhausted',JSON.stringify(refused));assert.equal(refused.snapshot.lifecycle,'paused');assert.equal(controller.lookupRecord(f.cwd,'transaction','forge-orchestrate-resume-execution:'+paused.boundary.idempotency_key),null,'authorization resume cannot use the answer-as-result budget exception');
  }
  const f=helper.fixture('codex','auto',false);roots.push(f);const paused=invoke(f,'pause',f.input,f.selected.snapshot);assert.equal(paused.unit.type,'plan-slice');const answered=invoke(f,'resume',{...f.input,response:{choice:'review accepted'}},paused.snapshot);assert.equal(answered.outcome,'resumed');assert.equal(answered.lifecycle,'idle','legitimate answer-as-result remains compatible outside unfinished execute-task');
  console.log('PASS fresh-process execute resume retains same unit until genuine captured delivery; idempotence, invalid results and answer-as-result compatibility');
 }finally{for(const f of roots)helper.cleanup(f);}}
if(process.argv[2]==='--child')child();else try{main();}catch(error){console.error(error.stack);process.exitCode=1;}
