/**
 * MeshBinV4 constructor encoding (fixed-width, VM byte order), for the default
 * bin and its option variants (DECISIONS: separate small contracts, no flags).
 *
 *   tokenCat bytes32 · bidNum bidDen askNum askDen bytes8 · ownerCat bytes32
 *   · managerHash bytes32 · manageAfter bytes4 · [variant extras]
 *
 *   locked       no extras (no owner path)
 *   vesting      unlockHeight bytes4
 *   feeSchedule  fee0 bytes2 · h1 bytes4 · fee1 bytes2 · h2 bytes4 · fee2 bytes2
 *   sizeFee      baseFee bytes2 · slope bytes2 · refSize bytes8 · maxFee bytes2
 *
 * Categories are given in display order (64 hex) and reversed into the VM's
 * order. Integers are little-endian and positive. Every push has a fixed size,
 * so each variant's redeem script has a fixed-length parameter prefix
 * (pushes run last argument first): default 140 = manageAfter 5 + manager 33
 * + owner 33 + 4 × 9 + token 33; the extras add their pushes in front.
 */
import { Contract, type NetworkProvider } from 'cashscript';
import { binToHex, encodeCashAddress, hash256, hexToBin } from '@bitauth/libauth';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { catVm, le } from './harness.js';

export const BIN_MIN_SATS = 1000n;
export const NO_MANAGER = '00'.repeat(32);
export const VARIANTS = ['default', 'locked', 'vesting', 'feeSchedule', 'sizeFee'] as const;
export type BinVariant = (typeof VARIANTS)[number];

export const PREFIX_LENS: Record<BinVariant, number> = {
    default: 140, locked: 140, vesting: 145, feeSchedule: 159, sizeFee: 158,
};
export const PREFIX_LEN = PREFIX_LENS.default;

const ARTIFACT_FILES: Record<BinVariant, string> = {
    default: 'MeshBinV4.json', locked: 'variants/MeshBinV4Locked.json', vesting: 'variants/MeshBinV4Vesting.json',
    feeSchedule: 'variants/MeshBinV4FeeSchedule.json', sizeFee: 'variants/MeshBinV4SizeFee.json',
};
const ART_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts');
const cache: Partial<Record<BinVariant, any>> = {};
export function binArtifact(v: BinVariant = 'default'): any {
    return (cache[v] ??= JSON.parse(readFileSync(join(ART_DIR, ARTIFACT_FILES[v]), 'utf-8')));
}

export interface FeeSchedule { fee0: number; h1: number; fee1: number; h2: number; fee2: number }
export interface SizeFee { baseFee: number; slope: number; refSize: bigint; maxFee: number }

export interface BinV4Params {
    variant?: BinVariant;      // default: 'default'
    tokenCat: string;          // display order, 64 hex
    bidNum: bigint; bidDen: bigint;
    askNum: bigint; askDen: bigint;
    ownerCat: string;          // display order, 64 hex (position NFT category)
    managerHash?: string;      // 64 hex, P2SH32 script hash of the manager; zero = no manager
    manageAfter?: number;      // block height before which manage() is closed
    unlockHeight?: number;     // vesting
    fees?: FeeSchedule;        // feeSchedule
    sizeFee?: SizeFee;         // sizeFee
}

const is64 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const isHeight = (h: unknown) => Number.isInteger(h) && (h as number) >= 0 && (h as number) < 500_000_000;
const isBps = (f: unknown) => Number.isInteger(f) && (f as number) >= 0 && (f as number) < 10_000;

/** Rules a bin must meet to be fillable and safe to fund (the covenant enforces the price ones too). */
export function validateBinV4(p: BinV4Params): void {
    const fail = (m: string): never => { throw new Error(`invalid V4 bin: ${m}`); };
    const v = p.variant ?? 'default';
    if (!VARIANTS.includes(v)) fail(`unknown variant ${v}`);
    if (!is64(p.tokenCat)) fail('tokenCat must be 64 lowercase hex');
    if (!is64(p.ownerCat)) fail('ownerCat must be 64 lowercase hex');
    if (p.tokenCat === p.ownerCat) fail('ownerCat must differ from tokenCat');
    if (/^0{64}$/.test(p.tokenCat)) fail('tokenCat must be a token, not zero');
    if (p.managerHash !== undefined && !is64(p.managerHash)) fail('managerHash must be 64 lowercase hex');
    if (!isHeight(p.manageAfter ?? 0)) fail('manageAfter must be a block height (0..499,999,999)');
    for (const [k, x] of Object.entries({ bidNum: p.bidNum, bidDen: p.bidDen, askNum: p.askNum, askDen: p.askDen })) {
        if (typeof x !== 'bigint' || x <= 0n || x >= 1n << 63n) fail(`${k} must be 1..2^63-1`);
    }
    if (p.askNum * p.bidDen < p.bidNum * p.askDen) fail('ask must be ≥ bid');
    if (v === 'vesting' && !isHeight(p.unlockHeight)) fail('vesting needs unlockHeight, a block height');
    if (v === 'feeSchedule') {
        const f = p.fees ?? fail('feeSchedule needs fees');
        if (![f.fee0, f.fee1, f.fee2].every(isBps)) fail('fees must be 0..9999 bps');
        if (!(f.fee0 >= f.fee1 && f.fee1 >= f.fee2)) fail('fees must not rise over time (fee0 ≥ fee1 ≥ fee2)');
        if (!isHeight(f.h1) || !isHeight(f.h2) || f.h1 > f.h2) fail('h1 ≤ h2, both block heights');
    }
    if (v === 'sizeFee') {
        const s = p.sizeFee ?? fail('sizeFee needs sizeFee');
        if (!isBps(s.maxFee) || !isBps(s.baseFee) || s.baseFee > s.maxFee) fail('0 ≤ baseFee ≤ maxFee < 10000');
        if (!Number.isInteger(s.slope) || s.slope < 0 || s.slope >= 1 << 15) fail('slope must be 0..32767');
        if (typeof s.refSize !== 'bigint' || s.refSize <= 0n || s.refSize >= 1n << 63n) fail('refSize must be 1..2^63-1');
    }
    if (v !== 'vesting' && p.unlockHeight !== undefined) fail('unlockHeight is only for vesting');
    if (v !== 'feeSchedule' && p.fees !== undefined) fail('fees are only for feeSchedule');
    if (v !== 'sizeFee' && p.sizeFee !== undefined) fail('sizeFee is only for sizeFee');
}

