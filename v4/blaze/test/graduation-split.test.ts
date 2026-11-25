import assert from 'node:assert/strict';
import { graduationSplitV1 } from '../src/graduation/split.js';

const a = graduationSplitV1(100_001n, 500_003n, 9_000);
assert.deepEqual(a, { lockedBase: 90_001n, creatorBase: 10_000n, lockedQuote: 450_003n, creatorQuote: 50_000n });
assert.ok(a.lockedBase * 10_000n >= 100_001n * 9_000n);
assert.ok(a.lockedQuote * 10_000n >= 500_003n * 9_000n);
assert.equal(a.lockedBase + a.creatorBase, 100_001n);
assert.equal(a.lockedQuote + a.creatorQuote, 500_003n);
assert.deepEqual(graduationSplitV1(17n, 19n, 10_000), {
  lockedBase: 17n, creatorBase: 0n, lockedQuote: 19n, creatorQuote: 0n,
});
assert.throws(() => graduationSplitV1(10n, 10n, 8_999), /lock share/);
assert.throws(() => graduationSplitV1(0n, 10n, 9_000), /both assets/);
console.log('Mesh Blaze graduation split: 8 assertions passed');
