import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import type { SpendableUtxo } from 'cashscript';
import { decodeCurveStateV1, encodeCurveStateV1 } from './state.js';
import { quoteBuy, type BuyQuote, type CurveConfig } from '../math/curve.js';
import { launchManifestHashV1, type LaunchManifestV1 } from '../manifest/v1.js';
import type { PlannedOutput } from './buy-plan.js';

export interface TokenPairBuyPlanV1 {
  feeCap: bigint;
  baseInput: SpendableUtxo;
  quoteInput: SpendableUtxo;
  buyerInput: SpendableUtxo;
  outputs: readonly PlannedOutput[];
  quote: BuyQuote;
  maxGross: bigint;
  networkFee: bigint;
  minBaseOut: bigint;
}
function fail(message: string): never { throw new Error(`Mesh Blaze token-pair buy plan: ${message}`); }
export function tokenPairCurveConfigV1(m: LaunchManifestV1): CurveConfig {
  return { virtualBase: m.virtualBase, virtualQuote: m.virtualQuote, quoteThreshold: m.graduationQuoteThreshold,
    fees: { creatorBps: m.curveFees.creator.bps, partnerBps: m.curveFees.partner.bps, protocolBps: m.curveFees.protocol.bps } };
}
export function readTokenPairVaultsV1(m: LaunchManifestV1, base: SpendableUtxo, quote: SpendableUtxo) {
  launchManifestHashV1(m);
  if (m.quoteCategory === null) fail('manifest quote must be a CashToken');
  const allocation = m.allocations.find((a) => a.name === 'curve');
  if (!allocation || base.lockingBytecode !== allocation.lockingBytecode ||
      binToHex(sha256.hash(hexToBin(base.lockingBytecode))) !== m.curveScriptHash)
    fail('base script differs from manifest');
  if (!base.token || base.token.category !== m.tokenCategory || base.token.nft?.capability !== 'mutable' || base.token.amount <= 0n)
    fail('base input needs launch FT and state NFT');
  if (base.satoshis !== allocation.satoshis) fail('base carrier differs from manifest');
  const state = decodeCurveStateV1(base.token.nft.commitment);
  if (binToHex(sha256.hash(hexToBin(quote.lockingBytecode))) !== m.quoteVaultScriptHash ||
      quote.satoshis !== m.quoteVaultCarrierSats) fail('quote vault script or carrier differs');
  const held = state.realQuote + state.creatorFees + state.partnerFees + state.protocolFees;
  if (held === 0n ? Boolean(quote.token) :
      (!quote.token || quote.token.category !== m.quoteCategory || quote.token.amount !== held || Boolean(quote.token.nft)))
    fail('quote vault token ledger differs from NFT state');
  return { inventory: { base: base.token.amount, state }, held };
}
function readInputs(m: LaunchManifestV1, base: SpendableUtxo, quote: SpendableUtxo, buyer: SpendableUtxo) {
  const vaults = readTokenPairVaultsV1(m, base, quote);
  if (!buyer.token || buyer.token.category !== m.quoteCategory || buyer.token.nft || buyer.token.amount <= 0n)
    fail('buyer input must contain fungible quote tokens only');
  return vaults;
}
function sameToken(actual: PlannedOutput, category: string, amount: bigint, commitment?: string) {
  if (actual.token?.category !== category || actual.token.amount !== amount ||
      (commitment === undefined ? Boolean(actual.token.nft) :
        actual.token.nft?.capability !== 'mutable' || actual.token.nft.commitment !== commitment))
    fail('output token differs');
}