export function binV4Args(p: BinV4Params): string[] {
    const v = p.variant ?? 'default';
    const args = [
        '0x' + catVm(p.tokenCat),
        '0x' + le(p.bidNum, 8), '0x' + le(p.bidDen, 8),
        '0x' + le(p.askNum, 8), '0x' + le(p.askDen, 8),
        '0x' + catVm(p.ownerCat),
        '0x' + (p.managerHash ?? NO_MANAGER),
        '0x' + le(p.manageAfter ?? 0, 4),
    ];
    if (v === 'vesting') args.push('0x' + le(p.unlockHeight!, 4));
    if (v === 'feeSchedule') {
        const f = p.fees!;
        args.push('0x' + le(f.fee0, 2), '0x' + le(f.h1, 4), '0x' + le(f.fee1, 2), '0x' + le(f.h2, 4), '0x' + le(f.fee2, 2));
    }
    if (v === 'sizeFee') {
        const s = p.sizeFee!;
        args.push('0x' + le(s.baseFee, 2), '0x' + le(s.slope, 2), '0x' + le(s.refSize, 8), '0x' + le(s.maxFee, 2));
    }
    return args;
}

/** The parameter prefix of the redeem script, built by hand (last argument first). */
export function binV4Prefix(p: BinV4Params): string {
    const push = (h: string) => (h.length / 2).toString(16).padStart(2, '0') + h;
    return binV4Args(p).map((x) => x.slice(2)).reverse().map(push).join('');
}

export function binV4Contract(artifact: any, p: BinV4Params, provider: NetworkProvider): Contract {
    return new Contract(artifact, binV4Args(p), { provider, contractType: 'p2sh32' });
}

/** Contract for any variant, artifact chosen from p.variant. */
export function binOf(p: BinV4Params, provider: NetworkProvider): Contract {
    return binV4Contract(binArtifact(p.variant ?? 'default'), p, provider);
}

/** Redeem script (P2SH) or the locking script itself (P2S). */
export function redeemBytes(c: Contract): Uint8Array {
    return hexToBin(c.bytecode);
}

const SAMPLE: BinV4Params = {
    tokenCat: 'aa'.repeat(32), ownerCat: 'bb'.repeat(32), bidNum: 1n, bidDen: 1n, askNum: 1n, askDen: 1n,
    unlockHeight: 1, fees: { fee0: 1, h1: 1, fee1: 1, h2: 1, fee2: 1 }, sizeFee: { baseFee: 1, slope: 1, refSize: 1n, maxFee: 1 },
};

/** Template body shared by every bin of a variant (redeem script after the parameter prefix). */
export function binV4Body(artifact: any, provider: NetworkProvider, variant: BinVariant = 'default'): string {
    const p = { ...SAMPLE, variant };
    return binToHex(redeemBytes(binV4Contract(artifact, p, provider))).slice(PREFIX_LENS[variant] * 2);
}

/** Redeem script rebuilt from params + body, without CashScript (as the server and manager do). */
export function binV4Redeem(p: BinV4Params, bodyHex: string): Uint8Array {
    return hexToBin(binV4Prefix(p) + bodyHex);
}

export function binV4ScriptHash(p: BinV4Params, bodyHex: string): Uint8Array {
    return hash256(binV4Redeem(p, bodyHex));
}

/** P2SH32 locking bytecode rebuilt from params + body. */
export function binV4Lock(p: BinV4Params, bodyHex: string): Uint8Array {
    return Uint8Array.from([0xaa, 0x20, ...binV4ScriptHash(p, bodyHex), 0x87]);
}

export function binV4Addresses(p: BinV4Params, bodyHex: string) {
    const payload = binV4ScriptHash(p, bodyHex);
    const a = (prefix: 'bchtest' | 'bitcoincash', type: 'p2sh' | 'p2shWithTokens') => encodeCashAddress({ prefix, type, payload }).address;
    return {
        chipnet: { address: a('bchtest', 'p2sh'), tokenAddress: a('bchtest', 'p2shWithTokens') },
        mainnet: { address: a('bitcoincash', 'p2sh'), tokenAddress: a('bitcoincash', 'p2shWithTokens') },
    };
}
