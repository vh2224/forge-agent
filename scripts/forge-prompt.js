#!/usr/bin/env node
'use strict';

/**
 * Deterministic prompt renderer for Forge dispatch units.
 *
 * Templates are resolved from the project before any installed/global copy so
 * the prompt contract stays coupled to the checkout that is being executed.
 * The rendered prompt is materialized atomically under
 * .gsd/forge/prompts/<dispatch-id>.md and can be removed only by dispatch ID.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { countTokens } = require('./forge-tokens.js');
const { resolveForgePaths } = require('./forge-home.js');

const TEMPLATE_FILES = Object.freeze({
  'execute-task': 'execute-task.md',
  'execute-loose-task': 'execute-loose-task.md',
  'plan-slice': 'plan-slice.md',
  'plan-check': 'plan-check.md',
  'plan-milestone': 'plan-milestone.md',
  'complete-slice': 'complete-slice.md',
  'complete-milestone': 'complete-milestone.md',
  'discuss-milestone': 'discuss-milestone.md',
  'discuss-slice': 'discuss-slice.md',
  'research-milestone': 'research-milestone.md',
  'research-slice': 'research-slice.md',
});

const ALLOWED_PLACEHOLDERS = new Set([
  'WORKING_DIR',
  'FORGE_SCRIPTS_DIR',
  'M###',
  'S##',
  'T##',
  'auto_commit',
  'milestone_cleanup',
  'unit_effort',
  'THINKING_OPUS',
  'CS_LINT',
  'CS_STRUCTURE',
  'CS_RULES',
  'TOP_MEMORIES',
  'LEDGER',
  'description',
  'PLAN_CHECK_MODE',
  'MUST_HAVES_CHECK_RESULTS',
  'routing_domains',
  'workspace_repos',
]);

const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9_.#-]*)\}/g;
const DISPATCH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MILESTONE_ID_RE = /^(?:M\d+|M-\d{14}-[a-z0-9][a-z0-9-]*)$/i;
const SLICE_ID_RE = /^S\d+$/i;
const TASK_ID_RE = /^(?:T\d+(?:\.\d+)?|TASK-\d+|T-\d{14}-[a-z0-9][a-z0-9-]*)$/i;
const MAX_TEMPLATE_BYTES = 256 * 1024;
const MAX_DATA_BYTES = 512 * 1024;
const MAX_CONTEXT_TOKENS = 16000;
const DEFAULT_STANDARDS_REL = '.gsd/CODING-STANDARDS.md';
const MEMORY_FRAGMENT_POINTER = '.gsd/memory/';
const LEDGER_FRAGMENT_POINTER = '.gsd/ledger/';
const NO_DOMAINS_NOTICE = '(none — omit domain:)';
const SINGLE_REPO_NOTICE = '(single repo — omit repo:)';

// Section names as they appear in CODING-STANDARDS.md, per injected placeholder.
// CS_STRUCTURE concatenates three sections (see extractStandards).
const STANDARDS_SECTIONS = Object.freeze({
  CS_LINT: 'Lint & Format Commands',
  CS_STRUCTURE: 'Directory Conventions + Asset Map + Pattern Catalog',
  CS_RULES: 'Code Rules',
});

const REQUIRED_IDS = Object.freeze({
  'execute-task': ['milestoneId', 'sliceId', 'taskId'],
  'execute-loose-task': ['taskId'],
  'plan-slice': ['milestoneId', 'sliceId'],
  'plan-check': ['milestoneId', 'sliceId'],
  'plan-milestone': ['milestoneId'],
  'complete-slice': ['milestoneId', 'sliceId'],
  'complete-milestone': ['milestoneId'],
  'discuss-milestone': ['milestoneId'],
  'discuss-slice': ['milestoneId', 'sliceId'],
  'research-milestone': ['milestoneId'],
  'research-slice': ['milestoneId', 'sliceId'],
});

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertDirectory(dir, label) {
  const resolved = path.resolve(dir);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (_) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  return resolved;
}

function validateUnitType(unitType) {
  if (!Object.prototype.hasOwnProperty.call(TEMPLATE_FILES, unitType)) {
    throw new Error(`Unsupported unit type: ${unitType || '(missing)'}`);
  }
  return unitType;
}

function validateDispatchId(dispatchId) {
  if (typeof dispatchId !== 'string' || !DISPATCH_ID_RE.test(dispatchId)) {
    throw new Error('dispatch_id must contain only letters, numbers, dot, underscore, or hyphen (max 128 chars)');
  }
  return dispatchId;
}

function validateId(value, regex, label) {
  if (typeof value !== 'string' || !regex.test(value)) {
    throw new Error(`Invalid ${label}: ${value == null ? '(missing)' : value}`);
  }
  return value;
}

function validateText(value, label, maxBytes = MAX_DATA_BYTES) {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (value.includes('\0')) throw new Error(`${label} must not contain NUL bytes`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return value;
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new Error(`${label} must be an integer >= ${min}`);
  return Math.min(max, parsed);
}

function resolveRegularFileWithin(root, filename, label, maxBytes) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(filename);
  if (!isWithin(resolvedRoot, target)) throw new Error(`${label} path must stay inside its root: ${target}`);
  const realRoot = fs.realpathSync(resolvedRoot);
  const realTarget = fs.realpathSync(target);
  if (!isWithin(realRoot, realTarget)) throw new Error(`${label} path must stay inside its root: ${realTarget}`);
  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) throw new Error(`${label} path is not a file: ${realTarget}`);
  if (stat.size > maxBytes) throw new Error(`${label} file exceeds ${maxBytes} bytes`);
  return realTarget;
}

/**
 * Normalize a truncation pointer for prompt injection: POSIX separators (the
 * prompt is read by humans and models on every platform) and no newlines, so a
 * pointer can never break out of the marker it lives in.
 */
