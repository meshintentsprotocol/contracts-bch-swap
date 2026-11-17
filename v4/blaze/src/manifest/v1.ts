import { binToHex, hexToBin, sha256, utf8ToBin } from '@bitauth/libauth';
import type { Allocation, GenesisPlan } from '../genesis/plan.js';

const MAX_U64 = (1n << 64n) - 1n;
const MAX_VM = (1n << 63n) - 1n;
const ZERO_HASH = '00'.repeat(32);
const HASH = /^[0-9a-f]{64}$/;
const NAME = /^[a-z][a-z0-9_]{0,31}$/;

export interface FeeRights {
  creator: { scriptHash: string; bps: number };
  partner: { scriptHash: string; bps: number };
  protocol: { scriptHash: string; bps: number };
}

export interface LaunchManifestV1 {
  version: 1;
  tokenCategory: string;
  quoteCategory: string | null;
  totalSupply: bigint;
  allocations: readonly Allocation[];
  activationHeight: number;
  alphaStartHeight: number;
  alphaEndHeight: number;
  presaleRoute: 'standalone' | 'dbc' | 'market' | null;
  presaleScriptHash: string;
  /** Bit 0: fixed-price allocation; bit 1: bounded curve-buy vault. */
  alphaModes: number;
  alphaFixedScriptHash: string;
  alphaBuyScriptHash: string;
  virtualBase: bigint;
  virtualQuote: bigint;
  graduationQuoteThreshold: bigint;
  lockedLiquidityBps: number;
  curveScriptHash: string;
  /** Zero for BCH; SHA-256 of the separate paired quote-vault locking bytecode for CashToken quotes. */
  quoteVaultScriptHash: string;
  /** Zero for BCH; independent BCH carrier held by the paired quote vault. */
  quoteVaultCarrierSats: bigint;
  graduationScriptHash: string;
  marketScriptHash: string;
  curveFees: FeeRights;
  marketFees: FeeRights;
}

/** Conservative lifetime bounds for either quote kind's largest curve products. */
export function validateCurveArithmeticV1(m: LaunchManifestV1): void {
  const supply = m.totalSupply;
  const vb = m.virtualBase;
  const vq = m.virtualQuote;
  const threshold = m.graduationQuoteThreshold;
  const feeBps = m.curveFees.creator.bps + m.curveFees.partner.bps + m.curveFees.protocol.bps;
  if ([supply, vb, vq, threshold].some((x) => x <= 0n || x > MAX_VM) || feeBps <= 0 || feeBps >= 10_000)
    invalid('curve invalid arithmetic domain');
  if ((supply + vb) * threshold > MAX_VM)
    invalid('curve buy reserve product exceeds VM range');
  if ((threshold + vq) * supply > MAX_VM)
    invalid('curve sell reserve product exceeds VM range');
  const denominator = BigInt(10_000 - feeBps);
  const maxTerminalGross = (threshold * 10_000n + denominator - 1n) / denominator;
  if (maxTerminalGross > MAX_VM || maxTerminalGross * BigInt(feeBps) > MAX_VM)
    invalid('curve fee product exceeds VM range');
  if (threshold + vq > MAX_VM || supply + vb > MAX_VM)
    invalid('curve effective reserve exceeds VM range');
}
export const validateBchCurveArithmeticV1 = validateCurveArithmeticV1;

