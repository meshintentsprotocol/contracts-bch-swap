import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import type { SpendableUtxo, TokenDetails } from 'cashscript';
import { decodeCurveStateV1, encodeCurveStateV1, requiredBchSatoshis } from './state.js';
import { quoteBuy, type BuyQuote, type CurveConfig } from '../math/curve.js';
import type { LaunchManifestV1 } from '../manifest/v1.js';
import { validateBchCurveArithmeticV1 } from '../manifest/v1.js';

export interface PlannedOutput { lockingBytecode: string; satoshis: bigint; token?: TokenDetails }
export interface BchCurveBuyPlanV1 {
  curveInput: SpendableUtxo;
  buyerInput: SpendableUtxo;
  outputs: readonly [PlannedOutput, PlannedOutput, PlannedOutput];
  quote: BuyQuote;
  maxGross: bigint;
  networkFee: bigint;
}

function fail(reason: string): never { throw new Error(`Mesh Blaze BCH buy plan: ${reason}`); }
export function curveConfigFromManifestV1(m: LaunchManifestV1): CurveConfig {
  if (m.quoteCategory !== null) fail('manifest quote must be BCH');
  validateBchCurveArithmeticV1(m);
  return {
    virtualBase: m.virtualBase, virtualQuote: m.virtualQuote,
    quoteThreshold: m.graduationQuoteThreshold,
    fees: { creatorBps: m.curveFees.creator.bps, partnerBps: m.curveFees.partner.bps, protocolBps: m.curveFees.protocol.bps },
  };
}
export function curveCarrierFromManifestV1(m: LaunchManifestV1): bigint {
  const curve = m.allocations.find((a) => a.name === 'curve');
  if (!curve) fail('manifest has no curve allocation');
  return curve.satoshis;
}
export function checkBchCurveSourceV1(m: LaunchManifestV1, curveInput: SpendableUtxo) {
  const curve = m.allocations.find((a) => a.name === 'curve');
  if (!curve || curveInput.lockingBytecode !== curve.lockingBytecode ||
      binToHex(sha256.hash(hexToBin(curveInput.lockingBytecode))) !== m.curveScriptHash)
    fail('curve input script differs from manifest');
  const tok = curveInput.token;
  if (!tok || tok.category !== m.tokenCategory || tok.nft?.capability !== 'mutable' || tok.amount <= 0n)
    fail('curve input must carry launch FT and mutable state NFT');
  const state = decodeCurveStateV1(tok.nft.commitment);
  if (curveInput.satoshis !== requiredBchSatoshis(state, curveCarrierFromManifestV1(m))) fail('curve input value differs from state');
  return { base: tok.amount, state };
}

/** Pure plan: no key access, signing, network lookup, or broadcast. */
export function planBchCurveBuyV1(m: LaunchManifestV1, curveInput: SpendableUtxo, buyerInput: SpendableUtxo,
  maxGross: bigint, networkFee: bigint, minBaseOut: bigint): BchCurveBuyPlanV1 {
  const inventory = checkBchCurveSourceV1(m, curveInput);
  if (buyerInput.token) fail('buyer funding input must be BCH only');
  if (!/^(?:[0-9a-f]{2})+$/.test(buyerInput.lockingBytecode)) fail('invalid buyer script');
  if (networkFee < 0n || networkFee > 5_000n) fail('network fee outside covenant cap');
  if (minBaseOut <= 0n) fail('minimum base output must be positive');
  const quote = quoteBuy(curveConfigFromManifestV1(m), inventory, maxGross);
  if (quote.baseOut < minBaseOut) fail('slippage: base output below minimum');
  const curveValue = requiredBchSatoshis(quote.next.state, curveCarrierFromManifestV1(m));
  const tokenCarrier = 1_000n;
  const change = buyerInput.satoshis - quote.usedGross - tokenCarrier - networkFee;
  if (change < 546n) fail('buyer input cannot fund buy and dust-safe change');
  const buyerLock = buyerInput.lockingBytecode;
  const plan: BchCurveBuyPlanV1 = {
    curveInput, buyerInput, quote, maxGross, networkFee,
    outputs: [
      { lockingBytecode: curveInput.lockingBytecode, satoshis: curveValue,
        token: { category: m.tokenCategory, amount: quote.next.base,
          nft: { capability: 'mutable', commitment: encodeCurveStateV1(quote.next.state) } } },
      { lockingBytecode: buyerLock, satoshis: tokenCarrier, token: { category: m.tokenCategory, amount: quote.baseOut } },
      { lockingBytecode: buyerLock, satoshis: change },
    ],
  };
  verifyBchCurveBuyPlanV1(m, plan);
  return plan;
}

/** Wallets can recheck a plan after presentation and before signing. */
export function verifyBchCurveBuyPlanV1(m: LaunchManifestV1, plan: BchCurveBuyPlanV1): void {
  const inventory = checkBchCurveSourceV1(m, plan.curveInput);
  if (plan.buyerInput.token) fail('buyer funding input must be BCH only');
  if (plan.outputs.length !== 3) fail('buy requires three outputs');
  if (plan.networkFee < 0n || plan.networkFee > 5_000n) fail('network fee outside covenant cap');
  const expected = quoteBuy(curveConfigFromManifestV1(m), inventory, plan.maxGross);
  const [curve, token, change] = plan.outputs;
  if (plan.quote.usedGross !== expected.usedGross || plan.quote.baseOut !== expected.baseOut ||
      plan.quote.next.base !== expected.next.base ||
      encodeCurveStateV1(plan.quote.next.state) !== encodeCurveStateV1(expected.next.state)) fail('quoted state differs');
  if (curve.lockingBytecode !== plan.curveInput.lockingBytecode ||
      curve.satoshis !== requiredBchSatoshis(expected.next.state, curveCarrierFromManifestV1(m)) ||
      curve.token?.category !== m.tokenCategory || curve.token.amount !== expected.next.base ||
      curve.token.nft?.capability !== 'mutable' || curve.token.nft.commitment !== encodeCurveStateV1(expected.next.state))
    fail('curve successor differs');
  if (token.lockingBytecode !== plan.buyerInput.lockingBytecode || token.satoshis !== 1_000n ||
      token.token?.category !== m.tokenCategory || token.token.amount !== expected.baseOut || token.token.nft)
    fail('buyer token output differs');
  if (change.lockingBytecode !== plan.buyerInput.lockingBytecode || change.token ||
      change.satoshis !== plan.buyerInput.satoshis - expected.usedGross - token.satoshis - plan.networkFee ||
      change.satoshis < 546n) fail('buyer refund/change differs');
}