function normalizePointer(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Marker builders in decreasing order of information. Each takes the cut char
 * count and returns the exact text appended after the surviving content.
 * The `[...truncated ` prefix is deliberately shared with forge-tokens.js so
 * both truncators emit one recognizable family of marker.
 */
function markerBuilders(source, section) {
  const where = section ? `${source} § ${section}` : source;
  return [
    cut => `\n\n[...truncated ${cut} chars — see ${where}]`,
    () => `\n\n[...truncated — see ${source}]`,
  ];
}

function cutContent(text, budget) {
  const raw = text.slice(0, budget);
  const boundary = raw.lastIndexOf('\n');
  const cut = boundary >= Math.floor(budget / 2) ? raw.slice(0, boundary) : raw;
  return cut.trimEnd();
}

/**
 * Truncate to at most `maxChars`, telling the reader what was cut and where the
 * rest lives. The marker is charged against the same budget it protects, so it
 * degrades full marker -> short marker -> the silent ellipsis, and the result
 * length never exceeds `maxChars`.
 */
function truncateChars(text, maxChars, opts = {}) {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return '…'.slice(0, maxChars);

  const source = normalizePointer(opts && opts.source);
  const section = normalizePointer(opts && opts.section);
  if (source) {
    for (const build of markerBuilders(source, section)) {
      // Reserve using the widest possible cut count so the final marker (built
      // from the real count) can only be shorter than what we budgeted for.
      const reserve = build(text.length).length;
      if (reserve + 1 > maxChars) continue;
      const content = cutContent(text, maxChars - reserve);
      if (content.length === 0) continue;
      const rendered = `${content}${build(text.length - content.length)}`;
      if (rendered.length <= maxChars) return rendered;
    }
  }

  const raw = text.slice(0, maxChars - 1);
  const boundary = raw.lastIndexOf('\n');
  const cut = boundary >= Math.floor(maxChars / 2) ? raw.slice(0, boundary) : raw;
  return `${cut.trimEnd()}…`;
}

function truncateContext(text, maxTokens, opts = {}) {
  return truncateChars(text, maxTokens * 4, opts);
}

function boundStandards(standards, maxTokens, template, opts = {}) {
  const standardsPath = normalizePointer(opts && opts.standardsPath) || DEFAULT_STANDARDS_REL;
  const keys = ['CS_LINT', 'CS_STRUCTURE', 'CS_RULES'];
  const values = Object.fromEntries(keys.map(key => [
    key,
    validateText(standards[key] || '(none)', key),
  ]));
  const used = keys.filter(key => template.includes(`{${key}}`));
  let remaining = maxTokens * 4;
  const result = { CS_LINT: '', CS_STRUCTURE: '', CS_RULES: '' };
  for (let index = 0; index < used.length; index += 1) {
    const key = used[index];
    const allocation = Math.floor(remaining / (used.length - index));
    result[key] = truncateChars(values[key], allocation, {
      source: standardsPath,
      section: STANDARDS_SECTIONS[key],
    });
    remaining -= result[key].length;
  }
  return result;
}

function candidateTemplateRoots(cwd, options = {}) {
  const roots = [];
  if (options.templateDir) roots.push({ scope: 'explicit', dir: path.resolve(options.templateDir) });

  // Project-owned templates deliberately precede all installed/global copies.
  roots.push({ scope: 'project', dir: path.join(cwd, 'shared', 'templates', 'dispatch') });
  roots.push({ scope: 'project-runtime', dir: path.join(cwd, '.claude', 'forge', 'templates', 'dispatch') });

  const scriptDir = path.resolve(options.scriptDir || __dirname);
  roots.push({ scope: 'script-coupled', dir: path.resolve(scriptDir, '..', 'shared', 'templates', 'dispatch') });
  roots.push({ scope: 'installed-coupled', dir: path.resolve(scriptDir, '..', 'templates', 'dispatch') });

  const forgePaths = resolveForgePaths({
    cwd,
    forgeHome: options.forgeHome,
    userHome: options.homeDir,
    env: options.env,
  });
  const canonicalRoot = path.join(forgePaths.forgeHome, 'templates', 'dispatch');
  const legacyRoot = path.join(forgePaths.claudeHome, 'templates', 'dispatch');
  // `homeDir` was the test/embedding override before Forge home existed. Keep
  // its historical global scope when no explicit forgeHome is supplied; all
  // normal calls still prefer the canonical Forge tree.
  if (options.homeDir && !options.forgeHome) roots.push({ scope: 'global', dir: legacyRoot });
  else roots.push({ scope: 'global', dir: canonicalRoot });
  // A legacy Claude projection remains a read-only fallback while an upgrade
  // is in progress. New writes and generated prompts always use Forge home.
  if (options.includeLegacy !== false && !(options.homeDir && !options.forgeHome)) {
    roots.push({ scope: 'legacy-claude', dir: legacyRoot });
  }

  const seen = new Set();
  return roots.filter(({ dir }) => {
    const key = process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveTemplate(unitType, options = {}) {
  validateUnitType(unitType);
  const cwd = assertDirectory(options.cwd || process.cwd(), 'cwd');
  const filename = TEMPLATE_FILES[unitType];

  for (const root of candidateTemplateRoots(cwd, options)) {
    const candidate = path.resolve(root.dir, filename);
    if (!isWithin(root.dir, candidate)) throw new Error(`Unsafe template path for ${unitType}`);
    if (!fs.existsSync(candidate)) continue;
    const safeCandidate = resolveRegularFileWithin(root.dir, candidate, 'Template', MAX_TEMPLATE_BYTES);
    return {
      content: fs.readFileSync(safeCandidate, 'utf8').replace(/^\uFEFF/, ''),
      path: safeCandidate,
      scope: root.scope,
    };
  }

  throw new Error(`No template found for ${unitType}; checked project-local and installed template roots`);
}

function sectionBody(markdown, heading) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const wanted = `## ${heading}`.trim().toLowerCase();
  const start = lines.findIndex(line => line.trim().toLowerCase() === wanted);
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i].trim())) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function extractStandards(markdown) {
  const lint = sectionBody(markdown, 'Lint & Format Commands');
  const structureParts = [
    sectionBody(markdown, 'Directory Conventions'),
    sectionBody(markdown, 'Asset Map'),
    sectionBody(markdown, 'Pattern Catalog'),
  ].filter(Boolean);
  const rules = sectionBody(markdown, 'Code Rules');
  return {
    CS_LINT: lint || '(none)',
    CS_STRUCTURE: structureParts.join('\n\n') || '(none)',
    CS_RULES: rules || '(none)',
  };
}

// Single resolution of the standards file, consumed by the loader and by the
// truncation pointer so the marker can never name a file we did not read.
function standardsTarget(cwd, standardsPath) {
  return standardsPath
    ? path.resolve(cwd, standardsPath)
    : path.join(cwd, '.gsd', 'CODING-STANDARDS.md');
}

function standardsPointer(cwd, standardsPath) {
  const relative = path.relative(cwd, standardsTarget(cwd, standardsPath));
  const normalized = normalizePointer(relative);
  return normalized && !normalized.startsWith('..') ? normalized : DEFAULT_STANDARDS_REL;
}

function loadStandards(cwd, standardsPath) {
  const target = standardsTarget(cwd, standardsPath);
  if (!isWithin(cwd, target)) throw new Error(`Standards path must stay inside cwd: ${target}`);
  if (!fs.existsSync(target)) return extractStandards('');
  const safeTarget = resolveRegularFileWithin(cwd, target, 'Standards', MAX_DATA_BYTES);
  return extractStandards(fs.readFileSync(safeTarget, 'utf8'));
}

function formatMemoryResult(result, maxTokens) {
  if (result == null) return '(none)';
  const pointer = { source: MEMORY_FRAGMENT_POINTER };
  if (typeof result === 'string') return truncateContext(validateText(result.trim(), 'memories') || '(none)', maxTokens, pointer);
  if (typeof result.markdown === 'string') return truncateContext(validateText(result.markdown.trim(), 'memories') || '(none)', maxTokens, pointer);
  const values = Array.isArray(result)
    ? result
    : Array.isArray(result.facts)
      ? result.facts
      : Array.isArray(result.memories)
        ? result.memories
        : [];
  if (values.length === 0) return '(none)';
  const lines = values.map(item => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') return item.fact || item.text || item.content || JSON.stringify(item);
    return String(item);
  }).filter(Boolean).map(line => /^\s*[-*]\s/.test(line) ? line : `- ${line}`);
  return truncateContext(validateText(lines.join('\n'), 'memories') || '(none)', maxTokens, pointer);
}

