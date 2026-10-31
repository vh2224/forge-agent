#!/usr/bin/env node
/**
 * forge-phases.js
 *
 * Renders the live phase-resolution table from the actual dispatch resolver.
 * This deliberately has no model, tier, alias, or routing defaults of its own:
 * the resolver and phase mapper remain the single sources of truth.
 */

'use strict';

const { resolveDispatch, TIER_DEFAULTS } = require('./forge-dispatch-resolve.js');
const { mapPhase, readRoutingConfig } = require('./forge-routing.js');
const { readPrefs, validatePrefs, loadSchema } = require('./forge-prefs.js');

function domainsFor(cwd) {
  try {
    const config = readRoutingConfig(cwd);
    const keys = config && config.routing && typeof config.routing === 'object'
      ? Object.keys(config.routing) : [];
    return ['default', ...keys.filter((key) => key !== 'default')];
  } catch {
    return ['default'];
  }
}

function configKey(contract, unitType) {
  const phase = mapPhase(unitType);
  if (contract.route_source === 'routing') {
    return `routing.${contract.domain}.${phase}.${contract.tier}`;
  }
  if (contract.route_source === 'frontmatter') {
    return 'frontmatter tier:/worker: do T##-PLAN.md';
  }
  return `tier_models.${contract.tier}`;
}

function makeRow(unitType, domain, cwd) {
  const contract = resolveDispatch({ unitType, domain, cwd });
  const routable = mapPhase(unitType) !== null;
  return {
    unit_type: unitType,
    domain: routable ? contract.domain : '—',
    domain_used: contract.domain,
    domain_input: contract.domain_input,
    tier: contract.tier,
    model: contract.model,
    alias: contract.alias,
    engine: contract.engine,
    route_source: contract.route_source,
    config_key: configKey(contract, unitType),
    routable,
    inherits_default: routable && contract.domain_input !== contract.domain,
  };
}

function buildPhases(cwd) {
  const resolvedCwd = cwd || process.cwd();
  const domains = domainsFor(resolvedCwd);
  const unit_types = Object.keys(TIER_DEFAULTS);
  const rows = [];
  for (const unitType of unit_types) {
    if (mapPhase(unitType) === null) {
      rows.push(makeRow(unitType, 'default', resolvedCwd));
    } else {
      for (const domain of domains) rows.push(makeRow(unitType, domain, resolvedCwd));
    }
  }
  const warnings = validatePrefs(readPrefs(resolvedCwd).prefs, loadSchema())
    .filter(warning => warning.key === 'routing' || warning.key.startsWith('routing.'));
  return { domains, unit_types, rows, warnings };
}

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}

function renderPhases(cwd) {
  const table = buildPhases(cwd);
  const headers = ['unit_type', 'domínio', 'tier', 'modelo (alias)', 'engine', 'onde configurar'];
  const values = table.rows.map((row) => [
    row.unit_type,
    `${row.routable ? row.domain_input : row.domain}${row.inherits_default ? ' (herda default)' : ''}`,
    row.tier,
    row.alias ? `${row.model} (${row.alias})` : `${row.model} (${row.engine})`,
    row.engine,
    row.config_key,
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...values.map((row) => row[index].length)));
  const line = (columns) => columns.map((value, index) => pad(value, widths[index])).join(' | ');
  const hasNonRoutable = table.rows.some((row) => !row.routable);
  const notes = [];
  if (hasNonRoutable) {
    notes.push('Nota: fases não roteáveis nunca passam pelo bloco routing; usam apenas tier_models.');
  }
  notes.push(
    `Nota: plan-milestone tem tier fixo ${TIER_DEFAULTS['plan-milestone']}, mas seu modelo é configurável em tier_models.${TIER_DEFAULTS['plan-milestone']}.`,
  );
  if (table.warnings.length) {
    const { plainText } = require('./forge-sidecar-identity');
    notes.push('Avisos de routing:', ...table.warnings.map(warning => `- ${plainText(warning.message, { limit: 500 })}`));
  }
  return [
    'Resolução viva por fase (derivada do resolver do workspace):',
    line(headers),
    widths.map((width) => '-'.repeat(width)).join('-|-'),
    ...values.map(line),
    '',
    ...notes,
  ].join('\n');
}

function runCli(argv) {
  try {
    const args = argv || [];
    let cwd = process.cwd();
    let asJson = false;
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--cwd' && args[i + 1] !== undefined) { cwd = args[i + 1]; i += 1; }
      else if (args[i] === '--json') asJson = true;
      else if (args[i] !== '--phases') throw new Error(`flag desconhecida: ${args[i]}`);
    }
    process.stdout.write(asJson ? `${JSON.stringify(buildPhases(cwd))}\n` : `${renderPhases(cwd)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`forge-phases error: ${error.message}\n`);
    return 1;
  }
}

module.exports = { domainsFor, buildPhases, renderPhases, runCli };

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
