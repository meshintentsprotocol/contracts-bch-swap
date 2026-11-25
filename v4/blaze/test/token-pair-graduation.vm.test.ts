import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, encodeTransaction, hash256, hashTransaction, hexToBin, sha256,
  type Transaction } from '@bitauth/libauth';
import { Contract, type SpendableUtxo } from 'cashscript';
import { OWNER, TAKER, KEEPER, TOKEN_A, TOKEN_B, catVm, le, net, nft,
  tb, utxo, buildTx, verify, lockOf, inputMetrics } from '../../test/harness.js';
import { encodeCurveStateV1, type CurveStateV1 } from '../src/curve/state.js';
import { quoteBuy, quoteSell } from '../src/math/curve.js';
import { planTokenPairBuyV1 } from '../src/curve/token-pair-buy-plan.js';
import { planTokenPairSellV1 } from '../src/curve/token-pair-sell-plan.js';
import { planTokenPairClaimV1 } from '../src/curve/token-pair-claim-plan.js';
import { buildSignedTokenPairAction } from '../src/curve/token-pair-signed-trades.js';
import { tokenPairGraduationTermsHashV1, planTokenPairGraduationV1,
  type TokenPairGraduationTermsV1 } from '../src/graduation/token-pair-handoff.js';
import { tokenPairV2FromManifest } from '../src/graduation/token-pair-v2.js';
import { buildSignedTokenPairGraduationV1 } from '../src/graduation/token-pair-signed-handoff.js';
import { verifyTokenPairLaunchBundleV1 } from '../src/graduation/token-pair-launch-bundle.js';
import { planSeed, planFixedSupplyGenesis } from '../src/genesis/plan.js';
import { launchManifestHashV1, verifyGenesisAgainstManifestV1 } from '../src/manifest/v1.js';
import { verifyLaunchGenesisBundleCommitmentV1 } from '../src/graduation/launch-bundle.js';
import { planCreatorPositionGenesis } from '../src/graduation/position-genesis.js';
import type { LaunchManifestV1 } from '../src/manifest/v1.js';

const BASE = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenBaseVaultV2Prototype.json', 'utf8'));
const QUOTE = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenQuoteVaultV2Prototype.json', 'utf8'));
const ARCHIVE = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeStateArchiveV1.json', 'utf8'));
const MARKET_BASE_LOCKED = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenMarketBaseLockedV1.json', 'utf8'));
const MARKET_QUOTE_LOCKED = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenMarketQuoteLockedV1.json', 'utf8'));
const MARKET_BASE_OWNED = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenMarketBaseOwnedV1.json', 'utf8'));
const MARKET_QUOTE_OWNED = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenMarketQuoteOwnedV1.json', 'utf8'));
const COLLECTOR = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenFeeCollectorV1.json', 'utf8'));
const h = (script: Uint8Array) => binToHex(sha256.hash(script));
const archive = new Contract(ARCHIVE, [], { provider: net, contractType: 'p2sh32' });
const terminal = { stage: 1 as const, realQuote: 500_003n,
  creatorFees: 0n, partnerFees: 0n, protocolFees: 0n };
const rights = { creator: { scriptHash: h(OWNER.lock), bps: 50 },
  partner: { scriptHash: h(TAKER.lock), bps: 25 }, protocol: { scriptHash: h(KEEPER.lock), bps: 25 } };
const marketRights = { creator: { scriptHash: h(OWNER.lock), bps: 800 },
  partner: { scriptHash: h(TAKER.lock), bps: 200 }, protocol: { scriptHash: h(KEEPER.lock), bps: 1_000 } };
const positionSeed = planSeed(net, utxo(OWNER.lock, 100_000n), OWNER.template, 600n);
const positionCommitment = '01' + 'ab'.repeat(32);
const positionGenesis = planCreatorPositionGenesis(net, positionSeed, OWNER.template,
  binToHex(OWNER.lock), positionCommitment, 900n, binToHex(OWNER.lock));
