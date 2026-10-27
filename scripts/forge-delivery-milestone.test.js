'use strict';
// Focused schema2 milestone aggregation regression. No production worktree writes.
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const delivery=require('./forge-delivery'),roots=require('./forge-code-roots'),lab=require('./forge-code-roots.test');
function run(){const f=lab.fixture();let checks=0;try{
 const unit={type:'milestone',id:'M001'},roadmap='# M001 Roadmap\n\n## Slices\n- S01: existing child delivery\n';
 const file=path.join(f.owner,'ROADMAP.md');fs.writeFileSync(file,roadmap);
 const input={schema_version:2,unit,plan:'ROADMAP.md',plan_fingerprint:delivery.sha256(roadmap),execution_contract:f.contract,additional_criteria:[{id:'SC01',text:'Observable aggregate criterion',reference:'ROADMAP.md#scope',type:'functional',aspects:['default']}],bindings:[],expected_children:[]};
 const build=x=>delivery.buildDelivery(x||input,{ownerRoot:f.owner,codeDir:f.a}),notVerified=out=>{assert(out.criteria.length>0);assert(out.criteria.every(c=>c.status==='n\u00e3o verificado'));};
 const output=build();assert(delivery.renderDeliveryMarkdown(output).includes('Implementa\u00e7\u00e3o'));assert(output.diagnostics.includes('plan_legacy'));notVerified(output);assert(output.criteria.every(c=>c.evidence.length===0));checks++;
 const single={...f.contract,code_roots:[f.contract.code_roots[0]]};notVerified(build({...input,execution_contract:single}));checks++;
 for(const type of ['task','slice']){assert.throws(()=>build({...input,unit:{type,id:type==='task'?'T01':'S01',milestone:'M001',slice:'S01'}}),/execution-plan-frontmatter-required/);checks++;}
 const changed=structuredClone(f.contract);changed.code_roots[0].identity_sha256='0'.repeat(64);assert.throws(()=>build({...input,execution_contract:changed}),/root-identity-changed/);checks++;
 assert.throws(()=>delivery.buildDelivery(input,{ownerRoot:f.owner,codeDir:f.b}),/delivery-primary-root-mismatch/);checks++;
 const mismatch=build({...input,plan_fingerprint:'0'.repeat(64)});assert(mismatch.diagnostics.includes('plan_fingerprint_mismatch'));notVerified(mismatch);checks++;
 const outside=build({...input,plan:'../outside.md'});assert(outside.diagnostics.some(x=>x.startsWith('plan_')));notVerified(outside);checks++;
 const criterion=output.criteria[0].id;
 const envelope={schema_version:1,kind:'verification',unit,plan_fingerprint:input.plan_fingerprint,root_id:'alpha',root_identity_sha256:f.contract.code_roots[0].identity_sha256,execution_contract_sha256:roots.digest(f.contract),code_dir:f.a,revision:'synthetic',environment:'fixture',captured_at:'2026-10-26T00:00:00.000Z',result:{passed:true,checks:[{command:'synthetic',exitCode:0}]}};
 const bind=source=>({...input,bindings:[{criterion_id:criterion,coverage:'behavioral',root_id:'alpha',source:{kind:'verification',path:source,check_index:0}}]});
 for(const mutation of [{unit:{type:'slice',id:'S01',milestone:'M001'}},{plan_fingerprint:'0'.repeat(64)},{root_identity_sha256:'0'.repeat(64)},{root_id:'foreign'}]){fs.writeFileSync(path.join(f.owner,'envelope.json'),JSON.stringify({...envelope,...mutation}));const out=build(bind('envelope.json'));notVerified(out);assert(out.criteria[0].evidence.some(o=>o.reasons?.length));checks++;}
 notVerified(build(bind('../outside.json')));checks++;
 const malformed='---\nmust_haves:\n  truths: invalid\n  artifacts: []\n  key_links: []\ndepends: []\nwrites: [alpha::same.txt]\nexpected_output: [alpha::same.txt]\n---\n';fs.writeFileSync(file,malformed);assert.throws(()=>build({...input,plan_fingerprint:delivery.sha256(malformed)}),/malformed must_haves/);checks++;
 const structured=lab.plan(f.contract);fs.writeFileSync(file,structured);const withPlan={...input,plan_fingerprint:delivery.sha256(structured)};const qualified=build(withPlan);assert(qualified.criteria.filter(c=>c.artifact_path).every(c=>/^alpha::|^beta::/.test(c.artifact_path)));checks++;
 const badPath=structured.replace(/alpha::same.txt/g,'alpha::../outside.txt');fs.writeFileSync(file,badPath);assert.throws(()=>build({...withPlan,plan_fingerprint:delivery.sha256(badPath)}),/root-path-invalid/);checks++;
 const legacy=structured.replace(/^roots_schema:.*\n/m,'');fs.writeFileSync(file,legacy);assert.throws(()=>build({...withPlan,plan_fingerprint:delivery.sha256(legacy)}),/legacy-multiroot-refused/);checks++;
 console.log(JSON.stringify({status:'passed',checks,scope:'isolated schema2 milestone/task/slice/root/path/fingerprint/envelope guards',fixtures_only:true}));return checks;
 }finally{f.cleanup();}}
module.exports={run};if(require.main===module)run();
