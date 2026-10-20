#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateCorpus, caseIdentity, classifyProvenance, validateShape, MAX_INPUT_BYTES } = require('./forge-empirical-corpus');
const { normalizeTarget, fingerprint } = require('./forge-autonomy-sources');
const fixturePath = path.join(__dirname, 'fixtures/empirical-corpus/contract/cases.json');
const matrix = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const schema = require('../shared/schemas/empirical-corpus.schema.json');
let assertions = 0;
function check(value, message) { assertions++; assert.ok(value, message); }
for (const row of matrix.cases) {
  const result = validateCorpus(row.corpus);
  check(result.valid === row.valid, `${row.name}: valid ${JSON.stringify(result.diagnostics)}`);
  check(result.ready === row.ready, `${row.name}: ready`);
  check(JSON.stringify(row.corpus) === JSON.stringify(JSON.parse(JSON.stringify(row.corpus))), 'fixture remains serializable');
}
const base = matrix.cases[0].corpus;
function mutate(edit) { const input = structuredClone(base); edit(input); return validateCorpus(input); }
function has(result, code) { check(result.diagnostics.some((d) => d.code === code), code); }
const complete = validateCorpus(base);
check(complete.counts.deliveries === 1 && complete.counts.files === 4 && complete.counts.revisions === 1, 'independent counts');
check(complete.authority.commands === false && complete.authority.network === false && complete.authority.additional_roots === false, 'no authority');
check(complete.agent_input_refs.join() === 'before', 'grader solution excluded');
check(base.candidates[0].metrics.cost.value === null && base.candidates[0].metrics.uat.value === null, 'missing metrics stay null');
const two = validateCorpus(matrix.cases.find((c) => c.name === 'two-revisions-one-delivery').corpus);
check(two.counts.candidates === 2 && two.counts.deliveries === 1 && two.counts.versions === 2 && two.counts.revisions === 2, 'version dedupe');
const distinct = validateCorpus(matrix.cases.find((c) => c.name === 'different-deliveries-identical-bytes').corpus);
check(distinct.counts.deliveries === 2, 'identical hashes do not merge deliveries');
const candidate = base.candidates[0];
const normalized = normalizeTarget(candidate.unit).target;
check(caseIdentity(candidate).delivery_id === `delivery:${fingerprint({origin:candidate.origin,unit:normalized,delivery_key:candidate.delivery_key})}`, 'canonical helper identity');
check(caseIdentity({...candidate,version:'v900',reopened:true,refs:[]}).case_id === candidate.case_id, 'stable identity');
check(caseIdentity({...candidate,unit:{type:'task',id:'T-20260101120001-other-change'}}).delivery_id !== candidate.delivery_id, 'unit isolation');
const component = validateCorpus(matrix.cases.find((c) => c.name === 'component-match-installation-unknown').corpus).provenance[0].claims;
check(component.component_match.state === 'observed' && component.installation_complete.state === 'unknown', 'no installation inference');
const conflict = validateCorpus(matrix.cases.find((c) => c.name === 'conflicting-declarations').corpus).provenance[0].claims;
check(conflict.declared_version.state === 'conflict' && conflict.declared_version.value === null, 'conflict retained');
const release = {kind:'release_exists',state:'observed',value:'fictional-1',refs:['before'],contemporaneous:true,limitations:[]};
check(classifyProvenance([release],base.references).declared_version.state === 'unknown', 'release does not declare version');
check(classifyProvenance([{...release,contemporaneous:false}],base.references).release_exists.state === 'unknown', 'noncontemporaneous evidence');
check(classifyProvenance([{...release,refs:['missing']}],base.references).release_exists.state === 'unknown', 'absent evidence');
has(validateCorpus('{broken'), 'json_malformed');
has(validateCorpus(' '.repeat(MAX_INPUT_BYTES+1)), 'input_too_large');
has(mutate((c)=>c.candidates[0].metrics.cost.value=0), 'unknown_value_not_null');
has(mutate((c)=>c.references[0].bytes=-1), 'field_minimum');
has(mutate((c)=>c.references[0].bytes='1'), 'field_type');
has(mutate((c)=>c.references[0].role='command'), 'field_enum');
has(mutate((c)=>c.references[0].captured_at='2026-01-01T12:00:00'), 'field_timestamp');
has(mutate((c)=>c.references[0].captured_at='2027-01-01T12:00:00Z'), 'reference_capture_future');
has(mutate((c)=>c.references[0].peg='HEAD'), 'reference_revision_invalid');
has(mutate((c)=>c.references.push({...c.references[0],bytes:99})), 'reference_conflict');
has(mutate((c)=>c.candidates[0].refs.push('unlisted')), 'reference_unknown');
has(mutate((c)=>c.candidates[0].delivery_id='forged'), 'identity_mismatch');
has(mutate((c)=>c.candidates.push(structuredClone(c.candidates[0]))), 'version_duplicate');
has(mutate((c)=>c.references[0].region='grader'), 'reference_region_mismatch');
has(mutate((c)=>delete c.references[0].sha256), 'reference_integrity_missing');
has(mutate((c)=>c.references[0].lineage=[]), 'reference_lineage_missing');
has(mutate((c)=>{c.exposure_registry=[{family_id:c.candidates[0].family_id,refs:['before'],purpose:'synthetic adjustment',captured_at:c.captured_at}];c.split_policy.reserved_families=[c.candidates[0].family_id];}), 'reserved_family_exposed');
check(!mutate((c)=>{c.references[0].role='unknown';c.references[0].region='unknown';}).ready, 'unknown role ineligible');
check(!mutate((c)=>c.candidates[0].refs=['before']).ready, 'coverage declaration insufficient without roles');
check(!mutate((c)=>c.candidates[0].selection='excluded').ready, 'empty selected population');
// Exercise every public schema definition using valid fixture plus actual schema-driven mutation.
function keywords(rule) { for(const [key,value] of Object.entries(rule)) { check(['$schema','$id','title','type','properties','required','additionalProperties','enum','minLength','minimum','pattern','format','items'].includes(key), `supported keyword ${key}`); if(key==='properties') Object.values(value).forEach(keywords); if(key==='items') keywords(value); } }
keywords(schema);
const shapeErrors=[];validateShape({...base,schema_version:2},schema,'$',shapeErrors);
check(shapeErrors.some((d)=>d.code==='field_enum'), 'public schema loaded and enforced');
const malformed = spawnSync(process.execPath,[path.join(__dirname,'forge-empirical-corpus.js'),fixturePath],{encoding:'utf8'});
check(malformed.status===1 && JSON.parse(malformed.stdout).valid===false, 'CLI validates declared corpus rather than fixture wrapper');
console.log(`empirical-corpus: ${assertions} assertions passed; ${matrix.cases.length} synthetic scenarios`);
