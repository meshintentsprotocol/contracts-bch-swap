import { binToHex, hash256, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract, type Artifact, type NetworkProvider } from 'cashscript';
import { launchManifestHashV1, type LaunchManifestV1 } from '../manifest/v1.js';
import { decodeCurveStateV1 } from './state.js';

const MAX_VM = (1n << 63n) - 1n;
function le8(value: bigint, minimum = 1_000n): string {
  if (value < minimum || value > MAX_VM) throw new Error('Mesh Blaze quote vault: number outside VM range');
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((value >> BigInt(i * 8)) & 255n);
  return `0x${binToHex(out)}`;
}
function vmCategory(display: string): string { return `0x${binToHex(hexToBin(display).reverse())}`; }

/** Reconstruct a quote vault from public launch terms and authenticate its script hash. */
export function tokenQuoteVaultFromManifestV1(artifact: Artifact, m: LaunchManifestV1, provider: NetworkProvider): Contract {
  if (m.quoteCategory === null) throw new Error('Mesh Blaze quote vault: manifest quote is BCH');
  launchManifestHashV1(m);
  const contract = new Contract(artifact, [vmCategory(m.tokenCategory), vmCategory(m.quoteCategory), le8(m.quoteVaultCarrierSats)],
    { provider, contractType: 'p2sh32' });
  if (binToHex(sha256.hash(hexToBin(contract.lockingBytecode))) !== m.quoteVaultScriptHash)
    throw new Error('Mesh Blaze quote vault: script differs from manifest');
  return contract;
}

/** Build quote first, then base; the base script commits the quote redeem-script hash. */
export function tokenPairFromManifestV1(baseArtifact: Artifact, quoteArtifact: Artifact, m: LaunchManifestV1,
  provider: NetworkProvider): { base: Contract; quote: Contract } {
  if (m.quoteCategory === null) throw new Error('Mesh Blaze token pair: manifest quote is BCH');
  launchManifestHashV1(m);
  const quote = tokenQuoteVaultFromManifestV1(quoteArtifact, m, provider);
  const allocation = m.allocations.find((a) => a.name === 'curve');
  if (!allocation?.nftCommitment) throw new Error('Mesh Blaze token pair: missing curve NFT');
  const state = decodeCurveStateV1(allocation.nftCommitment);
  if (state.stage !== 0 || state.realQuote !== 0n || state.creatorFees !== 0n || state.partnerFees !== 0n || state.protocolFees !== 0n)
    throw new Error('Mesh Blaze token pair: genesis state must start empty');
  const fees = m.curveFees;
  const total = fees.creator.bps + fees.partner.bps + fees.protocol.bps;
  if (total <= 0 || total >= 10_000) throw new Error('Mesh Blaze token pair: invalid fee total');
  const le2 = (n: number) => `0x${binToHex(Uint8Array.of(n & 255, n >> 8))}`;
  const base = new Contract(baseArtifact, [
    vmCategory(m.tokenCategory), vmCategory(m.quoteCategory), `0x${binToHex(hash256(hexToBin(quote.bytecode)))}`,
    le8(m.virtualBase, 1n), le8(m.virtualQuote, 1n), le8(m.graduationQuoteThreshold, 1n), le8(allocation.satoshis),
    le2(fees.creator.bps), le2(fees.partner.bps), le2(fees.protocol.bps),
    `0x${fees.creator.scriptHash}`, `0x${fees.partner.scriptHash}`, `0x${fees.protocol.scriptHash}`,
  ], { provider, contractType: 'p2sh32' });
  if (binToHex(sha256.hash(hexToBin(base.lockingBytecode))) !== m.curveScriptHash ||
      base.lockingBytecode !== allocation.lockingBytecode)
    throw new Error('Mesh Blaze token pair: base script differs from manifest allocation');
  return { base, quote };
}
