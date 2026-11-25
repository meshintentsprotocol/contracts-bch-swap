import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import type { SpendableUtxo } from 'cashscript';
import { checkBchCurveSourceV1, curveCarrierFromManifestV1, curveConfigFromManifestV1, type PlannedOutput } from './buy-plan.js';
import { encodeCurveStateV1, requiredBchSatoshis } from './state.js';
import { quoteSell, type SellQuote } from '../math/curve.js';
import type { LaunchManifestV1 } from '../manifest/v1.js';

export interface BchCurveSellPlanV1 {
  curveInput: SpendableUtxo;
  sellerInput: SpendableUtxo;
  outputs: readonly [PlannedOutput, PlannedOutput];
  quote: SellQuote;
  minQuoteOut: bigint;
  networkFee: bigint;
}
export type FeeRole = 0 | 1 | 2;
export interface BchCurveClaimPlanV1 {
  curveInput: SpendableUtxo;
  sponsorInput: SpendableUtxo;
  role: FeeRole;
  recipientScript: string;
  outputs: readonly [PlannedOutput, PlannedOutput, PlannedOutput];
  networkFee: bigint;
}
function fail(reason: string): never { throw new Error(`Mesh Blaze BCH settlement plan: ${reason}`); }
function feeCap(networkFee: bigint) { if (networkFee < 0n || networkFee > 5_000n) fail('network fee outside 0..5000 sats'); }
function successor(m: LaunchManifestV1, curveInput: SpendableUtxo, base: bigint, state: ReturnType<typeof checkBchCurveSourceV1>['state']): PlannedOutput {
  return { lockingBytecode: curveInput.lockingBytecode, satoshis: requiredBchSatoshis(state, curveCarrierFromManifestV1(m)),
    token: { category: m.tokenCategory, amount: base, nft: { capability: 'mutable', commitment: encodeCurveStateV1(state) } } };
}
function sameSuccessor(actual: PlannedOutput, expected: PlannedOutput) {
  if (actual.lockingBytecode !== expected.lockingBytecode || actual.satoshis !== expected.satoshis ||
      actual.token?.category !== expected.token?.category || actual.token?.amount !== expected.token?.amount ||
      actual.token?.nft?.capability !== 'mutable' || actual.token.nft.commitment !== expected.token?.nft?.commitment)
    fail('curve successor differs');
}

export function planBchCurveSellV1(m: LaunchManifestV1, curveInput: SpendableUtxo, sellerInput: SpendableUtxo,
  networkFee: bigint, minQuoteOut: bigint): BchCurveSellPlanV1 {
  const inventory = checkBchCurveSourceV1(m, curveInput);
  const sellerToken = sellerInput.token;
  if (!sellerToken || sellerToken.category !== m.tokenCategory || sellerToken.nft || sellerToken.amount <= 0n)
    fail('seller input must contain only launch FT');
  feeCap(networkFee);
  if (minQuoteOut < 0n) fail('negative minimum quote output');
  const quote = quoteSell(curveConfigFromManifestV1(m), inventory, sellerToken.amount);
  if (quote.traderQuote < minQuoteOut) fail('slippage: quote output below minimum');
  const proceeds = sellerInput.satoshis + quote.traderQuote - networkFee;
  if (proceeds < 546n) fail('seller output below dust');
  const plan: BchCurveSellPlanV1 = { curveInput, sellerInput, quote, networkFee, minQuoteOut,
    outputs: [successor(m, curveInput, quote.next.base, quote.next.state),
      { lockingBytecode: sellerInput.lockingBytecode, satoshis: proceeds }] };
  verifyBchCurveSellPlanV1(m, plan);
  return plan;
}

