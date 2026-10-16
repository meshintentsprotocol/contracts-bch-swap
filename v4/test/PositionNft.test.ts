/**
 * Phase 2: the position NFT. Commitment layout, BCMR metadata (checked by
 * libauth and by running the parse script in the VM, as a wallet would), and
 * cases N1–N5 of v4plan 03 §2.2.
 *
 * Consensus allows several genesis shapes we must never register (a minting
 * NFT left over, fungible supply, two NFTs). For those, the suite proves that
 * the VM accepts the transaction AND that checkGenesis refuses it.
 *
 * Usage: npx tsx test/PositionNft.test.ts
 */
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { generate as generateVectors, OUT as VECTORS } from '../tools/gen-position-vectors.js';
import {
    binToHex, encodeTransaction, hashTransaction, hexToBin, importMetadataRegistry, type Output, type Transaction,
} from '@bitauth/libauth';
import {
    OWNER, TAKER, ATTACKER, TOKEN_A, TOKEN_B, makeKey, net, tb, tok, nft, utxo, lockOf, vm, buildTx, verify,
    expectAccept, expectReject, check, section, summary, type Tok, type Built,
} from './harness.js';
import { balanced } from './tx.js';
import { binOf, type BinV4Params } from './v4_encode.js';
import {
    COMMITMENT_V1_LEN, PARSE_BYTECODE, checkGenesis, decodeCommitment, encodeCommitment, positionRegistry,
    GenesisError, type PositionCommitment,
} from './position.js';

const SECOND = makeKey(0x55);
const GEN_TXID = 'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e100';
const CAT = GEN_TXID;                                   // category = txid of the outpoint input 0 spends
const MGR = 'cd'.repeat(32);

const COMMIT: PositionCommitment = {
    version: 1, shape: 'curve', variant: 'default', tokenCat: TOKEN_A, binStepBps: 100,
    lowIndex: 760, highIndex: 762, binCount: 3, managerHash: MGR, createdHeight: 900_000,
};
const C_HEX = encodeCommitment(COMMIT);
const binP = (k: number, over: Partial<BinV4Params> = {}): BinV4Params => ({
    tokenCat: TOKEN_A, ownerCat: CAT, bidNum: BigInt(1990 + 20 * k), bidDen: 1n, askNum: BigInt(2000 + 20 * k), askDen: 1n,
    managerHash: MGR, manageAfter: 0, ...over,
});
const BINS = [binP(0), binP(1), binP(2)];

interface GenOpts {
    nftOut?: Tok | null; extraOut?: Array<{ to: Uint8Array; amount: bigint; token?: Tok }>;
    bins?: BinV4Params[]; binTok?: (k: number) => Tok | undefined; binSats?: bigint; vout?: number; extraIn?: Tok;
}

/** LP's genesis: input 0 (vout 0) creates the category; NFT to the LP; bins funded with BCH and tokens. */
function genesis(o: GenOpts = {}) {
    const bins = o.bins ?? BINS;
    const b = tb();
    b.addInput(utxo(OWNER.lock, 200_000n, undefined, o.vout ?? 0, GEN_TXID), OWNER.template.unlockP2PKH());
    b.addInput(utxo(OWNER.lock, 2_000n, tok(300n)), OWNER.template.unlockP2PKH());
    if (o.extraIn) b.addInput(utxo(OWNER.lock, 1_000n, o.extraIn), OWNER.template.unlockP2PKH());
    const outs = (b as any).outputs as any[];
    if (o.nftOut !== null) outs.push({ to: OWNER.lock, amount: 1_000n, token: o.nftOut ?? nft(CAT, 'mutable', C_HEX) });
    let tokensUsed = 0n;
    bins.forEach((p, k) => {
        const t = o.binTok ? o.binTok(k) : (k === 0 ? undefined : tok(100n));
        if (t && t.category === TOKEN_A) tokensUsed += t.amount;
        outs.push({ to: lockOf(binOf(p, net)), amount: o.binSats ?? 50_000n, ...(t ? { token: t } : {}) });
    });
    for (const e of o.extraOut ?? []) outs.push(e);
    if (300n - tokensUsed > 0n) outs.push({ to: OWNER.lock, amount: 1_000n, token: tok(300n - tokensUsed) });
    return b;
}

