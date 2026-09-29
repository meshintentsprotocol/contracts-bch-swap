/**
 * V2 covenant security suite (offline, MockNetworkProvider + VM debug)
 *
 *   StrategyCovenantV2   — payment derived from pool balances, index-bound recreation
 *   LimitOrderSwapV2     — index-bound maker payout, cancel / cancelEarly
 *   DutchAuctionSwapV2   — decaying payout, fill window, cancel after window
 *   Composition          — intent + pool + fee in one transaction
 *
 * Usage: npx tsx test/mesh_test/V2.security.test.ts
 */
import { Contract, TransactionBuilder } from 'cashscript';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    OWNER, TAKER, ATTACKER, TOKEN_PUSD, TOKEN_FAKE, pusdLE, BCH,
    p2pkh, provider, fakeTxid, expectAccept, expectReject, section, summary, resetStats,
} from './_mesh_security_harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const art = (n: string) => JSON.parse(readFileSync(join(ROOT, 'artifacts', `${n}.json`), 'utf-8'));
const POOL = art('StrategyCovenantV2');
const LIMIT = art('LimitOrderSwapV2');
const DUTCH = art('DutchAuctionSwapV2');

const net = provider();
const MAKER = TAKER; // the intent maker in these tests
const T0 = 1_750_000_000;
const tok = (amount: bigint, category = TOKEN_PUSD) => ({ amount, category });
const fee = (sats = 20_000n) => ({ txid: fakeTxid(), vout: 0, satoshis: sats });
const tb = (locktime = T0) => { const b = new TransactionBuilder({ provider: net }); b.setLocktime(locktime); return b; };

// price: 1 pUSD unit = 2000 sats, 30 bps fee ⇒ out = floor(in * 2000 * 9970 / 10000)
const poolTokIn = new Contract(POOL, [OWNER.pkh, pusdLE, BCH, 2000n, 1n, 30n], { provider: net });   // gives BCH
// price: 2100 sats = 1 pUSD, 30 bps ⇒ out = floor(in * 1 * 9970 / (2100 * 10000))
const poolTokOut = new Contract(POOL, [OWNER.pkh, BCH, pusdLE, 1n, 2100n, 30n], { provider: net });  // gives pUSD

