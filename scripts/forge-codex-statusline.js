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

// Read statement boundaries without interpreting TOML values. Comments and
// quoted values cannot introduce keys/tables, including inside multiline arrays.
// Multiline strings and escaped keys remain a manual merge, as before.
function statements(current) {
  const result = [];
  let start = current.startsWith('\uFEFF') ? 1 : 0;
  let code = '', quote = '', comment = false;
  const brackets = [];
  for (let i = start; i < current.length; i++) {
    const char = current[i];
    if (comment && char !== '\n') continue;
    if (quote) {
      if (char === '\n' || char === '\r') return null;
      code += char;
      if (quote === '"' && char === '\\') {
        if (++i >= current.length || /[\r\n]/.test(current[i])) return null;
        code += current[i];
      } else if (char === quote) quote = '';
      continue;
    }
    if (char === '#' && !comment) { comment = true; continue; }
    if (char === '\n') {
      comment = false;
      if (!brackets.length) {
        if (code.trim()) result.push({ code: code.trim(), start, end: i + 1 });
        start = i + 1;
        code = '';
      } else code += '\n';
      continue;
    }
    if (char === '"' || char === "'") {
      if (current.slice(i, i + 3) === char.repeat(3)) return null;
      quote = char;
    } else if (char === '[' || char === '{') brackets.push(char);
    else if (char === ']' || char === '}') {
      if (brackets.pop() !== (char === ']' ? '[' : '{')) return null;
    }
    code += char;
  }
  if (quote || brackets.length) return null;
  if (code.trim()) result.push({ code: code.trim(), start, end: current.length });
  return result;
}

function keyPath(code) {
  const parts = [];
  const key = /^\s*(?:([A-Za-z0-9_-]+)|"([^"\\]*)"|'([^']*)')\s*/;
  while (code) {
    const match = key.exec(code);
    if (!match) return null;
    parts.push(match[1] ?? match[2] ?? match[3]);
    code = code.slice(match[0].length);
    if (!code) return parts;
    if (!code.startsWith('.')) return null;
    code = code.slice(1);
    if (!code.trim()) return null;
  }
  return null;
}

// This is a conservative, additive editor, not a TOML serializer. Keep every
// existing byte and decline ambiguous syntax rather than rewriting user config.
function addDefaultStatusLine(current) {
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const conflict = { content: current, conflict: true, reason: 'status-line-manual-merge' };
  const entries = statements(current);
  if (!entries) return conflict;
  let section = [], header = null, preserved = false, ambiguous = false, cannotAdd = false;
  for (const entry of entries) {
    if (entry.code.startsWith('[')) {
      const table = /^(\[\[?)([\s\S]*?)(\]\]?)$/.exec(entry.code);
      if (!table || table[1].length !== table[3].length) return conflict;
      section = keyPath(table[2]);
      if (!section) return conflict;
      if (section[0] === 'tui') {
        if (section.length !== 1 || table[1] !== '[' || header) ambiguous = true;
        else header = entry;
      }
      continue;
    }
    // '=' inside a quoted key is not an assignment separator.
    const binding = /^((?:"[^"\\]*"|'[^']*'|[^="'])+)=/.exec(entry.code);
    const keys = binding && keyPath(binding[1]);
    if (!keys) return conflict;
    const path = [...section, ...keys];
    if (path.length === 2 && path[0] === 'tui' && path[1] === 'status_line') preserved = true;
    else if (path[0] === 'tui' && (path[1] === 'status_line' || !section.length)) cannotAdd = true;
  }
  if (ambiguous) return conflict;
  if (preserved) return { content: current, reason: 'status-line-preserved' };
  if (cannotAdd) return conflict;
  if (header) {
    const end = header.end;
    const separator = current.slice(header.start, end).endsWith('\n') ? '' : eol;
    return { content: current.slice(0, end) + separator + assignment + eol + current.slice(end), reason: 'status-line-added' };
  }
  // Root dotted assignment can coexist with other sections and preserves even
  // files without a trailing newline. Keep a BOM at the start when present.
  const bom = current.startsWith('\uFEFF') ? '\uFEFF' : '';
  return { content: bom + `tui.${assignment}${eol}` + current.slice(bom.length), reason: 'status-line-added' };
}

module.exports = { DEFAULT_STATUS_LINE, addDefaultStatusLine };