/** Run the BCMR parsing transaction (BCMR spec) for an NFT; returns the altstack as hex, or null if parsing fails. */
function bcmrParse(commitmentHex: string, category = CAT): string[] | null {
    const transaction: Transaction = {
        version: 2, locktime: 0,
        inputs: [
            { outpointIndex: 0, outpointTransactionHash: hexToBin('11'.repeat(32)), sequenceNumber: 0, unlockingBytecode: Uint8Array.of() },
            { outpointIndex: 0, outpointTransactionHash: new Uint8Array(32), sequenceNumber: 0, unlockingBytecode: Uint8Array.of(0x51) },
        ],
        outputs: [{ lockingBytecode: Uint8Array.of(0x6a), valueSatoshis: 0n }],
    };
    const sourceOutputs: Output[] = [
        { lockingBytecode: OWNER.lock, valueSatoshis: 1_000n, token: { amount: 0n, category: hexToBin(category), nft: { capability: 'mutable', commitment: hexToBin(commitmentHex) } } },
        { lockingBytecode: hexToBin(PARSE_BYTECODE), valueSatoshis: 0n },
    ];
    const state = vm.evaluate({ inputIndex: 1, sourceOutputs, transaction }) as any;
    if (state.error || vm.stateSuccess(state) !== true || state.alternateStack.length === 0) return null;
    return state.alternateStack.map((x: Uint8Array) => binToHex(x));
}

const errCode = (f: () => unknown) => { try { f(); return 'OK'; } catch (e: any) { return e instanceof GenesisError ? e.code : `throw: ${e.message}`; } };

