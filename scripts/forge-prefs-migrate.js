#!/usr/bin/env node
'use strict';

// forge-prefs-migrate — Migrates legacy markdown preference files to the
// two-layer JSONC catalogs, gated on a resolved-diff so a migration can
// NEVER lose or invent a value (M008 S05 D1–D7).
//
// Pipeline per layer (D3):
//   capture (legacy old-reader) → generate (scaffold + user-value activation)
//   → diff-GATE + schema-GATE in memory (failure → exit 3, ZERO writes, not even .bak)
//   → copy every legacy md to .md.bak (never clobbers an existing .bak)
//   → write the jsonc catalog → re-verify with the REAL new-reader
//   → divergence or schema warning → rollback (delete the jsonc, originals untouched) → exit 3
//   → success → remove the legacy md files (the .bak stays).
//
// Malformed legacy markdown (routing parse error, e.g. the flattened
// indentation class of 2026-07-16) → exit 4, zero writes: never migrate
// invented state (M008-CONTEXT decision #2).
//
// Exit codes (D7):
//   0 — migrated, already-migrated no-op, or dry-run
//   3 — resolved diff/schema warning (gate STOP) or post-write re-verify rollback
//   4 — legacy markdown parse error (STOP)
//   1 — unexpected error / bad arguments
//
// Reuse contract (D1): the Markdown extractor comes from forge-prefs-legacy.js;
// parseJsonc / deepMerge and every catalog
// primitive from forge-prefs-scaffold.js (generateScaffold / segmentCatalog /
// off-marker grammar). This module declares ZERO markdown-extraction regexes.
//
// Test-only hook: FORGE_PREFS_MIGRATE_TEST_MUTATE=1 perturbs the generated
// jsonc BEFORE the gate runs, so the exit-3 zero-write path is e2e-testable
// (precedent: FORGE_XLLM_AGY_BIN mocks). Never set outside tests.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  parseJsonc,
  stripJsonc,
  preferenceLayerDescriptors,
  deepMerge,
  loadSchema,
  validatePrefs,
} = require('./forge-prefs.js');
const { legacyReadLayer } = require('./forge-prefs-legacy.js');

const {
  generateScaffold,
  segmentCatalog,
  rootKeys,
  readQuoted,
  OFF_MARKER,
} = require('./forge-prefs-scaffold.js');

// ── Small local helpers (structural, not extraction) ───────────────────────

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonEqual(left, right) {
  // NOTE: JSON.stringify collapses NaN/Infinity→null; unreachable today (legacy reader + --set
  // never route non-JSON-safe numerics here), but a future numeric source would need a richer equality.
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function getDottedValue(value, dotted) {
  let current = value;
  for (const key of dotted.split('.')) {
    if (!isPlainObject(current) || !hasOwn(current, key)) return { found: false, value: undefined };
    current = current[key];
  }
  return { found: true, value: current };
}

function setDottedValue(value, dotted, nextValue) {
  const keys = dotted.split('.');
  if (!dotted || keys.some((key) => !key)) throw new Error('key must be a non-empty dotted path');
  const output = deepMerge({}, value || {});
  let current = output;
  for (let index = 0; index < keys.length - 1; index++) {
    const key = keys[index];
    if (!isPlainObject(current[key])) current[key] = {};
    current = current[key];
  }
  current[keys[keys.length - 1]] = nextValue;
  return output;
}

function parseSetExpression(expression) {
  const equals = String(expression || '').indexOf('=');
  if (equals <= 0) throw new Error('--set expects dotted.key=value');
  const key = expression.slice(0, equals).trim();
  const raw = expression.slice(equals + 1);
  if (!key || key.split('.').some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error('--set key must be a dotted key');
  }
  try { return { key, value: JSON.parse(raw) }; } catch { return { key, value: raw }; }
}

// ── resolvedDiff — the gate (pure, exported) ────────────────────────────────
// Deep-compares two resolved preference objects and returns every divergence
// as [{path, old, new}]. Arrays compare by whole-value equality (replace
// semantics, matching deepMerge). The top-level `$schema` key is catalog
// metadata introduced by the scaffold — it is ignored, never a divergence.

function resolvedDiff(oldObj, newObj) {
  const diffs = [];
  (function walk(a, b, prefix) {
    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = new Set(Object.keys(a).concat(Object.keys(b)));
      for (const key of keys) {
        if (prefix === '' && key === '$schema') continue;
        const dotted = prefix ? `${prefix}.${key}` : key;
        if (!hasOwn(a, key)) diffs.push({ path: dotted, old: undefined, new: b[key] });
        else if (!hasOwn(b, key)) diffs.push({ path: dotted, old: a[key], new: undefined });
        else walk(a[key], b[key], dotted);
      }
      return;
    }
    if (!jsonEqual(a, b)) diffs.push({ path: prefix || '<root>', old: a, new: b });
  })(oldObj || {}, newObj || {}, '');
  return diffs;
}

