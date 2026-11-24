'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const rewrite=require('./forge-command-rewrite'),verify=require('./forge-verify');
let failed=0,passed=0;function test(name,fn){try{fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+' '+e.stack);}}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'forge-resource-scope-'));
const owner=path.join(root,'owner'),code=path.join(root,'code');fs.mkdirSync(path.join(owner,'.gsd'),{recursive:true});fs.mkdirSync(code);
fs.writeFileSync(path.join(owner,'.gsd','forge-prefs.jsonc'),JSON.stringify({resources:{enforcement:'off'}}));
fs.writeFileSync(path.join(code,'package.json'),JSON.stringify({name:'forge-real-vitest-command',version:'1.0.0',scripts:{test:'vitest run'}}));
fs.writeFileSync(path.join(code,'package-lock.json'),'{}');
const budget={workers:2,heapMb:512,playwrightWorkers:1,admit:true,enforcement:'clamp'};
test('spawn env rewrite keeps compound command bytes and all argv insertions',()=>{
 const command='npm test && jest --runInBand',p=rewrite.planRewrite(command,budget,{cwd:code,envMode:'spawn'});
 assert.equal(p.command,'npm test && jest --runInBand --maxWorkers=2');assert.deepEqual(p.env,{VITEST_MAX_FORKS:'2',VITEST_MAX_THREADS:'2',NODE_OPTIONS:'--max-old-space-size=512'});
 assert.ok(!p.insertions.some(i=>i.text.startsWith('VITEST_')));
});
test('default POSIX representation and explicit human concurrency preserved',()=>{
 assert.match(rewrite.planRewrite('npm test',budget,{cwd:code}).command,/^VITEST_MAX_FORKS=/);
 assert.equal(rewrite.planRewrite('vitest --maxWorkers=7',budget,{cwd:code,envMode:'spawn'}).outcome,'intact');
});
test('owner prefs supplied independently of command CODE_DIR',()=>{
 let observed,released=0;const events=[];
 const result=verify.runVerificationGate({cwd:code,gsdDir:path.join(owner,'.gsd'),taskPlanVerify:'npm test',resourceEventSink:e=>events.push(JSON.parse(e)),
 requireResources:()=>({acquireCommandBudget:opts=>{observed=opts;return {...budget,enforcement:opts.prefsResult?.prefs?.resources?.enforcement};},releaseCommandBudget:()=>released++})});
 assert.equal(observed.cwd,code);assert.equal(observed.prefsResult?.prefs?.resources?.enforcement,'off');assert.ok(events.some(e=>e.reason==='intact:enforcement-off'));
 assert.ok(!events.some(e=>e.kind==='resource-clamp-applied'));assert.equal(released,0);assert.equal(result.checks.length,1);
});
if(process.platform==='win32')test('real Windows npm Vitest child receives env and joined lease release',()=>{
 const bin=path.join(code,'node_modules','.bin');fs.mkdirSync(bin,{recursive:true});
 const checker=path.join(code,'check.cjs');fs.writeFileSync(checker,"if(process.env.VITEST_MAX_FORKS!=='2'||process.env.VITEST_MAX_THREADS!=='2')process.exit(41); console.log('REAL-WINDOWS-ENV-PASS');");
 fs.writeFileSync(path.join(bin,'vitest.cmd'),'@"'+process.execPath+'" "'+checker+'" %*\r\n');
 let released=0;const result=verify.runVerificationGate({cwd:code,taskPlanVerify:'npm test',commandTimeoutMs:30000,
 requireResources:()=>({acquireCommandBudget:()=>({...budget,pool:{handle:{slots:[0]}}}),releaseCommandBudget:()=>released++})});
 assert.equal(result.checks[0].exitCode,0,JSON.stringify(result.checks[0]));assert.match(result.checks[0].stdout,/REAL-WINDOWS-ENV-PASS/);assert.equal(released,1);
});
// All children are synchronously joined by runVerificationGate before fixture cleanup.
fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({passed,failed}));if(failed)process.exitCode=1;
