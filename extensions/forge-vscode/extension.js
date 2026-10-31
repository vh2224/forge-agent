'use strict';

const vscode = require('vscode');
const model = require('./forge-panel-model');
const reader = require('./forge-panel-reader');

let activeSubscription;

// Only local file folders reach the reader; other schemes are never read.
function workspaceScope() {
  const folders = Array.isArray(vscode.workspace.workspaceFolders) ? vscode.workspace.workspaceFolders : [];
  if (!folders.length) return { reason: 'no-workspace' };
  const local = folders.filter(folder => folder && folder.uri && folder.uri.scheme === 'file'
    && typeof folder.uri.fsPath === 'string' && folder.uri.fsPath).map(folder => folder.uri.fsPath);
  return local.length ? { folders: local } : { reason: 'workspace-not-local' };
}

function activate(context) {
  deactivate();
  const emitter = new vscode.EventEmitter();
  const panelReader = reader.createReader();
  let nodes = model.readingNodes();
  let rendered = null;
  let sequence = 0;
  let disposed = false;

  const provider = Object.freeze({
    onDidChangeTreeData: emitter.event,
    getChildren(element) {
      return model.getChildren(nodes, element);
    },
    getTreeItem(element) {
      return model.getTreeItem(element);
    },
  });

  function render(result, ticket) {
    // A newer request owns the view; coalesced callers share its result.
    if (disposed || !result || ticket !== sequence) return;
    rendered = result;
    nodes = model.buildNodes(result);
    emitter.fire(undefined);
  }

  function read(trigger) {
    if (disposed) return Promise.resolve();
    const ticket = ++sequence;
    const scope = workspaceScope();
    if (!scope.folders) {
      render(model.localResult(scope.reason), ticket);
      return Promise.resolve();
    }
    return panelReader.read(scope.folders, { trigger }).then(result => render(result, ticket));
  }

  function state() {
    if (!rendered) {
      return Object.freeze({ status: 'pending', reason: 'reading',
        counts: Object.freeze({ works: 0, agents: 0, pending: 0, evidence: 0 }), stable_sha256: null, generated_at: null });
    }
    return model.summarize(rendered);
  }

  const treeView = vscode.window.createTreeView('forge.work', {
    treeDataProvider: provider,
    canSelectMany: false,
  });
  const command = vscode.commands.registerCommand('forge.work.refresh', () => read('manual'));
  const visibility = treeView.onDidChangeVisibility(event => {
    if (event && event.visible) read('visible');
  });
  const windowState = vscode.window.onDidChangeWindowState(event => {
    if (event && event.focused && treeView.visible) read('focus');
  });
  const foldersChange = vscode.workspace.onDidChangeWorkspaceFolders(() => read('folders'));
  const resources = [foldersChange, windowState, visibility, command, treeView, emitter];

  activeSubscription = {
    dispose() {
      if (disposed) return;
      disposed = true;
      panelReader.dispose();
      for (const resource of resources) {
        try { resource.dispose(); } catch (_) { /* keep disposing the rest */ }
      }
    },
  };
  context.subscriptions.push(activeSubscription);
  read('activation');
  return Object.freeze({ provider, treeView, state, refresh: () => read('manual') });
}

function deactivate() {
  if (activeSubscription) activeSubscription.dispose();
  activeSubscription = undefined;
}

module.exports = { activate, deactivate };
