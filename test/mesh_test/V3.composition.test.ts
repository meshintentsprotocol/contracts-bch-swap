/**
 * MeshPoolV3 composition (offline VM): V3 pools in the same transaction as V2
 * intents and V2 pools.
 *
 * Every covenant checks only its own indices:
 *   intent (LimitOrderSwapV2)  input i → payout outputs[i]
 *   V2 pool                    input i → recreated outputs[i]
 *   V3 pool                    input i → recreated outputs[i], proceeds outputs[i + N]
 * so outputs between the recreated pools and a V3 proceeds slot are free for
 * the filler (change, surplus shares, or small filler outputs back to itself).
 *
 * Usage: npx tsx test/mesh_test/V3.composition.test.ts
 */
import { Contract, TransactionBuilder } from 'cashscript';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    OWNER, TAKER, ATTACKER, TOKEN_PUSD, TOKEN_MUSD, pusdLE, musdLE, BCH as BCH_LE,
    p2pkh, provider, fakeTxid, expectAccept, expectReject, section, summary, resetStats,
} from './_mesh_security_harness.js';
import { BCH, v3Contract, p2sh32Hash } from './v3_encode.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const art = (n: string) => JSON.parse(readFileSync(join(ROOT, 'artifacts', `${n}.json`), 'utf-8'));
const V3 = art('MeshPoolV3');
const V2 = art('StrategyCovenantV2');
const LIMIT = art('LimitOrderSwapV2');

const net = provider();
const MAKER = TAKER;
const SOLVER = ATTACKER.template; // the filler: a different key from the pool owner
const SOLVER_LOCK = p2pkh(ATTACKER.pkh);
const T0 = 1_750_000_000;
const EXP = BigInt(T0 + 3600);
const tb = () => { const b = new TransactionBuilder({ provider: net }); b.setLocktime(T0); return b; };
const tok = (amount: bigint, category = TOKEN_PUSD) => ({ amount, category });
const utxo = (satoshis: bigint, token?: { amount: bigint; category: string }) => ({ txid: fakeTxid(), vout: 0, satoshis, ...(token ? { token } : {}) });
const out = (amountIn: bigint, num: bigint, den: bigint, fee = 30n) => (amountIn * num * (10000n - fee)) / (den * 10000n);
const LP = p2pkh(OWNER.pkh); // pool owner receives mode-0 proceeds

