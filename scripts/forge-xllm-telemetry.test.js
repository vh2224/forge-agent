#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { normalizeDispatchId, buildPlanPrompt } = require('./forge-xllm.js');
const { countTokens } = require('./forge-tokens.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  process.stdout.write(`  ✓ ${name}\n`);
}

test('sidecar dispatch IDs are generated and collision-resistant in shape', () => {
  const first = normalizeDispatchId(null, 'execute');
  const second = normalizeDispatchId(null, 'execute');
  assert.match(first, /^xllm-execute-\d+-[a-f0-9]{10}$/);
  assert.notStrictEqual(first, second);
});

test('caller-provided safe dispatch ID round-trips exactly', () => {
  assert.strictEqual(normalizeDispatchId('execute-task-T03-a2', 'execute'), 'execute-task-T03-a2');
});

test('unsafe dispatch IDs are rejected before process creation', () => {
  assert.throws(() => normalizeDispatchId('../escape', 'plan'), /invalid --dispatch-id/);
  assert.throws(() => normalizeDispatchId('has space', 'plan'), /invalid --dispatch-id/);
});

test('sidecar input telemetry counts the actual built prompt', () => {
  const prompt = buildPlanPrompt('milestone context');
  assert(Number.isInteger(countTokens(prompt)) && countTokens(prompt) > 0);
});

async function testFailureIdentityReasonCodes(){
  const fs=require('fs'),path=require('path'),Module=require('module'),filename=require.resolve('./forge-xllm'),raw=fs.readFileSync(filename,'utf8'),copy=new Module(filename+'#failure-reason-data',module);copy.filename=filename;copy.paths=Module._nodeModulePaths(path.dirname(filename));
  copy._compile(raw.replace(/^#![^\n]*(?:\n|$)/,'')+'\nmodule.exports.__failureReasonTest={withSidecarIdentity,sidecarFailureReason};\n',filename);
  const api=copy.exports.__failureReasonTest,events=[];let coerced=0,getters=0;
  const codes=[{value:{toString(){coerced++;throw Error('no object coercion');}},message:'network connection failed',expected:'network'},
    {value:'fixture-known-code',message:'network',expected:'fixture-known-code'},
    {value:'private invalid code with spaces',message:'unclassified fixture failure',expected:'unknown'},
    {value:400,message:"The 'arbitrary-model-token' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",expected:'codex-client-upgrade-required'}];
  for(const row of codes){const error=Object.assign(Error(row.message),{code:row.value});await assert.rejects(api.withSidecarIdentity('execute',{engine:'codex',model:'fixture-model',effort:'medium',hostRuntime:'codex',announce:(stage,fields)=>events.push({stage,fields})},async()=>{throw error;}),caught=>caught===error);assert.strictEqual(events.at(-1).fields.reason_code,row.expected);assert.strictEqual(typeof events.at(-1).fields.reason_code,'string');}
  const error=Error('network connection failed');Object.defineProperty(error,'code',{get(){getters++;return{bad:true};}});assert.strictEqual(api.sidecarFailureReason(error),'network');assert.strictEqual(getters,0);assert.strictEqual(coerced,0);assert(!JSON.stringify(events).includes('[object Object]'));assert(!JSON.stringify(events).includes('private invalid'));
  const {classifyErrorClass,reviewFailureDiagnostic}=require('./forge-xllm'),client=require('./forge-appserver-client');assert.strictEqual(classifyErrorClass(client.APPSERVER_TERMINAL_MESSAGES.CLIENT_UPGRADE_REQUIRED),'terminal');assert.strictEqual(reviewFailureDiagnostic({code:'codex-client-upgrade-required'}).reason_code,'codex-client-upgrade-required');
}

testFailureIdentityReasonCodes().then(()=>{passed++;process.stdout.write(`\n${passed} passed, 0 failed\n`);}).catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
