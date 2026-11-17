import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, encodeTransaction, hashTransaction, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { KEEPER, OWNER, TAKER, TOKEN_A, TOKEN_B, catVm, le, net, nft, tb, utxo, buildTx, verify, lockOf } from '../../test/harness.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';
import { planBchCurveBuyV1 } from '../src/curve/buy-plan.js';
import { planBchCurveClaimV1, planBchCurveSellV1 } from '../src/curve/sell-claim-plan.js';
import { buildSignedBchCurveAction } from '../src/curve/bch-signed-trades.js';
import { bchGraduationTermsHashV2, planBchGraduationV2, type BchGraduationTermsV2 } from '../src/graduation/bch-handoff.js';
import { buildSignedBchGraduationV2 } from '../src/graduation/bch-signed-handoff.js';
import type { LaunchManifestV1 } from '../src/manifest/v1.js';

const artifact = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const CURVE = artifact('blaze/artifacts/MeshBlazeBchCurveV2Prototype.json');
const COLLECTOR = artifact('blaze/artifacts/MeshBlazeBchFeeCollectorV1.json');
const FEE_BIN = artifact('blaze/artifacts/MeshBlazeBchFeeBinLockedV1.json');
const FEE_OWNED = artifact('blaze/artifacts/MeshBlazeBchFeeBinOwnedV1.json');
const ARCHIVE = artifact('blaze/artifacts/MeshBlazeStateArchiveV1.json');
const LOCKED = artifact('artifacts/variants/MeshBinV4Locked.json');
const CREATOR = artifact('artifacts/MeshBinV4.json');
const h = (bytes: Uint8Array) => binToHex(sha256.hash(bytes));
const state = encodeCurveStateV1({ stage: 1, realQuote: 500_003n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n });
function bin(a: object, ownerCat: string) {
  return new Contract(a as any, [`0x${catVm(TOKEN_A)}`, `0x${le(7n, 8)}`, `0x${le(1n, 8)}`,
    `0x${le(8n, 8)}`, `0x${le(1n, 8)}`, `0x${catVm(ownerCat)}`,
    `0x${'00'.repeat(32)}`, `0x${le(0n, 4)}`], { provider: net, contractType: 'p2sh32' });
}
const locked = bin(LOCKED, TOKEN_B);
const creator = bin(CREATOR, '11'.repeat(32));
const archive = new Contract(ARCHIVE, [], { provider: net, contractType: 'p2sh32' });
const collectors = [OWNER, TAKER, KEEPER].map((key) => new Contract(COLLECTOR,
  [`0x${h(key.lock)}`, `0x${le(1_000n, 8)}`], { provider: net, contractType: 'p2sh32' }));
const feeLocked = new Contract(FEE_BIN, [`0x${catVm(TOKEN_A)}`, `0x${le(7n, 8)}`, `0x${le(1n, 8)}`,
  `0x${le(8n, 8)}`, `0x${le(1n, 8)}`, ...collectors.map((c) => `0x${h(lockOf(c))}`),
  `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`],
  { provider: net, contractType: 'p2sh32' });
const feeCreator = new Contract(FEE_OWNED, [`0x${catVm(TOKEN_A)}`, `0x${catVm('11'.repeat(32))}`,
  `0x${le(7n, 8)}`, `0x${le(1n, 8)}`, `0x${le(8n, 8)}`, `0x${le(1n, 8)}`,
  ...collectors.map((c) => `0x${h(lockOf(c))}`),
  `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`],
  { provider: net, contractType: 'p2sh32' });
