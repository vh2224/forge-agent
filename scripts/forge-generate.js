#!/usr/bin/env node
'use strict';

const path = require('path');
const claude = require('./forge-claude-renderer');
const codex = require('./forge-codex-renderer');
const RUNTIMES = Object.freeze(['claude', 'codex', 'both']);
function selected(runtime) { return runtime === 'both' ? ['claude', 'codex'] : [runtime]; }
function parseArgs(argv = process.argv.slice(2)) { const out = { runtime: 'both', repo: path.resolve(__dirname, '..') }; for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === '--runtime') out.runtime = argv[++i] || ''; else if (arg === '--repo') out.repo = path.resolve(argv[++i] || ''); else if (arg === '--claude-home') out.claudeHome = argv[++i]; else if (arg === '--codex-home') out.codexHome = argv[++i]; else if (arg === '--forge-home') out.forgeHome = argv[++i]; else if (arg === '--project-root') out.projectRoot = argv[++i]; else if (arg === '--dry-run') out.dryRun = true; else if (arg === '--update') out.update = true; else if (arg === '--migrate-legacy') out.migrateLegacy = true; else if (arg === '--json') out.json = true; else if (arg === '--help' || arg === '-h') out.help = true; else throw new Error(`opção desconhecida: ${arg}`); } if (!RUNTIMES.includes(out.runtime)) throw new Error(`runtime inválido: ${out.runtime}`); return out; }
function generate(options = {}) {
  const runtime = options.runtime || 'both';
  if (!RUNTIMES.includes(runtime)) throw new Error(`runtime inválido: ${runtime}`);
  const reports = {};
  for (const host of selected(runtime)) {
    const input = { ...options };
    if (host === 'claude') {
      reports.claude = claude.write(input);
    } else {
      // Generation is a production caller, so it pins the native Codex dialect
      // rather than asking every invocation to reconstruct renderer internals.
      reports.codex = codex.write({
        ...input,
        ...codex.PRODUCTION_DISPATCH_DIALECT,
      });
    }
  }
  return {
    runtime,
    selected: selected(runtime),
    reports,
    changed: Object.values(reports).some((report) => report.changed),
    dry_run: Boolean(options.dryRun),
  };
}
function main(argv = process.argv.slice(2), output = process.stdout.write.bind(process.stdout), error = process.stderr.write.bind(process.stderr)) { try { const options = parseArgs(argv); if (options.help) { output('Usage: forge-generate.js --runtime claude|codex|both [--repo DIR] [--dry-run] [--update] [--json]\n'); return 0; } const report = generate(options); output(options.json ? `${JSON.stringify(report)}\n` : `Forge generation ${report.runtime}: ${report.selected.join(', ')}; ${report.changed ? 'changed' : 'no changes'}\n`); return 0; } catch (e) { error(`forge-generate: ${e.message}\n`); return 1; } }
if (require.main === module) process.exitCode = main();
module.exports = { RUNTIMES, selected, parseArgs, generate, main };
