'use strict';

const fs = require('fs');
const path = require('path');
const START = '<!-- forge:interaction:start -->';
const END = '<!-- forge:interaction:end -->';

// Resolved beside the installed script too: no consumer repository dependency.
function contract() {
  return fs.readFileSync(path.join(__dirname, '..', 'shared', 'forge-interaction.md'), 'utf8').trimEnd();
}

function renderBlock(eol = '\n') {
  return [START, contract(), END].join('\n').replace(/\r\n|\n/g, eol);
}

function project(content) {
  // Keep YAML frontmatter on line one. Original workflow bytes remain intact.
  return `${content}${content.endsWith('\n') ? '\n' : '\n\n'}${renderBlock()}\n`;
}

function sync(text) {
  const markers = [];
  let offset = 0, fence = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const opening = /^( {0,3})(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`).test(line)) fence = null;
    } else if (opening) fence = opening[2];
    else if (line.startsWith('<!-- forge:interaction:')) {
      if (line !== START && line !== END) return { malformed: 'interaction-invalid-marker' };
      markers.push({ line, start: offset, end: offset + line.length });
    }
    offset += raw.length + 1;
  }
  if (markers.length && (markers.length !== 2 || markers[0].line !== START || markers[1].line !== END)) {
    return { malformed: 'interaction-malformed-markers' };
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = renderBlock(eol);
  if (markers.length) return { content: text.slice(0, markers[0].start) + block + text.slice(markers[1].end) };
  const padding = !text || text.endsWith(eol + eol) ? '' : text.endsWith(eol) ? eol : eol + eol;
  return { content: text + padding + block + eol };
}

module.exports = { START, END, contract, renderBlock, project, sync };
