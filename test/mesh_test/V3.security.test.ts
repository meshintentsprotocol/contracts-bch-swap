/**
 * MeshPoolV3 security suite (offline, MockNetworkProvider + VM debug).
 *
 * Layout used below: pool at input 0 → recreated at output 0; with N inputs the
 * pool's proceeds slot is output N (j = i + tx.inputs.length).
 *
 * Usage: npx tsx test/mesh_test/V3.security.test.ts
 */
import { MockNetworkProvider, TransactionBuilder } from 'cashscript';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    OWNER, TAKER, ATTACKER, TOKEN_PUSD, TOKEN_MUSD, TOKEN_FAKE,
    p2pkh, provider, fakeTxid, expectAccept, expectReject, section, summary, resetStats,
} from './_mesh_security_harness.js';
import { BCH, PREFIX_LEN, v3Contract, p2sh32Hash, redeemBytes, type V3Params } from './v3_encode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const V3 = JSON.parse(readFileSync(join(ROOT, 'artifacts', 'MeshPoolV3.json'), 'utf-8'));
const net = provider();
const tb = () => new TransactionBuilder({ provider: net });
const tok = (amount: bigint, category = TOKEN_PUSD) => ({ amount, category });
const utxo = (satoshis: bigint, token?: { amount: bigint; category: string; nft?: any }) =>
    ({ txid: fakeTxid(), vout: 0, satoshis, ...(token ? { token } : {}) });
const toOwner = p2pkh(OWNER.pkh);
const toTaker = p2pkh(TAKER.pkh);
const toAttacker = p2pkh(ATTACKER.pkh);
const out = (amountIn: bigint, num: bigint, den: bigint, fee = 30n) => (amountIn * num * (10000n - fee)) / (den * 10000n);

const pool = (p: Omit<V3Params, 'ownerPkh'> & { ownerPkh?: Uint8Array }) => v3Contract(V3, { ownerPkh: OWNER.pkh, ...p }, net);

