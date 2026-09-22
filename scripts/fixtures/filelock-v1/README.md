# File-lock compatibility fixture

`forge-filelock.js` and `forge-lock.js` are unmodified copies from Forge 4.33.4
(commit `10b481116b060c57da4e9559925907af1b6c18e0`). Tests run these actual old
implementations against the v2 hashed format in both acquisition directions.
The optional runs registry is intentionally unavailable in the fixture; legacy
tests use unowned locks, for which the old implementation uses only age.

Do not update these fixtures when changing the current locking protocol.
