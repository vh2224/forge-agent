'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),cp=require('child_process');

async function childMain(){
 const input=JSON.parse(Buffer.from(fs.readFileSync(0,'utf8').trim(),'base64').toString('utf8'));
 let clock=input.below,phase='entry',packaged=0,provisionalCalls=0,calibrationCalls=0;
 const now=()=>clock;
 const admission=require('./forge-milestone-time-admission'),provisional=require('./forge-claude-provisional'),calibration=require('./forge-sidecar-calibration-v2');
 const originalGuard=admission.assertOwnerTransportEntry,originalPrepare=provisional.prepare,originalCalibration=calibration.resolve,guards=[];
 admission.assertOwnerTransportEntry=function(options){guards.push({phase,at:clock,injected:options?.now===now,task:options?.request?.taskId});return originalGuard.apply(this,arguments);};
 provisional.prepare=function(...args){try{return originalPrepare.apply(this,args);}finally{if(packaged){provisionalCalls++;phase='provisional';if(input.crossing==='provisional')clock=input.afterCap;}}};
 calibration.resolve=function(...args){const result=originalCalibration.apply(this,args);if(packaged){calibrationCalls++;phase='calibration';if(input.crossing==='calibration')clock=input.afterCap;}return result;};
 try{
  const result=await require('./forge-unit-sidecar').runUnitSidecar(input.request,{now,onPackagedContext:()=>{packaged++;phase='packaged';}})
   .then(value=>({ok:true,status:value.status}),error=>({ok:false,code:error.code,provider_called:error.provider_called,stage:error.stage,layer:error.layer}));
  process.stdout.write(JSON.stringify({result,guards,packaged,provisionalCalls,calibrationCalls})+'\n');
 }finally{admission.assertOwnerTransportEntry=originalGuard;provisional.prepare=originalPrepare;calibration.resolve=originalCalibration;}
}
async function main(){
 const h=require('./forge-linked-task-transport.test'),lts=require('./forge-linked-task-start'),linked=require('./forge-linked-task'),prep=require('./forge-task-preparation'),side=require('./forge-unit-sidecar');
 const saved={HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,FORGE_HOME:process.env.FORGE_HOME};
 const home=h.tempRoot('forge-late-spawn-home-');process.env.HOME=process.env.USERPROFILE=home;process.env.FORGE_HOME=path.resolve(__dirname,'..');
 try{
  const f=h.chainFixture();f.endpoint();
  assert.equal(lts.produceHandoff({cwd:f.owner,milestone:h.M,...f.prof}).status,'produced');
  assert.equal(h.startTask(f).status,'started');h.prefs(f,'claude-sonnet-5');
  const start=JSON.parse(fs.readFileSync(path.join(f.owner,'.gsd/forge/time',h.M,'linked-task/start.json'))),S=Date.parse(start.started_at);
  const ceiling=linked.linkedTaskFor(f.owner,f.task).link.linked_task.horizon.ceiling_ms,below=S+60000,afterCap=S+ceiling+600000;
  const cli=path.join(f.root,'fixture-cli');fs.mkdirSync(cli);
  const binary=path.join(cli,'claude.js');
  fs.writeFileSync(binary,"'use strict';const fs=require('fs'),path=require('path');\nif(process.argv.includes('--version')){fs.appendFileSync(path.join(__dirname,'versions.txt'),'version\\n');console.log('9.9.9 (Claude Code)');process.exit(0);}\nfs.appendFileSync(path.join(__dirname,'children.txt'),'child\\n');const candidate=JSON.parse(fs.readFileSync(path.join(__dirname,'candidate.json'),'utf8'));const index=process.argv.indexOf('--model'),model=process.argv[index+1];const result='---GSD-WORKER-RESULT---\\nstatus: done\\nresult_json: '+JSON.stringify(candidate)+'\\n---END-RESULT---\\n';console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result,structured_output:candidate,usage:{input_tokens:1,output_tokens:1},modelUsage:{[model]:{inputTokens:1,outputTokens:1}}}));\n");
  const registry=path.join(cli,'accounts.json');fs.writeFileSync(registry,JSON.stringify({version:1,active:'fixture',accounts:{fixture:{name:'fixture'}}}));
  fs.mkdirSync(path.join(f.home,'.claude'),{recursive:true});fs.writeFileSync(path.join(f.home,'.claude/forge-accounts-tokens.json'),JSON.stringify({fixture:'synthetic-not-a-credential'}));
  const children=()=>fs.existsSync(path.join(cli,'children.txt'))?fs.readFileSync(path.join(cli,'children.txt'),'utf8').trim().split('\n').length:0;
  for(const crossing of ['provisional','calibration','admitted']){
   const raw=h.prepRequest(f,'codex','research','last-spawn-'+crossing);
   const selected=await prep.startStandaloneTaskPreparation(raw,{now:()=>below});assert.equal(selected.action,'invoke-sidecar');
   const research='# Research\n\n## Summary\nThe fixture exports a number and its check verifies that behavior.\n\n## Don\'t Hand-Roll\nReuse the existing check script.\n\n## Relevant Code\n- scripts/result.js: numeric export.\n- scripts/check.js: executable assertion.\n';
   const candidate={status:'done',summary:'Synthetic admitted research.',questions:[],artifacts:side.locations(selected.delivery_request).required.map(item=>({path:item,content:research}))};
   const resultFile=path.join(cli,'candidate.json');fs.writeFileSync(resultFile,JSON.stringify(candidate));const before=children();
   const child=cp.spawnSync(process.execPath,[__filename,'--child'],{cwd:f.code,input:Buffer.from(JSON.stringify({request:selected.delivery_request,below,afterCap,crossing})).toString('base64'),encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:1048576,
    env:{...process.env,HOME:f.home,USERPROFILE:f.home,FORGE_ACCOUNTS_REGISTRY:registry,FORGE_KEYCHAIN_DISABLED:'1',FORGE_XLLM_CLAUDE_BIN:binary}});
   assert.equal(child.status,0,child.stderr||child.error?.message);const seen=JSON.parse(child.stdout.trim().split('\n').at(-1));
   assert.equal(seen.packaged,1);assert.equal(seen.provisionalCalls,1);assert.equal(seen.calibrationCalls,1);
   assert(seen.guards.every(row=>row.injected&&row.task===f.task));
   assert(seen.guards.some(row=>row.phase==='packaged'&&row.at===below),'the packaging guard must see the original admitted clock');
   const receipt=JSON.parse(fs.readFileSync(raw.resultFile+'.receipt.json'));
   if(crossing!=='admitted'){
    assert.equal(children(),before,'no provider child may start after '+crossing+' crosses the cap: '+JSON.stringify(seen));
    assert.deepEqual([seen.result.ok,seen.result.code,seen.result.provider_called],[false,'linked-task-budget-exhausted',false]);
    assert.equal(seen.guards.at(-1).phase,'calibration');assert.equal(seen.guards.at(-1).at,afterCap);
    assert.deepEqual([receipt.phase,receipt.failure.reason_code,receipt.failure.provider_called,receipt.failure.layer],['failed','linked-task-budget-exhausted',false,'milestone-time-admission']);
   }else{
    assert.equal(children(),before+1);assert.deepEqual(seen.result,{ok:true,status:'done'});
    assert.equal(receipt.phase,'ready');assert(seen.guards.every(row=>row.at===below));
    for(const artifact of candidate.artifacts)assert.equal(fs.readFileSync(path.join(f.owner,artifact.path),'utf8'),artifact.content,'admitted control publishes through the real artifact publisher');
   }
  }
  console.log('PASS last Claude spawn admission refuses typed after real provisional/calibration with zero provider children; admitted control genuinely publishes');
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}h.cleanup();}
}
if(process.argv[2]==='--child')childMain().catch(error=>{console.error(error.stack);process.exitCode=1;});
else main().catch(error=>{console.error(error.stack);process.exitCode=1;});
