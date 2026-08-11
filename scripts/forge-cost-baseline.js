#!/usr/bin/env node
'use strict';

/**
 * Cost baseline harness for GSD dispatch units.
 *
 * Renders every unit_type in TEMPLATE_FILES with deterministic, fixed inputs
 * (never read from disk memories/standards) and reports rendered_tokens vs.
 * template_tokens per unit, plus real telemetry via forge-tokens.aggregate
 * when available. Used to capture a before/after snapshot of context cost
 * around GSD control changes.
 */

const fs = require('fs');
const path = require('path');
const { countTokens, aggregate } = require('./forge-tokens.js');
const { TEMPLATE_FILES, renderPrompt } = require('./forge-prompt.js');

// Deterministic inputs shared across unit types — mirrors
// forge-context-budget.test.js:39-60 baseOptions(). Never derived from disk.
// `label` is deliberately NOT a parameter here: it used to be interpolated into
// `description`, which made two runs with different labels measure different
// prompt text (`--label before` 5977 vs `--label after` 5976 tokens, a long
// label +254). The label is result metadata only — the measured input is fixed.
function baseOptions(cwd, unitType) {
  return {
    cwd,
    unitType,
    milestoneId: 'M001',
    sliceId: 'S01',
    taskId: 'T01',
    description: 'Cost baseline measurement',
    unitEffort: 'medium',
    thinking: 'adaptive',
    autoCommit: false,
    milestoneCleanup: 'keep',
    planCheckMode: 'advisory',
    mustHavesCheckResults: 'pass: 4\nwarn: 0\nfail: 0',
    memories: ['Use deterministic prompt artifacts', 'Keep context bounded'],
    standards: {
      CS_LINT: 'npm test',
      CS_STRUCTURE: 'Source files live in scripts/.',
      CS_RULES: 'Keep scripts zero-dependency and cross-platform.',
    },
  };
}

function templateTokensFor(cwd, filename) {
  const templatePath = path.join(cwd, 'shared', 'templates', 'dispatch', filename);
  const content = fs.readFileSync(templatePath, 'utf8');
  return countTokens(content);
}

/**
 * measureBaseline(cwd, opts) -> {
 *   generated_at, label, cwd, inputs: 'deterministic',
 *   by_unit_type: { '<unit>': { rendered_tokens, template_tokens } },
 *   totals: { rendered_tokens, unit_types },
 *   telemetry: <forge-tokens.aggregate(cwd, {milestoneId}) or null>,
 *   errors: [ { unit_type, message } ],
 * }
 */
function measureBaseline(cwd, opts) {
  const options = opts || {};
  const resolvedCwd = path.resolve(cwd || process.cwd());
  const label = options.label || 'baseline';

  const byUnitType = {};
  const errors = [];
  let totalRenderedTokens = 0;

  for (const unitType of Object.keys(TEMPLATE_FILES)) {
    try {
      const rendered = renderPrompt(baseOptions(resolvedCwd, unitType));
      const templateTokens = templateTokensFor(resolvedCwd, TEMPLATE_FILES[unitType]);
      byUnitType[unitType] = {
        rendered_tokens: rendered.input_tokens,
        template_tokens: templateTokens,
      };
      totalRenderedTokens += rendered.input_tokens;
    } catch (error) {
      errors.push({ unit_type: unitType, message: error.message });
    }
  }

  let telemetry = null;
  try {
    telemetry = aggregate(resolvedCwd, { milestoneId: options.milestoneId || null });
  } catch (_) {
    telemetry = null;
  }

  return {
    generated_at: new Date().toISOString(),
    label,
    cwd: resolvedCwd,
    inputs: 'deterministic',
    by_unit_type: byUnitType,
    totals: {
      rendered_tokens: totalRenderedTokens,
      unit_types: Object.keys(byUnitType).length,
    },
    telemetry,
    errors,
  };
}

function renderMarkdown(result) {
  const lines = [];
  lines.push(`| unit_type | rendered_tokens | template_tokens |`);
  lines.push(`| --- | --- | --- |`);
  const unitTypes = Object.keys(result.by_unit_type).sort();
  for (const unitType of unitTypes) {
    const row = result.by_unit_type[unitType];
    lines.push(`| ${unitType} | ${row.rendered_tokens} | ${row.template_tokens} |`);
  }
  lines.push(`| **totals** | **${result.totals.rendered_tokens}** | — |`);

  if (result.telemetry && result.telemetry.has_telemetry) {
    lines.push('');
    lines.push('Telemetry (real dispatch history — NOT deterministic, do not compare directly to the table above):');
    lines.push('');
    lines.push(`| phase | count | input | output |`);
    lines.push(`| --- | --- | --- | --- |`);
    const phases = Object.keys(result.telemetry.by_phase || {});
    for (const phase of phases) {
      const p = result.telemetry.by_phase[phase];
      lines.push(`| ${phase} | ${p.count} | ${p.input} | ${p.output} |`);
    }
  }

  if (result.errors.length > 0) {
    lines.push('');
    lines.push('Errors:');
    for (const err of result.errors) {
      lines.push(`- ${err.unit_type}: ${err.message}`);
    }
  }

  return lines.join('\n') + '\n';
}

function parseArgs(argv) {
  const booleanFlags = new Set(['json', 'markdown', 'help']);
  const valueFlags = new Set(['cwd', 'label', 'milestone']);
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (booleanFlags.has(key)) {
      args[key] = true;
      continue;
    }
    if (!valueFlags.has(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
    if (i + 1 >= argv.length) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = argv[++i];
  }
  return args;
}

function printUsage() {
  process.stdout.write(`Usage:
  node forge-cost-baseline.js [--json] [--cwd <dir>] [--label <text>] [--milestone <id>]
  node forge-cost-baseline.js --markdown [--cwd <dir>] [--label <text>] [--milestone <id>]

Options:
  --json        Print the full measurement result as JSON (default mode)
  --markdown    Print a markdown table instead of JSON
  --cwd DIR     Project root to measure (default: cwd)
  --label TEXT  Free-text label stamped into the result (default: baseline)
  --milestone ID  Milestone ID passed to forge-tokens.aggregate for telemetry
  --help        Show this message
`);
}

function cliMain(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }
  const cwd = args.cwd || process.cwd();
  const result = measureBaseline(cwd, { label: args.label, milestoneId: args.milestone });
  if (args.markdown) {
    process.stdout.write(renderMarkdown(result));
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  return 0;
}

if (require.main === module) {
  try {
    const code = cliMain(process.argv.slice(2));
    process.exit(code);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}

module.exports = { measureBaseline, renderMarkdown, _private: { baseOptions, templateTokensFor } };
