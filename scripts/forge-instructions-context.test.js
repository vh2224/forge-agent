'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),cp=require('child_process');
const instructions=require('./forge-instructions'),interaction=require('./forge-interaction');
let passed=0;const test=(name,fn)=>{fn();passed++;process.stdout.write('PASS '+name+'\n');};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'forge-entry-context-'));
try {
 test('all five contexts preserve the exact complete existing contract content',()=>{
  const expected={routing:instructions.CONTRACT_LINES.join('\n'),personal:instructions.renderPersonalContract(),entry:instructions.renderEntryContract(),communication:instructions.renderCommunicationContract(),interaction:interaction.contract()};
  for(const[name,body]of Object.entries(expected)){const c=instructions.readContext(name);assert.equal(c.content,body.replace(/\r\n/g,'\n').trimEnd());assert.equal(c.bytes,Buffer.byteLength(c.content));assert.match(c.sha256,/^[a-f0-9]{64}$/);}
 });
 test('old detailed render and worker projection remain complete',()=>{
  const full=instructions.renderBlock();for(const name of ['personal','entry','communication'])assert.ok(full.includes(instructions.readContext(name).content));
  assert.ok(interaction.project('worker body').includes(interaction.contract()));assert.ok(interaction.sync('operator body').content.includes(interaction.contract()));
 });
 test('the former 32KiB overflow becomes compact with every operator byte retained',()=>{
  const prefix='User-specific rule Ω\r\n'.repeat(450),old=prefix+instructions.renderBlock({eol:'crlf'})+'\r\n'+interaction.renderBlock('\r\n')+'\r\n';
  assert.ok(Buffer.byteLength(old)>32768);const file=path.join(temp,'AGENTS.md');fs.writeFileSync(file,old);
  const r=instructions.syncFile(file,{host:'codex'});assert.equal(r.outcome,'updated');const next=fs.readFileSync(file,'utf8');assert.ok(next.startsWith(prefix));assert.ok(Buffer.byteLength(next)<32768);assert.ok(next.includes('--context interaction'));assert.ok(!next.includes(interaction.contract()));
  assert.equal(instructions.syncFile(file,{host:'codex'}).outcome,'unchanged');assert.equal(fs.readFileSync(file,'utf8'),next);
 });
 test('both managed entry blocks fit an 8KiB budget with complete loading triggers',()=>{
  const text=instructions.renderEntryBlock()+'\n'+interaction.renderEntryBlock();assert.ok(Buffer.byteLength(text)<=8192);
  for(const token of ['personal','communication','entry','routing','interaction','--phase boot','claims','CODE_DIR','receipt','content'])assert.ok(text.includes(token),token);
  assert.ok(!text.includes('worker-engine-fallback'));assert.ok(instructions.readContext('routing').content.includes('worker-engine-fallback'));
 });
 test('a still oversized operator file is refused without a byte being written',()=>{
  const file=path.join(temp,'large.md'),before='operator-only-rule\n'.repeat(2200);fs.writeFileSync(file,before);
  const r=instructions.syncFile(file);assert.equal(r.outcome,'skipped');assert.equal(r.reason,'instruction-budget-exceeded');assert.equal(r.instructionBudgetExceeded,true);assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.equal(instructions.syncFile(file,{maxBytes:65536}).outcome,'updated');assert.ok(fs.readFileSync(file,'utf8').startsWith(before));
 });
 test('CLI contexts are read-only, named and reject an unknown context',()=>{
  const cli=path.join(__dirname,'forge-instructions.js');const r=cp.spawnSync(process.execPath,[cli,'--context','interaction','--json'],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0);assert.deepEqual(JSON.parse(r.stdout),instructions.readContext('interaction'));
  const bad=cp.spawnSync(process.execPath,[cli,'--context','missing'],{encoding:'utf8',windowsHide:true});assert.equal(bad.status,2);assert.ok(!bad.stdout);assert.throws(()=>instructions.readContext('missing'),/instruction-context-invalid/);
 });
 test('full and compact interaction modes retain fence-aware malformed refusal',()=>{
  const malformed=interaction.START+'\nunterminated';assert.equal(interaction.sync(malformed,{compact:true}).malformed,'interaction-malformed-markers');
  const code='```md\n'+interaction.START+'\n'+interaction.END+'\n```\n';const result=interaction.sync(code,{compact:true}).content;assert.ok(result.startsWith(code));assert.equal(interaction.sync(result,{compact:true}).content,result);
 });
 process.stdout.write(JSON.stringify({passed,failed:0})+'\n');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
