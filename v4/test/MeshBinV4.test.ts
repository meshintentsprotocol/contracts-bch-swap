/**
 * MeshBinV4 VM security suite, cases B0–B9 of v4plan 03 §2.1 (B10, the option
 * variants, is in MeshBinV4.options.test.ts; B7's mixed-covenant transactions
 * are in MeshBinV4.composition.test.ts).
 *
 * Every transaction is verified by the BCH 2026 VM. Rejections must come from
 * the bin's own input (`at`), never from a signature or a policy rule.
 *
 * Usage: npx tsx test/MeshBinV4.test.ts
 */
import { Contract } from 'cashscript';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { binToHex } from '@bitauth/libauth';
import {
    OWNER, TAKER, ATTACKER, KEEPER, TOKEN_A, TOKEN_B, TOKEN_FAKE, net, tok, nft, utxo, lockOf,
    expectAccept, expectReject, check, section, summary, type Tok,
} from './harness.js';
import { balanced, binLeg, type Leg } from './tx.js';
import { binOf, binArtifact, type BinV4Params } from './v4_encode.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = JSON.parse(readFileSync(join(HERE, 'fixtures', 'ManagerStub.json'), 'utf-8'));

export const POS = '5a1e7c0ffee0b1a5d00d0000c0ffee5a1e7c0ffee0b1a5d00d0000c0ffee5a1e';
export const POS_COMMIT = '01' + '00'.repeat(40);           // a position commitment (version 1, never empty)
export const stub = (salt = 'ab') => new Contract(STUB, ['0x' + salt.repeat(32)], { provider: net, contractType: 'p2sh32' });
export const MANAGER = stub();
export const MGR_HASH = binToHex(lockOf(MANAGER).slice(2, 34));
export const MANAGE_AFTER = 900_000;

export const BASE: BinV4Params = {
    tokenCat: TOKEN_A, ownerCat: POS, bidNum: 1990n, bidDen: 1n, askNum: 2000n, askDen: 1n,
    managerHash: MGR_HASH, manageAfter: MANAGE_AFTER,
};
export const bin = (over: Partial<BinV4Params> = {}) => binOf({ ...BASE, ...over }, net);
const T = (a: bigint, cat = TOKEN_A): Tok | undefined => (a > 0n ? tok(a, cat) : undefined);

/** One bin traded: (inS, inT) → (outS, outT), in place unless `more.outTo`. */
const trade = (c: Contract, inS: bigint, inT: bigint, outS: bigint, outT: bigint, more: Partial<Leg> = {}, opts = {}) =>
    () => balanced([binLeg(c, inS, T(inT), outS, T(outT), more)], opts);

/** The require() each attack must trip (source text, as CashScript's debugger reports it). */
const R = {
    PRICE: 'require(ds * d + dt * n >= 0)',
    SAME: 'require(tx.outputs[i].lockingBytecode == tx.inputs[i].lockingBytecode)',
    INCAT: 'require(inCat == tokenCat || inCat == 0x)',
    OUTCAT: 'require(outCat == tokenCat || outCat == 0x)',
    COMMIT: 'require(tx.outputs[i].nftCommitment == 0x)',
    MIN: 'require(tx.outputs[i].value >= 1000)',
    OWNER_CAT: 'require(cat.split(32)[0] == ownerCat)',
    OWNER_COMMIT: 'require(ownerOk(k, ownerCat))',     // ownerOk returns the commitment check
    OWNER_READ: 'ownerOk(k, ownerCat)',                // input k has no token at all: the category read fails inside ownerOk
    MGR: 'managerAt0(managerHash)',
    TIME: 'require(tx.time >= int(manageAfter))',
};

const ownerNftIn = (t: Tok, k = OWNER) => ({ lock: k.lock, unlock: k.template.unlockP2PKH(), sats: 1_000n, tok: t });

