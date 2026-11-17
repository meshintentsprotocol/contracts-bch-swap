import type { LaunchManifestV1 } from '../manifest/v1.js';
import type { BchGraduationTermsV2 } from './bch-handoff.js';

export interface BchChipnetBudgetOptions {
  /** Reusable wallet float for sells, post-graduation swaps and token output carriers. */
  tradeFloatSats: bigint;
  /** Wallet-funded fees across the entire E1 transaction sequence. */
  networkFeeReserveSats: bigint;
  /** Carrier of the separate creator position NFT output. */
  positionNftCarrierSats: bigint;
}

/** Conservative funding target for one BCH-quoted launch; no network calls or broadcast. */
export function estimateBchChipnetBudget(m: Pick<LaunchManifestV1,
  'quoteCategory' | 'graduationQuoteThreshold' | 'curveFees' | 'allocations' | 'lockedLiquidityBps'>,
  terms: Pick<BchGraduationTermsV2, 'lockedBps' | 'collectorCarrierSats'>,
  options: BchChipnetBudgetOptions) {
  const fail = (message: string): never => { throw new Error(`Mesh Blaze chipnet budget: ${message}`); };
  if (m.quoteCategory !== null) fail('BCH quote required');
  if (terms.lockedBps !== m.lockedLiquidityBps || terms.lockedBps < 9_000 || terms.lockedBps > 10_000)
    fail('invalid lock share');
  const threshold = m.graduationQuoteThreshold;
  const curve = m.allocations.find((allocation) => allocation.name === 'curve');
  if (!curve) throw new Error('Mesh Blaze chipnet budget: missing curve allocation');
  if (threshold <= 0n || curve.satoshis < 1_000n) fail('invalid curve allocation');
  const feeBps = m.curveFees.creator.bps + m.curveFees.partner.bps + m.curveFees.protocol.bps;
  if (!Number.isInteger(feeBps) || feeBps <= 0 || feeBps >= 10_000) fail('invalid curve fee');
  if (terms.collectorCarrierSats < 1_000n || options.positionNftCarrierSats < 1_000n ||
      options.tradeFloatSats < 0n || options.networkFeeReserveSats < 0n) fail('invalid reserves or carriers');
  // Conservative upper estimate: integer fee rounding can lower the actual gross needed.
  const grossBuyBudget = (threshold * 10_000n + BigInt(10_000 - feeBps) - 1n) / BigInt(10_000 - feeBps);
  const binCarriers = terms.lockedBps === 10_000 ? 1_000n : 2_000n;
  const collectorCarriers = 3n * terms.collectorCarrierSats;
  const capitalNeeded = grossBuyBudget + curve.satoshis + binCarriers + collectorCarriers +
    options.positionNftCarrierSats + options.tradeFloatSats + options.networkFeeReserveSats;
  const minimumLockedQuote = (threshold * BigInt(terms.lockedBps) + 9_999n) / 10_000n;
  return { grossBuyBudget, threshold, minimumLockedQuote, binCarriers, collectorCarriers,
    curveCarrier: curve.satoshis, positionNftCarrier: options.positionNftCarrierSats,
    tradeFloat: options.tradeFloatSats, networkFeeReserve: options.networkFeeReserveSats,
    capitalNeeded };
}
