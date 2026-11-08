'use strict';

// #348: the actual parser and the published --check gate reject product paths
// before a worker runs. No provider, prefs, claims or owner metadata are used.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const must = require('./forge-must-haves');
const roots = require('./forge-code-roots');
const base = fs.realpathSync.native(os.tmpdir());
const lab = fs.realpathSync.native(fs.mkdtempSync(path.join(base, 'forge-plan-paths-348-')));
const marker = 'owned-plan-protected-path-fixture';
fs.writeFileSync(path.join(lab, '.owner'), marker);
const alpha = path.join(lab, 'alpha'), beta = path.join(lab, 'beta');
fs.mkdirSync(alpha); fs.mkdirSync(beta);
const fields = ['writes[0]', 'expected_output[0]', 'artifacts[0].path', 'key_links[0].from', 'key_links[0].to'];
const variants = ['.gsd/report.md', '.GSD/report.md', 'docs/.gSd/report.md', '.git/config', 'docs\\.SvN\\entries', '.GsD\\milestones\\M001\\report.md'];
const literal = 'Preserve the literal .gsd/STATE.md and primary::.git/config in explanatory text.';
const quote = value => "'" + value.replace(/'/g, "''") + "'";
let serial = 0;

function plan(rooted, changedField, changedPath, objectWrite = false, omitWrites = false) {
  const qualify = value => rooted ? 'alpha::' + value : value;
  const values = Object.fromEntries(fields.map(field => [field, qualify('docs/report.md')]));
  if (changedField) values[changedField] = qualify(changedPath);
  const declarations = rooted ? ['roots_schema: 2', 'primary_root_id: alpha', 'code_roots:', '  - id: alpha', '    path: ' + quote(alpha), '    vcs: git', '  - id: beta', '    path: ' + quote(beta), '    vcs: git'] : [];
  const writeLines = omitWrites ? [] : objectWrite
    ? ['writes:', '  - root_id: alpha', '    path: ' + quote(changedField === 'writes[0]' ? changedPath : 'docs/report.md')]
    : ['writes:', '  - ' + quote(values['writes[0]'])];
  return ['---', ...declarations, 'depends: []', ...writeLines,
    'must_haves:', '  truths:', '    - ' + quote(literal), '  artifacts:',
    '    - path: ' + quote(values['artifacts[0].path']), '      provides: Documento verificavel', '      min_lines: 1',
    '  key_links:', '    - from: ' + quote(values['key_links[0].from']), '      to: ' + quote(values['key_links[0].to']), '      via: ' + quote(literal),
    'expected_output:', '  - ' + quote(values['expected_output[0]']), '---', '# Plano', '', literal, ''].join('\n');
}
function writePlan(content) {
  const file = path.join(lab, 'plan-' + (++serial) + '.md'); fs.writeFileSync(file, content); return file;
}
function cli(content) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'forge-must-haves.js'), '--check', writePlan(content)],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ifError(result.error); assert.equal(result.signal, null);
  return { status: result.status, data: JSON.parse(result.stdout), stderr: result.stderr };
}

try {
  // Establish the canonical refusal independently from the parser under test.
  for (const value of variants) assert.throws(() => roots.assertRelative(value), error => error.code === 'root-path-protected');
  for (const rooted of [false, true]) {
    for (const field of fields) {
      for (const value of variants) {
        assert.throws(() => must.parseMustHaves(plan(rooted, field, value)), error => {
          assert.equal(error.code, 'root-path-protected'); assert(error.message.includes(field)); return true;
        }, (rooted ? 'v2' : 'v1') + ' accepts protected ' + field + ': ' + value);
      }
      const checked = cli(plan(rooted, field, variants.at(-1)));
      assert.equal(checked.status, 2); assert.equal(checked.data.legacy, false); assert.equal(checked.data.valid, false);
      assert(checked.data.errors.some(message => message.includes('root-path-protected') && message.includes(field)));
      assert.equal(checked.stderr, '');
    }
    console.log('PASS #348 ' + (rooted ? 'v2 qualified' : 'v1') + ' parser and actual CLI reject all five protected path fields with case/separator variants');
  }
  assert.throws(() => must.parseMustHaves(plan(true, 'writes[0]', 'docs/.gsd/report.md', true)), error => error.code === 'root-path-protected' && error.message.includes('writes[0]'));
  assert.equal(must.parseExecutionFields(plan(true, null, null, true)).writes[0].root_id, 'alpha');
  must.parseMustHaves(plan(true, null, null, true));

  for (const rooted of [false, true]) {
    const content = plan(rooted), parsed = must.parseMustHaves(content), execution = must.parseExecutionFields(content);
    assert.deepEqual(parsed.truths, [literal]); assert.equal(parsed.key_links[0].via, literal);
    assert.equal(parsed.artifacts[0].path, rooted ? 'alpha::docs/report.md' : 'docs/report.md');
    if (rooted) assert.deepEqual(execution.code_roots.map(root => root.path), [alpha, beta]);
    const checked = cli(content); assert.equal(checked.status, 0); assert.equal(checked.data.valid, true);
    const contract = { primary_root_id: 'alpha', code_roots: [{ id: 'alpha', path: alpha }, ...(rooted ? [{ id: 'beta', path: beta }] : [])] };
    const resolved = roots.resolvePath(contract, parsed.artifacts[0].path, { legacy: !rooted });
    assert.equal(resolved.root_id, 'alpha'); assert.equal(resolved.absolute, path.join(alpha, 'docs', 'report.md'));
    const glob = must.parseMustHaves(content.replace(/docs\/report\.md/g, 'docs/**'));
    assert.equal(glob.artifacts[0].path, rooted ? 'alpha::docs/**' : 'docs/**');
  }
  must.parseMustHaves(plan(false, null, null, false, true));
  const legacy = cli('# Legacy plan\n\nDeliverable description: .gsd/STATE.md\n');
  assert.equal(legacy.status, 0); assert.deepEqual(legacy.data, { legacy: true, valid: true, errors: [] });
  console.log('PASS #348 docs paths, object writes, root declarations, globs, absent optional writes, literal truths/via and legacy gate remain compatible');

  const validFile = writePlan(plan(false)), badFile = writePlan(plan(false, 'artifacts[0].path', '.gsd/report.md'));
  for (const first of ['forge-must-haves.js', 'forge-code-roots.js']) {
    const script = "require(process.argv[1]);const assert=require('assert/strict'),fs=require('fs');const must=require(process.argv[2]);must.parseMustHaves(fs.readFileSync(process.argv[3],'utf8'));assert.throws(()=>must.parseMustHaves(fs.readFileSync(process.argv[4],'utf8')),error=>error.code==='root-path-protected');";
    const result = spawnSync(process.execPath, ['--trace-warnings', '-e', script, path.join(__dirname, first), path.join(__dirname, 'forge-must-haves.js'), validFile, badFile],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  }
  console.log('PASS #348 both fresh-process module load orders retain canonical parser/path exports without circular dependency warnings');
} finally {
  assert.equal(fs.realpathSync.native(lab), lab);
  assert.equal(path.dirname(lab), base);
  assert.equal(fs.readFileSync(path.join(lab, '.owner'), 'utf8'), marker);
  fs.rmSync(lab, { recursive: true });
}
