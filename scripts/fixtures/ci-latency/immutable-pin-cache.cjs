'use strict';
// Historical layers recursively recheck the same ancestor sentinel twice.
// Snapshot their JSON defaults and memoize ONLY an unchanged sentinel proof.
// validate(), raw-source reads and caller-supplied negative fixtures stay live.
const installed = new WeakMap();
function installImmutablePinCache(root) {
  const modules=[], visited=new Set(), objects=new Set(), active=new Set();
  function visit(module) {
    if (!module || visited.has(module)) return;
    visited.add(module);modules.push(module);
    for (const child of module.children || []) visit(child);
  }
  function plainData(value) {
    if (value === null || ['string','number','boolean'].includes(typeof value)) return true;
    if (typeof value !== 'object' || active.has(value)) return false;
    if (objects.has(value)) return true;
    const prototype=Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== Array.prototype) return false;
    active.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const property=Object.getOwnPropertyDescriptor(value,key);
      if (typeof key !== 'string' || !Object.hasOwn(property,'value') || !plainData(property.value)) return false;
    }
    active.delete(value);objects.add(value);return true;
  }
  visit(root);
  const json=modules.filter(module=>module.filename && module.filename.endsWith('.json'));
  if (!json.length || !json.every(module=>plainData(module.exports))) return {enabled:false,layers:0};
  // Exported defaults are deliberately mutated by negative-control tests.
  // Preserve that contract and invalidate the proof before any changed graph
  // reaches a cached sentinel. Descriptors avoid invoking injected accessors.
  const snapshots=[...objects].map(value=>({value,prototype:Object.getPrototypeOf(value),
    entries:Reflect.ownKeys(value).map(key=>[key,Object.getOwnPropertyDescriptor(value,key).value])}));
  const exports=json.map(module=>[module,module.exports]);
  function unchanged() {
    if (!exports.every(([module,value])=>module.exports===value)) return false;
    return snapshots.every(({value,prototype,entries})=>Object.getPrototypeOf(value)===prototype
      && Reflect.ownKeys(value).length===entries.length
      && entries.every(([key,expected])=>{
        const descriptor=Object.getOwnPropertyDescriptor(value,key);
        return descriptor && Object.hasOwn(descriptor,'value') && Object.is(descriptor.value,expected);
      }));
  }
  let depth=0,graphStable=false;
  const states=[];
  for (const module of modules) {
    if (!module.exports || typeof module.exports.after !== 'function') continue;
    const prior=installed.get(module);
    if (prior) { states.push(prior);continue; }
    const original=module.exports.after,state={module,wrapper:null};
    const memo=new Map();
    function after(kind,file,previous,attributed=false) {
      if (depth===0) graphStable=unchanged();
      depth++;
      try {
      const sentinel=kind==='files' && file==='__validate_ancestor_pins__' && previous===''
        && typeof attributed==='boolean' && arguments.length<=4;
      const stable=sentinel && graphStable && states.every(item=>item.module.exports.after===item.wrapper);
      if (stable && memo.has(attributed)) return memo.get(attributed);
      const result=Reflect.apply(original,this,arguments);
      if (stable) memo.set(attributed,result);
      return result;
      } finally { depth--; }
    }
    state.wrapper=after;
    if (!Object.getOwnPropertyDescriptor(module.exports,'after')?.writable) { state.wrapper=original;states.push(state);continue; }
    states.push(state);module.exports.after=after;installed.set(module,state);
  }
  return {enabled:true,layers:states.length};
}
module.exports={installImmutablePinCache};