function resolveMemories(options) {
  if (options.memories != null) return formatMemoryResult(options.memories, options.memoryMaxTokens);

  const query = {
    cwd: options.cwd,
    unitType: options.unitType,
    unitId: options.taskId || options.sliceId || options.milestoneId,
    milestoneId: options.milestoneId,
    sliceId: options.sliceId,
    taskId: options.taskId,
    limit: options.memoryLimit,
    maxTokens: options.memoryMaxTokens,
    query: options.memoryQuery || [
      options.unitType,
      options.milestoneId,
      options.sliceId,
      options.taskId,
      options.description,
    ].filter(Boolean).join(' '),
  };

  if (typeof options.memoryProvider === 'function') {
    return formatMemoryResult(options.memoryProvider(query), query.maxTokens);
  }

  // Only load the selector coupled to this renderer. Requiring a project-local
  // `scripts/forge-memory.js` would execute arbitrary workspace JavaScript in
  // the orchestrator process merely because a file had a matching name.
  const api = require('./forge-memory.js');
  if (typeof api.queryRelevant === 'function') {
    return formatMemoryResult(api.queryRelevant(query), query.maxTokens);
  }

  return '(none)';
}

/**
 * Format whatever the ledger seam returned into the {LEDGER} slot.
 * Accepts a plain string (direct override / provider) or the builder's envelope
 * ({ markdown, included_ids, omitted_count }).
 *
 * The final char bound is belt-and-suspenders for the DIRECT path only: the
 * builder already honours the budget and pays for its own entry-counting marker,
 * so this truncation does not fire behind it.
 */
