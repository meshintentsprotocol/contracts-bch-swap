import { binToHex, hexToBin } from '@bitauth/libauth';

export const STATE_V1_BYTES = 34;
const MAX = (1n << 63n) - 1n;

export interface CurveStateV1 {
  stage: 0 | 1; // 0 trading, 1 complete
  realQuote: bigint;
  creatorFees: bigint;
  partnerFees: bigint;
  protocolFees: bigint;
}

const invalid = (reason: string): never => { throw new Error(`Mesh Blaze curve state: ${reason}`); };
const u64 = (value: bigint, label: string) => {
  if (typeof value !== 'bigint' || value < 0n || value > MAX) invalid(`${label} outside signed VM range`);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((value >> BigInt(i * 8)) & 255n);
  return out;
};
const readU64 = (bytes: Uint8Array, offset: number) => {
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) + BigInt(bytes[offset + i]!);
  if (value > MAX) invalid('counter outside signed VM range');
  return value;
};

export function encodeCurveStateV1(state: CurveStateV1): string {
  if (state.stage !== 0 && state.stage !== 1) invalid('unknown stage');
  const bytes = new Uint8Array(STATE_V1_BYTES);
  bytes[0] = 1;
  bytes[1] = state.stage;
  bytes.set(u64(state.realQuote, 'real quote'), 2);
  bytes.set(u64(state.creatorFees, 'creator fees'), 10);
  bytes.set(u64(state.partnerFees, 'partner fees'), 18);
  bytes.set(u64(state.protocolFees, 'protocol fees'), 26);
  return binToHex(bytes);
}

export function decodeCurveStateV1(hex: string): CurveStateV1 {
  if (!/^(?:[0-9a-f]{2}){34}$/.test(hex)) invalid('commitment must be 34 lowercase bytes');
  const bytes = hexToBin(hex);
  if (bytes[0] !== 1 || (bytes[1] !== 0 && bytes[1] !== 1)) invalid('unsupported version or stage');
  return {
    stage: bytes[1] as 0 | 1,
    realQuote: readU64(bytes, 2),
    creatorFees: readU64(bytes, 10),
    partnerFees: readU64(bytes, 18),
    protocolFees: readU64(bytes, 26),
  };
}

/** BCH quote state UTXO carries carrier sats plus real reserve plus claimable fees. */
export function requiredBchSatoshis(state: CurveStateV1, carrier: bigint): bigint {
  if (carrier < 1_000n) invalid('carrier below 1000 sats');
  return carrier + state.realQuote + state.creatorFees + state.partnerFees + state.protocolFees;
}
