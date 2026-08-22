#!/usr/bin/env node
// forge-projection-self.js — refusing to project a file onto its own source.
//
// WHY THIS EXISTS
// ---------------
// `projectRoot` defaults to the repo being installed from
// (`forge-claude-renderer.js` § roots). In every ordinary install that is
// harmless: the operator installs FROM the forge-agent clone INTO their own
// project, so `project/CLAUDE.md` resolves somewhere else entirely. But when the
// project IS the forge-agent clone — the dogfood loop, and the only way this
// repo is ever developed — that same target resolves to `<repo>/CLAUDE.md`,
// which is the manifest's own declared input for `claude-instructions`.
//
// The installer then rewrites the canonical source with a rendered copy of
// itself, stamping the `<!-- forge-source: -->` marker onto the file that IS the
// source. Measured on 2026-08-22, installing v4.21.1 from this repo: the summary
// reported `[adopted] .../forge-agent/CLAUDE.md`, and the ownership record now
// claims the source as a managed destination.
//
// THE DAMAGE IS NOT THE TWO LINES
// -------------------------------
// It is circular. The app's *Atualizar* runs `git pull --ff-only`, and the
// precheck refuses to start on a dirty tree (`UpdateCore.swift` §
// UpdatePrecheck) — correctly, because moving an operator's work aside to
// install an update is damage. So an install performed from this repo leaves the
// tree dirty and thereby BLOCKS the next update, with a diff nobody wrote. The
// operator is told to resolve uncommitted changes that the installer authored.
//
// WHAT THIS REFUSES, AND WHAT IT DOES NOT
// ---------------------------------------
// Only the exact identity: a destination that resolves to the SAME FILE as the
// repo input it was rendered from. Not "a destination inside the repo" — the
// repo is a legitimate project root, and its `.gsd/`, its skills and its agents
// are legitimate destinations. Not "a destination whose name matches a source" —
// two different files may share a basename. Comparison is by resolved real path,
// so a symlinked clone and a case-insensitive filesystem both answer correctly.
//
// A synthesized artifact whose `source` names no file on disk (the Codex
// `AGENTS.md`, the TOML wrappers) can never be self-projection, and says so by
// returning false rather than by not being asked.
//
// Exports:
//   REASON              → the stable reason string for reports
//   isSelfProjection({ repo, source, destination }) → boolean
//
// Zero npm dependencies — Node built-ins only.

'use strict';

const fs = require('fs');
const path = require('path');

const REASON = 'source_is_destination';

// Resolve through symlinks when the path exists. A clone reached through a
// symlinked parent (/tmp → /private/tmp on macOS is the common one) would
// otherwise compare unequal to itself.
function realOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isSelfProjection({ repo, source, destination } = {}) {
  if (!repo || !source || !destination) return false;
  // A destination that does not exist yet cannot BE the source: if the two were
  // the same file, the source's own existence would have made it exist.
  const destinationReal = realOrNull(path.resolve(destination));
  if (destinationReal === null) return false;
  // `source` is repo-relative for manifest-driven artifacts and a bare label for
  // synthesized ones. A label resolves to nothing on disk and answers false.
  const sourceReal = realOrNull(path.resolve(repo, source));
  if (sourceReal === null) return false;
  return sourceReal === destinationReal;
}

module.exports = { REASON, isSelfProjection };
