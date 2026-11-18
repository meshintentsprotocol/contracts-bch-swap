import type { SpendableUtxo } from 'cashscript';
import { encodeCurveStateV1 } from './state.js';
import { quoteSell, type SellQuote } from '../math/curve.js';
import { readTokenPairVaultsV1, tokenPairCurveConfigV1 } from './token-pair-buy-plan.js';
import type { PlannedOutput } from './buy-plan.js';
import type { LaunchManifestV1 } from '../manifest/v1.js';

export interface TokenPairSellPlanV1 {
  feeCap: bigint;
  baseInput: SpendableUtxo;
  quoteInput: SpendableUtxo;
  sellerInput: SpendableUtxo;
  outputs: readonly [PlannedOutput, PlannedOutput, PlannedOutput];
  quote: SellQuote;
  minQuoteOut: bigint;
  networkFee: bigint;
}
function fail(message: string): never { throw new Error(`Mesh Blaze token-pair sell plan: ${message}`); }
function sellerAmount(m: LaunchManifestV1, seller: SpendableUtxo): bigint {
  if (!seller.token || seller.token.category !== m.tokenCategory || seller.token.nft || seller.token.amount <= 0n)
    fail('seller input must carry only launch FT');
  return seller.token.amount;
}
function outputsFor(m: LaunchManifestV1, base: SpendableUtxo, quote: SpendableUtxo, seller: SpendableUtxo,
  trade: SellQuote, networkFee: bigint): [PlannedOutput, PlannedOutput, PlannedOutput] {
  const state = trade.next.state;
  const quoteHeld = state.realQuote + state.creatorFees + state.partnerFees + state.protocolFees;
  const sellerCarrier = seller.satoshis - networkFee;
  if (sellerCarrier < 1_000n) fail('seller BCH cannot fund quote-token carrier and fee');
  return [
    { lockingBytecode: base.lockingBytecode, satoshis: base.satoshis,
      token: { category: m.tokenCategory, amount: trade.next.base,
        nft: { capability: 'mutable', commitment: encodeCurveStateV1(state) } } },
    { lockingBytecode: quote.lockingBytecode, satoshis: quote.satoshis,
      ...(quoteHeld > 0n ? { token: { category: m.quoteCategory!, amount: quoteHeld } } : {}) },
    { lockingBytecode: seller.lockingBytecode, satoshis: sellerCarrier,
      token: { category: m.quoteCategory!, amount: trade.traderQuote } },
  ];
}

export function planTokenPairSellV1(m: LaunchManifestV1, baseInput: SpendableUtxo, quoteInput: SpendableUtxo,
  sellerInput: SpendableUtxo, networkFee: bigint, minQuoteOut: bigint,
  feeCap = 5_000n): TokenPairSellPlanV1 {
  const { inventory } = readTokenPairVaultsV1(m, baseInput, quoteInput);
  if (![5_000n, 10_000n].includes(feeCap) || networkFee < 0n || networkFee > feeCap)
    fail('network fee outside covenant cap');
  if (minQuoteOut < 0n) fail('negative minimum quote output');
  const trade = quoteSell(tokenPairCurveConfigV1(m), inventory, sellerAmount(m, sellerInput));
  if (trade.traderQuote < minQuoteOut) fail('slippage: quote output below minimum');
  const plan: TokenPairSellPlanV1 = { baseInput, quoteInput, sellerInput, networkFee, minQuoteOut,
    feeCap, quote: trade,
    outputs: outputsFor(m, baseInput, quoteInput, sellerInput, trade, networkFee) };
  verifyTokenPairSellPlanV1(m, plan);
  return plan;
}

export function verifyTokenPairSellPlanV1(m: LaunchManifestV1, plan: TokenPairSellPlanV1): void {
  const { inventory } = readTokenPairVaultsV1(m, plan.baseInput, plan.quoteInput);
  if (![5_000n, 10_000n].includes(plan.feeCap) || plan.networkFee < 0n ||
      plan.networkFee > plan.feeCap || plan.outputs.length !== 3)
    fail('invalid fee or output count');
  const expected = quoteSell(tokenPairCurveConfigV1(m), inventory, sellerAmount(m, plan.sellerInput));
  if (expected.traderQuote < plan.minQuoteOut || plan.quote.grossQuote !== expected.grossQuote ||
      plan.quote.next.base !== expected.next.base ||
      encodeCurveStateV1(plan.quote.next.state) !== encodeCurveStateV1(expected.next.state)) fail('sell quote or slippage differs');
  const outputs = outputsFor(m, plan.baseInput, plan.quoteInput, plan.sellerInput, expected, plan.networkFee);
  for (let i = 0; i < 3; i++) {
    const actual = plan.outputs[i]!;
    const want = outputs[i]!;
    if (actual.lockingBytecode !== want.lockingBytecode || actual.satoshis !== want.satoshis ||
        actual.token?.category !== want.token?.category || actual.token?.amount !== want.token?.amount ||
        actual.token?.nft?.capability !== want.token?.nft?.capability ||
        actual.token?.nft?.commitment !== want.token?.nft?.commitment) fail(`output ${i} differs`);
  }
}