function fixture(lockedBps: 9_000 | 10_000, marketBid = 7n, marketAsk = 8n,
  launchCat = TOKEN_A, quoteCat = TOKEN_B, marketBidDen = 1n, marketAskDen = 1n) {
  const collectors = [OWNER, TAKER, KEEPER].map((key) => new Contract(COLLECTOR,
    [`0x${catVm(quoteCat)}`, `0x${h(key.lock)}`, `0x${le(1_000n, 8)}`],
    { provider: net, contractType: 'p2sh32' }));
  const marketArgs = [`0x${catVm(launchCat)}`, `0x${catVm(quoteCat)}`,
    `0x${le(marketBid, 8)}`, `0x${le(marketBidDen, 8)}`,
    `0x${le(marketAsk, 8)}`, `0x${le(marketAskDen, 8)}`,
    `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`,
    ...collectors.map((collector) => `0x${h(lockOf(collector))}`),
    `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`];
  const lockedQuote = new Contract(MARKET_QUOTE_LOCKED, marketArgs,
    { provider: net, contractType: 'p2sh32' });
  const lockedBase = new Contract(MARKET_BASE_LOCKED, [marketArgs[0]!, marketArgs[1]!,
    `0x${binToHex(hash256(hexToBin(lockedQuote.bytecode)))}`, ...marketArgs.slice(2)],
    { provider: net, contractType: 'p2sh32' });
  const ownerCat = positionSeed.category;
  const ownedQuote = new Contract(MARKET_QUOTE_OWNED,
    [marketArgs[0]!, marketArgs[1]!, `0x${catVm(ownerCat)}`, ...marketArgs.slice(2)],
    { provider: net, contractType: 'p2sh32' });
  const ownedBase = new Contract(MARKET_BASE_OWNED,
    [marketArgs[0]!, marketArgs[1]!, `0x${catVm(ownerCat)}`,
      `0x${binToHex(hash256(hexToBin(ownedQuote.bytecode)))}`, ...marketArgs.slice(2)],
    { provider: net, contractType: 'p2sh32' });
  const terms: TokenPairGraduationTermsV1 = {
    creatorPositionCategory: ownerCat,
    lockedBaseScript: lockedBase.lockingBytecode, lockedQuoteScript: lockedQuote.lockingBytecode,
    creatorBaseScript: ownedBase.lockingBytecode, creatorQuoteScript: ownedQuote.lockingBytecode,
    archiveScript: archive.lockingBytecode,
    collectorScripts: collectors.map((collector) => collector.lockingBytecode) as [string, string, string],
    lockedBps, marketCarrierSats: 1_000n, collectorCarrierSats: 1_000n,
  };
  const hashes = [terms.lockedBaseScript, terms.lockedQuoteScript, terms.creatorBaseScript,
    terms.creatorQuoteScript, terms.archiveScript, ...terms.collectorScripts].map((script) => `0x${h(hexToBin(script))}`);
  const q = new Contract(QUOTE, [`0x${catVm(launchCat)}`, `0x${catVm(quoteCat)}`,
    `0x${le(1_000n, 8)}`, `0x${le(500_003n, 8)}`,
    `0x${le(100_000n, 8)}`, `0x${le(1_000_000n, 8)}`, `0x${le(1_000n, 8)}`,
    `0x${le(BigInt(lockedBps), 2)}`, `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`, ...hashes,
    `0x${le(marketBid, 8)}`, `0x${le(marketBidDen, 8)}`,
    `0x${le(marketAsk, 8)}`, `0x${le(marketAskDen, 8)}`],
  { provider: net, contractType: 'p2sh32' });
  const b = new Contract(BASE, [`0x${catVm(launchCat)}`, `0x${catVm(quoteCat)}`,
    `0x${binToHex(hash256(hexToBin(q.bytecode)))}`,
    `0x${le(100_000n, 8)}`, `0x${le(1_000_000n, 8)}`, `0x${le(500_003n, 8)}`,
    `0x${le(1_000n, 8)}`, `0x${le(50n, 2)}`, `0x${le(25n, 2)}`, `0x${le(25n, 2)}`,
    `0x${h(OWNER.lock)}`, `0x${h(TAKER.lock)}`, `0x${h(KEEPER.lock)}`,
    `0x${le(1_000n, 8)}`, `0x${le(BigInt(lockedBps), 2)}`,
    `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`, ...hashes,
    `0x${le(marketBid, 8)}`, `0x${le(marketBidDen, 8)}`,
    `0x${le(marketAsk, 8)}`, `0x${le(marketAskDen, 8)}`],
  { provider: net, contractType: 'p2sh32' });
  const zero = '00'.repeat(32);
  const m: LaunchManifestV1 = {
    version: 1, tokenCategory: launchCat, quoteCategory: quoteCat, totalSupply: 1_000_000n,
    allocations: [{ name: 'curve', amount: 1_000_000n, satoshis: 1_000n,
      lockingBytecode: b.lockingBytecode,
      nftCommitment: encodeCurveStateV1({ ...terminal, stage: 0, realQuote: 0n }) }],
    activationHeight: 400_000, alphaStartHeight: 0, alphaEndHeight: 0, presaleRoute: null,
    presaleScriptHash: zero, alphaModes: 0, alphaFixedScriptHash: zero, alphaBuyScriptHash: zero,
    virtualBase: 100_000n, virtualQuote: 1_000_000n, graduationQuoteThreshold: 500_003n,
    lockedLiquidityBps: lockedBps, curveScriptHash: h(lockOf(b)), quoteVaultScriptHash: h(lockOf(q)),
    quoteVaultCarrierSats: 1_000n, graduationScriptHash: h(lockOf(b)),
    marketScriptHash: h(lockOf(lockedBase)), curveFees: rights, marketFees: marketRights,
  };
  const artifacts = { curveBase: BASE, curveQuote: QUOTE,
    marketBaseLocked: MARKET_BASE_LOCKED, marketQuoteLocked: MARKET_QUOTE_LOCKED,
    marketBaseOwned: MARKET_BASE_OWNED, marketQuoteOwned: MARKET_QUOTE_OWNED,
    collector: COLLECTOR, archive: ARCHIVE };
  const market = { bidNum: marketBid, bidDen: marketBidDen,
    askNum: marketAsk, askDen: marketAskDen,
    tradingFeeBps: 30, marketCarrierSats: 1_000n, collectorCarrierSats: 1_000n };
  const reconstructed = tokenPairV2FromManifest(m, market, terms, artifacts, net);
  assert.equal(reconstructed.curveBase.lockingBytecode, b.lockingBytecode);
  assert.equal(reconstructed.curveQuote.lockingBytecode, q.lockingBytecode);
  assert.equal(reconstructed.lockedBase.lockingBytecode, lockedBase.lockingBytecode);
  assert.throws(() => tokenPairV2FromManifest({ ...m, marketScriptHash: h(OWNER.lock) },
    market, terms, artifacts, net), /market script/);
  assert.throws(() => tokenPairV2FromManifest(m, market,
    { ...terms, collectorScripts: [binToHex(OWNER.lock), ...terms.collectorScripts.slice(1)] as [string, string, string] },
    artifacts, net), /destination/);
  const bundleHash = verifyTokenPairLaunchBundleV1(m, market, terms, positionGenesis.transaction,
    positionGenesis.sourceOutputs, binToHex(OWNER.lock), positionCommitment, artifacts, net);
  assert.match(bundleHash, /^[0-9a-f]{64}$/);
  assert.throws(() => verifyTokenPairLaunchBundleV1(m, market, terms, positionGenesis.transaction,
    positionGenesis.sourceOutputs, binToHex(OWNER.lock), '01' + 'cd'.repeat(32), artifacts, net),
  /non-minting position NFT/);
  const base = utxo(b.lockingBytecode, 1_000n,
    nft(launchCat, 'mutable', encodeCurveStateV1(terminal), 100_001n));
  const quote = utxo(q.lockingBytecode, 1_000n, { category: quoteCat, amount: 500_003n });
  const sponsor = utxo(TAKER.lock, 20_000n);
  const plan = planTokenPairGraduationV1(m, base, quote, sponsor, terms,
    tokenPairGraduationTermsHashV1(terms), 7_000n);
  return { m, b, q, base, quote, sponsor, plan, terms, bundleHash,
    lockedBase, lockedQuote, ownedBase, ownedQuote, collectors };
}
function build(f: ReturnType<typeof fixture>, mutate?: (outputs: typeof f.plan.outputs) => void) {
  const outputs = structuredClone(f.plan.outputs);
  mutate?.(outputs);
  const builder = tb();
  builder.addInput(f.base, f.b.unlock[f.plan.outputs.length === 9 ? 'graduate' : 'graduateAll']());
  builder.addInput(f.quote, f.q.unlock[f.plan.outputs.length === 9 ? 'graduate' : 'graduateAll']());
  builder.addInput(f.sponsor, TAKER.template.unlockP2PKH());
  for (const output of outputs) builder.addOutput({ to: hexToBin(output.lockingBytecode),
    amount: output.satoshis, ...(output.token ? { token: output.token } : {}) });
  return buildTx(builder);
}
function live(tx: Transaction, index: number): SpendableUtxo {
  const output = tx.outputs[index];
  if (!output) throw new Error(`linked E2: missing output ${index}`);
  return { txid: hashTransaction(encodeTransaction(tx)), vout: index,
    satoshis: output.valueSatoshis, lockingBytecode: binToHex(output.lockingBytecode),
    ...(output.token ? { token: { category: binToHex(output.token.category),
      amount: output.token.amount,
      ...(output.token.nft ? { nft: { capability: output.token.nft.capability,
        commitment: binToHex(output.token.nft.commitment) } } : {}) } } : {}) };
}
function assertFeeAtLeastSize(built: ReturnType<typeof buildTx>) {
  const fee = built.sourceOutputs.reduce((sum, output) => sum + output.valueSatoshis, 0n) -
    built.transaction.outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
  assert.ok(fee >= BigInt(built.size), `fee ${fee} below ${built.size}-byte floor`);
}
const ninety = fixture(9_000);
const launchSeed = planSeed(net, utxo(OWNER.lock, 200_000n), OWNER.template, 600n);
const quoteSeed = planSeed(net, utxo(TAKER.lock, 200_000n), TAKER.template, 600n);
const issued = fixture(9_000, 2n, 21n, launchSeed.category, quoteSeed.category, 1n, 10n);
const launchGenesis = planFixedSupplyGenesis(net, launchSeed, OWNER.template, 1_000_000n,
  issued.m.allocations, 1_000n, binToHex(OWNER.lock), undefined,
  launchManifestHashV1(issued.m), 1, issued.bundleHash);