/** Exact-in quote plan; three outputs for exact funding, four for positive quote change. */
export function planTokenPairBuyV1(m: LaunchManifestV1, baseInput: SpendableUtxo, quoteInput: SpendableUtxo,
  buyerInput: SpendableUtxo, maxGross: bigint, networkFee: bigint, minBaseOut: bigint,
  feeCap = 5_000n): TokenPairBuyPlanV1 {
  const { inventory, held } = readInputs(m, baseInput, quoteInput, buyerInput);
  if (![5_000n, 10_000n].includes(feeCap) || networkFee < 0n || networkFee > feeCap)
    fail('network fee outside covenant cap');
  if (minBaseOut <= 0n) fail('minimum base output must be positive');
  const trade = quoteBuy(tokenPairCurveConfigV1(m), inventory, maxGross);
  if (trade.baseOut < minBaseOut) fail('slippage: base output below minimum');
  if (buyerInput.token!.amount < trade.usedGross) fail('buyer quote input below used gross');
  const remainder = buyerInput.token!.amount - trade.usedGross;
  const buyerBaseCarrier = remainder === 0n ? buyerInput.satoshis - networkFee : 1_000n;
  const buyerQuoteCarrier = remainder === 0n ? 0n : buyerInput.satoshis - buyerBaseCarrier - networkFee;
  if (buyerBaseCarrier < 1_000n || (remainder > 0n && buyerQuoteCarrier < 1_000n)) fail('buyer BCH cannot fund token carriers and fee');
  const outputs: PlannedOutput[] = [
    { lockingBytecode: baseInput.lockingBytecode, satoshis: baseInput.satoshis,
      token: { category: m.tokenCategory, amount: trade.next.base,
        nft: { capability: 'mutable', commitment: encodeCurveStateV1(trade.next.state) } } },
    { lockingBytecode: quoteInput.lockingBytecode, satoshis: quoteInput.satoshis,
      token: { category: m.quoteCategory!, amount: held + trade.usedGross } },
    { lockingBytecode: buyerInput.lockingBytecode, satoshis: buyerBaseCarrier,
      token: { category: m.tokenCategory, amount: trade.baseOut } },
  ];
  if (remainder > 0n) outputs.push({ lockingBytecode: buyerInput.lockingBytecode, satoshis: buyerQuoteCarrier,
    token: { category: m.quoteCategory!, amount: remainder } });
  const plan: TokenPairBuyPlanV1 = { baseInput, quoteInput, buyerInput, outputs, quote: trade, maxGross,
    networkFee, minBaseOut, feeCap };
  verifyTokenPairBuyPlanV1(m, plan);
  return plan;
}

/** Recompute economics and exact destinations before presenting the plan for signatures. */
export function verifyTokenPairBuyPlanV1(m: LaunchManifestV1, plan: TokenPairBuyPlanV1): void {
  const { inventory, held } = readInputs(m, plan.baseInput, plan.quoteInput, plan.buyerInput);
  if (![5_000n, 10_000n].includes(plan.feeCap) || plan.networkFee < 0n || plan.networkFee > plan.feeCap)
    fail('network fee outside covenant cap');
  const expected = quoteBuy(tokenPairCurveConfigV1(m), inventory, plan.maxGross);
  if (expected.baseOut < plan.minBaseOut || plan.quote.usedGross !== expected.usedGross ||
      encodeCurveStateV1(plan.quote.next.state) !== encodeCurveStateV1(expected.next.state) ||
      plan.quote.next.base !== expected.next.base) fail('quoted state or slippage differs');
  const remainder = plan.buyerInput.token!.amount - expected.usedGross;
  if (remainder < 0n || plan.outputs.length !== (remainder === 0n ? 3 : 4)) fail('quote change output count differs');
  const [base, quote, buyerBase, buyerChange] = plan.outputs;
  if (!base || !quote || !buyerBase) fail('missing outputs');
  if (base.lockingBytecode !== plan.baseInput.lockingBytecode || base.satoshis !== plan.baseInput.satoshis) fail('base successor differs');
  sameToken(base, m.tokenCategory, expected.next.base, encodeCurveStateV1(expected.next.state));
  if (quote.lockingBytecode !== plan.quoteInput.lockingBytecode || quote.satoshis !== plan.quoteInput.satoshis) fail('quote successor differs');
  sameToken(quote, m.quoteCategory!, held + expected.usedGross);
  if (buyerBase.lockingBytecode !== plan.buyerInput.lockingBytecode || buyerBase.satoshis < 1_000n) fail('buyer base payout differs');
  sameToken(buyerBase, m.tokenCategory, expected.baseOut);
  if (remainder > 0n) {
    if (!buyerChange || buyerChange.lockingBytecode !== plan.buyerInput.lockingBytecode || buyerChange.satoshis < 1_000n)
      fail('quote refund destination differs');
    sameToken(buyerChange, m.quoteCategory!, remainder);
  }
  if (buyerBase.satoshis + (buyerChange?.satoshis ?? 0n) !== plan.buyerInput.satoshis - plan.networkFee)
    fail('buyer BCH fee or change differs');
}
