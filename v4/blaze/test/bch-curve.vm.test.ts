import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binToHex, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { TAKER, OWNER, KEEPER, TOKEN_A, catVm, le, net, nft, tb, utxo, buildTx, verify, lockOf, inputMetrics } from '../../test/harness.js';
import { encodeCurveStateV1, requiredBchSatoshis, type CurveStateV1 } from '../src/curve/state.js';
import { quoteBuy, quoteSell, type CurveInventory, type CurveConfig } from '../src/math/curve.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = JSON.parse(readFileSync(join(HERE, '..', 'artifacts', 'MeshBlazeBchCurveV1.json'), 'utf8'));
const config: CurveConfig = { virtualBase: 100_000n, virtualQuote: 1_000_000n, quoteThreshold: 500_000n, fees: { creatorBps: 50, partnerBps: 25, protocolBps: 25 } };
const initial: CurveInventory = { base: 1_000_000n, state: { stage: 0, realQuote: 0n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n } };
const carrier = 1_000n;
const costSamples: Array<{ path: string; bytes: number; opCost: number; maxOpCost: number }> = [];
function measure(path: string, built: ReturnType<typeof buildTx>) {
  const metric = inputMetrics(built)[0]!;
  assert.equal(metric.ok, true);
  assert.ok(metric.opCost <= metric.maxOpCost);
  costSamples.push({ path, bytes: built.size, opCost: metric.opCost, maxOpCost: metric.maxOpCost });
}
function rejectsAtCurve(result: true | string) {
  assert.equal(typeof result, 'string');
  assert.match(result as string, /input index 0/i);
}

function curve(cfg: CurveConfig = config) {
  const c = new Contract(ARTIFACT, [
    '0x' + catVm(TOKEN_A),
    '0x' + le(cfg.virtualBase, 8), '0x' + le(cfg.virtualQuote, 8), '0x' + le(cfg.quoteThreshold, 8),
    '0x' + le(carrier, 8), '0x' + le(cfg.fees.creatorBps, 2), '0x' + le(cfg.fees.partnerBps, 2), '0x' + le(cfg.fees.protocolBps, 2),
    '0x' + binToHex(sha256.hash(TAKER.lock)), '0x' + binToHex(sha256.hash(OWNER.lock)), '0x' + binToHex(sha256.hash(KEEPER.lock)),
  ], { provider: net, contractType: 'p2sh32' });
  return c;
}

function buyTx(input: CurveInventory, gross: bigint, tamper: 'none' | 'base' | 'fee' | 'refund' | 'shortRefund' | 'tokenRecipient' | 'nonminimal' = 'none', cfg: CurveConfig = config) {
  const c = curve(cfg);
  const quote = quoteBuy(cfg, input, gross);
  const next = structuredClone(quote.next);
  if (tamper === 'base') next.base -= 1n;
  if (tamper === 'fee') next.state.creatorFees += 1n;
  if (tamper === 'nonminimal') next.state.protocolFees += 1n;
  const before = requiredBchSatoshis(input.state, carrier);
  const after = requiredBchSatoshis(next.state, carrier);
  const buyerBch = 1_000_000n;
  const networkFee = tamper === 'shortRefund' ? 6_000n : 2_000n;
  const b = tb();
  b.addInput(utxo(c.lockingBytecode, before, nft(TOKEN_A, 'mutable', encodeCurveStateV1(input.state), input.base)), c.unlock.buy());
  b.addInput(utxo(TAKER.lock, buyerBch), TAKER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(c), amount: after, token: nft(TOKEN_A, 'mutable', encodeCurveStateV1(next.state), next.base) });
  b.addOutput({ to: tamper === 'tokenRecipient' ? OWNER.lock : TAKER.lock, amount: 1_000n, token: { category: TOKEN_A, amount: input.base - next.base } });
  b.addOutput({ to: tamper === 'refund' ? OWNER.lock : TAKER.lock, amount: before + buyerBch - after - 1_000n - networkFee });
  return { b, quote, next };
}

function sellTx(input: CurveInventory, baseIn: bigint, tamper: 'none' | 'reserve' | 'recipient' | 'fee' = 'none') {
  const c = curve();
  const quote = quoteSell(config, input, baseIn);
  const next = structuredClone(quote.next);
  if (tamper === 'reserve') next.state.realQuote -= 1n;
  const before = requiredBchSatoshis(input.state, carrier);
  const after = requiredBchSatoshis(next.state, carrier);
  const sellerSats = 10_000n;
  const networkFee = tamper === 'fee' ? 6_000n : 2_000n;
  const b = tb();
  b.addInput(utxo(c.lockingBytecode, before, nft(TOKEN_A, 'mutable', encodeCurveStateV1(input.state), input.base)), c.unlock.sell());
  b.addInput(utxo(TAKER.lock, sellerSats, { category: TOKEN_A, amount: baseIn }), TAKER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(c), amount: after, token: nft(TOKEN_A, 'mutable', encodeCurveStateV1(next.state), next.base) });
  b.addOutput({ to: tamper === 'recipient' ? OWNER.lock : TAKER.lock, amount: before + sellerSats - after - networkFee });
  return { b, quote };
}