function main() {
    resetStats();
    const R = 100_000n;

    // ── Limit intent + V3 BCH-reserve pool ─────────────────────────────────
    section('LimitOrderSwapV2 (sell 10 pUSD, want ≥ 17,000 sats) + V3 pool (BCH reserve, accepts pUSD)');
    const limit = new Contract(LIMIT, [MAKER.pkh, pusdLE, BCH_LE, 10n, 17_000n, EXP], { provider: net });
    const v3bch = v3Contract(V3, { ownerPkh: OWNER.pkh, reserve: BCH, slots: [{ cat: TOKEN_PUSD, num: 2000n, den: 1n }], feeBps: 30, mode: 0 }, net);
    const o10 = out(10n, 2000n, 1n);
    const composeA = (makerPay: bigint, poolTake: bigint, proceedsTo: Uint8Array = LP) => () => {
        const b = tb();
        b.addInput(utxo(1_000n, tok(10n)), limit.unlock.fill());          // [0] intent
        b.addInput(utxo(R), v3bch.unlock.fill());                         // [1] V3 pool → proceeds at [1 + 3] = [4]
        b.addInput(utxo(4_000n), SOLVER.unlockP2PKH());                    // [2] solver fee
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: makerPay });           // [0] maker payout
        b.addOutput({ to: v3bch.address, amount: R - poolTake });          // [1] pool recreated
        b.addOutput({ to: SOLVER_LOCK, amount: 1_000n });                  // [2] solver change
        b.addOutput({ to: SOLVER_LOCK, amount: 1_000n + (poolTake - makerPay) }); // [3] filler / surplus to solver
        b.addOutput({ to: proceedsTo, amount: 1_000n, token: tok(10n) });  // [4] pool proceeds: the intent's pUSD
        return b;
    };
    expectAccept('intent + V3 pool + fee: maker 19,940, pUSD proceeds to the LP at [4]', composeA(o10, o10));
    expectAccept('maker paid its minimum, surplus kept by the filler', composeA(17_000n, o10));
    expectReject('maker underpaid below 17,000', composeA(16_000n, o10));
    expectReject('pool over-drawn beyond its price', composeA(o10 + 500n, o10 + 500n));
    expectReject('intent pUSD diverted from the pool proceeds to the filler', composeA(o10, o10, SOLVER_LOCK));

    // ── Token↔token intent + V3 token↔token pool ───────────────────────────
    section('LimitOrderSwapV2 (sell 10 pUSD, want ≥ 950 mUSD) + V3 pool (mUSD reserve, accepts pUSD)');
    const t2t = new Contract(LIMIT, [MAKER.pkh, pusdLE, musdLE, 10n, 950n, EXP], { provider: net });
    const v3tt = v3Contract(V3, { ownerPkh: OWNER.pkh, reserve: TOKEN_MUSD, slots: [{ cat: TOKEN_PUSD, num: 100n, den: 1n }], feeBps: 30, mode: 0 }, net);
    const M = 5_000n;
    const o4 = out(10n, 100n, 1n); // 997
    const composeB = (makerGets: bigint, poolGives: bigint) => () => {
        const b = tb();
        b.addInput(utxo(1_000n, tok(10n)), t2t.unlock.fill());                      // [0] intent: 10 pUSD
        b.addInput(utxo(1_000n, tok(M, TOKEN_MUSD)), v3tt.unlock.fill());          // [1] pool: 5,000 mUSD → proceeds [4]
        b.addInput(utxo(4_000n), SOLVER.unlockP2PKH());                             // [2] solver fee
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 1_000n, token: tok(makerGets, TOKEN_MUSD) }); // [0]
        b.addOutput({ to: v3tt.tokenAddress, amount: 1_000n, token: tok(M - poolGives, TOKEN_MUSD) }); // [1]
        b.addOutput({ to: SOLVER_LOCK, amount: 1_000n, ...(poolGives > makerGets ? { token: tok(poolGives - makerGets, TOKEN_MUSD) } : {}) }); // [2]
        b.addOutput({ to: SOLVER_LOCK, amount: 1_000n });                          // [3] filler
        b.addOutput({ to: LP, amount: 1_000n, token: tok(10n) });                   // [4] proceeds: pUSD to the LP
        return b;
    };
    expectAccept('pUSD → mUSD in one tx: maker 997 mUSD, LP receives 10 pUSD', composeB(o4, o4));
    expectReject('maker below its 950 mUSD minimum', composeB(900n, o4));
    expectReject('pool gives more mUSD than its price allows', composeB(o4 + 5n, o4 + 5n));

    // ── Two-hop through a V2 pool and a V3 pool ────────────────────────────
    section('Two-hop pUSD → BCH → mUSD: V2 pool (gives BCH for pUSD) + V3 pool (gives mUSD for BCH)');
    const t2t2 = new Contract(LIMIT, [MAKER.pkh, pusdLE, musdLE, 10n, 900n, EXP], { provider: net });
    const v2 = new Contract(V2, [OWNER.pkh, pusdLE, BCH_LE, 2000n, 1n, 30n], { provider: net });
    // V3: mUSD reserve accepting BCH at 1 mUSD unit per 20 sats
    const v3m = v3Contract(V3, { ownerPkh: OWNER.pkh, reserve: TOKEN_MUSD, slots: [{ cat: BCH, num: 1n, den: 20n }], feeBps: 30, mode: 0 }, net);
    const hopBch = o10;                        // V2 pays 19,940 sats for 10 pUSD
    const payV3 = 19_000n;                     // filler pays the V3 pool 19,000 sats
    const hopM = out(payV3, 1n, 20n);          // 947 mUSD
    const composeC = (makerGets: bigint, v3Pay: bigint) => () => {
        const b = tb();
        b.addInput(utxo(1_000n, tok(10n)), t2t2.unlock.fill());                       // [0] intent: 10 pUSD
        b.addInput(utxo(R), v2.unlock.fill());                                         // [1] V2: gives BCH, gets pUSD at [1]
        b.addInput(utxo(1_000n, tok(M, TOKEN_MUSD)), v3m.unlock.fill());              // [2] V3: gives mUSD, proceeds at [2 + 4] = [6]
        b.addInput(utxo(5_000n), SOLVER.unlockP2PKH());                                // [3] solver fee
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 1_000n, token: tok(makerGets, TOKEN_MUSD) }); // [0]
        b.addOutput({ to: v2.tokenAddress, amount: R - hopBch, token: tok(10n) });    // [1] V2 recreated
        b.addOutput({ to: v3m.tokenAddress, amount: 1_000n, token: tok(M - hopM, TOKEN_MUSD) }); // [2] V3 recreated
        b.addOutput({ to: SOLVER_LOCK, amount: 1_000n, ...(hopM > makerGets ? { token: tok(hopM - makerGets, TOKEN_MUSD) } : {}) }); // [3]
        b.addOutput({ to: SOLVER_LOCK, amount: 1_000n });                              // [4] filler
        b.addOutput({ to: SOLVER_LOCK, amount: hopBch - v3Pay });                      // [5] BCH left from the hop
        b.addOutput({ to: LP, amount: v3Pay });                                        // [6] V3 proceeds: BCH to the LP
        return b;
    };
    expectAccept('two-hop fill: maker 947 mUSD; V2 pool +10 pUSD −19,940 sats; V3 LP +19,000 sats', composeC(hopM, payV3));
    expectReject('V3 pool underpaid in BCH for the mUSD it gives', composeC(hopM, 18_000n));

    // ── Recycling chain: forward proceeds become a reverse reserve that fills ─
    section('Recycling chain (mode 1): forward proceeds UTXO is a valid reverse reserve');
    const reverse = v3Contract(V3, { ownerPkh: OWNER.pkh, reserve: TOKEN_PUSD, slots: [{ cat: BCH, num: 1n, den: 2100n }], feeBps: 30, mode: 0 }, net);
    const forward = v3Contract(V3, { ownerPkh: OWNER.pkh, reserve: BCH, slots: [{ cat: TOKEN_PUSD, num: 2000n, den: 1n }], feeBps: 30, mode: 1, proceedsHash: p2sh32Hash(reverse.address) }, net);
    expectAccept('tx 1: forward fill sends 10 pUSD to the reverse pool', () => {
        const b = tb();
        b.addInput(utxo(R), forward.unlock.fill());
        b.addInput(utxo(5_000n, tok(10n)), TAKER.template.unlockP2PKH());
        b.addOutput({ to: forward.address, amount: R - o10 });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: o10 + 3_000n });
        b.addOutput({ to: reverse.tokenAddress, amount: 1_000n, token: tok(10n) });
        return b;
    });
    const o21k = out(21_000n, 1n, 2100n); // 9
    expectAccept('tx 2: that UTXO (1000 sats + 10 pUSD) fills as the reverse pool: 21,000 sats in, 9 pUSD out', () => {
        const b = tb();
        b.addInput(utxo(1_000n, tok(10n)), reverse.unlock.fill());
        b.addInput(utxo(30_000n), TAKER.template.unlockP2PKH());
        b.addOutput({ to: reverse.tokenAddress, amount: 1_000n, token: tok(10n - o21k) });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: 1_000n, token: tok(o21k) });
        b.addOutput({ to: LP, amount: 21_000n });
        return b;
    });

    summary('MeshPoolV3 composition');
}

main();
