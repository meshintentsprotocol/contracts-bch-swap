import { binToHex, hash256, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract, type Artifact, type NetworkProvider } from 'cashscript';
import { decodeCurveStateV1 } from '../curve/state.js';
import { launchManifestHashV1, type LaunchManifestV1 } from '../manifest/v1.js';
import { validateTerminalPriceArithmetic } from './price-continuity.js';
import { tokenPairGraduationTermsHashV1, type TokenPairGraduationTermsV1 } from './token-pair-handoff.js';

const MAX_VM = (1n << 63n) - 1n;
const fail = (reason: string): never => { throw new Error(`Mesh Blaze token-pair V2: ${reason}`); };
const hashScript = (script: string) => binToHex(sha256.hash(hexToBin(script)));
const cat = (category: string) => `0x${binToHex(hexToBin(category).reverse())}`;
function fixed(value: bigint, bytes: 2 | 8, label: string): string {
  if (typeof value !== 'bigint' || value < 0n || value > (bytes === 2 ? 65_535n : MAX_VM))
    fail(`${label} outside fixed VM range`);
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = Number((value >> BigInt(i * 8)) & 255n);
  return `0x${binToHex(out)}`;
}

export interface TokenMarketTermsV1 {
  bidNum: bigint;
  bidDen: bigint;
  askNum: bigint;
  askDen: bigint;
  tradingFeeBps: number;
  marketCarrierSats: bigint;
  collectorCarrierSats: bigint;
}
export interface TokenPairV2Artifacts {
  curveBase: Artifact;
  curveQuote: Artifact;
  marketBaseLocked: Artifact;
  marketQuoteLocked: Artifact;
  marketBaseOwned: Artifact;
  marketQuoteOwned: Artifact;
  collector: Artifact;
  archive: Artifact;
}
export function validateTokenMarketArithmeticV1(m: LaunchManifestV1, t: TokenMarketTermsV1): void {
  if (m.quoteCategory === null) fail('CashToken quote required');
  if (![t.bidNum, t.bidDen, t.askNum, t.askDen].every((n) => typeof n === 'bigint' && n > 0n && n <= MAX_VM))
    fail('invalid market price fraction');
  if (t.askNum * t.bidDen > MAX_VM || t.bidNum * t.askDen > MAX_VM ||
      t.askNum * t.bidDen < t.bidNum * t.askDen) fail('unsafe or crossed market price');
  if (!Number.isInteger(t.tradingFeeBps) || t.tradingFeeBps < 1 || t.tradingFeeBps >= 10_000)
    fail('trading fee outside 1..9999 bps');
  if (t.marketCarrierSats < 1_000n || t.collectorCarrierSats < 1_000n ||
      t.marketCarrierSats > MAX_VM || t.collectorCarrierSats > MAX_VM)
    fail('market or collector carrier outside VM range');
  const shares = [m.marketFees.creator.bps, m.marketFees.partner.bps, m.marketFees.protocol.bps];
  if (shares[2]! <= 0 || shares.reduce((sum, x) => sum + x, 0) > 10_000)
    fail('invalid market recipient shares');
  const maxAskProduct = m.totalSupply * t.askNum;
  const maxBidProduct = m.totalSupply * t.bidNum;
  if (maxAskProduct + t.askDen - 1n > MAX_VM || maxBidProduct > MAX_VM)
    fail('price product exceeds VM range');
  const maxAsk = (maxAskProduct + t.askDen - 1n) / t.askDen;
  const maxBid = maxBidProduct / t.bidDen;
  const maxQuote = maxAsk > maxBid ? maxAsk : maxBid;
  if (maxQuote * BigInt(t.tradingFeeBps) + 9_999n > MAX_VM)
    fail('fee product exceeds VM range');
  const maxFee = (maxQuote * BigInt(t.tradingFeeBps) + 9_999n) / 10_000n;
  if (maxFee * 10_000n > MAX_VM || maxQuote + maxFee > MAX_VM)
    fail('fee-share or quote amount exceeds VM range');
  validateTerminalPriceArithmetic(m, t);
}