function main() {
    resetStats();

    // ── Encoding invariants ────────────────────────────────────────────────
    section('Encoding: constant 300-byte parameter prefix, one template body');
    {
        const a = pool({ reserve: BCH, slots: [{ cat: TOKEN_PUSD, num: 2000n, den: 1n }], feeBps: 30, mode: 0 });
        const b = pool({ reserve: TOKEN_PUSD, slots: [{ cat: BCH, num: 1n, den: 2100n, rNum: 7n, rDen: 9n }, { cat: TOKEN_MUSD, num: 3n, den: 4n }], feeBps: 9999, mode: 2 });
        const ra = redeemBytes(a); const rb = redeemBytes(b);
        const bodyA = Buffer.from(ra.slice(PREFIX_LEN)).toString('hex');
        const bodyB = Buffer.from(rb.slice(PREFIX_LEN)).toString('hex');
        const ok = ra.length === rb.length && bodyA === bodyB && ra.length - PREFIX_LEN === ra.length - 300;
        console.log(`  ${ok ? '✅' : '❌'} prefix is ${PREFIX_LEN} bytes for any params; template body identical (${ra.length} B redeem script)`);
        if (!ok) process.exitCode = 1;
    }

    // ── S1: BCH reserve, accepts pUSD, proceeds to owner ────────────────────
    section('S1 · BCH reserve → accepts pUSD @ 2000 sats/unit, 30 bps, proceeds to owner');
    const s1 = pool({ reserve: BCH, slots: [{ cat: TOKEN_PUSD, num: 2000n, den: 1n }], feeBps: 30, mode: 0 });
    const R = 100_000n;
    const o10 = out(10n, 2000n, 1n); // 19,940
    const s1Fill = (opts: { take?: bigint; pay?: bigint; payCat?: string; proceedsTo?: Uint8Array; swap?: boolean; poolToken?: bigint; poolIn?: any; payNft?: 'none' | 'mutable'; poolOut?: bigint } = {}) => () => {
        const pay = opts.pay ?? 10n;
        const take = opts.take ?? o10;
        const payTok = { ...tok(pay, opts.payCat ?? TOKEN_PUSD), ...(opts.payNft ? { nft: { capability: opts.payNft, commitment: '' } } : {}) };
        const b = tb();
        b.addInput(opts.poolIn ?? utxo(R), s1.unlock.fill());
        b.addInput(utxo(5_000n, payTok), TAKER.template.unlockP2PKH());
        const poolOut = { to: opts.poolToken ? s1.tokenAddress : s1.address, amount: opts.poolOut ?? R - take, ...(opts.poolToken ? { token: tok(opts.poolToken) } : {}) };
        const taker = { to: toTaker, amount: take + 3_000n };
        const proceeds = { to: opts.proceedsTo ?? toOwner, amount: 1_000n, token: payTok };
        b.addOutput(poolOut);
        if (opts.swap) { b.addOutput(proceeds); b.addOutput(taker); } else { b.addOutput(taker); b.addOutput(proceeds); }
        return b;
    };
    expectAccept('honest: pay 10 pUSD to the owner at the proceeds slot, take 19,940 sats', s1Fill());
    expectReject('DRAIN: pay 1 pUSD, take the reserve', s1Fill({ pay: 1n, take: R - 1_000n }));
    expectReject('over-take by 1 sat', s1Fill({ take: o10 + 1n }));
    expectReject('proceeds sent to the attacker instead of the owner', s1Fill({ proceedsTo: toAttacker }));
    expectReject('proceeds at the wrong output index', s1Fill({ swap: true }));
    expectReject('pay with a token the pool does not accept', s1Fill({ payCat: TOKEN_FAKE }));
    expectReject('pay with a mutable NFT of the accepted category', s1Fill({ payNft: 'mutable' }));
    expectReject('pay with an NFT only (no fungible amount)', s1Fill({ payNft: 'none', pay: 0n, take: 1_000n }));
    expectAccept('immutable NFT riding along with a full fungible payment (LP gets it as an extra)', s1Fill({ payNft: 'none' }));
    expectReject('park tokens in the BCH reserve (recreated pool carries a token)', s1Fill({ poolToken: 5n }));
    expectReject('pool UTXO carrying a stray token cannot be filled', s1Fill({ poolIn: utxo(R, tok(3n)) }));
    expectReject('reserve recreated below 1000 sats', s1Fill({ take: R - 999n, pay: 1_000n }));
    expectReject('pay in the reserve asset (BCH proceeds to a BCH pool)', () => {
        const b = tb();
        b.addInput(utxo(R), s1.unlock.fill());
        b.addInput(utxo(40_000n), TAKER.template.unlockP2PKH());
        b.addOutput({ to: s1.address, amount: R - o10 });
        b.addOutput({ to: toTaker, amount: o10 });
        b.addOutput({ to: toOwner, amount: 30_000n });
        return b;
    });
    expectReject('recreate as a different covenant (fee 0)', () => {
        const t = pool({ reserve: BCH, slots: [{ cat: TOKEN_PUSD, num: 2000n, den: 1n }], feeBps: 0, mode: 0 });
        const b = tb();
        b.addInput(utxo(R), s1.unlock.fill());
        b.addInput(utxo(5_000n, tok(10n)), TAKER.template.unlockP2PKH());
        b.addOutput({ to: t.address, amount: R - o10 });
        b.addOutput({ to: toTaker, amount: o10 + 3_000n });
        b.addOutput({ to: toOwner, amount: 1_000n, token: tok(10n) });
        return b;
    });
    expectReject('two pools, one payment: second proceeds slot goes to the attacker', () => {
        const b = tb();
        b.addInput(utxo(R), s1.unlock.fill());                                      // [0] → proceeds [3]
        b.addInput(utxo(R), s1.unlock.fill());                                      // [1] → proceeds [4]
        b.addInput(utxo(5_000n, tok(10n)), ATTACKER.template.unlockP2PKH());        // [2]
        b.addOutput({ to: s1.address, amount: R - o10 });
        b.addOutput({ to: s1.address, amount: R - o10 });
        b.addOutput({ to: toAttacker, amount: 2n * o10 + 3_000n });
        b.addOutput({ to: toOwner, amount: 1_000n, token: tok(10n) });
        b.addOutput({ to: toAttacker, amount: 1_000n });
        return b;
    });
    expectReject('two pools, one payment: second proceeds slot missing', () => {
        const b = tb();
        b.addInput(utxo(R), s1.unlock.fill());
        b.addInput(utxo(R), s1.unlock.fill());
        b.addInput(utxo(5_000n, tok(10n)), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: s1.address, amount: R - o10 });
        b.addOutput({ to: s1.address, amount: R - o10 });
        b.addOutput({ to: toAttacker, amount: 2n * o10 + 3_000n });
        b.addOutput({ to: toOwner, amount: 1_000n, token: tok(10n) });
        return b;
    });
    expectAccept('two pools in one tx, each paid at its own proceeds slot', () => {
        const b = tb();
        b.addInput(utxo(R), s1.unlock.fill());
        b.addInput(utxo(R), s1.unlock.fill());
        b.addInput(utxo(6_000n, tok(20n)), TAKER.template.unlockP2PKH());
        b.addOutput({ to: s1.address, amount: R - o10 });
        b.addOutput({ to: s1.address, amount: R - o10 });
        b.addOutput({ to: toTaker, amount: 2n * o10 + 3_000n });
        b.addOutput({ to: toOwner, amount: 1_000n, token: tok(10n) });
        b.addOutput({ to: toOwner, amount: 1_000n, token: tok(10n) });
        return b;
    });
    expectAccept('owner docks', () => {
        const b = tb();
        b.addInput(utxo(R), s1.unlock.dock(OWNER.pub, OWNER.template));
        b.addOutput({ to: toOwner, amount: R - 1_000n });
        return b;
    });
    expectReject('attacker cannot dock', () => {
        const b = tb();
        b.addInput(utxo(R), s1.unlock.dock(ATTACKER.pub, ATTACKER.template));
        b.addOutput({ to: toAttacker, amount: R - 1_000n });
        return b;
    });
    expectReject('needs the 2025 VM limits (redeem script > 520 bytes)', () => {
        const old = new MockNetworkProvider({ vmTarget: 'BCH_2023_05' as any });
        const p = v3Contract(V3, { ownerPkh: OWNER.pkh, reserve: BCH, slots: [{ cat: TOKEN_PUSD, num: 2000n, den: 1n }], feeBps: 30, mode: 0 }, old);
        const b = new TransactionBuilder({ provider: old });
        b.addInput(utxo(R), p.unlock.fill());
        b.addInput(utxo(5_000n, tok(10n)), TAKER.template.unlockP2PKH());
        b.addOutput({ to: p.address, amount: R - o10 });
        b.addOutput({ to: toTaker, amount: o10 + 3_000n });
        b.addOutput({ to: toOwner, amount: 1_000n, token: tok(10n) });
        return b;
    });

    // ── S2: multi-pair — one BCH reserve, three accepted tokens ─────────────
    section('S2 · multi-pair: BCH reserve accepts pUSD @2000, mUSD @1990, FAKE @0.09 sats/unit');
    const s2 = pool({ reserve: BCH, feeBps: 30, mode: 0, slots: [
        { cat: TOKEN_PUSD, num: 2000n, den: 1n }, { cat: TOKEN_MUSD, num: 1990n, den: 1n }, { cat: TOKEN_FAKE, num: 9n, den: 100n },
    ] });
    const s2Fill = (payCat: string, pay: bigint, take: bigint) => () => {
        const b = tb();
        b.addInput(utxo(R), s2.unlock.fill());
        b.addInput(utxo(5_000n, tok(pay, payCat)), TAKER.template.unlockP2PKH());
        b.addOutput({ to: s2.address, amount: R - take });
        b.addOutput({ to: toTaker, amount: take + 3_000n });
        b.addOutput({ to: toOwner, amount: 1_000n, token: tok(pay, payCat) });
        return b;
    };
    expectAccept('pay 10 pUSD at the pUSD price (19,940 sats)', s2Fill(TOKEN_PUSD, 10n, out(10n, 2000n, 1n)));
    expectAccept('pay 10 mUSD at the mUSD price (19,840 sats)', s2Fill(TOKEN_MUSD, 10n, out(10n, 1990n, 1n)));
    expectAccept('pay 100,000 FAKE at its price (8,973 sats)', s2Fill(TOKEN_FAKE, 100_000n, out(100_000n, 9n, 100n)));
    expectReject('pay mUSD but take at the (better) pUSD price', s2Fill(TOKEN_MUSD, 10n, out(10n, 2000n, 1n)));
    expectReject('pay an unaccepted token', s2Fill('ab'.repeat(32), 10n, 1_000n));

    // ── S3: token reserve accepting BCH ─────────────────────────────────────
    section('S3 · pUSD reserve → accepts BCH @ 1/2100 units per sat, proceeds to owner');
    const s3 = pool({ reserve: TOKEN_PUSD, slots: [{ cat: BCH, num: 1n, den: 2100n }], feeBps: 30, mode: 0 });
    const TR = 400n;
    const o21k = out(21_000n, 1n, 2100n); // 9
    const s3Fill = (opts: { give?: bigint; poolSats?: bigint; paySats?: bigint; proceedsTo?: Uint8Array; payToken?: boolean } = {}) => () => {
        const give = opts.give ?? o21k;
        const pay = opts.paySats ?? 21_000n;
        const b = tb();
        b.addInput(utxo(1_000n, tok(TR)), s3.unlock.fill());
        b.addInput(utxo(40_000n, opts.payToken ? tok(10n) : undefined), TAKER.template.unlockP2PKH());
        b.addOutput({ to: s3.tokenAddress, amount: opts.poolSats ?? 1_000n, token: tok(TR - give) });
        b.addOutput({ to: toTaker, amount: 1_000n, token: tok(give + (opts.payToken ? 10n : 0n)) });
        b.addOutput(opts.payToken ? { to: toOwner, amount: 1_000n, token: tok(10n) } : { to: opts.proceedsTo ?? toOwner, amount: pay });
        return b;
    };
    expectAccept('honest: pay 21,000 sats to the owner, take 9 pUSD', s3Fill());
    expectReject('over-take 1 pUSD unit', s3Fill({ give: o21k + 1n }));
    expectReject('leak the pool carrier sats (1000 → 500)', s3Fill({ poolSats: 500n }));
    expectReject('BCH proceeds to the attacker', s3Fill({ proceedsTo: toAttacker }));
    expectReject('pay in the reserve token', s3Fill({ payToken: true, give: 5n }));
    expectReject('DRAIN: take 399 pUSD paying 1 sat', s3Fill({ give: TR - 1n, paySats: 1_000n }));

    // ── S4: token ↔ token ───────────────────────────────────────────────────
    section('S4 · token↔token: mUSD reserve → accepts pUSD @ 100 mUSD units per pUSD unit');
    const s4 = pool({ reserve: TOKEN_MUSD, slots: [{ cat: TOKEN_PUSD, num: 100n, den: 1n }], feeBps: 30, mode: 0 });
    const M = 5_000n;
    const o4 = out(10n, 100n, 1n); // 997
    const s4Fill = (payCat: string, give: bigint, payBch = false) => () => {
        const b = tb();
        b.addInput(utxo(1_000n, tok(M, TOKEN_MUSD)), s4.unlock.fill());
        b.addInput(utxo(30_000n, payBch ? undefined : tok(10n, payCat)), TAKER.template.unlockP2PKH());
        b.addOutput({ to: s4.tokenAddress, amount: 1_000n, token: tok(M - give, TOKEN_MUSD) });
        b.addOutput({ to: toTaker, amount: 1_000n, token: tok(give + (payCat === TOKEN_MUSD && !payBch ? 10n : 0n), TOKEN_MUSD) });
        b.addOutput(payBch ? { to: toOwner, amount: 20_000n } : { to: toOwner, amount: 1_000n, token: tok(10n, payCat) });
        return b;
    };
    expectAccept('honest: pay 10 pUSD, take 997 mUSD', s4Fill(TOKEN_PUSD, o4));
    expectReject('over-take 1 mUSD unit', s4Fill(TOKEN_PUSD, o4 + 1n));
    expectReject('pay in the reserve token (mUSD)', s4Fill(TOKEN_MUSD, 500n));
    expectReject('pay BCH (not accepted)', s4Fill(TOKEN_PUSD, 100n, true));

    // ── S5: mode 1 — proceeds to a fixed reverse pool ───────────────────────
    section('S5 · mode 1: BCH reserve sells for pUSD; pUSD proceeds fund a fixed reverse pool');
    const reverse = pool({ reserve: TOKEN_PUSD, slots: [{ cat: BCH, num: 1n, den: 2100n }], feeBps: 30, mode: 0 });
    const s5 = pool({ reserve: BCH, slots: [{ cat: TOKEN_PUSD, num: 2000n, den: 1n }], feeBps: 30, mode: 1, proceedsHash: p2sh32Hash(reverse.address) });
    const s5Fill = (to: string | Uint8Array) => () => {
        const b = tb();
        b.addInput(utxo(R), s5.unlock.fill());
        b.addInput(utxo(5_000n, tok(10n)), TAKER.template.unlockP2PKH());
        b.addOutput({ to: s5.address, amount: R - o10 });
        b.addOutput({ to: toTaker, amount: o10 + 3_000n });
        b.addOutput({ to, amount: 1_000n, token: tok(10n) });
        return b;
    };
    expectAccept('proceeds become a UTXO of the reverse pool', s5Fill(reverse.tokenAddress));
    expectReject('proceeds to the owner instead of the committed reverse pool', s5Fill(toOwner));
    expectReject('proceeds to a different pool (attacker-chosen price)', s5Fill(
        pool({ reserve: TOKEN_PUSD, slots: [{ cat: BCH, num: 1n, den: 1n }], feeBps: 30, mode: 0 }).tokenAddress));

    summary('MeshPoolV3 security');
}

main();