const quoteGenesis = planFixedSupplyGenesis(net, quoteSeed, TAKER.template, 1_000_000n,
  [{ name: 'quote_issuer', amount: 1_000_000n, satoshis: 1_000n,
    lockingBytecode: binToHex(TAKER.lock) }], 1_000n, binToHex(TAKER.lock));
for (const signed of [launchSeed, quoteSeed, launchGenesis, quoteGenesis, positionSeed, positionGenesis])
  assert.equal(verify(signed), true);
const linkedTransactions: Transaction[] = [positionSeed.transaction, positionGenesis.transaction,
  launchSeed.transaction, launchGenesis.transaction, quoteSeed.transaction, quoteGenesis.transaction];
verifyGenesisAgainstManifestV1(launchGenesis, issued.m);
verifyLaunchGenesisBundleCommitmentV1(launchGenesis.transaction, issued.bundleHash);
const launchChange = launchGenesis.transaction.outputs[3]!;
const quoteFund = tb();
quoteFund.addInput(utxo(OWNER.lock, launchChange.valueSatoshis, undefined, 3,
  launchGenesis.txid), OWNER.template.unlockP2PKH());
quoteFund.addOutput({ to: lockOf(issued.q), amount: 1_000n });
quoteFund.addOutput({ to: OWNER.lock, amount: launchChange.valueSatoshis - 2_000n });
const fundedQuoteVault = buildTx(quoteFund);
assert.equal(verify(fundedQuoteVault), true);
assertFeeAtLeastSize(fundedQuoteVault);
linkedTransactions.push(fundedQuoteVault.transaction);
const quoteChange = quoteGenesis.transaction.outputs[1]!;
const buyerFund = tb();
buyerFund.addInput(utxo(TAKER.lock, 1_000n,
  { category: quoteSeed.category, amount: 1_000_000n }, 0, quoteGenesis.txid),
TAKER.template.unlockP2PKH());
buyerFund.addInput(utxo(TAKER.lock, quoteChange.valueSatoshis, undefined, 1,
  quoteGenesis.txid), TAKER.template.unlockP2PKH());
