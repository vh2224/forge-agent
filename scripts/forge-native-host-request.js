'use strict';
// TEMP candidate: canonical read-side owner factory. No CLI, selection or writer.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const contexts=new WeakMap(),requests=new WeakMap(),MAX_INPUT=2*1024*1024;
const INPUT_KEYS=['schema_version','owner','run_id','milestone_id','slice_id','task_id','begin_key','expected_begin_sha256','workflow_id','dispatch_id','verification_bindings'];
function fail(code){throw Object.assign(new Error(code),{code,stage:'native-host-request'});}
function hash(value){return crypto.createHash('sha256').update(value).digest('hex');}
function plain(value){return value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype&&Reflect.ownKeys(value).every(k=>typeof k==='string')&&Object.values(Object.getOwnPropertyDescriptors(value)).every(d=>Object.hasOwn(d,'value')&&d.enumerable);}
function closed(value,keys,code){if(!plain(value)||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))fail(code);}
function stable(value){if(Array.isArray(value))return value.map(stable);
if(plain(value))return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
return value;}
function digest(value){return hash(JSON.stringify(stable(value)));}
function normalizeDeclarations(rows){
if(rows===null)return null;
if(!Array.isArray(rows)||rows.length>require('./forge-delivery').MAX_BINDINGS)fail('native-host-verification-declarations-schema');
const result=rows.map(row=>{if(!plain(row)||Object.keys(row).some(k=>!['root_id','criterion','criterion_id','aspect','coverage','source','required_coverages'].includes(k))||typeof row.root_id!=='string'||!row.root_id||!['behavioral','structural','documentary'].includes(row.coverage)||!plain(row.source))fail('native-host-verification-declarations-schema');
if(Object.hasOwn(row,'criterion')===Object.hasOwn(row,'criterion_id'))fail('native-host-verification-declarations-schema');
if(Object.hasOwn(row,'criterion')){const c=row.criterion;if(!plain(c)||!['truth','artifact','key_link','additional'].includes(c.kind)||Object.keys(c).some(k=>!['kind','index','id'].includes(k))||Object.hasOwn(c,'index')===Object.hasOwn(c,'id'))fail('native-host-verification-declarations-schema');const id=c.index??c.id;if(!(Number.isSafeInteger(id)&&id>=0||typeof id==='string'&&id.length>0))fail('native-host-verification-declarations-schema');}
else if(typeof row.criterion_id!=='string'||!row.criterion_id)fail('native-host-verification-declarations-schema');
if(Object.hasOwn(row,'aspect')&&(typeof row.aspect!=='string'||!row.aspect))fail('native-host-verification-declarations-schema');
if(row.source.kind==='verification'){closed(row.source,['kind','check_index'],'native-host-verification-declarations-schema');if(!Number.isSafeInteger(row.source.check_index)||row.source.check_index<0)fail('native-host-verification-declarations-schema');}
else if(row.source.kind==='artifact'){closed(row.source,['kind','row_index','property'],'native-host-verification-declarations-schema');if(!Number.isSafeInteger(row.source.row_index)||row.source.row_index<0||!['exists','substantive','wired','documentary'].includes(row.source.property))fail('native-host-verification-declarations-schema');}
else fail('native-host-verification-declarations-schema');
if(row.required_coverages!==undefined){if(!Array.isArray(row.required_coverages)||!row.required_coverages.length||row.required_coverages.length>64)fail('native-host-verification-declarations-schema');for(const item of row.required_coverages){closed(item,['aspect','coverage','root_id'],'native-host-verification-declarations-schema');if(typeof item.aspect!=='string'||!item.aspect.trim()||typeof item.root_id!=='string'||!item.root_id.trim()||!['behavioral','documentary'].includes(item.coverage))fail('native-host-verification-declarations-schema');}if(new Set(row.required_coverages.map(item=>JSON.stringify([item.aspect,item.root_id,item.coverage]))).size!==row.required_coverages.length)fail('native-host-verification-declarations-schema');}
return structuredClone(row);});
if(Buffer.byteLength(JSON.stringify(result))>MAX_INPUT)fail('native-host-verification-declarations-bound');return result;}
function normalizeOwnerInput(value){
if(!plain(value)||Object.keys(value).some(k=>!INPUT_KEYS.includes(k))||INPUT_KEYS.filter(k=>!['workflow_id','dispatch_id','verification_bindings'].includes(k)).some(k=>!Object.hasOwn(value,k)))fail('native-host-owner-input-schema');
value={workflow_id:null,dispatch_id:null,verification_bindings:null,...value};
value.verification_bindings=normalizeDeclarations(value.verification_bindings);
if(value.schema_version!==1)fail('native-host-owner-input-schema');
for(const k of INPUT_KEYS.filter(k=>!['schema_version','owner','expected_begin_sha256','workflow_id','verification_bindings'].includes(k)))if(!(value[k]===null&&['workflow_id','dispatch_id'].includes(k))&&(typeof value[k]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value[k])))fail('native-host-owner-input-id');
if(value.workflow_id!==null&&(typeof value.workflow_id!=='string'||!value.workflow_id.trim()||value.workflow_id.includes('\u0000')||Buffer.byteLength(value.workflow_id)>MAX_INPUT))fail('native-host-workflow-selector');
if(typeof value.owner!=='string'||!path.isAbsolute(value.owner)||Buffer.byteLength(value.owner)>4096||/[\x00-\x1f]/.test(value.owner))fail('native-host-owner-input-path');
if(!/^[a-f0-9]{64}$/.test(value.expected_begin_sha256||''))fail('native-host-begin-checksum');
if(value.run_id!==value.milestone_id||!/^S\d+$/.test(value.slice_id)||!/^T\d+(?:\.\d+)?$/.test(value.task_id))fail('native-host-scope-unsupported');
if(Buffer.byteLength(JSON.stringify(value))>MAX_INPUT)fail('native-host-owner-input-bound');
return structuredClone({...value,owner:path.resolve(value.owner)});}
function physical(file,directory=false){const abs=path.resolve(file),parts=abs.slice(path.parse(abs).root.length).split(path.sep).filter(Boolean);
let at=path.parse(abs).root;
for(let i=0;i<parts.length;i++){at=path.join(at,parts[i]);
const s=fs.lstatSync(at);
if(s.isSymbolicLink()||i<parts.length-1&&!s.isDirectory())fail('native-host-path-identity');
if(i===parts.length-1&&(directory?!s.isDirectory():!s.isFile()||s.nlink!==1))fail('native-host-path-type');}const key=s=>process.platform==='win32'?s.toLowerCase():s;
if(key(fs.realpathSync.native(abs))!==key(abs))fail('native-host-path-alias');
return abs;}
function read(file,optional=false){try{physical(file);}catch(error){if(optional&&error.code==='ENOENT'){const parent=path.dirname(file);physical(parent,true);try{fs.lstatSync(file);}catch(last){if(last.code==='ENOENT')return null;
throw last;}fail('native-host-input-changed');}throw error;}const value=require('./forge-autonomy-sources').readBoundedStableFile(file,MAX_INPUT,{expectedReal:path.resolve(file)});
if(value.error||value.stat.nlink!==1)fail('native-host-input-unstable');
return Buffer.from(value.buffer);}
function parseSecuritySpec(text){if(typeof text!=='string'||Buffer.byteLength(text)>MAX_INPUT)fail('native-host-security-spec');
const section=text.split('## Security Gate')[1];
if(!section)fail('native-host-security-spec');
const prefix=section.split('**Exception list')[0],fence=String.fromCharCode(96).repeat(3),blocks=[...prefix.matchAll(new RegExp(fence+'[^\\n]*\\n([\\s\\S]*?)\\n'+fence,'g'))].map(m=>m[1].trim()),flags=[...prefix.matchAll(/flags:\s*\x60(gi|g)\x60/g)].map(m=>m[1]);
if(blocks.length!==3||flags.join(',')!=='gi,g,g')fail('native-host-security-spec-shape');
const exceptionPart=section.split('**Exception list')[1],match=exceptionPart&&new RegExp(fence+'[^\\n]*\\n([\\s\\S]*?)\\n'+fence).exec(exceptionPart);
if(!match)fail('native-host-security-spec-shape');
const exceptions=match[1].split(/\r?\n/).map(l=>l.split('#')[0].trim()).filter(Boolean);
if(exceptions.length!==4)fail('native-host-security-spec-shape');try{return{patterns:blocks.map((source,i)=>new RegExp(source,flags[i])),exceptions:exceptions.map(source=>new RegExp(source,'gi'))};}catch{fail('native-host-security-spec-regex');}}
function scanSecurityPlan(plan,spec){if(typeof plan!=='string'||Buffer.byteLength(plan)>MAX_INPUT)fail('native-host-plan-bound');
const parsed=parseSecuritySpec(spec),ranges=[];
for(const pattern of parsed.exceptions)for(const hit of plan.matchAll(pattern))ranges.push([hit.index,hit.index+hit[0].length]);
let hits=0,suppressed=0;
for(const pattern of parsed.patterns)for(const hit of plan.matchAll(pattern)){hits++;
if(ranges.some(([a,b])=>hit.index>=a&&hit.index+hit[0].length<=b))suppressed++;}return{required:hits>suppressed,hits,suppressed,plan_sha256:hash(plan),spec_sha256:hash(spec)};}
function deps(){return{ids:require('./forge-ids'),runs:require('./forge-runs'),controller:require('./forge-unit-controller'),lease:require('./forge-unit-lease'),roots:require('./forge-code-roots'),claims:require('./forge-write-claim'),gate:require('./forge-claim-gate'),execution:require('./forge-task-execution'),orchestrate:require('./forge-orchestrate'),questions:require('./forge-pending-questions'),dispatch:require('./forge-dispatch-resolve')};}
function pendingSources(a,owner,input,workflow,unit){
const questionSources=[];
for(const filter of [{type:'milestone',id:input.milestone_id},{type:'workflow',id:workflow},{type:'unit',id:unit}]){
let packet;try{packet=a.questions.listPendingQuestions({cwd:owner,filter});}catch(error){if(filter.type==='workflow'&&error.code==='pending-question-scope-required')fail('native-host-workflow-question-scope-unsupported');throw error;}
if(packet.census?.invalid||packet.census?.excess||['questions-unreadable','owner-missing'].includes(packet.empty_reason))fail('native-host-question-census');
questionSources.push({filter,questions:packet.questions});}
const planning=a.questions.readPlanningQuestions({cwd:owner,milestone:input.milestone_id,slice:input.slice_id});
if(!Array.isArray(planning.records))fail('native-host-planning-question-census');
return{questionSources,planning};}
function assertNoPending(sources){if(sources.questionSources.some(s=>s.questions.some(q=>q.status==='pending'))||sources.planning.records.some(q=>q.status!=='resolved'))fail('native-host-pending-questions');}
function canonicalWorkflow(begin,input){
if(!Object.hasOwn(begin,'workflow_binding'))fail('native-host-workflow-binding-unavailable');
const b=begin.workflow_binding,expected={schema_version:1,workflow_id:b?.workflow_id,mode:b?.mode,begin_key:begin.idempotency_key,unit_key:begin.unit.key,milestone:begin.milestone,slice:begin.after.state.active_slice==='\u2014'?null:begin.after.state.active_slice||null,host_runtime:begin.host_runtime,owner_digest:begin.owner_digest,lease_generation:begin.lease_generation};
if(!plain(b)||digest(b)!==digest(expected)||!['auto','task','step'].includes(b.mode)||typeof b.workflow_id!=='string'||!b.workflow_id.trim()||b.workflow_id.includes('\u0000')||begin.event.workflow_binding_sha256!==digest(b))fail('native-host-workflow-binding-invalid');
if(input.workflow_id!==null&&input.workflow_id!==b.workflow_id)fail('native-host-selector-mismatch');return b.workflow_id;}
function resolvedPolicy(owner){
const prefs=require('./forge-prefs').readPrefs(owner);if(prefs.ok!==true)fail('native-host-preferences-invalid');
const schemaFile=path.resolve(__dirname,'../forge-prefs.schema.json'),schemaBytes=read(schemaFile),schema=JSON.parse(schemaBytes.toString('utf8'));
function value(name,child){const rule=child?schema.properties[name]?.properties?.[child]:schema.properties[name];const v=child?prefs.prefs[name]?.[child]:prefs.prefs[name];if(!rule)fail('native-host-preference-schema');return v===undefined?structuredClone(rule.default):v;}
const budgets=Object.fromEntries(['auto_memory','ledger_snapshot','coding_standards'].map(k=>[k,value('token_budget',k)]));
if(Object.values(budgets).some(v=>!Number.isSafeInteger(v)||v<0||v>16000))fail('native-host-budget-invalid');
const verification={preferenceCommands:value('verification','preference_commands'),commandTimeoutMs:value('verification','command_timeout_ms')};
if(!Array.isArray(verification.preferenceCommands)||verification.preferenceCommands.some(v=>typeof v!=='string')||!Number.isSafeInteger(verification.commandTimeoutMs)||verification.commandTimeoutMs<=0)fail('native-host-verification-policy');
const autoCommit=value('auto_commit');if(typeof autoCommit!=='boolean')fail('native-host-constraints-unavailable');
const planGateInteractive=value('plan_gate','interactive');if(!['always','auto','off'].includes(planGateInteractive))fail('native-host-plan-gate-policy');
return{budgets,verification,planGateInteractive,constraints:{auto_commit:autoCommit,deploy:false},schema_sha256:hash(schemaBytes),prefs};}
function contextSources(owner,input,transition){
const milestone=path.join(owner,'.gsd/milestones',input.milestone_id),slice=path.join(milestone,'slices',input.slice_id);
const files=[{label:'Slice plan',file:path.join(slice,input.slice_id+'-PLAN.md'),required:true},{label:'Milestone context',file:path.join(milestone,input.milestone_id+'-CONTEXT.md')},{label:'Slice context',file:path.join(slice,input.slice_id+'-CONTEXT.md')}];
const rows=[];let total=0;
for(const item of files){let bytes=read(item.file,!item.required);const admitted=transition?.get(item.file);
if(admitted){const current=bytes?hash(bytes):null;if(current!==admitted.after_sha256&&(!admitted.pending||current!==admitted.before_sha256))fail('native-host-publication-context-readback');bytes=admitted.before_bytes;}
if(bytes){total+=bytes.length;if(total>MAX_INPUT)fail('native-host-context-bound');const raw=Buffer.alloc(bytes.length);bytes.copy(raw);rows.push({...item,sha256:hash(bytes),text:bytes.toString('utf8'),raw});}}
return rows;}
function currentRenderIsolation(contract){
const primary=contract.code_roots.find(root=>root.id===contract.primary_root_id);
if(!primary||primary.vcs!=='git')fail('native-host-render-isolation-unsupported');
const isolation=require('./forge-isolation');if(typeof isolation.gitCurrentBranch!=='function')fail('native-host-render-branch-producer-unavailable');
const branch=isolation.gitCurrentBranch(primary.path);
if(typeof branch!=='string'||!branch||!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch))fail('native-host-render-branch-required');
// This is the observed PRIMARY checkout branch. A multi-root coordination run's
// legacy branch field is not evidence of this physical checkout's branch.
return{mode:'worktree',primary_root_id:primary.id,code_dir:primary.path,branch};
}
function inspect(input,transition){const a=deps(),owner=physical(input.owner,true);
if(!a.ids.isValid(input.milestone_id)||a.ids.entityKind(input.milestone_id)!=='milestone')fail('native-host-milestone-required');
const run=a.runs.get(owner,input.run_id),actor=run&&a.runs.observeHostSession('claude',run.session_id);
if(!run||run.active!==true||run.host_runtime!=='claude'||!actor||actor.sessionId!==run.session_id)fail('native-host-actor-required');
const claim=a.claims.readClaim(run);a.claims.validateHeldClaim(claim);
if(claim.schema_version!==2||!claim.generation||claim.released||run.batch_locator)fail('native-host-held-claim-required');
const contract=a.roots.validateContract(claim.execution_contract,{owner,revalidate:true}),renderIsolation=currentRenderIsolation(contract),unit='execute-task/'+input.task_id,begin=a.controller.lookupRecord(owner,'transaction',input.begin_key);
if(!begin||begin.action!=='begin'||begin.phase!=='committed'||begin.unit?.key!==unit||begin.milestone!==input.milestone_id||begin.after?.state?.active_slice!==input.slice_id||begin.host_runtime!=='claude'||a.controller.recordChecksum(begin)!==input.expected_begin_sha256)fail('native-host-begin-binding');
if(begin.batch||begin.linked_entry||begin.resumed_pause)fail('native-host-begin-mode-unsupported');
const workflow=canonicalWorkflow(begin,input),questions=pendingSources(a,owner,input,workflow,unit);assertNoPending(questions);
const held=a.lease.readLease(a.lease.leaseFile(owner,unit)),lease=held.record;
if(held.corrupt||!a.lease.validRecord(lease,unit)||lease.generation!==begin.lease_generation||lease.request_id!==input.begin_key||lease.host_runtime!=='claude'||a.lease.observe(owner,unit).reason!=='lease-active')fail('native-host-lease-required');
const decision={unit:begin.unit,details:{transaction:{idempotency_key:input.begin_key,begin_checksum:input.expected_begin_sha256}}},orchestration={cwd:owner,milestone:input.milestone_id,host_runtime:'claude',owner_token:lease.owner_token};
const inspectAttempt=probe=>{if(probe.cwd!==owner||probe.begin.idempotency_key!==input.begin_key||a.controller.recordChecksum(probe.begin)!==input.expected_begin_sha256)fail('native-host-inspector-binding');const fresh=pendingSources(a,owner,input,workflow,unit);return{pending_questions:fresh.questionSources.flatMap(s=>s.questions)};};
const pending=a.orchestrate.validatePending(orchestration,decision,{inspectAttempt});
if(pending.ok!==true)fail('native-host-pending-'+String(pending.reason||'refused').replace(/[^a-z0-9-]/gi,''));
const locator={contextRoot:owner,cwd:contract.code_roots.find(r=>r.id===contract.primary_root_id).path,milestoneId:input.milestone_id,sliceId:input.slice_id,taskId:input.task_id},planFile=a.execution.milestonePlanFile(locator),planBytes=read(planFile),plan=planBytes.toString('utf8'),checked=a.roots.validatePlan(plan,contract);
if(!a.claims.ordinaryRetainedProjection(run,contract)||!checked.writes.length||checked.writes.some(p=>!claim.paths.some(c=>a.roots.covers(c,p)))&&!a.claims.coversRetainedExecution(run,contract,checked.writes))fail('native-host-claim-coverage');
const policy=resolvedPolicy(owner);
const gateFile=planFile.replace(/-PLAN\.md$/,'-PLAN-GATE.md'),gateBytes=read(gateFile,true),gateText=gateBytes?gateBytes.toString('utf8'):'';
let planDecision={plan:'approved'};
if(!/^status:\s*approved\s*$/m.test(gateText)){
if(policy.planGateInteractive==='off')planDecision={plan:'skipped',planSkipReason:'interactive-off'};
else if(begin.workflow_binding.mode==='auto')fail('native-host-auto-plan-gate-producer-unavailable');
else if(policy.planGateInteractive==='auto')fail('native-host-plan-gate-decision-unavailable');
else fail('native-host-plan-gate-required');}
const approvedHash=gateText.match(/^plan_sha256:\s*([a-f0-9]{64})\s*$/m)?.[1];
if(approvedHash&&approvedHash!==hash(planBytes))fail('execution-plan-gate-stale');
const gate=a.gate.previewGate({cwd:owner,runId:input.run_id,claim,enforcement:'enforcing'});
if(gate.enforcement!=='enforcing'||gate.decision!=='proceed')fail('native-host-claim-gate-refused');
const specFile=path.resolve(__dirname,'../shared/forge-dispatch.md'),specBytes=read(specFile),security=scanSecurityPlan(plan,specBytes.toString('utf8')),securityFile=planFile.replace(/-PLAN\.md$/,'-SECURITY.md'),securityBytes=read(securityFile,true);
if(security.required&&(!securityBytes||!securityBytes.toString('utf8').trim()))fail('execution-security-required');
if(securityBytes&&(!/^# Security Checklist (?:\u2014|-)(?: |$)/m.test(securityBytes.toString('utf8'))||!(/^- \[ \]|^- \[x\]/mi.test(securityBytes.toString('utf8'))||/No security-sensitive scope detected.*No checklist required\./.test(securityBytes.toString('utf8')))))fail('native-host-security-checklist-unready');
const route=a.dispatch.resolveDispatch({cwd:owner,unitType:'execute-task',unitId:input.task_id,milestoneId:input.milestone_id,planPath:planFile,roadmapPath:path.join(owner,'.gsd/milestones',input.milestone_id,input.milestone_id+'-ROADMAP.md'),hostRuntime:'claude',workerMode:'native'},process.env);
if(route.dispatch_allowed!==true||route.host_runtime!=='claude'||route.worker_mode!=='native'||route.resolved_worker_engine!=='claude'||!(route.model_resolved||route.model)||!route.effort)fail('native-host-route-required');
const context=contextSources(owner,input,transition);
const facts={owner,actor,workflow_id:workflow,run_id:run.id,unit,milestone_id:input.milestone_id,slice_id:input.slice_id,task_id:input.task_id,begin_key:input.begin_key,begin_checksum:input.expected_begin_sha256,lease_generation:lease.generation,claim_generation:claim.generation,claim_sha256:a.roots.digest(claim),execution_contract:contract,render_isolation:renderIsolation,writes:checked.writes,plan_file:planFile,input_hashes:{plan:hash(planBytes),plan_gate:gateBytes?hash(gateBytes):null,security_spec:hash(specBytes),security:securityBytes?hash(securityBytes):null},gates:{...planDecision,claim:'proceed',security:securityBytes&&securityBytes.toString('utf8').trim()?'passed':'not-applicable'},security_reason:security,questions_sha256:digest(questions),verification_bindings_sha256:digest(input.verification_bindings),policy_sha256:digest(policy),context_sources:context.map(({text,raw,...r})=>r),route};
return{facts,stamp:digest(facts),claim,run,policy,context};}
function buildOwnerContext(value){const input=normalizeOwnerInput(value),initial=inspect(input),handle=Object.freeze({});
const ownerSnapshot=require('./forge-task-execution').protectedSnapshot(initial.facts.owner);
if(inspect(input).stamp!==initial.stamp)fail('native-host-owner-authority-changed');
contexts.set(handle,{input,initial,ownerSnapshot,publicationWitness:null,publicationAttemptWitness:null,publicationIdentity:null,publicationRuntime:null});
return handle;}
function publicationIdentity(proof){return require('./forge-code-roots').digest({dispatch_id:proof.dispatch_id,request_sha256:proof.request_sha256,result_sha256:proof.result_sha256,manifest:proof.manifest,receipt:proof.receipt,artifacts:proof.artifacts});}
function publicationLease(row,pending){
const activity=require('./forge-protected-owner-activity'),roots=require('./forge-code-roots'),owner=row.initial.facts.owner;
let runtime=row.publicationRuntime;
if(!runtime){
 // First capture is only during the ORIGINAL synchronous ready callback. The
 // private Activity store is the producer; no option/JSON supplies a runtime.
 if(!pending||typeof activity.currentScope!=='function')fail('native-host-original-ready-scope-required');
 const current=activity.currentScope();
 if(!current||current.kind!=='native-execution'||roots.key(current.owner)!==roots.key(owner)
     ||current.unit!==row.initial.facts.unit||current.generation!==row.initial.facts.lease_generation
     ||typeof current.projectPublicationLease!=='function'||!Object.isFrozen(current))fail('native-host-original-ready-scope-required');
 runtime=current;
}
const snapshot=runtime.projectPublicationLease(owner,row.ownerSnapshot);
const leaseFile=require('./forge-unit-lease').leaseFile(owner,row.initial.facts.unit),relative=path.relative(owner,leaseFile).split(path.sep).join('/');
if(!plain(snapshot)||!Object.hasOwn(row.ownerSnapshot,relative)||!(/^[a-f0-9]{64}$/.test(snapshot[relative]||'')))fail('native-host-publication-lease-projection');
const otherBytes={...snapshot,[relative]:row.ownerSnapshot[relative]};
if(roots.digest(Object.entries(otherBytes).sort())!==roots.digest(Object.entries(row.ownerSnapshot).sort()))fail('native-host-publication-lease-projection');
return{runtime,snapshot};}
function publicationTransition(row,witness,pending=false){
const requestRow=requests.get(row.request);if(!requestRow)fail('native-host-publication-request-required');
const native=require('./forge-native-execution'),method=pending?'assertOriginalPublicationAttemptWitness':'assertOriginalPublicationWitness';
if(typeof native[method]!=='function')fail('native-host-publication-producer-unavailable');
const proof=native[method](witness,{request:requestRow.request});
if(!proof||proof.dispatch_id!==requestRow.request.dispatchId||proof.request_sha256!==require('./forge-code-roots').digest(requestRow.request)||!Array.isArray(proof.artifacts))fail('native-host-publication-binding');
const lease=publicationLease(row,pending);
const transition=new Map(),seen=new Set(),currentSnapshot=require('./forge-task-execution').protectedSnapshot(row.initial.facts.owner),expectedSnapshot={...lease.snapshot};
for(const artifact of proof.artifacts){
if(!artifact||typeof artifact.path!=='string'||!artifact.path.startsWith('.gsd/')||artifact.path.includes('\\')||path.posix.normalize(artifact.path)!==artifact.path||seen.has(artifact.path)||!(/^[a-f0-9]{64}$/.test(artifact.after_sha256||''))||!(artifact.before===null||/^[a-f0-9]{64}$/.test(artifact.before)))fail('native-host-publication-artifact');
seen.add(artifact.path);const file=path.resolve(row.initial.facts.owner,artifact.path),rel=path.relative(row.initial.facts.owner,file);
if(rel===''||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||(row.ownerSnapshot[artifact.path]??null)!==artifact.before)fail('native-host-publication-preimage');
let bytes;try{bytes=read(file);}catch(error){if(error.code!=='ENOENT')throw error;bytes=null;}
const current=bytes?hash(bytes):null;
if(current!==artifact.after_sha256&&(!pending||current!==artifact.before))fail('native-host-publication-readback');
if((currentSnapshot[artifact.path]??null)!==current)fail('native-host-publication-owner-unstable');
if(current===null)delete expectedSnapshot[artifact.path];else expectedSnapshot[artifact.path]=current;
let directory=path.posix.dirname(artifact.path);
while(directory!=='.'){
 if(row.ownerSnapshot[directory+'/']!==undefined&&row.ownerSnapshot[directory+'/']!=='directory')fail('native-host-publication-directory');
 if(currentSnapshot[directory+'/']!==undefined){if(currentSnapshot[directory+'/']!=='directory')fail('native-host-publication-directory');expectedSnapshot[directory+'/']='directory';}
 directory=path.posix.dirname(directory);
}
const original=row.initial.context.find(source=>source.file===file);
if(original){if(original.sha256!==artifact.before||hash(original.raw)!==original.sha256)fail('native-host-publication-context-preimage');transition.set(file,{pending,before_sha256:artifact.before,after_sha256:artifact.after_sha256,before_bytes:original.raw});}
}
const roots=require('./forge-code-roots');
if(roots.digest(Object.entries(currentSnapshot).sort())!==roots.digest(Object.entries(expectedSnapshot).sort()))fail('native-host-publication-owner-changed');
return{transition,identity:publicationIdentity(proof),runtime:lease.runtime};}
function assertOwnerContext(handle,options={}){const row=contexts.get(handle);
if(!row)fail('native-host-owner-context-required');
if(!plain(options)||Object.keys(options).some(key=>!['publicationWitness','publicationAttemptWitness'].includes(key))||options.publicationWitness!==undefined&&options.publicationAttemptWitness!==undefined)fail('native-host-owner-context-options');
const complete=options.publicationWitness===undefined?row.publicationWitness:options.publicationWitness;
const pending=options.publicationAttemptWitness===undefined?row.publicationAttemptWitness:options.publicationAttemptWitness;
if(row.publicationWitness&&complete!==row.publicationWitness||row.publicationAttemptWitness&&pending!==row.publicationAttemptWitness)fail('native-host-publication-witness-conflict');
if(row.publicationWitness&&options.publicationAttemptWitness!==undefined)fail('native-host-publication-downgrade');
const admitted=complete?publicationTransition(row,complete):pending?publicationTransition(row,pending,true):null;
if(admitted&&row.publicationIdentity&&admitted.identity!==row.publicationIdentity)fail('native-host-publication-upgrade-conflict');
const current=inspect(row.input,admitted?.transition);
if(current.stamp!==row.initial.stamp)fail('native-host-owner-authority-changed');
if(admitted){row.publicationRuntime=admitted.runtime;row.publicationIdentity=admitted.identity;if(complete)row.publicationWitness=complete;else row.publicationAttemptWitness=pending;}
return current.facts;}
function describeOwnerContext(handle){return structuredClone(assertOwnerContext(handle));}
function ownerAdapters(handle){assertOwnerContext(handle);
return Object.freeze({assertAuthority(){assertOwnerContext(handle);},assertBoundary(){assertOwnerContext(handle);}});}
function channelState(channel,context){const bridge=require('./forge-native-host-bridge');
if(typeof bridge.assertOwnedChannel!=='function')fail('native-host-owned-channel-producer-unavailable');
const row=bridge.assertOwnedChannel(channel,context);
if(!row||!row.admission||typeof row.admission.assertCurrent!=='function'||typeof row.admission.writeImmutable!=='function')fail('native-host-spool-admission-unavailable');row.admission.assertCurrent();return row;}
function buildExecutionRequest(context,channel){
const facts=assertOwnerContext(context),owner=contexts.get(context),live=inspect(owner.input);
if(!owner.input.verification_bindings?.length)fail('native-host-verification-bindings-required');
const owned=channelState(channel,context);
if(owner.input.dispatch_id!==null&&owner.input.dispatch_id!==owned.dispatch_id)fail('native-host-selector-mismatch');
if(owner.request){const previous=requests.get(owner.request);if(previous.channel!==channel)fail('native-host-attempt-reconciliation-required');assertExecutionRequest(owner.request);return owner.request;}
if(typeof owned.dispatch_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(owned.dispatch_id))fail('native-host-dispatch-producer');
for(const file of [owned.result_file,owned.context_file]){if(typeof file!=='string'||!path.isAbsolute(file))fail('native-host-owned-channel-required');for(const root of [facts.owner,...facts.execution_contract.code_roots.map(r=>r.path)]){const relative=path.relative(root,file);if(relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))fail('native-host-channel-inside-root');}}
const contextText=live.context.map(row=>'## '+row.label+'\n'+row.text).join('\n\n');
if(Buffer.byteLength(contextText)>MAX_INPUT)fail('native-host-context-bound');
owned.admission.writeImmutable('context',owned.context_file,Buffer.from(contextText));
const promptApi=require('./forge-prompt'),rendered=promptApi.renderPrompt({cwd:facts.owner,codeDir:facts.render_isolation.code_dir,unitType:'execute-task',milestoneId:facts.milestone_id,sliceId:facts.slice_id,taskId:facts.task_id,autoCommit:live.policy.constraints.auto_commit,unitEffort:facts.route.effort,isolationMode:facts.render_isolation.mode,branch:facts.render_isolation.branch,memoryMaxTokens:live.policy.budgets.auto_memory,ledgerMaxTokens:live.policy.budgets.ledger_snapshot,standardsMaxTokens:live.policy.budgets.coding_standards});
if(Buffer.byteLength(rendered.prompt)>MAX_INPUT)fail('native-host-request-bound');
const renderSources=[{file:rendered.template_source,sha256:rendered.template_sha256}];
if(rendered.procedure_context){const pc=rendered.procedure_context;renderSources.push({file:path.join(pc.root,'shared/forge-procedures.json'),sha256:pc.manifest_sha256});for(const module of pc.modules)renderSources.push({file:path.join(pc.root,module.path),sha256:module.sha256});}
for(const source of renderSources)if(hash(read(source.file))!==source.sha256)fail('native-host-render-source-changed');
const r={phase:'execute',scope:'milestone',unitType:'execute-task',cwd:facts.execution_contract.code_roots.find(v=>v.id===facts.execution_contract.primary_root_id).path,contextRoot:facts.owner,milestoneId:facts.milestone_id,sliceId:facts.slice_id,taskId:facts.task_id,runId:facts.run_id,workflowId:facts.workflow_id,dispatchId:owned.dispatch_id,planFile:facts.plan_file,contextFile:owned.context_file,resultFile:owned.result_file,route:structuredClone(facts.route),claim:structuredClone(live.claim),execution_contract:structuredClone(facts.execution_contract),gates:structuredClone(facts.gates),constraints:structuredClone(live.policy.constraints),verification:{...structuredClone(live.policy.verification),bindings:structuredClone(owner.input.verification_bindings)},budgets:structuredClone(live.policy.budgets),prompt:rendered.prompt,procedure_context:rendered.procedure_context};
if(facts.input_hashes.security!==null)r.securityFile=facts.plan_file.replace(/-PLAN\.md$/,'-SECURITY.md');
const research=path.join(facts.owner,'.gsd/milestones',facts.milestone_id,'slices',facts.slice_id,facts.slice_id+'-RESEARCH.md');if(read(research,true))r.researchFile=research;
require('./forge-native-recovery-delivery').requireExplicitVerify(read(r.planFile).toString('utf8'),r);
const seal=require('./forge-verify').normalizeExecutionVerification(r.execution_contract,read(r.planFile).toString('utf8'),r.verification,{},{});
require('./forge-delivery').validateExecutionBindings(read(r.planFile).toString('utf8'),r.execution_contract,{type:'task',id:r.taskId,milestone:r.milestoneId,slice:r.sliceId},r.verification.bindings,seal);
require('./forge-unit-sidecar').locations(r);
if(Buffer.byteLength(JSON.stringify(r))>MAX_INPUT)fail('native-host-request-bound');
const handle=Object.freeze({});requests.set(handle,{context,channel,request:structuredClone(r),sha256:digest(r),context_sha256:hash(contextText),rendered_sha256:rendered.final_prompt_sha256,renderSources});owner.request=handle;assertExecutionRequest(handle);return handle;}
function assertExecutionRequest(handle,expected={}){const row=requests.get(handle);if(!row)fail('native-host-request-handle-required');
if(expected.context&&expected.context!==row.context||expected.channel&&expected.channel!==row.channel)fail('native-host-request-handle-foreign');assertOwnerContext(row.context,expected.publicationWitness!==undefined?{publicationWitness:expected.publicationWitness}:expected.publicationAttemptWitness!==undefined?{publicationAttemptWitness:expected.publicationAttemptWitness}:{});
const owned=channelState(row.channel,row.context);if(owned.result_file!==row.request.resultFile||owned.context_file!==row.request.contextFile||owned.dispatch_id!==row.request.dispatchId||hash(read(owned.context_file))!==row.context_sha256)fail('native-host-request-source-changed');
for(const source of row.renderSources)if(hash(read(source.file))!==source.sha256)fail('native-host-render-source-changed');
if(digest(row.request)!==row.sha256)fail('native-host-request-changed');return structuredClone(row.request);}
function readExecutionRequest(handle){return assertExecutionRequest(handle);}
function validateExecutionRequest(handle,nativeInvocation){const r=assertExecutionRequest(handle);
if(!nativeInvocation||nativeInvocation.ok!==true)fail('native-host-preflight-required');
const check=require('./forge-unit-sidecar').validateRecoveryRequest(r,{nativeInvocation});if(check.supported!==true)fail('native-host-request-preflight-refused');return r;}
module.exports={normalizeOwnerInput,scanSecurityPlan,buildOwnerContext,assertOwnerContext,describeOwnerContext,ownerAdapters,buildExecutionRequest,assertExecutionRequest,readExecutionRequest,validateExecutionRequest};
