import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract, type Artifact, type NetworkProvider } from 'cashscript';
import { decodeCurveStateV1, requiredBchSatoshis } from './state.js';
import { launchManifestHashV1, type LaunchManifestV1 } from '../manifest/v1.js';

const MAX_VM = (1n << 63n) - 1n;
const hex8 = (value: bigint, label: string): string => {
  if (value < 0n || value > MAX_VM) throw new Error(`Mesh Blaze BCH curve: ${label} outside signed VM range`);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((value >> BigInt(8 * i)) & 255n);
  return `0x${binToHex(out)}`;
};
const hex2 = (value: number, label: string): string => {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error(`Mesh Blaze BCH curve: invalid ${label}`);
  return `0x${binToHex(Uint8Array.of(value & 255, value >> 8))}`;
};

/** Reconstruct the covenant address from committed launch economics, then compare its script hash. */
export function bchCurveFromManifestV1(artifact: Artifact, manifest: LaunchManifestV1, provider: NetworkProvider): Contract {
  if (manifest.quoteCategory !== null) throw new Error('Mesh Blaze BCH curve: quote category must be BCH');
  // Validates the complete manifest before any constructor field is read.
  launchManifestHashV1(manifest);
  const curve = manifest.allocations.find((a) => a.name === 'curve');
  if (!curve?.nftCommitment) throw new Error('Mesh Blaze BCH curve: missing curve state NFT');
  const initial = decodeCurveStateV1(curve.nftCommitment);
  if (initial.stage !== 0 || initial.realQuote !== 0n || initial.creatorFees !== 0n || initial.partnerFees !== 0n || initial.protocolFees !== 0n)
    throw new Error('Mesh Blaze BCH curve: genesis state must start empty');
  const carrier = curve.satoshis;
  requiredBchSatoshis(initial, carrier);
  const fees = manifest.curveFees;
  const totalBps = fees.creator.bps + fees.partner.bps + fees.protocol.bps;
  if (totalBps <= 0 || totalBps >= 10_000) throw new Error('Mesh Blaze BCH curve: fee total must be 1..9999 bps');
  const categoryVm = binToHex(hexToBin(manifest.tokenCategory).reverse());
  const args = [
    `0x${categoryVm}`,
    hex8(manifest.virtualBase, 'virtual base'),
    hex8(manifest.virtualQuote, 'virtual quote'),
    hex8(manifest.graduationQuoteThreshold, 'graduation threshold'),
    hex8(carrier, 'carrier'),
    hex2(fees.creator.bps, 'creator fee'),
    hex2(fees.partner.bps, 'partner fee'),
    hex2(fees.protocol.bps, 'protocol fee'),
    `0x${fees.creator.scriptHash}`,
    `0x${fees.partner.scriptHash}`,
    `0x${fees.protocol.scriptHash}`,
  ];
  const contract = new Contract(artifact, args, { provider, contractType: 'p2sh32' });
  const scriptHash = binToHex(sha256.hash(hexToBin(contract.lockingBytecode)));
  if (scriptHash !== manifest.curveScriptHash || contract.lockingBytecode !== curve.lockingBytecode)
    throw new Error('Mesh Blaze BCH curve: script differs from manifest curve allocation');
  return contract;
}