export function run() {
    // ── Commitment ─────────────────────────────────────────────────────────
    section('Commitment v1 (82 bytes)');
    check('encodes to 82 bytes', C_HEX.length === COMMITMENT_V1_LEN * 2, `${C_HEX.length / 2} B`);
    const cases: PositionCommitment[] = [
        COMMIT,
        { ...COMMIT, shape: 'bidAsk', variant: 'sizeFee', lowIndex: -1852, highIndex: -1, binCount: 1852, managerHash: '00'.repeat(32) },
        { ...COMMIT, shape: 'custom', variant: 'vesting', lowIndex: -(2 ** 31 - 1), highIndex: 2 ** 31 - 1, binCount: 32_767, binStepBps: 10_000, createdHeight: 499_999_999 },
    ];
    for (const c of cases) check(`round trip ${c.shape}/${c.variant} [${c.lowIndex}, ${c.highIndex}]`, JSON.stringify(decodeCommitment(encodeCommitment(c))) === JSON.stringify(c));
    const bad: Array<[string, string]> = [
        ['empty', ''], ['81 bytes', C_HEX.slice(0, -2)], ['83 bytes', C_HEX + '00'], ['version 2', '02' + C_HEX.slice(2)],
        ['reserved flag bit', C_HEX.slice(0, 2) + 'c1' + C_HEX.slice(4)], ['unknown shape 7', C_HEX.slice(0, 2) + '07' + C_HEX.slice(4)],
        ['step 0', C_HEX.slice(0, 68) + '0000' + C_HEX.slice(72)], ['uppercase hex', C_HEX.toUpperCase()],
        ['low above high', encodeCommitment({ ...COMMIT, lowIndex: 5, highIndex: 9 }).replace(/^(.{72})(.{8})(.{8})/, '$1$3$2')],
    ];
    for (const [name, hex] of bad) {
        let threw = false;
        try { decodeCommitment(hex); } catch { threw = true; }
        check(`decoder refuses: ${name}`, threw);
    }

    // ── BCMR ───────────────────────────────────────────────────────────────
    section('BCMR metadata (wallet display)');
    const reg = positionRegistry([{ category: CAT, name: 'Range BCH/pUSD 1,980–2,040', iconUri: 'https://mesh.example/icon.svg' }], '2026-10-16T00:00:00.000Z');
    const imported = importMetadataRegistry(reg);
    check('the registry passes libauth\'s BCMR schema validation', typeof imported !== 'string', typeof imported === 'string' ? imported.slice(0, 200) : 'valid');
    const alt = bcmrParse(C_HEX);
    const want = ['01', '01',   // version, flags = shape curve (1) | variant default (0) << 3
        TOKEN_A, '64', 'f802', 'fa02', '03', MGR, 'a0bb0d'];
    check('the parse script, run as a wallet runs it, splits the commitment into the fields', JSON.stringify(alt) === JSON.stringify(want), JSON.stringify(alt));
    const altNeg = bcmrParse(encodeCommitment({ ...COMMIT, lowIndex: -5, highIndex: -1 }));
    check('negative grid indexes parse as negative VM numbers', altNeg?.[4] === '85' && altNeg?.[5] === '81', JSON.stringify(altNeg?.slice(4, 6)));
    check('a short (malformed) commitment fails to parse instead of showing wrong fields', bcmrParse(C_HEX.slice(0, 60)) === null);

    // ── N1 ─────────────────────────────────────────────────────────────────
    section('N1 · genesis + bins in one transaction');
    const g1 = expectAccept('genesis: input 0 spends output #0; one mutable NFT to the LP; 3 bins funded', genesis);
    if (g1) {
        const r = checkGenesis(g1.transaction, g1.sourceOutputs, BINS, net);
        check('checkGenesis registers it', r.category === CAT && r.nftIndex === 0 && r.binIndexes.join() === '1,2,3', `category ${r.category.slice(0, 12)}… NFT at ${r.nftIndex}, bins at ${r.binIndexes}`);
        check('the holder is the LP', r.holderLock === binToHex(OWNER.lock));
        // Follow the real outputs: the LP withdraws bin 1 with the NFT just minted.
        const txid = hashTransaction(encodeTransaction(g1.transaction));
        const binC = binOf(BINS[1]!, net);
        expectAccept('the LP withdraws a bin with the freshly minted NFT (spending the genesis outputs)', () => {
            const b = tb();
            b.addInput(utxo(binC.lockingBytecode, 50_000n, tok(100n), 2, txid), (binC as any).unlock.owner(1n));
            b.addInput(utxo(OWNER.lock, 1_000n, nft(CAT, 'mutable', C_HEX), 0, txid), OWNER.template.unlockP2PKH());
            b.addInput(utxo(OWNER.lock, 5_000n), OWNER.template.unlockP2PKH());
            const o = (b as any).outputs as any[];
            o.push({ to: OWNER.lock, amount: 50_000n, token: tok(100n) }, { to: OWNER.lock, amount: 1_000n, token: nft(CAT, 'mutable', C_HEX) }, { to: OWNER.lock, amount: 3_000n });
            return b;
        });
    }
    expectAccept('genesis with an immutable NFT (allowed: commitment can never change)', () => genesis({ nftOut: nft(CAT, 'none', C_HEX) }));

    // ── N2 ─────────────────────────────────────────────────────────────────
    section('N2 · genesis shapes consensus allows but the server must refuse');
    const vmOkButRefused = (name: string, o: GenOpts, code: string) => {
        const built = buildTx(genesis(o));
        const v = verify(built);
        check(`${name}: the VM accepts it (consensus)`, v === true, v === true ? '' : v.slice(0, 120));
        const got = errCode(() => checkGenesis(built.transaction, built.sourceOutputs, o.bins ?? BINS, net));
        check(`${name}: checkGenesis refuses (${code})`, got === code, got);
    };
    vmOkButRefused('minting NFT left over', { nftOut: nft(CAT, 'minting', C_HEX) }, 'G3');
    vmOkButRefused('fungible supply minted with the NFT', { nftOut: { amount: 1_000n, category: CAT, nft: { capability: 'mutable', commitment: C_HEX } } }, 'G3');
    vmOkButRefused('two NFTs', { extraOut: [{ to: ATTACKER.lock, amount: 1_000n, token: nft(CAT, 'mutable', C_HEX) }] }, 'G3');
    vmOkButRefused('NFT plus a separate fungible output', { extraOut: [{ to: OWNER.lock, amount: 1_000n, token: tok(5n, CAT) }] }, 'G3');
    vmOkButRefused('NFT with an empty commitment', { nftOut: nft(CAT, 'mutable', '') }, 'G4');
    vmOkButRefused('NFT with a malformed commitment', { nftOut: nft(CAT, 'mutable', 'beef') }, 'G4');
    vmOkButRefused('no NFT at all (fungible-only category)', { nftOut: tok(1n, CAT) }, 'G3');
    {
        const built = buildTx(genesis({ vout: 1 }));
        const v = verify(built);
        check('input 0 spends output #1: the VM refuses to create the category', v !== true && /token|categor|genesis/i.test(v), v === true ? 'ACCEPTED' : v.slice(0, 110));
        const wrong = buildTx(genesis({ nftOut: nft('ab'.repeat(32), 'mutable', C_HEX), bins: BINS.map((p) => ({ ...p, ownerCat: 'ab'.repeat(32) })) }));
        const w = verify(wrong);
        check('an NFT of a category no input creates: the VM refuses', w !== true, w === true ? 'ACCEPTED' : w.slice(0, 110));
    }

    // ── N3 ─────────────────────────────────────────────────────────────────
    section('N3 · registration refuses bins that don\'t belong');
    const regRefuses = (name: string, o: GenOpts, listed: BinV4Params[], code = 'G5') => {
        const built = buildTx(genesis(o));
        check(`${name} (VM-valid)`, verify(built) === true);
        const got = errCode(() => checkGenesis(built.transaction, built.sourceOutputs, listed, net));
        check(`${name}: refused (${code})`, got === code, got);
    };
    const other = BINS.map((p, k) => (k === 1 ? { ...p, ownerCat: TOKEN_B } : p));
    regRefuses('a bin whose ownerCat is another category', { bins: other }, other);
    regRefuses('a listed bin that is not funded in the genesis transaction', { bins: BINS.slice(0, 2) }, BINS);
    regRefuses('more bins listed than the commitment counts', {}, [...BINS, binP(3)]);
    const otherTok = BINS.map((p) => ({ ...p, tokenCat: TOKEN_B }));
    regRefuses('bins of another token than the commitment', { bins: otherTok, binTok: () => undefined }, otherTok);
    const noMgr = BINS.map((p) => ({ ...p, managerHash: undefined }));
    regRefuses('bins with another manager than the commitment', { bins: noMgr }, noMgr);
    regRefuses('a bin funded below the 1,000-sat minimum', { binSats: 900n, binTok: () => undefined }, BINS);
    regRefuses('a bin funded with a foreign token', { binTok: (k) => (k === 2 ? tok(10n, TOKEN_B) : undefined), extraIn: tok(10n, TOKEN_B) }, BINS);

    // ── N4 ─────────────────────────────────────────────────────────────────
    section('N4 · commitment changes');
    const newC = encodeCommitment({ ...COMMIT, lowIndex: 770, highIndex: 772 });
    const recommit = (from: Tok, to: Tok, holder = OWNER) => () => {
        const b = tb();
        b.addInput(utxo(holder.lock, 1_000n, from), holder.template.unlockP2PKH());
        b.addInput(utxo(holder.lock, 5_000n), holder.template.unlockP2PKH());
        const o = (b as any).outputs as any[];
        o.push({ to: holder.lock, amount: 1_000n, token: to }, { to: holder.lock, amount: 3_000n });
        return b;
    };
    expectAccept('the holder of a mutable NFT updates its commitment', recommit(nft(CAT, 'mutable', C_HEX), nft(CAT, 'mutable', newC)));
    {
        const v = verify(buildTx(recommit(nft(CAT, 'none', C_HEX), nft(CAT, 'none', newC))()));
        check('an immutable NFT\'s commitment cannot change (consensus)', v !== true, v === true ? 'ACCEPTED' : v.slice(0, 100));
        const m = verify(buildTx(recommit(nft(CAT, 'mutable', C_HEX), nft(CAT, 'minting', C_HEX))()));
        check('a mutable NFT cannot be upgraded to minting (consensus)', m !== true, m === true ? 'ACCEPTED' : m.slice(0, 100));
    }
    {
        const binC = binOf(BINS[1]!, net);
        const withdraw = (t: Tok) => () => balanced(
            [{ lock: binC.lockingBytecode, unlock: (binC as any).unlock.owner(1n), inS: 50_000n, inTok: tok(100n), outS: 50_000n, outTok: tok(100n), outTo: OWNER.lock }],
            { extraIns: [{ lock: OWNER.lock, unlock: OWNER.template.unlockP2PKH(), sats: 1_000n, tok: t }], party: OWNER });
        expectAccept('after a commitment update the NFT still owns the bins', withdraw(nft(CAT, 'mutable', newC)));
        expectAccept('even a cleared commitment on a mutable NFT still owns the bins (no self-lock)', withdraw(nft(CAT, 'mutable', '')));
    }

    // ── N5 ─────────────────────────────────────────────────────────────────
    section('N5 · transfer: the new holder controls the position, the old one doesn\'t');
    expectAccept('the LP sends the position NFT to a second owner', recommit(nft(CAT, 'mutable', C_HEX), nft(CAT, 'mutable', C_HEX)));
    {
        const binC = binOf(BINS[1]!, net);
        const withdrawBy = (holder: typeof OWNER, t?: Tok) => () => balanced(
            [{ lock: binC.lockingBytecode, unlock: (binC as any).unlock.owner(1n), inS: 50_000n, inTok: tok(100n), outS: 50_000n, outTok: tok(100n), outTo: holder.lock }],
            { extraIns: [{ lock: holder.lock, unlock: holder.template.unlockP2PKH(), sats: 1_000n, ...(t ? { tok: t } : {}) }], party: holder });
        expectAccept('the new holder withdraws a bin', withdrawBy(SECOND, nft(CAT, 'mutable', C_HEX)));
        expectReject('the old holder (no NFT any more) cannot', withdrawBy(OWNER), { at: 0, rule: 'ownerOk(k, ownerCat)', reason: /OP_SPLIT/ });
        expectReject('the old holder with a look-alike NFT of another category cannot', withdrawBy(OWNER, nft(TOKEN_B, 'mutable', C_HEX)), { at: 0, rule: 'require(cat.split(32)[0] == ownerCat)' });
    }

    // ── L3 vectors ─────────────────────────────────────────────────────────
    section('L3 · positionNft.vectors.json');
    const file = JSON.parse(readFileSync(VECTORS, 'utf-8'));
    check('the vectors file matches a fresh regeneration', JSON.stringify(file) === JSON.stringify(JSON.parse(JSON.stringify(generateVectors()))));
    check('the parse bytecode in the file is the one wallets get', file.parseBytecode === PARSE_BYTECODE);
    for (const v of file.vectors) {
        const back = decodeCommitment(v.hex);
        const parsed = bcmrParse(v.hex);
        check(`${v.name}: decodes to its fields and parses in the VM`, JSON.stringify(back) === JSON.stringify(v.fields) && parsed !== null && parsed[2] === v.fields.tokenCat);
    }
    for (const v of file.invalid) {
        let threw = false;
        try { decodeCommitment(v.hex); } catch { threw = true; }
        check(`invalid refused: ${v.name}`, threw);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
    summary('Position NFT (phase 2)');
}
