// Standalone smoke test for the ProjectStatusIcon variant picker.
// Runs under `node`; no jest/vitest required. The frontend package
// currently has no test runner — when one is added, drop this in
// favour of a proper *.test.tsx file.
//
//   node src/components/__tests__/projectStatusIcon.smoke.mjs
//
// The variant table is duplicated here on purpose so this script
// stays independent of the TSX module's runtime imports (React,
// lucide-react). It exercises the *priority* rules, which are the
// only part that's likely to regress.

function pickVariant(status) {
  if (!status) return 'idle';
  if (status.branch === 'conflict') return 'conflict';
  if (status.container === 'error') return 'error';
  if (status.container === 'busy') return 'busy';
  if (status.container === 'stopped_incomplete') return 'stopped_incomplete';
  if (status.branch === 'merged') return 'merged';
  if (status.branch === 'pushed') return 'pushed';
  if (status.container === 'running' || status.container === 'paused') return 'paused';
  if (status.branch === 'created' || status.branch === 'committed') return 'created';
  if (status.container === 'stopped') return 'stopped';
  return 'idle';
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${expected}, got ${actual}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   ${label}`);
  }
}

// undefined status → idle
assertEq(pickVariant(undefined), 'idle', 'undefined → idle');

// conflict outranks everything (a busy + conflict still shows conflict).
assertEq(
  pickVariant({ container: 'busy', branch: 'conflict' }),
  'conflict',
  'conflict outranks busy'
);

// busy outranks branch-pushed: in-flight state > stale "everything is up".
assertEq(
  pickVariant({ container: 'busy', branch: 'pushed' }),
  'busy',
  'busy outranks pushed'
);

// stopped_incomplete outranks merged: a half-finished workspace is
// more important to surface than that an older MR landed.
assertEq(
  pickVariant({ container: 'stopped_incomplete', branch: 'merged' }),
  'stopped_incomplete',
  'stopped_incomplete outranks merged'
);

// Running + no work yet → calm blue paused dot, not violet "branch created".
assertEq(
  pickVariant({ container: 'running', branch: 'created' }),
  'paused',
  'running container hides branch-created (shows paused dot)'
);

// Pushed wins over paused only when the container isn't running.
assertEq(
  pickVariant({ container: 'stopped', branch: 'pushed' }),
  'pushed',
  'stopped + pushed → pushed (not stopped dot)'
);

// Plain idle: no branch, no container.
assertEq(
  pickVariant({ container: 'absent', branch: 'none' }),
  'idle',
  'absent + no branch → idle'
);

// Branch created, container never started → violet GitBranch icon.
assertEq(
  pickVariant({ container: 'absent', branch: 'created' }),
  'created',
  'absent + created → created'
);

// Error short-circuits everything except conflict (which is even higher).
assertEq(
  pickVariant({ container: 'error', branch: 'created' }),
  'error',
  'error short-circuits created'
);

// Conflict beats error.
assertEq(
  pickVariant({ container: 'error', branch: 'conflict' }),
  'conflict',
  'conflict beats error'
);

if (process.exitCode) {
  console.error('\nsome assertions failed');
} else {
  console.log('\nall ok');
}
