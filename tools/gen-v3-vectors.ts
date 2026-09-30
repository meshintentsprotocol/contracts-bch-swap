/**
 * MeshPoolV3 parity vectors for the meshserver and frontend encoders.
 *
 * For each case: constructor args (hex), redeem script, P2SH32 locking bytecode,
 * chipnet/mainnet addresses, and for mirror pools the reverse pool of every
 * slot. A second list holds params the encoder must reject. `artifact.sha256`
 * pins the compiled bytecode, so a drifted artifact copy fails the parity test.
 *
 * Usage: npx tsx tools/gen-v3-vectors.ts   (after npm run build:v3)
 */
import { MockNetworkProvider } from 'cashscript';
import { binToHex, encodeCashAddress, hash256, sha256, utf8ToBin } from '@bitauth/libauth';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BCH, PREFIX_LEN, mirrorOf, redeemBytes, v3Args, v3Contract, validateV3, type V3Params } from '../test/mesh_test/v3_encode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = JSON.parse(readFileSync(join(ROOT, 'artifacts', 'MeshPoolV3.json'), 'utf-8'));
const OUT = join(ROOT, 'test', 'mesh_test', 'vectors', 'meshPoolV3.vectors.json');
const net = new MockNetworkProvider();

const PUSD = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
const MUSD = 'b4863d5773c7a269b6fe3b9f7ce2ce1098ab71c0b046ef2a39058d5e30b1f353';
const TOK3 = '7c2d3b4a5f60718293a4b5c6d7e8f901122334455667788990aabbccddeeff00';
const OWNER = '1b7e3c5a9d2f4e6081a3c5e7f90b2d4f6a8c0e21';

function describe(p: V3Params) {
    validateV3(p);
    const c = v3Contract(artifact, p, net);
    const redeem = redeemBytes(c);
    const scriptHash = hash256(redeem);
    const addr = (prefix: 'bchtest' | 'bitcoincash', type: 'p2sh' | 'p2shWithTokens') =>
        encodeCashAddress({ prefix, type, payload: scriptHash }).address;
    const prefix = c.address.startsWith('bchtest:') ? 'bchtest' : 'bitcoincash';
    if (c.address !== addr(prefix, 'p2sh') || c.tokenAddress !== addr(prefix, 'p2shWithTokens')) throw new Error('cashscript and libauth addresses differ');
    return {
        args: v3Args(p).map((a) => a.slice(2)),
        redeemScriptHex: binToHex(redeem),
        prefixHex: binToHex(redeem.slice(0, PREFIX_LEN)),
        scriptHash: binToHex(scriptHash),
        lockingBytecodeHex: `aa20${binToHex(scriptHash)}87`,
        chipnet: { address: addr('bchtest', 'p2sh'), tokenAddress: addr('bchtest', 'p2shWithTokens') },
        mainnet: { address: addr('bitcoincash', 'p2sh'), tokenAddress: addr('bitcoincash', 'p2shWithTokens') },
    };
}

const plain = (p: V3Params) => ({
    ...p,
    ownerPkh: typeof p.ownerPkh === 'string' ? p.ownerPkh : binToHex(p.ownerPkh),
    slots: p.slots.map((s) => ({ cat: s.cat, num: String(s.num), den: String(s.den), rNum: String(s.rNum ?? 0n), rDen: String(s.rDen ?? 0n) })),
});

const reverseBch: V3Params = { ownerPkh: OWNER, reserve: PUSD, feeBps: 30, mode: 0, slots: [{ cat: BCH, num: 1n, den: 2100n }] };
const cases: Array<[string, V3Params]> = [
    ['bch-reserve-pusd-owner', { ownerPkh: OWNER, reserve: BCH, feeBps: 30, mode: 0, slots: [{ cat: PUSD, num: 2000n, den: 1n }] }],
    ['bch-reserve-three-tokens', { ownerPkh: OWNER, reserve: BCH, feeBps: 5, mode: 0, slots: [
        { cat: PUSD, num: 2000n, den: 1n }, { cat: MUSD, num: 1995n, den: 1n }, { cat: TOK3, num: 7n, den: 3n }] }],
    ['pusd-reserve-bch', reverseBch],
    ['musd-reserve-pusd-token-to-token', { ownerPkh: OWNER, reserve: MUSD, feeBps: 10, mode: 0, slots: [{ cat: PUSD, num: 100n, den: 1n }] }],
    ['fee-zero-large-price', { ownerPkh: OWNER, reserve: BCH, feeBps: 0, mode: 0, slots: [{ cat: PUSD, num: 4611686018427387903n, den: 1000000000000000000n }] }],
    ['mode1-recycle-to-reverse', { ownerPkh: OWNER, reserve: BCH, feeBps: 30, mode: 1, slots: [{ cat: PUSD, num: 2000n, den: 1n }],
        proceedsHash: describe(reverseBch).scriptHash }],
    ['mode2-mirror-single', { ownerPkh: OWNER, reserve: BCH, feeBps: 30, mode: 2, slots: [{ cat: PUSD, num: 2000n, den: 1n, rNum: 1n, rDen: 2200n }] }],
    ['mode2-mirror-two-slots', { ownerPkh: OWNER, reserve: BCH, feeBps: 30, mode: 2, slots: [
        { cat: PUSD, num: 2000n, den: 1n, rNum: 1n, rDen: 2200n }, { cat: MUSD, num: 1990n, den: 1n, rNum: 1n, rDen: 2190n }] }],
    ['mode2-mirror-token-to-token', { ownerPkh: OWNER, reserve: MUSD, feeBps: 30, mode: 2, slots: [{ cat: PUSD, num: 100n, den: 1n, rNum: 1n, rDen: 110n }] }],
];