function formatLedgerResult(result, maxTokens) {
  if (result == null) return '(none)';
  const pointer = { source: LEDGER_FRAGMENT_POINTER };
  const text = typeof result === 'string'
    ? result
    : typeof result.markdown === 'string'
      ? result.markdown
      : '';
  const trimmed = validateText(String(text).trim(), 'ledger');
  if (!trimmed) return '(none)';
  return truncateContext(trimmed, maxTokens, pointer);
}

function resolveLedger(options) {
  if (options.ledger != null) return formatLedgerResult(options.ledger, options.ledgerMaxTokens);

  const query = {
    cwd: options.cwd,
    maxTokens: options.ledgerMaxTokens,
    unitType: options.unitType,
    milestoneId: options.milestoneId,
    sliceId: options.sliceId,
  };

  if (typeof options.ledgerProvider === 'function') {
    return formatLedgerResult(options.ledgerProvider(query), query.maxTokens);
  }

  // Only the selector coupled to this renderer, for the same reason as
  // resolveMemories: requiring a project-local `scripts/forge-projection.js`
  // would execute arbitrary workspace JavaScript in the orchestrator process
  // merely because a file had a matching name.
  const api = require('./forge-projection.js');
  if (typeof api.renderLedgerSnapshot === 'function') {
    return formatLedgerResult(api.renderLedgerSnapshot(options.cwd, { maxTokens: query.maxTokens }), query.maxTokens);
  }

  return '(none)';
}

function boolString(value, defaultValue = false) {
  if (value == null || value === '') return String(defaultValue);
  if (typeof value === 'boolean') return String(value);
  if (value === 'true' || value === 'false') return value;
  throw new Error(`Expected boolean value, received: ${value}`);
}

function validateRenderOptions(rawOptions) {
  const options = { ...rawOptions };
  options.cwd = assertDirectory(options.cwd || process.cwd(), 'cwd');
  options.unitType = validateUnitType(options.unitType);

  for (const idName of REQUIRED_IDS[options.unitType]) {
    if (idName === 'milestoneId') validateId(options.milestoneId, MILESTONE_ID_RE, 'milestone ID');
    if (idName === 'sliceId') validateId(options.sliceId, SLICE_ID_RE, 'slice ID');
    if (idName === 'taskId') validateId(options.taskId, TASK_ID_RE, 'task ID');
  }

  if (options.milestoneId != null) validateId(options.milestoneId, MILESTONE_ID_RE, 'milestone ID');
  if (options.sliceId != null) validateId(options.sliceId, SLICE_ID_RE, 'slice ID');
  if (options.taskId != null) validateId(options.taskId, TASK_ID_RE, 'task ID');

  if ((options.unitType === 'plan-milestone' || options.unitType === 'execute-loose-task' || options.unitType.startsWith('research-')) && !options.description) {
    throw new Error(`description is required for ${options.unitType}`);
  }
  options.description = validateText(options.description || '', 'description', 32 * 1024);
  options.unitEffort = validateText(options.unitEffort || 'low', 'unit_effort', 128);
  options.thinking = validateText(options.thinking || 'adaptive', 'thinking', 128);
  options.planCheckMode = validateText(options.planCheckMode || 'advisory', 'plan_check_mode', 128);
  options.mustHavesCheckResults = validateText(options.mustHavesCheckResults || '(not run)', 'must_haves_check_results');
  options.memoryLimit = boundedInteger(options.memoryLimit, 12, 1, 50, 'memory_limit');
  options.memoryMaxTokens = boundedInteger(options.memoryMaxTokens, 1200, 2, MAX_CONTEXT_TOKENS, 'memory_max_tokens');
  options.standardsMaxTokens = boundedInteger(options.standardsMaxTokens, 3000, 3, MAX_CONTEXT_TOKENS, 'standards_max_tokens');
  // The ledger snapshot budget default lives HERE, as a literal (S02 B2). The
  // skill lines that read `${PREFS[token_budget][ledger_snapshot]:-1500}` are
  // model-interpreted best effort; prefs-absent is this repo's real state, so
  // the renderer must resolve 1500 on its own with nothing configured anywhere.
  options.ledgerMaxTokens = boundedInteger(options.ledgerMaxTokens, 1500, 2, MAX_CONTEXT_TOKENS, 'ledger_max_tokens');
  options.milestoneCleanup = validateText(options.milestoneCleanup || 'keep', 'milestone_cleanup', 128);
  if (!['keep', 'archive', 'delete'].includes(options.milestoneCleanup)) {
    throw new Error(`Invalid milestone_cleanup: ${options.milestoneCleanup}`);
  }
  options.isolationMode = validateText(options.isolationMode || 'shared', 'isolation_mode', 32);
  if (!['shared', 'branch', 'worktree'].includes(options.isolationMode)) {
    throw new Error(`Invalid isolation_mode: ${options.isolationMode}`);
  }
  if (options.isolationMode !== 'shared') {
    options.branch = validateText(options.branch || '', 'branch', 255);
    if (!options.branch || /[\r\n]/.test(options.branch) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(options.branch)) {
      throw new Error(`Invalid branch for ${options.isolationMode} isolation`);
    }
    options.codeDir = assertDirectory(options.codeDir || options.cwd, 'code_dir');
  }
  return options;
}

