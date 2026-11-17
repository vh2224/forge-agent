'use strict';
const assert=require('node:assert/strict');
const {installImmutablePinCache}=require('./fixtures/ci-latency/immutable-pin-cache.cjs');
const counts={leaf:0,parent:0,validate:0};
const json={filename:'fixture.json',children:[],exports:JSON.parse('{"value":"pinned","nested":[1,2]}')};
const leaf={filename:'leaf/distribution.cjs',children:[json],exports:{
  after(kind,file,prior){counts.leaf++;return file==='__validate_ancestor_pins__'?'':prior+json.exports.value;},
  validate(value){counts.validate++;assert.equal(value.value,json.exports.value);return true;},
}};
const parent={filename:'parent/distribution.cjs',children:[leaf],exports:{
  after(...args){counts.parent++;leaf.exports.after('files','__validate_ancestor_pins__','');return leaf.exports.after(...args);},
}};
assert.deepEqual(installImmutablePinCache(parent),{enabled:true,layers:2});
assert(Object.isFrozen(json.exports)&&Object.isFrozen(json.exports.nested));
assert.throws(()=>{json.exports.value='tampered';},TypeError);
for(let i=0;i<100;i++)assert.equal(parent.exports.after('files','__validate_ancestor_pins__',''),'');
assert.deepEqual(counts,{leaf:1,parent:1,validate:0});
for(let i=0;i<2;i++)assert.equal(parent.exports.after('files','actual-source','before'),'beforepinned');
assert.deepEqual(counts,{leaf:3,parent:3,validate:0},'ordinary mappings are never memoized');
assert(leaf.exports.validate({value:'pinned'}));
assert.throws(()=>leaf.exports.validate({value:'tampered'}));assert.equal(counts.validate,2,'validation and negative inputs remain live');
const stable=leaf.exports.after;
leaf.exports.after=()=> 'changed';
assert.equal(parent.exports.after('files','__validate_ancestor_pins__',''),'changed','changed dependency invalidates a cached proof');
leaf.exports.after=stable;
assert.equal(parent.exports.after('files','__validate_ancestor_pins__',''),'');
const before=parent.exports.after;
installImmutablePinCache(parent);assert.equal(parent.exports.after,before,'reinstallation cannot stack wrappers');
let getterCalls=0;const unsafe={};Object.defineProperty(unsafe,'dynamic',{get(){getterCalls++;return 1;}});
const unsafeJson={filename:'unsafe.json',exports:unsafe,children:[]},unsafeLayer={filename:'unsafe/distribution.cjs',children:[unsafeJson],exports:{after:()=>''}};
const original=unsafeLayer.exports.after;
assert.deepEqual(installImmutablePinCache(unsafeLayer),{enabled:false,layers:0});assert.equal(unsafeLayer.exports.after,original);assert.equal(getterCalls,0);
console.log('PASS immutable sentinel proof cache; ordinary lookups, actual validation and negative controls remain live; dependency changes invalidate cache; accessors refuse optimization');
