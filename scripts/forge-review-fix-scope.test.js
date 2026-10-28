'use strict';
const assert=require('node:assert/strict');
const {canonicalRequest}=require('./forge-attempt-recovery');
const {capability}=require('./forge-transport-capabilities');
const {locations}=require('./forge-unit-sidecar');
const original={unitType:'review-fix',taskId:'T-20261028040008-vigiar-progresso',reviewFix:{boundary:'task'},cwd:process.cwd()};
const request=canonicalRequest(original);
assert.equal(request.scope,'standalone-task');assert.equal(request.phase,'review-fix');
assert.equal(locations(request).reviewFix.boundary,'task');
assert.equal(original.scope,undefined);
for(const engine of ['claude','codex']){
 assert.equal(capability(engine,'review-fix',request).mode,'fix');
 for(const phase of ['execute','plan','review',undefined])assert.equal(capability(engine,'review-fix',{...request,phase}).supported,false);
}
assert.equal(capability('agy','review-fix',request).supported,false);
assert.throws(()=>locations({...request,reviewFix:{boundary:'slice'}}),/review-fix/);
assert.throws(()=>locations({...request,taskId:undefined,milestoneId:'M001',sliceId:'S01',reviewFix:{boundary:'slice'}}),/review-fix/);
assert.throws(()=>locations({...request,scope:'milestone'}),/review-fix/);
const milestone=canonicalRequest({unitType:'review-fix',milestoneId:'M001',sliceId:'S01',reviewFix:{boundary:'slice'}});
assert.equal(milestone.scope,'milestone');assert.equal(milestone.phase,'review');
assert.equal(locations(milestone).reviewFix.boundary,'slice');
console.log('PASS standalone review-fix identity, exact transport phase, legacy milestone identity and invalid boundary refusal');
