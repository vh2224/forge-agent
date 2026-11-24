'use strict';

// Reconciliation census only: never replace a preparation execution contract.
const roots=require('./forge-code-roots'),isolation=require('./forge-isolation');
function fail(){throw Object.assign(new Error('owner-window-code-roots-unmeasured'),{code:'owner-window-code-roots-unmeasured'});}
function measure({owner,contract,run}){
 const registered=run.worktrees===undefined?[]:run.worktrees;
 if(!Array.isArray(registered)||registered.length>14)fail();
 const measured=new Map(contract.code_roots.map(root=>[roots.key(root.path),root])),targets=new Set(),bindings=[];
 for(const entry of registered){
  if(!entry||typeof entry.repo!=='string'||typeof entry.path!=='string'||typeof run.branch!=='string'||!run.branch)fail();
  let repo,worktree;
  try{
   repo=roots.measureRoot({id:'repository-'+roots.digest(entry.repo).slice(0,16),path:entry.repo});
   worktree=roots.measureRoot({id:'worktree-'+roots.digest(entry.path).slice(0,16),path:entry.path});
  }catch{fail();}
  const repositoryKey=roots.key(repo.path),worktreeKey=roots.key(worktree.path);
  const repositoryDeclared=contract.code_roots.some(root=>roots.key(root.path)===repositoryKey);
  const isolatedDeclared=contract.code_roots.some(root=>roots.key(root.path)===worktreeKey)&&repositoryKey===roots.key(owner);
  if(repositoryKey===worktreeKey||targets.has(worktreeKey)||!repositoryDeclared&&!isolatedDeclared
    ||!isolation.validateWorktreeIdentity(repo.path,worktree.path,run.branch).ok)fail();
  targets.add(worktreeKey);
  if(!measured.has(repositoryKey))measured.set(repositoryKey,repo);
  if(!measured.has(worktreeKey))measured.set(worktreeKey,worktree);
  bindings.push({repo:repo.path,path:worktree.path,branch:run.branch,repository_identity_sha256:repo.identity_sha256,worktree_identity_sha256:worktree.identity_sha256});
 }
 // At most14 declared roots and two measured checkouts per registered pair.
 if(measured.size>42||new Set([...measured.values()].map(root=>root.id)).size!==measured.size)fail();
 return{roots:[...measured.values()],bindings:bindings.sort((a,b)=>roots.key(a.path).localeCompare(roots.key(b.path)))};
}
module.exports={measure};
