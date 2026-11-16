'use strict';
// Additive measured successor: retain every historical validator and pin.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib'),assert=require('node:assert/strict');
const previous=require('../issue-407/distribution.cjs'),data=require('./distribution-delta.json');
const ROOT=path.resolve(__dirname,'../../..'),PIN='81504ea65d67c0732369051b798937bd0051262a2ebd2c31978500775a9a8a5b';
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const read=file=>fs.readFileSync(path.join(ROOT,file));
const normalize=text=>String(text).replace(/version=\d+\.\d+\.\d+/g,'version=<dynamic>');
const linked=/^<!-- forge:linked-task:([a-z0-9-]+):start -->\r?\n[\s\S]*?^<!-- forge:linked-task:\1:end -->\r?\n/gm;
const attributed=bytes=>hash(bytes.toString('utf8').replace(linked,''));
const key=item=>item.source_id+'::'+item.source;
function check(value=data){assert.equal(hash(JSON.stringify(value)),PIN,'campaign independent measured delta');assert.equal(hash(JSON.stringify(previous.issue407Layer)),value.predecessor_layer_sha256,'campaign independent measured delta predecessor');previous.after('files','__validate_ancestor_pins__','');return value;}
function before(row){const bytes=zlib.gunzipSync(Buffer.from(row.before_gzip_base64,'base64'),{maxOutputLength:4*1024*1024});assert.equal(hash(bytes),row.before,'campaign exact predecessor bytes');return bytes;}
function validate(options){
 const value=check(options.integrationLayerValue||data),readRaw=options.readRaw||read;
 const projected=[];
 for(const item of options.artifacts){const row=value.rendered[key(item)];if(!row){projected.push(item);continue;}
  assert.equal(hash(normalize(item.content)),row.after,'campaign measured rendered source '+item.source);
  if(row.before===null)continue;
  const content=before(row).toString('utf8');projected.push({...item,content,...(Object.hasOwn(item,'bytes')?{bytes:Buffer.byteLength(content)}:{})});
 }
 const valid=previous.validate({...options,artifacts:projected,readRaw:file=>{
  const row=value.files[file],actual=readRaw(file);return row&&row.before!==null&&hash(actual)===row.after?before(row):actual;
 }});
 for(const[file,row]of Object.entries(value.files))assert.equal(hash(readRaw(file)),row.after,'campaign measured current source '+file);
 return valid;
}
function after(kind,file,prior,attr=false){check();const old=previous.after(kind,file,prior,attr),row=kind==='surfaces'?data.surfaces[file]:data.files[file];
 if(!row||row.before===null)return old;assert.equal(old,row[attr?'attributed_before':'before'],'campaign predecessor '+file);return row[attr?'attributed_after':'after'];}
function projectGolden(golden){check();const old=previous.projectGolden(golden);return{...old,surfaces:old.surfaces.map(row=>{const pin=data.surfaces[row.source_id];if(!pin)return row;assert.equal(row.sha256,pin.before);return{...row,sha256:pin.after};})};}
function sampleAfter(pointer,prior){check();const old=previous.sampleAfter(pointer,prior),row=data.samples?.find(r=>r.pointer===pointer||r.pointer+'/source/sha256'===pointer);if(!row)return old;assert.equal(old,row.before,'campaign exact sample predecessor '+pointer);return row.after;}
function previousSamples(text){check();const row=data.files['docs/communication-evaluation/samples.json'];if(!row)return previous.previousSamples(text);assert.equal(hash(text),row.after,'campaign exact current samples');return previous.previousSamples(before(row).toString('utf8'));}
function currentSmoke(text){const row=check().files['scripts/forge-smoke.js'];if(!row)return text;assert.equal(hash(text),row.after,'unrecognized smoke changes: exact407 measured source');return before(row).toString('utf8');}
function predecessorSmoke(text){return previous.predecessorSmoke(currentSmoke(text));}
function previousSmoke(text){return previous.previousSmoke(currentSmoke(text));}
function readme(old){return previous.readme(old)+'\n'+read('scripts/fixtures/issues-403-407-integration/README.md').toString('utf8');}
module.exports={...previous,validate,after,projectGolden,readme,sampleAfter,previousSamples,previousSmoke,predecessorSmoke,
 files:[...new Set([...previous.files,...Object.keys(data.rendered).map(key=>key.slice(key.indexOf('::')+2))])],integrationLayer:data};
