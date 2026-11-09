'use strict';
// Test-only next terminal. The entire #367 and earlier validation chain runs.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../incomplete-resume/distribution.cjs'),terminal=require('./distribution-delta.json');
const ROOT=path.resolve(__dirname,'../../..'),hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const ANCHORS={"docs/lifecycle-resume.md":{"before":"e8a09b1377622b87e86e4fda20448ba16f1eb435b76efe49b5a53ad0c2b30127","after":"4eb7614bd28c557a184acc5e96364535b366118a5b6f4725a1f3c9e208290f36","attributed_before":"e8a09b1377622b87e86e4fda20448ba16f1eb435b76efe49b5a53ad0c2b30127","attributed_after":"4eb7614bd28c557a184acc5e96364535b366118a5b6f4725a1f3c9e208290f36"},"scripts/forge-runs.js":{"before":"efe7a09ef9dc950c6c7f6621c08b83b7bc34f8bd97486da3c69eceecbb5bf4f6","after":"2f0d77d3ff54b971fec865f5c4f2276fd5ed0c9ccfb59f458b6f61b099b5c28d","attributed_before":"efe7a09ef9dc950c6c7f6621c08b83b7bc34f8bd97486da3c69eceecbb5bf4f6","attributed_after":"2f0d77d3ff54b971fec865f5c4f2276fd5ed0c9ccfb59f458b6f61b099b5c28d"},"scripts/forge-unit-controller.js":{"before":"83bd10375fafc52c1d26af8125ca27e1d3c4f23e7f81cb5ac90df68b610ae900","after":"4ee058cfb7447c7ab95cd083bcbc83e65492059ecf1401f449806bb22d38d598","attributed_before":"83bd10375fafc52c1d26af8125ca27e1d3c4f23e7f81cb5ac90df68b610ae900","attributed_after":"4ee058cfb7447c7ab95cd083bcbc83e65492059ecf1401f449806bb22d38d598"},"scripts/forge-unit-controller.test.js":{"before":"66e5f93531cda46e8c6af1906391976a0c791fcd37cf5edab419fedcb2d1930d","after":"434b4c5ecbe18f12eb767a5929684e2e06bdfa49c9aa19675b1c62a22dfb1549","attributed_before":"66e5f93531cda46e8c6af1906391976a0c791fcd37cf5edab419fedcb2d1930d","attributed_after":"434b4c5ecbe18f12eb767a5929684e2e06bdfa49c9aa19675b1c62a22dfb1549"},"scripts/forge-unit-lease.js":{"before":"c642cac6b08af0972d52b0e310d5e253d57e44464170f7d085ee15f059f1efe9","after":"372c984037e203f7245b4f094bb8038b28299f396eafc87567d7460b7115608e","attributed_before":"c642cac6b08af0972d52b0e310d5e253d57e44464170f7d085ee15f059f1efe9","attributed_after":"372c984037e203f7245b4f094bb8038b28299f396eafc87567d7460b7115608e"},"scripts/forge-unit-lease.test.js":{"before":"52c54f68498c2bd8001d9a17ec318efddcf632480ea579d2d878aed4d2a44976","after":"5feea893df94cf408fef2dde0ff606204c87f1ff7be5c8bb46e0f18063eed830","attributed_before":"52c54f68498c2bd8001d9a17ec318efddcf632480ea579d2d878aed4d2a44976","attributed_after":"5feea893df94cf408fef2dde0ff606204c87f1ff7be5c8bb46e0f18063eed830"},"scripts/forge-claude-renderer.test.js":{"before":"ce9604c74c6085c961981323663e2e4b86317c8f8551f426bdfb0c9d061c2e7c","after":"6b4c2f4b4d1ee6bd710a668a1c092fb85655b6e3c2a11556f972917e1de9d1db","attributed_before":"ce9604c74c6085c961981323663e2e4b86317c8f8551f426bdfb0c9d061c2e7c","attributed_after":"6b4c2f4b4d1ee6bd710a668a1c092fb85655b6e3c2a11556f972917e1de9d1db"},"scripts/forge-communication-surfaces.test.js":{"before":"74d20c474d11f12ce15256154cd240b586b8f8571b175405fd1acaf76ad72b24","after":"8acdda48b061dfc65d06a9bdeb7918e46b0c4931dd4cdc9356d6aaf2b1bd9f49","attributed_before":"74d20c474d11f12ce15256154cd240b586b8f8571b175405fd1acaf76ad72b24","attributed_after":"8acdda48b061dfc65d06a9bdeb7918e46b0c4931dd4cdc9356d6aaf2b1bd9f49"},"scripts/forge-dispatch-source-guard.test.js":{"before":"08ad208ba8ad931fd10da328f923007743457e83b9eb76c6e4a11a626bd6bbed","after":"9241c279083c24f1e29efce9369eeea305e9b8f10086fce2934978837addb892","attributed_before":"08ad208ba8ad931fd10da328f923007743457e83b9eb76c6e4a11a626bd6bbed","attributed_after":"9241c279083c24f1e29efce9369eeea305e9b8f10086fce2934978837addb892"},"scripts/forge-incomplete-resume-distribution.test.js":{"before":"3a7a31078d88591214f1c4e86b300d323829f293058a9216e3a516aec97670a0","after":"6f9adcd3add89982a1fbb02c19ef320e6da191a8e51319ae88e9548228391195","attributed_before":"3a7a31078d88591214f1c4e86b300d323829f293058a9216e3a516aec97670a0","attributed_after":"6f9adcd3add89982a1fbb02c19ef320e6da191a8e51319ae88e9548228391195"},"scripts/forge-milestone-endpoint.test.js":{"before":"88c9751c86bb0416d242daacc1f1f7bd9041edb949d407242ff98c2adfa8fcfb","after":"4206951f30ce7be0ecd1044720d6263bfd8986709795e9cc161a255cbfd6d159","attributed_before":"88c9751c86bb0416d242daacc1f1f7bd9041edb949d407242ff98c2adfa8fcfb","attributed_after":"4206951f30ce7be0ecd1044720d6263bfd8986709795e9cc161a255cbfd6d159"}},PRIOR_PINS={"scripts/fixtures/incomplete-resume/distribution.cjs":"e935b65bc3b8b74cda036b9c64e463855dc32c8f1e5d9bcf92adb7b9f96fa190","scripts/fixtures/incomplete-resume/distribution-delta.json":"734c63c9e5f7d3986afddc82747bd90d8e5f66deaccd392de998820734a1bb18","scripts/fixtures/incomplete-resume/README.md":"aeed7a2a04699c13a1b8d87ffb46656068c8071137d448cd51daca6cb46988ec"};
const linked=/^<!-- forge:linked-task:([a-z0-9-]+):start -->\r?\n[\s\S]*?^<!-- forge:linked-task:\1:end -->\r?\n/gm;
const read=relative=>fs.readFileSync(path.join(ROOT,relative));
function projection(bytes,relative,value=terminal){
 const pins=ANCHORS[relative],row=value.sources[relative];
 if(!pins)return bytes;
 assert(row,'#375 missing declared source '+relative);
 assert.equal(hash(bytes),pins.after,'#375 exact current source '+relative);
 const prior=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'));
 assert.equal(hash(prior),pins.before,'#375 exact committed prior bytes '+relative);
 return prior;
}
function validateTerminal(readRaw,value){
 assert.deepEqual(Object.keys(value).sort(),['schema_version','issue','provenance','sources'].sort(),'#375 closed terminal shape');
 assert.equal(value.schema_version,1);assert.equal(value.issue,375);
 assert.deepEqual(value.provenance,{base_revision:'b0828ad687114e15db06c5bbd835e1191c4b2c7e',implementation_revision:'c55412a77052026fb85790465fd217d8fd73a240',
  previous_delta:'scripts/fixtures/incomplete-resume/distribution-delta.json',method:'Exact committed source375 and exact consumer/API delta; byte-reversible prior view; all historical validators retained.'});
 assert.deepEqual(Object.keys(value.sources),Object.keys(ANCHORS),'#375 exact declared sources');
 for(const[file,pin]of Object.entries(PRIOR_PINS))assert.equal(hash(readRaw(file)),pin,'#375 immutable historical fixture '+file);
 for(const[file,pins]of Object.entries(ANCHORS)){
  const row=value.sources[file];
  assert.deepEqual(Object.keys(row).sort(),['before','after','attributed_before','attributed_after','before_gzip_base64'].sort(),'#375 closed source row '+file);
  for(const field of ['before','after','attributed_before','attributed_after'])assert.equal(row[field],pins[field],'#375 independent committed/measured '+field+' '+file);
  const bytes=readRaw(file);assert.equal(hash(bytes),pins.after,'#375 measured current source '+file);
  assert.equal(hash(bytes.toString('utf8').replace(linked,'')),pins.attributed_after,'#375 measured attributed source '+file);
  const prior=projection(bytes,file,value);
  assert.equal(hash(prior.toString('utf8').replace(linked,'')),pins.attributed_before,'#375 exact attributed prior '+file);
 }
 const doc=readRaw('scripts/fixtures/interrupted-owner/README.md').toString('utf8');
 for(const pins of Object.values(ANCHORS))for(const key of ['before','after'])assert(doc.includes(pins[key]),'#375 documented source '+key);
 return true;
}
function after(kind,key,prior,attributed=false){
 const old=previous.after(kind,key,prior,attributed),row=ANCHORS[key];
 if(!row||!['files','sources','documents'].includes(kind))return old;
 assert.equal(old,row[attributed?'attributed_before':'before'],'#375 composed prior '+key);
 return row[attributed?'attributed_after':'after'];
}
function validate(options){
 const {artifacts,readRaw=read,terminalLayerValue=terminal,...rest}=options;
 validateTerminal(readRaw,terminalLayerValue);
 return previous.validate({artifacts,...rest,readRaw:relative=>projection(readRaw(relative),relative,terminalLayerValue)});
}
function readme(old){return previous.readme(old)+'\n'+read('scripts/fixtures/interrupted-owner/README.md').toString('utf8');}
module.exports={...previous,interruptionLayer:terminal,interruptionSources:Object.keys(ANCHORS),after,readme,validate};
