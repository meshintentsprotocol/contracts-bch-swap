import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binToHex, hash256, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { OWNER, TAKER, KEEPER, TOKEN_A, TOKEN_B, catVm, le, net, nft, tb, utxo, buildTx, verify, lockOf, inputMetrics } from '../../test/harness.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';
import { quoteBuy, quoteSell, type CurveConfig, type CurveInventory } from '../src/math/curve.js';
import { tokenPairFromManifestV1 } from '../src/curve/quote-vault.js';
import { planTokenPairBuyV1, verifyTokenPairBuyPlanV1 } from '../src/curve/token-pair-buy-plan.js';
import { planTokenPairSellV1, verifyTokenPairSellPlanV1 } from '../src/curve/token-pair-sell-plan.js';
import { planTokenPairClaimV1, verifyTokenPairClaimPlanV1 } from '../src/curve/token-pair-claim-plan.js';
import type { LaunchManifestV1 } from '../src/manifest/v1.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = JSON.parse(readFileSync(join(HERE, '..', 'artifacts', 'MeshBlazeTokenBaseVaultV1.json'), 'utf8'));
const QUOTE = JSON.parse(readFileSync(join(HERE, '..', 'artifacts', 'MeshBlazeTokenQuoteVaultV1.json'), 'utf8'));
const cfg: CurveConfig = { virtualBase: 100_000n, virtualQuote: 1_000_000n, quoteThreshold: 500_000n,
  fees: { creatorBps: 50, partnerBps: 25, protocolBps: 25 } };
const start: CurveInventory = { base: 1_000_000n,
  state: { stage: 0, realQuote: 0n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n } };
const scriptHash = (lock: Uint8Array) => binToHex(sha256.hash(lock));

