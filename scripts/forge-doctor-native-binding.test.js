#!/usr/bin/env node
'use strict';
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),cp=require('child_process');
const doctor=require('./forge-doctor'),repo=path.resolve(__dirname,'..');
const lab=fs.mkdtempSync(path.join(os.tmpdir(),'forge-doctor-binding-'));
const prior={HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,FORGE_HOME:process.env.FORGE_HOME};
process.env.HOME=lab;process.env.USERPROFILE=lab;process.env.FORGE_HOME=path.join(lab,'home');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');let passed=0,seq=0;
const tree=root=>fs.readdirSync(root,{withFileTypes:true}).flatMap(item=>item.isDirectory()?tree(path.join(root,item.name)).map(row=>item.name+'/'+row):[item.name+':'+hash(fs.readFileSync(path.join(root,item.name)))]).sort();
function fixture({unit='plan-milestone',effort='medium',frontmatter,highRisk=false,model='claude-opus-5-5'}={}){
 const cwd=path.join(lab,'case-'+(++seq));fs.mkdirSync(path.join(cwd,'.gsd'),{recursive:true});
 const prefs={tier_models:Object.fromEntries(['light','standard','heavy','max'].map(key=>[key,model])),effort:{[unit]:effort}};
 fs.writeFileSync(path.join(cwd,'.gsd/forge-prefs.jsonc'),JSON.stringify(prefs));
 const options={unitType:unit,hostRuntime:'claude',workerMode:'native',agentPath:path.join(repo,'agents',unit==='execute-task'?'forge-executor.md':'forge-planner.md')};
 if(unit==='execute-task'){
  options.planPath=path.join(cwd,'T01-PLAN.md');fs.writeFileSync(options.planPath,'---\ntier: standard\n'+(frontmatter?'effort: '+frontmatter+'\n':'')+'---\n# Diagnostic-only plan\n');
 }
 if(unit==='plan-slice'){
  options.unitId='S01';options.roadmapPath=path.join(cwd,'M001-ROADMAP.md');fs.writeFileSync(options.roadmapPath,'# Roadmap\n- S01 risk: '+(highRisk?'high':'low')+'\n');
 }
 return{cwd,options};
}
function test(name,fn){fn();passed++;console.log('PASS '+name);}
function inspect(f,extra={}){const before=tree(f.cwd);const out=doctor.checkNativeBinding(f.cwd,{...f.options,...extra});assert.deepStrictEqual(tree(f.cwd),before,'diagnostic writes no context/lease/controller data');assert.equal(out.native_tool_availability,'unknown');assert.equal(out.provider_called,false);assert.equal(out.effect,'read-only-binding-diagnosis');assert(!JSON.stringify(out).includes(f.cwd));return out;}
function cli(f,extras=[]){
 const args=[path.join(__dirname,'forge-doctor.js'),'--diagnose-native-binding',f.options.unitType,'--runtime',f.options.hostRuntime,'--worker-mode',f.options.workerMode,'--cwd',f.cwd,'--agent',f.options.agentPath,'--json'];
 for(const[key,flag]of [['unitId','--unit-id'],['planPath','--plan'],['roadmapPath','--roadmap']])if(f.options[key])args.push(flag,f.options[key]);
 return cp.spawnSync(process.execPath,[...args,...extras],{encoding:'utf8',windowsHide:true,timeout:30000,env:{...process.env}});
}
try{
 for(const [name,spec,wanted,reason]of [
  ['milestone preference xhigh',{unit:'plan-milestone',effort:'xhigh'},'xhigh','prefs.effort:plan-milestone'],
  ['slice high-risk escalation',{unit:'plan-slice',effort:'medium',highRisk:true},'max','risk-escalation:high'],
  ['execution preference high',{unit:'execute-task',effort:'high'},'high','prefs.effort:execute-task'],
  ['execution frontmatter high',{unit:'execute-task',effort:'medium',frontmatter:'high'},'high','frontmatter-effort:high'],
 ])test('doctor detects '+name+' without changing model effort native or files',()=>{
  const f=fixture(spec),out=inspect(f);assert.equal(out.status,'incompatible');assert.equal(out.reason_code,'native-effort-binding-mismatch');assert.equal(out.runtime_authorized,true);assert.equal(out.worker_mode,'native');assert.equal(out.model_resolved,'claude-opus-5-5');assert.equal(out.effort_resolved,wanted);assert.equal(out.effort_reason,reason);assert.equal(out.effort_observed,'medium');assert.match(out.source_sha256,/^(?:sha256:)?[a-f0-9]{64}$/);
 });
 test('matching binding is only binding compatibility and never active-tool availability',()=>{
  const f=fixture(),out=inspect(f,{activeCapabilities:{available:true,tool:'invented'}});assert.equal(out.ok,true);assert.equal(out.status,'compatible-binding');assert.equal(out.effort_resolved,'medium');assert.equal(out.effort_observed,'medium');
 });
 test('stale source fingerprint is refused without exposing a path',()=>{
  const f=fixture(),out=inspect(f,{agentSha256:'0'.repeat(64)});assert.equal(out.ok,false);assert.equal(out.reason_code,'native-effort-binding-fingerprint-mismatch');assert.equal(out.source_sha256,null);
 });
 test('missing or wrong agent evidence remains unknown',()=>{
  const f=fixture();assert.equal(inspect(f,{agentPath:undefined}).reason_code,'native-effort-binding-evidence-missing');assert.equal(inspect(f,{agentPath:path.join(repo,'agents/forge-executor.md')}).reason_code,'native-effort-binding-agent-mismatch');
 });
 test('unrecognized or private frontmatter effort is not reflected',()=>{
  const f=fixture(),file=path.join(f.cwd,'private-agent.md');fs.writeFileSync(file,'---\nname: forge-planner\neffort: credential=synthetic-only\n---\n');const out=inspect(f,{agentPath:file});assert.equal(out.ok,false);assert.equal(out.effort_observed,null);assert(!JSON.stringify(out).includes('credential'));
 });
 test('non-Claude route is not rewritten or represented as Claude binding compatibility',()=>{
  const f=fixture({model:'gpt-6-sol'}),out=inspect(f,{hostRuntime:'codex'});assert.equal(out.ok,true);assert.equal(out.status,'not-applicable');assert.equal(out.worker_mode,'native');assert.equal(out.model_resolved,'gpt-6-sol');assert.equal(out.effort_observed,null);
 });
 test('explicit sidecar is preserved including any authoritative runtime refusal',()=>{
  const f=fixture(),out=inspect(f,{workerMode:'sidecar',sidecarDeclared:true});assert.equal(out.worker_mode,'sidecar');assert.equal(out.model_resolved,'claude-opus-5-5');assert.equal(out.effort_resolved,'medium');assert.equal(out.effort_observed,null);if(out.runtime_authorized)assert.equal(out.status,'not-applicable');else{assert.equal(out.ok,false);assert.equal(out.status,'unknown');}
 });
 test('public doctor CLI returns actionable mismatch and preserves read-only scope',()=>{
  const f=fixture({effort:'xhigh'}),before=tree(f.cwd),run=cli(f);assert.equal(run.status,1,run.stderr);assert.equal(JSON.parse(run.stdout).reason_code,'native-effort-binding-mismatch');assert.deepStrictEqual(tree(f.cwd),before);
 });
 test('public doctor CLI matching control and stale-fingerprint negative retain availability unknown',()=>{
  const f=fixture(),ok=cli(f);assert.equal(ok.status,0,ok.stderr);assert.equal(JSON.parse(ok.stdout).native_tool_availability,'unknown');const bad=cli(f,['--agent-sha256','0'.repeat(64)]);assert.equal(bad.status,1,bad.stderr);assert.equal(JSON.parse(bad.stdout).reason_code,'native-effort-binding-fingerprint-mismatch');
 });
 test('public doctor CLI refuses conflicting mutations or invented-capability inputs',()=>{
  const f=fixture();for(const extra of [['--fix'],['--check','all'],['--active-capabilities','invented'],['--runtime','claude']]){const run=cli(f,extra);assert.equal(run.status,2,run.stderr);assert.equal(run.stdout,'');}
 });
 test('library requires explicit host and one of the diagnosed unit identities',()=>{
  const f=fixture();assert.equal(inspect(f,{hostRuntime:undefined}).reason_code,'native-binding-input-invalid');const bad=inspect(f,{unitType:'__proto__'});assert.equal(bad.unit_type,null);assert.equal(bad.agent_type,null);
 });
 console.log('\n'+passed+' passed, 0 failed');
}finally{
 for(const[key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 const parent=fs.realpathSync.native(os.tmpdir()),actual=fs.realpathSync.native(lab);assert(actual.startsWith(parent+path.sep));fs.rmSync(actual,{recursive:true,force:true});
}