// ── activateValues — scaffold + user values ────────────────────────────────
// Starts from the all-commented scaffold and appends one ACTIVE JSON entry per
// top-level key found in `values`, placed right after that key's commented
// scaffold segment (the docs stay). Keys the schema does not know (typo or
// custom — D4) are spliced literally before the root close with a marker
// comment. The result MUST parse via parseJsonc to exactly `values` (plus the
// `$schema` metadata key, which the gate ignores).

// Form B: `eol` is the line ending observed in the catalogue this entry is being
// spliced into. The entry must carry the file's own bytes — emitting LF into a
// CRLF catalogue the operator authored leaves the file half and half.
function detectEol(text) {
  return (String(text).match(/\r\n|\n|\r/) || ['\n'])[0];
}
const ENDS_WITH_EOL = /(?:\r\n|\n|\r)$/;

function renderActiveEntry(key, value, note, eol) {
  const nl = eol || '\n';
  const json = JSON.stringify(value, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join(nl);
  const lines = [];
  if (note) lines.push(`  // ${note}`);
  lines.push(`  ${JSON.stringify(key)}: ${json},`);
  return `${lines.join(nl)}${nl}`;
}

function activateValues(catalogText, values, schema) {
  const userValues = values || {};
  const pending = new Set(Object.keys(userValues));
  // The catalogue may be a generated scaffold (LF) or bytes read from the
  // operator's disk (possibly CRLF). Either way, follow what is there.
  const eol = detectEol(catalogText);
  let output = '';
  for (const segment of segmentCatalog(catalogText)) {
    output += segment.raw;
    if (segment.key && pending.has(segment.key)) {
      if (!ENDS_WITH_EOL.test(output)) output += eol;
      output += renderActiveEntry(segment.key, userValues[segment.key], null, eol);
      pending.delete(segment.key);
    }
  }
  if (pending.size > 0) {
    // Out-of-schema keys (D4): no scaffold segment exists — splice before the
    // root close so they live inside the JSON object. The generated catalog is
    // module-owned text: its final `}` is always the root close.
    let block = '';
    for (const key of Object.keys(userValues)) {
      if (!pending.has(key)) continue;
      block += renderActiveEntry(key, userValues[key], 'migrated from legacy md (not in schema)', eol);
    }
    const close = output.lastIndexOf('}');
    if (close === -1) throw new Error('generated catalog has no root close');
    const head = output.slice(0, close);
    output = `${ENDS_WITH_EOL.test(head) ? head : `${head}${eol}`}${block}${output.slice(close)}`;
  }
  const parsed = parseJsonc(output);
  if (!parsed.ok) {
    throw new Error(`activateValues produced invalid JSONC: ${parsed.error.message}`);
  }
  if (schema) {
    // Structural sanity only; the real gate is resolvedDiff in migrateLayer.
    const check = resolvedDiff(userValues, parsed.value);
    if (check.length > 0) {
      throw new Error(`activateValues round-trip mismatch: ${check.map((d) => d.path).join(', ')}`);
    }
  }
  return output;
}

// ── Layer descriptors ──────────────────────────────────────────────────────
// The file lists come from forge-prefs.js#preferenceLayerDescriptors — the
// SAME lists readPrefs resolves (Forge global with a Claude legacy fallback;
// local <cwd>/.gsd with the
// repo-shared md before the personal md, last-wins). The 3→2 fold direction
// of decision #1 therefore comes from the old-reader itself and is never
// re-implemented here. No legacy filename literal exists in this module.

function layerDescriptors(cwd, opts) {
  return preferenceLayerDescriptors(cwd, opts);
}

function existingFiles(files) {
  return files.filter((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  });
}

// Resolve the current on-disk state of both layers with composed semantics
// (jsonc shadows md). Used for the merged capture and the post-write
// re-verify. With default dirs the CLI path uses the REAL readPrefs(cwd);
// with test overrides (globalDir/localDir) it composes the identical shape
// via the same exported primitives (parseJsonc / legacyReadLayer / deepMerge).
function resolveCurrent(cwd, opts, replacementLayer) {
  const options = opts || {};
  const errors = [];
  const layers = layerDescriptors(cwd, options).map((layer) => {
    // Preview a pending layer through the same ordering and domain-atomic
    // merge used after publication. No temporary catalog or inherited copy.
    if (replacementLayer && replacementLayer.name === layer.name) return replacementLayer.value;
    const jsoncCandidates = layer.jsoncCandidates || [layer.jsoncPath];
    const jsoncPresent = existingFiles(jsoncCandidates);
    if (jsoncPresent.length > 0) {
      const jsoncPath = jsoncPresent[0];
      let raw;
      try {
        raw = fs.readFileSync(jsoncPath, 'utf8');
      } catch (error) {
        errors.push({ file: jsoncPath, line: null, message: error.message });
        return {};
      }
      const parsed = parseJsonc(raw);
      if (!parsed.ok) {
        errors.push({ file: jsoncPath, line: parsed.error.line, message: parsed.error.message });
        return {};
      }
      return parsed.value;
    }
    const legacy = legacyReadLayer(layer.mdFiles);
    if (legacy.routingMalformed) {
      errors.push({
        file: legacy.malformedFile,
        line: null,
        message: `routing-parse-error: malformed routing block in ${legacy.malformedFile}`,
      });
      delete legacy.prefs.routing;
    }
    return legacy.prefs;
  });
  return { prefs: deepMerge(layers[0], layers[1]), errors };
}

// ── migrateLayer — the per-layer pipeline (D3, D5) ─────────────────────────

function bakPathFor(mdFile) {
  const candidate = `${mdFile}.bak`;
  if (!fs.existsSync(candidate)) return candidate;
  // Never clobber a pre-existing .bak: it may hold an older, still-precious
  // pre-migration state. Timestamp-suffix instead.
  return `${mdFile}.bak-${Date.now()}`;
}

// prepareLayer performs the entire read-only half of the pipeline: capture is
// the caller's, generation and THE GATE happen here — with ZERO writes. Only
// a prep whose gate passed may be handed to commitLayer.
function prepareLayer(layer) {
  const { name, jsoncPath, mdFiles, oldLayerResolved, schema } = layer;
  const jsoncCandidates = layer.jsoncCandidates || [jsoncPath];
  if (existingFiles(jsoncCandidates).length > 0) {
    // Idempotence (D5): the layer already migrated. Do not re-read md or .bak.
    return { name, action: 'skipped', reason: 'already-migrated', jsoncPath };
  }
  const present = existingFiles(mdFiles);
  if (present.length === 0) {
    return { name, action: 'skipped', reason: 'absent', jsoncPath };
  }
  const effectiveSchema = schema || loadSchema();
  if (!effectiveSchema) return { name, action: 'error', reason: 'schema-unavailable' };
  const schemaRef = path
    .relative(path.dirname(jsoncPath), path.join(__dirname, '..', 'forge-prefs.schema.json'))
    .split(path.sep).join('/') || 'forge-prefs.schema.json';
  let generated = activateValues(
    generateScaffold(effectiveSchema, { schemaRef }),
    oldLayerResolved,
    effectiveSchema,
  );
  if (process.env.FORGE_PREFS_MIGRATE_TEST_MUTATE === '1') {
    // TEST-ONLY: perturb the generated catalog before the gate so the exit-3
    // zero-write path can be exercised end to end. Never set in production.
    const close = generated.lastIndexOf('}');
    generated = `${generated.slice(0, close)}  "__forge_test_mutation": 1\n${generated.slice(close)}`;
  }
  const parsed = parseJsonc(generated);
  if (!parsed.ok) return { name, action: 'error', reason: `generated-jsonc-invalid: ${parsed.error.message}` };

  // ── THE GATE (D2 / RISK BLOCKER 1): in-memory, before ANY filesystem write.
  const diff = resolvedDiff(oldLayerResolved, parsed.value);
  if (diff.length > 0) {
    return { name, action: 'stop', reason: 'diff', diff, jsoncPath };
  }
  // Schema is an independent gate from the round-trip proof above: the
  // legacy and generated values can agree while still being invalid for the
  // catalog schema. Keep this before commit so rejection leaves no .bak or
  // jsonc artifact behind.
  const warnings = validatePrefs(parsed.value, effectiveSchema);
  if (warnings.length > 0) {
    return { name, action: 'stop', reason: 'schema-warnings', warnings, jsoncPath };
  }
  return {
    name,
    action: 'ready',
    jsoncPath,
    mdFiles: present,
    preserveFiles: (layer.legacyMdFiles || []).filter((file) => present.includes(file)),
    generated,
    diff: [],
  };
}

// commitLayer performs the write half: .bak of every legacy md FIRST (never
// clobbering an existing .bak), then the jsonc catalog (LF, utf8).
function commitLayer(prep) {
  const baks = [];
  for (const mdFile of prep.mdFiles) {
    const bak = bakPathFor(mdFile);
    fs.copyFileSync(mdFile, bak);
    baks.push(bak);
  }
  fs.mkdirSync(path.dirname(prep.jsoncPath), { recursive: true });
  fs.writeFileSync(prep.jsoncPath, prep.generated, 'utf8');
  return {
    name: prep.name,
    action: 'migrated',
    jsoncPath: prep.jsoncPath,
    baks,
    mdFiles: prep.mdFiles,
    preserveFiles: prep.preserveFiles || [],
    diff: [],
  };
}

// Single-layer convenience pipeline (exported for tests / targeted callers).
function migrateLayer(layer) {
  const prep = prepareLayer(layer);
  if (prep.action !== 'ready') return prep;
  if (layer.dryRun) {
    return {
      name: prep.name,
      action: 'dry-run',
      jsoncPath: prep.jsoncPath,
      wouldBackup: prep.mdFiles.map((file) => `${file}.bak`),
      diff: [],
    };
  }
  return commitLayer(prep);
}

// Local catalogues must not silently become team configuration.  This helper
// is intentionally best-effort: a non-repository is a valid caller, and an
// already-covered path needs no textual .gitignore edit.  `execFileSync` is
// injectable so tests can prove all three branches without invoking git.
function ensureGitignore(cwd, opts) {
  const options = opts || {};
  const run = options.execFileSync || execFileSync;
  const write = options.writeFileSync || fs.writeFileSync;
  const exists = options.existsSync || fs.existsSync;
  const gitignore = path.join(cwd, '.gitignore');
  const warning = 'config de time por commit deixa de existir — valores fundidos no seu local gitignored';
  try {
    run('git', ['rev-parse', '--is-inside-work-tree'], { cwd, stdio: 'ignore' });
  } catch {
    return { action: 'skipped', reason: 'not-git', warning: null };
  }
  try {
    run('git', ['check-ignore', '-q', '.gsd/forge-prefs.jsonc'], { cwd, stdio: 'ignore' });
    return { action: 'skipped', reason: 'already-ignored', warning: null };
  } catch {
    // git check-ignore uses exit 1 for an unignored path; any other failure is
    // conservatively treated the same, because the preceding rev-parse proved
    // this is a repository and the additive rule is safe.
  }
  if (options.dryRun) return { action: 'would-append', path: gitignore, warning: `adicionaria .gsd/forge-prefs.jsonc ao .gitignore; ${warning}` };
  let old = '';
  if (exists(gitignore)) old = fs.readFileSync(gitignore, 'utf8');
  // Form B: the existing .gitignore is re-emitted whole (this is a rewrite, not an
  // append), so its own EOL is captured and reused for the separator and the new
  // line. Joining with LF would leave a Windows-authored .gitignore mixed.
  const eol = detectEol(old);
  const newline = old.length === 0 || ENDS_WITH_EOL.test(old) ? old : `${old}${eol}`;
  write(gitignore, `${newline}.gsd/forge-prefs.jsonc${eol}`, 'utf8');
  return { action: 'appended', path: gitignore, warning: `adicionado .gsd/forge-prefs.jsonc ao .gitignore; ${warning}` };
}

const SET_MARKER = 'set by forge-prefs-migrate --set';

// End offset of the root entry anchored at `keyStart`, just past its trailing
// comma and newline. Walks the comment-masked text (offset-preserving), so the
// extent is the real JSON value rather than a guess at how it was rendered.
function rootEntryEnd(mask, text, keyStart) {
  const quoted = readQuoted(mask, keyStart);
  if (!quoted) return null;
  let index = mask.indexOf(':', quoted.end);
  if (index === -1) return null;
  let depth = 0;
  for (index += 1; index < mask.length; index++) {
    const character = mask[index];
    if (character === '"') {
      const string = readQuoted(mask, index);
      if (!string) continue;
      index = string.end - 1;
      if (depth === 0) { index += 1; break; }
      continue;
    }
    if (character === '{' || character === '[') { depth += 1; continue; }
    if (character === '}' || character === ']') {
      if (depth === 0) break;
      depth -= 1;
      if (depth === 0) { index += 1; break; }
      continue;
    }
    if (depth === 0 && character === ',') break;
  }
  while (index < mask.length && (mask[index] === ' ' || mask[index] === '\t')) index += 1;
  if (mask[index] === ',') index += 1;
  // The returned offset is consumed as a RANGE end by activeSectionRanges →
  // setCatalogValue, which rewrites the catalogue by slicing. It must land just
  // past the whole line terminator, whatever that terminator is. `indexOf('\n')`
  // already lands correctly on CRLF (the LF is the last byte of the pair) but is
  // blind to a lone CR, which would fold two source lines into one range.
  const tail = /\r\n|\n|\r/.exec(text.slice(index));
  return tail === null ? text.length : index + tail.index + tail[0].length;
}

// Every ACTIVE occurrence of `section` as an absolute source range, in document
// order. A range covers the entry plus the `// set by …` marker line when one
// labels it, so rewriting a range leaves no orphaned marker. Anchors come from
// rootKeys — segmentCatalog draws its boundaries for the rescaffold use case and
// clamps consecutive duplicates in a way that misattributes markers.
function activeSectionRanges(text, section) {
  const needle = `// ${SET_MARKER}`;
  const mask = stripJsonc(text);
  const lineStartOf = (index) => text.lastIndexOf('\n', Math.max(0, index - 1)) + 1;
  const ranges = [];
  for (const anchor of rootKeys(mask)) {
    if (anchor.key !== section) continue;
    const end = rootEntryEnd(mask, text, anchor.start);
    if (end === null) continue;
    let start = lineStartOf(anchor.start);
    const head = text.slice(0, start);
    const marker = head.lastIndexOf(needle);
    // Whitespace-only between the marker and the key proves the marker labels
    // THIS entry and not an unrelated earlier one.
    if (marker !== -1 && head.slice(marker + needle.length).trim() === '') start = lineStartOf(marker);
    ranges.push({ start, end });
  }
  return ranges;
}

// Set a dotted knob by rewriting the touched section IN PLACE, leaving every
// other byte of the catalogue untouched. Three cases, in order:
//
//   1. the section is already active → rewrite the FIRST occurrence where it
//      sits (its documentation banner is outside the range and survives) and
//      delete any later duplicate a pre-v2 append left behind;
//   2. the section exists only as commented scaffold → activateValues turns it
//      on right below its own docs, not at the end of the file;
//   3. the schema does not know the section at all → append before the root
//      close with a marker comment explaining the stray key.
//
// Rewriting in place is what makes hand-editing trustworthy. The predecessor
// appended a duplicate root key and relied on JSON last-wins, so an appended
// block silently SHADOWED the documented block a user had edited by hand — the
// edit parsed fine and did nothing. Case 1 exists to make those two paths agree.
function setCatalogValue(catalogText, dotted, value, schema) {
  const parsed = parseJsonc(catalogText);
  if (!parsed.ok) throw new Error(`cannot set value in invalid JSONC: ${parsed.error.message}`);
  const keys = dotted.split('.');
  const section = keys[0];
  // Read from the last-wins parse BEFORE any rewrite, so collapsing duplicate
  // keys can never change what the catalogue resolves to.
  const next = setDottedValue(parsed.value, dotted, value);
  const occurrences = activeSectionRanges(catalogText, section);
  // Form B: every byte outside the touched range is re-emitted verbatim, so the
  // replacement entry must carry the catalogue's own EOL — not LF by decree.
  const eol = detectEol(catalogText);
  let output;
  if (occurrences.length > 0) {
    const entry = renderActiveEntry(section, next[section], null, eol);
    output = '';
    let cursor = 0;
    for (let index = 0; index < occurrences.length; index++) {
      const range = occurrences[index];
      if (range.start < cursor) continue;
      output += catalogText.slice(cursor, range.start);
      if (index === 0) output += entry;
      cursor = range.end;
    }
    output += catalogText.slice(cursor);
  } else {
    // segmentCatalog is the only catalogue locator used here; OFF_MARKER comes
    // from the scaffold module rather than defining a competing on/off grammar.
    const hasSection = segmentCatalog(catalogText).some((segment) => segment.key === section);
    if (hasSection) {
      // Schema is withheld: activateValues' gate is a bidirectional diff, which
      // a single-key payload would trip against every other active knob. The
      // value gate below covers this path instead.
      output = activateValues(catalogText, { [section]: next[section] }, null);
    } else {
      if (!OFF_MARKER) throw new Error('scaffold off-marker unavailable');
      const close = catalogText.lastIndexOf('}');
      if (close === -1) throw new Error('catalog has no root close');
      const head = catalogText.slice(0, close);
      output = `${ENDS_WITH_EOL.test(head) ? head : `${head}${eol}`}${renderActiveEntry(section, next[section], SET_MARKER, eol)}${catalogText.slice(close)}`;
    }
  }
  const checked = parseJsonc(output);
  if (!checked.ok) throw new Error(`--set produced invalid JSONC: ${checked.error.message}`);
  // Value gate: the touched section must resolve to exactly the requested state
  // and nothing else may have moved.
  const drift = resolvedDiff(next, checked.value);
  if (drift.length > 0) throw new Error(`--set changed unrelated values: ${drift.map((entry) => entry.path).join(', ')}`);
  return output;
}

function setPreference(cwd, expression, opts) {
  const options = opts || {};
  // $schema is tooling metadata (the catalog-reference hook), not a user
  // preference — refuse to set it BEFORE parseSetExpression (whose dotted-key
  // regex rejects the leading `$` with a generic message) so the viewer/skill
  // never delegate a catalog-corrupting write.
  const rawKey = String(expression || '').slice(0, String(expression || '').indexOf('=')).trim();
  if (rawKey === '$schema') {
    throw new Error('$schema é metadata de tooling, não pode ser setado como preferência');
  }
  const requested = parseSetExpression(expression);
  const descriptors = layerDescriptors(cwd, options);
  const defaultLayer = fs.existsSync(path.join(cwd, '.gsd')) ? 'local' : 'global';
  const layerName = options.layer || defaultLayer;
  if (layerName !== 'global' && layerName !== 'local') throw new Error('--layer must be global or local');
  const layer = descriptors.find((entry) => entry.name === layerName);
  const sourceJsonc = existingFiles(layer.jsoncCandidates || [layer.jsoncPath])[0];
  const exists = Boolean(sourceJsonc);
  if (!exists && layerName === 'local' && !options.create) {
    return { status: 'local-create-required', layer: layerName, path: layer.jsoncPath };
  }
  const schema = options.schema || loadSchema();
  if (!schema) throw new Error('forge-prefs.schema.json unavailable');
  // Enum/type gate — pre-write, reusing validatePrefs (schema is the single
  // source of truth, DECISION 53). Build a minimal candidate carrying only
  // the requested key so pre-existing legacy state elsewhere in the resolved
  // prefs never gets flagged (Pitfall 1). The candidate contains ONLY the
  // requested dotted chain, so ANY warning validatePrefs emits on it is
  // necessarily about that chain (ancestor, descendant, or the exact key) —
  // reject on any warning rather than filtering by exact key match, which
  // let unknown/invalid keys under a validated ancestor/descendant slip
  // through and get written (review-fix/TASK-001, R1 conceded).
  const candidate = setDottedValue({}, requested.key, requested.value);
  const candidateWarnings = validatePrefs(candidate, schema);
  if (candidateWarnings.length > 0) {
    throw new Error(candidateWarnings.map((warning) => warning.message).join('; '));
  }
  const schemaRef = path.relative(path.dirname(layer.jsoncPath), path.join(__dirname, '..', 'forge-prefs.schema.json')).split(path.sep).join('/') || 'forge-prefs.schema.json';
  const original = sourceJsonc ? fs.readFileSync(sourceJsonc, 'utf8') : generateScaffold(schema, { schemaRef });
  const next = exists
    ? setCatalogValue(original, requested.key, requested.value, schema)
    : activateValues(original, setDottedValue({}, requested.key, requested.value), schema);
  const nextLayer = parseJsonc(next).value;
  const actual = getDottedValue(nextLayer, requested.key);
  if (!actual.found || !jsonEqual(actual.value, requested.value)) {
    throw new Error(`--set verification failed for ${requested.key}`);
  }
  const expected = resolveCurrent(cwd, options, { name: layerName, value: nextLayer });
  if (expected.errors.length) throw new Error('--set cannot verify preference layers before writing');
  if (!options.dryRun) {
    let writeState = 'not-written';
    try {
      fs.mkdirSync(path.dirname(layer.jsoncPath), { recursive: true });
      writeState = 'unknown'; // An I/O exception can follow a partial write.
      fs.writeFileSync(layer.jsoncPath, next, 'utf8');
      writeState = 'written';
      const observedLayer = parseJsonc(fs.readFileSync(layer.jsoncPath, 'utf8'));
      const observed = resolveCurrent(cwd, options);
      if (!observedLayer.ok || resolvedDiff(nextLayer, observedLayer.value).length
          || observed.errors.length || resolvedDiff(expected.prefs, observed.prefs).length) {
        throw new Error(`--set verification failed for ${requested.key}`);
      }
    } catch (error) {
      // Preserve an intervening writer's bytes rather than pretending a safe
      // rollback is possible. Callers must inspect effects before retrying.
      error.write_state = writeState;
      if (writeState !== 'not-written') error.message += ` (catalog write state: ${writeState}; inspect before retry)`;
      throw error;
    }
  }
  return { status: options.dryRun ? 'dry-run' : 'set', layer: layerName, path: layer.jsoncPath, key: requested.key, value: requested.value };
}

// ── migrateAll — capture → per-layer → re-verify → cleanup ─────────────────

function migrateAll(cwd, opts) {
  const options = opts || {};
  const targetCwd = cwd || process.cwd();
  const schema = options.schema || loadSchema();
  if (!schema) return { status: 'error', errors: [{ message: 'forge-prefs.schema.json unavailable' }], layers: [] };

  const descriptors = layerDescriptors(targetCwd, options).filter((layer) => {
    if (options.globalOnly) return layer.name === 'global';
    if (options.localOnly) return layer.name === 'local';
    return true;
  });

  // Capture: per-layer legacy resolved (only for layers still on markdown) and
  // the merged pre-migration resolved for the whole-object re-verify gate.
  const captures = [];
  for (const layer of descriptors) {
    if (existingFiles(layer.jsoncCandidates || [layer.jsoncPath]).length > 0 || existingFiles(layer.mdFiles).length === 0) {
      captures.push({ layer, oldLayerResolved: {} });
      continue;
    }
    const legacy = legacyReadLayer(layer.mdFiles);
    if (legacy.routingMalformed) {
      // Malformed legacy markdown → never migrate invented state (exit 4).
      return {
        status: 'legacy-parse-error',
        errors: [{
          file: legacy.malformedFile,
          message: `routing-parse-error: malformed routing block in ${legacy.malformedFile}`,
        }],
        layers: [],
      };
    }
    captures.push({ layer, oldLayerResolved: legacy.prefs });
  }
  const before = resolveCurrent(targetCwd, options);
  if (before.errors.length > 0) {
    return { status: 'legacy-parse-error', errors: before.errors, layers: [] };
  }

  // Phase 1 — prepare EVERY layer (read-only). A gate failure in ANY layer
  // stops the whole run before a single byte is written anywhere: "exit 3,
  // ZERO writes" holds across layers, not just within one.
  const preps = [];
  for (const capture of captures) {
    const prep = prepareLayer({
      name: capture.layer.name,
      jsoncPath: capture.layer.jsoncPath,
      jsoncCandidates: capture.layer.jsoncCandidates,
      mdFiles: capture.layer.mdFiles,
      legacyMdFiles: capture.layer.legacyMdFiles,
      oldLayerResolved: capture.oldLayerResolved,
      schema,
    });
    preps.push(prep);
    if (prep.action === 'stop') {
      if (prep.reason === 'schema-warnings') {
        return { status: 'schema-warnings', layers: preps, warnings: prep.warnings };
      }
      return { status: 'diff', layers: preps, diff: prep.diff };
    }
    if (prep.action === 'error') {
      return { status: 'error', layers: preps, errors: [{ message: prep.reason }] };
    }
  }

  const ready = preps.filter((prep) => prep.action === 'ready');
  if (options.dryRun) {
    const localReady = preps.find((prep) => prep.name === 'local' && prep.action === 'ready');
    const execForIgnore = options.execFileSync || ((options.globalDir || options.localDir) ? (() => { throw new Error('not a git repository'); }) : undefined);
    const gitignore = localReady ? ensureGitignore(targetCwd, { dryRun: true, execFileSync: execForIgnore }) : null;
    return {
      status: 'dry-run',
      gitignore,
      layers: preps.map((prep) => (prep.action !== 'ready' ? prep : {
        name: prep.name,
        action: 'dry-run',
        jsoncPath: prep.jsoncPath,
        wouldBackup: prep.mdFiles.map((file) => `${file}.bak`),
        diff: [],
      })),
    };
  }
  if (ready.length === 0) return { status: 'noop', layers: preps };

  // Phase 2 — commit (writes) only after every gate passed.
  // Commit is injectable so tests can force a mid-loop throw. If any layer's
  // commit throws mid-loop (ENOSPC/EACCES on the 2nd+ layer), UNWIND: delete
  // the jsonc files already written by prior successful commits in THIS run,
  // leaving the .bak files and original mds intact, then surface the error.
  // Mirrors the rigor of the post-write-diff rollback below.
  const commit = options.commitLayer || commitLayer;
  const results = [];
  const writtenJsonc = [];
  try {
    for (const prep of preps) {
      if (prep.action !== 'ready') { results.push(prep); continue; }
      const result = commit(prep);
      results.push(result);
      if (result.action === 'migrated') writtenJsonc.push(result.jsoncPath);
    }
  } catch (err) {
    for (const jsoncPath of writtenJsonc) {
      try { fs.unlinkSync(jsoncPath); } catch { /* unwind best effort */ }
    }
    return { status: 'error', layers: results, errors: [{ message: err && err.message ? err.message : String(err) }] };
  }
  const migrated = results.filter((result) => result.action === 'migrated');

  // Post-write re-verify (D3): run the REAL resolver over the new state and
  // diff against the captured pre-migration resolved. The legacy md files are
  // still on disk here — the jsonc shadow makes them inert — so a rollback
  // (delete the jsonc) restores the exact previous state.
  const after = resolveCurrent(targetCwd, options);
  const mergedDiff = resolvedDiff(before.prefs, after.prefs);
  const schemaWarnings = validatePrefs(after.prefs, schema);
  if (after.errors.length > 0 || mergedDiff.length > 0 || schemaWarnings.length > 0) {
    for (const result of migrated) {
      try { fs.unlinkSync(result.jsoncPath); } catch { /* rollback best effort */ }
    }
    return { status: 'rollback', layers: results, diff: mergedDiff, errors: after.errors, warnings: schemaWarnings };
  }

  // Success: retire the legacy md files (the .bak stays as the recovery copy).
  for (const result of migrated) {
    for (const mdFile of result.mdFiles) {
      if ((result.preserveFiles || []).includes(mdFile)) continue;
      try { fs.unlinkSync(mdFile); } catch { /* leave shadowed file behind */ }
    }
  }
  const localMigrated = migrated.some((result) => result.name === 'local');
  // Directory overrides are a test/embedding API, not an instruction to run
  // the caller's git executable. They model a non-git temp directory unless
  // the embedding caller deliberately supplies the standard exec hook.
  const execForIgnore = options.execFileSync || ((options.globalDir || options.localDir) ? (() => { throw new Error('not a git repository'); }) : undefined);
  const gitignore = localMigrated
    ? ensureGitignore(targetCwd, { execFileSync: execForIgnore })
    : null;
  // The first local legacy source is the repo-shared file by the canonical
  // descriptor order. Keep filename ownership in forge-prefs.js alone.
  const localDescriptor = descriptors.find((descriptor) => descriptor.name === 'local');
  const repoSharedLegacy = localDescriptor && localDescriptor.mdFiles[0];
  const teamFolded = migrated.some((result) => result.name === 'local' && result.mdFiles.includes(repoSharedLegacy));
  const warnings = [];
  if (gitignore && gitignore.warning) warnings.push(gitignore.warning);
  if (teamFolded) warnings.push('config de time por commit deixa de existir — valores fundidos no seu local gitignored');
  return { status: 'migrated', layers: results, diff: [], gitignore, warnings };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const args = {
    cwd: process.cwd(),
    dryRun: false,
    globalOnly: false,
    localOnly: false,
    json: false,
    globalDir: null,
    localDir: null,
    set: null,
    layer: null,
    create: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--cwd') args.cwd = path.resolve(argv[++index] || process.cwd());
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--global-only') args.globalOnly = true;
    else if (arg === '--local-only') args.localOnly = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--set') args.set = argv[++index] || '';
    else if (arg === '--layer') args.layer = argv[++index] || '';
    else if (arg === '--create') args.create = true;
    // Test/advanced overrides — keep the CLI e2e-testable without ever
    // touching the operator's real runtime home.
    else if (arg === '--global-dir') args.globalDir = path.resolve(argv[++index] || '');
    else if (arg === '--local-dir') args.localDir = path.resolve(argv[++index] || '');
    else return { error: `unknown argument: ${arg}` };
  }
  return args;
}

function printDiff(diff, write) {
  for (const entry of diff) {
    write(`  ✗ ${entry.path}: old=${JSON.stringify(entry.old)} new=${JSON.stringify(entry.new)}\n`);
  }
}

function exitCodeFor(status) {
  if (status === 'migrated' || status === 'noop' || status === 'dry-run') return 0;
  if (status === 'diff' || status === 'schema-warnings' || status === 'rollback') return 3;
  if (status === 'legacy-parse-error') return 4;
  return 1;
}

function runCli(argv) {
  const args = parseCliArgs(argv);
  const err = (text) => process.stderr.write(text);
  if (args.error) {
    err(`✗ forge-prefs-migrate: ${args.error}\n`);
    return 1;
  }
  if (args.set !== null) {
    try {
      const result = setPreference(args.cwd, args.set, args);
      if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else process.stderr.write(`✓ ${result.status}: ${result.key || ''} (${result.layer})\n`);
      return result.status === 'local-create-required' ? 1 : 0;
    } catch (error) {
      err(`✗ prefs --set error: ${error.message}\n`);
      return 1;
    }
  }
  let result;
  try {
    result = migrateAll(args.cwd, {
      dryRun: args.dryRun,
      globalOnly: args.globalOnly,
      localOnly: args.localOnly,
      globalDir: args.globalDir || undefined,
      localDir: args.localDir || undefined,
    });
  } catch (error) {
    err(`✗ forge-prefs-migrate: unexpected error: ${error.message}\n`);
    if (args.json) process.stdout.write(`${JSON.stringify({ status: 'error', errors: [{ message: error.message }] })}\n`);
    return 1;
  }
  if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  for (const layer of result.layers || []) {
    if (layer.action === 'skipped') err(`• ${layer.name}: skipped (${layer.reason})\n`);
    else if (layer.action === 'dry-run') err(`• ${layer.name}: would migrate → ${layer.jsoncPath} (gate diff: empty)\n`);
    else if (layer.action === 'migrated') err(`✓ ${layer.name}: migrated → ${layer.jsoncPath} (gate diff: empty; .bak: ${(layer.baks || []).join(', ')})\n`);
    else if (layer.action === 'stop' && layer.reason === 'schema-warnings') err(`✗ ${layer.name}: schema warnings — migration stopped, zero writes\n`);
    else if (layer.action === 'stop') err(`✗ ${layer.name}: resolved diff NON-EMPTY — migration stopped, zero writes\n`);
  }
  if (result.status === 'diff' || result.status === 'rollback') {
    err(`✗ gate STOP (${result.status}): the old and new resolved objects diverge:\n`);
    printDiff(result.diff || [], err);
    if (result.status === 'rollback') err('✗ jsonc rolled back; legacy md files untouched (.bak kept)\n');
  }
  if (result.status === 'schema-warnings' || (result.status === 'rollback' && (result.warnings || []).length > 0)) {
    for (const warning of result.warnings || []) err(`✗ schema warning: ${warning.key}: ${warning.message}\n`);
    err('✗ migration refused to avoid corrupting values; legacy sources and any existing .bak preserved\n');
  } else if (result.status === 'legacy-parse-error') {
    for (const entry of result.errors || []) err(`✗ legacy parse error: ${entry.file || ''} — ${entry.message}\n`);
    err('✗ fix the legacy markdown before migrating — never migrating invented state\n');
  } else if (result.status === 'migrated') {
    err('✓ migration complete — resolved diff old×new: empty (round-trip proven)\n');
  } else if (result.status === 'noop') {
    err('• nothing to migrate (already migrated or no legacy markdown)\n');
  } else if (result.status === 'dry-run') {
    err('• dry-run: no files written\n');
  }
  if (result.status === 'migrated') {
    for (const warning of result.warnings || []) err(`⚠ ${warning}\n`);
  }
  if (result.gitignore && result.gitignore.action === 'would-append') err(`⚠ ${result.gitignore.warning}\n`);
  return exitCodeFor(result.status);
}

module.exports = {
  resolvedDiff,
  activateValues,
  prepareLayer,
  commitLayer,
  migrateLayer,
  migrateAll,
  ensureGitignore,
  setCatalogValue,
  setPreference,
  parseSetExpression,
  layerDescriptors,
  resolveCurrent,
  runCli,
};

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