function curveFor(lockBps: bigint, lockedScript = lockOf(locked), creatorScript = lockOf(creator), bid = 7n, ask = 8n, bidDen = 1n, askDen = 1n) { return new Contract(CURVE, [`0x${catVm(TOKEN_A)}`, `0x${le(100_000n, 8)}`,
  `0x${le(1_000_000n, 8)}`, `0x${le(500_003n, 8)}`, `0x${le(1_000n, 8)}`,
  `0x${le(50n, 2)}`, `0x${le(25n, 2)}`, `0x${le(25n, 2)}`,
  `0x${h(OWNER.lock)}`, `0x${h(TAKER.lock)}`, `0x${h(KEEPER.lock)}`,
  `0x${h(lockedScript)}`, `0x${h(creatorScript)}`, `0x${h(lockOf(archive))}`, `0x${le(lockBps, 2)}`,
  ...collectors.map((c) => `0x${h(lockOf(c))}`), `0x${le(1_000n, 8)}`,
  `0x${le(bid, 8)}`, `0x${le(bidDen, 8)}`, `0x${le(ask, 8)}`, `0x${le(askDen, 8)}`,
], { provider: net, contractType: 'p2sh32' }); }
const curve = curveFor(9_000n);
function signedFixture(lockBps = 9_000, networkFee = 4_000n) {
  const c = curveFor(BigInt(lockBps), lockOf(feeLocked), lockOf(feeCreator));
  const zero = '00'.repeat(32);
  const rights = { creator: { scriptHash: h(OWNER.lock), bps: 50 },
    partner: { scriptHash: h(TAKER.lock), bps: 25 }, protocol: { scriptHash: h(KEEPER.lock), bps: 25 } };
  const m: LaunchManifestV1 = {
    version: 1, tokenCategory: TOKEN_A, quoteCategory: null, totalSupply: 1_000_000n,
    allocations: [{ name: 'curve', amount: 1_000_000n, satoshis: 1_000n,
      lockingBytecode: c.lockingBytecode,
      nftCommitment: encodeCurveStateV1({ stage: 0, realQuote: 0n, creatorFees: 0n,
        partnerFees: 0n, protocolFees: 0n }) }],
    activationHeight: 400_000, alphaStartHeight: 0, alphaEndHeight: 0, presaleRoute: null,
    presaleScriptHash: zero, alphaModes: 0, alphaFixedScriptHash: zero, alphaBuyScriptHash: zero,
    virtualBase: 100_000n, virtualQuote: 1_000_000n, graduationQuoteThreshold: 500_003n,
    lockedLiquidityBps: lockBps, curveScriptHash: h(lockOf(c)), quoteVaultScriptHash: zero,
    quoteVaultCarrierSats: 0n, graduationScriptHash: h(OWNER.lock),
    marketScriptHash: h(lockOf(feeLocked)), curveFees: rights, marketFees: rights,
  };
  const terms: BchGraduationTermsV2 = { lockedBinScript: feeLocked.lockingBytecode,
    creatorBinScript: feeCreator.lockingBytecode, stateArchiveScript: archive.lockingBytecode,
    lockedPositionCategory: TOKEN_B, creatorPositionCategory: '11'.repeat(32), lockedBps: lockBps,
    collectorScripts: collectors.map((collector) => collector.lockingBytecode) as [string, string, string],
    collectorCarrierSats: 1_000n };
  const source = utxo(c.lockingBytecode, 501_003n, nft(TOKEN_A, 'mutable', state, 100_001n));
  const sponsor = utxo(OWNER.lock, 10_000n);
  const plan = planBchGraduationV2(m, source, sponsor, terms,
    bchGraduationTermsHashV2(terms), networkFee);
  return { m, c, plan };
}
function reachableLifecycle() {
  const marketArgs = [`0x${catVm(TOKEN_A)}`, `0x${le(2n, 8)}`, `0x${le(1n, 8)}`,
    `0x${le(21n, 8)}`, `0x${le(10n, 8)}`];
  const feeArgs = [...collectors.map((collector) => `0x${h(lockOf(collector))}`),
    `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`];
  const marketLocked = new Contract(FEE_BIN, [...marketArgs, ...feeArgs],
    { provider: net, contractType: 'p2sh32' });
  const marketOwned = new Contract(FEE_OWNED, [marketArgs[0]!, `0x${catVm('11'.repeat(32))}`,
    ...marketArgs.slice(1), ...feeArgs], { provider: net, contractType: 'p2sh32' });
  const c = curveFor(9_000n, lockOf(marketLocked), lockOf(marketOwned), 2n, 21n, 1n, 10n);
  const zero = '00'.repeat(32);
  const rights = { creator: { scriptHash: h(OWNER.lock), bps: 50 },
    partner: { scriptHash: h(TAKER.lock), bps: 25 }, protocol: { scriptHash: h(KEEPER.lock), bps: 25 } };
  const m: LaunchManifestV1 = {
    version: 1, tokenCategory: TOKEN_A, quoteCategory: null, totalSupply: 1_000_000n,
    allocations: [{ name: 'curve', amount: 1_000_000n, satoshis: 1_000n,
      lockingBytecode: c.lockingBytecode,
      nftCommitment: encodeCurveStateV1({ stage: 0, realQuote: 0n, creatorFees: 0n,
        partnerFees: 0n, protocolFees: 0n }) }],
    activationHeight: 400_000, alphaStartHeight: 0, alphaEndHeight: 0, presaleRoute: null,
    presaleScriptHash: zero, alphaModes: 0, alphaFixedScriptHash: zero, alphaBuyScriptHash: zero,
    virtualBase: 100_000n, virtualQuote: 1_000_000n, graduationQuoteThreshold: 500_003n,
    lockedLiquidityBps: 9_000, curveScriptHash: h(lockOf(c)), quoteVaultScriptHash: zero,
    quoteVaultCarrierSats: 0n, graduationScriptHash: h(OWNER.lock),
    marketScriptHash: h(lockOf(marketLocked)), curveFees: rights, marketFees: rights,
  };
  let curveInput = utxo(c.lockingBytecode, 1_000n,
    nft(TOKEN_A, 'mutable', m.allocations[0]!.nftCommitment!, 1_000_000n));
  const openingPlan = planBchCurveBuyV1(m, curveInput, utxo(TAKER.lock, 900_000n),
    100_000n, 4_000n, 1n);
  const opening = buildSignedBchCurveAction(net, m, openingPlan, c, TAKER.template, 'buy');
  assert.equal(verify(opening), true);
  assert.equal(openingPlan.quote.complete, false);
  curveInput = utxo(c.lockingBytecode, openingPlan.outputs[0].satoshis,
    openingPlan.outputs[0].token, 0, opening.txid);
  const soldTokens = utxo(TAKER.lock, openingPlan.outputs[1].satoshis,
    openingPlan.outputs[1].token, 1, opening.txid);
  const sellPlan = planBchCurveSellV1(m, curveInput, soldTokens, 4_000n, 1n);
  const sold = buildSignedBchCurveAction(net, m, sellPlan, c, TAKER.template, 'sell');
  assert.equal(verify(sold), true);
  curveInput = utxo(c.lockingBytecode, sellPlan.outputs[0].satoshis,
    sellPlan.outputs[0].token, 0, sold.txid);
  const buyPlan = planBchCurveBuyV1(m, curveInput, utxo(TAKER.lock, 900_000n), 800_000n, 4_000n, 1n);
  const bought = buildSignedBchCurveAction(net, m, buyPlan, c, TAKER.template, 'buy');
  assert.equal(verify(bought), true);
  assert.equal(buyPlan.quote.complete, true);
  curveInput = utxo(c.lockingBytecode, buyPlan.outputs[0].satoshis,
    buyPlan.outputs[0].token, 0, bought.txid);
  for (const [role, recipient, signer] of [[0, OWNER, OWNER], [1, TAKER, OWNER],
    [2, KEEPER, OWNER]] as const) {
    const claimPlan = planBchCurveClaimV1(m, curveInput, utxo(signer.lock, 10_000n),
      role, binToHex(recipient.lock), 4_000n);
    const claimed = buildSignedBchCurveAction(net, m, claimPlan, c, signer.template, 'claim');
    assert.equal(verify(claimed), true);
    curveInput = utxo(c.lockingBytecode, claimPlan.outputs[0].satoshis,
      claimPlan.outputs[0].token, 0, claimed.txid);
  }
  const terms: BchGraduationTermsV2 = { lockedBinScript: marketLocked.lockingBytecode,
    creatorBinScript: marketOwned.lockingBytecode, stateArchiveScript: archive.lockingBytecode,
    lockedPositionCategory: TOKEN_B, creatorPositionCategory: '11'.repeat(32), lockedBps: 9_000,
    collectorScripts: collectors.map((collector) => collector.lockingBytecode) as [string, string, string],
    collectorCarrierSats: 1_000n };
  const handoff = planBchGraduationV2(m, curveInput, utxo(OWNER.lock, 10_000n),
    terms, bchGraduationTermsHashV2(terms), 4_000n);
  const graduated = buildSignedBchGraduationV2(net, m, handoff, c, OWNER.template);
  assert.equal(verify(graduated), true);
  assert.equal(handoff.split.lockedQuote, 450_003n);
  const marketTrade = tb();
  marketTrade.addInput(utxo(marketLocked.lockingBytecode, handoff.outputs[0]!.satoshis,
    handoff.outputs[0]!.token, 0, graduated.txid), marketLocked.unlock.buy());
  for (let i = 0; i < collectors.length; i++) {
    const collector = collectors[i]!;
    marketTrade.addInput(utxo(collector.lockingBytecode, 1_000n, undefined, i + 3,
      graduated.txid), collector.unlock.accrue());
  }
  marketTrade.addInput(utxo(TAKER.lock, 50_000n), TAKER.template.unlockP2PKH());
  marketTrade.addOutput({ to: lockOf(marketLocked), amount: handoff.outputs[0]!.satoshis + 21_050n,
    token: { category: TOKEN_A, amount: handoff.outputs[0]!.token!.amount - 10_000n } });
  marketTrade.addOutput({ to: lockOf(collectors[0]!), amount: 1_005n });
  marketTrade.addOutput({ to: lockOf(collectors[1]!), amount: 1_001n });
  marketTrade.addOutput({ to: lockOf(collectors[2]!), amount: 1_007n });
  marketTrade.addOutput({ to: TAKER.lock, amount: 1_000n,
    token: { category: TOKEN_A, amount: 10_000n } });
  marketTrade.addOutput({ to: TAKER.lock, amount: 23_937n });
  const marketBuilt = buildTx(marketTrade);
  assert.equal(verify(marketBuilt), true);
  for (let i = 0; i < collectors.length; i++) {
    const collector = collectors[i]!;
    const recipient = [OWNER, TAKER, KEEPER][i]!;
    const accrued = [5n, 1n, 7n][i]!;
    const topUp = 546n - accrued;
    const claim = tb();
    claim.addInput(utxo(collector.lockingBytecode, 1_000n + accrued, undefined,
      i + 1, hashTransaction(encodeTransaction(marketBuilt.transaction))),
      collector.unlock.claim());
    claim.addInput(utxo(OWNER.lock, 10_000n), OWNER.template.unlockP2PKH());
    claim.addOutput({ to: lockOf(collector), amount: 1_000n });
    claim.addOutput({ to: recipient.lock, amount: 546n });
    claim.addOutput({ to: OWNER.lock, amount: 10_000n - topUp - 4_000n });
    assert.equal(verify(buildTx(claim)), true);
  }
  console.log(`reachable E1 partial chain: opening ${opening.size} B, sell ${sold.size} B, terminal buy ${bought.size} B, graduation ${graduated.size} B, market buy ${marketBuilt.size} B`);
}

