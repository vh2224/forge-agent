'use strict';

// Explicit retained evidence is data, never an authorization or replay receipt.
const path=require('path'),roots=require('./forge-code-roots');
function fail(code){throw Object.assign(new Error(code),{code});}
function measure({owner,request,fingerprint,receiptCopy,read}){
 const file=require('./forge-unit-sidecar').artifactAttemptFiles(request).receiptFile,original=read(file,8*1024*1024,true);
 let bytes=original,copy=null;
 if(receiptCopy!==undefined){
  if(typeof receiptCopy!=='string'||!path.isAbsolute(receiptCopy))fail('owner-window-receipt-copy-invalid');
  const directory=path.join(owner,'.gsd/tasks',request.taskId),candidate=path.resolve(receiptCopy);
  if(!roots.within(directory,candidate)||roots.key(candidate)===roots.key(directory))fail('owner-window-receipt-copy-invalid');
  bytes=read(candidate,8*1024*1024);
  if(original&&!original.equals(bytes))fail('owner-window-receipt-copy-mismatch');
  copy={file:candidate,sha256:roots.digest(bytes),original_present:original!==null,original_sha256:original?roots.digest(original):null};
 }
 let receipt=null;
 if(bytes){
  try{receipt=JSON.parse(bytes);}catch{fail('owner-window-receipt-mismatch');}
  if(!receipt||receipt.dispatch_id!==request.dispatchId||receipt.request_fingerprint!==fingerprint)fail('owner-window-receipt-mismatch');
 }
 return{receipt,reference:{file,sha256:bytes?roots.digest(bytes):null,phase:receipt?.phase||'missing',...(copy?{retained_copy:copy}:{})}};
}
module.exports={measure};
