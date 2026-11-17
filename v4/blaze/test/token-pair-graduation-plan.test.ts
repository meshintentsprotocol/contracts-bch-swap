import assert from 'node:assert/strict';
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { OWNER, TAKER, KEEPER, TOKEN_A, TOKEN_B, nft, utxo } from '../../test/harness.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';
import { tokenPairGraduationTermsHashV1, planTokenPairGraduationV1,
  verifyTokenPairGraduationPlanV1, type TokenPairGraduationTermsV1 } from '../src/graduation/token-pair-handoff.js';
import type { LaunchManifestV1 } from '../src/manifest/v1.js';

const hash = (script: string) => binToHex(sha256.hash(hexToBin(script)));
const baseScript = binToHex(OWNER.lock);
const quoteScript = binToHex(TAKER.lock);
const sponsorScript = binToHex(KEEPER.lock);
const zero = '00'.repeat(32);
const completed = { stage: 1 as const, realQuote: 500_003n,
  creatorFees: 0n, partnerFees: 0n, protocolFees: 0n };
const terms: TokenPairGraduationTermsV1 = {
  creatorPositionCategory: '11'.repeat(32),
  lockedBaseScript: sponsorScript, lockedQuoteScript: sponsorScript,
  creatorBaseScript: baseScript, creatorQuoteScript: baseScript,
  archiveScript: quoteScript, collectorScripts: [baseScript, quoteScript, sponsorScript],
  lockedBps: 9_000, marketCarrierSats: 1_000n, collectorCarrierSats: 1_000n,
};
const rights = { creator: { scriptHash: hash(baseScript), bps: 50 },
  partner: { scriptHash: hash(quoteScript), bps: 25 },
  protocol: { scriptHash: hash(sponsorScript), bps: 25 } };
function manifest(lockBps = 9_000): LaunchManifestV1 {
  return {
    version: 1, tokenCategory: TOKEN_A, quoteCategory: TOKEN_B, totalSupply: 1_000_000n,
    allocations: [{ name: 'curve', amount: 1_000_000n, satoshis: 1_000n,
      lockingBytecode: baseScript, nftCommitment: encodeCurveStateV1({ ...completed, stage: 0, realQuote: 0n }) }],
    activationHeight: 400_000, alphaStartHeight: 0, alphaEndHeight: 0, presaleRoute: null,
    presaleScriptHash: zero, alphaModes: 0, alphaFixedScriptHash: zero, alphaBuyScriptHash: zero,
    virtualBase: 100_000n, virtualQuote: 1_000_000n, graduationQuoteThreshold: 500_003n,
    lockedLiquidityBps: lockBps, curveScriptHash: hash(baseScript), quoteVaultScriptHash: hash(quoteScript),
    quoteVaultCarrierSats: 1_000n, graduationScriptHash: hash(baseScript),
    marketScriptHash: hash(sponsorScript), curveFees: rights, marketFees: rights,
  };
}
const base = utxo(OWNER.lock, 1_000n, nft(TOKEN_A, 'mutable', encodeCurveStateV1(completed), 100_001n));
const quote = utxo(TAKER.lock, 1_000n, { category: TOKEN_B, amount: 500_003n });
const sponsor = utxo(KEEPER.lock, 10_000n);
const termsHash = tokenPairGraduationTermsHashV1(terms);
const plan = planTokenPairGraduationV1(manifest(), base, quote, sponsor, terms, termsHash, 1_000n);
assert.deepEqual(plan.split, { lockedBase: 90_001n, creatorBase: 10_000n,
  lockedQuote: 450_003n, creatorQuote: 50_000n });
assert.equal(plan.outputs.length, 9);
assert.equal(plan.outputs[0]!.token!.category, TOKEN_A);
assert.equal(plan.outputs[1]!.token!.category, TOKEN_B);
assert.equal(plan.outputs[4]!.token!.nft!.commitment, encodeCurveStateV1(completed));
assert.equal(plan.outputs[8]!.satoshis, 3_000n);
assert.equal(plan.outputs.reduce((sum, output) => sum + output.satoshis, 0n), 11_000n);
verifyTokenPairGraduationPlanV1(manifest(), plan);
const tampered = structuredClone(plan);
tampered.outputs[1]!.token!.amount -= 1n;
assert.throws(() => verifyTokenPairGraduationPlanV1(manifest(), tampered), /output 1 differs/);
assert.throws(() => planTokenPairGraduationV1(manifest(), base, quote, sponsor, terms, zero, 1_000n), /terms hash differs/);
assert.throws(() => planTokenPairGraduationV1(manifest(), base, quote, sponsor,
  terms, termsHash, 5_001n), /network fee outside cap/);
assert.throws(() => planTokenPairGraduationV1(manifest(), base, quote,
  utxo(KEEPER.lock, 1_000n), terms, termsHash, 1_000n), /cannot fund outputs/);
assert.throws(() => planTokenPairGraduationV1(manifest(), base,
  utxo(TAKER.lock, 1_000n, { category: TOKEN_B, amount: 500_002n }),
  sponsor, terms, termsHash, 1_000n), /ledger differs/);
assert.throws(() => planTokenPairGraduationV1(manifest(),
  utxo(OWNER.lock, 1_000n, nft(TOKEN_A, 'mutable', encodeCurveStateV1({ ...completed, creatorFees: 1n }), 100_001n)),
  quote, sponsor, terms, termsHash, 1_000n), /ledger differs|unclaimed fees/);
const allTerms = { ...terms, lockedBps: 10_000 };
const all = planTokenPairGraduationV1(manifest(10_000), base, quote, sponsor,
  allTerms, tokenPairGraduationTermsHashV1(allTerms), 1_000n);
assert.equal(all.outputs.length, 7);
assert.equal(all.split.creatorBase, 0n);
assert.equal(all.outputs[2]!.token!.nft!.commitment, encodeCurveStateV1(completed));
assert.equal(all.outputs[6]!.satoshis, 5_000n);
console.log('Mesh Blaze token-pair graduation plan: 19 assertions passed');
