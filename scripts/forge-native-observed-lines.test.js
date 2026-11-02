'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const native=require('./forge-native-recovery-delivery'),verify=require('./forge-verify'),side=require('./forge-unit-sidecar');
const {fixture}=require('./forge-native-recovery-delivery.test'),{capabilities}=require('./forge-recovery-transition.test');
async function main(){
  assert(native.isObservedTestLine({stdout:'PASS legacy\n'},'PASS legacy'));
  assert(native.isObservedTestLine({stdout:'x'.repeat(3000)+'\n'},'x'.repeat(3000)),'legacy in-view lines retain their old limits');
  assert(!native.isObservedTestLine({stdout:'',observed_stdout_lines:['PASS forged']},'PASS forged'));
  assert(!native.isObservedTestLine({stdout:'…[truncated]',stdout_truncated:true,observed_stdout_lines:['1..5']},'1..5'),'a newly retained generic TAP summary is not a named assertion');
  assert(!native.isObservedTestLine({stdout:'',stdout_truncated:true,observed_stdout_lines:Array(65).fill('PASS forged')},'PASS forged'));
  const f=await fixture();
  try{
    const handoff=await side.recoverUnitSidecar(f.request,f.recovery,f.runtime),request=handoff.result.request;
    for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'check.cjs'),"const a=require('assert');a.equal(require('fs').readFileSync('same.txt','utf8'),'after\\n');process.stdout.write('p'.repeat(12000)+'\\n');console.log('PASS late actual assertion');");
    const invocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:request.route,activeCapabilities:capabilities,prompt:'Actual bounded stdout witness fixture; no provider.',forkTurns:'none',taskName:'observed',agentType:'forge-executor'});
    const pointers=[],options={request,nativeInvocation:invocation,assertBoundary:f.assertBoundary,assertAuthority:f.assertBoundary,persistDeliveryReceipt:p=>pointers.push(p)},session=native.prepare(options);session.start();
    for(const root of f.contract.code_roots)fs.writeFileSync(path.join(root.path,'same.txt'),'after\n');
    const result=f.result();for(const item of result.must_haves_status)for(const e of item.evidence)e.stdout_line='PASS late actual assertion';session.returned(result);
    const manifest=fs.readFileSync(request.resultFile+'.manifest.json'),returned=fs.readFileSync(pointers.at(-1).file),verified=session.verify(result);
    assert(verified.capture.passed);assert.equal(verified.capture.gate.roots.length,2);
    for(const envelope of verified.capture.gate.roots){const check=envelope.result.checks[0];assert.equal(check.exitCode,0);assert(check.stdout.endsWith('…[truncated]'));assert(!check.stdout.includes('PASS late actual assertion'));assert.deepEqual(check.observed_stdout_lines,['PASS late actual assertion']);assert.equal(check.stdout_truncated,true);if(process.platform==='win32')assert.equal(check.cleanup?.status,'joined');}
    const published=session.publish(result);assert.deepEqual(published.result,result);assert.deepEqual(fs.readFileSync(request.resultFile+'.manifest.json'),manifest);assert.deepEqual(fs.readFileSync(pointers[0].file),returned);
    console.log('PASS actual owned commands retain bounded late native witnesses across two roots and publish original result without provider inference');
  }finally{f.cleanup();}
  const absent=await fixture();
  try{
    const handoff=await side.recoverUnitSidecar(absent.request,absent.recovery,absent.runtime),request=handoff.result.request;
    for(const root of absent.contract.code_roots)fs.writeFileSync(path.join(root.path,'check.cjs'),"process.stdout.write('p'.repeat(12000)+'\\n');console.log('PASS real only');");
    const invocation=require('./forge-native-invocation').buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:request.route,activeCapabilities:capabilities,prompt:'Unobserved witness fixture; no provider.',forkTurns:'none',taskName:'absent',agentType:'forge-executor'});
    const session=native.prepare({request,nativeInvocation:invocation,assertBoundary:absent.assertBoundary,assertAuthority:absent.assertBoundary,persistDeliveryReceipt:()=>{}});session.start();for(const root of absent.contract.code_roots)fs.writeFileSync(path.join(root.path,'same.txt'),'after\n');
    const result=absent.result();for(const item of result.must_haves_status)for(const e of item.evidence)e.stdout_line='PASS never emitted';session.returned(result);assert.throws(()=>session.verify(result),/criterion-unobserved-evidence/);
    const commands={alpha:['node check.cjs'],beta:['node check.cjs']};assert.throws(()=>verify.runRootVerification(absent.contract,{commandsByRoot:commands,evidenceRequests:{foreign:{'node check.cjs':['PASS x']}}}),/evidence-request-invalid/);
    assert.throws(()=>verify.runRootVerification(absent.contract,{commandsByRoot:commands,evidenceRequests:{alpha:{'node check.cjs':Array(65).fill('PASS x')}}}),/evidence-request-invalid/);
    assert.throws(()=>verify.runRootVerification(absent.contract,{commandsByRoot:commands,evidenceRequests:{alpha:{'node other.cjs':['PASS x']}}}),/evidence-request-invalid/);
    assert.throws(()=>verify.runRootVerification(absent.contract,{commandsByRoot:commands,evidenceRequests:{alpha:{'node check.cjs':['x'.repeat(2049)]}}}),/evidence-request-invalid/);
    console.log('PASS absent witnesses, foreign roots/commands and over-limit requests refuse; legacy stdout and process limits stay intact');
  }finally{absent.cleanup();}
}
module.exports={main};if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