buyerFund.addOutput({ to: TAKER.lock, amount: 20_000n,
  token: { category: quoteSeed.category, amount: 1_000_000n } });
buyerFund.addOutput({ to: TAKER.lock, amount: quoteChange.valueSatoshis - 20_000n });
const fundedBuyer = buildTx(buyerFund);
assert.equal(verify(fundedBuyer), true);
assertFeeAtLeastSize(fundedBuyer);
linkedTransactions.push(fundedBuyer.transaction);
const issuedBase = utxo(issued.b.lockingBytecode, 1_000n,
  nft(launchSeed.category, 'mutable', issued.m.allocations[0]!.nftCommitment!, 1_000_000n),
  0, launchGenesis.txid);
const issuedQuote = utxo(issued.q.lockingBytecode, 1_000n, undefined, 0,
  hashTransaction(encodeTransaction(fundedQuoteVault.transaction)));
const issuedBuyer = utxo(TAKER.lock, 20_000n,
  { category: quoteSeed.category, amount: 1_000_000n }, 0,
  hashTransaction(encodeTransaction(fundedBuyer.transaction)));
const issuedOpening = planTokenPairBuyV1(issued.m, issuedBase, issuedQuote,
  issuedBuyer, 100_000n, 7_000n, 1n, 10_000n);
const signedOpening = buildSignedTokenPairAction(net, issued.m, issuedOpening,
  issued.b, issued.q, TAKER.template, 'buy');
assert.equal(verify(signedOpening), true);
linkedTransactions.push(signedOpening.transaction);
const sellFunding = tb();
const openingBuyerBase = live(signedOpening.transaction, 2);
const openingQuoteRefund = live(signedOpening.transaction, 3);
sellFunding.addInput(openingBuyerBase, TAKER.template.unlockP2PKH());
sellFunding.addInput(openingQuoteRefund, TAKER.template.unlockP2PKH());
sellFunding.addOutput({ to: TAKER.lock, amount: 8_000n, token: openingBuyerBase.token! });
sellFunding.addOutput({ to: TAKER.lock, amount: 4_000n, token: openingQuoteRefund.token! });
const fundedSeller = buildTx(sellFunding);
assert.equal(verify(fundedSeller), true);
assertFeeAtLeastSize(fundedSeller);
linkedTransactions.push(fundedSeller.transaction);
const issuedSellPlan = planTokenPairSellV1(issued.m,
  live(signedOpening.transaction, 0), live(signedOpening.transaction, 1),
  live(fundedSeller.transaction, 0), 7_000n, 1n, 10_000n);
const signedIssuedSell = buildSignedTokenPairAction(net, issued.m, issuedSellPlan,
  issued.b, issued.q, TAKER.template, 'sell');
