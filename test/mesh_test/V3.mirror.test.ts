/**
 * MeshPoolV3 mirror mode (proceedsMode 2): closed-loop recycling.
 *
 * A mode-2 pool rebuilds the reverse pool of the matched slot from its own
 * bytecode at run time and requires the proceeds to go there. The reverse pool
 * is itself mode 2, and its mirror is the original pool, so capital cycles
 * forward → reverse → forward with every price enforced on-chain.
 *
 * Usage: npx tsx test/mesh_test/V3.mirror.test.ts
 */
import { TransactionBuilder } from 'cashscript';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    OWNER, TAKER, ATTACKER, TOKEN_PUSD, TOKEN_MUSD,
    p2pkh, provider, fakeTxid, expectAccept, expectReject, section, summary, resetStats,
} from './_mesh_security_harness.js';
import { binToHex } from '@bitauth/libauth';
import { BCH, PREFIX_LEN, v3Contract, mirrorOf, redeemBytes, type V3Params } from './v3_encode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const V3 = JSON.parse(readFileSync(join(ROOT, 'artifacts', 'MeshPoolV3.json'), 'utf-8'));
const net = provider();
const tb = () => new TransactionBuilder({ provider: net });
const tok = (amount: bigint, category = TOKEN_PUSD) => ({ amount, category });
const utxo = (satoshis: bigint, token?: { amount: bigint; category: string }) => ({ txid: fakeTxid(), vout: 0, satoshis, ...(token ? { token } : {}) });
const out = (amountIn: bigint, num: bigint, den: bigint, fee = 30n) => (amountIn * num * (10000n - fee)) / (den * 10000n);
const c = (p: V3Params) => v3Contract(V3, p, net);
let infoFailures = 0;
const check = (name: string, ok: boolean) => { console.log(`  ${ok ? '✅' : '❌'} ${name}`); if (!ok) infoFailures++; };

