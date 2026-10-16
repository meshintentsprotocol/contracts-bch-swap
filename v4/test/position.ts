/**
 * Position NFT (phase 2): commitment layout, genesis rules, BCMR metadata.
 * Reference implementation for the server (port it with v4_encode.ts).
 *
 * Commitment v1, 82 bytes, fixed offsets:
 *   0   1  version            0x01
 *   1   1  flags              bits 0–2 shape (0 spot, 1 curve, 2 bid-ask, 3 custom),
 *                             bits 3–5 bin variant (index in VARIANTS), bits 6–7 zero
 *   2  32  tokenCat           display order (as wallets show categories)
 *  34   2  binStepBps         LE unsigned, 1..10000
 *  36   4  lowIndex           VM number, 4 bytes (sign-magnitude), grid index of the lowest bin
 *  40   4  highIndex          same, highest bin
 *  44   2  binCount           LE unsigned, 1..32767
 *  46  32  managerHash        the bins' managerHash (zero: no manager)
 *  78   4  createdHeight      LE unsigned block height
 *
 * Nothing on chain reads the commitment: the bins enforce ownership by
 * category alone. It describes the position for wallets (BCMR), indexers and
 * the UI, and is never empty (an immutable NFT needs a non-empty one to own
 * its bins; see ownerOk in contracts/lib/bin.cash).
 *
 * Genesis (checked by the server before it registers a position):
 *   G1 input 0 spends an output with index 0; the category is that outpoint's txid
 *   G2 no input already carries the category (it really is a genesis)
 *   G3 exactly one output carries the category: one NFT, capability none or
 *      mutable (never minting), with no fungible amount
 *   G4 its commitment is a valid v1 commitment
 *   G5 every listed bin names the category as ownerCat, matches the
 *      commitment (token, variant, manager, count) and is funded in this
 *      transaction with only the pair's token (or none), no NFT, ≥ 1,000 sats
 */
import { binToHex, hexToBin, sha256, type Output, type Transaction } from '@bitauth/libauth';
import { catVm, le, sle } from './harness.js';
import { VARIANTS, binV4Lock, binV4Body, binArtifact, type BinV4Params, type BinVariant } from './v4_encode.js';
import type { NetworkProvider } from 'cashscript';

export const COMMITMENT_V1_LEN = 82;
export const SHAPES = ['spot', 'curve', 'bidAsk', 'custom'] as const;
export type Shape = (typeof SHAPES)[number];

export interface PositionCommitment {
    version: 1;
    shape: Shape;
    variant: BinVariant;
    tokenCat: string;          // display order, 64 hex
    binStepBps: number;
    lowIndex: number;
    highIndex: number;
    binCount: number;
    managerHash: string;       // 64 hex; zeros = no manager
    createdHeight: number;
}

const is64 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const isInt = (x: unknown, lo: number, hi: number) => Number.isInteger(x) && (x as number) >= lo && (x as number) <= hi;

export function validateCommitment(c: PositionCommitment): void {
    const fail = (m: string): never => { throw new Error(`invalid position commitment: ${m}`); };
    if (c.version !== 1) fail('version must be 1');
    if (!SHAPES.includes(c.shape)) fail(`unknown shape ${c.shape}`);
    if (!VARIANTS.includes(c.variant)) fail(`unknown variant ${c.variant}`);
    if (!is64(c.tokenCat)) fail('tokenCat must be 64 lowercase hex');
    if (!isInt(c.binStepBps, 1, 10_000)) fail('binStepBps must be 1..10000');
    if (!isInt(c.lowIndex, -(2 ** 31 - 1), 2 ** 31 - 1) || !isInt(c.highIndex, -(2 ** 31 - 1), 2 ** 31 - 1)) fail('indexes must fit a 4-byte VM number');
    if (c.lowIndex > c.highIndex) fail('lowIndex must be ≤ highIndex');
    if (!isInt(c.binCount, 1, 32_767)) fail('binCount must be 1..32767');
    if (!is64(c.managerHash)) fail('managerHash must be 64 lowercase hex (zeros for none)');
    if (!isInt(c.createdHeight, 0, 499_999_999)) fail('createdHeight must be a block height');
}

export function encodeCommitment(c: PositionCommitment): string {
    validateCommitment(c);
    const flags = SHAPES.indexOf(c.shape) | (VARIANTS.indexOf(c.variant) << 3);
    const hex = '01' + flags.toString(16).padStart(2, '0') + c.tokenCat + le(c.binStepBps, 2)
        + sle(c.lowIndex, 4) + sle(c.highIndex, 4) + le(c.binCount, 2) + c.managerHash + le(c.createdHeight, 4);
    if (hex.length !== COMMITMENT_V1_LEN * 2) throw new Error('commitment length');
    return hex;
}