assert.equal(verify(signedIssuedSell), true);
linkedTransactions.push(signedIssuedSell.transaction);
const quoteConsolidation = tb();
const remainingQuote = live(fundedSeller.transaction, 1);
const sellerProceeds = live(signedIssuedSell.transaction, 2);
const buyerBch = live(fundedBuyer.transaction, 1);
for (const source of [remainingQuote, sellerProceeds, buyerBch])
  quoteConsolidation.addInput(source, TAKER.template.unlockP2PKH());
quoteConsolidation.addOutput({ to: TAKER.lock, amount: 20_000n,
  token: { category: quoteSeed.category,
    amount: remainingQuote.token!.amount + sellerProceeds.token!.amount } });
quoteConsolidation.addOutput({ to: TAKER.lock,
  amount: remainingQuote.satoshis + sellerProceeds.satoshis + buyerBch.satoshis - 21_000n });
const fundedTerminalBuyer = buildTx(quoteConsolidation);
assert.equal(verify(fundedTerminalBuyer), true);
assertFeeAtLeastSize(fundedTerminalBuyer);
linkedTransactions.push(fundedTerminalBuyer.transaction);
const issuedTerminalPlan = planTokenPairBuyV1(issued.m,
  live(signedIssuedSell.transaction, 0), live(signedIssuedSell.transaction, 1),
  live(fundedTerminalBuyer.transaction, 0), 800_000n, 7_000n, 1n, 10_000n);
assert.equal(issuedTerminalPlan.quote.complete, true);
assert.ok(issuedTerminalPlan.quote.refund > 0n);
const signedTerminal = buildSignedTokenPairAction(net, issued.m, issuedTerminalPlan,
  issued.b, issued.q, TAKER.template, 'buy');
assert.equal(verify(signedTerminal), true);
linkedTransactions.push(signedTerminal.transaction);
let liveCurveBase = live(signedTerminal.transaction, 0);
let liveCurveQuote = live(signedTerminal.transaction, 1);
let liveSponsor = live(fundedTerminalBuyer.transaction, 1);
const curveFeePayouts: SpendableUtxo[] = [];
for (const [role, recipient] of [OWNER, TAKER, KEEPER].entries()) {
  const feeClaimPlan = planTokenPairClaimV1(issued.m, liveCurveBase, liveCurveQuote,
    liveSponsor, role as 0 | 1 | 2, binToHex(recipient.lock), 7_000n, 10_000n);
  const feeClaim = buildSignedTokenPairAction(net, issued.m, feeClaimPlan,
    issued.b, issued.q, TAKER.template, 'claim');
  assert.equal(verify(feeClaim), true);
  linkedTransactions.push(feeClaim.transaction);
  liveCurveBase = live(feeClaim.transaction, 0);
  liveCurveQuote = live(feeClaim.transaction, 1);
  curveFeePayouts.push(live(feeClaim.transaction, 2));
  liveSponsor = live(feeClaim.transaction, 3);
}
const issuedGraduationPlan = planTokenPairGraduationV1(issued.m,
  liveCurveBase, liveCurveQuote, liveSponsor, issued.terms,
  tokenPairGraduationTermsHashV1(issued.terms), 7_000n);
const issuedGraduation = buildSignedTokenPairGraduationV1(net, issued.m,
  issuedGraduationPlan, issued.b, issued.q, TAKER.template);
assert.equal(verify(issuedGraduation), true);
assert.ok(issuedGraduation.paidFee >= BigInt(issuedGraduation.size));
linkedTransactions.push(issuedGraduation.transaction);
const marketBuyerFund = tb();
const terminalQuoteRefund = live(signedTerminal.transaction, 3);
marketBuyerFund.addInput(terminalQuoteRefund, TAKER.template.unlockP2PKH());
marketBuyerFund.addOutput({ to: TAKER.lock, amount: 6_000n,
  token: { category: quoteSeed.category, amount: 21_063n } });
marketBuyerFund.addOutput({ to: TAKER.lock, amount: terminalQuoteRefund.satoshis - 7_000n,
  token: { category: quoteSeed.category, amount: terminalQuoteRefund.token!.amount - 21_063n } });
const fundedMarketBuyer = buildTx(marketBuyerFund);
assert.equal(verify(fundedMarketBuyer), true);
assertFeeAtLeastSize(fundedMarketBuyer);
linkedTransactions.push(fundedMarketBuyer.transaction);
const liveMarketBuy = tb();
const gradBase = live(issuedGraduation.transaction, 0);
const gradQuote = live(issuedGraduation.transaction, 1);
liveMarketBuy.addInput(gradBase, issued.lockedBase.unlock.buy());
liveMarketBuy.addInput(gradQuote, issued.lockedQuote.unlock.buy());
for (let i = 0; i < 3; i++) liveMarketBuy.addInput(
  live(issuedGraduation.transaction, i + 5), issued.collectors[i]!.unlock.accrue());
