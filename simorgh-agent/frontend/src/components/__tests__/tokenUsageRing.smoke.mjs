// Standalone smoke test for TokenUsageRing's stage thresholds and
// formatTokens helper. Duplicates the logic from TokenUsageRing.tsx so
// the test stays runnable under plain `node` (no jest / vitest /
// React in the loop).
//
//   node src/components/__tests__/tokenUsageRing.smoke.mjs

function stageFor(ratio) {
  if (ratio >= 0.95) return 'red';
  if (ratio >= 0.8)  return 'amber';
  return 'sky';
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `${n}`;
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   ${label}`);
  }
}

// --- stageFor thresholds (the user-requested colour rules) ---
assertEq(stageFor(0),     'sky',   '0% → sky');
assertEq(stageFor(0.50),  'sky',   '50% → sky');
assertEq(stageFor(0.79),  'sky',   '79% → sky (under threshold)');
assertEq(stageFor(0.80),  'amber', '80% → amber (boundary)');
assertEq(stageFor(0.90),  'amber', '90% → amber');
assertEq(stageFor(0.94),  'amber', '94% → amber (under red)');
assertEq(stageFor(0.95),  'red',   '95% → red (boundary)');
assertEq(stageFor(1.00),  'red',   '100% → red');
assertEq(stageFor(1.50),  'red',   'over-cap → still red');

// --- formatTokens edges ---
assertEq(formatTokens(0),         '0',     '0 tokens');
assertEq(formatTokens(42),        '42',    'sub-1k stays plain');
assertEq(formatTokens(999),       '999',   '999 stays plain');
assertEq(formatTokens(1_000),     '1.0k',  '1k → 1.0k');
assertEq(formatTokens(9_999),     '10.0k', '9999 rounds to 10.0k');
assertEq(formatTokens(10_000),    '10k',   '10k drops decimal');
assertEq(formatTokens(368_200),   '368k',  '368.2k context usage');
assertEq(formatTokens(1_000_000), '1.0M',  '1M boundary');
assertEq(formatTokens(2_500_000), '2.5M',  '2.5M');

if (process.exitCode) {
  console.error('\nsome assertions failed');
} else {
  console.log('\nall ok');
}
