/**
 * MeshBinV4 option variants, case B10 of v4plan 03 §2.1:
 *   locked (no owner path), vesting (owner path from a height),
 *   fee schedule by height, size-based fee.
 *
 * Usage: npx tsx test/MeshBinV4.options.test.ts
 */
import { fileURLToPath } from 'url';
import { encodeDataPush, hexToBin } from '@bitauth/libauth';
import type { Unlocker } from 'cashscript';
import { OWNER, KEEPER, ATTACKER, net, tok, nft, expectAccept, expectReject, check, section, summary, type Tok } from './harness.js';
import { balanced, binLeg, type Leg } from './tx.js';
import { binOf, binArtifact, type BinV4Params } from './v4_encode.js';
import { BASE, POS, POS_COMMIT, MANAGER, MANAGE_AFTER } from './MeshBinV4.test.js';

const T = (a: bigint): Tok | undefined => (a > 0n ? tok(a) : undefined);
const of = (over: Partial<BinV4Params>) => binOf({ ...BASE, ...over }, net);
const ownerNft = (holder = OWNER) => ({ lock: holder.lock, unlock: holder.template.unlockP2PKH(), sats: 1_000n, tok: nft(POS, 'mutable', POS_COMMIT) });

/** Unlocking bytecode that selects function `index` with no arguments (for paths an ABI doesn't offer). */
const rawSelector = (c: { bytecode: string }, index: number): Unlocker => ({
    generateUnlockingBytecode: () => Uint8Array.from([0x50 + index, ...encodeDataPush(hexToBin(c.bytecode))]),
});

