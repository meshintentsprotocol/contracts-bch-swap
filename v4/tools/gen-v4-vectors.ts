/**
 * MeshBinV4 parity vectors for the meshserver and frontend encoders.
 *
 * For each case: params, constructor args (hex), redeem script, parameter
 * prefix, script hash, P2SH32 locking bytecode, chipnet and mainnet
 * addresses. Every variant's artifact is pinned by the sha256 of its
 * bytecode and its body hex, so a drifted artifact copy fails the parity test.
 * A second list holds params the encoder must reject.
 *
 * Usage: npx tsx tools/gen-v4-vectors.ts   (after npm run build)
 */
import { MockNetworkProvider } from 'cashscript';
import { binToHex, sha256, utf8ToBin } from '@bitauth/libauth';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    PREFIX_LENS, VARIANTS, binArtifact, binOf, binV4Addresses, binV4Args, binV4Body, binV4Prefix, binV4ScriptHash,
    redeemBytes, validateBinV4, type BinV4Params,
} from '../test/v4_encode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', 'vectors', 'meshBinV4.vectors.json');
const net = new MockNetworkProvider();

const PUSD = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
const MUSD = 'b4863d5773c7a269b6fe3b9f7ce2ce1098ab71c0b046ef2a39058d5e30b1f353';
const POS = '5a1e7c0ffee0b1a5d00d0000c0ffee5a1e7c0ffee0b1a5d00d0000c0ffee5a1e';
const MGR = 'cd'.repeat(32);

export function describe(p: BinV4Params) {
    validateBinV4(p);
    const c = binOf(p, net);
    const redeem = redeemBytes(c);
    const v = p.variant ?? 'default';
    const body = binV4Body(binArtifact(v), net, v);
    const prefix = binV4Prefix(p);
    if (binToHex(redeem) !== prefix + body) throw new Error('hand-built prefix ‖ body differs from CashScript');
    const hash = binToHex(binV4ScriptHash(p, body));
    if (c.lockingBytecode !== `aa20${hash}87`) throw new Error('locking bytecode differs');
    const addrs = binV4Addresses(p, body);
    const net0 = c.address.startsWith('bchtest:') ? addrs.chipnet : addrs.mainnet;
    if (c.address !== net0.address || c.tokenAddress !== net0.tokenAddress) throw new Error('cashscript and libauth addresses differ');
    // Unlocking bytecode CashScript itself builds for each path (no signatures, so any transaction will do):
    // the server builds these by hand and must match byte for byte.
    const ctx = { transaction: { version: 2, locktime: 0, inputs: [], outputs: [] } as any, sourceOutputs: [], inputIndex: 0 };
    const u = (c as any).unlock;
    const unlocking: Record<string, string> = {
        fill: binToHex((v === 'feeSchedule' ? u.fill(1n) : u.fill()).generateUnlockingBytecode(ctx)),
        manage: binToHex(u.manage().generateUnlockingBytecode(ctx)),
    };
    if (v === 'feeSchedule') unlocking.fillTier0 = binToHex(u.fill(0n).generateUnlockingBytecode(ctx));
    if (v !== 'locked') {
        unlocking.owner1 = binToHex(u.owner(1n).generateUnlockingBytecode(ctx));
        unlocking.owner17 = binToHex(u.owner(17n).generateUnlockingBytecode(ctx));
    }
    return {
        args: binV4Args(p).map((a) => a.slice(2)),
        redeemScriptHex: binToHex(redeem),
        prefixHex: prefix,
        scriptHash: hash,
        lockingBytecodeHex: `aa20${hash}87`,
        ...addrs,
        unlocking,
    };
}

/** JSON-friendly params: bigints as decimal strings. */
export const plain = (p: BinV4Params) => JSON.parse(JSON.stringify(p, (_k, x) => (typeof x === 'bigint' ? String(x) : x)));

const base = (over: Partial<BinV4Params> = {}): BinV4Params => ({
    tokenCat: PUSD, ownerCat: POS, bidNum: 1990n, bidDen: 1n, askNum: 2000n, askDen: 1n, managerHash: MGR, manageAfter: 0, ...over,
});