function main() {
    resetStats();
    const R = 100_000n;

    // LP buys pUSD at 2000 sats/unit (forward sells BCH) and sells it back at 2200 sats/unit (reverse).
    const fwdP: V3Params = { ownerPkh: OWNER.pkh, reserve: BCH, feeBps: 30, mode: 2,
        slots: [{ cat: TOKEN_PUSD, num: 2000n, den: 1n, rNum: 1n, rDen: 2200n }] };
    const fwd = c(fwdP);
    const rev = c(mirrorOf(fwdP));
    const back = c(mirrorOf(mirrorOf(fwdP)));

    section('Derivation (off-chain encoder)');
    check('mirror of the mirror is the original pool (same address)', back.address === fwd.address);
    check('the reverse pool is a different address', rev.address !== fwd.address);
    const [fb, rb] = [redeemBytes(fwd), redeemBytes(rev)];
    check(`redeem scripts share the template body after the ${PREFIX_LEN}-byte prefix`,
        fb.length === rb.length && binToHex(fb.slice(PREFIX_LEN)) === binToHex(rb.slice(PREFIX_LEN)));

    section('Forward (BCH reserve) → proceeds must fund its mirror');
    const o10 = out(10n, 2000n, 1n);
    const fwdFill = (to: string | Uint8Array) => () => {
        const b = tb();
        b.addInput(utxo(R), fwd.unlock.fill());
        b.addInput(utxo(5_000n, tok(10n)), TAKER.template.unlockP2PKH());
        b.addOutput({ to: fwd.address, amount: R - o10 });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: o10 + 3_000n });
        b.addOutput({ to, amount: 1_000n, token: tok(10n) });
        return b;
    };
    expectAccept('on-chain derivation matches: 10 pUSD proceeds fund the reverse pool', fwdFill(rev.tokenAddress));
    expectReject('proceeds to the owner (mode 2 requires the mirror)', fwdFill(p2pkh(OWNER.pkh)));
    expectReject('proceeds to a reverse pool with an attacker-chosen price (1 pUSD per sat)', fwdFill(
        c({ ...mirrorOf(fwdP), slots: [{ cat: BCH, num: 1n, den: 1n, rNum: 2000n, rDen: 1n }] }).tokenAddress));
    expectReject('proceeds to a reverse pool with a different owner', fwdFill(c({ ...mirrorOf(fwdP), ownerPkh: ATTACKER.pkh }).tokenAddress));
    expectReject('proceeds to a reverse pool with a different fee', fwdFill(c({ ...mirrorOf(fwdP), feeBps: 0 }).tokenAddress));
    expectReject('proceeds to a non-mirror (mode 0) pool with the same terms', fwdFill(c({ ...mirrorOf(fwdP), mode: 0 }).tokenAddress));

    section('Reverse (pUSD reserve) → proceeds must fund the original forward pool');
    const o22k = out(22_000n, 1n, 2200n); // 9 pUSD for 22,000 sats
    const revFill = (to: string | Uint8Array) => () => {
        const b = tb();
        b.addInput(utxo(1_000n, tok(10n)), rev.unlock.fill());            // the proceeds UTXO from the forward fill
        b.addInput(utxo(30_000n), TAKER.template.unlockP2PKH());
        b.addOutput({ to: rev.tokenAddress, amount: 1_000n, token: tok(10n - o22k) });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: 1_000n, token: tok(o22k) });
        b.addOutput({ to, amount: 22_000n });                                // BCH proceeds
        return b;
    };
    expectAccept('closed loop: 22,000 sats proceeds go back to the forward pool', revFill(fwd.address));
    expectReject('reverse proceeds to the owner', revFill(p2pkh(OWNER.pkh)));
    expectReject('reverse proceeds to a forward pool at a different price', revFill(
        c({ ...fwdP, slots: [{ cat: TOKEN_PUSD, num: 3000n, den: 1n, rNum: 1n, rDen: 2200n }] }).address));

    section('Multi-pair forward in mode 2: each accepted asset has its own mirror');
    const mpP: V3Params = { ownerPkh: OWNER.pkh, reserve: BCH, feeBps: 30, mode: 2, slots: [
        { cat: TOKEN_PUSD, num: 2000n, den: 1n, rNum: 1n, rDen: 2200n },
        { cat: TOKEN_MUSD, num: 1990n, den: 1n, rNum: 1n, rDen: 2190n },
    ] };
    const mp = c(mpP);
    const mpFill = (payCat: string, take: bigint, to: string) => () => {
        const b = tb();
        b.addInput(utxo(R), mp.unlock.fill());
        b.addInput(utxo(5_000n, tok(10n, payCat)), TAKER.template.unlockP2PKH());
        b.addOutput({ to: mp.address, amount: R - take });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: take + 3_000n });
        b.addOutput({ to, amount: 1_000n, token: tok(10n, payCat) });
        return b;
    };
    expectAccept('mUSD payment funds the mUSD mirror (slot 1)', mpFill(TOKEN_MUSD, out(10n, 1990n, 1n), c(mirrorOf(mpP, 1)).tokenAddress));
    expectAccept('pUSD payment funds the pUSD mirror (slot 0)', mpFill(TOKEN_PUSD, out(10n, 2000n, 1n), c(mirrorOf(mpP, 0)).tokenAddress));
    expectReject('mUSD payment sent to the pUSD mirror', mpFill(TOKEN_MUSD, out(10n, 1990n, 1n), c(mirrorOf(mpP, 0)).tokenAddress));

    section('Token↔token mirror: mUSD reserve accepts pUSD, reverse is a pUSD reserve accepting mUSD');
    const ttP: V3Params = { ownerPkh: OWNER.pkh, reserve: TOKEN_MUSD, feeBps: 30, mode: 2,
        slots: [{ cat: TOKEN_PUSD, num: 100n, den: 1n, rNum: 1n, rDen: 110n }] };
    const tt = c(ttP);
    const ttRev = c(mirrorOf(ttP));
    const o4 = out(10n, 100n, 1n);
    expectAccept('10 pUSD proceeds fund the pUSD-reserve mirror', () => {
        const b = tb();
        b.addInput(utxo(1_000n, tok(5_000n, TOKEN_MUSD)), tt.unlock.fill());
        b.addInput(utxo(5_000n, tok(10n)), TAKER.template.unlockP2PKH());
        b.addOutput({ to: tt.tokenAddress, amount: 1_000n, token: tok(5_000n - o4, TOKEN_MUSD) });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: 1_000n, token: tok(o4, TOKEN_MUSD) });
        b.addOutput({ to: ttRev.tokenAddress, amount: 1_000n, token: tok(10n) });
        return b;
    });

    section('Mode 2 guards');
    const zeroRev = c({ ...fwdP, slots: [{ cat: TOKEN_PUSD, num: 2000n, den: 1n, rNum: 0n, rDen: 2200n }] });
    expectReject('a mode-2 slot without a reverse price cannot fill (funds would strand in the mirror)', () => {
        const b = tb();
        b.addInput(utxo(R), zeroRev.unlock.fill());
        b.addInput(utxo(5_000n, tok(10n)), TAKER.template.unlockP2PKH());
        b.addOutput({ to: zeroRev.address, amount: R - o10 });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: o10 + 3_000n });
        b.addOutput({ to: c(mirrorOf({ ...fwdP, slots: [{ cat: TOKEN_PUSD, num: 2000n, den: 1n, rNum: 0n, rDen: 2200n }] })).tokenAddress, amount: 1_000n, token: tok(10n) });
        return b;
    });
    expectAccept('owner can always dock a mirror pool', () => {
        const b = tb();
        b.addInput(utxo(1_000n, tok(10n)), rev.unlock.dock(OWNER.pub, OWNER.template));
        b.addOutput({ to: p2pkh(OWNER.pkh), amount: 1_000n, token: tok(10n) });
        return b;
    });

    if (infoFailures) process.exitCode = 1;
    summary('MeshPoolV3 mirror mode');
}

main();