liveMarketBuy.addInput(live(fundedMarketBuyer.transaction, 0), TAKER.template.unlockP2PKH());
liveMarketBuy.addOutput({ to: lockOf(issued.lockedBase), amount: 1_000n,
  token: { category: launchSeed.category, amount: gradBase.token!.amount - 10_000n } });
liveMarketBuy.addOutput({ to: lockOf(issued.lockedQuote), amount: 1_000n,
  token: { category: quoteSeed.category, amount: gradQuote.token!.amount + 21_050n } });
for (const [i, amount] of [5n, 1n, 7n].entries()) liveMarketBuy.addOutput({
  to: lockOf(issued.collectors[i]!), amount: 1_000n,
  token: { category: quoteSeed.category, amount },
});
liveMarketBuy.addOutput({ to: TAKER.lock, amount: 1_000n,
  token: { category: launchSeed.category, amount: 10_000n } });
const issuedMarketBuy = buildTx(liveMarketBuy);
assert.equal(verify(issuedMarketBuy), true);
assert.ok(issuedMarketBuy.size <= 5_000);
linkedTransactions.push(issuedMarketBuy.transaction);
let marketClaimSponsor = live(issuedGraduation.transaction, 8);
const marketFeePayouts: SpendableUtxo[] = [];
for (const [i, recipient] of [OWNER, TAKER, KEEPER].entries()) {
  const claim = tb();
  claim.addInput(live(issuedMarketBuy.transaction, i + 2), issued.collectors[i]!.unlock.claim());
  claim.addInput(marketClaimSponsor, TAKER.template.unlockP2PKH());
  claim.addOutput({ to: lockOf(issued.collectors[i]!), amount: 1_000n });
  claim.addOutput({ to: recipient.lock, amount: 1_000n,
    token: { category: quoteSeed.category, amount: [5n, 1n, 7n][i]! } });
  claim.addOutput({ to: TAKER.lock, amount: marketClaimSponsor.satoshis - 6_000n });
  const paid = buildTx(claim);
  assert.equal(verify(paid), true);
  assert.ok(paid.size <= 5_000);
  linkedTransactions.push(paid.transaction);
  marketFeePayouts.push(live(paid.transaction, 1));
  marketClaimSponsor = live(paid.transaction, 2);
}
const finalBase = live(issuedMarketBuy.transaction, 0).token!.amount +
  live(issuedGraduation.transaction, 2).token!.amount +
  live(signedTerminal.transaction, 2).token!.amount +
  live(issuedMarketBuy.transaction, 5).token!.amount;
const finalQuote = live(issuedMarketBuy.transaction, 1).token!.amount +
  live(issuedGraduation.transaction, 3).token!.amount +
  live(fundedMarketBuyer.transaction, 1).token!.amount +
  curveFeePayouts.reduce((sum, output) => sum + output.token!.amount, 0n) +
  marketFeePayouts.reduce((sum, output) => sum + output.token!.amount, 0n);
assert.equal(finalBase, 1_000_000n);
assert.equal(finalQuote, 1_000_000n);
assert.equal(linkedTransactions.length, 22);
console.log(`Mesh Blaze E2 linked local lifecycle: ${linkedTransactions.length} signed VM transactions, both supplies conserved`);
const signedGraduation = buildSignedTokenPairGraduationV1(net, ninety.m, ninety.plan,
  ninety.b, ninety.q, TAKER.template);
assert.equal(verify(signedGraduation), true);
assert.ok(signedGraduation.paidFee >= BigInt(signedGraduation.size));
const fullFixture = fixture(10_000);
assert.equal(verify(buildSignedTokenPairGraduationV1(net, fullFixture.m, fullFixture.plan,
  fullFixture.b, fullFixture.q, TAKER.template)), true);
console.log(`SIZE V2 graduation: ${build(ninety).size}`);
const initialBase = utxo(ninety.b.lockingBytecode, 1_000n,
  nft(TOKEN_A, 'mutable', encodeCurveStateV1({ ...terminal, stage: 0, realQuote: 0n }), 1_000_000n));
const initialQuote = utxo(ninety.q.lockingBytecode, 1_000n);
const initialBuyer = utxo(TAKER.lock, 8_000n, { category: TOKEN_B, amount: 100_000n });
const signedBuyPlan = planTokenPairBuyV1(ninety.m, initialBase, initialQuote,
  initialBuyer, 100_000n, 7_000n, 1n, 10_000n);
const signedBuy = buildSignedTokenPairAction(net, ninety.m, signedBuyPlan,
  ninety.b, ninety.q, TAKER.template, 'buy');
assert.equal(verify(signedBuy), true);
const buyState = signedBuyPlan.quote.next;
const afterBuyBase = utxo(ninety.b.lockingBytecode, 1_000n,
  nft(TOKEN_A, 'mutable', encodeCurveStateV1(buyState.state), buyState.base));
const afterBuyQuote = utxo(ninety.q.lockingBytecode, 1_000n,
  { category: TOKEN_B, amount: 100_000n });