function invalid(message: string): never { throw new Error(`Mesh Blaze manifest v1: ${message}`); }
function hash32(value: string, label: string): Uint8Array {
  if (!HASH.test(value)) invalid(`${label} must be 32-byte lowercase hex`);
  return hexToBin(value);
}
function u16(value: number, label: string): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) invalid(`${label} must be uint16`);
  return Uint8Array.of(value & 255, (value >> 8) & 255);
}
function u32(value: number, label: string): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) invalid(`${label} must be uint32`);
  return Uint8Array.of(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255);
}
function u64(value: bigint, label: string): Uint8Array {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_U64) invalid(`${label} must be uint64`);
  const bytes = new Uint8Array(8);
  for (let i = 0; i < 8; i++) bytes[i] = Number((value >> BigInt(i * 8)) & 255n);
  return bytes;
}
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
function feeBytes(rights: FeeRights, label: string): Uint8Array[] {
  const recipients = [rights.creator, rights.partner, rights.protocol];
  let total = 0;
  const chunks: Uint8Array[] = [];
  for (const [index, recipient] of recipients.entries()) {
    if (!Number.isInteger(recipient.bps) || recipient.bps < 0 || recipient.bps > 10_000) invalid(`${label} recipient ${index} bps out of range`);
    if (recipient.bps && recipient.scriptHash === ZERO_HASH) invalid(`${label} active recipient ${index} has zero script hash`);
    total += recipient.bps;
    chunks.push(hash32(recipient.scriptHash, `${label} recipient ${index}`), u16(recipient.bps, `${label} bps`));
  }
  if (total > 10_000) invalid(`${label} total bps exceed 10000`);
  return chunks;
}

/** Stable byte format: fixed header, then allocation count and name-sorted allocations. */
export function encodeLaunchManifestV1(m: LaunchManifestV1): Uint8Array {
  if (m.version !== 1) invalid('version must be 1');
  validateCurveArithmeticV1(m);
  if (m.quoteCategory === m.tokenCategory) invalid('quote and launch categories must differ');
  if (m.quoteCategory === ZERO_HASH) invalid('zero quote category is reserved for BCH');
  if (m.quoteCategory === null ? (m.quoteVaultScriptHash !== ZERO_HASH || m.quoteVaultCarrierSats !== 0n) :
      (m.quoteVaultScriptHash === ZERO_HASH || m.quoteVaultCarrierSats < 1_000n))
    invalid('quote vault commitment and carrier must match quote kind');
  if (m.totalSupply <= 0n || m.totalSupply > (1n << 63n) - 1n) invalid('total supply outside CashToken range');
  if (m.virtualBase <= 0n || m.virtualQuote <= 0n || m.graduationQuoteThreshold <= 0n) invalid('curve reserves and threshold must be positive');
  if (!Number.isInteger(m.lockedLiquidityBps) || m.lockedLiquidityBps < 9_000 || m.lockedLiquidityBps > 10_000) invalid('locked liquidity must be 90..100 percent');
  if (m.activationHeight > 499_999_999 || m.alphaStartHeight > 499_999_999 || m.alphaEndHeight > 499_999_999) invalid('height exceeds BCH block-height locktime range');
  if (!Number.isInteger(m.alphaModes) || m.alphaModes < 0 || m.alphaModes > 3) invalid('Alpha modes must be a two-bit mask');
  if (m.alphaModes === 0 ? (m.alphaStartHeight !== 0 || m.alphaEndHeight !== 0) : (m.alphaStartHeight <= 0 || m.alphaEndHeight < m.alphaStartHeight || m.alphaEndHeight >= m.activationHeight)) invalid('invalid Alpha window');
  const presaleRoute = m.presaleRoute === null ? 0 : m.presaleRoute === 'standalone' ? 1 : m.presaleRoute === 'dbc' ? 2 : m.presaleRoute === 'market' ? 3 : invalid('unknown presale route');
  if ((presaleRoute === 0) !== (m.presaleScriptHash === ZERO_HASH)) invalid('presale script must match enabled route');
  if (Boolean(m.alphaModes & 1) !== (m.alphaFixedScriptHash !== ZERO_HASH)) invalid('Alpha fixed script must match mode');
  if (Boolean(m.alphaModes & 2) !== (m.alphaBuyScriptHash !== ZERO_HASH)) invalid('Alpha buy script must match mode');
  if (m.allocations.length < 1 || m.allocations.length > 32) invalid('allocation count must be 1..32');
  const sorted = [...m.allocations].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  let sum = 0n;
  const chunks: Uint8Array[] = [
    utf8ToBin('MBLZ'), Uint8Array.of(1),
    hash32(m.tokenCategory, 'token category'),
    Uint8Array.of(m.quoteCategory === null ? 0 : 1),
    hash32(m.quoteCategory ?? ZERO_HASH, 'quote category'),
    u64(m.totalSupply, 'total supply'),
    u32(m.activationHeight, 'activation height'),
    u32(m.alphaStartHeight, 'Alpha start'),
    u32(m.alphaEndHeight, 'Alpha end'),
    Uint8Array.of(presaleRoute),
    hash32(m.presaleScriptHash, 'presale script'),
    Uint8Array.of(m.alphaModes),
    hash32(m.alphaFixedScriptHash, 'Alpha fixed script'),
    hash32(m.alphaBuyScriptHash, 'Alpha buy script'),
    u64(m.virtualBase, 'virtual base'),
    u64(m.virtualQuote, 'virtual quote'),
    u64(m.graduationQuoteThreshold, 'graduation threshold'),
    u16(m.lockedLiquidityBps, 'lock bps'),
    hash32(m.curveScriptHash, 'curve script'),
    hash32(m.quoteVaultScriptHash, 'quote vault script'),
    u64(m.quoteVaultCarrierSats, 'quote vault carrier'),
    hash32(m.graduationScriptHash, 'graduation script'),
    hash32(m.marketScriptHash, 'market script'),
    ...feeBytes(m.curveFees, 'curve fees'),
    ...feeBytes(m.marketFees, 'market fees'),
    Uint8Array.of(sorted.length),
  ];
  let previous = '';
  for (const a of sorted) {
    if (!NAME.test(a.name) || a.name === previous) invalid('allocation names must be unique lowercase ASCII identifiers');
    previous = a.name;
    if (a.amount <= 0n || a.satoshis < 1_000n || !/^(?:[0-9a-f]{2})+$/.test(a.lockingBytecode)) invalid(`invalid allocation ${a.name}`);
    if (a.nftCommitment !== undefined && (a.name !== 'curve' || !/^(?:[0-9a-f]{2}){1,128}$/.test(a.nftCommitment))) invalid(`invalid state NFT on ${a.name}`);
    sum += a.amount;
    const name = utf8ToBin(a.name);
    const commitment = a.nftCommitment === undefined ? new Uint8Array() : hexToBin(a.nftCommitment);
    chunks.push(Uint8Array.of(name.length), name, u64(a.amount, `${a.name} amount`), u64(a.satoshis, `${a.name} sats`), sha256.hash(hexToBin(a.lockingBytecode)), Uint8Array.of(commitment.length), commitment);
  }
  if (sum !== m.totalSupply) invalid('allocation sum differs from total supply');
  return concat(chunks);
}