const invalid: Array<[string, V3Params]> = [
    ['slot accepts the reserve', { ownerPkh: OWNER, reserve: PUSD, feeBps: 30, mode: 0, slots: [{ cat: PUSD, num: 1n, den: 1n }] }],
    ['duplicate slot category', { ownerPkh: OWNER, reserve: BCH, feeBps: 30, mode: 0, slots: [{ cat: PUSD, num: 1n, den: 1n }, { cat: PUSD, num: 2n, den: 1n }] }],
    ['zero price', { ownerPkh: OWNER, reserve: BCH, feeBps: 30, mode: 0, slots: [{ cat: PUSD, num: 0n, den: 1n }] }],
    ['fee 10000', { ownerPkh: OWNER, reserve: BCH, feeBps: 10000, mode: 0, slots: [{ cat: PUSD, num: 1n, den: 1n }] }],
    ['no slots', { ownerPkh: OWNER, reserve: BCH, feeBps: 30, mode: 0, slots: [] }],
    ['four slots', { ownerPkh: OWNER, reserve: BCH, feeBps: 30, mode: 0, slots: [
        { cat: PUSD, num: 1n, den: 1n }, { cat: MUSD, num: 1n, den: 1n }, { cat: TOK3, num: 1n, den: 1n }, { cat: 'ab'.repeat(32), num: 1n, den: 1n }] }],
    ['mode 1 without hash', { ownerPkh: OWNER, reserve: BCH, feeBps: 30, mode: 1, slots: [{ cat: PUSD, num: 1n, den: 1n }] }],
    ['mode 2 without reverse price', { ownerPkh: OWNER, reserve: BCH, feeBps: 30, mode: 2, slots: [{ cat: PUSD, num: 2000n, den: 1n }] }],
    ['uppercase category', { ownerPkh: OWNER, reserve: BCH, feeBps: 30, mode: 0, slots: [{ cat: PUSD.toUpperCase(), num: 1n, den: 1n }] }],
    ['short owner pkh', { ownerPkh: OWNER.slice(2), reserve: BCH, feeBps: 30, mode: 0, slots: [{ cat: PUSD, num: 1n, den: 1n }] }],
];

const vectors = cases.map(([name, p]) => ({
    name,
    params: plain(p),
    ...describe(p),
    ...(p.mode === 2 ? { mirrors: p.slots.map((_, k) => ({ slot: k, params: plain(mirrorOf(p, k)), ...describe(mirrorOf(p, k)) })) } : {}),
}));

// Every redeem script must share one template body after the fixed-width prefix.
const bodies = new Set(vectors.flatMap((v: any) => [v, ...(v.mirrors ?? [])]).map((v: any) => v.redeemScriptHex.slice(PREFIX_LEN * 2)));
if (bodies.size !== 1) throw new Error(`parameter prefix is not ${PREFIX_LEN} bytes for every case`);

for (const [name, p] of invalid) {
    let threw = false;
    try { validateV3(p); } catch { threw = true; }
    if (!threw) throw new Error(`invalid case accepted by validateV3: ${name}`);
}

const doc = {
    description: 'MeshPoolV3 encoding vectors. Categories in display order; BCH is "BCH"; integers are decimal strings.',
    artifact: {
        contractName: artifact.contractName,
        compiler: `${artifact.compiler.name} ${artifact.compiler.version}`,
        bytecodeSha256: binToHex(sha256.hash(utf8ToBin(artifact.bytecode))),
    },
    prefixLen: PREFIX_LEN,
    vectors,
    invalid: invalid.map(([name, p]) => ({ name, params: plain(p) })),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors (+${invalid.length} invalid) → ${OUT}`);
