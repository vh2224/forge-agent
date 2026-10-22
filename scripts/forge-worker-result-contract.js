'use strict';

// Prompt, provider schema and local validation share this exact contract.
const fs = require('fs');
const path = require('path');
const string = { type: 'string' };
const object = properties => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });
const array = items => ({ type: 'array', items });
const execute = object({
  status: { ...string, enum: ['done', 'partial', 'blocked'] },
  summary: { ...string, minLength: 1 },
  must_haves_status: array(object({
    item: string,
    status: { ...string, enum: ['met', 'unmet', 'unknown'] },
    note: string,
    scope: { ...string, enum: ['task', 'environment'] },
    reason: { ...string, enum: ['', 'git-commit-required', 'gsd-write-refused',
      'out-of-scope-test-failure', 'network-required', 'sandbox-exec-blocked'] },
  })),
  files_changed: array(string),
});

function load(name) {
  for (const dir of ['shared/schemas', 'schemas']) {
    const file = path.join(__dirname, '..', dir, name);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  throw new Error('worker-result-schema-unavailable');
}

function reference(schema, root) {
  if (!schema.$ref.startsWith('#/')) return undefined;
  return schema.$ref.slice(2).split('/').reduce((value, key) =>
    value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

function matches(value, schema, root = schema, depth = 0) {
  if (depth > 128) return false;
  if (typeof schema === 'boolean') return schema;
  if (!schema || typeof schema !== 'object') return false;
  if (schema.$ref) return matches(value, reference(schema, root), root, depth + 1);
  const match = part => matches(value, part, root, depth + 1);
  if (schema.allOf && !schema.allOf.every(match)
      || schema.anyOf && !schema.anyOf.some(match)
      || schema.oneOf && schema.oneOf.filter(match).length !== 1
      || schema.not && match(schema.not)) return false;
  if (schema.if && !match(match(schema.if) ? schema.then || {} : schema.else || {})) return false;
  const equal = other => JSON.stringify(value) === JSON.stringify(other);
  if (Object.hasOwn(schema, 'const') && !equal(schema.const)) return false;
  if (schema.enum && !schema.enum.some(equal)) return false;
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (schema.type && !types.some(t => t === type || t === 'integer' && Number.isSafeInteger(value))) return false;
  if (type === 'number' && (!Number.isFinite(value)
      || schema.minimum !== undefined && value < schema.minimum
      || schema.maximum !== undefined && value > schema.maximum)) return false;
  if (type === 'string' && (schema.minLength !== undefined && value.length < schema.minLength
      || schema.maxLength !== undefined && value.length > schema.maxLength
      || schema.pattern && !new RegExp(schema.pattern).test(value))) return false;
  if (type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems
        || schema.maxItems !== undefined && value.length > schema.maxItems
        || schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) return false;
    if (schema.items && !value.every(item => matches(item, schema.items, root, depth + 1))) return false;
  }
  if (type === 'object') {
    if (schema.required?.some(key => !Object.hasOwn(value, key))) return false;
    for (const key of Object.keys(value)) {
      const property = schema.properties?.[key];
      if (property !== undefined) {
        if (!matches(value[key], property, root, depth + 1)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties && !matches(value[key], schema.additionalProperties, root, depth + 1)) return false;
    }
  }
  return true;
}

function example(schema, root = schema) {
  if (schema.$ref) return example(reference(schema, root), root);
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum.includes('blocked') ? 'blocked' : schema.enum[0];
  if (schema.anyOf) return example(schema.anyOf[0], root);
  if (schema.type === 'object') return Object.fromEntries((schema.required || [])
    .map(key => [key, example(schema.properties[key], root)]));
  if (schema.type === 'array') return [];
  if (schema.type === 'boolean') return false;
  if (schema.type === 'number' || schema.type === 'integer') return schema.minimum || 0;
  return 'Pending';
}

function contract(profile = 'execute', suppliedSchema) {
  const schema = suppliedSchema || (profile === 'execute' ? execute
    : load(profile === 'memory' ? 'memory-extraction.schema.json' : 'unit-artifacts.schema.json'));
  return {
    profile, schema, example: example(schema),
    validate(value) {
      if (!matches(value, schema) || value?.status === 'done' && value.questions?.length) {
        return { ok: false, reason: 'schema-invalid' };
      }
      if (['preparation', 'artifacts'].includes(profile) && value.status !== 'done' && value.artifacts.length) {
        return { ok: false, reason: 'artifacts-on-non-done' };
      }
      return { ok: true };
    },
    instruction(transport = 'native') {
      const body = 'Return exactly the JSON object defined by this schema. Status values are exact; complete is invalid. No extra keys. A done result must have no unanswered questions.\nSchema: '
        + JSON.stringify(schema) + '\nValid example: ' + JSON.stringify(example(schema));
      if (transport === 'json') return body;
      if (transport === 'claude-cli') return body
        + '\nUse structured_output enforced by --json-schema; do not emit worker-result markers or put JSON in result text.';
      return body + '\nThis native transport does not enforce a provider schema. Finish with:\n---GSD-WORKER-RESULT---\nstatus: <exact JSON status>\nresult_json: <complete JSON object>\n---END-RESULT---';
    },
  };
}
module.exports = { contract, matches };
