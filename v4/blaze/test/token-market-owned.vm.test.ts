import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, hash256, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { OWNER, TAKER, KEEPER, TOKEN_A, TOKEN_B, catVm, le, net, nft,
  tb, utxo, buildTx, verify, inputMetrics, lockOf } from '../../test/harness.js';

const BASE = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenMarketBaseOwnedV1.json', 'utf8'));
const QUOTE = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenMarketQuoteOwnedV1.json', 'utf8'));
const COLLECTOR = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenFeeCollectorV1.json', 'utf8'));
const ownerCat = '11'.repeat(32);
const h = (bytes: Uint8Array) => binToHex(sha256.hash(bytes));
const collectors = [OWNER, TAKER, KEEPER].map((key) => new Contract(COLLECTOR,
  [`0x${catVm(TOKEN_B)}`, `0x${h(key.lock)}`, `0x${le(1_000n, 8)}`],
{ provider: net, contractType: 'p2sh32' }));
const args = [`0x${catVm(TOKEN_A)}`, `0x${catVm(TOKEN_B)}`, `0x${catVm(ownerCat)}`,
  `0x${le(2n, 8)}`, `0x${le(1n, 8)}`, `0x${le(21n, 8)}`, `0x${le(10n, 8)}`,
  `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`,
  ...collectors.map((c) => `0x${h(lockOf(c))}`),
  `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`];
const quote = new Contract(QUOTE, args, { provider: net, contractType: 'p2sh32' });
const base = new Contract(BASE, [args[0]!, args[1]!, args[2]!,
  `0x${binToHex(hash256(hexToBin(quote.bytecode)))}`, ...args.slice(3)],
{ provider: net, contractType: 'p2sh32' });
type Attack = 'none' | 'wrongOwner' | 'baseAmount' | 'quoteAmount' | 'recipient' | 'fee';
function exit(attack: Attack) {
  const builder = tb();
  builder.addInput(utxo(base.lockingBytecode, 1_000n,
    { category: TOKEN_A, amount: 63_333n }), base.unlock.ownerExit());
  builder.addInput(utxo(quote.lockingBytecode, 1_000n,
    { category: TOKEN_B, amount: 50_000n }), quote.unlock.ownerExit());
  const position = nft(attack === 'wrongOwner' ? '22'.repeat(32) : ownerCat, 'none', '01');
  builder.addInput(utxo(OWNER.lock, 1_000n, position), OWNER.template.unlockP2PKH());
  builder.addInput(utxo(TAKER.lock, 5_000n), TAKER.template.unlockP2PKH());
  builder.addOutput({ to: attack === 'recipient' ? TAKER.lock : OWNER.lock, amount: 1_000n,
    token: { category: TOKEN_A, amount: 63_333n + (attack === 'baseAmount' ? 1n : 0n) } });
  builder.addOutput({ to: OWNER.lock, amount: 1_000n,
    token: { category: TOKEN_B, amount: 50_000n + (attack === 'quoteAmount' ? 1n : 0n) } });
  builder.addOutput({ to: OWNER.lock, amount: 1_000n, token: position });
  builder.addOutput({ to: TAKER.lock, amount: attack === 'fee' ? 5_000n : 1_000n });
  return buildTx(builder);
}
assert.equal(verify(exit('none')), true);
function buy() {
  const builder = tb();
  builder.addInput(utxo(base.lockingBytecode, 1_000n,
    { category: TOKEN_A, amount: 63_333n }), base.unlock.buy());
  builder.addInput(utxo(quote.lockingBytecode, 1_000n,
    { category: TOKEN_B, amount: 50_000n }), quote.unlock.buy());
  for (const collector of collectors)
    builder.addInput(utxo(collector.lockingBytecode, 1_000n), collector.unlock.accrue());
  builder.addInput(utxo(TAKER.lock, 5_000n,
    { category: TOKEN_B, amount: 21_063n }), TAKER.template.unlockP2PKH());
  builder.addOutput({ to: lockOf(base), amount: 1_000n,
    token: { category: TOKEN_A, amount: 53_333n } });
  builder.addOutput({ to: lockOf(quote), amount: 1_000n,
    token: { category: TOKEN_B, amount: 71_050n } });
  for (const [i, amount] of [5n, 1n, 7n].entries())
    builder.addOutput({ to: lockOf(collectors[i]!), amount: 1_000n,
      token: { category: TOKEN_B, amount } });
  builder.addOutput({ to: TAKER.lock, amount: 1_000n,
    token: { category: TOKEN_A, amount: 10_000n } });
  return buildTx(builder);
}
assert.equal(verify(buy()), true);
function sell() {
  const builder = tb();
  builder.addInput(utxo(base.lockingBytecode, 1_000n,
    { category: TOKEN_A, amount: 53_333n }), base.unlock.sell());
  builder.addInput(utxo(quote.lockingBytecode, 1_000n,
    { category: TOKEN_B, amount: 71_050n }), quote.unlock.sell());
  for (const [i, amount] of [5n, 1n, 7n].entries())
    builder.addInput(utxo(collectors[i]!.lockingBytecode, 1_000n,
      { category: TOKEN_B, amount }), collectors[i]!.unlock.accrue());
  builder.addInput(utxo(TAKER.lock, 5_000n,
    { category: TOKEN_A, amount: 10_000n }), TAKER.template.unlockP2PKH());
  builder.addOutput({ to: lockOf(base), amount: 1_000n,
    token: { category: TOKEN_A, amount: 63_333n } });
  builder.addOutput({ to: lockOf(quote), amount: 1_000n,
    token: { category: TOKEN_B, amount: 51_098n } });
  for (const [i, amount] of [9n, 2n, 14n].entries())
    builder.addOutput({ to: lockOf(collectors[i]!), amount: 1_000n,
      token: { category: TOKEN_B, amount } });
  builder.addOutput({ to: TAKER.lock, amount: 1_000n,
    token: { category: TOKEN_B, amount: 19_940n } });
  return buildTx(builder);
}
assert.equal(verify(sell()), true);
for (const attack of ['wrongOwner', 'baseAmount', 'quoteAmount', 'recipient', 'fee'] as const) {
  const tx = exit(attack);
  assert.notEqual(verify(tx), true, `${attack} must fail`);
  const metrics = inputMetrics(tx);
  assert.equal(metrics[0]!.ok, false, `${attack} base must reject`);
  assert.equal(metrics[1]!.ok, false, `${attack} quote must reject`);
}
console.log('Mesh Blaze owned token market VM: buy, sell, NFT exit and 5 attacks passed');
