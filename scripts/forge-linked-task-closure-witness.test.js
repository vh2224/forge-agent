'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),cp=require('child_process');
function child(){const i=JSON.parse(fs.readFileSync(0,'utf8')),lts=require('./forge-linked-task-start'),horizon=require('./forge-linked-task-horizon');let result;
 if(i.action==='close')result=lts.closeLinkedTask({...i.args,...(i.stop?{failpoint:name=>name===i.stop}:{})});
 else result={life:lts.linkedLifecycle(i.args.cwd,i.args.taskId),clock:horizon.readTaskClock({cwd:i.args.cwd,task:i.args.taskId,now:i.args.now}),status:horizon.readLinkedStatus({cwd:i.args.cwd,task:i.args.taskId,now:i.args.now})};
 process.stdout.write(JSON.stringify(result)+'\n');}
function invoke(action,args,stop){const r=cp.spawnSync(process.execPath,[__filename,'--child'],{input:JSON.stringify({action,args,stop}),encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1048576});assert.equal(r.status,0,r.stderr||r.error?.message);return JSON.parse(r.stdout.trim());}
function main(){const h=require('./forge-linked-task-transport.test'),lts=require('./forge-linked-task-start'),time=require('./forge-milestone-time');const saved={HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE,FORGE_HOME:process.env.FORGE_HOME};const home=h.tempRoot('forge-closure-witness-home-');process.env.HOME=process.env.USERPROFILE=home;process.env.FORGE_HOME=path.resolve(__dirname,'..');
 try{for(const interrupted of [false,true]){
  const f=h.chainFixture();f.endpoint();assert.equal(lts.produceHandoff({cwd:f.owner,milestone:h.M,...f.prof}).status,'produced');assert.equal(h.startTask(f).status,'started');h.taskDelivery(f);
  const dir=path.join(f.owner,'.gsd/forge/time',h.M,'linked-task'),closure=path.join(dir,'closure.json'),witness=path.join(f.owner,'.gsd/forge/time',h.M,'linked-task-bindings/closure.json'),args={cwd:f.owner,taskId:f.task,codeDir:f.code,now:Date.now()+1000,...f.prof};
  const originalDelivery=path.join(f.owner,'.gsd/tasks',f.task,f.task+'-DELIVERY.json'),originalBytes=fs.readFileSync(originalDelivery);fs.writeFileSync(originalDelivery,'{}\n');
  assert.throws(()=>time.publishLinkedTaskClosureWitness({...args,milestone:h.M}),error=>error.code==='linked-task-delivery-unproven');assert.equal(fs.existsSync(witness),false,'private primitive must derive actual delivery before minting a witness');fs.writeFileSync(originalDelivery,originalBytes);
  const first=invoke('close',args,interrupted?'after-closure-witness':undefined);assert.equal(first.status,interrupted?'partial':'closed');assert(fs.existsSync(witness),'genuine close publishes independent complete witness');assert.equal(fs.existsSync(closure),!interrupted);
  const witnessed=fs.readFileSync(witness),w=JSON.parse(witnessed);assert.equal(w.kind,'forge-linked-task-closure-witness');assert.equal(w.closure.task_id,f.task);
  assert.throws(()=>time.publishOwnerRecord({cwd:f.owner,milestone:h.M,path:'linked-task-bindings/closure.json',record:w}),error=>error.code==='time-record-path-invalid');
  for(const key of ['record','build','anchor','binding','proof','witness'])assert.throws(()=>time.publishLinkedTaskClosureWitness({...args,milestone:h.M,[key]:key==='build'?()=>({record:w.closure}):w}),error=>error.code==='time-record-invalid');
  const prefix=path.join(f.owner,'.gsd/tasks',f.task,f.task);const sourcePaths=['-SUMMARY.md','-DELIVERY.json','-DELIVERY-INPUT.json'];const originals=sourcePaths.map(suffix=>fs.readFileSync(prefix+suffix));
  // Today's mutable delivery has no authority to rewrite historical publication.
  for(const suffix of sourcePaths)fs.writeFileSync(prefix+suffix,'later task source deliberately no longer a delivery\n');
  const replay=invoke('close',{...args,now:args.now+900000});assert.equal(replay.status,interrupted?'closed':'unchanged');assert(fs.readFileSync(witness).equals(witnessed));
  const bytes=fs.readFileSync(closure),record=JSON.parse(bytes);assert.deepEqual(record,w.closure,'interrupted recovery publishes the exact original instant, clock, digest and proof');
  const valid=invoke('read',{...args,now:args.now+900000});assert.equal(valid.life.status,'closed');assert.equal(valid.clock.status,'measured');assert.equal(valid.clock.frozen,true);assert.equal(valid.clock.horizon.ended_at,record.closed_at);
  assert.equal(valid.status.task_horizon.state,'completed');
  if(!interrupted){
   const attacks=[r=>{r.closed_at=new Date(Date.parse(r.closed_at)+1000).toISOString();},r=>{r.summary.sha256='a'.repeat(64);},r=>{r.delivery.sha256='b'.repeat(64);},r=>{r.delivery.input_sha256='c'.repeat(64);},r=>{r.delivery.criteria++;},r=>{r.delivery.fingerprint=r.fingerprint='d'.repeat(64);},r=>{r.clock.journal_records++;}];
   for(const attack of attacks){const changed=JSON.parse(bytes);attack(changed);fs.writeFileSync(closure,JSON.stringify(changed)+'\n');const beforeTree=h.tree(f.owner);const bad=invoke('read',args);assert.equal(bad.life.status,'invalid');assert.equal(bad.clock.status,'invalid');assert.equal(bad.status.status,'invalid');const refused=invoke('close',args);assert.equal(refused.status,'refused');assert.deepEqual(h.tree(f.owner),beforeTree,'invalid closure replay writes no personal capture/history');assert(fs.readFileSync(witness).equals(witnessed));fs.writeFileSync(closure,bytes);}
   fs.unlinkSync(witness);const legacyBytes=fs.readFileSync(closure),legacyTree=h.tree(f.owner),legacy=invoke('read',args);assert.equal(legacy.life.status,'invalid','legacy valid-shape closure has no publication authority');assert.equal(invoke('close',args).status,'refused');assert.deepEqual(h.tree(f.owner),legacyTree);assert(fs.readFileSync(closure).equals(legacyBytes));
   assert.throws(()=>time.publishLinkedTaskClosureWitness({...args,milestone:h.M}),error=>error.code==='time-record-invalid','private issuer never retroactively blesses a legacy public closure');
   time.publishOwnerRecord({cwd:f.owner,milestone:h.M,path:'linked-task/closure-witness.json',record:w});assert.equal(invoke('read',args).life.status,'invalid','a public lookalike cannot mint private publication evidence');fs.unlinkSync(path.join(dir,'closure-witness.json'));fs.writeFileSync(witness,witnessed);
   const forged=JSON.parse(witnessed);forged.closure_sha256='e'.repeat(64);fs.writeFileSync(witness,JSON.stringify(forged)+'\n');assert.equal(invoke('read',args).life.status,'invalid');assert.equal(invoke('close',args).status,'refused');fs.writeFileSync(witness,witnessed);
  }
  for(let n=0;n<sourcePaths.length;n++)fs.writeFileSync(prefix+sourcePaths[n],originals[n]);assert.equal(invoke('close',args).status,'unchanged');assert(fs.readFileSync(closure).equals(bytes));
 }
 console.log('PASS genuine fresh-process closure publish/replay, interrupted witness recovery, immutable historical clock and single-file/legacy refusal');
 }finally{for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}h.cleanup();}}
if(process.argv[2]==='--child')child();else try{main();}catch(error){console.error(error.stack);process.exitCode=1;}
