'use strict';

// Advisory inspection of selected routes. Never repairs prefs or walks a chain.
const {ARTIFACT_UNITS,READONLY_CONTEXT_REASON}=require('./forge-transport-capabilities');
const {isSafeModelId}=require('./forge-sidecar-diagnostic');
function checkArtifactRouting(cwd,options={}){
 const hosts=options.runtime==='both'?['claude','codex']:['claude','codex'].includes(options.runtime)?[options.runtime]:[];
 if(!hosts.length)return{ok:true,verdict:'inconclusive',inspected:0,incompatible:[],unresolved:[],skipped:'runtime-required',message:'Informe --runtime claude|codex para avaliar as rotas de artefato do host atual.'};
 const incompatible=[],unresolved=[];let inspected=0;
 for(const host of hosts)for(const unitType of ARTIFACT_UNITS){
  let route;try{route=require('./forge-dispatch-resolve').resolveDispatch({cwd,unitType,hostRuntime:host});}catch{route=null;}
  inspected++;
  if(!route||route.prefs_ok!==true||route.config_ok!==true||!isSafeModelId(route.model_resolved)){unresolved.push({host,unit_type:unitType,reason_code:'artifact-routing-unmeasured'});continue;}
  if(route.dispatch_allowed===false&&route.dispatch_reason_code===READONLY_CONTEXT_REASON){
   incompatible.push({host,unit_type:unitType,reason_code:READONLY_CONTEXT_REASON,model_resolved:route.model_resolved,tier:route.tier,
    route_source:route.route_source,profile:route.artifact_admission?.profile,hint:route.dispatch_hint});
  }else if(route.dispatch_allowed!==true){unresolved.push({host,unit_type:unitType,reason_code:'artifact-routing-unmeasured'});}
 }
 const verdict=incompatible.length?'incompatible':unresolved.length?'inconclusive':'compatible';
 return{ok:true,verdict,domain:'default',inspected,incompatible,unresolved,message:`Rotas de artefato no domínio default: ${incompatible.length} incompatíveis e ${unresolved.length} não comprovadas em ${inspected} inspeções. `
  +(incompatible.length?'Configure as células routing por unidade indicadas no JSON; nenhum modelo foi substituído.':'A inspeção não prova invocação nem disponibilidade do provedor.')};
}
module.exports={checkArtifactRouting};