/** Rebuild all E2 scripts from explicit terms before accepting a genesis commitment. */
export function tokenPairV2FromManifest(m: LaunchManifestV1, market: TokenMarketTermsV1,
  terms: TokenPairGraduationTermsV1, artifacts: TokenPairV2Artifacts, provider: NetworkProvider) {
  launchManifestHashV1(m);
  validateTokenMarketArithmeticV1(m, market);
  tokenPairGraduationTermsHashV1(terms);
  if (m.quoteCategory === null) fail('CashToken quote required');
  const quoteCategory = m.quoteCategory as string;
  if (m.graduationScriptHash !== m.curveScriptHash)
    fail('graduation script hash must pin the V2 base curve');
  if (terms.lockedBps !== m.lockedLiquidityBps ||
      terms.marketCarrierSats !== market.marketCarrierSats ||
      terms.collectorCarrierSats !== market.collectorCarrierSats)
    fail('graduation shares or carriers differ');
  if (terms.creatorPositionCategory === m.tokenCategory ||
      terms.creatorPositionCategory === m.quoteCategory)
    fail('creator position category collides with trade assets');
  const allocation = m.allocations.find((entry) => entry.name === 'curve');
  if (!allocation?.nftCommitment) fail('curve allocation lacks state NFT');
  const curveAllocation = allocation!;
  const state = decodeCurveStateV1(curveAllocation.nftCommitment!);
  if (state.stage !== 0 || state.realQuote || state.creatorFees || state.partnerFees || state.protocolFees)
    fail('curve genesis state must be empty');
  const rights = [m.marketFees.creator, m.marketFees.partner, m.marketFees.protocol] as const;
  const collectors = rights.map((right) => new Contract(artifacts.collector,
    [cat(quoteCategory), `0x${right.scriptHash}`,
      fixed(market.collectorCarrierSats, 8, 'collector carrier')],
    { provider, contractType: 'p2sh32' }));
  const collectorHashes = collectors.map((collector) => `0x${hashScript(collector.lockingBytecode)}`);
  const price = [fixed(market.bidNum, 8, 'bid numerator'), fixed(market.bidDen, 8, 'bid denominator'),
    fixed(market.askNum, 8, 'ask numerator'), fixed(market.askDen, 8, 'ask denominator')];
  const shares = [fixed(BigInt(market.tradingFeeBps), 2, 'trading fee'),
    ...rights.map((right) => fixed(BigInt(right.bps), 2, 'market share'))];
  const marketArgs = [cat(m.tokenCategory), cat(quoteCategory), ...price,
    fixed(market.marketCarrierSats, 8, 'market carrier'),
    fixed(market.marketCarrierSats, 8, 'market carrier'),
    fixed(market.collectorCarrierSats, 8, 'collector carrier'), ...collectorHashes, ...shares];
  const lockedQuote = new Contract(artifacts.marketQuoteLocked, marketArgs,
    { provider, contractType: 'p2sh32' });
  const lockedBase = new Contract(artifacts.marketBaseLocked,
    [marketArgs[0]!, marketArgs[1]!, `0x${binToHex(hash256(hexToBin(lockedQuote.bytecode)))}`,
      ...marketArgs.slice(2)], { provider, contractType: 'p2sh32' });
  const ownedArgs = [marketArgs[0]!, marketArgs[1]!, cat(terms.creatorPositionCategory),
    ...marketArgs.slice(2)];
  const ownedQuote = new Contract(artifacts.marketQuoteOwned, ownedArgs,
    { provider, contractType: 'p2sh32' });
  const ownedBase = new Contract(artifacts.marketBaseOwned,
    [ownedArgs[0]!, ownedArgs[1]!, ownedArgs[2]!,
      `0x${binToHex(hash256(hexToBin(ownedQuote.bytecode)))}`, ...ownedArgs.slice(3)],
    { provider, contractType: 'p2sh32' });
  const archive = new Contract(artifacts.archive, [], { provider, contractType: 'p2sh32' });
  if (archive.bytecode !== '00') fail('state archive is not OP_0');
  if (terms.lockedBaseScript !== lockedBase.lockingBytecode ||
      terms.lockedQuoteScript !== lockedQuote.lockingBytecode ||
      terms.creatorBaseScript !== ownedBase.lockingBytecode ||
      terms.creatorQuoteScript !== ownedQuote.lockingBytecode ||
      terms.archiveScript !== archive.lockingBytecode ||
      terms.collectorScripts.some((script, i) => script !== collectors[i]!.lockingBytecode))
    fail('graduation destination is not reconstructed artifact');
  if (hashScript(lockedBase.lockingBytecode) !== m.marketScriptHash)
    fail('locked market script differs from manifest');
  const destinationHashes = [terms.lockedBaseScript, terms.lockedQuoteScript,
    terms.creatorBaseScript, terms.creatorQuoteScript, terms.archiveScript,
    ...terms.collectorScripts].map((script) => `0x${hashScript(script)}`);
  const curveQuote = new Contract(artifacts.curveQuote,
    [cat(m.tokenCategory), cat(quoteCategory), fixed(m.quoteVaultCarrierSats, 8, 'quote carrier'),
      fixed(m.graduationQuoteThreshold, 8, 'graduation threshold'),
      fixed(m.virtualBase, 8, 'virtual base'), fixed(m.virtualQuote, 8, 'virtual quote'),
      fixed(curveAllocation.satoshis, 8, 'base carrier'), fixed(BigInt(terms.lockedBps), 2, 'locked bps'),
      fixed(market.marketCarrierSats, 8, 'market carrier'),
      fixed(market.collectorCarrierSats, 8, 'collector carrier'), ...destinationHashes, ...price],
    { provider, contractType: 'p2sh32' });
  const f = m.curveFees;
  const curveBase = new Contract(artifacts.curveBase,
    [cat(m.tokenCategory), cat(quoteCategory),
      `0x${binToHex(hash256(hexToBin(curveQuote.bytecode)))}`,
      fixed(m.virtualBase, 8, 'virtual base'), fixed(m.virtualQuote, 8, 'virtual quote'),
      fixed(m.graduationQuoteThreshold, 8, 'graduation threshold'),
      fixed(curveAllocation.satoshis, 8, 'base carrier'),
      fixed(BigInt(f.creator.bps), 2, 'creator curve fee'),
      fixed(BigInt(f.partner.bps), 2, 'partner curve fee'),
      fixed(BigInt(f.protocol.bps), 2, 'protocol curve fee'),
      `0x${f.creator.scriptHash}`, `0x${f.partner.scriptHash}`, `0x${f.protocol.scriptHash}`,
      fixed(m.quoteVaultCarrierSats, 8, 'quote carrier'),
      fixed(BigInt(terms.lockedBps), 2, 'locked bps'),
      fixed(market.marketCarrierSats, 8, 'market carrier'),
      fixed(market.collectorCarrierSats, 8, 'collector carrier'), ...destinationHashes, ...price],
    { provider, contractType: 'p2sh32' });
  if (hashScript(curveBase.lockingBytecode) !== m.curveScriptHash ||
      curveBase.lockingBytecode !== curveAllocation.lockingBytecode ||
      hashScript(curveQuote.lockingBytecode) !== m.quoteVaultScriptHash)
    fail('paired curve scripts differ from manifest');
  return { curveBase, curveQuote, lockedBase, lockedQuote, ownedBase, ownedQuote,
    collectors: collectors as [Contract, Contract, Contract], archive };
}