function claimTx(input: CurveInventory, role: 0 | 1 | 2, tamper: 'none' | 'recipient' | 'reserve' = 'none') {
  const c = curve();
  const next = structuredClone(input);
  const field = (['creatorFees', 'partnerFees', 'protocolFees'] as const)[role];
  const amount = next.state[field];
  next.state[field] = 0n;
  if (tamper === 'reserve') next.state.realQuote -= 1n;
  const recipient = tamper === 'recipient' ? OWNER : [TAKER, OWNER, KEEPER][role]!;
  const before = requiredBchSatoshis(input.state, carrier);
  const after = requiredBchSatoshis(next.state, carrier);
  const b = tb();
  b.addInput(utxo(c.lockingBytecode, before, nft(TOKEN_A, 'mutable', encodeCurveStateV1(input.state), input.base)), c.unlock.claim(BigInt(role)));
  if (amount === 0n) b.addInput(utxo(TAKER.lock, 2_000n), TAKER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(c), amount: after, token: nft(TOKEN_A, 'mutable', encodeCurveStateV1(next.state), next.base) });
  b.addOutput({ to: recipient.lock, amount: amount || 1_000n });
  if (amount === 0n) b.addOutput({ to: TAKER.lock, amount: 1_000n });
  return b;
}

const cases: Array<[string, () => void]> = [
  ['honest buy passes BCH VM', () => {
    const { b } = buyTx(initial, 100_000n);
    const built = buildTx(b);
    assert.equal(verify(built), true);
    measure('buy', built);
  }],
  ['extra base token taken at same quote fails covenant', () => {
    const { b } = buyTx(initial, 100_000n, 'base');
    rejectsAtCurve(verify(buildTx(b)));
  }],
  ['fake fee accrual fails covenant', () => {
    const { b } = buyTx(initial, 100_000n, 'fee');
    rejectsAtCurve(verify(buildTx(b)));
  }],
  ['honest sell passes BCH VM', () => {
    const bought = quoteBuy(config, initial, 100_000n);
    const built = buildTx(sellTx(bought.next, 1_000n).b);
    assert.equal(verify(built), true);
    measure('sell', built);
  }],
  ['wrong sell quote delta fails covenant', () => {
    const bought = quoteBuy(config, initial, 100_000n);
    rejectsAtCurve(verify(buildTx(sellTx(bought.next, 1_000n, 'reserve').b)));
  }],
  ['redirected seller proceeds fail covenant', () => {
    const bought = quoteBuy(config, initial, 100_000n);
    rejectsAtCurve(verify(buildTx(sellTx(bought.next, 1_000n, 'recipient').b)));
  }],
  ['excessive seller network fee fails covenant', () => {
    const bought = quoteBuy(config, initial, 100_000n);
    rejectsAtCurve(verify(buildTx(sellTx(bought.next, 1_000n, 'fee').b)));
  }],
  ['terminal buy passes and next trade is unavailable in reference model', () => {
    const { b, quote } = buyTx(initial, 1_000_000n);
    const built = buildTx(b);
    assert.equal(verify(built), true);
    measure('terminal buy', built);
    assert.equal(quote.complete, true);
    assert.throws(() => quoteBuy(config, quote.next, 1_000n), /complete/);
  }],
  ['completed state rejects a further buy in BCH VM', () => {
    const done = quoteBuy(config, initial, 1_000_000n).next;
    const c = curve();
    const before = requiredBchSatoshis(done.state, carrier);
    const b = tb();
    b.addInput(utxo(c.lockingBytecode, before, nft(TOKEN_A, 'mutable', encodeCurveStateV1(done.state), done.base)), c.unlock.buy());
    b.addInput(utxo(TAKER.lock, 1_000_000n), TAKER.template.unlockP2PKH());
    b.addOutput({ to: lockOf(c), amount: before, token: nft(TOKEN_A, 'mutable', encodeCurveStateV1(done.state), done.base - 1n) });
    b.addOutput({ to: TAKER.lock, amount: 1_000n, token: { category: TOKEN_A, amount: 1n } });
    b.addOutput({ to: TAKER.lock, amount: 997_000n });
    rejectsAtCurve(verify(buildTx(b)));
  }],
  ['completed state rejects a further sell in BCH VM', () => {
    const done = quoteBuy(config, initial, 1_000_000n).next;
    const c = curve();
    const before = requiredBchSatoshis(done.state, carrier);
    const b = tb();
    b.addInput(utxo(c.lockingBytecode, before, nft(TOKEN_A, 'mutable', encodeCurveStateV1(done.state), done.base)), c.unlock.sell());
    b.addInput(utxo(TAKER.lock, 10_000n, { category: TOKEN_A, amount: 1n }), TAKER.template.unlockP2PKH());
    b.addOutput({ to: lockOf(c), amount: before, token: nft(TOKEN_A, 'mutable', encodeCurveStateV1(done.state), done.base + 1n) });
    b.addOutput({ to: TAKER.lock, amount: 8_000n });
    rejectsAtCurve(verify(buildTx(b)));
  }],
  ['redirected buyer change fails covenant', () => {
    rejectsAtCurve(verify(buildTx(buyTx(initial, 1_000_000n, 'refund').b)));
  }],
  ['excessive network fee fails covenant', () => {
    rejectsAtCurve(verify(buildTx(buyTx(initial, 1_000_000n, 'shortRefund').b)));
  }],
  ['redirected token payout fails covenant', () => {
    rejectsAtCurve(verify(buildTx(buyTx(initial, 100_000n, 'tokenRecipient').b)));
  }],
  ['nonminimal terminal gross fails covenant', () => {
    const nearThreshold: CurveInventory = { base: initial.base, state: { ...initial.state, realQuote: config.quoteThreshold - 99n } };
    const quote = quoteBuy(config, nearThreshold, 100n);
    assert.equal(quote.usedGross, 99n);
    rejectsAtCurve(verify(buildTx(buyTx(nearThreshold, 100n, 'nonminimal').b)));
  }],
  ['zero protocol share sends rounding remainder to creator', () => {
    const cfg: CurveConfig = { ...config, fees: { creatorBps: 50, partnerBps: 25, protocolBps: 0 } };
    const { b, quote } = buyTx(initial, 200n, 'none', cfg);
    assert.equal(quote.fees.creator, 1n);
    assert.equal(quote.fees.protocol, 0n);
    assert.equal(verify(buildTx(b)), true);
  }],
  ['zero creator and protocol shares send rounding remainder to partner', () => {
    const cfg: CurveConfig = { ...config, fees: { creatorBps: 0, partnerBps: 75, protocolBps: 0 } };
    const { b, quote } = buyTx(initial, 200n, 'none', cfg);
    assert.equal(quote.fees.partner, 1n);
    assert.equal(verify(buildTx(b)), true);
  }],
  ['creator fee claim pays designated recipient', () => {
    const bought = quoteBuy(config, initial, 200_000n);
    const built = buildTx(claimTx(bought.next, 0));
    assert.equal(verify(built), true);
    measure('claim', built);
  }],
  ['partner fee claim pays designated recipient', () => {
    const bought = quoteBuy(config, initial, 500_000n);
    assert.equal(verify(buildTx(claimTx(bought.next, 1))), true);
  }],
  ['protocol fee claim pays designated recipient', () => {
    const bought = quoteBuy(config, initial, 500_000n);
    assert.equal(verify(buildTx(claimTx(bought.next, 2))), true);
  }],
  ['fee claim to wrong recipient fails covenant', () => {
    const bought = quoteBuy(config, initial, 200_000n);
    rejectsAtCurve(verify(buildTx(claimTx(bought.next, 0, 'recipient'))));
  }],
  ['fee claim changing reserve fails covenant', () => {
    const bought = quoteBuy(config, initial, 200_000n);
    rejectsAtCurve(verify(buildTx(claimTx(bought.next, 0, 'reserve'))));
  }],
  ['empty balance cannot be claimed twice', () => {
    rejectsAtCurve(verify(buildTx(claimTx(initial, 0))));
  }],
  ['completed curve still pays accrued creator fee', () => {
    const bought = quoteBuy(config, initial, 1_000_000n);
    assert.equal(bought.complete, true);
    assert.equal(verify(buildTx(claimTx(bought.next, 0))), true);
  }],
];

let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}:`, error); }
}
console.log(`Mesh Blaze BCH curve VM: ${cases.length - failed} passed, ${failed} failed`);
for (const sample of costSamples) console.log(`COST ${sample.path}: ${sample.bytes} bytes, ${sample.opCost}/${sample.maxOpCost} op cost`);
if (failed) process.exitCode = 1;
