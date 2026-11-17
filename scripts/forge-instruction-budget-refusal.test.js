'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict');
const instructions=require('./forge-instructions'),installer=require('./forge-installer');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-budget-refusal-')),selector=process.argv[2];
try {
 if(!selector||selector==='api') {
  const file=path.join(root,'api.md'),before='Operator byte Ω\r\n'.repeat(2200);fs.writeFileSync(file,before);
  for(const maxBytes of ['invalid','65536',0,-1,NaN,Infinity,null,{},2.5]) {
   assert.throws(()=>instructions.syncFile(file,{maxBytes}),e=>e.code==='instruction-budget-invalid');
   assert.equal(fs.readFileSync(file,'utf8'),before,'invalid budget wrote operator file');
   assert.throws(()=>instructions.syncInstructions(root,{maxBytes}),e=>e.code==='instruction-budget-invalid');
  }
  console.log('PASS API invalid budgets refuse before writes');
 }
 if(!selector||selector==='batch') {
  const project=path.join(root,'sync');fs.mkdirSync(project);const first=path.join(project,'CLAUDE.md'),second=path.join(project,'AGENTS.md');
  const small='operator-small\r\n',large='operator-large Ω\r\n'.repeat(2200);fs.writeFileSync(first,small);fs.writeFileSync(second,large);
  const report=instructions.syncInstructions(project,{host:'both'});assert(report.files.some(f=>f.instructionBudgetExceeded));assert.equal(report.changed,0);
  assert.equal(fs.readFileSync(first,'utf8'),small,'batch changed first before second budget refusal');assert.equal(fs.readFileSync(second,'utf8'),large);
  console.log('PASS batch preflight leaves both instruction files unchanged');
 }
 if(!selector||selector==='install') {
  for(const dryRun of [false,true]) {
   const base=path.join(root,'install-'+dryRun),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot,{recursive:true});
   const first=path.join(projectRoot,'CLAUDE.md'),second=path.join(projectRoot,'AGENTS.md'),small='operator-first\r\n',large='operator-second Ω\r\n'.repeat(2200);fs.writeFileSync(first,small);fs.writeFileSync(second,large);
   assert.throws(()=>installer.install({repo:path.resolve(__dirname,'..'),runtime:'both',forgeHome:path.join(base,'forge'),codexHome:path.join(base,'codex'),claudeHome:path.join(base,'claude'),userHome:base,projectRoot,dryRun,skipCapabilityCheck:true,codexQuestionBinary:'fixture-codex',questionSpawnSync:()=>({status:0,stdout:''}),provenance:null}),e=>e.code==='instruction-budget-exceeded');
   assert.equal(fs.readFileSync(first,'utf8'),small,'installer changed first before second budget refusal');assert.equal(fs.readFileSync(second,'utf8'),large);
  }
  console.log('PASS both-host installer preflight and dry-run leave both files unchanged');
 }
} finally {fs.rmSync(root,{recursive:true,force:true});}
