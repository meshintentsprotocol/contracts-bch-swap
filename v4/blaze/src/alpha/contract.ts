import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract, type Artifact, type NetworkProvider } from 'cashscript';

const MAX_VM = (1n << 63n) - 1n;

const hex8 = (value: bigint, label: string): string => {
  if (value < 0n || value > MAX_VM) throw new Error(`Mesh Blaze Alpha: ${label} outside valid range`);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((value >> BigInt(8 * i)) & 255n);
  return `0x${binToHex(out)}`;
};

const hex4 = (value: number, label: string): string => {
  if (!Number.isInteger(value) || value < 0 || value > 499_999_999) throw new Error(`Mesh Blaze Alpha: invalid ${label}`);
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = (value >> (8 * i)) & 255;
  return `0x${binToHex(out)}`;
};

export interface AlphaFixedTerms {
  tokenCategory: string;
  totalSaleTokens: bigint;
  quotePricePerToken: bigint;
  maxRaiseQuote: bigint;
  alphaStartHeight: number;
  alphaEndHeight: number;
  creatorLockingBytecode: string;
  creatorScriptHash?: string;
}

export function encodeAlphaFixedState(stage: number, collectedQuote: bigint, tokensRemaining: bigint): string {
  const buf = new Uint8Array(17);
  buf[0] = stage & 255;
  for (let i = 0; i < 8; i++) {
    buf[1 + i] = Number((collectedQuote >> BigInt(8 * i)) & 255n);
    buf[9 + i] = Number((tokensRemaining >> BigInt(8 * i)) & 255n);
  }
  return binToHex(buf);
}

export function createAlphaFixedContract(
  artifact: Artifact,
  terms: AlphaFixedTerms,
  provider: NetworkProvider
): Contract {
  const categoryVm = binToHex(hexToBin(terms.tokenCategory).reverse());
  const creatorHash = terms.creatorScriptHash ?? binToHex(sha256.hash(hexToBin(terms.creatorLockingBytecode)));
  const args = [
    `0x${categoryVm}`,
    hex8(terms.totalSaleTokens, 'totalSaleTokens'),
    hex8(terms.quotePricePerToken, 'quotePricePerToken'),
    hex8(terms.maxRaiseQuote, 'maxRaiseQuote'),
    hex4(terms.alphaStartHeight, 'alphaStartHeight'),
    hex4(terms.alphaEndHeight, 'alphaEndHeight'),
    `0x${creatorHash}`,
  ];
  return new Contract(artifact, args, { provider, contractType: 'p2sh32' });
}

export interface AlphaBuyTerms {
  tokenCategory: string;
  curveScriptHash: string;
  maxGrossQuote: bigint;
  minTokenOutput: bigint;
  alphaStartHeight: number;
  alphaEndHeight: number;
  expiryHeight: number;
}

export function encodeAlphaBuyState(
  stage: number,
  totalDeposited: bigint,
  totalTokensBought: bigint,
  unusedQuoteRefund: bigint
): string {
  const buf = new Uint8Array(25);
  buf[0] = stage & 255;
  for (let i = 0; i < 8; i++) {
    buf[1 + i] = Number((totalDeposited >> BigInt(8 * i)) & 255n);
    buf[9 + i] = Number((totalTokensBought >> BigInt(8 * i)) & 255n);
    buf[17 + i] = Number((unusedQuoteRefund >> BigInt(8 * i)) & 255n);
  }
  return binToHex(buf);
}

export function createAlphaBuyContract(
  artifact: Artifact,
  terms: AlphaBuyTerms,
  provider: NetworkProvider
): Contract {
  const categoryVm = binToHex(hexToBin(terms.tokenCategory).reverse());
  const args = [
    `0x${categoryVm}`,
    `0x${terms.curveScriptHash}`,
    hex8(terms.maxGrossQuote, 'maxGrossQuote'),
    hex8(terms.minTokenOutput, 'minTokenOutput'),
    hex4(terms.alphaStartHeight, 'alphaStartHeight'),
    hex4(terms.alphaEndHeight, 'alphaEndHeight'),
    hex4(terms.expiryHeight, 'expiryHeight'),
  ];
  return new Contract(artifact, args, { provider, contractType: 'p2sh32' });
}
