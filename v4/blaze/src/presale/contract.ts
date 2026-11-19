import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract, type Artifact, type NetworkProvider } from 'cashscript';

const MAX_VM = (1n << 63n) - 1n;

const hex8 = (value: bigint, label: string): string => {
  if (value < 0n || value > MAX_VM) throw new Error(`Mesh Blaze presale: ${label} outside valid range`);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((value >> BigInt(8 * i)) & 255n);
  return `0x${binToHex(out)}`;
};

const hex4 = (value: number, label: string): string => {
  if (!Number.isInteger(value) || value < 0 || value > 499_999_999) throw new Error(`Mesh Blaze presale: invalid ${label}`);
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = (value >> (8 * i)) & 255;
  return `0x${binToHex(out)}`;
};

export interface PresaleTerms {
  tokenCategory: string;
  totalSaleTokens: bigint;
  minRaiseQuote: bigint;
  maxRaiseQuote: bigint;
  openHeight: number;
  closeHeight: number;
  creatorLockingBytecode: string;
  creatorScriptHash?: string;
  successDestinationLockingBytecode: string;
  successDestinationHash?: string;
}

export function encodePresaleState(stage: number, collectedQuote: bigint, tokensRemaining: bigint): string {
  const buf = new Uint8Array(17);
  buf[0] = stage & 255;
  for (let i = 0; i < 8; i++) {
    buf[1 + i] = Number((collectedQuote >> BigInt(8 * i)) & 255n);
    buf[9 + i] = Number((tokensRemaining >> BigInt(8 * i)) & 255n);
  }
  return binToHex(buf);
}

export function decodePresaleState(commitmentHex: string): { stage: number; collectedQuote: bigint; tokensRemaining: bigint } {
  const bytes = hexToBin(commitmentHex);
  if (bytes.length !== 17) throw new Error('Invalid presale state commitment length');
  let collectedQuote = 0n;
  let tokensRemaining = 0n;
  for (let i = 0; i < 8; i++) {
    collectedQuote |= BigInt(bytes[1 + i]!) << BigInt(8 * i);
    tokensRemaining |= BigInt(bytes[9 + i]!) << BigInt(8 * i);
  }
  return { stage: bytes[0]!, collectedQuote, tokensRemaining };
}

export function createPresaleContract(
  artifact: Artifact,
  terms: PresaleTerms,
  provider: NetworkProvider
): Contract {
  const categoryVm = binToHex(hexToBin(terms.tokenCategory).reverse());
  const creatorHash = terms.creatorScriptHash ?? binToHex(sha256.hash(hexToBin(terms.creatorLockingBytecode)));
  const successHash = terms.successDestinationHash ?? binToHex(sha256.hash(hexToBin(terms.successDestinationLockingBytecode)));

  const args = [
    `0x${categoryVm}`,
    hex8(terms.totalSaleTokens, 'totalSaleTokens'),
    hex8(terms.minRaiseQuote, 'minRaiseQuote'),
    hex8(terms.maxRaiseQuote, 'maxRaiseQuote'),
    hex4(terms.openHeight, 'openHeight'),
    hex4(terms.closeHeight, 'closeHeight'),
    `0x${creatorHash}`,
    `0x${successHash}`,
  ];
  return new Contract(artifact, args, { provider, contractType: 'p2sh32' });
}
