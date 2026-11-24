# Documentation retirement — test-only measured view

Based on published commit b8f1df6d0020d0a8fb0d7d2ecdcdd7027459445e. Retired documents are absent in the current tree, not recreated as active guidance. Only their exact old bytes are served to unchanged historical validators. The owner proposal is archived verbatim in proposal.md (13754 bytes; SHA256 fc0b24c8eac217b8e8a263a44ed10f5bad2b1ac942447160237bbee37b487d51), including the original12496-byte prefix and appended historical implementation-status record. It is not a new delivery or UAT statement.

All224 published fixture files at this base, including the three #457/#458 files, remain byte-identical. Current real sources/retirements and complete fixture membership are checked before any ancestor validator. Historical callback bytes are accepted only at exact measured stages; unknown input is refused. No global module/fs hook, source registry change, production module, VERSION or release is introduced. Existing legacy API meanings and one predecessor delegation are retained.

Execution: authorized native worker; model/effort unknown, no canonical Forge dispatch or receipt claimed. Focused tests and independent review establish only their stated scope, not a new release/install or OS isolation.
