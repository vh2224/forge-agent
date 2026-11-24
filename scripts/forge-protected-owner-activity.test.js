'use strict';
// Synthetic consent adapter; real questions, roots, controller and reconciliation.
// No operator-project data or provider inference is used by this fixture.
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const activity=require('./forge-protected-owner-activity'),questions=require('./forge-pending-questions');
const roots=require('./forge-code-roots'),runs=require('./forge-runs'),execution=require('./forge-task-execution');
const support=require('./forge-issues-434-436.test'),successor=require('./forge-sidecar-verification-successor');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const put=(file,bytes)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);};
async function fixture(action){return support.fixture(async f=>{
  const file=path.join(f.a,'.gsd/forge/events.jsonl'),prefix=Buffer.from('{"retained":true}\n');put(file,prefix);
  const h=support.historical(f),decision=activity.reconciliationDecision(h.request),owner=questions.openQuestions(decision);
  questions.answer({cwd:f.owner,identity:owner.identity_sha256,answers:[{id:'owner-delta-approval',answer:'aprovar',source:'tool-answer'}]});
  const ts=new Date().toISOString(),triple=[{ts,kind:'resource-admission',reason:'platform-unsupported:win32',source:'platform-degraded',workers:2,pressureLevel:null},
    {ts,kind:'resource-pool-granted',granted:2,ceiling:2,reason:'pool-granted'},
    {ts,kind:'resource-pool-released',granted:2,reason:'pool-released'}];
  const appended=Buffer.from([...triple,...triple].map(JSON.stringify).join('\n')+'\n');fs.appendFileSync(file,appended);
  const originalOwnerAnswer=fs.readFileSync(path.join(f.owner,'.gsd/forge/questions',owner.identity_sha256+'.json'));
  const rootOptions={ownerDecision:owner.identity_sha256,rootId:'alpha',originalBytes:prefix,appendedBytes:appended};
  const proposal=activity.codeRootAppendDecision(h.request,rootOptions),opened=questions.openQuestions(proposal);
  const answerFile=path.join(f.owner,'.gsd/forge/questions',opened.identity_sha256+'.json');
  const originFile=path.join(f.owner,'.gsd/forge/questions',opened.identity_sha256+'.origin.json');
  const answer=()=>questions.answer({cwd:f.owner,identity:opened.identity_sha256,answers:[{id:'code-root-append-approval',answer:'aprovar',source:'tool-answer'}]});
  const options=()=>({request:h.request,hostRuntime:'codex',operatorDecision:owner.identity_sha256,
    assertAuthority:()=>true,attestStoppedWriter:()=>true,readPendingQuestions:()=>[],originalBytes:h.originalBytes,
    attestChanges:challenge=>({challenge_sha256:roots.digest(challenge),changes:challenge.changes.map(row=>({...row,
      kind:row.path.includes('/questions')?'decision-record':'operator-reviewed',reference:'synthetic exact fixture observation'}))}),
    codeRootAppendApproval:{...rootOptions,operatorDecision:opened.identity_sha256,
      attestOperatorAnswer:challenge=>({observed:true,challenge_sha256:roots.digest(challenge),reference:'synthetic host actually handled this canonical answer'})}});
  await action({f,h,file,prefix,appended,rootOptions,proposal,opened,answerFile,originFile,answer,options});
  assert(fs.readFileSync(path.join(f.owner,'.gsd/forge/questions',owner.identity_sha256+'.json')).equals(originalOwnerAnswer));
  support.unchanged(f,h);
});}

