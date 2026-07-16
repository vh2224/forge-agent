#!/usr/bin/env node
/**
 * Lints every configured routing cell without duplicating the routing parser.
 * Exit 1 means invalid configuration; unexpected CLI failures are reported but
 * deliberately exit 0, following the operator-facing Forge CLI contract.
 */

'use strict';

const { readRoutingConfig } = require('./forge-routing');
const { modelToAlias, modelFamily } = require('./forge-model-alias');

function memberDetails(id) {
  const aliasInfo = modelToAlias(id);
  return {
    id,
    engine: modelFamily(id),
    alias: aliasInfo.alias,
    mapped: aliasInfo.mapped,
  };
}

function finding(severity, code, message, details) {
  return Object.assign({ severity, code, message }, details || {});
}

function lintRouting(cwd) {
  const config = readRoutingConfig(cwd);
  const report = {
    present: config.present,
    ok: config.ok,
    errors: [],
    warnings: [],
    cells: [],
  };

  if (!config.present) return report;

  if (!config.ok) {
    report.errors.push(
      finding('error', 'routing-parse-error', 'O bloco routing: não pôde ser analisado.')
    );
    return report;
  }

  if (!Object.prototype.hasOwnProperty.call(config.routing, 'default')) {
    report.warnings.push(
      finding(
        'warning',
        'missing-default-domain',
        'O domínio default está ausente; células ausentes degradam para o routing legado.'
      )
    );
  }

  for (const domain of Object.keys(config.routing)) {
    const phases = config.routing[domain];
    for (const phase of Object.keys(phases)) {
      const phaseConfig = phases[phase];
      const fallback = phaseConfig.fallback == null
        ? null
        : memberDetails(phaseConfig.fallback);
      const tiers = Object.keys(phaseConfig).filter((key) => key !== 'fallback');

      if (tiers.length === 0) {
        report.warnings.push(
          finding(
            'warning',
            'phase-without-tiers',
            'A fase não possui nenhum tier configurado.',
            { domain, phase }
          )
        );

        if (fallback && (fallback.engine !== 'claude' || !fallback.mapped)) {
          report.errors.push(
            finding(
              'error',
              'invalid-fallback',
              'O fallback deve pertencer à família claude e possuir alias mapeado.',
              { domain, phase, id: fallback.id }
            )
          );
        }
      }

      for (const tier of tiers) {
        const chain = phaseConfig[tier].map(memberDetails);
        const cell = { domain, phase, tier, chain, fallback, findings: [] };

        for (const member of chain) {
          let item = null;
          if (member.engine === 'gemini') {
            item = finding(
              'warning',
              'phase-unsupported-family',
              'A família gemini não possui worker nativo para esta fase.',
              { id: member.id }
            );
          } else if (member.engine !== 'gpt' && !member.mapped) {
            item = finding(
              'error',
              'unmapped-chain-member',
              'O membro da cadeia não possui alias executável.',
              { id: member.id }
            );
          }
          if (item) cell.findings.push(item);
        }

        if (fallback && (fallback.engine !== 'claude' || !fallback.mapped)) {
          cell.findings.push(
            finding(
              'error',
              'invalid-fallback',
              'O fallback deve pertencer à família claude e possuir alias mapeado.',
              { id: fallback.id }
            )
          );
        }

        for (const item of cell.findings) {
          const contextual = Object.assign(
            { domain, phase, tier },
            item
          );
          if (item.severity === 'error') report.errors.push(contextual);
          else report.warnings.push(contextual);
        }
        report.cells.push(cell);
      }
    }
  }

  return report;
}

function formatMember(member) {
  return member.id + ' (engine=' + (member.engine || 'unknown') +
    ', alias=' + (member.alias || 'none') + ', mapped=' + member.mapped + ')';
}

function formatText(report) {
  const lines = ['Forge routing lint'];
  if (!report.present) {
    lines.push('', 'Nenhum bloco routing: configurado.');
  } else if (!report.ok) {
    lines.push('', 'O bloco routing: contém erro de parse.');
  }

  for (const cell of report.cells) {
    lines.push('', 'Célula: ' + cell.domain + ' / ' + cell.phase + ' / ' + cell.tier);
    lines.push('  domain: ' + cell.domain);
    lines.push('  phase: ' + cell.phase);
    lines.push('  tier: ' + cell.tier);
    lines.push('  chain:');
    for (const member of cell.chain) lines.push('    - ' + formatMember(member));
    lines.push('  fallback: ' + (cell.fallback ? formatMember(cell.fallback) : '(ausente)'));
    lines.push('  findings:');
    if (cell.findings.length === 0) lines.push('    - nenhum');
    for (const item of cell.findings) {
      lines.push('    - ' + item.severity + ' ' + item.code + ': ' + item.message);
    }
  }

  const globalFindings = report.errors.concat(report.warnings)
    .filter((item) => item.domain === undefined);
  if (globalFindings.length > 0) {
    lines.push('', 'Findings globais:');
    for (const item of globalFindings) {
      lines.push('  - ' + item.severity + ' ' + item.code + ': ' + item.message);
    }
  }
  lines.push('', 'Resumo: ' + report.errors.length + ' erro(s), ' +
    report.warnings.length + ' warning(s).');
  return lines.join('\n') + '\n';
}

function parseArgs(argv) {
  const options = { cwd: process.cwd(), json: false, lint: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lint') options.lint = true;
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--cwd' && argv[i + 1] !== undefined) options.cwd = argv[++i];
  }
  return options;
}

function runCli(argv) {
  try {
    const options = parseArgs(argv);
    const report = lintRouting(options.cwd);
    process.stdout.write(options.json ? JSON.stringify(report) + '\n' : formatText(report));
    return report.errors.length > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write('forge-routing-lint: erro interno: ' + error.message + '\n');
    return 0;
  }
}

module.exports = { lintRouting, formatText, parseArgs, runCli };

if (require.main === module) process.exitCode = runCli(process.argv.slice(2));
