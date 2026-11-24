'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
const lab=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'forge-artifact-routing-'))),saved={...process.env};
const put=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
try{
 Object.assign(process.env,{HOME:path.join(lab,'home'),USERPROFILE:path.join(lab,'home'),FORGE_HOME:path.join(lab,'core')});fs.mkdirSync(process.env.HOME);
 const {resolveDispatch}=require('./forge-dispatch-resolve'),transport=require('./forge-transport-capabilities'),guard=require('./forge-dispatch-guard'),prefs=require('./forge-prefs');
 const cwd=path.join(lab,'project');fs.mkdirSync(cwd);const prefsFile=path.join(cwd,'.gsd/forge-prefs.jsonc');
 const configured={tier_models:{light:['gpt-5.6-luna','claude-sonnet-5-5'],standard:['gpt-5.6-sol','claude-sonnet-5-5'],heavy:['gpt-5.6-sol','claude-opus-5-5'],max:['gpt-5.6-sol','claude-opus-5-5']},effort:Object.fromEntries(transport.ARTIFACT_UNITS.map(unit=>[unit,'medium']))};put(prefsFile,configured);
 const original=fs.readFileSync(prefsFile),before=[];
 for(const unitType of transport.ARTIFACT_UNITS){
  const route=resolveDispatch({unitType,cwd,hostRuntime:'claude'});before.push({unitType,route});
  assert.equal(route.dispatch_allowed,false,unitType+' must refuse before a guaranteed unsupported transport');
  assert.equal(route.dispatch_reason_code,transport.READONLY_CONTEXT_REASON);assert.equal(route.resolved_worker_engine,'codex');assert.equal(route.model,route.chain[0].id);
  assert(route.dispatch_hint.includes('routing.default.'+unitType));assert(route.dispatch_hint.includes('nenhum')||route.dispatch_hint.includes('No worker'));
  const admission=transport.readOnlyArtifactAdmission({engine:route.resolved_worker_engine,workerMode:route.worker_mode,mode:'artifacts',unitType});assert.equal(admission.admitted,false);
  assert.throws(()=>transport.assertReadOnlyArtifactContext({engine:'codex',workerMode:'sidecar',mode:'artifacts',unitType}),error=>error.code===route.dispatch_reason_code&&error.provider_called===false);
  const native=resolveDispatch({unitType,cwd,hostRuntime:'codex'});assert.equal(native.dispatch_allowed,true,JSON.stringify(native));assert.equal(native.worker_mode,'native');
  const explicit=resolveDispatch({unitType,cwd,hostRuntime:'claude',workerMode:'sidecar',workerEngine:'codex',sidecarDeclared:true});assert.equal(explicit.dispatch_reason_code,transport.READONLY_CONTEXT_REASON);
 }
 const cli=cp.spawnSync(process.execPath,[path.join(__dirname,'forge-dispatch-resolve.js'),'--unit-type','research-milestone','--host-runtime','claude','--cwd',cwd,'--json'],{encoding:'utf8',windowsHide:true});
 assert.equal(JSON.parse(cli.stdout).dispatch_allowed,false);assert.equal(JSON.parse(cli.stdout).dispatch_reason_code,transport.READONLY_CONTEXT_REASON);
 assert(fs.readFileSync(prefsFile).equals(original),'all inspections are read-only and preserve model choices');
 const report=require('./forge-doctor').checkArtifactRouting(cwd,{runtime:'claude'});assert.equal(report.ok,true,'doctor warning remains advisory');assert.equal(report.incompatible.length,transport.ARTIFACT_UNITS.length);
 assert.equal(require('./forge-doctor').checkArtifactRouting(cwd,{runtime:'codex'}).verdict,'compatible','Codex native is not rejected by a static GPT preference warning');
 assert.equal(require('./forge-doctor').checkArtifactRouting(cwd,{}).verdict,'inconclusive','a missing host is not guessed');
 const stdout=cp.spawnSync(process.execPath,[path.join(__dirname,'forge-doctor.js'),'--check','artifact-routing','--runtime','claude','--cwd',cwd,'--json'],{encoding:'utf8',windowsHide:true});assert.equal(stdout.status,0,stdout.stderr);assert(JSON.parse(stdout.stdout).results[0].incompatible.length);
 const identity=require('./forge-sidecar-identity').formatHumanIdentity('recusado',{phase:'research-milestone',unit:'research-milestone/M001',reason_code:transport.READONLY_CONTEXT_REASON,provider_called:false});assert(identity.includes('causa '+transport.READONLY_CONTEXT_REASON));assert(!identity.includes('causa adapter-failed'));
 assert(require('./forge-sidecar-identity').formatHumanIdentity('recusado',{reason_code:'unsupported-sidecar-unit',provider_called:false}).includes('causa unsupported-sidecar-unit'));
 const protectedRoutes=['execute-task','plan-slice'].map(unitType=>resolveDispatch({unitType,cwd,hostRuntime:'claude'}));
 const loop=require('./forge-long-workflow-adapter'),administrative=[];
 for(const mode of ['auto','step']){
  const owner=path.join(lab,mode);fs.mkdirSync(path.join(owner,'.gsd/milestones/M001'),{recursive:true});put(path.join(owner,'.gsd/forge-prefs.jsonc'),configured);
  require('./forge-state').write(owner,{milestone:'M001',phase:'idle',active_slice:'S01',active_task:'—',auto_mode:'off'});
  const input={cwd:owner,milestone:'M001',workflow_id:'routing-'+mode,owner_token:'fixture-owner',prefsReader:()=>({ok:true,prefs:{workflow:{skip_discuss:true}}}),inventory:{roadmap_exists:true,context_exists:true,research_exists:false,slices:[],milestone_complete:false}};
  const selected=loop.invoke('claude',mode,'next',input).result;
  assert.equal(selected.unit.type,'research-milestone');
  assert.equal(resolveDispatch({cwd:owner,unitType:selected.unit.type,hostRuntime:'claude'}).dispatch_allowed,false);
  administrative.push({mode,owner,input,selected});
 }
 configured.routing={default:Object.fromEntries(transport.ARTIFACT_UNITS.map(unit=>[unit,Object.fromEntries(['light','standard','heavy','max'].map(tier=>[tier,['claude-sonnet-5-5']]))]))};put(prefsFile,configured);
 for(const row of administrative){
  put(path.join(row.owner,'.gsd/forge-prefs.jsonc'),configured);
  const resumed=loop.invoke('claude',row.mode,'next',row.input,row.selected.snapshot).result;
  assert.deepEqual(resumed.unit,row.selected.unit,'routing correction preserves the same auto/step unit');
  const route=resolveDispatch({cwd:row.owner,unitType:resumed.unit.type,hostRuntime:'claude'});assert.equal(route.dispatch_allowed,true);assert.equal(route.model,'claude-sonnet-5-5');
  assert(!fs.existsSync(path.join(row.owner,'invocations.txt')),'selection/resolution never fabricates a provider invocation');
 }
 assert.equal(prefs.readPrefsCached(cwd).ok,true);
 const schema=JSON.parse(fs.readFileSync(path.join(__dirname,'../forge-prefs.schema.json')));
 assert.deepEqual(schema.$defs.artifactRoutingPhase.enum,transport.ARTIFACT_UNITS,'schema phase vocabulary stays bound to canonical transport inventory');
 assert(!prefs.validatePrefs(prefs.readPrefsCached(cwd).prefs,schema).some(row=>row.key?.startsWith('routing.default.')),'exact artifact phase cells are recognized');
 for(const unitType of transport.ARTIFACT_UNITS){const route=resolveDispatch({unitType,cwd,hostRuntime:'claude'});assert.equal(route.model,'claude-sonnet-5-5');assert.equal(route.dispatch_allowed,true,JSON.stringify(route));assert.equal(route.route_source,'routing');}
 configured.routing.backend={'research-milestone':{standard:['gpt-5.6-sol']}};put(prefsFile,configured);
 const backend=resolveDispatch({unitType:'research-milestone',cwd,domain:'backend',hostRuntime:'claude'});assert.equal(backend.dispatch_allowed,false);assert(backend.dispatch_hint.includes('Célula efetiva: routing.backend.research-milestone.standard'));
 for(let i=0;i<protectedRoutes.length;i++){const next=resolveDispatch({unitType:['execute-task','plan-slice'][i],cwd,hostRuntime:'claude'});assert.equal(next.model,protectedRoutes[i].model);assert.equal(next.effort,protectedRoutes[i].effort);assert.deepEqual(next.chain,protectedRoutes[i].chain);}
 configured.routing.default['unknown-phase']={standard:['claude-sonnet-5-5']};put(prefsFile,configured);assert(prefs.validatePrefs(prefs.readPrefsCached(cwd).prefs,schema).some(row=>row.key==='routing.default.unknown-phase'));
 const markdown=path.join(lab,'markdown');fs.mkdirSync(path.join(markdown,'.gsd'),{recursive:true});
 const legacyPath=require('./forge-home').resolvePreferencePaths(markdown).local.mdFiles[0];
 put(legacyPath,'routing:\n  default:\n    research-milestone:\n      standard: [claude-sonnet-5-5]\n');
 const markdownRoute=resolveDispatch({unitType:'research-milestone',cwd:markdown,hostRuntime:'claude'});assert.equal(markdownRoute.prefs_ok,false,'legacy catalogs still require canonical migration');assert.notEqual(markdownRoute.model,'claude-sonnet-5-5','catalog text cannot select a route');
 const safe=guard.evaluateDispatchGuard({host_runtime:'claude',worker_engine:'codex',worker_mode:'sidecar',unit_type:'discuss-milestone',scope:'standalone-task',phase:'discuss'});assert.equal(safe.dispatch_allowed,true);
 const denied=guard.evaluateDispatchGuard({host_runtime:'claude',worker_engine:'codex',worker_mode:'sidecar',unit_type:'research-milestone',scope:'standalone-task',phase:'research'});assert.equal(denied.reason_code,transport.READONLY_CONTEXT_REASON);
 for(const [phase,contract]of Object.entries(require('./forge-task-preparation').PHASE_CONTRACTS)){
  const row=guard.evaluateDispatchGuard({host_runtime:'claude',worker_engine:'codex',worker_mode:'sidecar',unit_type:contract.unitType,scope:'standalone-task',phase});
  assert.equal(row.dispatch_allowed,phase!=='research',phase+' retains its exact standalone profile');
 }
 put(prefsFile,'{ PRIVATE-PREF-BYTES');const unknown=require('./forge-doctor').checkArtifactRouting(cwd,{runtime:'claude'});assert.equal(unknown.verdict,'inconclusive');assert.equal(unknown.unresolved.length,transport.ARTIFACT_UNITS.length);assert(!JSON.stringify(unknown).includes('PRIVATE-PREF-BYTES'));
 console.log('PASS resolver/entrypoint parity all artifact profiles, both hosts and explicit mode; real cause/doctor warning and explicit phase routing without rewriting executor/planner');
}finally{process.env=saved;assert.equal(path.dirname(lab),fs.realpathSync.native(os.tmpdir()));fs.rmSync(lab,{recursive:true,force:true});}