// Issue455: old resolved answers are reviewed DATA; only the fresh answer authorizes.
function historyPaths(x,id){return['.json','.origin.json'].map(s=>path.join(x.f.owner,'.gsd/forge/questions',id+s));}
function removeFixtureQuestions(x,ids){for(const id of ids)for(const file of historyPaths(x,id))if(fs.existsSync(file))fs.unlinkSync(file);}
function oldHistory(x){
  x.answer();
  const owner=questions.openQuestions(activity.reconciliationDecision(x.h.request));
  questions.answer({cwd:x.f.owner,identity:owner.identity_sha256,answers:[{id:'owner-delta-approval',answer:'nao',source:'tool-answer'}]});
  const root=questions.openQuestions(activity.codeRootAppendDecision(x.h.request,{...x.rootOptions,ownerDecision:owner.identity_sha256}));
  questions.answer({cwd:x.f.owner,identity:root.identity_sha256,answers:[{id:'code-root-append-approval',answer:'nao',source:'tool-answer'}]});
  const ids=[x.rootOptions.ownerDecision,x.opened.identity_sha256,owner.identity_sha256,root.identity_sha256];
  const pins=new Map(ids.flatMap(id=>historyPaths(x,id).map(file=>[file,fs.readFileSync(file)])));
  for(const id of ids){const answer=questions.continuation({cwd:x.f.owner,identity:id});assert(answer.ok);
    assert.equal(answer.identity.unit,'execute-task/T01');assert.equal(answer.identity.milestone,'M001');assert.equal(answer.identity.slice,'S01');assert.equal(answer.identity.task,'T01');assert.equal(answer.identity.workflow_id,'M001');
    for(const field of ['dispatch_id','request_fingerprint','receipt_phase'])assert.equal(answer.identity[field],null,'owner-origin history cannot prove an exact old request');}
  return{ids,pins,owner:owner.identity_sha256,root:root.identity_sha256};
}
function freshHistoryApproval(x,history,created=[],checkCoverage=true){
  const decision=activity.reconciliationDecision(x.h.request);
  if(checkCoverage){for(const[file,bytes]of history.pins){const relative=path.relative(x.f.owner,file).replace(/\\/g,'/');assert.equal(decision.changes.filter(row=>row.path===relative&&row.after===sha(bytes)).length,1,'both exact historical carrier hashes remain in reviewed');}
    const digest=roots.digest({owner:fs.realpathSync.native(x.f.owner),unit:'execute-task/T01',dispatch_id:x.h.request.dispatchId,changes:decision.changes});
    assert.equal(decision.delta_sha256,digest,'history must not be omitted from reviewed digest');assert.equal(decision.decision_set,'owner-delta/'+digest);}
  const owner=questions.openQuestions(decision);created.push(owner.identity_sha256);
  questions.answer({cwd:x.f.owner,identity:owner.identity_sha256,answers:[{id:'owner-delta-approval',answer:'aprovar',source:'tool-answer'}]});
  const rootOptions={...x.rootOptions,ownerDecision:owner.identity_sha256};
  const append=questions.openQuestions(activity.codeRootAppendDecision(x.h.request,rootOptions));created.push(append.identity_sha256);
  questions.answer({cwd:x.f.owner,identity:append.identity_sha256,answers:[{id:'code-root-append-approval',answer:'aprovar',source:'tool-answer'}]});
  const original=x.options();return{...original,operatorDecision:owner.identity_sha256,
    attestChanges:challenge=>{const classified=original.attestChanges(challenge);return{...classified,changes:classified.changes.map(row=>history.ids.slice(0,2).some(id=>row.path.endsWith('/'+id+'.json')||row.path.endsWith('/'+id+'.origin.json'))?{...row,kind:'operator-reviewed'}:row)};},
    codeRootAppendApproval:{...original.codeRootAppendApproval,...rootOptions,operatorDecision:append.identity_sha256}};
}
function refusedHistory(error){return typeof error?.code==='string'&&(/^(owner-reconciliation-|pending-question-|root-append-)/.test(error.code)||error.code==='ENOENT');}
async function historicalCarrierNegatives(){return fixture(async x=>{
  const history=oldHistory(x),stateFile=historyPaths(x,history.owner)[0],originFile=historyPaths(x,history.owner)[1];
  assert.throws(()=>activity.createOwnerReconciliation(x.options()),refusedHistory,'an old positive answer is not current authority');
  const extra=(name,patch={},resolved=true)=>{const d=activity.reconciliationDecision(x.h.request),q=questions.openQuestions({...d,...patch});
    if(resolved)questions.answer({cwd:x.f.owner,identity:q.identity_sha256,answers:[{id:d.questions[0].id,answer:'nao',source:'tool-answer'}]});
    return()=>removeFixtureQuestions(x,[q.identity_sha256]);};
  const mutate=(file,change)=>{const bytes=fs.readFileSync(file);change(bytes);return()=>fs.writeFileSync(file,bytes);};
  const cases=[
    {name:'unresolved historical pair',prepare:()=>extra('pending',{},false)},
    {name:'missing origin pair',prepare:()=>mutate(originFile,()=>fs.unlinkSync(originFile))},
    {name:'corrupt canonical origin',prepare:()=>mutate(originFile,b=>{const v=JSON.parse(b);v.identity_sha256='f'.repeat(64);fs.writeFileSync(originFile,JSON.stringify(v));})},
    {name:'canonical cross-unit history',prepare:()=>extra('unit',{unit:'execute-task/T02',task:'T02'})},
    {name:'canonical cross-workflow history',prepare:()=>extra('workflow',{workflow_id:'M002'})},
    {name:'canonical unknown decision purpose',prepare:()=>extra('purpose',{decision_set:'unrelated/'+sha('synthetic unknown purpose')})}
  ];
  for(const row of cases){const restore=row.prepare(),created=[];try{
    assert.throws(()=>{const options=freshHistoryApproval(x,history,created,false);activity.createOwnerReconciliation(options);},refusedHistory,row.name);
  }finally{removeFixtureQuestions(x,created);restore();}}
  const created=[],options=freshHistoryApproval(x,history,created);
  try{
    const old=fs.readFileSync(stateFile);fs.appendFileSync(stateFile,' ');
    assert.throws(()=>activity.createOwnerReconciliation(options),refusedHistory,'new current carrier hash was not approved');fs.writeFileSync(stateFile,old);
    assert.throws(()=>activity.createOwnerReconciliation({...options,operatorDecision:undefined}),refusedHistory,'fresh current approval is mandatory');
    const cap=activity.createOwnerReconciliation(options);activity.withOwnerReconciliationRead(cap,x.h.request,()=>{});
    fs.appendFileSync(stateFile,' ');assert.throws(()=>activity.withOwnerReconciliationRead(cap,x.h.request,()=>{}),'historical state mutation after capability must refuse');fs.writeFileSync(stateFile,old);
    const origin=fs.readFileSync(originFile);fs.unlinkSync(originFile);assert.throws(()=>activity.withOwnerReconciliationRead(cap,x.h.request,()=>{}),'historical origin deletion after capability must refuse');fs.writeFileSync(originFile,origin);
    activity.withOwnerReconciliationRead(cap,x.h.request,()=>{});
    for(const[file,bytes]of history.pins)assert(fs.readFileSync(file).equals(bytes),'all old answers/origins retained byte-exact');
    console.log('PASS issue455 historical carrier negatives: unresolved/missing/corrupt/cross-unit/cross-workflow/purpose, fresh hashes, post-cap mutation/deletion; no old answer grants authority');
  }finally{removeFixtureQuestions(x,created);}
});}

