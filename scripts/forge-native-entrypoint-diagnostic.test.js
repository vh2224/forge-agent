'use strict';
const assert=require('assert/strict'),fs=require('fs');
const h=require('./fixtures/forge-native-execution').createFixtureHarness();let completed=false;
(async()=>{
 const f=h.nativeFixture();
 const request={...f.r,scope:'milestone',phase:'execute',milestoneId:'M001',sliceId:'S01',taskId:'T01'};
 request.route=require('./forge-dispatch-resolve').resolveDispatch({cwd:f.owner,unitType:request.unitType,milestoneId:'M001',unitId:'T01',planPath:request.planFile,hostRuntime:'codex'});
 const guard=require('./forge-dispatch-guard').evaluateDispatchGuard({...request.route,unit_type:'execute-task'});
 assert.equal(guard.dispatch_allowed,true);
 await assert.rejects(require('./forge-unit-sidecar').runUnitSidecar(request,f.runtime),e=>e.code==='execution-entrypoint-incompatible'&&e.message.includes('native owner delivery'));
 assert.equal(f.calls(),0);assert(!fs.existsSync(request.resultFile+'.receipt.json'));
 console.log('PASS allowed native posture reports incompatible milestone sidecar entry before provider/receipt');completed=true;
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>h.close(completed));