export function launchManifestHashV1(m: LaunchManifestV1): string {
  return binToHex(sha256.hash(encodeLaunchManifestV1(m)));
}

/** Independently compare the genesis outputs to the manifest's economic allocation. */
export function verifyGenesisAgainstManifestV1(genesis: GenesisPlan, m: LaunchManifestV1): void {
  if (genesis.category !== m.tokenCategory) invalid('genesis category differs from manifest');
  const hash = launchManifestHashV1(m);
  if (genesis.manifestHash !== hash) invalid('genesis plan manifest hash differs');
  const publication = `6a044d424c5a20${hash}`;
  if (genesis.transaction.outputs.filter((o) => binToHex(o.lockingBytecode) === publication).length !== 1) invalid('genesis must publish one exact manifest hash');
  if (Object.keys(genesis.allocationIndexes).length !== m.allocations.length) invalid('genesis allocation count differs from manifest');
  let total = 0n;
  for (const a of m.allocations) {
    const index = genesis.allocationIndexes[a.name];
    if (index === undefined) invalid(`missing genesis allocation ${a.name}`);
    const out = genesis.transaction.outputs[index];
    if (!out?.token || binToHex(out.token.category) !== m.tokenCategory || out.token.amount !== a.amount || out.valueSatoshis !== a.satoshis || binToHex(out.lockingBytecode) !== a.lockingBytecode) invalid(`genesis allocation ${a.name} differs from manifest`);
    if (out.token.nft ? (a.name !== 'curve' || out.token.nft.capability !== 'mutable' || binToHex(out.token.nft.commitment) !== a.nftCommitment) : a.nftCommitment !== undefined) invalid(`genesis state NFT ${a.name} differs from manifest`);
    total += a.amount;
  }
  if (total !== m.totalSupply) invalid('genesis supply differs from manifest');
}