function applyIsolationHeader(prompt, options) {
  if (options.isolationMode === 'shared') return prompt;
  const marker = `WORKING_DIR: ${options.cwd}`;
  const index = prompt.indexOf(marker);
  if (index < 0) throw new Error('Template is missing the WORKING_DIR header required for isolation');
  const insertAt = index + marker.length;
  const header = [
    `\nISOLATION: ${options.isolationMode}`,
    `BRANCH: ${options.branch}`,
    `CODE_DIR: ${options.codeDir}`,
    'Isolation rule: all source-code reads, writes, builds and git commits happen inside CODE_DIR on branch BRANCH. All .gsd/** artifact paths stay under WORKING_DIR. Never commit from WORKING_DIR when CODE_DIR differs.',
  ].join('\n');
  return prompt.slice(0, insertAt) + header + prompt.slice(insertAt);
}

function appendPendingContext(prompt, options) {
  if (!options.pendingContextFile) return prompt;
  const expectedRoot = path.join(options.cwd, '.gsd', 'forge', 'context', 'pending');
  const target = path.resolve(options.pendingContextFile);
  if (!isWithin(expectedRoot, target)) throw new Error(`pending_context_file must stay inside ${expectedRoot}`);
  const safeTarget = resolveRegularFileWithin(expectedRoot, target, 'pending_context_file', MAX_DATA_BYTES);
  const record = JSON.parse(fs.readFileSync(safeTarget, 'utf8'));
  if (!record || typeof record.additional_context !== 'string' || !record.additional_context.trim()) {
    throw new Error('pending_context_file has no additional_context');
  }
  const context = validateText(record.additional_context, 'pending_context', 32 * 1024);
  return `${prompt.replace(/\s+$/, '')}\n\n## Pending Context Boundary\n\n${context}\n`;
}

function resolveRoutingDomains(cwd) {
  let list = [];
  try {
    // Lazy optional sibling: prompt rendering remains usable in partial installs.
    const { listDomains } = require('./forge-routing');
    try { list = listDomains(cwd); } catch (_) { list = []; }
  } catch (err) {
    const absent = require('./forge-optional-require').isAbsentModuleError(err, './forge-routing');
    if (!absent) throw err;
  }
  const s = Array.isArray(list) && list.length ? list.join(', ') : NO_DOMAINS_NOTICE;
  if (!s || !s.trim()) return NO_DOMAINS_NOTICE;
  return s;
}

function resolveWorkspaceRepos(cwd) {
  let names = [];
  try {
    // Lazy optional sibling: prompt rendering remains usable in partial installs.
    const { repoNames } = require('./forge-repos');
    try { names = repoNames(cwd); } catch (_) { names = []; }
  } catch (err) {
    const absent = require('./forge-optional-require').isAbsentModuleError(err, './forge-repos');
    if (!absent) throw err;
  }
  const s = Array.isArray(names) && names.length > 1 ? names.join(', ') : SINGLE_REPO_NOTICE;
  if (!s || !s.trim()) return SINGLE_REPO_NOTICE;
  return s;
}

