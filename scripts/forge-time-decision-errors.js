'use strict';

// Callback diagnostics are a closed vocabulary, never an exception payload.
const SAFE_CODES=new Set(['time-decision-attestation-required','time-decision-answer-mismatch',
  'time-decision-scope-mismatch','time-options-stale','time-options-invalid']);
function safeDecisionFailure(error){
 try{const code=error?.code;return typeof code==='string'&&SAFE_CODES.has(code)?code:'time-decision-attestation-required';}
 catch{return'time-decision-attestation-required';}
}
module.exports={safeDecisionFailure};
