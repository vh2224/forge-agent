#!/usr/bin/env node
'use strict';

// One product release line is shared by the installer and both host adapters.
// LEGACY_VERSION is deliberately retained for non-destructive Claude upgrades.
const VERSION = '4.8.0';
const LEGACY_VERSION = '3.1.4';

module.exports = { VERSION, LEGACY_VERSION };
