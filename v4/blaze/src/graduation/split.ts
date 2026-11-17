/** Exact two-asset allocation for the BCH-quoted V4 handoff. This is planning math, not spend authorization. */
export interface GraduationSplitV1 {
  lockedBase: bigint;
  creatorBase: bigint;
  lockedQuote: bigint;
  creatorQuote: bigint;
}

export function graduationSplitV1(base: bigint, quote: bigint, lockedBps: number): GraduationSplitV1 {
  if (base <= 0n || quote <= 0n) throw new Error('Mesh Blaze graduation: both assets must be positive');
  if (!Number.isInteger(lockedBps) || lockedBps < 9_000 || lockedBps > 10_000)
    throw new Error('Mesh Blaze graduation: lock share must be 9000..10000 bps');
  const ceilShare = (amount: bigint) => (amount * BigInt(lockedBps) + 9_999n) / 10_000n;
  const lockedBase = ceilShare(base);
  const lockedQuote = ceilShare(quote);
  return {
    lockedBase, creatorBase: base - lockedBase,
    lockedQuote, creatorQuote: quote - lockedQuote,
  };
}