/** Strict decoder: anything but a well-formed v1 commitment throws. */
export function decodeCommitment(hex: string): PositionCommitment {
    const fail = (m: string): never => { throw new Error(`invalid position commitment: ${m}`); };
    if (!/^([0-9a-f]{2})*$/.test(hex)) fail('not lowercase hex');
    if (hex.length !== COMMITMENT_V1_LEN * 2) fail(`length ${hex.length / 2}, expected ${COMMITMENT_V1_LEN}`);
    const b = hexToBin(hex);
    if (b[0] !== 1) fail(`version ${b[0]}`);
    const flags = b[1]!;
    if (flags & 0xc0) fail('reserved flag bits set');
    if ((flags & 7) >= SHAPES.length) fail('unknown shape');
    if (((flags >> 3) & 7) >= VARIANTS.length) fail('unknown variant');
    const u = (o: number, n: number) => { let x = 0; for (let i = n - 1; i >= 0; i--) x = x * 256 + b[o + i]!; return x; };
    const s4 = (o: number) => { const mag = u(o, 4) & 0x7fffffff; return b[o + 3]! & 0x80 ? -mag : mag; };
    const c: PositionCommitment = {
        version: 1, shape: SHAPES[flags & 7]!, variant: VARIANTS[(flags >> 3) & 7]!,
        tokenCat: hex.slice(4, 68), binStepBps: u(34, 2), lowIndex: s4(36), highIndex: s4(40),
        binCount: u(44, 2), managerHash: hex.slice(92, 156), createdHeight: u(78, 4),
    };
    if (Object.is(c.lowIndex, -0) || Object.is(c.highIndex, -0)) fail('negative zero index');
    validateCommitment(c);
    return c;
}

// ── Genesis ───────────────────────────────────────────────────────────────────
export class GenesisError extends Error { constructor(public code: string, msg: string) { super(`${code}: ${msg}`); } }

export interface GenesisResult { category: string; nftIndex: number; holderLock: string; commitment: PositionCommitment; binIndexes: number[] }

const catHex = (t: Output['token']) => (t ? binToHex(t.category) : '');

/**
 * The server's genesis and registration check. `bins` are the position's bin
 * parameters as submitted with the registration; each must be funded in this
 * transaction.
 */
export function checkGenesis(tx: Transaction, sourceOutputs: Output[], bins: BinV4Params[], provider: NetworkProvider): GenesisResult {
    const g = (code: string, msg: string): never => { throw new GenesisError(code, msg); };
    const in0 = tx.inputs[0] ?? g('G1', 'no inputs');
    if (in0.outpointIndex !== 0) g('G1', `input 0 spends output #${in0.outpointIndex}; a new category needs output #0`);
    const category = binToHex(in0.outpointTransactionHash);
    if (sourceOutputs.some((o) => catHex(o.token) === category)) g('G2', 'an input already carries the category: not a genesis');

    const holders = tx.outputs.map((o, i) => [o, i] as const).filter(([o]) => catHex(o.token) === category);
    if (holders.length !== 1) g('G3', `${holders.length} outputs carry the category; exactly one NFT is allowed`);
    const [nftOut, nftIndex] = holders[0]!;
    const t = nftOut.token!;
    if (!t.nft) g('G3', 'the category output has no NFT (fungible only)');
    if (t.nft!.capability === 'minting') g('G3', 'a minting NFT would let its holder mint more owners');
    if (t.amount !== 0n) g('G3', `fungible supply of ${t.amount} created; a position has none`);

    let commitment: PositionCommitment;
    try { commitment = decodeCommitment(binToHex(t.nft!.commitment)); } catch (e: any) { return g('G4', e.message); }

    if (bins.length !== commitment.binCount) g('G5', `${bins.length} bins listed, commitment says ${commitment.binCount}`);
    const used = new Set<number>([nftIndex]);
    const binIndexes = bins.map((p, k) => {
        if (p.ownerCat !== category) g('G5', `bin ${k}: ownerCat is not the genesis category`);
        if (p.tokenCat !== commitment.tokenCat) g('G5', `bin ${k}: token differs from the commitment`);
        if ((p.variant ?? 'default') !== commitment.variant) g('G5', `bin ${k}: variant differs from the commitment`);
        if ((p.managerHash ?? '00'.repeat(32)) !== commitment.managerHash) g('G5', `bin ${k}: manager differs from the commitment`);
        const v = p.variant ?? 'default';
        const lock = binToHex(binV4Lock(p, binV4Body(binArtifact(v), provider, v)));
        const j = tx.outputs.findIndex((o, i) => !used.has(i) && binToHex(o.lockingBytecode) === lock);
        if (j < 0) g('G5', `bin ${k}: not funded in this transaction`);
        used.add(j);
        const o = tx.outputs[j]!;
        if (o.token && (catHex(o.token) !== p.tokenCat || o.token.nft)) g('G5', `bin ${k}: holds a foreign token or an NFT`);
        if (o.valueSatoshis < 1000n) g('G5', `bin ${k}: below the 1,000-sat minimum`);
        return j;
    });
    return { category, nftIndex, holderLock: binToHex(nftOut.lockingBytecode), commitment, binIndexes };
}

