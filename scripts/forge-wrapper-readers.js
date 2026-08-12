'use strict';

// This is deliberately a data module.  The companion test owns filesystem
// discovery, so loading this registry never reads a project or spawns a tool.

// Object.freeze over a Set does not stop .add(); this criterion gates a
// destructive opt-in, so the vocabulary is a frozen array with a has() view.
const VERDICT_NAMES = Object.freeze(['learned', 'breaks', 'safe-by-construction']);
const VERDICTS = Object.freeze({
  has: value => VERDICT_NAMES.includes(value),
  values: () => VERDICT_NAMES,
});

// Freezing the array alone leaves every entry mutable: WRAPPER_DIR_READERS[1]
// .verdict = 'learned' silently shrinks unlearnedReaders().  Freeze each one.
const WRAPPER_DIR_READERS = Object.freeze([
  {
    file: 'forge-dashboard.js',
    dirs: Object.freeze(['.gsd/milestones']),
    evidence: 'forge-dashboard.js:54 — fs.readdirSync(forgeDir), where forgeDir is .gsd/forge; line 255 only prints the milestone path.',
    verdict: 'safe-by-construction',
    why: 'The named forgeDir target at line 53 is the .gsd/forge filter, so its enumeration cannot consume milestone wrapper entries.',
  },
  {
    file: 'forge-decisions-migrate.js',
    dirs: Object.freeze(['.gsd/milestones']),
    evidence: 'forge-decisions-migrate.js:247-261 — milestonesDir is path.join(effectiveCwd, \'.gsd\', \'milestones\') and fs.readdirSync(milestonesDir) feeds milestoneDirs.',
    verdict: 'breaks',
    why: 'The loop expects every top-level name to be a milestone directory and probes it for *-DECISIONS.md; an epoch.md container therefore hides its member milestones.',
  },
  {
    file: 'forge-doctor.js',
    dirs: Object.freeze(['.gsd/milestones', '.gsd/tasks']),
    evidence: 'forge-doctor.js:172,208-213 — collectPlanFiles uses fs.readdirSync and is invoked with both .gsd/milestones and .gsd/tasks.',
    verdict: 'breaks',
    why: 'collectPlanFiles only descends through directory entries and reads loose PLAN files; it does not parse an epoch.md container.',
  },
  {
    file: 'forge-epoch-group.js',
    dirs: Object.freeze(['.gsd/milestones', '.gsd/tasks']),
    evidence: 'forge-epoch-group.js:202-205 — listWrapperDirs(parent) then entries(parent), followed by if (!entry.isDirectory()) continue.',
    verdict: 'safe-by-construction',
    why: 'The explicit entry.isDirectory() filter intentionally limits this writer to loose wrapper directories; existing epoch.md containers are skipped rather than misread as wrappers.',
  },
  {
    file: 'forge-gsd-census.js',
    dirs: Object.freeze(['.gsd/milestones', '.gsd/tasks']),
    evidence: 'forge-gsd-census.js:333-334 — census() calls walkTreeDirs(cwd, \'.gsd/milestones\') and walkTreeDirs(cwd, \'.gsd/tasks\'); walkTreeDirs:281 fs.readdirSync(parentAbs) and :287 if (!entry.isDirectory()) continue.',
    verdict: 'breaks',
    why: 'Both wrapper roots are enumerated directly (not below a caller-selected unit) and every non-directory entry is discarded, so an epoch.md container is dropped rather than parsed — the same shape as forge-status.js. The consequence is specific to this module: the census exists to prove no bytes were lost, so grouped milestone/task mass would silently vanish from trees.totals and a post-sweep compare would read as a shrink instead of a relocation.',
  },
  {
    file: 'forge-ids.js',
    dirs: Object.freeze(['.gsd/milestones', '.gsd/tasks']),
    evidence: 'forge-ids.js:249-280 — listExistingIds readdirSync(d) then reads grouped .md files with forge-grouped-file.readGroupedUnits().',
    verdict: 'learned',
    why: 'After listing the roots, listExistingIds explicitly recognizes grouped containers and adds each parsed unit id (or wrapper marker left side).',
  },
  {
    file: 'forge-smoke.js',
    dirs: Object.freeze(['.gsd/milestones']),
    evidence: 'forge-smoke.js:278,306,323,356,364,370 â€” fs.mkdirSync/fs.writeFileSync create deterministic fixture paths; :5043 enumerates only walk(path.join(gsd, \'forge\')).',
    verdict: 'safe-by-construction',
    why: 'The specific snapshotForge filter walks only path.join(gsd, \'forge\'); milestone occurrences are deterministic fixture construction, so no third-party wrapper root is enumerated.',
  },
  {
    file: 'forge-memory-migrate.js',
    dirs: Object.freeze(['.gsd/milestones']),
    evidence: 'forge-memory-migrate.js:184-204 — fs.readdirSync(milestonesDir) and stat.isDirectory() select milestone directories.',
    verdict: 'breaks',
    why: 'resolveViaFilesystem searches only loose milestone directories and their slices; it has no grouped-file reader for epoch.md.',
  },
  {
    file: 'forge-runs.js',
    dirs: Object.freeze(['.gsd/milestones']),
    evidence: 'forge-runs.js:49 — listAll enumerates only runsDir; line 200 constructs a milestone path without listing it.',
    verdict: 'safe-by-construction',
    why: 'The specific f.endsWith(\'.json\') filter is applied to .gsd/forge/runs, not to .gsd/milestones, so wrapper containers are never inputs to this enumeration.',
  },
  {
    file: 'forge-parallelism.js',
    dirs: Object.freeze(['.gsd/tasks']),
    evidence: 'forge-parallelism.js:165-172 — discoverTasks joins path.join(sliceDir, \'tasks\') and fs.readdirSync(tasksRoot), then filters entries with /^T\\d+(\\.\\d+)?$/.',
    verdict: 'safe-by-construction',
    why: 'The specific caller-supplied sliceDir plus the /^T\\d+/ name filter confine this enumeration to a slice-local tasks directory; it never enumerates the .gsd/tasks or .gsd/milestones wrapper roots.',
  },
  {
    file: 'forge-route-audit.js',
    dirs: Object.freeze(['.gsd/milestones']),
    evidence: 'forge-route-audit.js:20,31 — milestone mentions are route-identity documentation; the module has no fs.readdirSync call.',
    verdict: 'safe-by-construction',
    why: 'The absence of fs.readdirSync is the specific filter: this audit consumes recorded route data rather than enumerating wrapper directories.',
  },
  {
    file: 'forge-state.js',
    dirs: Object.freeze(['.gsd/milestones']),
    evidence: 'forge-state.js:33 — stateFile constructs one .gsd/milestones/<id>/<id>-STATE.md path; it has no fs.readdirSync call.',
    verdict: 'safe-by-construction',
    why: 'The caller-supplied milestoneId path construction is the specific filter; forge-state never enumerates the milestone root.',
  },
  {
    file: 'forge-status.js',
    dirs: Object.freeze(['.gsd/milestones', '.gsd/tasks']),
    evidence: 'forge-status.js:127 and 268 — readdirSync(tasksDir) and readdirSync(milestonesDir) filter entries with isDirectory().',
    verdict: 'breaks',
    why: 'Both root scans discard epoch.md containers via entry.isDirectory(), so grouped task and milestone units disappear from the status model.',
  },
  {
    file: 'forge-statusline.js',
    dirs: Object.freeze(['.gsd/milestones']),
    evidence: 'forge-statusline.js:182 reads one milestone ROADMAP; lines 209,213,580 enumerate only .gsd/forge paths.',
    verdict: 'safe-by-construction',
    why: 'The concrete .json, evidence-*.jsonl, and pause-* filters operate below .gsd/forge, never on the milestone root.',
  },
  {
    file: 'forge-surgical-reset.js',
    dirs: Object.freeze(['.gsd/milestones']),
    evidence: 'forge-surgical-reset.js:9 is a documentation example of a milestone path; the module has no fs.readdirSync call.',
    verdict: 'safe-by-construction',
    why: 'No directory enumeration exists in this script, so an epoch container cannot be selected by it.',
  },
  {
    file: 'forge-unit-controller.js',
    dirs: Object.freeze(['.gsd/milestones']),
    evidence: 'forge-unit-controller.js:227-232 — discoverInventory receives one milestone id, builds .gsd/milestones/<id>, and enumerates only inside that selected milestone and its slices/tasks.',
    verdict: 'safe-by-construction',
    why: 'The specific caller-selected milestone id is joined before firstExisting enumerates; the controller never lists the .gsd/milestones wrapper root, so an epoch.md container cannot be consumed as a milestone directory.',
  },
  {
    file: 'forge-verifier.js',
    dirs: Object.freeze(['.gsd/milestones']),
    evidence: 'forge-verifier.js:922-935 — discoverTaskPlans uses fs.readdirSync(sliceDir/tasks), below a caller-selected milestone and slice.',
    verdict: 'safe-by-construction',
    why: 'The specific /^T\\d{2}$/ task-name filter applies only after the selected slice/tasks path; it never enumerates .gsd/milestones or .gsd/tasks roots.',
  },
  {
    file: 'forge-workspace.js',
    dirs: Object.freeze(['.gsd/milestones', '.gsd/tasks']),
    evidence: 'forge-workspace.js:113 — fs.readdirSync(gsd), where gsd is path.join(dir, \'.gsd\') (line 106); \'milestones\' and \'tasks\' appear at line 51 only as names inside the WORK_ENTRIES presence list. The second enumeration, line 965, walks repository directories and prunes every dotted name (including .gsd).',
    verdict: 'safe-by-construction',
    why: 'Both enumerations stop above the wrapper roots: the classify() readdir lists .gsd itself and only tests membership of the specific names \'milestones\'/\'tasks\', and the discovery walk filters out dotted directories before descending, so neither ever consumes a milestone or task wrapper entry.',
  },
].map(Object.freeze));

function unlearnedReaders() {
  return WRAPPER_DIR_READERS.filter(reader => reader.verdict === 'breaks');
}

module.exports = { VERDICTS, VERDICT_NAMES, WRAPPER_DIR_READERS, unlearnedReaders };
