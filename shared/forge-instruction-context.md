# Project instruction context

Project AGENTS.md/CLAUDE.md contain a bounded invariant bootstrap. Sync replaces
only the two independently owned managed blocks, retaining operator bytes and
marker/fence/EOL validation. Worker and workflow interaction projections remain
complete; this change does not remove their mandatory procedure composition.

Use `forge-instructions.js --context <name> --json` and consume `content`:

| Context | Required before |
| --- | --- |
| personal | Boot, resume, status and own-work selection |
| communication | First user-facing phase communication |
| entry | Classifying a new request, before creating a run or choosing direct work |
| routing | Preparing, dispatching or recovering a routed unit |
| interaction | Presenting/persisting questions or issuing recovery authorization |

Each context is composed from the same complete canonical implementation or
adjacent source used before compaction, with byte count and SHA256. Missing,
empty or invalid sources refuse the affected phase. A path/digest alone never
stands in for reading content. The phase procedure loader remains mandatory.

`--print` and renderBlock retain the detailed historical API. syncFile and
syncInstructions generate compact project entry blocks. Interaction sync defaults
to full content; only the project caller selects `{compact:true}`.

Generation refuses a resulting file above32768 UTF-8 bytes without changing it.
An explicitly supplied `--max-bytes N` changes that generator per-file budget;
it does not change the host's effective configuration. Measure global guidance,
ancestor files and mandatory imports separately. Moving content into always-loaded
imports does not reduce context. Operator content is never silently truncated.

Distribution/fixture tests establish byte preservation and discoverability, not
that every host will follow arbitrary prose. Record fresh-host observations and
their exact scope separately from local passing tests.
