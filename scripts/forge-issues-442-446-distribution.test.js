'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const layer=require('./fixtures/issues-457-458/distribution.cjs'),parent=require('./fixtures/issues-457-458/distribution.cjs').loadHistoricalFixture('scripts/fixtures/issue-439/distribution.cjs'),root=path.resolve(__dirname,'..');
const artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts;
assert.equal(layer.validate({artifacts}),true);assert.equal(layer.validate414Snapshot({artifacts}),true);
for(const file of ['scripts/forge-owner-window-recovery.js','scripts/forge-milestone-time-clock.js','scripts/forge-review-emit.js']){const readRaw=relative=>{const bytes=fs.readFileSync(path.join(root,relative));return relative===file?Buffer.concat([bytes,Buffer.from('\n// fault')]):bytes;};assert.throws(()=>layer.validate({artifacts,readRaw}),'changed-source drift '+file);}
const changed=structuredClone(layer.issues442446Layer);changed.provenance.issues=[];assert.throws(()=>layer.validate({artifacts,issues442446LayerValue:changed}),/independent measured delta/);
assert.equal(layer.issue439Layer,parent.issue439Layer,'published predecessor exported unchanged');
assert(layer.readme('').includes(layer.issues442446Layer.surfaces.skills.after),'current README records measured surface');
const current=fs.readFileSync(path.join(root,'docs/communication-evaluation/samples.json'),'utf8');assert.equal(layer.previousSamples(current),parent.previousSamples(require('node:zlib').gunzipSync(Buffer.from(layer.issues442446Layer.files['docs/communication-evaluation/samples.json'].before_gzip_base64,'base64')).toString('utf8')));
console.log('PASS issue batch successor: exact source/rendered projection, drift negatives, immutable predecessor and sample bytes');