export function verifyBchCurveSellPlanV1(m: LaunchManifestV1, plan: BchCurveSellPlanV1): void {
  const inventory = checkBchCurveSourceV1(m, plan.curveInput);
  const sellerToken = plan.sellerInput.token;
  if (!sellerToken || sellerToken.category !== m.tokenCategory || sellerToken.nft || sellerToken.amount <= 0n)
    fail('seller input must contain only launch FT');
  feeCap(plan.networkFee);
  if (plan.outputs.length !== 2) fail('sell requires two outputs');
  const quote = quoteSell(curveConfigFromManifestV1(m), inventory, sellerToken.amount);
  if (quote.traderQuote < plan.minQuoteOut || plan.quote.traderQuote !== quote.traderQuote ||
      plan.quote.next.base !== quote.next.base ||
      encodeCurveStateV1(plan.quote.next.state) !== encodeCurveStateV1(quote.next.state)) fail('sell quote differs');
  sameSuccessor(plan.outputs[0], successor(m, plan.curveInput, quote.next.base, quote.next.state));
  const payout = plan.outputs[1];
  if (payout.lockingBytecode !== plan.sellerInput.lockingBytecode || payout.token ||
      payout.satoshis !== plan.sellerInput.satoshis + quote.traderQuote - plan.networkFee || payout.satoshis < 546n)
    fail('seller proceeds differ');
}

function claimBalance(m: LaunchManifestV1, curveInput: SpendableUtxo, role: FeeRole) {
  const inventory = checkBchCurveSourceV1(m, curveInput);
  const state = structuredClone(inventory.state);
  const field = (['creatorFees', 'partnerFees', 'protocolFees'] as const)[role];
  const amount = state[field];
  if (amount < 1_000n) fail('claim balance below 1000 sats');
  state[field] = 0n;
  const rights = [m.curveFees.creator, m.curveFees.partner, m.curveFees.protocol][role];
  if (!rights) fail('invalid fee role');
  return { inventory, state, amount, rights };
}

export function planBchCurveClaimV1(m: LaunchManifestV1, curveInput: SpendableUtxo, sponsorInput: SpendableUtxo,
  role: FeeRole, recipientScript: string, networkFee: bigint): BchCurveClaimPlanV1 {
  const { inventory, state, amount, rights } = claimBalance(m, curveInput, role);
  if (sponsorInput.token) fail('claim sponsor must be BCH only');
  feeCap(networkFee);
  if (!/^(?:[0-9a-f]{2})+$/.test(recipientScript) || binToHex(sha256.hash(hexToBin(recipientScript))) !== rights.scriptHash)
    fail('recipient script differs from manifest');
  const change = sponsorInput.satoshis - networkFee;
  if (change < 546n) fail('claim sponsor change below dust');
  const plan: BchCurveClaimPlanV1 = { curveInput, sponsorInput, role, recipientScript, networkFee,
    outputs: [successor(m, curveInput, inventory.base, state),
      { lockingBytecode: recipientScript, satoshis: amount },
      { lockingBytecode: sponsorInput.lockingBytecode, satoshis: change }] };
  verifyBchCurveClaimPlanV1(m, plan);
  return plan;
}

export function verifyBchCurveClaimPlanV1(m: LaunchManifestV1, plan: BchCurveClaimPlanV1): void {
  const { inventory, state, amount, rights } = claimBalance(m, plan.curveInput, plan.role);
  if (plan.sponsorInput.token) fail('claim sponsor must be BCH only');
  feeCap(plan.networkFee);
  if (plan.outputs.length !== 3 || plan.recipientScript !== plan.outputs[1].lockingBytecode ||
      binToHex(sha256.hash(hexToBin(plan.recipientScript))) !== rights.scriptHash)
    fail('claim recipient differs from manifest');
  sameSuccessor(plan.outputs[0], successor(m, plan.curveInput, inventory.base, state));
  if (plan.outputs[1].satoshis !== amount || plan.outputs[1].token) fail('claim payout differs');
  if (plan.outputs[2].lockingBytecode !== plan.sponsorInput.lockingBytecode || plan.outputs[2].token ||
      plan.outputs[2].satoshis !== plan.sponsorInput.satoshis - plan.networkFee || plan.outputs[2].satoshis < 546n)
    fail('claim sponsor change differs');
}
