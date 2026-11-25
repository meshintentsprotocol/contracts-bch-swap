import assert from 'node:assert/strict';
import { estimateBchChipnetBudget } from '../src/graduation/chipnet-budget.js';

const rights = { creator: { bps: 50, scriptHash: '11'.repeat(32) },
  partner: { bps: 25, scriptHash: '22'.repeat(32) },
  protocol: { bps: 25, scriptHash: '33'.repeat(32) } };
const manifest = { quoteCategory: null, graduationQuoteThreshold: 500_003n, curveFees: rights,
  allocations: [{ name: 'curve', amount: 1_000_000n, satoshis: 1_000n, lockingBytecode: '51' }],
  lockedLiquidityBps: 9_000 };
const terms = { lockedBps: 9_000, collectorCarrierSats: 1_000n };
const reserves = { tradeFloatSats: 100_000n, networkFeeReserveSats: 100_000n,
  positionNftCarrierSats: 1_000n };
const budget = estimateBchChipnetBudget(manifest, terms, reserves);
assert.equal(budget.grossBuyBudget, 505_054n);
assert.equal(budget.minimumLockedQuote, 450_003n);
assert.equal(budget.capitalNeeded, 712_054n);
assert.ok(budget.capitalNeeded < 1_000_000n);
assert.equal(estimateBchChipnetBudget({ ...manifest, lockedLiquidityBps: 10_000 },
  { ...terms, lockedBps: 10_000 }, reserves).binCarriers, 1_000n);
assert.throws(() => estimateBchChipnetBudget(manifest, { ...terms, lockedBps: 10_000 }, reserves), /invalid lock share/);
assert.throws(() => estimateBchChipnetBudget({ ...manifest, quoteCategory: '44'.repeat(32) }, terms, reserves), /BCH quote/);
assert.throws(() => estimateBchChipnetBudget(manifest, terms,
  { ...reserves, networkFeeReserveSats: -1n }), /invalid reserves/);
console.log('BCH chipnet funding budget: 8 assertions passed');
