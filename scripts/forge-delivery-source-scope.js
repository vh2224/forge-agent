'use strict';
// Read-only expansion against the captured Git tree + captured dirty overlay.
// Current proof additionally checks today's VCS-visible universe. Ignored
// dependencies are excluded only by a captured, bound root .gitignore rule.
const { git }=require('./forge-git-process');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const isGlob=value=>/[*?]/.test(value);
function valid(value){if(typeof value!=='string'||value.length>1024||/[\\\x00-\x1f:]/.test(value)||value.split('/').some(p=>!p||p==='.'||p==='..'))fail('delivery-source-scope-invalid');return value;}
function command(root,args){try{return git(root,args,{maxBuffer:4*1024*1024,timeout:10000,env:{GIT_OPTIONAL_LOCKS:'0',GIT_NO_REPLACE_OBJECTS:'1'}});}catch{fail('delivery-source-inventory-unreadable');}}
function expand(root,envelope,scope,{current=false}={}){
 const patterns=scope.filter(isGlob);if(!patterns.length)return{paths:scope,globs:[]};scope.forEach(valid);
 if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(envelope.revision||''))fail('delivery-source-inventory-unreadable');
 const tree=new Map();for(const line of command(root,['ls-tree','-r','-z',envelope.revision]).split('\0').filter(Boolean)){
  const m=/^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);if(!m)fail('delivery-source-inventory-unreadable');valid(m[4]);tree.set(m[4],{mode:m[1],hash:m[3]});if(tree.size>65536)fail('delivery-source-inventory-limit');
 }
 for(const row of envelope.workspace||[]){valid(row.path);if(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.hash||''))tree.set(row.path,{mode:'100644',hash:row.hash});else tree.delete(row.path);}
 let visible;if(current){visible=new Set(command(root,['ls-files','-z','--cached','--others','--exclude-standard']).split('\0').filter(Boolean));if(visible.size>65536)fail('delivery-source-inventory-limit');visible.forEach(valid);}
 const paths=new Set(scope.filter(p=>!isGlob(p))),globs=[];
 const installArtifact=require('./forge-surgical-reset').isInstallArtifactPath;
 for(const pattern of patterns){const matcher=require('./forge-parallelism').globToRegex(pattern),matched=[...tree.keys()].filter(p=>matcher.test(p)).sort();
  // The snapshot's established exclusion concerns untracked install products,
  // not arbitrary ignored source. Inventory ignored source under the fixed
  // prefix too; it must have an explicit captured binding or proof refuses.
  if(!installArtifact(pattern)&&current){
   const prefix=pattern.slice(0,pattern.search(/[*?]/)).replace(/[^/]*$/,'');
   const ignored=command(root,['ls-files','-z','--others','--ignored','--exclude-standard','--',':(literal)'+(prefix||'.')]).split('\0').filter(Boolean);
   if(ignored.length>65536)fail('delivery-source-inventory-limit');
   for(const p of ignored){valid(p);if(matcher.test(p)&&!installArtifact(p)){
    if(!tree.has(p))fail('delivery-source-ignored-unproven');if(current)visible.add(p);
   }}
  }
  if(!installArtifact(pattern)&&tree.has('.gitignore')){
   // History cannot consult today's ignored files. Refuse a captured source
   // ignore rule that might hide this declaration; literal directory rules
   // outside the scope are provably irrelevant. Wildcard/negation semantics
   // are not guessed. Binding the policy also detects current policy changes.
   const rules=command(root,['cat-file','blob',tree.get('.gitignore').hash]).split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
   for(const rule of rules){if(installArtifact(rule))continue;
    if(/[!*?\[\]\\]/.test(rule))fail('delivery-source-ignore-ambiguous');
    const simple=rule.replace(/^\//,'').replace(/\/$/,'');valid(simple);
    if([simple,simple+'/**'].some(other=>require('./forge-parallelism').pathsOverlap(pattern,other)))fail('delivery-source-ignored-unproven');
   }paths.add('.gitignore');
  }
  if(matched.some(p=>!/^100(?:644|755)$/.test(tree.get(p).mode)))fail('delivery-source-scope-linked');
  if(current){const now=[...visible].filter(p=>matcher.test(p)).sort();if(JSON.stringify(now)!==JSON.stringify(matched))fail('delivery-current-source-changed');}
  if(!matched.length){
   // Only a fixed directory subtree can be wholly excluded this way. A
   // captured negation makes that proof ambiguous and is deliberately refused.
   const prefix=/^([^*?]+)\/\*\*$/.exec(pattern)?.[1],ignore=tree.get('.gitignore');
   if(!prefix||!ignore||!installArtifact(pattern))fail('delivery-source-glob-unproven');
   const lines=command(root,['cat-file','blob',ignore.hash]).split(/\r?\n/).map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
   if(lines.some(l=>l.startsWith('!'))||!lines.some(l=>[prefix,prefix+'/', '/'+prefix,'/'+prefix+'/'].includes(l)))fail('delivery-source-glob-unproven');
   paths.add('.gitignore');globs.push({pattern,status:'ignored-by-captured-root-rule',sources:[]});
  }else{matched.forEach(p=>paths.add(p));globs.push({pattern,status:'captured',sources:matched});}
 }
 if(paths.size>256)fail('delivery-source-inventory-limit');return{paths:[...paths].sort(),globs};
}
module.exports={expand,isGlob};