export function run() {
    // ── Locked ─────────────────────────────────────────────────────────────
    section('B10 · locked: no owner path');
    const locked = of({ variant: 'locked' });
    check('the locked ABI has no owner function', !binArtifact('locked').abi.some((f: any) => f.name === 'owner'), binArtifact('locked').abi.map((f: any) => f.name).join(', '));
    expectAccept('honest buy', () => balanced([binLeg(locked, 1_000n, T(100n), 21_000n, T(90n))]));
    expectReject('the owner, holding the NFT, tries to withdraw through fill()', () => balanced(
        [{ ...binLeg(locked, 50_000n, T(100n), 50_000n, T(100n)), outTo: OWNER.lock }],
        { extraIns: [ownerNft()], party: OWNER }), { at: 0, rule: 'require(tx.outputs[i].lockingBytecode == tx.inputs[i].lockingBytecode)' });
    expectReject('a hand-made unlocking that selects function 2 (owner in the default bin)', () => balanced(
        [{ lock: locked.lockingBytecode, unlock: rawSelector(locked, 2), inS: 50_000n, inTok: T(100n), outS: 50_000n, outTok: T(100n), outTo: OWNER.lock }],
        { extraIns: [ownerNft()], party: OWNER }), { at: 0, reason: /NUMEQUALVERIFY|VERIFY/ });
    {
        const lead = { inp: { lock: MANAGER.lockingBytecode, unlock: (MANAGER as any).unlock.go(), sats: 1_000n }, out: { to: KEEPER.lock, sats: 1_000n } };
        expectAccept('the manager can still move a locked bin', () => balanced(
            [{ lock: locked.lockingBytecode, unlock: (locked as any).unlock.manage(), inS: 50_000n, inTok: T(100n), outS: 50_000n, outTok: T(100n), outTo: KEEPER.lock }],
            { lead, locktime: MANAGE_AFTER, party: KEEPER }));
    }

    // ── Vesting ────────────────────────────────────────────────────────────
    section('B10 · vesting: owner path from unlockHeight');
    const UNLOCK = 950_000;
    const vest = of({ variant: 'vesting', unlockHeight: UNLOCK });
    const vestWithdraw = (locktime: number, holder = OWNER, nftTok: Tok = nft(POS, 'mutable', POS_COMMIT)) => () => balanced(
        [{ lock: vest.lockingBytecode, unlock: (vest as any).unlock.owner(1n), inS: 50_000n, inTok: T(100n), outS: 50_000n, outTok: T(100n), outTo: holder.lock }],
        { extraIns: [{ ...ownerNft(holder), tok: nftTok }], party: holder, locktime });
    expectReject('withdraw one block before unlockHeight', vestWithdraw(UNLOCK - 1), { at: 0, rule: 'require(tx.time >= int(unlockHeight))' });
    expectAccept('withdraw at unlockHeight', vestWithdraw(UNLOCK));
    expectReject('after unlockHeight without the NFT', vestWithdraw(UNLOCK + 10, ATTACKER, tok(1n, POS)), { at: 0, rule: 'require(ownerOk(k, ownerCat))' });
    expectAccept('trading is not locked while vesting', () => balanced([binLeg(vest, 1_000n, T(100n), 21_000n, T(90n))]));

    // ── Fee schedule ───────────────────────────────────────────────────────
    section('B10 · fee schedule by height (500 → 100 bps at h1 → 30 bps at h2)');
    const H1 = 900_100, H2 = 901_000;
    const fs = of({ variant: 'feeSchedule', fees: { fee0: 500, h1: H1, fee1: 100, h2: H2, fee2: 30 } });
    const PRICE = 'require(ds * d * 10000 + dt * n * mul >= 0)';
    const buy = (tier: bigint, pay: bigint, locktime?: number, more: Partial<Leg> = {}) => () => balanced(
        [binLeg(fs, 1_000n, T(100n), 1_000n + pay, T(90n), { unlock: (fs as any).unlock.fill(tier), ...more })], locktime !== undefined ? { locktime } : {});
    const sell = (tier: bigint, take: bigint, locktime?: number) => () => balanced(
        [binLeg(fs, 100_000n, undefined, 100_000n - take, T(10n), { unlock: (fs as any).unlock.fill(tier) })], locktime !== undefined ? { locktime } : {});
    // 10 tokens at ask 2,000: 20,000 × (1 + fee); at bid 1,990: 19,900 × (1 − fee)
    expectAccept('tier 0 (5 %): buy 10 paying 21,000', buy(0n, 21_000n));
    expectReject('tier 0: paying 20,999', buy(0n, 20_999n), { at: 0, rule: PRICE });
    expectAccept('tier 0: sell 10 taking 18,905', sell(0n, 18_905n));
    expectReject('tier 0: taking 18,906', sell(0n, 18_906n), { at: 0, rule: PRICE });
    expectReject('tier 1 (1 %) before h1', buy(1n, 20_200n, H1 - 1), { at: 0, rule: 'require(tx.time >= int(h1))' });
    expectAccept('tier 1 at h1: buy 10 paying 20,200', buy(1n, 20_200n, H1));
    expectReject('tier 1 at h1: paying 20,199', buy(1n, 20_199n, H1), { at: 0, rule: PRICE });
    expectReject('tier 2 (0.3 %) between h1 and h2', buy(2n, 20_060n, H2 - 1), { at: 0, rule: 'require(tx.time >= int(h2))' });
    expectAccept('tier 2 at h2: buy 10 paying 20,060', buy(2n, 20_060n, H2));
    expectAccept('tier 2 at h2: sell 10 taking 19,840', sell(2n, 19_840n, H2));
    expectReject('tier 2 at h2: taking 19,841', sell(2n, 19_841n, H2), { at: 0, rule: PRICE });
    expectReject('tier 3 does not exist', buy(3n, 30_000n, H2), { at: 0, rule: 'require(tier == 0)' });
    expectReject('tier 1 claimed with a final sequence (locktime disabled)', buy(1n, 20_200n, H1, { sequence: 0xffffffff }), { at: 0, reason: /locktime is disabled/ });

    // ── Size fee ───────────────────────────────────────────────────────────
    section('B10 · size fee (10 bps + 50 bps per 1,000 tokens above 1,000; cap 300 bps)');
    const sf = of({ variant: 'sizeFee', sizeFee: { baseFee: 10, slope: 50, refSize: 1_000n, maxFee: 300 } });
    const SPRICE = 'require(ds * d * 10000 * ref + dt * n * mul >= 0)';
    const sbuy = (qty: bigint, pay: bigint) => () => balanced([binLeg(sf, 1_000n, T(200_000n), 1_000n + pay, T(200_000n - qty))]);
    const ssell = (qty: bigint, take: bigint) => () => balanced([binLeg(sf, 400_000_000n, undefined, 400_000_000n - take, T(qty))]);
    // 500 tokens: fee 10 bps → 1,000,000 × 1.001
    expectAccept('500 tokens (under the reference): 10 bps → pay 1,001,000', sbuy(500n, 1_001_000n));
    expectReject('… paying 1,000,999', sbuy(500n, 1_000_999n), { at: 0, rule: SPRICE });
    // 3,000 tokens: excess 2,000 → 10 + 50 × 2 = 110 bps → 6,000,000 × 1.011 = 6,066,000
    expectAccept('3,000 tokens: 110 bps → pay 6,066,000', sbuy(3_000n, 6_066_000n));
    expectReject('3,000 tokens under-charged at the base fee only (6,006,000)', sbuy(3_000n, 6_006_000n), { at: 0, rule: SPRICE });
    expectReject('3,000 tokens: paying 1 sat less', sbuy(3_000n, 6_065_999n), { at: 0, rule: SPRICE });
    // 1,500 tokens: excess 500 → 10 + 50 × 0.5 = 35 bps → 3,000,000 × 1.0035 = 3,010,500 (fractional slope stays exact)
    expectAccept('1,500 tokens: 35 bps → pay 3,010,500', sbuy(1_500n, 3_010_500n));
    expectReject('… paying 3,010,499', sbuy(1_500n, 3_010_499n), { at: 0, rule: SPRICE });
    // 100,000 tokens: 10 + 50 × 99 = 4,960 → capped at 300 bps → 200,000,000 × 1.03
    expectAccept('100,000 tokens: capped at 300 bps → pay 206,000,000', sbuy(100_000n, 206_000_000n));
    expectReject('… paying 205,999,999', sbuy(100_000n, 205_999_999n), { at: 0, rule: SPRICE });
    // Sells: 3,000 at bid 1,990 → 5,970,000 × (1 − 0.011) = 5,904,330
    expectAccept('sell 3,000 tokens: 110 bps → take 5,904,330', ssell(3_000n, 5_904_330n));
    expectReject('… taking 5,904,331', ssell(3_000n, 5_904_331n), { at: 0, rule: SPRICE });
    expectAccept('top-up pays no fee', () => balanced([binLeg(sf, 1_000n, T(10n), 2_000n, T(10n))]));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
    summary('MeshBinV4 B10 options');
}