const signedSellPlan = planTokenPairSellV1(ninety.m, afterBuyBase, afterBuyQuote,
  utxo(TAKER.lock, 8_000n, { category: TOKEN_A, amount: 1_000n }), 7_000n, 1n, 10_000n);
const signedSell = buildSignedTokenPairAction(net, ninety.m, signedSellPlan,
  ninety.b, ninety.q, TAKER.template, 'sell');
assert.equal(verify(signedSell), true);
const sold = signedSellPlan.quote.next;
const soldBase = utxo(ninety.b.lockingBytecode, 1_000n,
  nft(TOKEN_A, 'mutable', encodeCurveStateV1(sold.state), sold.base));
const soldQuote = utxo(ninety.q.lockingBytecode, 1_000n,
  { category: TOKEN_B, amount: sold.state.realQuote + sold.state.creatorFees +
    sold.state.partnerFees + sold.state.protocolFees });
const signedClaimPlan = planTokenPairClaimV1(ninety.m, soldBase, soldQuote,
  utxo(OWNER.lock, 10_000n), 0, binToHex(OWNER.lock), 7_000n, 10_000n);
const signedClaim = buildSignedTokenPairAction(net, ninety.m, signedClaimPlan,
  ninety.b, ninety.q, OWNER.template, 'claim');
assert.equal(verify(signedClaim), true);
const initial = { base: 1_000_000n, state: { ...terminal, stage: 0 as const, realQuote: 0n } };
const curveConfig = { virtualBase: 100_000n, virtualQuote: 1_000_000n,
  quoteThreshold: 500_003n, fees: { creatorBps: 50, partnerBps: 25, protocolBps: 25 } };
const curveBuy = quoteBuy(curveConfig, initial, 100_000n);
const v2Buy = tb();
v2Buy.addInput(utxo(ninety.b.lockingBytecode, 1_000n,
  nft(TOKEN_A, 'mutable', encodeCurveStateV1(initial.state), initial.base)), ninety.b.unlock.buy());
v2Buy.addInput(utxo(ninety.q.lockingBytecode, 1_000n), ninety.q.unlock.buy());
v2Buy.addInput(utxo(TAKER.lock, 8_000n, { category: TOKEN_B, amount: 100_000n }),
  TAKER.template.unlockP2PKH());
v2Buy.addOutput({ to: lockOf(ninety.b), amount: 1_000n,
  token: nft(TOKEN_A, 'mutable', encodeCurveStateV1(curveBuy.next.state), curveBuy.next.base) });
v2Buy.addOutput({ to: lockOf(ninety.q), amount: 1_000n,
  token: { category: TOKEN_B, amount: curveBuy.usedGross } });
v2Buy.addOutput({ to: TAKER.lock, amount: 1_000n,
  token: { category: TOKEN_A, amount: curveBuy.baseOut } });
console.log(`SIZE V2 curve buy: ${buildTx(v2Buy).size}`);
assert.equal(verify(buildTx(v2Buy)), true);
const curveSell = quoteSell(curveConfig, curveBuy.next, 1_000n);
const held = (s: CurveStateV1) => s.realQuote + s.creatorFees + s.partnerFees + s.protocolFees;
const v2Sell = tb();
v2Sell.addInput(utxo(ninety.b.lockingBytecode, 1_000n,
  nft(TOKEN_A, 'mutable', encodeCurveStateV1(curveBuy.next.state), curveBuy.next.base)), ninety.b.unlock.sell());
v2Sell.addInput(utxo(ninety.q.lockingBytecode, 1_000n,
  { category: TOKEN_B, amount: held(curveBuy.next.state) }), ninety.q.unlock.sell());
v2Sell.addInput(utxo(TAKER.lock, 8_000n, { category: TOKEN_A, amount: 1_000n }),
  TAKER.template.unlockP2PKH());
v2Sell.addOutput({ to: lockOf(ninety.b), amount: 1_000n,
  token: nft(TOKEN_A, 'mutable', encodeCurveStateV1(curveSell.next.state), curveSell.next.base) });
v2Sell.addOutput({ to: lockOf(ninety.q), amount: 1_000n,
  token: { category: TOKEN_B, amount: held(curveSell.next.state) } });
v2Sell.addOutput({ to: TAKER.lock, amount: 1_000n,
  token: { category: TOKEN_B, amount: curveSell.traderQuote } });
assert.equal(verify(buildTx(v2Sell)), true);
const claimState = { ...curveSell.next.state, creatorFees: 0n };
const v2Claim = tb();
v2Claim.addInput(utxo(ninety.b.lockingBytecode, 1_000n,
  nft(TOKEN_A, 'mutable', encodeCurveStateV1(curveSell.next.state), curveSell.next.base)),
ninety.b.unlock.claim(0n));
v2Claim.addInput(utxo(ninety.q.lockingBytecode, 1_000n,
  { category: TOKEN_B, amount: held(curveSell.next.state) }), ninety.q.unlock.claim(0n));
