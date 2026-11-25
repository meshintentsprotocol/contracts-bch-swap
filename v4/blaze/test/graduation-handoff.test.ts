import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { KEEPER, OWNER, TAKER, TOKEN_A, TOKEN_B, catVm, le, net, nft, utxo } from '../../test/harness.js';
import { encodeCurveStateV1, type CurveStateV1 } from '../src/curve/state.js';
import { bchGraduationTermsHashV2, planBchGraduationV2, verifyBchGraduationPlanV2,
  type BchGraduationTermsV2 } from '../src/graduation/bch-handoff.js';
import type { LaunchManifestV1 } from '../src/manifest/v1.js';

const h = (b: Uint8Array) => binToHex(sha256.hash(b));
function v4Bin(path: string, ownerCat: string): Contract {
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  return new Contract(artifact, [
    `0x${catVm(TOKEN_A)}`, `0x${le(7n, 8)}`, `0x${le(1n, 8)}`,
    `0x${le(8n, 8)}`, `0x${le(1n, 8)}`, `0x${catVm(ownerCat)}`,
    `0x${'00'.repeat(32)}`, `0x${le(0n, 4)}`,
  ], { provider: net, contractType: 'p2sh32' });
}
const lockedBin = v4Bin('artifacts/variants/MeshBinV4Locked.json', TOKEN_B);
const creatorBin = v4Bin('artifacts/MeshBinV4.json', '11'.repeat(32));
const archive = new Contract(JSON.parse(readFileSync('blaze/artifacts/MeshBlazeStateArchiveV1.json', 'utf8')),
  [], { provider: net, contractType: 'p2sh32' });
const terms: BchGraduationTermsV2 = {
  lockedBinScript: lockedBin.lockingBytecode, creatorBinScript: creatorBin.lockingBytecode,
  stateArchiveScript: archive.lockingBytecode,
  creatorPositionCategory: '11'.repeat(32), lockedBps: 9_000,
  collectorScripts: [binToHex(OWNER.lock), binToHex(TAKER.lock), binToHex(KEEPER.lock)],
  collectorCarrierSats: 1_000n,
};
const state: CurveStateV1 = { stage: 1, realQuote: 500_003n,
  creatorFees: 0n, partnerFees: 0n, protocolFees: 0n };
function fixture(s: CurveStateV1 = state, base = 100_001n) {
  const zero = '00'.repeat(32);
  const rights = { creator: { scriptHash: h(OWNER.lock), bps: 50 },
    partner: { scriptHash: h(TAKER.lock), bps: 25 }, protocol: { scriptHash: h(KEEPER.lock), bps: 25 } };
  const m: LaunchManifestV1 = {
    version: 1, tokenCategory: TOKEN_A, quoteCategory: null, totalSupply: 1_000_000n,
    allocations: [{ name: 'curve', amount: 1_000_000n, satoshis: 1_000n,
      lockingBytecode: binToHex(OWNER.lock), nftCommitment: encodeCurveStateV1({ ...state, stage: 0, realQuote: 0n }) }],
    activationHeight: 400_000, alphaStartHeight: 0, alphaEndHeight: 0, presaleRoute: null,
    presaleScriptHash: zero, alphaModes: 0, alphaFixedScriptHash: zero, alphaBuyScriptHash: zero,
    virtualBase: 100_000n, virtualQuote: 1_000_000n, graduationQuoteThreshold: 500_003n,
    lockedLiquidityBps: 9_000, curveScriptHash: h(OWNER.lock), quoteVaultScriptHash: zero,
    quoteVaultCarrierSats: 0n, graduationScriptHash: h(KEEPER.lock),
    marketScriptHash: h(hexToBin(lockedBin.lockingBytecode)),
    curveFees: rights, marketFees: rights,
  };
  const curve = utxo(OWNER.lock, 1_000n + s.realQuote + s.creatorFees + s.partnerFees + s.protocolFees,
    nft(TOKEN_A, 'mutable', encodeCurveStateV1(s), base));
  const sponsor = utxo(TAKER.lock, 10_000n);
  return { m, curve, sponsor };
}
const { m, curve, sponsor } = fixture();
const commitment = bchGraduationTermsHashV2(terms);
const plan = planBchGraduationV2(m, curve, sponsor, terms, commitment, 1_000n);
assert.deepEqual(plan.split, { lockedBase: 90_001n, creatorBase: 10_000n,
  lockedQuote: 450_003n, creatorQuote: 50_000n });
assert.equal(plan.outputs.length, 7);
assert.equal(plan.outputs[0]!.satoshis, 451_003n);
assert.equal(plan.outputs[1]!.satoshis, 51_000n);
assert.equal(plan.outputs[2]!.token!.nft!.commitment, encodeCurveStateV1(state));
assert.equal(plan.outputs[3]!.satoshis, 1_000n);
assert.equal(plan.outputs[6]!.satoshis, 4_000n);
assert.equal(plan.outputs.reduce((sum, out) => sum + out.satoshis, 0n), curve.satoshis + sponsor.satoshis - 1_000n);
verifyBchGraduationPlanV2(m, plan);
plan.outputs[0]!.token!.amount -= 1n;
assert.throws(() => verifyBchGraduationPlanV2(m, plan), /output 0 differs/);
assert.throws(() => planBchGraduationV2(m, curve, sponsor, terms, h(OWNER.lock), 1_000n), /committed hash/);
assert.throws(() => planBchGraduationV2({ ...m, marketScriptHash: h(OWNER.lock) }, curve, sponsor,
  terms, commitment, 1_000n), /locked market script/);
assert.throws(() => planBchGraduationV2(m, fixture({ ...state, stage: 0 }).curve, sponsor, terms, commitment, 1_000n), /not complete/);
assert.throws(() => planBchGraduationV2(m, fixture({ ...state, creatorFees: 10n }).curve, sponsor, terms, commitment, 1_000n), /claim all/);
assert.throws(() => planBchGraduationV2(m, curve, utxo(TAKER.lock, 2_000n), terms, commitment, 1_000n), /sponsor cannot/);
assert.throws(() => planBchGraduationV2({ ...m, quoteCategory: TOKEN_B }, curve, sponsor, terms, commitment, 1_000n), /BCH quote/);
const full = { ...terms, lockedBps: 10_000 };
const fullPlan = planBchGraduationV2({ ...m, lockedLiquidityBps: 10_000 }, curve, sponsor, full,
  bchGraduationTermsHashV2(full), 1_000n);
assert.equal(fullPlan.outputs.length, 6);
assert.equal(fullPlan.split.creatorBase, 0n);
console.log('Mesh Blaze BCH graduation handoff: 17 assertions passed');