export function run() {
    const b = bin();

    // ── B0 ─────────────────────────────────────────────────────────────────
    section('B0 · honest fills');
    expectAccept('buy 10 tokens at the ask (2,000): pay 20,000', trade(b, 1_000n, 100n, 21_000n, 90n));
    expectAccept('sell 10 tokens at the bid (1,990): take 19,900', trade(b, 100_000n, 0n, 80_100n, 10n));
    expectAccept('partial: buy 1 token', trade(b, 1_000n, 100n, 3_000n, 99n));
    expectAccept('full sweep: buy every token (the output carries no token)', trade(b, 1_000n, 100n, 201_000n, 0n));
    expectAccept('sell down to the 1,000-sat floor', trade(b, 100_500n, 0n, 1_000n, 50n));
    expectAccept('flip back: buy back the 50 tokens sold in', trade(b, 1_000n, 50n, 101_000n, 0n));
    expectAccept('top-up: sats only', trade(b, 5_000n, 10n, 6_000n, 10n));
    expectAccept('top-up: tokens only', trade(b, 5_000n, 10n, 5_000n, 20n));
    expectAccept('no-change recreate (harmless: manage timing no longer depends on age, D10)', trade(b, 5_000n, 10n, 5_000n, 10n));
    expectAccept('overpay a buy (the bin keeps the surplus)', trade(b, 1_000n, 100n, 21_500n, 90n));
    {
        const f = bin({ bidNum: 5n, bidDen: 3n, askNum: 7n, askDen: 3n });
        expectAccept('fractional ask 7/3: buy 2 paying ceil(14/3) = 5', trade(f, 1_000n, 10n, 1_005n, 8n));
        expectAccept('fractional bid 5/3: sell 2 taking floor(10/3) = 3', trade(f, 1_010n, 0n, 1_007n, 2n));
    }
    expectAccept('two bins of one position in one transaction, bins at inputs 1 and 2 (after a lead input)', () => balanced([
        binLeg(b, 1_000n, T(100n), 21_000n, T(90n)),
        binLeg(bin({ bidNum: 2010n, askNum: 2020n }), 1_000n, T(100n), 21_200n, T(90n)),
    ], { lead: { inp: { lock: TAKER.lock, unlock: TAKER.template.unlockP2PKH(), sats: 7_000n }, out: { to: TAKER.lock, sats: 6_000n } } }));
    expectAccept('sweep of 10 bins at rising asks', () => balanced(Array.from({ length: 10 }, (_, k) =>
        binLeg(bin({ bidNum: BigInt(1990 + 10 * k), askNum: BigInt(2000 + 10 * k) }), 1_000n, T(100n), 1_000n + 100n * BigInt(2000 + 10 * k), undefined))));
    expectAccept('buy from one bin and sell into another in one transaction', () => balanced([
        binLeg(b, 1_000n, T(100n), 21_000n, T(90n)),
        binLeg(bin({ bidNum: 2100n, askNum: 2200n }), 50_000n, undefined, 50_000n - 21_000n, T(10n)),
    ]));

    // ── B1 ─────────────────────────────────────────────────────────────────
    section('B1 · under-payment, rounding, extremes');
    expectReject('buy 10 paying 1 sat less', trade(b, 1_000n, 100n, 20_999n, 90n), { at: 0, rule: R.PRICE });
    expectReject('sell 10 taking 1 sat more', trade(b, 100_000n, 0n, 80_099n, 10n), { at: 0, rule: R.PRICE });
    expectReject('buy: pay for 10, take 11', trade(b, 1_000n, 100n, 21_000n, 89n), { at: 0, rule: R.PRICE });
    expectReject('sell: give 9, take the price of 10', trade(b, 100_000n, 0n, 80_100n, 9n), { at: 0, rule: R.PRICE });
    {
        const f = bin({ bidNum: 5n, bidDen: 3n, askNum: 7n, askDen: 3n });
        expectReject('fractional ask 7/3: buy 2 paying 4 (rounded down)', trade(f, 1_000n, 10n, 1_004n, 8n), { at: 0, rule: R.PRICE });
        expectReject('fractional bid 5/3: sell 2 taking 4 (rounded up)', trade(f, 1_010n, 0n, 1_006n, 2n), { at: 0, rule: R.PRICE });
    }
    {
        // Large products (~2^112): price 1 + 2^-62 sats per unit, 2^50 tokens.
        const big = bin({ bidNum: 1n << 62n, bidDen: (1n << 62n) + 1n, askNum: (1n << 62n) + 1n, askDen: 1n << 62n });
        const n = 1n << 50n;
        const cost = (n * ((1n << 62n) + 1n) + (1n << 62n) - 1n) / (1n << 62n);  // ceil
        expectAccept(`2^50 tokens at ask 1+2^-62: pay ceil = ${cost}`, trade(big, 1_000n, n, 1_000n + cost, 0n));
        expectReject('… paying 1 sat less', trade(big, 1_000n, n, 1_000n + cost - 1n, 0n), { at: 0, rule: R.PRICE });
    }
    {
        const tiny = bin({ bidNum: 1n, bidDen: (1n << 62n) + 1n, askNum: 1n, askDen: 1n << 62n });
        expectAccept('tiny ask 2^-62 sats per unit: 2^62 tokens for 1 sat', trade(tiny, 1_000n, 1n << 62n, 1_001n, 0n));
        expectReject('… for 0 sats', trade(tiny, 1_000n, 1n << 62n, 1_000n, 0n), { at: 0, rule: R.PRICE });
    }
    {
        const max = (1n << 63n) - 1n;
        expectAccept('bin holding the maximum token amount (2^63−1): buy 1', trade(b, 1_000n, max, 3_000n, max - 1n));
        const top = bin({ bidNum: max - 1n, askNum: max });
        expectAccept('maximum price (2^63−1 sats per unit): sell 0, top up 1 sat', trade(top, 1_000n, 1n, 1_001n, 1n));
    }

    // ── B2 ─────────────────────────────────────────────────────────────────
    section('B2 · value can only move at the bin\'s price');
    expectReject('both sides down', trade(b, 21_000n, 100n, 20_000n, 90n), { at: 0, rule: R.PRICE });
    expectReject('take tokens for nothing', trade(b, 1_000n, 100n, 1_000n, 90n), { at: 0, rule: R.PRICE });
    expectReject('drain the carrier sats of a token bin', trade(b, 5_000n, 100n, 4_000n, 100n), { at: 0, rule: R.PRICE });
    expectReject('drain sats from a BCH-only bin', trade(b, 50_000n, 0n, 49_000n, 0n), { at: 0, rule: R.PRICE });

    // ── B3 ─────────────────────────────────────────────────────────────────
    section('B3 · recreated with any field changed');
    const fields: Array<[string, Partial<BinV4Params>]> = [
        ['bidNum', { bidNum: 1991n }], ['bidDen', { bidDen: 2n, bidNum: 3980n, }], ['askNum', { askNum: 2001n }], ['askDen', { askDen: 2n, askNum: 4000n }],
        ['ownerCat', { ownerCat: TOKEN_B }], ['managerHash', { managerHash: '00'.repeat(32) }], ['manageAfter', { manageAfter: MANAGE_AFTER + 1 }],
        ['tokenCat', { tokenCat: TOKEN_B }],
    ];
    for (const [name, over] of fields) {
        expectReject(`recreated with a different ${name}`, trade(b, 1_000n, 100n, 21_000n, 90n, { outTo: lockOf(bin(over)) }), { at: 0, rule: R.SAME });
    }
    expectReject('recreated as the locked variant with the same parameters', trade(b, 1_000n, 100n, 21_000n, 90n, { outTo: lockOf(binOf({ ...BASE, variant: 'locked' }, net)) }), { at: 0, rule: R.SAME });
    expectReject('output paid to the attacker instead of the bin', trade(b, 1_000n, 100n, 21_000n, 90n, { outTo: ATTACKER.lock }), { at: 0, rule: R.SAME });

    // ── B4 ─────────────────────────────────────────────────────────────────
    section('B4 · foreign token categories');
    expectReject('bin input holding a foreign token cannot be filled', () => balanced([binLeg(b, 5_000n, tok(10n, TOKEN_FAKE), 5_000n, tok(10n, TOKEN_FAKE))]), { at: 0, rule: R.INCAT });
    expectReject('foreign token swapped out for the pair\'s token', () => balanced([binLeg(b, 5_000n, tok(10n, TOKEN_FAKE), 5_000n, tok(10n))]), { at: 0, rule: R.INCAT });
    expectReject('foreign token parked in the bin (sold at the bid)', () => balanced([binLeg(b, 50_000n, undefined, 50_000n - 19_900n, tok(10n, TOKEN_FAKE))]), { at: 0, rule: R.OUTCAT });
    expectReject('another pair\'s token added to a BCH-only bin', () => balanced([binLeg(b, 50_000n, undefined, 50_000n, tok(10n, TOKEN_B))]), { at: 0, rule: R.OUTCAT });

    // ── B5 ─────────────────────────────────────────────────────────────────
    section('B5 · no NFT on the bin');
    const withNft = (cap: 'none' | 'mutable' | 'minting', commitment: string, cat = TOKEN_A): Tok => ({ amount: 90n, category: cat, nft: { capability: cap, commitment } });
    expectReject('mutable NFT of the pair\'s category attached', () => balanced([binLeg(b, 1_000n, T(100n), 21_000n, withNft('mutable', ''))]), { at: 0, rule: R.OUTCAT });
    expectReject('minting NFT attached', () => balanced([binLeg(b, 1_000n, T(100n), 21_000n, withNft('minting', ''))]), { at: 0, rule: R.OUTCAT });
    expectReject('immutable NFT with a commitment attached', () => balanced([binLeg(b, 1_000n, T(100n), 21_000n, withNft('none', 'beef'))]), { at: 0, rule: R.COMMIT });
    expectAccept('documented: an immutable NFT with an EMPTY commitment is invisible to introspection and rides along (owner gets it)',
        () => balanced([binLeg(b, 1_000n, T(100n), 21_000n, withNft('none', ''))]));

    // ── B6 ─────────────────────────────────────────────────────────────────
    section('B6 · bin minimum (1,000 sats)');
    const cheap = bin({ bidNum: 1n, askNum: 1n });
    expectAccept('sell at bid 1 down to exactly 1,000 sats', trade(cheap, 1_500n, 0n, 1_000n, 500n));
    expectReject('sell at bid 1 down to 999 sats (price fine, minimum broken)', trade(cheap, 1_500n, 0n, 999n, 501n), { at: 0, rule: R.MIN });
    expectAccept('a bin under the minimum can be topped back up', trade(b, 800n, 0n, 1_000n, 0n));

    // ── B7 ─────────────────────────────────────────────────────────────────
    section('B7 · index pairing (two bins can never share an output)');
    expectReject('two identical bins, both values merged into output 0, output 1 to the attacker', () => balanced([
        binLeg(b, 1_000n, T(100n), 42_000n, T(80n)),
        binLeg(b, 1_000n, T(100n), 1_000n, T(100n), { outTo: ATTACKER.lock }),
    ]), { at: 1, rule: R.SAME });
    {
        const hi = bin({ bidNum: 2100n, askNum: 2200n });
        expectReject('two bins with their outputs swapped', () => balanced([
            binLeg(b, 1_000n, T(100n), 23_000n, T(90n), { outTo: lockOf(hi) }),
            binLeg(hi, 1_000n, T(100n), 21_000n, T(90n), { outTo: lockOf(b) }),
        ]), { at: 0, rule: R.SAME });
    }
    expectReject('bin recreated one index later (output 0 is the attacker\'s)', () => balanced(
        [{ ...binLeg(b, 1_000n, T(100n), 0n, undefined), noOutput: true }],
        { extraOuts: [{ to: ATTACKER.lock, sats: 1_000n }, { to: lockOf(b), sats: 21_000n, tok: T(90n) }] },
    ), { at: 0, rule: R.SAME });

    // ── B8 ─────────────────────────────────────────────────────────────────
    section('B8 · owner path (position NFT)');
    const withdraw = (nftTok: Tok, k = 1, holder = OWNER) => () => balanced(
        [{ lock: b.lockingBytecode, unlock: (b as any).unlock.owner(BigInt(k)), inS: 50_000n, inTok: T(100n), outS: 50_000n, outTok: T(100n), outTo: holder.lock }],
        { extraIns: [ownerNftIn(nftTok, holder)], party: holder },
    );
    expectAccept('mutable position NFT at input 1: withdraw everything', withdraw(nft(POS, 'mutable', POS_COMMIT)));
    expectAccept('immutable position NFT (downgraded) still owns the bin', withdraw(nft(POS, 'none', POS_COMMIT)));
    expectAccept('documented: a minting NFT of the category also passes (genesis must not leave one, N2)', withdraw(nft(POS, 'minting', POS_COMMIT)));
    expectReject('same commitment under another category', withdraw(nft(TOKEN_FAKE, 'mutable', POS_COMMIT), 1, ATTACKER), { at: 0, rule: R.OWNER_CAT });
    expectReject('a fungible token of the position category (no NFT)', withdraw(tok(1n, POS), 1, ATTACKER), { at: 0, rule: R.OWNER_COMMIT });
    expectAccept('mutable position NFT whose holder cleared the commitment still owns the bin (no self-lock)', withdraw(nft(POS, 'mutable', '')));
    expectReject('an IMMUTABLE position-category NFT with an empty commitment (indistinguishable from a fungible token)', withdraw(nft(POS, 'none', ''), 1, ATTACKER), { at: 0, rule: R.OWNER_COMMIT });
    expectReject('a fungible amount plus an immutable empty-commitment NFT of the category', withdraw({ amount: 5n, category: POS, nft: { capability: 'none', commitment: '' } }, 1, ATTACKER), { at: 0, rule: R.OWNER_COMMIT });
    expectReject('k points at an input without the NFT', withdraw(nft(POS, 'mutable', POS_COMMIT), 2), { at: 0, rule: R.OWNER_READ, reason: /OP_SPLIT|invalid transaction UTXO index/ });
    expectReject('k out of range', withdraw(nft(POS, 'mutable', POS_COMMIT), 9), { at: 0, rule: R.OWNER_READ, reason: /OP_SPLIT|invalid transaction UTXO index/ });
    expectReject('k points at the bin itself', withdraw(nft(POS, 'mutable', POS_COMMIT), 0), { at: 0, rule: R.OWNER_CAT });
    expectReject('NFT only created in an output, not spent', () => balanced(
        [{ lock: b.lockingBytecode, unlock: (b as any).unlock.owner(1n), inS: 50_000n, inTok: T(100n), outS: 50_000n, outTok: T(100n), outTo: ATTACKER.lock }],
        { extraIns: [{ lock: ATTACKER.lock, unlock: ATTACKER.template.unlockP2PKH(), sats: 2_000n }], extraOuts: [{ to: ATTACKER.lock, sats: 1_000n, tok: nft(POS, 'mutable', POS_COMMIT) }], party: ATTACKER },
    ), { at: 0, rule: R.OWNER_READ, reason: /OP_SPLIT|invalid transaction UTXO index/ });
    expectAccept('owner reprices: withdraws and recreates the bin at a new price in one transaction', () => balanced(
        [{ lock: b.lockingBytecode, unlock: (b as any).unlock.owner(1n), inS: 50_000n, inTok: T(100n), outS: 50_000n, outTok: T(100n), outTo: lockOf(bin({ bidNum: 2050n, askNum: 2060n })) }],
        { extraIns: [ownerNftIn(nft(POS, 'mutable', POS_COMMIT))], party: OWNER },
    ));

    // ── B9 ─────────────────────────────────────────────────────────────────
    section('B9 · manage path');
    const mgrIn = (m = MANAGER) => ({ inp: { lock: m.lockingBytecode, unlock: (m as any).unlock.go(), sats: 1_000n }, out: { to: KEEPER.lock, sats: 1_000n } });
    const manageLeg = (c = b, more: Partial<Leg> = {}): Leg => ({ lock: c.lockingBytecode, unlock: (c as any).unlock.manage(), inS: 50_000n, inTok: T(100n), outS: 50_000n, outTok: T(100n), outTo: KEEPER.lock, ...more });
    expectAccept('manager at input 0, locktime = manageAfter', () => balanced([manageLeg()], { lead: mgrIn(), locktime: MANAGE_AFTER, party: KEEPER }));
    expectAccept('… locktime after manageAfter', () => balanced([manageLeg()], { lead: mgrIn(), locktime: MANAGE_AFTER + 50, party: KEEPER }));
    expectReject('locktime one block before manageAfter', () => balanced([manageLeg()], { lead: mgrIn(), locktime: MANAGE_AFTER - 1, party: KEEPER }), { at: 1, rule: R.TIME });
    expectReject('locktime given as a time, not a height', () => balanced([manageLeg()], { lead: mgrIn(), locktime: 1_800_000_000, party: KEEPER }), { at: 1, rule: R.TIME });
    expectReject('final sequence number (locktime disabled)', () => balanced([manageLeg(b, { sequence: 0xffffffff })], { lead: mgrIn(), locktime: MANAGE_AFTER, party: KEEPER }), { at: 1, rule: R.TIME });
    expectReject('no manager at input 0 (the bin at 0)', () => balanced([manageLeg()], { extraIns: [mgrIn().inp], locktime: MANAGE_AFTER, party: ATTACKER }), { at: 0, rule: R.MGR });
    expectReject('a fake manager (another script) at input 0', () => balanced([manageLeg()], { lead: mgrIn(stub('ee')), locktime: MANAGE_AFTER, party: ATTACKER }), { at: 1, rule: R.MGR });
    expectReject('a bin with no manager (zero hash) can\'t be managed', () => balanced([manageLeg(bin({ managerHash: undefined }))], { lead: mgrIn(), locktime: MANAGE_AFTER, party: KEEPER }), { at: 1, rule: R.MGR });

    section('Sizes');
    const redeem = binArtifact().debug.bytecode.length / 2;
    check('MeshBinV4 body size is the one in the spec (167 B)', redeem === 167, `${redeem} B`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
    summary('MeshBinV4 B0–B9');
}
