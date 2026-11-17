import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract, type Artifact, type NetworkProvider } from 'cashscript';
import { launchManifestHashV1, type LaunchManifestV1 } from '../manifest/v1.js';

const MAX_VM = (1n << 63n) - 1n;
const fail = (reason: string): never => { throw new Error(`Mesh Blaze BCH market: ${reason}`); };
const hashScript = (script: string) => binToHex(sha256.hash(hexToBin(script)));
const fixed = (value: bigint, bytes: 2 | 8, label: string): string => {
  if (typeof value !== 'bigint' || value < 0n || value > (bytes === 2 ? 65_535n : MAX_VM)) fail(`${label} outside fixed VM range`);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = Number((value >> BigInt(i * 8)) & 255n);
  return `0x${binToHex(out)}`;
};

/** Market fee shares are bps of the one explicit trading fee; LP receives the remainder. */
export interface BchMarketTermsV1 {
  bidNum: bigint;
  bidDen: bigint;
  askNum: bigint;
  askDen: bigint;
  tradingFeeBps: number;
  collectorCarrierSats: bigint;
}

export function validateBchMarketArithmeticV1(m: LaunchManifestV1, t: BchMarketTermsV1): void {
  if (m.quoteCategory !== null) fail('quote must be BCH');
  if (![t.bidNum, t.bidDen, t.askNum, t.askDen].every((n) => typeof n === 'bigint' && n > 0n && n <= MAX_VM))
    fail('bid and ask fractions must be positive VM integers');
  if (t.askNum * t.bidDen > MAX_VM || t.bidNum * t.askDen > MAX_VM ||
      t.askNum * t.bidDen < t.bidNum * t.askDen) fail('unsafe or crossed price fractions');
  if (!Number.isInteger(t.tradingFeeBps) || t.tradingFeeBps < 1 || t.tradingFeeBps >= 10_000)
    fail('trading fee outside 1..9999 bps');
  if (t.collectorCarrierSats < 1_000n || t.collectorCarrierSats > MAX_VM) fail('collector carrier outside VM range');
  const shares = [m.marketFees.creator.bps, m.marketFees.partner.bps, m.marketFees.protocol.bps];
  if (shares[2]! <= 0 || shares.reduce((sum, n) => sum + n, 0) > 10_000)
    fail('market recipient shares invalid');
  const maxAskProduct = m.totalSupply * t.askNum;
  const maxBidProduct = m.totalSupply * t.bidNum;
  if (maxAskProduct + t.askDen - 1n > MAX_VM || maxBidProduct > MAX_VM)
    fail('supply times price exceeds VM range');
  const maxAsk = (maxAskProduct + t.askDen - 1n) / t.askDen;
  const maxBid = maxBidProduct / t.bidDen;
  const maxQuote = maxAsk > maxBid ? maxAsk : maxBid;
  if (maxQuote * BigInt(t.tradingFeeBps) + 9_999n > MAX_VM) fail('fee product exceeds VM range');
  const maxFee = (maxQuote * BigInt(t.tradingFeeBps) + 9_999n) / 10_000n;
  if (maxFee * 10_000n > MAX_VM) fail('fee-share product exceeds VM range');
  if (maxQuote + maxFee + t.collectorCarrierSats > MAX_VM) fail('market BCH value exceeds VM range');
}

/** Reconstruct collector and locked-bin addresses; manifest.marketScriptHash pins all constructor terms indirectly. */
export function bchFeeMarketFromManifestV1(m: LaunchManifestV1, t: BchMarketTermsV1,
  binArtifact: Artifact, collectorArtifact: Artifact, provider: NetworkProvider) {
  launchManifestHashV1(m);
  validateBchMarketArithmeticV1(m, t);
  const roleRights = [m.marketFees.creator, m.marketFees.partner, m.marketFees.protocol] as const;
  const collectors = roleRights.map((right) => new Contract(collectorArtifact,
    [`0x${right.scriptHash}`, fixed(t.collectorCarrierSats, 8, 'collector carrier')],
    { provider, contractType: 'p2sh32' }));
  const vmCategory = `0x${binToHex(hexToBin(m.tokenCategory).reverse())}`;
  const bin = new Contract(binArtifact, [vmCategory,
    fixed(t.bidNum, 8, 'bid numerator'), fixed(t.bidDen, 8, 'bid denominator'),
    fixed(t.askNum, 8, 'ask numerator'), fixed(t.askDen, 8, 'ask denominator'),
    ...collectors.map((c) => `0x${hashScript(c.lockingBytecode)}`),
    fixed(BigInt(t.tradingFeeBps), 2, 'trading fee'),
    fixed(BigInt(m.marketFees.creator.bps), 2, 'creator share'),
    fixed(BigInt(m.marketFees.partner.bps), 2, 'partner share'),
    fixed(BigInt(m.marketFees.protocol.bps), 2, 'protocol share')],
    { provider, contractType: 'p2sh32' });
  if (hashScript(bin.lockingBytecode) !== m.marketScriptHash) fail('market script differs from manifest');
  return { bin, creatorCollector: collectors[0]!, partnerCollector: collectors[1]!, protocolCollector: collectors[2]! };
}

/** Creator-share bin uses the same price, fee and collectors, with only its position NFT enabling principal exit. */
export function bchOwnedFeeBinFromMarketV1(m: LaunchManifestV1, t: BchMarketTermsV1,
  ownerCategory: string, market: ReturnType<typeof bchFeeMarketFromManifestV1>,
  ownedArtifact: Artifact, provider: NetworkProvider): Contract {
  validateBchMarketArithmeticV1(m, t);
  if (!/^[0-9a-f]{64}$/.test(ownerCategory) || ownerCategory === m.tokenCategory || /^0+$/.test(ownerCategory))
    fail('invalid creator position category');
  const collectors = [market.creatorCollector, market.partnerCollector, market.protocolCollector];
  return new Contract(ownedArtifact, [
    `0x${binToHex(hexToBin(m.tokenCategory).reverse())}`,
    `0x${binToHex(hexToBin(ownerCategory).reverse())}`,
    fixed(t.bidNum, 8, 'bid numerator'), fixed(t.bidDen, 8, 'bid denominator'),
    fixed(t.askNum, 8, 'ask numerator'), fixed(t.askDen, 8, 'ask denominator'),
    ...collectors.map((c) => `0x${hashScript(c.lockingBytecode)}`),
    fixed(BigInt(t.tradingFeeBps), 2, 'trading fee'),
    fixed(BigInt(m.marketFees.creator.bps), 2, 'creator share'),
    fixed(BigInt(m.marketFees.partner.bps), 2, 'partner share'),
    fixed(BigInt(m.marketFees.protocol.bps), 2, 'protocol share')],
    { provider, contractType: 'p2sh32' });
}
