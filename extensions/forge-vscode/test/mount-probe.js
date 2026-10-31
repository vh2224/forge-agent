'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// This runner is a development-test entrypoint, never part of extension.js's imports.
function resultTarget(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('mount-result-target-invalid');
  const temp = fs.realpathSync.native(os.tmpdir());
  const target = path.resolve(value);
  const relative = path.relative(temp, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('mount-result-outside-temp');
  const parts = relative.split(path.sep);
  if (!/^forge-vscode-probe-[A-Za-z0-9]+$/.test(parts[0]) || parts.length !== 2 || parts[1] !== 'mount-result.json') {
    throw new Error('mount-result-not-owned');
  }
  let current = temp;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink() || fs.realpathSync.native(current) !== current) throw new Error('mount-result-link');
  }
  if (fs.existsSync(target)) throw new Error('mount-result-already-exists');
  return target;
}

async function run() {
  const target = resultTarget(process.env.FORGE_VSCODE_MOUNT_RESULT);
  const vscode = require('vscode');
  const result = {
    schema_version: 2, version: vscode.version, app_name: vscode.env.appName,
    app_host: vscode.env.appHost, ui_kind: vscode.env.uiKind,
    extension_found: false, extension_active: false, container_revealed: false,
    view_visible: false, panel_nodes: 0, panel_status: null, panel_reason: null,
    panel_stable_sha256: null, panel_generated_at: null, reason: 'extension-missing',
  };
  try {
    const extension = vscode.extensions.getExtension('forge-agent.forge-vscode');
    result.extension_found = Boolean(extension);
    if (extension) {
      const api = await extension.activate();
      result.extension_active = extension.isActive === true;
      await vscode.commands.executeCommand('workbench.view.extension.forge');
      result.container_revealed = true;
      const deadline = Date.now() + 10000;
      while (api?.treeView?.visible !== true && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      result.view_visible = api?.treeView?.visible === true;
      let timer;
      try {
        await Promise.race([api.refresh(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('panel-refresh-timeout')), 30000);
        })]);
      } finally { clearTimeout(timer); }
      const state = api.state();
      const children = await api.provider.getChildren();
      result.panel_nodes = Array.isArray(children) ? children.length : 0;
      // Closed values only; never serialize labels, work identities or node text.
      result.panel_status = ['ok', 'empty', 'unavailable', 'invalid'].includes(state?.status) ? state.status : null;
      const { STATE_REASONS } = require('../../../scripts/forge-panel-source');
      result.panel_reason = Object.hasOwn(STATE_REASONS, state?.reason) ? state.reason : null;
      result.panel_stable_sha256 = typeof state?.stable_sha256 === 'string'
        && /^[a-f0-9]{64}$/.test(state.stable_sha256) ? state.stable_sha256 : null;
      result.panel_generated_at = typeof state?.generated_at === 'string'
        && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(state.generated_at)
        && Number.isFinite(Date.parse(state.generated_at))
        && new Date(state.generated_at).toISOString() === state.generated_at ? state.generated_at : null;
      result.reason = 'observed';
    }
  } catch (_) {
    result.reason = 'extension-observation-failed';
  }
  // Revalidate immediately before exclusive creation. Never overwrite a prior result.
  resultTarget(target);
  fs.writeFileSync(target, JSON.stringify(result) + '\n', { encoding: 'utf8', flag: 'wx' });
}

module.exports = { run, resultTarget };
