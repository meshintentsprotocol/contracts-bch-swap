import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, hash256, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { OWNER, TAKER, KEEPER, TOKEN_A, TOKEN_B, catVm, le, net,
  tb, utxo, buildTx, verify, inputMetrics, lockOf } from '../../test/harness.js';

const BASE = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenMarketBaseLockedV1.json', 'utf8'));
const QUOTE = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenMarketQuoteLockedV1.json', 'utf8'));
const COLLECTOR = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenFeeCollectorV1.json', 'utf8'));
const h = (bytes: Uint8Array) => binToHex(sha256.hash(bytes));
const collectors = [OWNER, TAKER, KEEPER].map((key) => new Contract(COLLECTOR,
  [`0x${catVm(TOKEN_B)}`, `0x${h(key.lock)}`, `0x${le(1_000n, 8)}`],
  { provider: net, contractType: 'p2sh32' }));
const sharedArgs = [`0x${catVm(TOKEN_A)}`, `0x${catVm(TOKEN_B)}`,
  `0x${le(2n, 8)}`, `0x${le(1n, 8)}`, `0x${le(21n, 8)}`, `0x${le(10n, 8)}`,
  `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`,
  ...collectors.map((c) => `0x${h(lockOf(c))}`),
  `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`];
const quote = new Contract(QUOTE, sharedArgs, { provider: net, contractType: 'p2sh32' });
const base = new Contract(BASE, [sharedArgs[0]!, sharedArgs[1]!,
  `0x${binToHex(hash256(hexToBin(quote.bytecode)))}`, ...sharedArgs.slice(2)],
{ provider: net, contractType: 'p2sh32' });
type Side = 'buy' | 'sell';
type Attack = 'none' | 'quoteReserve' | 'creatorFee' | 'buyerAmount' | 'quoteScript';
function trade(side: Side, attack: Attack = 'none') {
  const isBuy = side === 'buy';
  const baseBefore = isBuy ? 570_000n : 560_000n;
  const quoteBefore = isBuy ? 450_003n : 471_053n;
  const feesBefore = isBuy ? [0n, 0n, 0n] : [5n, 1n, 7n];
  const feesAfter = isBuy ? [5n, 1n, 7n] : [9n, 2n, 14n];
  const price = isBuy ? 21_000n : 20_000n;
  const fee = isBuy ? 63n : 60n;
  const lp = isBuy ? 50n : 48n;
  const builder = tb();
  builder.addInput(utxo(base.lockingBytecode, 1_000n,
    { category: TOKEN_A, amount: baseBefore }), isBuy ? base.unlock.buy() : base.unlock.sell());
  builder.addInput(utxo(quote.lockingBytecode, 1_000n,
    { category: TOKEN_B, amount: quoteBefore }), isBuy ? quote.unlock.buy() : quote.unlock.sell());
  for (let i = 0; i < 3; i++) builder.addInput(utxo(collectors[i]!.lockingBytecode, 1_000n,
    feesBefore[i]! > 0n ? { category: TOKEN_B, amount: feesBefore[i]! } : undefined),
  collectors[i]!.unlock.accrue());
  builder.addInput(utxo(TAKER.lock, 5_000n,
    { category: isBuy ? TOKEN_B : TOKEN_A, amount: isBuy ? price + fee : 10_000n }),
  TAKER.template.unlockP2PKH());
  builder.addOutput({ to: lockOf(base), amount: 1_000n,
    token: { category: TOKEN_A, amount: isBuy ? 560_000n : 570_000n } });
  builder.addOutput({ to: attack === 'quoteScript' ? OWNER.lock : lockOf(quote), amount: 1_000n,
    token: { category: TOKEN_B,
      amount: (isBuy ? quoteBefore + price + lp : quoteBefore - price + lp) +
        (attack === 'quoteReserve' ? 1n : 0n) } });
  for (let i = 0; i < 3; i++) builder.addOutput({ to: lockOf(collectors[i]!), amount: 1_000n,
    token: { category: TOKEN_B, amount: feesAfter[i]! +
      (attack === 'creatorFee' && i === 0 ? 1n : 0n) } });
  builder.addOutput({ to: TAKER.lock, amount: 1_000n,
    token: { category: isBuy ? TOKEN_A : TOKEN_B,
      amount: (isBuy ? 10_000n : price - fee) + (attack === 'buyerAmount' ? 1n : 0n) } });
  return buildTx(builder);
}
for (const side of ['buy', 'sell'] as const) {
  const good = trade(side);
  assert.equal(verify(good), true, `${side} must pass`);
  const metrics = inputMetrics(good);
  assert.equal(metrics[0]!.ok, true);
  assert.equal(metrics[1]!.ok, true);
  for (const attack of ['quoteReserve', 'creatorFee', 'buyerAmount', 'quoteScript'] as const) {
    const bad = trade(side, attack);
    assert.notEqual(verify(bad), true, `${side} ${attack} must fail`);
    const failed = inputMetrics(bad);
    assert.equal(failed[0]!.ok, false, `${side} ${attack} base must reject`);
    assert.equal(failed[1]!.ok, false, `${side} ${attack} quote must reject`);
  }
}
console.log('Mesh Blaze locked token market VM: buy/sell and 8 attacks passed');
