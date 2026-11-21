'use strict';
// Public API regression; local synthetic telemetry only, zero provider calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const side=require('./forge-unit-sidecar'),native=require('./forge-native-invocation');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function inventory(root){const result={};function visit(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);assert(!item.isSymbolicLink());if(item.isDirectory())visit(file);else result[path.relative(root,file)]=sha(fs.readFileSync(file));}}visit(root);return result;}
async function main(){
 const temp=fs.realpathSync.native(os.tmpdir()),lab=fs.mkdtempSync(path.join(temp,'forge-memory-failure-')),owner=path.join(lab,'owner');fs.mkdirSync(owner);
 const route={model:'gpt-6-luna',model_requested:'gpt-6-luna',model_resolved:'gpt-6-luna',alias:null,effort:'high',dispatch_engine:'codex',host_runtime:'codex',resolved_worker_engine:'codex',worker_mode:'native',dispatch_allowed:true,config_ok:true};
 const request=(label,value,missing=false,telemetry)=>({cwd:owner,contextRoot:owner,unitType:'memory-extract',sourceUnitType:'execute-task',sourceUnitId:'T01',milestoneId:'M001',workflowId:'fixture444',dispatchId:'fixture444-'+label,route,resultFile:path.join(lab,label+'.json'),nativeFailure:{reason_code:'fixture-worker-error',...(missing?{}:{provider_called:value}),...(telemetry===undefined?{}:{telemetry})}});
 let cases=0;
 async function accept(r,expected){const result=await side.acceptNativeMemoryResult(r),bytes=fs.readFileSync(r.resultFile+'.receipt.json');assert.equal(result.provider_called,expected);assert.equal(JSON.parse(bytes).failure.provider_called,expected);assert.equal((await side.acceptNativeMemoryResult(r)).provider_called,expected);assert(bytes.equals(fs.readFileSync(r.resultFile+'.receipt.json')),'replay preserves original receipt bytes');cases++;}
 async function refuse(r,code){const before=inventory(owner);await assert.rejects(side.acceptNativeMemoryResult(r),e=>e.code===code);assert(!fs.existsSync(r.resultFile));assert(!fs.existsSync(r.resultFile+'.receipt.json'));assert.deepEqual(inventory(owner),before,'refusal must not append an owner event');cases++;}
 try{
  for(const[label,value,expected,missing]of [['false',false,false,false],['unknown','unknown','unknown',false],['missing',null,'unknown',true]])await accept(request(label,value,missing),expected);
  console.log('PASS native memory failure false unknown and omitted provenance survive result receipt and replay');
  for(const[label,value]of [['null',null],['yes','yes'],['one',1],['zero',0],['object',{}],['array',[]],['empty',''],['false-string','false'],['nan',NaN]])await refuse(request(label,value),'native-memory-failure-invalid');
  console.log('PASS native memory failure nine invalid values refuse before result receipt and event');
  const invocation=native.buildNativeInvocation({hostRuntime:'codex',resolvedDispatch:route,activeCapabilities:{available:true,tool:'spawn_agent',source:'synthetic-test-capabilities',models:[route.model],reasoning_efforts:['high'],fork_turns:['none']},agentType:'forge-memory',prompt:'fixture only; no invocation'});assert.equal(invocation.ok,true);
  const telemetry=invocation.telemetry;await accept(request('true',true,false,telemetry),true);
  for(const[label,t,code]of [['missing-telemetry',undefined,'native-memory-telemetry-invalid'],['foreign-model',{...telemetry,model_resolved:'fixture-foreign-model'},'native-memory-telemetry-mismatch'],['foreign-effort',{...telemetry,effort_resolved:'low'},'native-memory-telemetry-mismatch'],['extra-field',{...telemetry,unexpected:'fixture'},'native-memory-telemetry-invalid']])await refuse(request(label,true,false,t),code);
  console.log('PASS native memory failure true still requires exact closed route telemetry');
  const historical=request('historical',false);await accept(historical,false);const bytes=fs.readFileSync(historical.resultFile+'.receipt.json');await assert.rejects(side.acceptNativeMemoryResult({...historical,nativeFailure:{...historical.nativeFailure,provider_called:'unknown'}}),e=>e.code==='dispatch-identity-conflict');assert(bytes.equals(fs.readFileSync(historical.resultFile+'.receipt.json')),'existing provenance is never rewritten');
  console.log('PASS native memory failure conflicting provenance cannot rewrite an existing receipt');
  assert.equal(cases,18);console.log('native-memory-failure: 18 public API cases passed; provider calls: 0');
 }finally{const actual=fs.realpathSync.native(lab);assert.equal(path.dirname(actual).toLowerCase(),temp.toLowerCase());assert(path.basename(actual).startsWith('forge-memory-failure-'));fs.rmSync(actual,{recursive:true});}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
