import type { LaunchManifestV1 } from '../manifest/v1.js';
import type { BchMarketTermsV1 } from '../market/bch-market.js';

const MAX_VM = (1n << 63n) - 1n;
const fail = (reason: string): never => { throw new Error(`Mesh Blaze graduation price: ${reason}`); };

/** Safe for every terminal base balance from 1 through the launch supply. */
export function validateTerminalPriceArithmetic(m: LaunchManifestV1, t: BchMarketTermsV1): void {
  const spotNum = m.virtualQuote + m.graduationQuoteThreshold;
  const maxDen = m.virtualBase + m.totalSupply;
  if ([t.bidNum * maxDen, t.askNum * maxDen,
       spotNum * t.bidDen, spotNum * t.askDen].some((n) => n <= 0n || n * 11_000n > MAX_VM))
    fail('terminal comparison exceeds signed VM range');
}

/** Mirrors the V2 covenant's fixed 10% per-side terminal marginal-price band. */
export function checkTerminalPrice(m: LaunchManifestV1, t: BchMarketTermsV1, base: bigint): void {
  validateTerminalPriceArithmetic(m, t);
  if (base <= 0n || base > m.totalSupply) fail('terminal base outside launch supply');
  const spotNum = m.virtualQuote + m.graduationQuoteThreshold;
  const spotDen = m.virtualBase + base;
  const bid = t.bidNum * spotDen;
  const ask = t.askNum * spotDen;
  const bidSpot = spotNum * t.bidDen;
  const askSpot = spotNum * t.askDen;
  if (bid > bidSpot || ask < askSpot || bid * 10_000n < bidSpot * 9_000n ||
      ask * 10_000n > askSpot * 11_000n) fail('market bid/ask outside terminal 10% band');
}