async function main(){
  await fixture(async x=>{
    assert.throws(()=>activity.createOwnerReconciliation(x.options()),/root-append-answer-required/,'unanswered cannot authorize');
    const pending=fs.readFileSync(x.answerFile);
    questions.answer({cwd:x.f.owner,identity:x.opened.identity_sha256,answers:[{id:'code-root-append-approval',answer:'nao',source:'tool-answer'}]});
    assert.throws(()=>activity.createOwnerReconciliation(x.options()),/root-append-answer-required/,'negative answer');
    fs.writeFileSync(x.answerFile,pending);x.answer();
    const options=x.options();
    for(const attestOperatorAnswer of [undefined,()=>({observed:false}),()=>({observed:true,challenge_sha256:'f'.repeat(64),reference:'wrong'})])
      assert.throws(()=>activity.createOwnerReconciliation({...options,codeRootAppendApproval:{...options.codeRootAppendApproval,attestOperatorAnswer}}),/root-append-live-answer-required/);
    assert.throws(()=>activity.createOwnerReconciliation({...options,codeRootAppendApproval:{...options.codeRootAppendApproval,rootId:'beta'}}),/root-append/);
    assert.throws(()=>activity.createOwnerReconciliation({...options,codeRootAppendApproval:{...options.codeRootAppendApproval,originalBytes:Buffer.from('foreign')}}),/root-append/);
    const events=fs.readFileSync(x.file);
    const invalid=Buffer.from(x.appended);invalid[invalid.indexOf(Buffer.from('platform-unsupported'))]=0x80;
    fs.writeFileSync(x.file,Buffer.concat([x.prefix,invalid]));
    assert.throws(()=>activity.createOwnerReconciliation({...options,codeRootAppendApproval:{...options.codeRootAppendApproval,appendedBytes:invalid}}),/root-append-events-invalid/,'invalid UTF-8 is not silently replaced');fs.writeFileSync(x.file,events);
    fs.appendFileSync(x.file,'{"seventh":true}\n');
    assert.throws(()=>activity.createOwnerReconciliation(options),/root-append-bytes-invalid/);fs.writeFileSync(x.file,events);
    const other=path.join(x.f.a,'.gsd/unapproved.md');put(other,'foreign');
    assert.throws(()=>activity.createOwnerReconciliation(options),/root-append-protected-delta-invalid/);fs.unlinkSync(other);
    assert.throws(()=>activity.createOwnerReconciliation({...options,attestStoppedWriter:()=>false}),/authority-required/);
    const cap=activity.createOwnerReconciliation(options),snapshot=x.h.parent.recovery_baseline.protected_roots.find(row=>row.root_id==='alpha').snapshot;
    activity.withOwnerReconciliationRead(cap,x.h.request,()=>execution.assertProtected(x.f.a,snapshot));
    assert.throws(()=>activity.withOwnerReconciliationRead({},x.h.request,()=>{}),/capability-required/);
    const original=fs.readFileSync(x.originFile);fs.appendFileSync(x.originFile,' ');
    assert.throws(()=>activity.withOwnerReconciliationRead(cap,x.h.request,()=>{}),/root-append-answer-changed/);fs.writeFileSync(x.originFile,original);
    fs.appendFileSync(x.file,'{"later":true}\n');
    assert.throws(()=>activity.withOwnerReconciliationRead(cap,x.h.request,()=>{}),/root-append-root-changed/);fs.writeFileSync(x.file,events);
    const source=path.join(x.f.a,'same.txt'),sourceBytes=fs.readFileSync(source);fs.appendFileSync(source,'foreign');
    assert.throws(()=>activity.withOwnerReconciliationRead(cap,x.h.request,()=>{}),/root-changed/);fs.writeFileSync(source,sourceBytes);
    const held=runs.get(x.f.owner,'M001').write_claim;runs.update(x.f.owner,'M001',{write_claim:{...held,generation:'foreign'}});
    assert.throws(()=>activity.withOwnerReconciliationRead(cap,x.h.request,()=>{}),/authority-changed/);runs.update(x.f.owner,'M001',{write_claim:held});
    assert.throws(()=>activity.reconciliationDecision(x.h.request,options.operatorDecision,{validatedRootAppend:{carriers:[{relative:'.gsd/anything'}]}}),/root-append-capability-required/);
    assert(fs.readFileSync(x.file).equals(events));
    console.log('PASS root append: explicit live consent, exact bytes and all retained-root/CAS negatives');
  });
  await fixture(async x=>{
    const history=oldHistory(x),current=freshHistoryApproval(x,history);
    const cap=activity.createOwnerReconciliation(current);
    const repaired=require('./forge-sidecar-verification-repair').create(support.repairOptions(x.h,{ownerReconciliation:cap}));
    const bound=successor.bindOwnerReconciliation(repaired,x.h.request,cap);assert.equal(bound,repaired,'same genuine successor');
    assert.throws(()=>successor.bindOwnerReconciliation(repaired,x.h.request,{}),/reconciliation-mismatch/);
    const view=successor.read(bound,x.h.request);view.check();
    const retained=fs.readFileSync(x.file);fs.appendFileSync(x.file,'{"racing":true}\n');
    assert.throws(()=>view.check(),/root-append-root-changed/);fs.writeFileSync(x.file,retained);
    const xllm=require('./forge-xllm'),original=xllm.runExecute;let calls=0;
    xllm.runExecute=async()=>{calls++;throw Error('unexpected provider');};
    try{
      const result=await require('./forge-unit-sidecar').runUnitSidecar(x.h.request,{verificationSuccessor:bound,ownerReconciliation:cap});
      assert.equal(result.status,'done');assert.equal(calls,0);assert(fs.readFileSync(x.file).equals(retained));
      assert.equal(JSON.parse(fs.readFileSync(view.receiptFile)).verification_successor.provider_called,false);
      for(const[file,bytes]of history.pins)assert(fs.readFileSync(file).equals(bytes),'publication preserves both positive and negative historical answers and origins');
      assert(fs.readFileSync(x.h.parentFile).equals(x.h.parentBytes));assert(fs.readFileSync(x.h.parent.recovery_baseline.state_file).equals(x.h.stateBytes));
      console.log('PASS issue455 fresh current approval publishes retained result with exact historical positive/negative pairs as data, zero providers and original receipt/S0/event bytes');
      assert.throws(()=>view.check(),/capability-required/,'consumed reconciliation cannot be reused');
    }finally{xllm.runExecute=original;}
    console.log('PASS root append: same opaque approval reaches outside-context successor and actual zero-provider publication');
  });
  await historicalCarrierNegatives();
}
module.exports={main};if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