v2Claim.addInput(utxo(OWNER.lock, 10_000n), OWNER.template.unlockP2PKH());
v2Claim.addOutput({ to: lockOf(ninety.b), amount: 1_000n,
  token: nft(TOKEN_A, 'mutable', encodeCurveStateV1(claimState), curveSell.next.base) });
v2Claim.addOutput({ to: lockOf(ninety.q), amount: 1_000n,
  token: { category: TOKEN_B, amount: held(claimState) } });
v2Claim.addOutput({ to: OWNER.lock, amount: 1_000n,
  token: { category: TOKEN_B, amount: curveSell.next.state.creatorFees } });
v2Claim.addOutput({ to: OWNER.lock, amount: 2_000n });
assert.equal(verify(buildTx(v2Claim)), true);
assert.equal(verify(build(ninety)), true);
assert.equal(verify(build(fixture(10_000))), true);
console.log(`SIZE V2 graduation: ${build(ninety).size}`);
const badPrice = build(fixture(9_000, 5n, 8n));
assert.notEqual(verify(badPrice), true);
assert.equal(inputMetrics(badPrice)[0]!.ok, false);
assert.equal(inputMetrics(badPrice)[1]!.ok, false);
const graduated = build(ninety);
const graduatedTxid = hashTransaction(encodeTransaction(graduated.transaction));
const marketBuy = tb();
marketBuy.addInput(utxo(ninety.lockedBase.lockingBytecode, 1_000n,
  { category: TOKEN_A, amount: 90_001n }, 0, graduatedTxid), ninety.lockedBase.unlock.buy());
marketBuy.addInput(utxo(ninety.lockedQuote.lockingBytecode, 1_000n,
  { category: TOKEN_B, amount: 450_003n }, 1, graduatedTxid), ninety.lockedQuote.unlock.buy());
for (let i = 0; i < 3; i++) marketBuy.addInput(utxo(ninety.collectors[i]!.lockingBytecode,
  1_000n, undefined, i + 5, graduatedTxid), ninety.collectors[i]!.unlock.accrue());
marketBuy.addInput(utxo(TAKER.lock, 6_000n, { category: TOKEN_B, amount: 80_240n }),
  TAKER.template.unlockP2PKH());
marketBuy.addOutput({ to: lockOf(ninety.lockedBase), amount: 1_000n,
  token: { category: TOKEN_A, amount: 80_001n } });
marketBuy.addOutput({ to: lockOf(ninety.lockedQuote), amount: 1_000n,
  token: { category: TOKEN_B, amount: 530_195n } });
for (const [i, amount] of [19n, 4n, 25n].entries()) marketBuy.addOutput({
  to: lockOf(ninety.collectors[i]!), amount: 1_000n,
  token: { category: TOKEN_B, amount },
});
marketBuy.addOutput({ to: TAKER.lock, amount: 1_000n,
  token: { category: TOKEN_A, amount: 10_000n } });
const marketBought = buildTx(marketBuy);
console.log(`SIZE E2 market buy: ${marketBought.size}`);
assert.equal(verify(marketBought), true);
const marketTxid = hashTransaction(encodeTransaction(marketBought.transaction));
for (const [i, amount] of [19n, 4n, 25n].entries()) {
  const claim = tb();
  const collector = ninety.collectors[i]!;
  claim.addInput(utxo(collector.lockingBytecode, 1_000n,
    { category: TOKEN_B, amount }, i + 2, marketTxid), collector.unlock.claim());
  claim.addInput(utxo(TAKER.lock, 5_000n), TAKER.template.unlockP2PKH());
  claim.addOutput({ to: lockOf(collector), amount: 1_000n });
  claim.addOutput({ to: [OWNER, TAKER, KEEPER][i]!.lock, amount: 1_000n,
    token: { category: TOKEN_B, amount } });
  claim.addOutput({ to: TAKER.lock, amount: 1_000n });
  assert.equal(verify(buildTx(claim)), true, `collector ${i} claim`);
}
function rejectsBoth(mutate: (outputs: typeof ninety.plan.outputs) => void) {
  const tx = build(ninety, mutate);
  assert.notEqual(verify(tx), true);
  const inputs = inputMetrics(tx);
  assert.equal(inputs[0]!.ok, false, 'base covenant must reject');
  assert.equal(inputs[1]!.ok, false, 'quote covenant must reject');
}
rejectsBoth((outputs) => { outputs[1]!.token!.amount -= 1n; });
rejectsBoth((outputs) => { outputs[1]!.lockingBytecode = binToHex(OWNER.lock); });
rejectsBoth((outputs) => { outputs[8]!.satoshis -= 5_001n; });
rejectsBoth((outputs) => { outputs[4]!.token!.nft!.commitment = '00'; });
console.log('Mesh Blaze paired graduation VM: 14 lifecycle checks plus artifact reconstruction');
