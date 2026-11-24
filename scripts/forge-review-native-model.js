'use strict';
// Review models belong to review, not the execution tier resolver. A native
// fallback resolves the explicit model of the actually observed reviewer.
const fs = require('fs');
const crypto = require('crypto');
const native = require('./forge-native-invocation');
function refuse(code) { return { ok: false, reason_code: code, model: null, model_argument: null }; }
function boundedRegular(file, oneLink = true) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || oneLink && before.nlink !== 1) throw new Error('source-invalid');
  const io = Object.create(fs);
  io.openSync = target => fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const read = require('./forge-autonomy-sources').readBoundedStableFile(file, 1024 * 1024, { expectedReal: fs.realpathSync.native(file), io });
  const after = fs.lstatSync(file);
  if (read.error || !after.isFile() || after.isSymbolicLink() || oneLink && (read.stat.nlink !== 1 || after.nlink !== 1)
    || [read.stat, after].some(stat => before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size
      || before.mtimeMs !== stat.mtimeMs || before.ctimeMs !== stat.ctimeMs)) throw new Error('source-changed');
  return { bytes: read.buffer, before, after };
}
function resolve(options = {}) {
  const binding = options.binding;
  if (!binding || binding.agentType !== 'forge-reviewer') return refuse('review-native-model-binding-required');
  let bytes, before, after;
  try {
    ({ bytes, before, after } = boundedRegular(binding.agentPath));
  } catch { return refuse('review-native-model-source-invalid'); }
  const observed = native.observeClaudeAgentBinding(binding);
  if (!observed.ok) return refuse(observed.reason_code);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (hash !== observed.source_fingerprint.replace(/^sha256:/, '') || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.isSymbolicLink() || after.nlink !== 1)
    return refuse('review-native-model-source-changed');
  const frontmatter = bytes.toString('utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  const models = frontmatter && [...frontmatter.matchAll(/^model\s*:\s*(.+?)\s*$/gm)];
  if (!models || models.length !== 1) return refuse('review-native-model-missing');
  const model = models[0][1].replace(/^(?:"([^"]*)"|'([^']*)')$/, (_m, a, b) => a ?? b);
  const aliases = require('./forge-model-alias');
  if (!/^(?:claude-[a-z0-9][a-z0-9._:+\[\]-]*|haiku|sonnet|opus|fable)$/i.test(model)
      || aliases.isMalformedId(model) || aliases.modelFamily(model) !== 'claude' || !aliases.modelToAlias(model).mapped)
    return refuse('review-native-model-incompatible');
  const effort = require('./forge-review-effort').resolveReviewEffort({ cwd: options.cwd,
    prefs: options.prefs, leg: options.leg || 'challenge', engine: 'claude', transport: 'claude-native',
    model, binding, capabilities: options.capabilities });
  if (effort.refusal) return refuse(effort.refusal.code);
  const route = { config_ok: true, dispatch_allowed: true, host_runtime: 'claude', worker_mode: 'native',
    dispatch_engine: 'claude', resolved_worker_engine: 'claude', model, model_resolved: model,
    effort: effort.effort_resolved || observed.effort };
  const checked = native.preflightNativeBinding({ hostRuntime: 'claude', resolvedDispatch: route,
    activeCapabilities: options.capabilities, agentType: 'forge-reviewer', effortBinding: observed });
  if (!checked.ok) return refuse(checked.reason_code);
  return { ok: true, reason_code: 'review-native-model-ready', model,
    model_argument: checked.telemetry.model_argument, external_model: options.externalModel || null,
    source_fingerprint: observed.source_fingerprint, effort, provider_called: false };
}
function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--input') throw new Error('usage: --input <host-observed JSON>');
  const result = resolve(JSON.parse(boundedRegular(argv[1], false).bytes.toString('utf8')));
  process.stdout.write(JSON.stringify(result) + '\n'); return result.ok ? 0 : 3;
}
module.exports = { resolve };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch { process.stderr.write('forge-review-native-model: input-invalid\n'); process.exitCode = 2; }
}
