/**
 * MeshBinV4 constructor encoding (fixed-width, VM byte order).
 *
 *   tokenCat bytes32 · bidNum bidDen askNum askDen bytes8 · ownerCat bytes32
 *   · managerHash bytes32 · cooldown bytes2
 *
 * Categories are given in display order (64 hex) and reversed into the VM's
 * order. Integers are little-endian, positive, below 2^63 (bytes8) or 2^15
 * (bytes2). Every push has a fixed size, so the redeem script's parameter
 * prefix is always PREFIX_LEN bytes:
 *   cooldown 3 + manager 33 + owner 33 + 4 × 9 + token 33 = 138.
 */
import { Contract, type NetworkProvider } from 'cashscript';
import { binToHex, hash256, hexToBin } from '@bitauth/libauth';
import { catVm, le } from './harness.js';

export const PREFIX_LEN = 138;
export const BIN_MIN_SATS = 1000n;

export interface BinV4Params {
    tokenCat: string;          // display order, 64 hex
    bidNum: bigint; bidDen: bigint;
    askNum: bigint; askDen: bigint;
    ownerCat: string;          // display order, 64 hex (position NFT category)
    managerHash?: string;      // 64 hex, P2SH32 script hash; zero = no manager
    cooldown?: number;         // blocks, 0..32767
}

const is64 = (s: string) => /^[0-9a-f]{64}$/.test(s);

/** Rules a bin must meet to be fillable and safe to fund (mirrors the covenant's own checks). */
export function validateBinV4(p: BinV4Params): void {
    const fail = (m: string) => { throw new Error(`invalid V4 bin: ${m}`); };
    if (!is64(p.tokenCat)) fail('tokenCat must be 64 hex');
    if (!is64(p.ownerCat)) fail('ownerCat must be 64 hex');
    if (p.tokenCat === p.ownerCat) fail('ownerCat must differ from tokenCat');
    if (p.managerHash !== undefined && !is64(p.managerHash)) fail('managerHash must be 64 hex');
    const cd = p.cooldown ?? 0;
    if (!Number.isInteger(cd) || cd < 0 || cd > 0x7fff) fail('cooldown must be 0..32767');
    for (const [k, v] of Object.entries({ bidNum: p.bidNum, bidDen: p.bidDen, askNum: p.askNum, askDen: p.askDen })) {
        if (v <= 0n || v >= 1n << 63n) fail(`${k} must be 1..2^63-1`);
    }
    if (p.askNum * p.bidDen < p.bidNum * p.askDen) fail('ask must be ≥ bid');
}

export function binV4Args(p: BinV4Params): string[] {
    return [
        '0x' + catVm(p.tokenCat),
        '0x' + le(p.bidNum, 8), '0x' + le(p.bidDen, 8),
        '0x' + le(p.askNum, 8), '0x' + le(p.askDen, 8),
        '0x' + catVm(p.ownerCat),
        '0x' + (p.managerHash ?? '00'.repeat(32)),
        '0x' + le(p.cooldown ?? 0, 2),
    ];
}

/** The parameter prefix of the redeem script, built by hand (last argument first). */
export function binV4Prefix(p: BinV4Params): string {
    const a = binV4Args(p).map((x) => x.slice(2));
    const push = (h: string) => (h.length / 2).toString(16).padStart(2, '0') + h;
    return a.slice().reverse().map(push).join('');
}

export function binV4Contract(artifact: any, p: BinV4Params, provider: NetworkProvider, contractType: 'p2sh32' | 'p2s' = 'p2sh32'): Contract {
    return new Contract(artifact, binV4Args(p), { provider, contractType });
}

/** Template body shared by every bin (redeem script after the parameter prefix). */
export function binV4Body(artifact: any, provider: NetworkProvider): string {
    const any: BinV4Params = { tokenCat: 'aa'.repeat(32), ownerCat: 'bb'.repeat(32), bidNum: 1n, bidDen: 1n, askNum: 1n, askDen: 1n };
    return binToHex(redeemBytes(binV4Contract(artifact, any, provider))).slice(PREFIX_LEN * 2);
}

/** P2SH32 locking bytecode rebuilt from params + body, as the manager will. */
export function binV4Lock(p: BinV4Params, bodyHex: string): Uint8Array {
    const h = hash256(hexToBin(binV4Prefix(p) + bodyHex));
    return Uint8Array.from([0xaa, 0x20, ...h, 0x87]);
}

/** Redeem script (P2SH) or the locking script itself (P2S). */
export function redeemBytes(c: Contract): Uint8Array {
    return hexToBin(c.bytecode);
}
