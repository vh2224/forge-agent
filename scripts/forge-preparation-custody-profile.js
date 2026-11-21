'use strict';

// A limited coordination observation is never a code snapshot or writer proof.
const path=require('path'),roots=require('./forge-code-roots');
const PROFILE='preparation-no-invocation-v1';
function fail(code){throw Object.assign(new Error(code),{code});}
function eligible(receipt){
 return receipt?.phase==='failed'&&receipt.failure?.provider_called===false
  &&!['result','returned','saved_result','saved_candidate','candidate','provisional_terminal'].some(key=>receipt[key]!==undefined&&receipt[key]!==null);
}
function inspectChannels({request,read}){
 const returned=read(request.resultFile+'.returned.json',8*1024*1024,true);
 const result=read(request.resultFile,8*1024*1024,true);
 let candidate=returned!==null;
 if(result){let parsed;try{parsed=JSON.parse(result);}catch{candidate=true;}
  if(parsed?.status!=='failure'||parsed.artifacts!==undefined||parsed.rawResult!==undefined||parsed.candidate!==undefined)candidate=true;
 }
 return{candidate,result_sha256:result===null?null:roots.digest(result),returned_sha256:returned===null?null:roots.digest(returned)};
}
function measure({owner,request,receipt,census,read}){
 if(!eligible(receipt))fail('owner-window-no-invocation-scope-required');
 const channels=inspectChannels({request,read});
 if(channels.candidate)fail('owner-window-saved-candidate-retained');
 const controls=[];
 for(const suffix of ['BRIEF','CONTEXT','RESEARCH','PLAN','SECURITY']){
  const relative=`.gsd/tasks/${request.taskId}/${request.taskId}-${suffix}.md`,bytes=read(path.join(owner,relative),1024*1024,true);
  controls.push({path:relative,sha256:bytes===null?null:roots.digest(bytes)});
 }
 return{measurement_profile:PROFILE,owner_surface_sha256:null,owner_control_files:controls,
  result_channel:{sha256:channels.result_sha256,returned_present:false},
  coverage:{owner_metadata:'named-control-files-only',code_contents:'unmeasured',authority:'coordination-only'},
  code_states:census.roots.map(root=>({root_id:root.id,path:root.path,identity_sha256:root.identity_sha256,vcs:root.vcs,contents:'unmeasured'})).sort((a,b)=>a.root_id.localeCompare(b.root_id))};
}
function assertLiveProof(scope,proof){
 if(scope?.measurement_profile!==PROFILE)return;
 if(proof?.no_invocation_observed!==true||proof.coverage_complete!==true||proof.unmeasured_code_contents_acknowledged!==true)fail('owner-window-no-invocation-unproven');
}
module.exports={PROFILE,eligible,inspectChannels,measure,assertLiveProof};
