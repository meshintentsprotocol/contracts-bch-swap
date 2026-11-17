import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { KEEPER, OWNER, TAKER, TOKEN_A, catVm, le, net, nft, tb, utxo, buildTx, verify } from '../../test/harness.js';
import { bchCurveFromManifestV1 } from '../src/curve/contract.js';
import { planBchCurveBuyV1, verifyBchCurveBuyPlanV1 } from '../src/curve/buy-plan.js';
import { planBchCurveSellV1, verifyBchCurveSellPlanV1, planBchCurveClaimV1, verifyBchCurveClaimPlanV1 } from '../src/curve/sell-claim-plan.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';
import { launchManifestHashV1, validateBchCurveArithmeticV1, type LaunchManifestV1 } from '../src/manifest/v1.js';

const ARTIFACT = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'MeshBlazeBchCurveV1.json'), 'utf8'));
const hash = (bytes: Uint8Array) => binToHex(sha256.hash(bytes));
const rights = () => ({
  creator: { scriptHash: hash(TAKER.lock), bps: 50 },
  partner: { scriptHash: hash(OWNER.lock), bps: 25 },
  protocol: { scriptHash: hash(KEEPER.lock), bps: 25 },
});

function fixture(): LaunchManifestV1 {
  const f = rights();
  const contract = new Contract(ARTIFACT, [
    `0x${catVm(TOKEN_A)}`, `0x${le(100_000n, 8)}`, `0x${le(1_000_000n, 8)}`,
    `0x${le(500_000n, 8)}`, `0x${le(1_000n, 8)}`,
    `0x${le(f.creator.bps, 2)}`, `0x${le(f.partner.bps, 2)}`, `0x${le(f.protocol.bps, 2)}`,
    `0x${f.creator.scriptHash}`, `0x${f.partner.scriptHash}`, `0x${f.protocol.scriptHash}`,
  ], { provider: net, contractType: 'p2sh32' });
  const zero = '00'.repeat(32);
  return {
    version: 1, tokenCategory: TOKEN_A, quoteCategory: null,
    totalSupply: 1_000_000n,
    allocations: [{ name: 'curve', amount: 1_000_000n, satoshis: 1_000n, lockingBytecode: contract.lockingBytecode,
      nftCommitment: encodeCurveStateV1({ stage: 0, realQuote: 0n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n }) }],
    activationHeight: 400_000, alphaStartHeight: 0, alphaEndHeight: 0,
    presaleRoute: null, presaleScriptHash: zero, alphaModes: 0, alphaFixedScriptHash: zero, alphaBuyScriptHash: zero,
    virtualBase: 100_000n, virtualQuote: 1_000_000n, graduationQuoteThreshold: 500_000n,
    lockedLiquidityBps: 9_000, curveScriptHash: hash(hexToBin(contract.lockingBytecode)),
    quoteVaultScriptHash: zero, quoteVaultCarrierSats: 0n,
    graduationScriptHash: hash(OWNER.lock), marketScriptHash: hash(KEEPER.lock),
    curveFees: f, marketFees: rights(),
  };
}

function boughtCurve(m: LaunchManifestV1, gross: bigint) {
  const c = bchCurveFromManifestV1(ARTIFACT, m, net);
  const genesis = utxo(c.lockingBytecode, 1_000n, nft(TOKEN_A, 'mutable', m.allocations[0]!.nftCommitment!, 1_000_000n));
  const buy = planBchCurveBuyV1(m, genesis, utxo(TAKER.lock, 1_000_000n), gross, 2_000n, 1n);
  const out = buy.outputs[0];
  return { c, current: utxo(c.lockingBytecode, out.satoshis, out.token) };
}

