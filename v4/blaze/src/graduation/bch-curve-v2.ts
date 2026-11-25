import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract, type Artifact, type NetworkProvider } from 'cashscript';
import { decodeCurveStateV1 } from '../curve/state.js';
import { launchManifestHashV1, type LaunchManifestV1 } from '../manifest/v1.js';
import { bchFeeMarketFromManifestV1, bchOwnedFeeBinFromMarketV1, type BchMarketTermsV1 } from '../market/bch-market.js';
import { bchGraduationTermsHashV2, type BchGraduationTermsV2 } from './bch-handoff.js';
import { validateTerminalPriceArithmetic } from './price-continuity.js';

const fail = (reason: string): never => { throw new Error(`Mesh Blaze BCH graduation curve: ${reason}`); };
const hashScript = (hex: string) => binToHex(sha256.hash(hexToBin(hex)));
function fixed(value: bigint, bytes: 2 | 8): string {
  if (value < 0n || value >= (bytes === 2 ? 1n << 16n : 1n << 63n)) fail('constructor number outside VM range');
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = Number((value >> BigInt(i * 8)) & 255n);
  return `0x${binToHex(out)}`;
}

/** Rebuild both market and V2 curve. Script hashes bind the supplied terms indirectly; no funds are moved. */
export function bchGraduationCurveFromManifestV1(m: LaunchManifestV1, marketTerms: BchMarketTermsV1,
  graduationTerms: BchGraduationTermsV2, curveArtifact: Artifact, binArtifact: Artifact,
  collectorArtifact: Artifact, ownedBinArtifact: Artifact, archiveArtifact: Artifact, provider: NetworkProvider) {
  launchManifestHashV1(m);
  if (m.quoteCategory !== null) fail('quote must be BCH');
  bchGraduationTermsHashV2(graduationTerms);
  if (graduationTerms.lockedBps !== m.lockedLiquidityBps) fail('lock percentage differs from manifest');
  const market = bchFeeMarketFromManifestV1(m, marketTerms, binArtifact, collectorArtifact, provider);
  validateTerminalPriceArithmetic(m, marketTerms);
  if (graduationTerms.lockedBinScript !== market.bin.lockingBytecode)
    fail('locked destination is not the committed fee market');
  if (graduationTerms.collectorCarrierSats !== marketTerms.collectorCarrierSats ||
      graduationTerms.collectorScripts[0] !== market.creatorCollector.lockingBytecode ||
      graduationTerms.collectorScripts[1] !== market.partnerCollector.lockingBytecode ||
      graduationTerms.collectorScripts[2] !== market.protocolCollector.lockingBytecode)
    fail('collector destinations differ from committed fee market');
  const creatorBin = bchOwnedFeeBinFromMarketV1(m, marketTerms, graduationTerms.creatorPositionCategory,
    market, ownedBinArtifact, provider);
  if (creatorBin.lockingBytecode !== graduationTerms.creatorBinScript)
    fail('creator destination is not the committed owned fee market');
  const archive = new Contract(archiveArtifact, [], { provider, contractType: 'p2sh32' });
  if (archive.bytecode !== '00' || archive.lockingBytecode !== graduationTerms.stateArchiveScript)
    fail('state archive is not the permanent OP_0 covenant');
  if (graduationTerms.creatorPositionCategory === m.tokenCategory)
    fail('position category equals launch token');
  const allocation = m.allocations.find((a) => a.name === 'curve');
  if (!allocation?.nftCommitment) throw new Error('Mesh Blaze BCH graduation curve: missing curve state NFT');
  const initial = decodeCurveStateV1(allocation.nftCommitment);
  if (initial.stage !== 0 || initial.realQuote || initial.creatorFees || initial.partnerFees || initial.protocolFees)
    fail('curve genesis state must be empty');
  const vmCategory = `0x${binToHex(hexToBin(m.tokenCategory).reverse())}`;
  const f = m.curveFees;
  const curve = new Contract(curveArtifact, [vmCategory,
    fixed(m.virtualBase, 8), fixed(m.virtualQuote, 8), fixed(m.graduationQuoteThreshold, 8),
    fixed(allocation.satoshis, 8), fixed(BigInt(f.creator.bps), 2),
    fixed(BigInt(f.partner.bps), 2), fixed(BigInt(f.protocol.bps), 2),
    `0x${f.creator.scriptHash}`, `0x${f.partner.scriptHash}`, `0x${f.protocol.scriptHash}`,
    `0x${hashScript(graduationTerms.lockedBinScript)}`,
    `0x${hashScript(graduationTerms.creatorBinScript)}`,
    `0x${hashScript(graduationTerms.stateArchiveScript)}`,
    fixed(BigInt(graduationTerms.lockedBps), 2),
    ...graduationTerms.collectorScripts.map((script) => `0x${hashScript(script)}`),
    fixed(graduationTerms.collectorCarrierSats, 8),
    fixed(marketTerms.bidNum, 8), fixed(marketTerms.bidDen, 8),
    fixed(marketTerms.askNum, 8), fixed(marketTerms.askDen, 8)],
    { provider, contractType: 'p2sh32' });
  if (hashScript(curve.lockingBytecode) !== m.curveScriptHash ||
      curve.lockingBytecode !== allocation.lockingBytecode)
    fail('curve script differs from manifest allocation');
  return { curve, market, creatorBin, archive };
}
