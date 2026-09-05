'use strict';

const DEFAULT_STATUS_LINE = Object.freeze([
  'model-with-reasoning', 'fast-mode',
  'context-used', 'context-remaining', 'context-window-size',
  'used-tokens', 'total-input-tokens', 'total-output-tokens',
  'usage-limit', 'secondary-usage-limit',
  'project-name', 'current-dir', 'hostname',
  'thread-title', 'thread-id', 'task-progress',
  'permissions', 'approval-mode',
  'codex-version', 'raw-output',
]);
const assignment = `status_line = ${JSON.stringify(DEFAULT_STATUS_LINE)}`;

// This is a conservative, additive editor, not a TOML serializer. Keep every
// existing byte and decline ambiguous syntax rather than rewriting user config.
function addDefaultStatusLine(current) {
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const active = current.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
  if (/\bstatus_line\b/.test(active)) return { content: current, reason: 'status-line-preserved' };
  if (/"""|'''|\\u[0-9a-f]{4}|\\U[0-9a-f]{8}/i.test(active)) {
    return { content: current, conflict: true, reason: 'status-line-manual-merge' };
  }
  const headers = [...current.matchAll(/^[ \t]*\[[ \t]*(?:tui|"tui"|'tui')[ \t]*\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/gm)];
  // Inline/dotted tables must not be reopened as [tui]. Treat other mentions
  // conservatively as well; the installer reports a conflict for manual review.
  const otherTui = current.replace(/^[ \t]*\[[ \t]*(?:tui|"tui"|'tui')[ \t]*\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/gm, '')
    .split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join('\n');
  if (headers.length > 1 || /\btui\b/.test(otherTui)) {
    return { content: current, conflict: true, reason: 'status-line-manual-merge' };
  }
  if (headers.length === 1) {
    const header = headers[0];
    const end = header.index + header[0].length;
    const separator = header[0].endsWith('\n') ? '' : eol;
    return { content: current.slice(0, end) + separator + assignment + eol + current.slice(end), reason: 'status-line-added' };
  }
  // Root dotted assignment can coexist with other sections and preserves even
  // files without a trailing newline. Keep a BOM at the start when present.
  const bom = current.startsWith('\uFEFF') ? '\uFEFF' : '';
  return { content: bom + `tui.${assignment}${eol}` + current.slice(bom.length), reason: 'status-line-added' };
}

module.exports = { DEFAULT_STATUS_LINE, addDefaultStatusLine };
