'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const installer=require('./forge-installer');const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-instruction-install-budget-'));
function options(name){const base=path.join(root,name),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot,{recursive:true});return {repo:path.resolve(__dirname,'..'),runtime:'codex',forgeHome:path.join(base,'forge'),codexHome:path.join(base,'codex'),claudeHome:path.join(base,'claude'),userHome:base,projectRoot,skipCapabilityCheck:true,codexQuestionBinary:'fixture-codex',questionSpawnSync:()=>({status:0,stdout:''}),provenance:null};}
try{
 const normal=options('normal'),file=path.join(normal.projectRoot,'AGENTS.md'),prefix='Operator rule Ω\n'.repeat(800),writes=[],original=fs.writeFileSync;
 fs.writeFileSync(file,prefix);fs.writeFileSync=function(p,data,...args){if(path.resolve(String(p))===file)writes.push(Buffer.byteLength(data));return original.call(this,p,data,...args);};
 try{installer.install(normal);}finally{fs.writeFileSync=original;}
 const after=fs.readFileSync(file,'utf8');assert.ok(after.startsWith(prefix));assert.ok(after.includes('--context interaction'));assert.ok(writes.every(n=>n<=32768),'installer transiently expanded the instruction file');
 for(const dryRun of [false,true]){const large=options(dryRun?'dry':'large'),target=path.join(large.projectRoot,'AGENTS.md'),before='Operator bytes remain untouched\n'.repeat(1200);fs.writeFileSync(target,before);assert.throws(()=>installer.install({...large,dryRun}),e=>e.code==='instruction-budget-exceeded');assert.equal(fs.readFileSync(target,'utf8'),before,'size refusal wrote instruction bytes');}
 console.log('PASS installer instruction budget: compact-only writes, operator bytes, named refusal and dry-run');
}finally{fs.rmSync(root,{recursive:true,force:true});}
