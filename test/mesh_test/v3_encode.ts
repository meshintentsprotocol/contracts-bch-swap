/**
 * MeshPoolV3 constructor encoding (fixed-width, VM byte order).
 *
 *   ownerPkh bytes20 · reserveCat bytes32 · 3 × (cat bytes32, num, den, rNum, rDen bytes8)
 *   · feeBps bytes2 · proceedsMode bytes2 · proceedsHash bytes32
 *
 * Categories are given in display order (64 hex) or 'BCH' and reversed into
 * the VM's order; BCH is 32 zero bytes. Integers are little-endian, positive,
 * below 2^63. An unused slot repeats the reserve category with zero prices.
 */
import { Contract, type NetworkProvider } from 'cashscript';
import { binToHex, cashAddressToLockingBytecode, hash256 } from '@bitauth/libauth';
import { scriptToBytecode } from '@cashscript/utils';

export const BCH = 'BCH';
export const PREFIX_LEN = 300;

export interface V3Slot { cat: string; num: bigint; den: bigint; rNum?: bigint; rDen?: bigint }
export interface V3Params {
    ownerPkh: Uint8Array | string;
    reserve: string;
    slots: V3Slot[];            // 1..3
    feeBps: number;
    mode: 0 | 1 | 2;
    proceedsHash?: string;      // 64 hex, mode 1
}

const hex = (b: Uint8Array | string) => (typeof b === 'string' ? b.replace(/^0x/, '') : binToHex(b));
export const catVm = (c: string) => (c === BCH ? '00'.repeat(32) : c.match(/.{2}/g)!.reverse().join(''));

export function le(v: bigint | number, bytes: number): string {
    let x = BigInt(v);
    if (x < 0n || x >= 1n << BigInt(bytes * 8 - 1)) throw new Error(`value ${v} does not fit ${bytes} signed bytes`);
    let out = '';
    for (let i = 0; i < bytes; i++) { out += (x & 0xffn).toString(16).padStart(2, '0'); x >>= 8n; }
    return out;
}

/**
 * Rules a pool must meet to be fillable and safe to fund. The covenant only
 * enforces some of them at fill time; a pool that breaks the others would lock
 * the LP's funds until dock() (e.g. a mode-2 slot without a reverse price).
 */
export function validateV3(p: V3Params): void {
    const fail = (m: string) => { throw new Error(`invalid V3 pool: ${m}`); };
    const isCat = (c: string) => c === BCH || /^[0-9a-f]{64}$/.test(c);
    if (!/^[0-9a-f]{40}$/.test(hex(p.ownerPkh))) fail('ownerPkh must be 20 bytes');
    if (!isCat(p.reserve)) fail('reserve must be BCH or a 64-hex category');
    if (p.slots.length < 1 || p.slots.length > 3) fail('1..3 slots');
    if (!Number.isInteger(p.feeBps) || p.feeBps < 0 || p.feeBps >= 10000) fail('feeBps must be 0..9999');
    const seen = new Set<string>();
    p.slots.forEach((s, k) => {
        if (!isCat(s.cat)) fail(`slot ${k}: category must be BCH or 64-hex`);
        if (s.cat === p.reserve) fail(`slot ${k}: accepts the reserve asset`);
        if (seen.has(s.cat)) fail(`slot ${k}: duplicate category`);
        seen.add(s.cat);
        if (s.num <= 0n || s.den <= 0n) fail(`slot ${k}: num and den must be > 0`);
        if (p.mode === 2 && ((s.rNum ?? 0n) <= 0n || (s.rDen ?? 0n) <= 0n)) fail(`slot ${k}: mirror mode needs rNum and rDen > 0`);
    });
    if (p.mode === 1 && !/^[0-9a-f]{64}$/.test(p.proceedsHash ?? '')) fail('mode 1 needs a 32-byte proceedsHash');
    if (p.mode !== 1 && p.proceedsHash && !/^0{64}$/.test(p.proceedsHash)) fail('proceedsHash is only used in mode 1');
}

export function v3Args(p: V3Params): string[] {
    if (p.slots.length < 1 || p.slots.length > 3) throw new Error('1..3 slots');
    const args = ['0x' + hex(p.ownerPkh), '0x' + catVm(p.reserve)];
    for (let k = 0; k < 3; k++) {
        const s = p.slots[k];
        if (s) args.push('0x' + catVm(s.cat), '0x' + le(s.num, 8), '0x' + le(s.den, 8), '0x' + le(s.rNum ?? 0n, 8), '0x' + le(s.rDen ?? 0n, 8));
        else args.push('0x' + catVm(p.reserve), '0x' + le(0, 8), '0x' + le(0, 8), '0x' + le(0, 8), '0x' + le(0, 8));
    }
    args.push('0x' + le(p.feeBps, 2), '0x' + le(p.mode, 2), '0x' + (p.proceedsHash ?? '00'.repeat(32)));
    return args;
}

export function v3Contract(artifact: any, p: V3Params, provider: NetworkProvider): Contract {
    return new Contract(artifact, v3Args(p), { provider });
}

/** The reverse pool that mirror mode (2) derives for slot k. */
export function mirrorOf(p: V3Params, k = 0): V3Params {
    const s = p.slots[k]!;
    return {
        ownerPkh: p.ownerPkh, reserve: s.cat, feeBps: p.feeBps, mode: 2,
        slots: [{ cat: p.reserve, num: s.rNum ?? 0n, den: s.rDen ?? 0n, rNum: s.num, rDen: s.den }],
    };
}

/** 32-byte script hash of a P2SH32 address (for mode 1's proceedsHash). */
export function p2sh32Hash(address: string): string {
    const r = cashAddressToLockingBytecode(address);
    if (typeof r === 'string') throw new Error(r);
    return binToHex(r.bytecode.slice(2, 34));
}

/** Redeem-script bytes of a contract (to check the constant 300-byte prefix). */
export function redeemBytes(c: Contract): Uint8Array {
    return scriptToBytecode((c as any).redeemScript);
}

export const scriptHash = (b: Uint8Array) => binToHex(hash256(b));
