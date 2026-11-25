import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract, type Artifact, type NetworkProvider } from 'cashscript';

const MAX_VM = (1n << 63n) - 1n;

const hex8 = (value: bigint, label: string): string => {
  if (value <= 0n || value > MAX_VM) throw new Error(`Mesh Blaze vesting: ${label} outside valid range`);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((value >> BigInt(8 * i)) & 255n);
  return `0x${binToHex(out)}`;
};

const hex4 = (value: number, label: string): string => {
  if (!Number.isInteger(value) || value < 0 || value > 499_999_999) throw new Error(`Mesh Blaze vesting: invalid ${label}`);
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = (value >> (8 * i)) & 255;
  return `0x${binToHex(out)}`;
};

export interface VestingTrancheTerms {
  tokenCategory: string;
  recipientLockingBytecode: string;
  recipientScriptHash?: string;
  tokenAmount: bigint;
  unlockHeight: number;
}

export function createVestingContract(
  artifact: Artifact,
  terms: VestingTrancheTerms,
  provider: NetworkProvider
): Contract {
  const categoryVm = binToHex(hexToBin(terms.tokenCategory).reverse());
  const recipientHash = terms.recipientScriptHash ?? binToHex(sha256.hash(hexToBin(terms.recipientLockingBytecode)));
  const args = [
    `0x${categoryVm}`,
    `0x${recipientHash}`,
    hex8(terms.tokenAmount, 'tokenAmount'),
    hex4(terms.unlockHeight, 'unlockHeight'),
  ];
  return new Contract(artifact, args, { provider, contractType: 'p2sh32' });
}
