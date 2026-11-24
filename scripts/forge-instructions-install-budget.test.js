'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const installer=require('./forge-installer');const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-instruction-install-budget-'));
function options(name){const base=path.join(root,name),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot,{recursive:true});return {repo:path.resolve(__dirname,'..'),runtime:'codex',forgeHome:path.join(base,'forge'),codexHome:path.join(base,'codex'),claudeHome:path.join(base,'claude'),userHome:base,projectRoot,skipCapabilityCheck:true,codexQuestionBinary:'fixture-codex',questionSpawnSync:()=>({status:0,stdout:''}),provenance:null};}
try{
 const normal=options('normal'),file=path.join(normal.projectRoot,'AGENTS.md'),prefix='Operator rule Ω\n'.repeat(800),writes=[],original=fs.writeFileSync;
 fs.writeFileSync(file,prefix);fs.writeFileSync=function(p,data,...args){if(path.resolve(String(p))===file)writes.push(Buffer.byteLength(data));return original.call(this,p,data,...args);};
 try{installer.install(normal);}finally{fs.writeFileSync=original;}
 const after=fs.readFileSync(file,'utf8');assert.ok(after.startsWith(prefix));assert.ok(after.includes('--context interaction'));assert.ok(writes.every(n=>n<=32768),'installer transiently expanded the instruction file');
 // Scoped maintenance may preserve development files and avoid optional panel activation.
 // Exercise the actual installer, with identical unchanged development bytes so normal
 // retirement would remove them, while managed core/procedures still get installed.
 const panel=require('./forge-vscode-install'),applyPanel=panel.applyPanel;
 for(const mode of ['deferred','default','opt-in','opt-out']){
  const deferred=mode==='deferred',explicit=mode==='opt-in'||mode==='opt-out';
  const scoped=options(mode),development=path.join(scoped.forgeHome,'scripts','forge-smoke.js'),prefs=path.join(scoped.forgeHome,'forge-agent-prefs.jsonc');
  fs.mkdirSync(path.dirname(development),{recursive:true});fs.copyFileSync(path.join(scoped.repo,'scripts','forge-smoke.js'),development);
  const devBytes=fs.readFileSync(development),prefsBytes='{}\n';fs.writeFileSync(prefs,prefsBytes);
  let panelCalls=0;panel.applyPanel=function(...args){panelCalls++;return applyPanel.apply(this,args);};
  let report;try{report=installer.install({...scoped,update:true,...(deferred?{deferDevelopmentRetirement:true,deferVscodePanel:true}:{}),...(explicit?{deferVscodePanel:true,vscodePanel:mode}:{})});}finally{panel.applyPanel=applyPanel;}
  assert.equal(report.ok,true);assert.equal(panelCalls,deferred?0:1);
  assert.equal(fs.existsSync(development),deferred);
  if(deferred)assert.deepEqual(fs.readFileSync(development),devBytes);
  assert.equal(report.plan.some(p=>p.reason==='development-retirement-deferred'),deferred);
  assert.equal(report.plan.some(p=>p.reason==='vscode-panel-activation-deferred'),deferred);
  assert.equal(fs.readFileSync(prefs,'utf8'),prefsBytes);
  assert.deepEqual(fs.readFileSync(path.join(scoped.forgeHome,'scripts','forge-instructions.js')),fs.readFileSync(path.join(scoped.repo,'scripts','forge-instructions.js')));
  assert.deepEqual(fs.readFileSync(path.join(scoped.forgeHome,'shared','forge-procedure-core.md')),fs.readFileSync(path.join(scoped.repo,'shared','forge-procedure-core.md')));
  assert.ok(fs.readFileSync(path.join(scoped.projectRoot,'AGENTS.md'),'utf8').includes('--context interaction'));
 }
 for(const dryRun of [false,true]){const large=options(dryRun?'dry':'large'),target=path.join(large.projectRoot,'AGENTS.md'),before='Operator bytes remain untouched\n'.repeat(1200);fs.writeFileSync(target,before);assert.throws(()=>installer.install({...large,dryRun}),e=>e.code==='instruction-budget-exceeded');assert.equal(fs.readFileSync(target,'utf8'),before,'size refusal wrote instruction bytes');}
 console.log('PASS installer instruction budget: compact-only writes, operator bytes, named refusal and dry-run');
}finally{fs.rmSync(root,{recursive:true,force:true});}
