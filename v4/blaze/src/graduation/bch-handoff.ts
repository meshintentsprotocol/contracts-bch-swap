import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import type { SpendableUtxo } from 'cashscript';
import type { LaunchManifestV1 } from '../manifest/v1.js';
import { checkBchCurveSourceV1, curveCarrierFromManifestV1, type PlannedOutput } from '../curve/buy-plan.js';
import { encodeCurveStateV1 } from '../curve/state.js';
import { graduationSplitV1, type GraduationSplitV1 } from './split.js';

/** Draft graduation extension; the current Manifest V1 does not commit this hash. */
export interface BchGraduationTermsV2 {
  lockedBinScript: string;
  creatorBinScript: string;
  stateArchiveScript: string;
  creatorPositionCategory: string;
  lockedBps: number;
  collectorScripts: readonly [string, string, string];
  collectorCarrierSats: bigint;
}
export interface BchGraduationPlanV2 {
  curveInput: SpendableUtxo;
  sponsorInput: SpendableUtxo;
  terms: BchGraduationTermsV2;
  expectedTermsHash: string;
  networkFee: bigint;
  split: GraduationSplitV1;
  outputs: PlannedOutput[];
}
function fail(reason: string): never { throw new Error(`Mesh Blaze BCH graduation: ${reason}`); }
function scriptBytes(script: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(script) || script.length > 1024) fail('script must be nonempty lowercase hex of at most 512 bytes');
  return hexToBin(script);
}
function categoryBytes(category: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(category) || /^0+$/.test(category)) fail('position category must be nonzero 32-byte lowercase hex');
  return hexToBin(category);
}
function encodedTerms(t: BchGraduationTermsV2): Uint8Array {
  if (!Number.isInteger(t.lockedBps) || t.lockedBps < 9_000 || t.lockedBps > 10_000) fail('lock share outside 9000..10000 bps');
  if (t.collectorScripts.length !== 3) fail('exactly three collector scripts required');
  if (t.collectorCarrierSats < 1_000n || t.collectorCarrierSats >= 1n << 63n)
    fail('collector carrier outside VM range');
  const creatorCategory = categoryBytes(t.creatorPositionCategory);
  const scripts = [t.lockedBinScript, t.creatorBinScript, t.stateArchiveScript, ...t.collectorScripts].map(scriptBytes);
  const parts: number[] = [2, t.lockedBps & 255, t.lockedBps >> 8, ...creatorCategory];
  for (let i = 0; i < 8; i++) parts.push(Number((t.collectorCarrierSats >> BigInt(i * 8)) & 255n));
  for (const script of scripts) parts.push(script.length & 255, script.length >> 8, ...script);
  return Uint8Array.from(parts);
}
export function bchGraduationTermsHashV2(t: BchGraduationTermsV2): string {
  return binToHex(sha256.hash(encodedTerms(t)));
}
function expectedOutputs(m: LaunchManifestV1, curve: SpendableUtxo, sponsor: SpendableUtxo,
  terms: BchGraduationTermsV2, expectedHash: string, networkFee: bigint) {
  if (m.quoteCategory !== null) fail('BCH quote required');
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || bchGraduationTermsHashV2(terms) !== expectedHash)
    fail('graduation terms do not match committed hash');
  if (terms.lockedBps !== m.lockedLiquidityBps) fail('lock share differs from launch manifest');
  if (binToHex(sha256.hash(scriptBytes(terms.lockedBinScript))) !== m.marketScriptHash)
    fail('locked market script differs from launch manifest');
  if (terms.creatorPositionCategory === m.tokenCategory)
    fail('position category must differ from launch token');
  if (networkFee < 0n || networkFee > 5_000n) fail('network fee outside cap');
  if (sponsor.token) fail('sponsor input must be BCH only');
  const { base, state } = checkBchCurveSourceV1(m, curve);
  if (state.stage !== 1 || state.realQuote !== m.graduationQuoteThreshold) fail('curve is not complete at threshold');
  if (state.creatorFees || state.partnerFees || state.protocolFees) fail('claim all curve fees before graduation');
  const split = graduationSplitV1(base, state.realQuote, terms.lockedBps);
  const creatorExists = split.creatorBase > 0n && split.creatorQuote > 0n;
  if ((split.creatorBase > 0n) !== (split.creatorQuote > 0n)) fail('one-sided creator share needs explicit terms');
  const binCount = creatorExists ? 2n : 1n;
  const sponsorChange = sponsor.satoshis - binCount * 1_000n - 3n * terms.collectorCarrierSats - networkFee;
  if (sponsorChange < 546n) fail('sponsor cannot fund bin and collector carriers, fee and change');
  const outputs: PlannedOutput[] = [
    { lockingBytecode: terms.lockedBinScript, satoshis: split.lockedQuote + 1_000n,
      token: { category: m.tokenCategory, amount: split.lockedBase } },
  ];
  if (creatorExists) outputs.push({ lockingBytecode: terms.creatorBinScript, satoshis: split.creatorQuote + 1_000n,
    token: { category: m.tokenCategory, amount: split.creatorBase } });
  outputs.push({ lockingBytecode: terms.stateArchiveScript, satoshis: curveCarrierFromManifestV1(m),
    token: { category: m.tokenCategory, amount: 0n,
      nft: { capability: 'mutable', commitment: encodeCurveStateV1(state) } } });
  for (const script of terms.collectorScripts)
    outputs.push({ lockingBytecode: script, satoshis: terms.collectorCarrierSats });
  outputs.push({ lockingBytecode: sponsor.lockingBytecode, satoshis: sponsorChange });
  return { split, outputs };
}
/** Unsigned layout only. A versioned curve covenant must enforce the same terms before this may be broadcast. */
export function planBchGraduationV2(m: LaunchManifestV1, curveInput: SpendableUtxo, sponsorInput: SpendableUtxo,
  terms: BchGraduationTermsV2, expectedTermsHash: string, networkFee: bigint): BchGraduationPlanV2 {
  const { split, outputs } = expectedOutputs(m, curveInput, sponsorInput, terms, expectedTermsHash, networkFee);
  const plan = { curveInput, sponsorInput, terms, expectedTermsHash, networkFee, split, outputs };
  verifyBchGraduationPlanV2(m, plan);
  return plan;
}
export function verifyBchGraduationPlanV2(m: LaunchManifestV1, plan: BchGraduationPlanV2): void {
  const { split, outputs } = expectedOutputs(m, plan.curveInput, plan.sponsorInput, plan.terms,
    plan.expectedTermsHash, plan.networkFee);
  if (Object.entries(split).some(([key, value]) => plan.split[key as keyof GraduationSplitV1] !== value))
    fail('asset split differs');
  if (plan.outputs.length !== outputs.length) fail('output count differs');
  for (let i = 0; i < outputs.length; i++) {
    const got = plan.outputs[i]!;
    const want = outputs[i]!;
    if (got.lockingBytecode !== want.lockingBytecode || got.satoshis !== want.satoshis ||
        got.token?.category !== want.token?.category || got.token?.amount !== want.token?.amount ||
        got.token?.nft?.capability !== want.token?.nft?.capability ||
        got.token?.nft?.commitment !== want.token?.nft?.commitment) fail(`output ${i} differs`);
  }
}