function main() {
    resetStats();

    // ── Pool: pUSD in → BCH out ────────────────────────────────────────────────
    section('StrategyCovenantV2 · pUSD in → BCH out');
    const R = 100_000n;
    const out10 = (10n * 2000n * 9970n) / 10000n; // 19,940

    expectAccept('first fill: pool had no tokens, receives 10 pUSD, gives 19,940 sats', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: R }, poolTokIn.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 2_000n, token: tok(10n) }, TAKER.template.unlockP2PKH());
        b.addOutput({ to: poolTokIn.tokenAddress, amount: R - out10, token: tok(10n) });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: out10 + 1_000n });
        return b;
    });
    expectAccept('later fill: pool already holds 50 pUSD', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: R, token: tok(50n) }, poolTokIn.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 2_000n, token: tok(10n) }, TAKER.template.unlockP2PKH());
        b.addOutput({ to: poolTokIn.tokenAddress, amount: R - out10, token: tok(60n) });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: out10 + 1_000n });
        return b;
    });
    expectReject('V1 drain: deliver 1 pUSD, take 99,000 sats', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: R }, poolTokIn.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 2_000n, token: tok(1n) }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: poolTokIn.tokenAddress, amount: 1_000n, token: tok(1n) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 100_000n });
        return b;
    });
    expectReject('take BCH, deliver no tokens (output without token)', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: R }, poolTokIn.unlock.fill());
        b.addInput(fee(), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: poolTokIn.address, amount: R - out10 });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: out10 + 18_000n });
        return b;
    });
    expectReject('over-take by 1 sat beyond the price', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: R }, poolTokIn.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 2_000n, token: tok(10n) }, TAKER.template.unlockP2PKH());
        b.addOutput({ to: poolTokIn.tokenAddress, amount: R - out10 - 1n, token: tok(10n) });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: out10 + 1_001n });
        return b;
    });
    expectReject('deliver wrong token category', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: R }, poolTokIn.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 2_000n, token: tok(10n, TOKEN_FAKE) }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: poolTokIn.tokenAddress, amount: R - out10, token: tok(10n, TOKEN_FAKE) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: out10 + 1_000n });
        return b;
    });
    expectReject('recreate pool at a different output index', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: R }, poolTokIn.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 2_000n, token: tok(10n) }, TAKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: out10 + 1_000n });
        b.addOutput({ to: poolTokIn.tokenAddress, amount: R - out10, token: tok(10n) });
        return b;
    });
    expectReject('two same-address pools share one recreated output (double count)', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: R }, poolTokIn.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 1, satoshis: R }, poolTokIn.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 2_000n, token: tok(10n) }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: poolTokIn.tokenAddress, amount: R - out10, token: tok(10n) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: R + out10 - 1_000n });
        return b;
    });
    expectAccept('two same-address pools, each paid on its own output', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: R }, poolTokIn.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 1, satoshis: R }, poolTokIn.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 3_000n, token: tok(20n) }, TAKER.template.unlockP2PKH());
        b.addOutput({ to: poolTokIn.tokenAddress, amount: R - out10, token: tok(10n) });
        b.addOutput({ to: poolTokIn.tokenAddress, amount: R - out10, token: tok(10n) });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: 2n * out10 + 1_000n });
        return b;
    });
    expectAccept('LP docks with owner signature', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: R, token: tok(10n) }, poolTokIn.unlock.dock(OWNER.pub, OWNER.template));
        b.addOutput({ to: p2pkh(OWNER.pkh), amount: R - 1_000n, token: tok(10n) });
        return b;
    });
    expectReject('attacker cannot dock', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: R }, poolTokIn.unlock.dock(ATTACKER.pub, ATTACKER.template));
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: R - 1_000n });
        return b;
    });

    // ── Pool: BCH in → pUSD out ────────────────────────────────────────────────
    section('StrategyCovenantV2 · BCH in → pUSD out');
    const TR = 400n;
    const outFor20k = (20_000n * 9970n) / (2100n * 10000n); // 9

    expectAccept('pay 20,000 sats, receive 9 pUSD', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 1_000n, token: tok(TR) }, poolTokOut.unlock.fill());
        b.addInput(fee(30_000n), TAKER.template.unlockP2PKH());
        b.addOutput({ to: poolTokOut.tokenAddress, amount: 21_000n, token: tok(TR - outFor20k) });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: 1_000n, token: tok(outFor20k) });
        return b;
    });
    expectReject('pay 20,000 sats, take 10 pUSD (over price)', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 1_000n, token: tok(TR) }, poolTokOut.unlock.fill());
        b.addInput(fee(30_000n), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: poolTokOut.tokenAddress, amount: 21_000n, token: tok(TR - 10n) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(10n) });
        return b;
    });
    expectReject('pay nothing, take tokens', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 1_000n, token: tok(TR) }, poolTokOut.unlock.fill());
        b.addInput(fee(), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: poolTokOut.tokenAddress, amount: 1_000n, token: tok(1n) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(TR - 1n) });
        return b;
    });

    // ── LimitOrderSwapV2 ───────────────────────────────────────────────────────
    section('LimitOrderSwapV2 (sell 10 pUSD, want ≥ 17,000 sats)');
    const EXP = BigInt(T0 + 3600);
    const limit = new Contract(LIMIT, [MAKER.pkh, pusdLE, BCH, 10n, 17_000n, EXP], { provider: net });
    const intentUtxo = () => ({ txid: fakeTxid(), vout: 0, satoshis: 1_000n, token: tok(10n) });

    expectAccept('filled from any funds, payout at its own index', () => {
        const b = tb();
        b.addInput(intentUtxo(), limit.unlock.fill());
        b.addInput(fee(40_000n), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 17_000n });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(10n) });
        return b;
    });
    expectReject('underpay maker by 1 sat', () => {
        const b = tb();
        b.addInput(intentUtxo(), limit.unlock.fill());
        b.addInput(fee(40_000n), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 16_999n });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(10n) });
        return b;
    });
    expectReject('payout at a different index', () => {
        const b = tb();
        b.addInput(intentUtxo(), limit.unlock.fill());
        b.addInput(fee(40_000n), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(10n) });
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 17_000n });
        return b;
    });
    expectReject('two intent UTXOs of the same order share one payout', () => {
        const b = tb();
        b.addInput(intentUtxo(), limit.unlock.fill());
        b.addInput(intentUtxo(), limit.unlock.fill());
        b.addInput(fee(40_000n), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 17_000n });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(20n) });
        return b;
    });
    expectReject('fill at/after expiry', () => {
        const b = tb(Number(EXP));
        b.addInput(intentUtxo(), limit.unlock.fill());
        b.addInput(fee(40_000n), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 17_000n });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(10n) });
        return b;
    });
    expectReject('cancel() before expiry', () => {
        const b = tb(Number(EXP) - 1);
        b.addInput(intentUtxo(), limit.unlock.cancel());
        b.addInput(fee(), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 1_000n, token: tok(10n) });
        return b;
    });
    expectAccept('cancel() after expiry by anyone refunds maker (server auto-refund)', () => {
        const b = tb(Number(EXP));
        b.addInput(intentUtxo(), limit.unlock.cancel());
        b.addInput(fee(), OWNER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 1_000n, token: tok(10n) });
        b.addOutput({ to: p2pkh(OWNER.pkh), amount: 18_000n });
        return b;
    });
    expectReject('cancel() after expiry cannot redirect funds', () => {
        const b = tb(Number(EXP));
        b.addInput(intentUtxo(), limit.unlock.cancel());
        b.addInput(fee(), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(10n) });
        return b;
    });
    expectReject('underfunded intent UTXO (9 of 10 pUSD) cannot be filled', () => {
        const b = tb();
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 1_000n, token: tok(9n) }, limit.unlock.fill());
        b.addInput(fee(40_000n), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 17_000n });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(9n) });
        return b;
    });
    expectAccept('underfunded intent UTXO refunds in full after expiry', () => {
        const b = tb(Number(EXP));
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 1_000n, token: tok(9n) }, limit.unlock.cancel());
        b.addInput(fee(), OWNER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 1_000n, token: tok(9n) });
        return b;
    });
    expectReject('overfunded intent refund must return everything (12 pUSD, only 10 returned)', () => {
        const b = tb(Number(EXP));
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 1_000n, token: tok(12n) }, limit.unlock.cancel());
        b.addInput(fee(), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 1_000n, token: tok(10n) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(2n) });
        return b;
    });
    expectReject('refund keeps the covenant dust sats (maker output below input value)', () => {
        const b = tb(Number(EXP));
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 5_000n, token: tok(10n) }, limit.unlock.cancel());
        b.addInput(fee(), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 1_000n, token: tok(10n) });
        return b;
    });
    expectAccept('cancelEarly() by maker before expiry', () => {
        const b = tb();
        b.addInput(intentUtxo(), limit.unlock.cancelEarly(MAKER.pub, MAKER.template));
        b.addInput(fee(), MAKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 1_000n, token: tok(10n) });
        return b;
    });
    expectReject('cancelEarly() by attacker', () => {
        const b = tb();
        b.addInput(intentUtxo(), limit.unlock.cancelEarly(ATTACKER.pub, ATTACKER.template));
        b.addInput(fee(), ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 1_000n, token: tok(10n) });
        return b;
    });

    // ── DutchAuctionSwapV2 ─────────────────────────────────────────────────────
    section('DutchAuctionSwapV2 (sell 5 pUSD, 9,500 → 8,500 sats over 600 s)');
    const dutch = new Contract(DUTCH, [MAKER.pkh, pusdLE, BCH, 5n, 9_500n, 8_500n, BigInt(T0), 600n], { provider: net });
    const dUtxo = () => ({ txid: fakeTxid(), vout: 0, satoshis: 1_000n, token: tok(5n) });
    const dFill = (lt: number, pay: bigint) => () => {
        const b = tb(lt);
        b.addInput(dUtxo(), dutch.unlock.fill());
        b.addInput(fee(40_000n), TAKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: pay });
        b.addOutput({ to: p2pkh(TAKER.pkh), amount: 1_000n, token: tok(5n) });
        return b;
    };
    expectAccept('at start requires 9,500', dFill(T0, 9_500n));
    expectReject('at start 9,499 is not enough', dFill(T0, 9_499n));
    expectAccept('at half-time requires 9,000', dFill(T0 + 300, 9_000n));
    expectReject('at half-time 8,999 is not enough', dFill(T0 + 300, 8_999n));
    expectReject('before startTime', dFill(T0 - 1, 9_500n));
    expectReject('at/after window end (refund only)', dFill(T0 + 600, 9_500n));
    expectReject('cancel() before window end', () => {
        const b = tb(T0 + 599);
        b.addInput(dUtxo(), dutch.unlock.cancel());
        b.addInput(fee(), OWNER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 1_000n, token: tok(5n) });
        return b;
    });
    expectAccept('cancel() after window end refunds maker', () => {
        const b = tb(T0 + 600);
        b.addInput(dUtxo(), dutch.unlock.cancel());
        b.addInput(fee(), OWNER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: 1_000n, token: tok(5n) });
        b.addOutput({ to: p2pkh(OWNER.pkh), amount: 18_000n });
        return b;
    });

    // ── Composition: intent + pool + solver fee ────────────────────────────────
    section('Atomic composition: LimitV2 intent + StrategyCovenantV2 pool + solver fee');
    const compose = (makerPay: bigint, poolOutSats: bigint) => () => {
        const b = tb();
        b.addInput(intentUtxo(), limit.unlock.fill());                                  // [0] intent: 10 pUSD
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: R }, poolTokIn.unlock.fill()); // [1] pool: 100k sats
        b.addInput(fee(3_000n), OWNER.template.unlockP2PKH());                             // [2] solver fee
        b.addOutput({ to: p2pkh(MAKER.pkh), amount: makerPay });                           // [0] maker
        b.addOutput({ to: poolTokIn.tokenAddress, amount: poolOutSats, token: tok(10n) }); // [1] pool recreated
        b.addOutput({ to: p2pkh(OWNER.pkh), amount: R + 1_000n + 3_000n - makerPay - poolOutSats - 1_500n }); // solver change
        return b;
    };
    expectAccept('maker paid 19,940 from pool; pool +10 pUSD −19,940 sats; solver pays only fee', compose(out10, R - out10));
    expectReject('pool over-drawn to pay maker more than the price', compose(out10 + 500n, R - out10 - 500n));
    expectReject('maker underpaid below 17,000 even though pool pays', compose(16_000n, R - out10));

    summary('V2 covenant security');
}

main();
