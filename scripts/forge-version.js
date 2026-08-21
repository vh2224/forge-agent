#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

// One product release line is shared by the installer and both host adapters.
// LEGACY_VERSION is deliberately retained for non-destructive Claude upgrades.
//
// Esta constante DEVE acompanhar a tag da release. Ela ficou parada em `4.8.0`
// enquanto `v4.9.0` e `v4.10.0` eram tagueadas, então um checkout de `v4.10.0`
// carimbava `4.8.0` no arquivo VERSION e no manifest — a versão que o usuário
// instalava não era a versão que ele baixou. Bumpar aqui exige, no mesmo commit:
//   1. regenerar o golden do renderer PELO RENDER PATH (o marcador de origem
//      embute `version=`, então todo hash de superfície marcada muda);
//   2. atualizar os literais fixados em forge-installer.test.js e
//      forge-package.test.js — eles são propositalmente literais, para que um
//      bump seja um ato consciente e não um efeito colateral.
const FALLBACK_VERSION = '4.20.0';
const LEGACY_VERSION = '3.1.4';

function installedVersion() {
  try {
    const value = fs.readFileSync(path.resolve(__dirname, '..', 'VERSION'), 'utf8').trim();
    return /^\d+\.\d+\.\d+$/.test(value) ? value : null;
  } catch (_) { return null; }
}

function sourceVersion() {
  try {
    const resolution = require('./forge-release-version.js').resolveVersion(path.resolve(__dirname, '..'));
    return resolution.new_tag ? resolution.new_tag.replace(/^v/, '') : null;
  } catch (error) {
    if (error && error.code === 'version-not-git') return null;
    throw error;
  }
}

function archiveVersion(root = path.resolve(__dirname, '..')) {
  const match = /(?:^|[-_])v?(\d+\.\d+\.\d+)$/.exec(path.basename(root));
  return match ? match[1] : null;
}

// Installed cores read the VERSION materialized by the installer. Source clones
// derive the exact prospective/tagged version from Git. The fallback exists only
// for standalone legacy copies that have neither provenance surface.
const VERSION = installedVersion() || sourceVersion() || archiveVersion() || FALLBACK_VERSION;

module.exports = { VERSION, LEGACY_VERSION, FALLBACK_VERSION, installedVersion, sourceVersion, archiveVersion };
