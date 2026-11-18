import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import type { SpendableUtxo } from 'cashscript';
import type { LaunchManifestV1 } from '../manifest/v1.js';
import { readTokenPairVaultsV1 } from '../curve/token-pair-buy-plan.js';
import type { PlannedOutput } from '../curve/buy-plan.js';
import { encodeCurveStateV1 } from '../curve/state.js';
import { graduationSplitV1, type GraduationSplitV1 } from './split.js';

/** Unsigned E2 output plan. V2 covenants must independently enforce this layout. */
export interface TokenPairGraduationTermsV1 {
  creatorPositionCategory: string;
  lockedBaseScript: string;
  lockedQuoteScript: string;
  creatorBaseScript: string;
  creatorQuoteScript: string;
  archiveScript: string;
  collectorScripts: readonly [string, string, string];
  lockedBps: number;
  marketCarrierSats: bigint;
  collectorCarrierSats: bigint;
}
export interface TokenPairGraduationPlanV1 {
  baseInput: SpendableUtxo;
  quoteInput: SpendableUtxo;
  sponsorInput: SpendableUtxo;
  terms: TokenPairGraduationTermsV1;
  expectedTermsHash: string;
  networkFee: bigint;
  split: GraduationSplitV1;
  outputs: PlannedOutput[];
}
const fail = (reason: string): never => { throw new Error(`Mesh Blaze token-pair graduation: ${reason}`); };
function script(script: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/.test(script) || script.length > 1024)
    fail('script must be nonempty lowercase hex of at most 512 bytes');
  return hexToBin(script);
}
function u64(value: bigint): number[] {
  if (value < 0n || value >= (1n << 63n)) fail('carrier outside signed VM range');
  return Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(8 * i)) & 255n));
}
export function tokenPairGraduationTermsHashV1(t: TokenPairGraduationTermsV1): string {
  if (!/^[0-9a-f]{64}$/.test(t.creatorPositionCategory) || /^0+$/.test(t.creatorPositionCategory))
    fail('creator position category must be nonzero lowercase 32-byte hex');
  if (!Number.isInteger(t.lockedBps) || t.lockedBps < 9_000 || t.lockedBps > 10_000)
    fail('lock share outside 9000..10000 bps');
  if (t.marketCarrierSats < 1_000n || t.collectorCarrierSats < 1_000n)
    fail('carrier below 1000 sats');
  if (t.collectorScripts.length !== 3) fail('three collectors required');
  const scripts = [t.lockedBaseScript, t.lockedQuoteScript, t.creatorBaseScript,
    t.creatorQuoteScript, t.archiveScript, ...t.collectorScripts].map(script);
  const bytes: number[] = [1, t.lockedBps & 255, t.lockedBps >> 8,
    ...hexToBin(t.creatorPositionCategory), ...u64(t.marketCarrierSats), ...u64(t.collectorCarrierSats)];
  for (const part of scripts) bytes.push(part.length & 255, part.length >> 8, ...part);
  return binToHex(sha256.hash(Uint8Array.from(bytes)));
}
function expected(m: LaunchManifestV1, base: SpendableUtxo, quote: SpendableUtxo,
  sponsor: SpendableUtxo, terms: TokenPairGraduationTermsV1,
  expectedHash: string, networkFee: bigint) {
  if (m.quoteCategory === null) fail('CashToken quote required');
  if (terms.creatorPositionCategory === m.tokenCategory || terms.creatorPositionCategory === m.quoteCategory)
    fail('creator position category must differ from launch and quote');
  const quoteCategory = m.quoteCategory as string;
  if (tokenPairGraduationTermsHashV1(terms) !== expectedHash) fail('graduation terms hash differs');
  if (terms.lockedBps !== m.lockedLiquidityBps) fail('lock share differs from manifest');
  if (binToHex(sha256.hash(script(terms.lockedBaseScript))) !== m.marketScriptHash)
    fail('locked base market script differs from manifest');
  if (networkFee < 0n || networkFee > 10_000n) fail('network fee outside cap');
  if (sponsor.token) fail('sponsor input must be BCH only');
  const { inventory, held } = readTokenPairVaultsV1(m, base, quote);
  const state = inventory.state;
  if (state.stage !== 1 || state.realQuote !== m.graduationQuoteThreshold ||
      state.creatorFees !== 0n || state.partnerFees !== 0n || state.protocolFees !== 0n)
    fail('completed curve must reach threshold with zero unclaimed fees');
  if (held !== state.realQuote || inventory.base <= 0n) fail('invalid graduation reserves');
  const split = graduationSplitV1(inventory.base, state.realQuote, terms.lockedBps);
  if ((split.creatorBase > 0n) !== (split.creatorQuote > 0n)) fail('one-sided creator share');
  const creator = split.creatorBase > 0n;
  const marketOutputs = creator ? 4n : 2n;
  const newCarriers = marketOutputs * terms.marketCarrierSats + 3n * terms.collectorCarrierSats;
  const sponsorChange = sponsor.satoshis + quote.satoshis - newCarriers - networkFee;
  if (sponsorChange < 546n) fail('sponsor and returned quote carrier cannot fund outputs');
  const outputs: PlannedOutput[] = [
    { lockingBytecode: terms.lockedBaseScript, satoshis: terms.marketCarrierSats,
      token: { category: m.tokenCategory, amount: split.lockedBase } },
    { lockingBytecode: terms.lockedQuoteScript, satoshis: terms.marketCarrierSats,
      token: { category: quoteCategory, amount: split.lockedQuote } },
  ];
  if (creator) outputs.push(
    { lockingBytecode: terms.creatorBaseScript, satoshis: terms.marketCarrierSats,
      token: { category: m.tokenCategory, amount: split.creatorBase } },
    { lockingBytecode: terms.creatorQuoteScript, satoshis: terms.marketCarrierSats,
      token: { category: quoteCategory, amount: split.creatorQuote } },
  );
  outputs.push({ lockingBytecode: terms.archiveScript, satoshis: base.satoshis,
    token: { category: m.tokenCategory, amount: 0n,
      nft: { capability: 'mutable', commitment: encodeCurveStateV1(state) } } });
  for (const collector of terms.collectorScripts)
    outputs.push({ lockingBytecode: collector, satoshis: terms.collectorCarrierSats });
  outputs.push({ lockingBytecode: sponsor.lockingBytecode, satoshis: sponsorChange });
  return { split, outputs };
}
export function planTokenPairGraduationV1(m: LaunchManifestV1, baseInput: SpendableUtxo,
  quoteInput: SpendableUtxo, sponsorInput: SpendableUtxo, terms: TokenPairGraduationTermsV1,
  expectedTermsHash: string, networkFee: bigint): TokenPairGraduationPlanV1 {
  const { split, outputs } = expected(m, baseInput, quoteInput, sponsorInput,
    terms, expectedTermsHash, networkFee);
  const plan = { baseInput, quoteInput, sponsorInput, terms, expectedTermsHash, networkFee, split, outputs };
  verifyTokenPairGraduationPlanV1(m, plan);
  return plan;
}
export function verifyTokenPairGraduationPlanV1(m: LaunchManifestV1, plan: TokenPairGraduationPlanV1): void {
  const { split, outputs } = expected(m, plan.baseInput, plan.quoteInput, plan.sponsorInput,
    plan.terms, plan.expectedTermsHash, plan.networkFee);
  if (Object.entries(split).some(([key, amount]) => plan.split[key as keyof GraduationSplitV1] !== amount))
    fail('asset split differs');
  if (plan.outputs.length !== outputs.length) fail('output count differs');
  for (let i = 0; i < outputs.length; i++) {
    const actual = plan.outputs[i]!;
    const wanted = outputs[i]!;
    if (actual.lockingBytecode !== wanted.lockingBytecode || actual.satoshis !== wanted.satoshis ||
        actual.token?.category !== wanted.token?.category || actual.token?.amount !== wanted.token?.amount ||
        actual.token?.nft?.capability !== wanted.token?.nft?.capability ||
        actual.token?.nft?.commitment !== wanted.token?.nft?.commitment)
      fail(`output ${i} differs`);
  }
}
