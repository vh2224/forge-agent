#!/usr/bin/env node
'use strict';

// Standalone round-trip contract for the cold-path catalogue generator.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const engine = require('./forge-prefs.js');
const scaffold = require('./forge-prefs-scaffold.js');

const schema = engine.loadSchema();
const source = fs.readFileSync(path.join(__dirname, 'forge-prefs-scaffold.js'), 'utf8');
const text = scaffold.generateScaffold(schema);
const lines = text.split(/\r?\n/);
const defaults = scaffold.defaultsFromSchema(schema);
let passed = 0;

function check(label, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`✓ ${label}\n`);
  } catch (error) {
    process.stderr.write(`✗ ${label}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

function activeForm(input) {
  return input.split(/\r?\n/).map((line) => scaffold.isOffMarker(line)
    ? scaffold.stripOffMarker(line)
    : line).join('\n');
}

function schemaTextValues(node, values) {
  if (!node || typeof node !== 'object') return;
  if (node.description) values.push(String(node.description));
  if (Object.prototype.hasOwnProperty.call(node, 'default')) values.push(JSON.stringify(node.default));
  if (Array.isArray(node.enum)) node.enum.forEach((item) => values.push(JSON.stringify(item)));
  if (node.properties) Object.values(node.properties).forEach((child) => schemaTextValues(child, values));
}

check('real shipped schema is available', () => {
  assert(schema && schema.properties);
});

check('off form parses to schema reference only', () => {
  const parsed = engine.parseJsonc(text);
  assert.strictEqual(parsed.ok, true, JSON.stringify(parsed.error));
  assert.deepStrictEqual(parsed.value, { $schema: 'forge-prefs.schema.json' });
});

check('all-on form parses to schema defaults', () => {
  const parsed = engine.parseJsonc(activeForm(text));
  assert.strictEqual(parsed.ok, true, JSON.stringify(parsed.error));
  assert.deepStrictEqual(parsed.value, { $schema: 'forge-prefs.schema.json', ...defaults });
  assert.deepStrictEqual(engine.validatePrefs(parsed.value, schema), []);
});

check('every off marker has the exact grammar', () => {
  for (const line of lines) {
    if (line.includes('// ') && /^(\s*)\/\/ /.test(line) &&
      !/^\s*\/\/ ── /.test(line)) {
      assert(scaffold.isOffMarker(line) || /^\s*\/\/ [^"{}\]]/.test(line), line);
    }
  }
  const structural = lines.filter((line) => scaffold.isOffMarker(line));
  assert(structural.length > 0);
  assert(structural.every((line) => /^[ \t]*\/\/ ("|\{|\}|\])/.test(line)));
});

check('documentation is schema-projected and sanitized', () => {
  const values = [];
  schemaTextValues(schema, values);
  for (const line of lines) {
    const match = line.match(/^\s*\/\/ (.*)$/);
    if (!match || scaffold.isOffMarker(line) || match[1].startsWith('── ') ||
      match[1].startsWith('Catálogo gerado') || match[1].startsWith('Para ativar') ||
      match[1].startsWith('Referência completa')) continue;
    assert(!/^["{}\]]/.test(match[1]), line);
    assert(values.some((value) => value.includes(match[1].replace(/^· /, ''))), line);
  }
});

check('generator source has no knob-explaining prose', () => {
  for (const key of ['auto_commit', 'merge_strategy', 'routing']) {
    const node = schema.properties[key];
    if (node && node.description) assert(!source.includes(node.description));
  }
  assert(source.includes('node.description'));
  assert(source.includes('node.default'));
});

check('nested section can be activated with one knob left off', () => {
  const nested = [];
  let inside = false;
  for (const line of lines) {
    if (/^\s*\/\/ ── effort /.test(line)) inside = true;
    else if (inside && /^\s*\/\/ ── /.test(line)) inside = false;
    nested.push(inside && scaffold.isOffMarker(line) ? scaffold.stripOffMarker(line) : line);
  }
  const target = nested.findIndex((line) => /"execute-task": "medium"/.test(line));
  assert(target !== -1);
  nested[target] = nested[target].replace(/^(\s*)/, '$1// ');
  const parsed = engine.parseJsonc(nested.join('\n'));
  assert.strictEqual(parsed.ok, true, JSON.stringify(parsed.error));
  assert(parsed.value.effort);
  assert(!Object.prototype.hasOwnProperty.call(parsed.value.effort, 'execute-task'));
});

check('exported marker helpers round-trip a structural line', () => {
  const line = '    // "nested": {';
  assert(scaffold.isOffMarker(line));
  assert.strictEqual(scaffold.stripOffMarker(line), '    "nested": {');
});

check('defaults projection covers every closed schema leaf', () => {
  let leaves = 0;
  function count(node) {
    if (!node || typeof node !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(node, 'default')) leaves += 1;
    if (node.properties) Object.values(node.properties).forEach(count);
  }
  count(schema);
  const projected = [];
  function collect(value, prefix) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.entries(value).forEach(([key, child]) => collect(child, prefix.concat(key)));
    } else projected.push(prefix.join('.'));
  }
  collect(defaults, []);
  // $schema is intentionally omitted and the open routing map is represented
  // by its empty object default rather than by a synthetic child leaf.
  assert.strictEqual(projected.length + 2, leaves);
  assert(Object.prototype.hasOwnProperty.call(defaults, 'routing'));
});

check('catalog contains every schema section in declaration order', () => {
  const expected = Object.keys(schema.properties).filter((key) => key !== '$schema');
  const actual = lines.filter((line) => /^  \/\/ ── /.test(line)).map((line) =>
    line.replace(/^  \/\/ ── /, '').split(' ─')[0]);
  assert.deepStrictEqual(actual, expected);
});

// RISK BLOCKER 2: these tests intentionally work with raw slices.  A merge
// may not prettify, sort, or otherwise rewrite source that belongs to a user.
function extendedSchema() {
  const copy = JSON.parse(JSON.stringify(schema));
  copy.properties.new_synthetic = {
    type: 'boolean',
    default: false,
    description: 'Synthetic section used by the rescaffold contract.',
  };
  return copy;
}

function activateSection(input, key) {
  let within = false;
  return input.split(/\n/).map((line) => {
    if (line.includes(`── ${key} `)) within = true;
    else if (within && line.includes('// ── ')) within = false;
    return within && scaffold.isOffMarker(line) ? scaffold.stripOffMarker(line) : line;
  }).join('\n');
}

function moveSection(input, key, before) {
  const segments = scaffold.segmentCatalog(input);
  const moving = segments.find((segment) => segment.key === key);
  const target = segments.find((segment) => segment.key === before);
  assert(moving && target, 'fixture sections available');
  const without = input.slice(0, moving.start) + input.slice(moving.end);
  const targetAt = without.indexOf(target.raw);
  return without.slice(0, targetAt) + moving.raw + without.slice(targetAt);
}

function handEditedCatalog() {
  let edited = activateSection(text, 'review');
  edited = edited.replace('  // ── review ', '  // meu ajuste\n  // ── review ');
  // `workers` is a shipped peer section; moving it verifies user ordering is
  // preserved without assuming a legacy `git` section in this schema revision.
  edited = moveSection(edited, 'workers', 'tier_models');
  edited = edited.replace('  // ── accounts ', '  // prosa livre entre seções\n  // ── accounts ');
  edited = edited.replace('  // "accounts": {', '  "accounts": {');
  edited = edited.replace('    // "handoff_threshold": 90', '    "handoff_threshold": 90');
  edited = edited.replace('  // }\n}', '  },\n}');
  edited = edited.replace(/\n}\n$/, '\n  "meu_bloco_estranho": { "url": "https://example.test//safe" }\n}\n');
  return edited;
}

check('segmentCatalog uses source slices and recognizes active and off sections', () => {
  const edited = activateSection(text, 'review');
  const segments = scaffold.segmentCatalog(edited);
  const review = segments.find((segment) => segment.key === 'review');
  assert(review);
  assert.strictEqual(review.kind, 'active');
  assert.strictEqual(edited.indexOf(review.raw), review.start);
  assert(segments.some((segment) => segment.key === 'accounts' && segment.kind === 'commented'));
});

check('catalogDiff is structural and treats active and commented forms as present', () => {
  const edited = activateSection(text, 'review');
  const diff = scaffold.catalogDiff(edited, extendedSchema());
  assert.deepStrictEqual(diff.missingSections, ['new_synthetic']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(engine.parseJsonc(edited).value, '$version'), false);
});

check('rescaffold preserves hand-edited user segments and adds the new section', () => {
  const edited = handEditedCatalog();
  const before = scaffold.segmentCatalog(edited).filter((segment) => segment.key !== null);
  const result = scaffold.rescaffoldCatalog(edited, extendedSchema());
  for (const segment of before) assert.notStrictEqual(result.text.indexOf(segment.raw), -1, segment.key);
  assert(result.text.includes('// ── new_synthetic '));
  assert.strictEqual(engine.parseJsonc(result.text).ok, true);
  assert(result.addedSections.includes('new_synthetic'));
  assert(result.warnings.some((warning) => warning.code === 'unknown-section'));
});

check('rescaffold is idempotent for edited and fresh catalogues', () => {
  const edited = handEditedCatalog();
  const first = scaffold.rescaffoldCatalog(edited, extendedSchema());
  const second = scaffold.rescaffoldCatalog(first.text, extendedSchema());
  assert.strictEqual(second.text, first.text);
  const fresh = scaffold.rescaffoldCatalog(text, schema);
  assert.strictEqual(fresh.text, text);
  assert.deepStrictEqual(fresh.warnings, []);
});

check('unknown section is retained verbatim with one unknown-section warning', () => {
  const foreign = text.replace(/\n}\n$/, '\n  "meu_bloco_estranho": { "note": "kept" }\n}\n');
  const result = scaffold.rescaffoldCatalog(foreign, schema);
  const warnings = result.warnings.filter((warning) => warning.code === 'unknown-section');
  assert.strictEqual(warnings.length, 1);
  assert(result.text.includes('"meu_bloco_estranho": { "note": "kept" }'));
});

check('new sections are rendered off at the canonical insertion position', () => {
  const result = scaffold.rescaffoldCatalog(text, extendedSchema());
  const previous = result.text.indexOf('// ── accounts ');
  const added = result.text.indexOf('// ── new_synthetic ');
  assert(previous !== -1 && added > previous);
  const line = result.text.slice(result.text.lastIndexOf('\n', added) + 1, result.text.indexOf('\n', added));
  assert(line.startsWith('  // ── new_synthetic '));
});

// The focused cases above intentionally leave room for fixture edits: this
// test file doubles as executable documentation for the byte-preservation
// contract.  The following small invariants cover details that are easy to
// regress while changing the structural scanner.

check('segment offsets delimit their own raw source exactly', () => {
  const segments = scaffold.segmentCatalog(text);
  for (const segment of segments) {
    assert.strictEqual(text.slice(segment.start, segment.end), segment.raw);
    assert(segment.end >= segment.start);
  }
});

check('rescaffold output remains a JSONC document after a schema-line repair', () => {
  const withoutSchema = text.replace(/^  "\$schema"[^\n]*\n/, '');
  const result = scaffold.rescaffoldCatalog(withoutSchema, schema);
  assert.strictEqual(engine.parseJsonc(result.text).ok, true);
  assert(result.text.includes('"$schema": "forge-prefs.schema.json"'));
});

process.stdout.write(`${passed} scaffold checks passed\n`);
