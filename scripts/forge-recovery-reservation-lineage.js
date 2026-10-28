'use strict';

// Pure validation of retained data, never an authorization or transition handle.
// The caller must already authenticate the live uninvoked-reservation transition.
const { digest } = require('./forge-code-roots');
function inheritedProvenance(state, { ordinary, routeKey, destinationKey }) {
  const saved=state.reservations?.at(-1),source=state.reservations?.at(-2),previous=state.attempts?.at(-1);
  const fail=()=>{throw Object.assign(new Error('recovery-correction-provenance-required'),{code:'recovery-correction-provenance-required'});};
  if(!ordinary||!saved||saved.provenance!==null||saved.corrected!==true||saved.reason!=='offline-correction'
    ||saved.correction?.offline_validated!==true||typeof saved.correction.evidence_reference!=='string'||!saved.correction.evidence_reference.trim()
    ||typeof saved.request_sha256!=='string'||!/^[a-f0-9]{64}$/.test(saved.request_sha256)||saved.correction.request_sha256!==saved.request_sha256
    ||saved.request_sha256===previous?.request_sha256
    ||previous?.failure_class!=='caller'||previous.provider_called!==false||previous.route?.worker_mode!=='native'
    ||!source?.provenance||source.corrected!==false||source.reason!=='resolved-next-destination'
    ||digest(previous.reservation)!==digest(source))fail();
  const route=routeKey(previous.route),destination=destinationKey(previous.route),provenance=source.provenance;
  if(previous.route_key!==route||saved.route_key!==route||source.route_key!==route
    ||saved.destination_key!==destination||source.destination_key!==destination
    ||provenance.request_identity_sha256!==state.request_identity_sha256
    ||provenance.chain_sha256!==digest(state.attempts[0].route.chain)
    ||provenance.chain_sha256!==digest(previous.route.chain)
    ||provenance.host!==previous.route.host_runtime||provenance.tier!==previous.route.tier
    ||provenance.unit_type!==previous.route.unit_type)fail();
  return provenance;
}
module.exports={inheritedProvenance};
