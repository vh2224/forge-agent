'use strict';

const vscode = require('vscode');
const model = require('./forge-panel-model');
const snapshot = require('./fixtures/synthetic-work.json');

let activeSubscription;

function activate(context) {
  deactivate();
  const nodes = model.buildNodes(snapshot);
  const provider = Object.freeze({
    getChildren(element) {
      return model.getChildren(nodes, element);
    },
    getTreeItem(element) {
      return model.getTreeItem(element);
    },
  });
  const treeView = vscode.window.createTreeView('forge.work', {
    treeDataProvider: provider,
    canSelectMany: false,
  });
  let disposed = false;
  activeSubscription = {
    dispose() {
      if (disposed) return;
      disposed = true;
      treeView.dispose();
    },
  };
  context.subscriptions.push(activeSubscription);
  return Object.freeze({ provider, treeView });
}

function deactivate() {
  if (activeSubscription) activeSubscription.dispose();
  activeSubscription = undefined;
}

module.exports = { activate, deactivate };
