'use strict';
const assert=require('node:assert/strict');
const {digest}=require('./forge-code-roots');
const {routeKey}=require('./forge-attempt-recovery');
const {destinationKey}=require('./forge-recovery-transition');
const {inheritedProvenance}=require('./forge-recovery-reservation-lineage');
function fixture(){
  const chain=[{id:'claude-opus-5-5',engine:'claude'},{id:'gpt-6.1-sol',engine:'gpt'}];
  const route={host_runtime:'codex',resolved_worker_engine:'gpt',worker_mode:'native',model:'gpt-6.1-sol',
    model_resolved:'gpt-6.1-sol',tier:'heavy',effort:'high',unit_type:'execute-task',chain};
  const provenance={unit_type:'execute-task',host:'codex',tier:'heavy',request_identity_sha256:'i',chain_sha256:digest(chain)};
  const source={route_key:routeKey(route),destination_key:destinationKey(route),corrected:false,reason:'resolved-next-destination',provenance};
  const saved={route_key:source.route_key,destination_key:source.destination_key,corrected:true,reason:'offline-correction',
    provenance:null,request_sha256:'b'.repeat(64),correction:{offline_validated:true,evidence_reference:'fixture:offline',request_sha256:'b'.repeat(64)}};
  return {request_identity_sha256:'i',attempts:[{route:{chain}},{route,route_key:routeKey(route),reservation:structuredClone(source),
    failure_class:'caller',provider_called:false,request_sha256:'a'.repeat(64)}],reservations:[source,saved]};
}
function main(){
  const options={ordinary:true,routeKey,destinationKey},state=fixture(),before=JSON.stringify(state);
  assert.deepEqual(inheritedProvenance(state,options),state.reservations[0].provenance);
  assert.equal(JSON.stringify(state),before,'derivation must not rewrite null provenance or any history');
  assert.throws(()=>inheritedProvenance(state,{...options,ordinary:false}),/correction-provenance-required/);
  const mutations=[
    s=>{s.reservations.pop();},s=>{s.reservations.shift();},s=>{s.attempts[1].reservation=null;},
    s=>{s.attempts[1].reservation.route_key='foreign';},s=>{s.reservations[0].provenance=null;},
    s=>{s.reservations[0].corrected=true;},s=>{s.reservations[0].reason='foreign';},
    s=>{s.reservations[1].provenance={};},s=>{s.reservations[1].corrected=false;},s=>{s.reservations[1].reason='foreign';},
    s=>{s.reservations[1].correction.offline_validated=false;},s=>{s.reservations[1].correction.evidence_reference='';},
    s=>{s.reservations[1].correction.evidence_reference=1;},s=>{s.reservations[1].correction.request_sha256='foreign';},
    s=>{s.reservations[1].request_sha256='a'.repeat(64);s.reservations[1].correction.request_sha256='a'.repeat(64);},
    s=>{s.attempts[1].failure_class='timeout';},s=>{s.attempts[1].provider_called=true;},s=>{s.attempts[1].provider_called='unknown';},
    s=>{s.attempts[1].route.worker_mode='sidecar';},s=>{s.attempts[1].route_key='foreign';},
    s=>{s.reservations[1].route_key='foreign';},s=>{s.reservations[1].destination_key='foreign';},
    s=>{s.reservations[0].destination_key='foreign';s.attempts[1].reservation.destination_key='foreign';},
    s=>{s.attempts[1].route.model_resolved='foreign';},s=>{s.attempts[1].route.effort='max';},
    s=>{s.attempts[1].route.tier='max';},s=>{s.request_identity_sha256='foreign';},
    s=>{s.attempts[0].route.chain=[];},s=>{s.attempts[1].route.chain=[];},
    s=>{s.attempts[1].route.host_runtime='foreign';},s=>{s.attempts[1].route.unit_type='foreign';},
  ];
  for(const change of mutations){const candidate=fixture();change(candidate);
    assert.throws(()=>inheritedProvenance(candidate,options),/correction-provenance-required/);}
  console.log('PASS corrected reservation lineage: immutable derivation and '+(mutations.length+1)+' invalid lineage/authority/identity/route/correction cases refused');
}
module.exports={main};if(require.main===module)main();