// ── BCMR ──────────────────────────────────────────────────────────────────────
/**
 * NFT parse bytecode (BCMR "parsable NFT"): splits a v1 commitment into its
 * fields on the altstack. The version byte is the NFT type (bottom item);
 * numbers are normalised with OP_BIN2NUM so clients read minimal VM numbers.
 */
export const PARSE_BYTECODE = [
    '00cf',            // OP_0 OP_UTXOTOKENCOMMITMENT
    '517f7c6b',        // version → type          (OP_1 OP_SPLIT OP_SWAP OP_TOALTSTACK)
    '517f7c6b',        // flags
    '01207f7c6b',      // tokenCat (32)
    '527f7c816b',      // binStepBps (2, OP_BIN2NUM)
    '547f7c816b',      // lowIndex (4)
    '547f7c816b',      // highIndex (4)
    '527f7c816b',      // binCount (2)
    '01207f7c6b',      // managerHash (32)
    '816b',            // createdHeight (rest, 4)
].join('');

export const NFT_FIELDS = {
    flags: { name: 'Flags', description: 'Bits 0–2 shape (0 spot, 1 curve, 2 bid-ask, 3 custom); bits 3–5 bin variant.', encoding: { type: 'binary' } },
    tokenCategory: { name: 'Token', description: 'The token this position trades against BCH.', encoding: { type: 'hex' } },
    binStepBps: { name: 'Bin step (bps)', description: 'Distance between price levels, in basis points.', encoding: { type: 'number' } },
    lowIndex: { name: 'Low level', description: 'Grid index of the lowest bin.', encoding: { type: 'number' } },
    highIndex: { name: 'High level', description: 'Grid index of the highest bin.', encoding: { type: 'number' } },
    binCount: { name: 'Bins', description: 'Number of bins this NFT owns.', encoding: { type: 'number' } },
    managerHash: { name: 'Manager', description: 'Script hash of the position manager; zero when none.', encoding: { type: 'hex' } },
    createdHeight: { name: 'Created', description: 'Block height at creation.', encoding: { type: 'locktime' } },
} as const;

export interface PositionIdentity { category: string; name: string; description?: string; symbol?: string; iconUri?: string; webUri?: string }

/** A BCMR registry listing positions (one identity per position category). Validate with libauth importMetadataRegistry. */
export function positionRegistry(positions: PositionIdentity[], at: string) {
    const identities: Record<string, Record<string, unknown>> = {};
    for (const p of positions) {
        const uris: Record<string, string> = {};
        if (p.iconUri) uris.icon = p.iconUri;
        if (p.webUri) uris.web = p.webUri;
        identities[p.category] = {
            [at]: {
                name: p.name,
                description: p.description ?? 'A Mesh V4 liquidity position. Whoever holds this NFT controls the position\'s bins. Sending it sends the position.',
                token: {
                    category: p.category,
                    symbol: p.symbol ?? 'MESHPOS',
                    decimals: 0,
                    nfts: {
                        description: 'Mesh V4 position NFT',
                        fields: NFT_FIELDS,
                        parse: {
                            bytecode: PARSE_BYTECODE,
                            types: { '01': { name: 'Mesh position (v1)', description: 'Bins on the Mesh price grid, owned by this NFT.', fields: Object.keys(NFT_FIELDS) } },
                        },
                    },
                },
                ...(Object.keys(uris).length ? { uris } : {}),
            },
        };
    }
    return {
        $schema: 'https://cashtokens.org/bcmr-v2.schema.json',
        version: { major: 1, minor: 0, patch: 0 },
        latestRevision: at,
        registryIdentity: { name: 'Mesh V4 positions', description: 'Position NFTs of the Mesh V4 liquidity protocol on Bitcoin Cash.' },
        identities,
    };
}

/**
 * BCMR publication output for a genesis transaction (BCMR authchain): OP_RETURN
 * 'BCMR' <sha256 of the registry file's exact bytes> <URI without https://>.
 * Returns CashScript addOpReturnOutput chunks.
 */
export function bcmrPublicationChunks(registryBytes: Uint8Array, httpsUrl: string): string[] {
    if (!httpsUrl.startsWith('https://')) throw new Error('BCMR registry URL must be https');
    return ['BCMR', '0x' + binToHex(sha256.hash(registryBytes)), httpsUrl.slice('https://'.length)];
}

/** Display-order category → VM order (for bin parameters). */
export const categoryVm = catVm;
