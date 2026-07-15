#!/usr/bin/env node
/**
 * Exibe a cadeia de modelos resolvida para um tier, incluindo os fallbacks
 * que não podem ser usados por não possuírem alias.
 */

'use strict';

const { readTierChain } = require('./forge-tier-chain.js');

const VALID_TIERS = ['light', 'standard', 'heavy', 'max'];
const USAGE = 'Uso: node scripts/forge-tier-explain.js --tier <light|standard|heavy|max> [--cwd <dir>] [--json]\n';

function formatMember(member) {
  const alias = member.mapped ? member.alias : '—';
  const status = member.mapped ? '' : ' (pulado — sem alias)';
  return `id: ${member.id} | alias: ${alias} | mapped: ${member.mapped}${status}`;
}

function formatChain(chain, tier) {
  const lines = [];
  if (tier) lines.push(`Cadeia resolvida do tier ${tier}:`);

  if (!Array.isArray(chain) || chain.length === 0) {
    lines.push('Nenhum modelo resolvido.');
    return lines.join('\n');
  }

  lines.push(`PRIMARY: ${formatMember(chain[0])}`);
  chain.slice(1).forEach((member, index) => {
    lines.push(`FALLBACK ${index + 1}: ${formatMember(member)}`);
  });
  return lines.join('\n');
}

function parseArgs(args) {
  const options = { tier: null, cwd: process.cwd(), json: false };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json') {
      options.json = true;
    } else if (
      (args[i] === '--tier' || args[i] === '--cwd') &&
      args[i + 1] !== undefined &&
      !args[i + 1].startsWith('--')
    ) {
      const key = args[i] === '--tier' ? 'tier' : 'cwd';
      options[key] = args[++i];
    } else {
      return null;
    }
  }
  return options;
}

module.exports = { formatChain };

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  if (!options || !VALID_TIERS.includes(options.tier)) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
  } else {
    const chain = readTierChain(options.tier, options.cwd);
    const output = options.json
      ? JSON.stringify(chain)
      : formatChain(chain, options.tier);
    process.stdout.write(`${output}\n`);
  }
}
