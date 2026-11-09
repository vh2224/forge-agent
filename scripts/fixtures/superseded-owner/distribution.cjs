'use strict';
// Test-only next terminal: #375 and every preceding validator still execute.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../interrupted-owner/distribution.cjs'),terminal=require('./distribution-delta.json');
const ROOT=path.resolve(__dirname,'../../..'),SPEC={"provenance":{"base_revision":"bccfb723bee755f830e452d0b3e3dbcc6fb66025","previous_delta":"scripts/fixtures/interrupted-owner/distribution-delta.json","source_input_sha256":"1da4da5888a71380a49dd7752c7a033a576ffb744d39456c3a85139e0822d096","method":"Exact Gitbase before bytes and finalized LF source378; four genuine consumer imports; all historical validators retained. No implementation commit asserted."},"sources":{"docs/lifecycle-resume.md":{"before":"4eb7614bd28c557a184acc5e96364535b366118a5b6f4725a1f3c9e208290f36","after":"0d073cbfe70afcbdd9805f97166729784f2c4223fe16b66a1df922953bfb3f3a","attributed_before":"4eb7614bd28c557a184acc5e96364535b366118a5b6f4725a1f3c9e208290f36","attributed_after":"0d073cbfe70afcbdd9805f97166729784f2c4223fe16b66a1df922953bfb3f3a"},"scripts/forge-unit-controller.js":{"before":"4ee058cfb7447c7ab95cd083bcbc83e65492059ecf1401f449806bb22d38d598","after":"3058c2bce2b0f0df59db3e80366d2b404f47f3702a781e0cf7880421d905f38b","attributed_before":"4ee058cfb7447c7ab95cd083bcbc83e65492059ecf1401f449806bb22d38d598","attributed_after":"3058c2bce2b0f0df59db3e80366d2b404f47f3702a781e0cf7880421d905f38b"},"scripts/forge-unit-controller.test.js":{"before":"434b4c5ecbe18f12eb767a5929684e2e06bdfa49c9aa19675b1c62a22dfb1549","after":"b4cd44cc63aabf2d83144c5f1f8e3c7ccf6eeed8aaa1a17f21fdac2efeb2c18d","attributed_before":"434b4c5ecbe18f12eb767a5929684e2e06bdfa49c9aa19675b1c62a22dfb1549","attributed_after":"b4cd44cc63aabf2d83144c5f1f8e3c7ccf6eeed8aaa1a17f21fdac2efeb2c18d"},"scripts/forge-claude-renderer.test.js":{"before":"6b4c2f4b4d1ee6bd710a668a1c092fb85655b6e3c2a11556f972917e1de9d1db","after":"75e88bc78d5036cabcdb8326c7b4a800e052f15ae7c0197119c9b490b4e4a9c1","attributed_before":"6b4c2f4b4d1ee6bd710a668a1c092fb85655b6e3c2a11556f972917e1de9d1db","attributed_after":"75e88bc78d5036cabcdb8326c7b4a800e052f15ae7c0197119c9b490b4e4a9c1"},"scripts/forge-communication-surfaces.test.js":{"before":"8acdda48b061dfc65d06a9bdeb7918e46b0c4931dd4cdc9356d6aaf2b1bd9f49","after":"be0d621639404fb3adbb33ba7e4e5b1e707743cb7c2dd5d0edbdaa12923cb1de","attributed_before":"8acdda48b061dfc65d06a9bdeb7918e46b0c4931dd4cdc9356d6aaf2b1bd9f49","attributed_after":"be0d621639404fb3adbb33ba7e4e5b1e707743cb7c2dd5d0edbdaa12923cb1de"},"scripts/forge-dispatch-source-guard.test.js":{"before":"9241c279083c24f1e29efce9369eeea305e9b8f10086fce2934978837addb892","after":"3f364729b5ed46aa74892521d66b76e285756af8e41b4d174f6e856ade1bb745","attributed_before":"9241c279083c24f1e29efce9369eeea305e9b8f10086fce2934978837addb892","attributed_after":"3f364729b5ed46aa74892521d66b76e285756af8e41b4d174f6e856ade1bb745"},"scripts/forge-incomplete-resume-distribution.test.js":{"before":"6f9adcd3add89982a1fbb02c19ef320e6da191a8e51319ae88e9548228391195","after":"c8151fb843896bf16f40a36b6a465087bf2f71e0cc79fd21c3f297687050cc10","attributed_before":"6f9adcd3add89982a1fbb02c19ef320e6da191a8e51319ae88e9548228391195","attributed_after":"c8151fb843896bf16f40a36b6a465087bf2f71e0cc79fd21c3f297687050cc10"}},"prior_pins":{"scripts/fixtures/interrupted-owner/distribution.cjs":"67292aab1b36d807b42a208a6475f52128a106ea4e39f45e9a3fb11dbb9179d5","scripts/fixtures/interrupted-owner/distribution-delta.json":"68406c0485f49322540e63d76e294f610138b4c6fb9803bca008940e242a2528","scripts/fixtures/interrupted-owner/README.md":"ed8fbef081dcd13969ee3643ee79ce4ca26a0c1e0d9f891c0bf912563d960276","scripts/forge-milestone-endpoint.test.js":"4206951f30ce7be0ecd1044720d6263bfd8986709795e9cc161a255cbfd6d159"},"control_doc":{"file":"scripts/fixtures/superseded-owner/README.md","sha256":"ee378b4e92612cc2061191e9aae0caac45063a2546c8bc89249c0a11baae0539"}},hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const linked=/^<!-- forge:linked-task:([a-z0-9-]+):start -->\r?\n[\s\S]*?^<!-- forge:linked-task:\1:end -->\r?\n/gm;
const read=file=>fs.readFileSync(path.join(ROOT,file));
function projection(bytes,file,value=terminal){
 const pin=SPEC.sources[file];if(!pin)return bytes;const row=value.sources[file];assert(row,'#378 missing source '+file);
 assert.equal(hash(bytes),pin.after,'#378 exact current source '+file);
 const before=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});
 assert.equal(hash(before),pin.before,'#378 exact Gitbase preimage '+file);return before;
}
function validateTerminal(readRaw,value){
 assert.deepEqual(Object.keys(value).sort(),['schema_version','issue','provenance','sources','control_doc'].sort(),'#378 closed terminal');
 assert.equal(value.schema_version,1);assert.equal(value.issue,378);assert.deepEqual(value.provenance,SPEC.provenance,'#378 exact measured provenance');
 assert.deepEqual(Object.keys(value.sources),Object.keys(SPEC.sources),'#378 exact seven sources');assert.deepEqual(value.control_doc,SPEC.control_doc);
 for(const[file,pin]of Object.entries(SPEC.prior_pins))assert.equal(hash(readRaw(file)),pin,'#378 immutable prior fixture/endpoint '+file);
 for(const[file,pin]of Object.entries(SPEC.sources)){
  const row=value.sources[file];assert.deepEqual(Object.keys(row).sort(),['before','after','attributed_before','attributed_after','before_gzip_base64'].sort(),'#378 closed source '+file);
  for(const name of ['before','after','attributed_before','attributed_after'])assert.equal(row[name],pin[name],'#378 independent measured '+name+' '+file);
  const bytes=readRaw(file);assert.equal(hash(bytes),pin.after,'#378 measured current source '+file);assert.equal(hash(bytes.toString('utf8').replace(linked,'')),pin.attributed_after);
  assert.equal(hash(projection(bytes,file,value).toString('utf8').replace(linked,'')),pin.attributed_before);
 }
 const doc=readRaw(SPEC.control_doc.file);assert.equal(hash(doc),SPEC.control_doc.sha256,'#378 exact README');
 for(const row of Object.values(SPEC.sources))for(const field of ['before','after'])assert(doc.toString('utf8').includes(row[field]));return true;
}
function validate(options){
 const{artifacts,readRaw=read,supersededLayerValue=terminal,...rest}=options;let inheritedError;
 // Run prior metadata/negatives with the real reversible view, preserving their error contract.
 try{previous.validate({artifacts,...rest,readRaw:file=>projection(readRaw(file),file,supersededLayerValue)});}catch(error){inheritedError=error;}
 try{validateTerminal(readRaw,supersededLayerValue);}catch(error){if(inheritedError)throw inheritedError;throw error;}
 if(inheritedError)throw inheritedError;return true;
}
function after(kind,key,prior,attributed=false){
 const before=previous.after(kind,key,prior,attributed),row=SPEC.sources[key];if(!row||!['files','sources','documents'].includes(kind))return before;
 assert.equal(before,row[attributed?'attributed_before':'before'],'#378 exact composed prior '+key);return row[attributed?'attributed_after':'after'];
}
function readme(old){return previous.readme(old)+'\n'+read(SPEC.control_doc.file).toString('utf8');}
module.exports={...previous,supersededLayer:terminal,supersededSources:Object.keys(SPEC.sources),after,readme,validate};