function buildValues(options, template) {
  const scriptsDir = __dirname;
  const usesStandards = /\{CS_(?:LINT|STRUCTURE|RULES)\}/.test(template);
  const standards = usesStandards
    ? (options.standards || loadStandards(options.cwd, options.standardsPath))
    : {};
  const normalizedStandards = usesStandards
    ? boundStandards(standards, options.standardsMaxTokens, template, {
      // Inline standards did not come from a file; point at the canonical one.
      standardsPath: options.standards ? DEFAULT_STANDARDS_REL : standardsPointer(options.cwd, options.standardsPath),
    })
    : { CS_LINT: '', CS_STRUCTURE: '', CS_RULES: '' };
  const memories = template.includes('{TOP_MEMORIES}') ? resolveMemories(options) : '';
  // Gated on the placeholder: the 10 unit types without {LEDGER} pay nothing —
  // no store read, no provider call.
  const ledger = template.includes('{LEDGER}') ? resolveLedger(options) : '';
  const routingOverride = typeof options.routingDomains === 'string' && options.routingDomains.trim()
    ? options.routingDomains
    : null;
  const reposOverride = typeof options.workspaceRepos === 'string' && options.workspaceRepos.trim()
    ? options.workspaceRepos
    : null;
  const resolvedRoutingDomains = template.includes('{routing_domains}')
    ? (routingOverride || resolveRoutingDomains(options.cwd))
    : '';
  const resolvedWorkspaceRepos = template.includes('{workspace_repos}')
    ? (reposOverride || resolveWorkspaceRepos(options.cwd))
    : '';
  return {
    WORKING_DIR: options.cwd,
    FORGE_SCRIPTS_DIR: scriptsDir,
    'M###': options.milestoneId,
    'S##': options.sliceId,
    'T##': options.taskId,
    auto_commit: boolString(options.autoCommit, false),
    milestone_cleanup: options.milestoneCleanup,
    unit_effort: options.unitEffort,
    THINKING_OPUS: options.thinking,
    CS_LINT: normalizedStandards.CS_LINT,
    CS_STRUCTURE: normalizedStandards.CS_STRUCTURE,
    CS_RULES: normalizedStandards.CS_RULES,
    TOP_MEMORIES: memories,
    LEDGER: ledger,
    description: options.description,
    PLAN_CHECK_MODE: options.planCheckMode,
    MUST_HAVES_CHECK_RESULTS: options.mustHavesCheckResults,
    routing_domains: resolvedRoutingDomains,
    workspace_repos: resolvedWorkspaceRepos,
  };
}

function renderTemplate(template, values, source = '(inline)') {
  const unknown = new Set();
  const missing = new Set();
  const rendered = template.replace(PLACEHOLDER_RE, (whole, name) => {
    if (!ALLOWED_PLACEHOLDERS.has(name)) {
      unknown.add(name);
      return whole;
    }
    if (values[name] == null) {
      missing.add(name);
      return whole;
    }
    return String(values[name]);
  });
  if (unknown.size > 0) throw new Error(`Unknown placeholder(s) in ${source}: ${[...unknown].join(', ')}`);
  if (missing.size > 0) throw new Error(`Missing placeholder value(s) in ${source}: ${[...missing].join(', ')}`);
  return rendered.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
}

function renderPrompt(rawOptions) {
  const options = validateRenderOptions(rawOptions || {});
  const template = resolveTemplate(options.unitType, options);
  const values = buildValues(options, template.content);
  const basePrompt = renderTemplate(template.content, values, template.path);
  const prompt = appendPendingContext(applyIsolationHeader(basePrompt, options), options);
  const templateSha256 = crypto.createHash('sha256').update(template.content).digest('hex');
  return {
    prompt,
    input_tokens: countTokens(prompt),
    token_method: 'heuristic-chars-4',
    template_source: template.path,
    template_scope: template.scope,
    template_sha256: templateSha256,
    unit_type: options.unitType,
    unit_id: options.taskId || options.sliceId || options.milestoneId,
    cwd: options.cwd,
  };
}

function promptRoot(cwd) {
  return path.join(path.resolve(cwd), '.gsd', 'forge', 'prompts');
}

function ensurePromptRoot(cwd) {
  const root = promptRoot(cwd);
  fs.mkdirSync(root, { recursive: true });
  const realCwd = fs.realpathSync(path.resolve(cwd));
  const realRoot = fs.realpathSync(root);
  if (!isWithin(realCwd, realRoot)) throw new Error(`Prompt root escapes cwd: ${realRoot}`);
  return realRoot;
}