function contracts() {
  const q = new Contract(QUOTE, [`0x${catVm(TOKEN_A)}`, `0x${catVm(TOKEN_B)}`, `0x${le(1_000n, 8)}`],
    { provider: net, contractType: 'p2sh32' });
  const b = new Contract(BASE, [
    `0x${catVm(TOKEN_A)}`, `0x${catVm(TOKEN_B)}`, `0x${binToHex(hash256(hexToBin(q.bytecode)))}`,
    `0x${le(cfg.virtualBase, 8)}`, `0x${le(cfg.virtualQuote, 8)}`, `0x${le(cfg.quoteThreshold, 8)}`,
    `0x${le(1_000n, 8)}`, `0x${le(cfg.fees.creatorBps, 2)}`, `0x${le(cfg.fees.partnerBps, 2)}`, `0x${le(cfg.fees.protocolBps, 2)}`,
    `0x${scriptHash(OWNER.lock)}`, `0x${scriptHash(TAKER.lock)}`, `0x${scriptHash(KEEPER.lock)}`,
  ], { provider: net, contractType: 'p2sh32' });
  return { b, q };
}
function pairManifest(base: Contract, quote: Contract): LaunchManifestV1 {
  const zero = '00'.repeat(32);
  const fees = { creator: { scriptHash: scriptHash(OWNER.lock), bps: 50 },
    partner: { scriptHash: scriptHash(TAKER.lock), bps: 25 }, protocol: { scriptHash: scriptHash(KEEPER.lock), bps: 25 } };
  return {
    version: 1, tokenCategory: TOKEN_A, quoteCategory: TOKEN_B, totalSupply: 1_000_000n,
    allocations: [{ name: 'curve', amount: 1_000_000n, satoshis: 1_000n, lockingBytecode: base.lockingBytecode,
      nftCommitment: encodeCurveStateV1(start.state) }],
    activationHeight: 400_000, alphaStartHeight: 0, alphaEndHeight: 0, presaleRoute: null, presaleScriptHash: zero,
    alphaModes: 0, alphaFixedScriptHash: zero, alphaBuyScriptHash: zero,
    virtualBase: cfg.virtualBase, virtualQuote: cfg.virtualQuote, graduationQuoteThreshold: cfg.quoteThreshold,
    lockedLiquidityBps: 9_000, curveScriptHash: scriptHash(hexToBin(base.lockingBytecode)),
    quoteVaultScriptHash: scriptHash(hexToBin(quote.lockingBytecode)), quoteVaultCarrierSats: 1_000n,
    graduationScriptHash: scriptHash(OWNER.lock), marketScriptHash: scriptHash(KEEPER.lock),
    curveFees: fees, marketFees: fees,
  };
}
function pairBuy(tamper: 'none' | 'price' | 'fee' | 'quoteScript' | 'shortRefund' | 'category' = 'none', buyerQuoteAmount = 20_000n, grossInput = 10_000n) {
  const { b, q } = contracts();
  const trade = quoteBuy(cfg, start, grossInput);
  const next = structuredClone(trade.next);
  if (tamper === 'price') next.base -= 1n;
  if (tamper === 'fee') { next.state.realQuote += 1n; next.state.creatorFees -= 1n; }
  const qInput = tamper === 'quoteScript' ? new Contract(QUOTE, [`0x${catVm(TOKEN_A)}`, `0x${catVm(TOKEN_B)}`, `0x${le(2_000n, 8)}`],
    { provider: net, contractType: 'p2sh32' }) : q;
  const quoteCarrier = tamper === 'quoteScript' ? 2_000n : 1_000n;
  const builder = tb();
  builder.addInput(utxo(b.lockingBytecode, 1_000n, nft(TOKEN_A, 'mutable', encodeCurveStateV1(start.state), start.base)), b.unlock.buy());
  builder.addInput(utxo(qInput.lockingBytecode, quoteCarrier), qInput.unlock.buy());
  builder.addInput(utxo(TAKER.lock, 5_000n, { category: tamper === 'category' ? TOKEN_A : TOKEN_B, amount: buyerQuoteAmount }), TAKER.template.unlockP2PKH());
  builder.addOutput({ to: lockOf(b), amount: 1_000n, token: nft(TOKEN_A, 'mutable', encodeCurveStateV1(next.state), next.base) });
  builder.addOutput({ to: lockOf(qInput), amount: quoteCarrier, token: { category: TOKEN_B, amount: trade.usedGross } });
  builder.addOutput({ to: TAKER.lock, amount: 1_000n, token: { category: TOKEN_A, amount: start.base - next.base } });
  if (buyerQuoteAmount > trade.usedGross) builder.addOutput({ to: TAKER.lock, amount: 2_000n,
    token: { category: TOKEN_B, amount: buyerQuoteAmount - trade.usedGross - (tamper === 'shortRefund' ? 1n : 0n) } });
  return builder;
}
function pairSell(tamper: 'none' | 'price' | 'fee' | 'recipient' | 'ledger' = 'none') {
  const { b, q } = contracts();
  const bought = quoteBuy(cfg, start, 100_000n).next;
  const trade = quoteSell(cfg, bought, 1_000n);
  const next = structuredClone(trade.next);
  const sellerBase = tamper === 'price' ? 1_001n : 1_000n;
  if (tamper === 'price') next.base += 1n;
  if (tamper === 'fee') { next.state.creatorFees += 1n; next.state.realQuote -= 1n; }
  const held0 = bought.state.realQuote + bought.state.creatorFees + bought.state.partnerFees + bought.state.protocolFees;
  const held1 = next.state.realQuote + next.state.creatorFees + next.state.partnerFees + next.state.protocolFees;
  const quoteOut = held0 - held1 - (tamper === 'ledger' ? 1n : 0n);
  const builder = tb();
  builder.addInput(utxo(b.lockingBytecode, 1_000n, nft(TOKEN_A, 'mutable', encodeCurveStateV1(bought.state), bought.base)), b.unlock.sell());
  builder.addInput(utxo(q.lockingBytecode, 1_000n, { category: TOKEN_B, amount: held0 }), q.unlock.sell());
  builder.addInput(utxo(TAKER.lock, 5_000n, { category: TOKEN_A, amount: sellerBase }), TAKER.template.unlockP2PKH());
  builder.addOutput({ to: lockOf(b), amount: 1_000n, token: nft(TOKEN_A, 'mutable', encodeCurveStateV1(next.state), next.base) });
  builder.addOutput({ to: lockOf(q), amount: 1_000n, token: { category: TOKEN_B, amount: held1 + (tamper === 'ledger' ? 1n : 0n) } });
  builder.addOutput({ to: tamper === 'recipient' ? OWNER.lock : TAKER.lock, amount: 3_000n,
    token: { category: TOKEN_B, amount: quoteOut } });
  return builder;
}
function pairClaim(role: 0 | 1 | 2, tamper: 'none' | 'recipient' | 'reserve' | 'sponsor' = 'none', complete = false) {
  const { b, q } = contracts();
  const bought = quoteBuy(cfg, start, complete ? 1_000_000n : 500_000n).next;
  const next = structuredClone(bought);
  const field = (['creatorFees', 'partnerFees', 'protocolFees'] as const)[role];
  const amount = bought.state[field];
  next.state[field] = 0n;
  if (tamper === 'reserve') next.state.realQuote -= 1n;
  const held0 = bought.state.realQuote + bought.state.creatorFees + bought.state.partnerFees + bought.state.protocolFees;
  const held1 = next.state.realQuote + next.state.creatorFees + next.state.partnerFees + next.state.protocolFees;
  const recipient = tamper === 'recipient' ? KEEPER : [OWNER, TAKER, KEEPER][role]!;
  const builder = tb();
  builder.addInput(utxo(b.lockingBytecode, 1_000n, nft(TOKEN_A, 'mutable', encodeCurveStateV1(bought.state), bought.base)), b.unlock.claim(BigInt(role)));
  builder.addInput(utxo(q.lockingBytecode, 1_000n, { category: TOKEN_B, amount: held0 }), q.unlock.claim(BigInt(role)));
  builder.addInput(utxo(OWNER.lock, 5_000n), OWNER.template.unlockP2PKH());
  builder.addOutput({ to: lockOf(b), amount: 1_000n, token: nft(TOKEN_A, 'mutable', encodeCurveStateV1(next.state), next.base) });
  builder.addOutput({ to: lockOf(q), amount: 1_000n, token: { category: TOKEN_B, amount: held1 } });
  builder.addOutput({ to: recipient.lock, amount: 1_000n, token: { category: TOKEN_B, amount } });
  builder.addOutput({ to: tamper === 'sponsor' ? TAKER.lock : OWNER.lock, amount: 2_000n });
  return builder;
}
function rejectsAtBase(result: true | string) {
  assert.equal(typeof result, 'string');
  assert.match(result as string, /input index 0/i);
}
const cases: Array<[string, () => void]> = [
  ['manifest reconstructs both paired covenant scripts in dependency order', () => {
    const { b, q } = contracts();
    const m = pairManifest(b, q);
    const rebuilt = tokenPairFromManifestV1(BASE, QUOTE, m, net);
    assert.equal(rebuilt.base.lockingBytecode, b.lockingBytecode);
    assert.equal(rebuilt.quote.lockingBytecode, q.lockingBytecode);
    assert.throws(() => tokenPairFromManifestV1(BASE, QUOTE, { ...m, quoteVaultScriptHash: scriptHash(OWNER.lock) }, net), /script differs/);
    assert.throws(() => tokenPairFromManifestV1(BASE, QUOTE, { ...m, curveScriptHash: scriptHash(OWNER.lock) }, net), /base script differs/);
  }],
  ['both paired covenant inputs accept one atomic CashToken-quote buy', () => {
    const built = buildTx(pairBuy());
    assert.equal(verify(built), true);
    const metrics = inputMetrics(built);
    assert.equal(metrics[0]!.ok, true);
    assert.equal(metrics[1]!.ok, true);
    console.log(`COST paired buy: ${built.size} bytes, base ${metrics[0]!.opCost}/${metrics[0]!.maxOpCost}, quote ${metrics[1]!.opCost}/${metrics[1]!.maxOpCost}`);
  }],
  ['exact-funded buy passes with three outputs and no quote change', () => {
    const built = buildTx(pairBuy('none', 10_000n));
    assert.equal(built.transaction.outputs.length, 3);
    assert.equal(verify(built), true);
  }],
  ['terminal buy partially fills and refunds excess quote tokens', () => {
    const trade = quoteBuy(cfg, start, 1_000_000n);
    assert.equal(trade.complete, true);
    assert.ok(trade.refund > 0n);
    const built = buildTx(pairBuy('none', 1_000_000n, 1_000_000n));
    assert.equal(built.transaction.outputs.length, 4);
    assert.equal(built.transaction.outputs[3]!.token!.amount, trade.refund);
    assert.equal(verify(built), true);
  }],
  ['terminal buy can use an exactly funded quote input', () => {
    const trade = quoteBuy(cfg, start, 1_000_000n);
    const built = buildTx(pairBuy('none', trade.usedGross, 1_000_000n));
    assert.equal(built.transaction.outputs.length, 3);
    assert.equal(verify(built), true);
  }],
  ['manifest-derived pair plan passes terminal buy in BCH VM', () => {
    const { b, q } = contracts();
    const m = pairManifest(b, q);
    const baseInput = utxo(b.lockingBytecode, 1_000n, nft(TOKEN_A, 'mutable', encodeCurveStateV1(start.state), start.base));
    const quoteInput = utxo(q.lockingBytecode, 1_000n);
    const buyerInput = utxo(TAKER.lock, 5_000n, { category: TOKEN_B, amount: 1_000_000n });
    const plan = planTokenPairBuyV1(m, baseInput, quoteInput, buyerInput, 1_000_000n, 2_000n, 1n);
    assert.equal(plan.quote.complete, true);
    assert.equal(plan.outputs.length, 4);
    verifyTokenPairBuyPlanV1(m, plan);
    const builder = tb();
    builder.addInput(baseInput, b.unlock.buy());
    builder.addInput(quoteInput, q.unlock.buy());
    builder.addInput(buyerInput, TAKER.template.unlockP2PKH());
    for (const output of plan.outputs) builder.addOutput({ to: hexToBin(output.lockingBytecode), amount: output.satoshis,
      ...(output.token ? { token: output.token } : {}) });
    assert.equal(verify(buildTx(builder)), true);
  }],
  ['pair plan rejects redirected refund and insufficient quote input', () => {
    const { b, q } = contracts();
    const m = pairManifest(b, q);
    const baseInput = utxo(b.lockingBytecode, 1_000n, nft(TOKEN_A, 'mutable', encodeCurveStateV1(start.state), start.base));
    const quoteInput = utxo(q.lockingBytecode, 1_000n);
    const buyerInput = utxo(TAKER.lock, 5_000n, { category: TOKEN_B, amount: 20_000n });
    const plan = planTokenPairBuyV1(m, baseInput, quoteInput, buyerInput, 10_000n, 2_000n, 1n);
    plan.outputs[3]!.lockingBytecode = binToHex(OWNER.lock);
    assert.throws(() => verifyTokenPairBuyPlanV1(m, plan), /refund destination/);
    assert.throws(() => planTokenPairBuyV1(m, baseInput, quoteInput,
      utxo(TAKER.lock, 5_000n, { category: TOKEN_B, amount: 5_000n }), 10_000n, 2_000n, 1n), /below used gross/);
  }],
  ['manifest-derived pair plan supports exact funding without quote change', () => {
    const { b, q } = contracts();
    const m = pairManifest(b, q);
    const baseInput = utxo(b.lockingBytecode, 1_000n, nft(TOKEN_A, 'mutable', encodeCurveStateV1(start.state), start.base));
    const quoteInput = utxo(q.lockingBytecode, 1_000n);
    const gross = quoteBuy(cfg, start, 1_000_000n).usedGross;
    const buyerInput = utxo(TAKER.lock, 5_000n, { category: TOKEN_B, amount: gross });
    const plan = planTokenPairBuyV1(m, baseInput, quoteInput, buyerInput, 1_000_000n, 2_000n, 1n);
    assert.equal(plan.outputs.length, 3);
    verifyTokenPairBuyPlanV1(m, plan);
    const builder = tb();
    builder.addInput(baseInput, b.unlock.buy());
    builder.addInput(quoteInput, q.unlock.buy());
    builder.addInput(buyerInput, TAKER.template.unlockP2PKH());
    for (const output of plan.outputs) builder.addOutput({ to: hexToBin(output.lockingBytecode), amount: output.satoshis,
      ...(output.token ? { token: output.token } : {}) });
    assert.equal(verify(buildTx(builder)), true);
  }],
  ['base covenant rejects a price-violating token payout', () => {
    rejectsAtBase(verify(buildTx(pairBuy('price'))));
  }],
  ['base covenant rejects a false creator fee split', () => {
    rejectsAtBase(verify(buildTx(pairBuy('fee'))));
  }],
  ['base covenant rejects a substituted quote-vault script', () => {
    rejectsAtBase(verify(buildTx(pairBuy('quoteScript'))));
  }],
  ['paired vaults reject a short quote-token refund', () => {
    rejectsAtBase(verify(buildTx(pairBuy('shortRefund'))));
  }],
  ['paired vaults reject the wrong buyer quote category', () => {
    const built = buildTx(pairBuy('category'));
    assert.equal(inputMetrics(built)[0]!.ok, false);
    assert.match(verify(built) as string, /token validation|input index 0/i);
  }],
  ['both paired covenant inputs accept an atomic token-quote sell', () => {
    const built = buildTx(pairSell());
    assert.equal(verify(built), true);
    const metrics = inputMetrics(built);
    assert.equal(metrics[0]!.ok, true);
    assert.equal(metrics[1]!.ok, true);
    console.log(`COST paired sell: ${built.size} bytes, base ${metrics[0]!.opCost}/${metrics[0]!.maxOpCost}, quote ${metrics[1]!.opCost}/${metrics[1]!.maxOpCost}`);
  }],
  ['paired sell rejects changed price', () => {
    rejectsAtBase(verify(buildTx(pairSell('price'))));
  }],
  ['paired sell rejects altered fee accounting', () => {
    rejectsAtBase(verify(buildTx(pairSell('fee'))));
  }],
  ['paired sell rejects diverted quote payout', () => {
    rejectsAtBase(verify(buildTx(pairSell('recipient'))));
  }],
  ['paired sell rejects an inconsistent quote-vault ledger', () => {
    rejectsAtBase(verify(buildTx(pairSell('ledger'))));
  }],
  ['manifest-derived paired sell plan passes both BCH VM inputs', () => {
    const { b, q } = contracts();
    const m = pairManifest(b, q);
    const bought = quoteBuy(cfg, start, 100_000n).next;
    const held = bought.state.realQuote + bought.state.creatorFees + bought.state.partnerFees + bought.state.protocolFees;
    const baseInput = utxo(b.lockingBytecode, 1_000n, nft(TOKEN_A, 'mutable', encodeCurveStateV1(bought.state), bought.base));
    const quoteInput = utxo(q.lockingBytecode, 1_000n, { category: TOKEN_B, amount: held });
    const sellerInput = utxo(TAKER.lock, 5_000n, { category: TOKEN_A, amount: 1_000n });
    const plan = planTokenPairSellV1(m, baseInput, quoteInput, sellerInput, 2_000n, 1n);
    verifyTokenPairSellPlanV1(m, plan);
    const builder = tb();
    builder.addInput(baseInput, b.unlock.sell());
    builder.addInput(quoteInput, q.unlock.sell());
    builder.addInput(sellerInput, TAKER.template.unlockP2PKH());
    for (const output of plan.outputs) builder.addOutput({ to: hexToBin(output.lockingBytecode), amount: output.satoshis,
      ...(output.token ? { token: output.token } : {}) });
    assert.equal(verify(buildTx(builder)), true);
    plan.outputs[2].lockingBytecode = binToHex(OWNER.lock);
    assert.throws(() => verifyTokenPairSellPlanV1(m, plan), /output 2 differs/);
  }],
  ['creator, partner and protocol claims each pass both paired covenants', () => {
    for (const role of [0, 1, 2] as const) {
      const built = buildTx(pairClaim(role));
      assert.equal(verify(built), true);
      const metrics = inputMetrics(built);
      assert.equal(metrics[0]!.ok, true);
      assert.equal(metrics[1]!.ok, true);
      if (role === 0) console.log(`COST paired claim: ${built.size} bytes, base ${metrics[0]!.opCost}/${metrics[0]!.maxOpCost}, quote ${metrics[1]!.opCost}/${metrics[1]!.maxOpCost}`);
    }
  }],
  ['completed paired curve still pays accrued creator fees', () => {
    assert.equal(verify(buildTx(pairClaim(0, 'none', true))), true);
  }],
  ['manifest-derived fee claim passes both paired covenants', () => {
    const { b, q } = contracts();
    const m = pairManifest(b, q);
    const bought = quoteBuy(cfg, start, 500_000n).next;
    const held = bought.state.realQuote + bought.state.creatorFees + bought.state.partnerFees + bought.state.protocolFees;
    const base = utxo(b.lockingBytecode, 1_000n, nft(TOKEN_A, 'mutable', encodeCurveStateV1(bought.state), bought.base));
    const quote = utxo(q.lockingBytecode, 1_000n, { category: TOKEN_B, amount: held });
    const sponsor = utxo(OWNER.lock, 5_000n);
    const plan = planTokenPairClaimV1(m, base, quote, sponsor, 0, binToHex(OWNER.lock), 2_000n);
    verifyTokenPairClaimPlanV1(m, plan);
    const builder = tb();
    builder.addInput(base, b.unlock.claim(0n));
    builder.addInput(quote, q.unlock.claim(0n));
    builder.addInput(sponsor, OWNER.template.unlockP2PKH());
    for (const output of plan.outputs) builder.addOutput({ to: hexToBin(output.lockingBytecode), amount: output.satoshis,
      ...(output.token ? { token: output.token } : {}) });
    assert.equal(verify(buildTx(builder)), true);
    plan.outputs[2].lockingBytecode = binToHex(KEEPER.lock);
    assert.throws(() => verifyTokenPairClaimPlanV1(m, plan), /output 2 differs/);
  }],
  ['paired claim rejects payment to the wrong recipient', () => {
    rejectsAtBase(verify(buildTx(pairClaim(0, 'recipient'))));
  }],
  ['paired claim rejects a changed real quote reserve', () => {
    rejectsAtBase(verify(buildTx(pairClaim(0, 'reserve'))));
  }],
  ['paired claim rejects redirected sponsor change', () => {
    rejectsAtBase(verify(buildTx(pairClaim(0, 'sponsor'))));
  }],
];
let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}:`, error); }
}
console.log(`Mesh Blaze paired token-quote VM: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
