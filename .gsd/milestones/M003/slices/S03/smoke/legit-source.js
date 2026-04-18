'use strict';

// Legit source for S03 verifier smoke test.
// Exercises: Exists pass (file present), Substantive pass
// (> min_lines + no stub regex matches), Wired pass (referenced
// by legit-plan's must_haves chain).

function add(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new TypeError('add expects numeric arguments');
  }
  return a + b;
}

module.exports = { add };