export const CASES: Array<[string, BinV4Params]> = [
    ['default-pusd-2000', base()],
    ['default-no-manager', base({ managerHash: undefined })],
    ['default-fractional-prices', base({ bidNum: 4464141736717019406n, bidDen: 2251799813685248n, askNum: 4508783154084189600n, askDen: 2251799813685248n })],
    ['default-tiny-price', base({ tokenCat: MUSD, bidNum: 1n, bidDen: 4611686018427387903n, askNum: 3n, askDen: 4611686018427387903n })],
    ['default-max-fields', base({ bidNum: (1n << 63n) - 2n, bidDen: 1n, askNum: (1n << 63n) - 1n, askDen: 1n, manageAfter: 499_999_999 })],
    ['default-bid-equals-ask', base({ bidNum: 2000n, askNum: 2000n })],
    ['locked', base({ variant: 'locked' })],
    ['vesting', base({ variant: 'vesting', unlockHeight: 950_000 })],
    ['fee-schedule', base({ variant: 'feeSchedule', fees: { fee0: 500, h1: 900_100, fee1: 100, h2: 901_000, fee2: 30 } })],
    ['size-fee', base({ variant: 'sizeFee', sizeFee: { baseFee: 10, slope: 50, refSize: 1_000n, maxFee: 300 } })],
];

export const INVALID: Array<[string, BinV4Params]> = [
    ['ask below bid', base({ bidNum: 2001n })],
    ['zero bid numerator', base({ bidNum: 0n })],
    ['zero ask denominator', base({ askDen: 0n })],
    ['price at 2^63', base({ askNum: 1n << 63n })],
    ['owner category equals the token', base({ ownerCat: PUSD })],
    ['uppercase category', base({ tokenCat: PUSD.toUpperCase() })],
    ['manageAfter is a time', base({ manageAfter: 1_800_000_000 })],
    ['vesting without unlockHeight', base({ variant: 'vesting' })],
    ['unlockHeight on a default bin', base({ unlockHeight: 5 })],
    ['fee schedule that rises', base({ variant: 'feeSchedule', fees: { fee0: 30, h1: 10, fee1: 100, h2: 20, fee2: 100 } })],
    ['fee schedule with h1 after h2', base({ variant: 'feeSchedule', fees: { fee0: 100, h1: 30, fee1: 50, h2: 20, fee2: 10 } })],
    ['fee of 10000 bps', base({ variant: 'feeSchedule', fees: { fee0: 10_000, h1: 1, fee1: 10, h2: 2, fee2: 10 } })],
    ['size fee base above max', base({ variant: 'sizeFee', sizeFee: { baseFee: 400, slope: 1, refSize: 10n, maxFee: 300 } })],
    ['size fee zero reference', base({ variant: 'sizeFee', sizeFee: { baseFee: 1, slope: 1, refSize: 0n, maxFee: 300 } })],
];

export function generate() {
    const artifacts = Object.fromEntries(VARIANTS.map((v) => {
        const a = binArtifact(v);
        return [v, {
            contractName: a.contractName, compiler: `${a.compiler.name} ${a.compiler.version}`,
            bytecodeSha256: binToHex(sha256.hash(utf8ToBin(a.bytecode))),
            prefixLen: PREFIX_LENS[v], bodyHex: binV4Body(a, net, v),
        }];
    }));
    return {
        description: 'MeshBinV4 encoding vectors (all variants). Categories in display order; integers are decimal strings; a missing managerHash means 32 zero bytes.',
        artifacts,
        vectors: CASES.map(([name, p]) => ({ name, params: plain(p), ...describe(p) })),
        invalid: INVALID.map(([name, p]) => ({ name, params: plain(p) })),
    };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const out = generate();
    for (const [name, p] of INVALID) {
        let threw = false;
        try { validateBinV4(p); } catch { threw = true; }
        if (!threw) throw new Error(`invalid case accepted by the encoder: ${name}`);
    }
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${out.vectors.length} vectors and ${out.invalid.length} invalid cases → ${OUT}`);
}
