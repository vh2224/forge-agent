#!/usr/bin/env node
'use strict';

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
const VERSION = '4.19.0';
const LEGACY_VERSION = '3.1.4';

module.exports = { VERSION, LEGACY_VERSION };
