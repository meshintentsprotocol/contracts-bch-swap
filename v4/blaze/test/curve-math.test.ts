import assert from 'node:assert/strict';
import { decodeCurveStateV1, encodeCurveStateV1, requiredBchSatoshis, type CurveStateV1 } from '../src/curve/state.js';
import { quoteBuy, quoteSell, splitQuoteFee, type CurveConfig, type CurveInventory } from '../src/math/curve.js';

const config: CurveConfig = {
  virtualBase: 100_000n, virtualQuote: 1_000_000n, quoteThreshold: 500_000n,
  fees: { creatorBps: 50, partnerBps: 25, protocolBps: 25 },
};
const initial: CurveInventory = {
  base: 1_000_000n,
  state: { stage: 0, realQuote: 0n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n },
};

const cases: Array<[string, () => void]> = [
  ['state commitment is a strict 34-byte round trip', () => {
    const encoded = encodeCurveStateV1(initial.state);
    assert.equal(encoded.length, 68);
    assert.deepEqual(decodeCurveStateV1(encoded), initial.state);
    assert.throws(() => decodeCurveStateV1(encoded.slice(2)), /34 lowercase bytes/);
  }],
  ['buy moves real quote and accrues fees without losing BCH', () => {
    const buy = quoteBuy(config, initial, 100_000n);
    assert.equal(buy.usedGross, 100_000n);
    assert.equal(buy.netQuote, 99_000n);
    assert.equal(buy.fees.total, 1_000n);
    assert.equal(buy.fees.creator + buy.fees.partner + buy.fees.protocol, buy.fees.total);
    assert.equal(requiredBchSatoshis(buy.next.state, 1_000n) - requiredBchSatoshis(initial.state, 1_000n), buy.usedGross);
    assert.equal((buy.next.base + config.virtualBase) * (buy.next.state.realQuote + config.virtualQuote) >= (initial.base + config.virtualBase) * (initial.state.realQuote + config.virtualQuote), true);
  }],
  ['threshold-crossing buy uses exact net quote and refunds excess', () => {
    const buy = quoteBuy(config, initial, 1_000_000n);
    assert.equal(buy.next.state.realQuote, config.quoteThreshold);
    assert.equal(buy.complete, true);
    assert.equal(buy.next.state.stage, 1);
    assert.equal(buy.usedGross + buy.refund, 1_000_000n);
    assert.equal(buy.netQuote, 500_000n);
    assert.equal(buy.refund > 0n, true);
    assert.throws(() => quoteBuy(config, buy.next, 1_000n), /trading is complete/);
  }],
  ['sell pays only from real quote and keeps fee in state', () => {
    const bought = quoteBuy(config, initial, 100_000n);
    const sell = quoteSell(config, bought.next, 1_000n);
    assert.equal(sell.grossQuote <= bought.next.state.realQuote, true);
    assert.equal(sell.grossQuote - sell.fees.total, sell.traderQuote);
    assert.equal(requiredBchSatoshis(bought.next.state, 1_000n) - requiredBchSatoshis(sell.next.state, 1_000n), sell.traderQuote);
    assert.equal((sell.next.base + config.virtualBase) * (sell.next.state.realQuote + config.virtualQuote) >= (bought.next.base + config.virtualBase) * (bought.next.state.realQuote + config.virtualQuote), true);
  }],
  ['initial sell cannot take virtual quote', () => {
    assert.throws(() => quoteSell(config, initial, 10_000n), /virtual quote/);
  }],
  ['sub-unit buy is rejected rather than collecting dust', () => {
    assert.throws(() => quoteBuy({ ...config, virtualQuote: 10_000_000n }, initial, 1n), /rounds to zero/);
  }],
  ['fee split never pays a zero-weight recipient', () => {
    const split = splitQuoteFee(1_000n, { creatorBps: 0, partnerBps: 90, protocolBps: 10 });
    assert.equal(split.creator, 0n);
    assert.equal(split.total, split.creator + split.partner + split.protocol);
  }],
  ['negative and overflowing counters are rejected', () => {
    assert.throws(() => encodeCurveStateV1({ ...initial.state, realQuote: -1n }), /outside signed VM range/);
    assert.throws(() => encodeCurveStateV1({ ...initial.state, realQuote: 1n << 63n }), /outside signed VM range/);
  }],
];

let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}:`, error); }
}
console.log(`Mesh Blaze curve math: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
