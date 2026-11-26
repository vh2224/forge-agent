'use strict';
const issue463SourceConsumer = require('./fixtures/issue-463/distribution.cjs');
issue463SourceConsumer.validateSourceConsumer(() => {

const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
const root=path.resolve(__dirname,'..'),successor=require('./fixtures/issue-463/distribution.cjs'),layer=successor.issues451452View,previous=require('./fixtures/issue-463/distribution.cjs').loadHistoricalFixture('scripts/fixtures/issue-440/distribution.cjs'),data=layer.issues451452Layer;
const read=successor.issue455View.projectRead(file=>fs.readFileSync(path.join(root,file))),hash=b=>crypto.createHash('sha256').update(b).digest('hex');

// Render only for a selected validator cohort. This memoizes renderer output,
// never a validator result; direct execution retains the original one render.
let artifacts;
function renderedArtifacts() {
  if (artifacts === undefined) { artifacts=require('./forge-claude-renderer').render({repo:root,projectRoot:root,claudeHome:path.join(root,'unused-host'),forgeHome:path.join(root,'unused-core')}).artifacts; }
  return artifacts;
}

const measuredFiles = Object.entries(data.files);
assert.equal(measuredFiles.length, 48);
const negativeGroups = Array.from({ length: 8 }, (_, group) =>
  measuredFiles.filter((_, index) => index % 8 === group));
assert(negativeGroups.every(group => group.length === 6));
assert.deepEqual(negativeGroups.flat().map(([file]) => file).sort(),
  measuredFiles.map(([file]) => file).sort(), 'all 48 drift negatives assigned exactly once');

const CASES = [
  { name: 'structural-projection-and-published-bytes', fn() {
    assert.equal(data.provenance.base_revision,'0fa00e3de485bd23a6a351d033d8aa8c8021fb25');assert.deepEqual(data.provenance.issues,[442,451,452,454]);assert.equal(data.predecessor_layer_sha256,hash(JSON.stringify(previous.issue440Layer)));assert.strictEqual(layer.issue440Layer,previous.issue440Layer);
    assert.equal(data.provenance.source_paths.length,22);assert.equal(data.provenance.consumer_paths.length,25);assert.equal(data.provenance.write_paths.length,51);assert.equal(Object.keys(data.files).length,48);assert.equal(Object.keys(data.historical_fixtures).length,215);
    assert.equal(hash(Object.keys(data.historical_fixtures).sort().join('\n')+'\n'),data.provenance.historical_list_sha256);for(const p of data.provenance.own_unmeasured_paths)assert(!Object.hasOwn(data.files,p));
    const projected = layer.projectRead();
    let existing = 0, created = 0;
    const newSources = new Set(['scripts/fixtures/issues-451-452/README.md',
      'scripts/forge-protected-owner-activity.test.js',
      'scripts/forge-legacy-preparation-retirement.js',
      'scripts/forge-legacy-preparation-retirement.test.js']);
    for (const [file, row] of measuredFiles) {
      assert.equal(hash(read(file)), row.after);
      if (row.before === null) {
        created++;
        assert(newSources.has(file));
        assert.equal(row.before_gzip_base64, null);
        assert.equal(row.attributed_before, null);
        assert(projected(file).equals(read(file)), 'new source is never rewound ' + file);
      } else {
        existing++;
        const before = zlib.gunzipSync(Buffer.from(row.before_gzip_base64, 'base64'));
        assert.equal(hash(before), row.before);
        assert(projected(file).equals(before), 'exact roundtrip ' + file);
      }
    }
    assert.equal(existing, 44);
    assert.equal(created, 4);
    for(const[file,row]of Object.entries(data.historical_fixtures)){const b=read(file);assert.equal(hash(b),row.sha256,'all published bytes remain exact '+file);assert.equal(b.length,row.bytes);}
    const oldRequire='./fixtures/issue-440/distribution.cjs',newRequire='./fixtures/issues-451-452/distribution.cjs',special='scripts/forge-issue-440-distribution.test.js';for(const file of data.provenance.consumer_paths){const b=zlib.gunzipSync(Buffer.from(data.files[file].before_gzip_base64,'base64')).toString('utf8');if(file===special){const a="const layer=require('./fixtures/issue-440/distribution.cjs'),parent=require('./fixtures/issue-448/distribution.cjs');",v="const successor=require('./fixtures/issues-451-452/distribution.cjs'),layer=successor.issue440View,parent=require('./fixtures/issue-448/distribution.cjs');",r='const read=file=>fs.readFileSync(path.join(root,file));',s='const read=successor.projectRead(file=>fs.readFileSync(path.join(root,file)));';assert.equal(b.split(a).length,2);assert.equal(b.split(r).length,2);assert.equal(read(file).toString('utf8'),b.replace(a,v).replace(r,s),'only two declared published440 test adapters');}else{assert.equal(b.split(oldRequire).length,2);assert.equal(read(file).toString('utf8'),b.replace(oldRequire,newRequire),'exact require-only migration '+file);}}
    assert.equal(Object.keys(data.provenance.historical_read_adapters).length,3);for(const[file,row]of Object.entries(data.provenance.historical_read_adapters)){const before=zlib.gunzipSync(Buffer.from(data.files[file].before_gzip_base64,'base64')).toString('utf8');assert.equal(before.split(row.before).length,2);assert.equal(read(file).toString('utf8'),before.replace(row.before,row.after),'exact historical changelog read adapter '+file);}
    const smokeFile='scripts/forge-smoke.js',smokeNow=read(smokeFile).toString('utf8'),smokeBefore=zlib.gunzipSync(Buffer.from(data.files[smokeFile].before_gzip_base64,'base64')).toString('utf8');for(const method of ['previousSmoke','predecessorSmoke']){assert.equal(layer[method](smokeNow),previous[method](smokeBefore));assert.equal(layer[method](smokeBefore),previous[method](smokeBefore));assert.throws(()=>layer[method](smokeNow+'\n// foreign drift\n'),/unrecognized smoke changes/);}
    for(const key of ['rendered','surfaces','samples','sample_projection','registry','parity'])assert.deepStrictEqual(layer.issue440Layer[key],previous.issue440Layer[key]);
  } },
  { name: 'full-validate-and-forged-metadata-refusal', fn() {
    const artifacts = renderedArtifacts();
    const method = 'validate', saved = previous[method];
    let parentCalls = 0;
    try {
      previous[method] = (...args) => { parentCalls++; return saved(...args); };
      assert.equal(layer[method]({ artifacts }), true);
    } finally { previous[method] = saved; }
    assert.equal(parentCalls, 1, 'one complete predecessor traversal for validate');
    const forged=structuredClone(data);forged.provenance.issues=[];assert.throws(()=>layer.validate({artifacts,issues451452LayerValue:forged}),/independent measured delta/);
  } },
  { name: 'full-validate414Snapshot', fn() {
    const artifacts = renderedArtifacts();
    const method = 'validate414Snapshot', saved = previous[method];
    let parentCalls = 0;
    try {
      previous[method] = (...args) => { parentCalls++; return saved(...args); };
      assert.equal(layer[method]({ artifacts }), true);
    } finally { previous[method] = saved; }
    assert.equal(parentCalls, 1, 'one complete predecessor traversal for validate414Snapshot');
  } },
  ...negativeGroups.map((files, group) => ({
    name: 'measured-source-drift-negatives-' + (group + 1) + '-of-8',
    fn() {
      for (const [file] of files) {
        const foreign = Buffer.concat([read(file), Buffer.from('\n// unmeasured foreign drift\n')]);
        const readRaw = path => path === file ? foreign : read(path);
        assert(layer.projectRead(readRaw)(file).equals(foreign), 'foreign bytes are never projected ' + file);
        assert.throws(() => layer.verifyCurrent({ readRaw }), /issues451452 measured current source/,
          'every measured source retains a strict census ' + file);
      }
    },
  })),
  { name: 'current-census-and-published-view-validators', fn() {
    const artifacts = renderedArtifacts();
    assert.equal(layer.verifyCurrent(), true);
    const historical='scripts/fixtures/issue-440/distribution-delta.json';assert.throws(()=>layer.verifyCurrent({readRaw:file=>file===historical?Buffer.concat([read(file),Buffer.from(' ') ]):read(file)}),/immutable published fixture/);
    // Preserve both the original published-view negative and full positive.
    const target='scripts/forge-unit-sidecar.js',readPublished=layer.projectRead();assert.throws(()=>layer.issue440View.validate({artifacts,readRaw:file=>file===target?Buffer.concat([readPublished(file),Buffer.from('\nforeign\n')]):readPublished(file)}));assert.equal(layer.issue440View.validate({artifacts}),true);
  } },
];

assert.equal(CASES.length, 12);
const selected = require('./forge-ci-units').selectCases(CASES);
for (const { fn } of selected) fn();
if (selected.length === CASES.length) {
  console.log('PASS #451/#452 measured successor: source_sha256, consumers25(24 require-only + published440 view), scope51, published215 exact; real validate/validate414, all48 measured-source drift negatives and foreign projection refusal');
} else {
  console.log('PASS #451/#452 selected cohorts: ' + selected.map(row => row.name).join(', '));
}
});