function spend(tamper: 'none' | 'lockedScript' | 'creatorScript' | 'base' | 'quote' | 'archive' | 'collector' | 'sponsor' | 'fees' | 'stage' = 'none', feeMarket = false, bid = 7n, ask = 8n) {
  const sourceCurve = feeMarket ? curveFor(9_000n, lockOf(feeLocked), lockOf(feeCreator), bid, ask) : curveFor(9_000n, lockOf(locked), lockOf(creator), bid, ask);
  const s = tamper === 'fees' ? encodeCurveStateV1({ stage: 1, realQuote: 500_003n,
    creatorFees: 1n, partnerFees: 0n, protocolFees: 0n }) : tamper === 'stage' ?
      encodeCurveStateV1({ stage: 0, realQuote: 500_003n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n }) : state;
  const b = tb();
  b.addInput(utxo(sourceCurve.lockingBytecode, tamper === 'fees' ? 501_004n : 501_003n,
    nft(TOKEN_A, 'mutable', s, 100_001n)), sourceCurve.unlock.graduate());
  b.addInput(utxo(OWNER.lock, 10_000n), OWNER.template.unlockP2PKH());
  b.addOutput({ to: tamper === 'lockedScript' ? TAKER.lock : feeMarket ? lockOf(feeLocked) : lockOf(locked), amount: tamper === 'quote' ? 451_002n : 451_003n,
    token: { category: TOKEN_A, amount: tamper === 'base' ? 90_000n : 90_001n } });
  b.addOutput({ to: tamper === 'creatorScript' ? TAKER.lock : feeMarket ? lockOf(feeCreator) : lockOf(creator), amount: 51_000n,
    token: { category: TOKEN_A, amount: tamper === 'base' ? 10_001n : 10_000n } });
  b.addOutput({ to: lockOf(archive), amount: 1_000n, token: nft(TOKEN_A, 'mutable', tamper === 'archive' ? '01' : s) });
  for (let i = 0; i < 3; i++) b.addOutput({ to: tamper === 'collector' && i === 0 ? OWNER.lock : lockOf(collectors[i]!), amount: 1_000n });
  b.addOutput({ to: tamper === 'sponsor' ? TAKER.lock : OWNER.lock, amount: 4_000n });
  return b;
}
function spendAll(tamper: 'none' | 'base' | 'quote' = 'none') {
  const all = curveFor(10_000n, lockOf(feeLocked), lockOf(feeCreator));
  const b = tb();
  b.addInput(utxo(all.lockingBytecode, 501_003n, nft(TOKEN_A, 'mutable', state, 100_001n)), all.unlock.graduateAll());
  b.addInput(utxo(OWNER.lock, 10_000n), OWNER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(feeLocked), amount: tamper === 'quote' ? 501_002n : 501_003n,
    token: { category: TOKEN_A, amount: tamper === 'base' ? 100_000n : 100_001n } });
  b.addOutput({ to: lockOf(archive), amount: 1_000n, token: nft(TOKEN_A, 'mutable', state) });
  for (const c of collectors) b.addOutput({ to: lockOf(c), amount: 1_000n });
  b.addOutput({ to: OWNER.lock, amount: 5_000n });
  return b;
}
const cases: Array<[string, () => void]> = [
  ['reachable genesis state buys to completion, claims all fees and graduates', reachableLifecycle],
  ['signed graduation handoff passes BCH VM', () => {
    const { m, c, plan } = signedFixture();
    const built = buildSignedBchGraduationV2(net, m, plan, c, OWNER.template);
    assert.equal(verify(built), true);
    assert.equal(built.paidFee, 4_000n);
    assert.ok(built.size < 4_000);
    console.log(`signed graduation sample: ${built.size} bytes, ${built.paidFee} sats fee`);
  }],
  ['signed full-lock graduation passes BCH VM', () => {
    const { m, c, plan } = signedFixture(10_000);
    assert.equal(verify(buildSignedBchGraduationV2(net, m, plan, c, OWNER.template)), true);
  }],
  ['signed graduation rejects fee below serialized size', () => {
    const { m, c, plan } = signedFixture(9_000, 1_000n);
    assert.throws(() => buildSignedBchGraduationV2(net, m, plan, c, OWNER.template), /fee differs or falls below rate/);
  }],
  ['completed curve funds V4 locked and creator bins', () => assert.equal(verify(buildTx(spend())), true)],
  ['completed curve atomically funds locked and owned fee bins plus three collectors', () => assert.equal(verify(buildTx(spend('none', true))), true)],
  ['terminal bid below ten percent band fails', () => assert.match(verify(buildTx(spend('none', false, 6n, 8n))) as string, /input index 0/i)],
  ['terminal ask above ten percent band fails', () => assert.match(verify(buildTx(spend('none', false, 7n, 9n))) as string, /input index 0/i)],
  ['locked bin substitution fails at curve input', () => assert.match(verify(buildTx(spend('lockedScript'))) as string, /input index 0/i)],
  ['creator bin substitution fails at curve input', () => assert.match(verify(buildTx(spend('creatorScript', true))) as string, /input index 0/i)],
  ['underlocked launch FT fails', () => assert.match(verify(buildTx(spend('base'))) as string, /input index 0/i)],
  ['underlocked BCH fails', () => assert.match(verify(buildTx(spend('quote'))) as string, /input index 0/i)],
  ['state NFT alteration fails', () => assert.match(verify(buildTx(spend('archive'))) as string, /input index 0/i)],
  ['collector substitution fails', () => assert.match(verify(buildTx(spend('collector'))) as string, /input index 0/i)],
  ['sponsor change diversion fails', () => assert.match(verify(buildTx(spend('sponsor'))) as string, /input index 0/i)],
  ['unclaimed curve fee blocks graduation', () => assert.match(verify(buildTx(spend('fees'))) as string, /input index 0/i)],
  ['nonterminal stage blocks graduation', () => assert.match(verify(buildTx(spend('stage'))) as string, /input index 0/i)],
  ['100 percent lock funds one V4 locked bin', () => assert.equal(verify(buildTx(spendAll())), true)],
  ['100 percent lock rejects missing launch FT', () => assert.match(verify(buildTx(spendAll('base'))) as string, /input index 0/i)],
  ['100 percent lock rejects missing BCH', () => assert.match(verify(buildTx(spendAll('quote'))) as string, /input index 0/i)],
];
let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}:`, e); }
}
console.log(`Mesh Blaze BCH graduation prototype VM: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