function generateDispatchId(rendered) {
  const suffix = crypto.randomBytes(6).toString('hex');
  return `${rendered.unit_type}-${rendered.unit_id}-${suffix}`;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function materializePrompt(rawOptions) {
  const rendered = renderPrompt(rawOptions);
  const dispatchId = validateDispatchId(rawOptions.dispatchId || rawOptions.dispatch_id || generateDispatchId(rendered));
  const root = ensurePromptRoot(rendered.cwd);
  const target = path.join(root, `${dispatchId}.md`);
  if (!isWithin(root, target)) throw new Error('Unsafe prompt output path');
  if (fs.existsSync(target)) throw new Error(`Prompt artifact already exists for dispatch_id: ${dispatchId}`);

  const artifact = [
    '---',
    `prompt_id: ${yamlString(dispatchId)}`,
    `dispatch_group_id: ${yamlString(dispatchId)}`,
    // Backward-compatible alias for consumers created before per-call dispatch
    // IDs were introduced. This identifies the prompt, not a model call.
    `dispatch_id: ${yamlString(dispatchId)}`,
    `unit_type: ${yamlString(rendered.unit_type)}`,
    `unit_id: ${yamlString(rendered.unit_id)}`,
    `input_tokens: ${rendered.input_tokens}`,
    `token_method: ${yamlString(rendered.token_method)}`,
    `template_source: ${yamlString(rendered.template_source)}`,
    `template_sha256: ${yamlString(rendered.template_sha256)}`,
    '---',
    '',
    rendered.prompt,
  ].join('\n');

  const temp = path.join(root, `.${dispatchId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, artifact, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // An atomic hard-link gives us rename-like publication without rename's
    // platform-specific overwrite semantics. EEXIST is a hard no-clobber guard.
    fs.linkSync(temp, target);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw new Error(`Prompt artifact already exists for dispatch_id: ${dispatchId}`);
    }
    throw error;
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }

  return {
    ...rendered,
    prompt_id: dispatchId,
    dispatch_group_id: dispatchId,
    dispatch_id: dispatchId,
    prompt_path: target,
  };
}

function cleanupPrompt(cwd, dispatchId) {
  const resolvedCwd = assertDirectory(cwd || process.cwd(), 'cwd');
  validateDispatchId(dispatchId);
  const root = promptRoot(resolvedCwd);
  if (!fs.existsSync(root)) return false;
  const realCwd = fs.realpathSync(resolvedCwd);
  const realRoot = fs.realpathSync(root);
  if (!isWithin(realCwd, realRoot)) throw new Error(`Prompt root escapes cwd: ${realRoot}`);
  const target = path.join(realRoot, `${dispatchId}.md`);
  if (!isWithin(realRoot, target)) throw new Error('Unsafe prompt cleanup path');
  if (!fs.existsSync(target)) return false;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Refusing to remove non-file prompt artifact: ${target}`);
  fs.unlinkSync(target);
  return true;
}

function parseArgs(argv) {
  const args = {};
  const booleanFlags = new Set(['stdin-json', 'memories-stdin', 'print-prompt', 'help']);
  const valueFlags = new Set([
    'unit-type', 'cwd', 'milestone', 'slice', 'task', 'dispatch-id',
    'description', 'unit-effort', 'thinking', 'plan-check-mode',
    'auto-commit', 'milestone-cleanup', 'standards-file', 'template-dir',
    'must-haves-file', 'memories-file', 'memories', 'memory-query',
    'memory-query-file', 'memory-limit', 'memory-max-tokens', 'standards-max-tokens',
    'ledger', 'ledger-max-tokens',
    'isolation-mode', 'branch', 'code-dir', 'vars-json', 'cleanup',
    'routing-domains', 'workspace-repos', 'pending-context-file',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (booleanFlags.has(key)) {
      args[key] = true;
      continue;
    }
    if (!valueFlags.has(key)) throw new Error(`Unknown option: --${key}`);
    if (i + 1 >= argv.length) throw new Error(`Missing value for --${key}`);
    args[key] = argv[++i];
  }
  return args;
}

function readFileWithinCwd(cwd, filename, label) {
  const target = path.resolve(cwd, filename);
  if (!isWithin(cwd, target)) throw new Error(`${label} path must stay inside cwd: ${target}`);
  const safeTarget = resolveRegularFileWithin(cwd, target, label, MAX_DATA_BYTES);
  return fs.readFileSync(safeTarget, 'utf8');
}

function cliOptions(args) {
  let stdinData = null;
  if (args['stdin-json'] || args['memories-stdin']) {
    stdinData = fs.readFileSync(0, 'utf8');
    if (Buffer.byteLength(stdinData, 'utf8') > MAX_DATA_BYTES) {
      throw new Error(`stdin exceeds ${MAX_DATA_BYTES} bytes`);
    }
  }
  let base = {};
  if (args['stdin-json']) {
    try { base = JSON.parse(stdinData || '{}'); }
    catch (error) { throw new Error(`Invalid stdin JSON: ${error.message}`); }
  }
  if (args['vars-json']) {
    try { base = { ...base, ...JSON.parse(args['vars-json']) }; }
    catch (error) { throw new Error(`Invalid --vars-json JSON: ${error.message}`); }
  }

  const cwd = path.resolve(args.cwd || base.cwd || process.cwd());
  const options = {
    ...base,
    cwd,
    unitType: args['unit-type'] || base.unitType || base.unit_type,
    milestoneId: args.milestone || base.milestoneId || base.milestone_id,
    sliceId: args.slice || base.sliceId || base.slice_id,
    taskId: args.task || base.taskId || base.task_id,
    dispatchId: args['dispatch-id'] || base.dispatchId || base.dispatch_id,
    description: args.description != null ? args.description : base.description,
    unitEffort: args['unit-effort'] || base.unitEffort || base.unit_effort,
    thinking: args.thinking || base.thinking,
    planCheckMode: args['plan-check-mode'] || base.planCheckMode || base.plan_check_mode,
    autoCommit: args['auto-commit'] != null ? args['auto-commit'] : (base.autoCommit ?? base.auto_commit),
    milestoneCleanup: args['milestone-cleanup'] || base.milestoneCleanup || base.milestone_cleanup,
    isolationMode: args['isolation-mode'] || base.isolationMode || base.isolation_mode,
    branch: args.branch || base.branch,
    codeDir: args['code-dir'] || base.codeDir || base.code_dir,
    standardsPath: args['standards-file'] || base.standardsPath || base.standards_path,
    templateDir: args['template-dir'] || base.templateDir || base.template_dir,
    mustHavesCheckResults: base.mustHavesCheckResults || base.must_haves_check_results,
    memories: base.memories,
    memoryQuery: args['memory-query'] || base.memoryQuery || base.memory_query,
    memoryLimit: args['memory-limit'] || base.memoryLimit || base.memory_limit,
    memoryMaxTokens: args['memory-max-tokens'] || base.memoryMaxTokens || base.memory_max_tokens,
    standardsMaxTokens: args['standards-max-tokens'] || base.standardsMaxTokens || base.standards_max_tokens,
    ledger: args.ledger != null ? args.ledger : base.ledger,
    ledgerMaxTokens: args['ledger-max-tokens'] || base.ledgerMaxTokens || base.ledger_max_tokens,
    routingDomains: args['routing-domains'] || base.routingDomains || base.routing_domains,
    workspaceRepos: args['workspace-repos'] || base.workspaceRepos || base.workspace_repos,
    pendingContextFile: args['pending-context-file'] || base.pendingContextFile || base.pending_context_file,
  };
  if (args['must-haves-file']) options.mustHavesCheckResults = readFileWithinCwd(cwd, args['must-haves-file'], 'must-haves');
  if (args['memories-file']) options.memories = readFileWithinCwd(cwd, args['memories-file'], 'memories');
  if (args['memory-query-file']) options.memoryQuery = readFileWithinCwd(cwd, args['memory-query-file'], 'memory-query');
  if (args.memories != null) options.memories = args.memories;
  if (args['memories-stdin']) options.memories = stdinData;
  return options;
}

function printUsage() {
  process.stdout.write(`Usage:
  node forge-prompt.js --unit-type <type> --cwd <dir> [IDs/options]
  node forge-prompt.js --stdin-json
  node forge-prompt.js --cleanup <dispatch-id> [--cwd <dir>]

Core options:
  --unit-type TYPE       One of: ${Object.keys(TEMPLATE_FILES).join(', ')}
  --milestone ID         Milestone ID (M### or timestamp form)
  --slice ID             Slice ID (S##)
  --task ID              Task ID (T## or timestamp form)
  --dispatch-id ID       Safe artifact ID; generated when omitted
  --description TEXT     Required by plan/research milestone units
  --unit-effort LEVEL    Resolved unit effort (default: low)
  --thinking VALUE       Resolved thinking value (default: adaptive)
  --auto-commit BOOL     true or false (default: false)
  --milestone-cleanup M  keep, archive, or delete
  --plan-check-mode MODE Plan-check mode (default: advisory)
  --must-haves-file PATH Read plan-check results from a file inside cwd
  --standards-file PATH  Coding standards file inside cwd
  --template-dir PATH    Explicit template root (project roots still default)
  --isolation-mode MODE  shared, branch, or worktree
  --branch NAME          Required for branch/worktree isolation
  --code-dir PATH        Source-code root for branch/worktree isolation
  --memories TEXT        Inject already-selected project memories
  --memories-file PATH   Read selected memories from a file inside cwd
  --memories-stdin       Read selected memories as raw stdin
  --memory-query TEXT    Query text for the selective memory API
  --memory-query-file P  Read selective-memory query from a file inside cwd
  --memory-limit N       Maximum selected memory entries (default: 12)
  --memory-max-tokens N  Selected-memory budget (default: 1200)
  --standards-max-tokens N Combined coding-standards budget (default: 3000)
  --ledger TEXT          Inject a deterministic ledger snapshot ("(none)" = none)
  --ledger-max-tokens N  Ledger snapshot budget (default: 1500)
  --routing-domains TEXT Test/deterministic routing-domains override
  --workspace-repos TEXT  Test/deterministic workspace-repos override
  --pending-context-file P Append a validated durable sidecar boundary inside the prompt artifact
  --stdin-json           Read all options as JSON from stdin
  --print-prompt         Print the rendered body instead of result metadata
  --cleanup ID           Safely remove exactly one rendered prompt artifact
`);
}

function cliMain(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printUsage();
    return;
  }
  if (args.cleanup) {
    const removed = cleanupPrompt(args.cwd || process.cwd(), args.cleanup);
    process.stdout.write(`${JSON.stringify({ dispatch_id: args.cleanup, removed })}\n`);
    return;
  }
  const options = cliOptions(args);
  const result = materializePrompt(options);
  if (args['print-prompt']) {
    process.stdout.write(result.prompt);
    return;
  }
  const { prompt, cwd, ...metadata } = result;
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

module.exports = {
  TEMPLATE_FILES,
  candidateTemplateRoots,
  resolveTemplate,
  extractStandards,
  resolveMemories,
  resolveLedger,
  renderTemplate,
  applyIsolationHeader,
  renderPrompt,
  materializePrompt,
  cleanupPrompt,
  validateDispatchId,
  _private: { truncateChars, truncateContext, boundStandards, standardsPointer, formatLedgerResult, LEDGER_FRAGMENT_POINTER, NO_DOMAINS_NOTICE, SINGLE_REPO_NOTICE, resolveRoutingDomains, resolveWorkspaceRepos },
};

if (require.main === module) {
  try {
    cliMain(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