const cases: Array<[string, () => void]> = [
  ['manifest reconstructs exactly one BCH curve script', () => {
    const m = fixture();
    assert.match(launchManifestHashV1(m), /^[0-9a-f]{64}$/);
    const contract = bchCurveFromManifestV1(ARTIFACT, m, net);
    assert.equal(contract.lockingBytecode, m.allocations[0]!.lockingBytecode);
    assert.equal(hash(hexToBin(contract.lockingBytecode)), m.curveScriptHash);
  }],
  ['changed recipient is rejected against committed script', () => {
    const m = fixture();
    const changed = { ...m, curveFees: { ...m.curveFees, creator: { ...m.curveFees.creator, scriptHash: hash(OWNER.lock) } } };
    assert.throws(() => bchCurveFromManifestV1(ARTIFACT, changed, net), /script differs/);
  }],
  ['changed virtual reserve is rejected against committed script', () => {
    const m = fixture();
    assert.throws(() => bchCurveFromManifestV1(ARTIFACT, { ...m, virtualQuote: m.virtualQuote + 1n }, net), /script differs/);
  }],
  ['token quote cannot use BCH curve', () => {
    const m = fixture();
    assert.throws(() => bchCurveFromManifestV1(ARTIFACT, { ...m, quoteCategory: '11'.repeat(32) }, net), /quote category/);
  }],
  ['nonempty genesis state is rejected', () => {
    const m = fixture();
    const allocations = [{ ...m.allocations[0]!, nftCommitment: encodeCurveStateV1({ stage: 0, realQuote: 1n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n }) }];
    assert.throws(() => bchCurveFromManifestV1(ARTIFACT, { ...m, allocations }, net), /genesis state/);
  }],
  ['safe curve manifest stays within signed VM products', () => {
    assert.doesNotThrow(() => validateBchCurveArithmeticV1(fixture()));
  }],
  ['oversized buy reserve product is rejected before funding', () => {
    const m = fixture();
    assert.throws(() => validateBchCurveArithmeticV1({ ...m, virtualBase: (1n << 63n) / m.graduationQuoteThreshold }), /buy reserve product/);
    assert.throws(() => launchManifestHashV1({ ...m, virtualBase: (1n << 63n) / m.graduationQuoteThreshold }), /buy reserve product/);
  }],
  ['oversized sell reserve product is rejected before funding', () => {
    const m = fixture();
    assert.throws(() => validateBchCurveArithmeticV1({ ...m, virtualQuote: (1n << 63n) / m.totalSupply }), /sell reserve product/);
  }],
  ['terminal fee multiplication overflow is rejected before funding', () => {
    const m = fixture();
    const expensive = { ...m, totalSupply: 1n, virtualBase: 1n, virtualQuote: 1n,
      graduationQuoteThreshold: (1n << 63n) / 10_000n,
      curveFees: { creator: { ...m.curveFees.creator, bps: 9_999 }, partner: { ...m.curveFees.partner, bps: 0 }, protocol: { ...m.curveFees.protocol, bps: 0 } } };
    assert.throws(() => validateBchCurveArithmeticV1(expensive), /fee product/);
  }],
  ['manifest-derived buy plan passes BCH VM and returns threshold excess', () => {
    const m = fixture();
    const c = bchCurveFromManifestV1(ARTIFACT, m, net);
    const curveUtxo = utxo(c.lockingBytecode, 1_000n, nft(TOKEN_A, 'mutable', m.allocations[0]!.nftCommitment!, 1_000_000n));
    const buyerUtxo = utxo(TAKER.lock, 1_000_000n);
    const plan = planBchCurveBuyV1(m, curveUtxo, buyerUtxo, 900_000n, 2_000n, 1n);
    assert.equal(plan.quote.complete, true);
    assert.ok(plan.quote.refund > 0n);
    verifyBchCurveBuyPlanV1(m, plan);
    const b = tb();
    b.addInput(curveUtxo, c.unlock.buy());
    b.addInput(buyerUtxo, TAKER.template.unlockP2PKH());
    for (const output of plan.outputs) b.addOutput({ to: hexToBin(output.lockingBytecode), amount: output.satoshis, ...(output.token ? { token: output.token } : {}) });
    assert.equal(verify(buildTx(b)), true);
  }],
  ['buy plan rejects a redirected change output', () => {
    const m = fixture();
    const c = bchCurveFromManifestV1(ARTIFACT, m, net);
    const curveUtxo = utxo(c.lockingBytecode, 1_000n, nft(TOKEN_A, 'mutable', m.allocations[0]!.nftCommitment!, 1_000_000n));
    const buyerUtxo = utxo(TAKER.lock, 1_000_000n);
    const plan = planBchCurveBuyV1(m, curveUtxo, buyerUtxo, 100_000n, 2_000n, 1n);
    plan.outputs[2].lockingBytecode = binToHex(OWNER.lock);
    assert.throws(() => verifyBchCurveBuyPlanV1(m, plan), /refund\/change/);
  }],
  ['buy plan rejects slippage and insufficient buyer funds', () => {
    const m = fixture();
    const c = bchCurveFromManifestV1(ARTIFACT, m, net);
    const curveUtxo = utxo(c.lockingBytecode, 1_000n, nft(TOKEN_A, 'mutable', m.allocations[0]!.nftCommitment!, 1_000_000n));
    const buyerUtxo = utxo(TAKER.lock, 10_000n);
    assert.throws(() => planBchCurveBuyV1(m, curveUtxo, buyerUtxo, 100_000n, 2_000n, 1n), /cannot fund/);
    assert.throws(() => planBchCurveBuyV1(m, curveUtxo, utxo(TAKER.lock, 1_000_000n), 100_000n, 2_000n, 1_000_000n), /slippage/);
  }],
  ['manifest-derived sell plan pays token seller in BCH VM', () => {
    const m = fixture();
    const { c, current } = boughtCurve(m, 100_000n);
    const seller = utxo(TAKER.lock, 10_000n, { category: TOKEN_A, amount: 1_000n });
    const plan = planBchCurveSellV1(m, current, seller, 2_000n, 1n);
    verifyBchCurveSellPlanV1(m, plan);
    const b = tb();
    b.addInput(current, c.unlock.sell());
    b.addInput(seller, TAKER.template.unlockP2PKH());
    for (const output of plan.outputs) b.addOutput({ to: hexToBin(output.lockingBytecode), amount: output.satoshis, ...(output.token ? { token: output.token } : {}) });
    assert.equal(verify(buildTx(b)), true);
  }],
  ['sell plan rejects diverted proceeds and slippage', () => {
    const m = fixture();
    const { current } = boughtCurve(m, 100_000n);
    const seller = utxo(TAKER.lock, 10_000n, { category: TOKEN_A, amount: 1_000n });
    const plan = planBchCurveSellV1(m, current, seller, 2_000n, 1n);
    plan.outputs[1].lockingBytecode = binToHex(OWNER.lock);
    assert.throws(() => verifyBchCurveSellPlanV1(m, plan), /seller proceeds/);
    assert.throws(() => planBchCurveSellV1(m, current, seller, 2_000n, 1_000_000n), /slippage/);
  }],
  ['manifest-derived creator claim pays recipient in BCH VM', () => {
    const m = fixture();
    const { c, current } = boughtCurve(m, 500_000n);
    const sponsor = utxo(OWNER.lock, 10_000n);
    const plan = planBchCurveClaimV1(m, current, sponsor, 0, binToHex(TAKER.lock), 2_000n);
    verifyBchCurveClaimPlanV1(m, plan);
    const b = tb();
    b.addInput(current, c.unlock.claim(0n));
    b.addInput(sponsor, OWNER.template.unlockP2PKH());
    for (const output of plan.outputs) b.addOutput({ to: hexToBin(output.lockingBytecode), amount: output.satoshis, ...(output.token ? { token: output.token } : {}) });
    assert.equal(verify(buildTx(b)), true);
  }],
  ['claim plan rejects changed recipient and sponsor change', () => {
    const m = fixture();
    const { current } = boughtCurve(m, 500_000n);
    const sponsor = utxo(OWNER.lock, 10_000n);
    assert.throws(() => planBchCurveClaimV1(m, current, sponsor, 0, binToHex(OWNER.lock), 2_000n), /recipient script/);
    const plan = planBchCurveClaimV1(m, current, sponsor, 0, binToHex(TAKER.lock), 2_000n);
    plan.outputs[2].satoshis -= 1n;
    assert.throws(() => verifyBchCurveClaimPlanV1(m, plan), /sponsor change/);
  }],
];

let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}:`, error); }
}
console.log(`Mesh Blaze BCH constructor and transaction plans: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
