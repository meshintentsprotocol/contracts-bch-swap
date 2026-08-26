/**
 * DutchDecayStrategyCovenant Adversarial Security Test Suite
 *
 * Asserts VM-level rejection of locktime manipulation, premature floor price claiming,
 * non-timestamp locktimes, reserve shortchanging, and unauthorized docking.
 */

import { Contract, TransactionBuilder } from 'cashscript';
import {
    DUTCH_ARTIFACT, OWNER, TAKER, ATTACKER,
    TOKEN_PUSD, pusdLE, BCH,
    p2pkh, provider, fakeTxid,
    expectAccept, expectReject, section, summary, resetStats
} from './_mesh_security_harness.js';

function main() {
    resetStats();
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   DutchDecayStrategyCovenant — Adversarial Security      ║');
    console.log('╚══════════════════════════════════════════════════════════╝');

    const net = provider();
    const RESERVE_SATS = 100_000n;
    const START_PRICE_NUM = 10n; // 10 sats per token
    const FLOOR_PRICE_NUM = 5n;  // 5 sats per token
    const PRICE_DEN = 1n;
    const START_TIME = 1700000000n;
    const DURATION = 3600n; // 1 hour
    const FEE_BPS = 30n;    // 0.30%

    const contract = new Contract(
        DUTCH_ARTIFACT,
        [
            OWNER.pkh,
            pusdLE,
            BCH,
            START_PRICE_NUM,
            FLOOR_PRICE_NUM,
            PRICE_DEN,
            START_TIME,
            DURATION,
            FEE_BPS
        ],
        { provider: net }
    );

    const contractUtxo = {
        txid: fakeTxid(),
        vout: 0,
        satoshis: RESERVE_SATS,
    };

    const tokenUtxo = {
        txid: fakeTxid(),
        vout: 0,
        satoshis: 2000n,
        token: { amount: 50_000n, category: TOKEN_PUSD }
    };

    const feeUtxo = {
        txid: fakeTxid(),
        vout: 0,
        satoshis: 50_000n,
    };

    const amountIn = 1000n;

    // ── 1. Locktime Validation & Premature Claiming ───────────────────────────
    section('1. Locktime Temporal Invariants (tx.locktime)');

    expectAccept('Honest fill at start time (T=0, Price=10 sats/token)', () => {
        const amountOut = (amountIn * START_PRICE_NUM * (10000n - FEE_BPS)) / (PRICE_DEN * 10000n); // 9,970 sats
        const remainingReserve = RESERVE_SATS - amountOut;

        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fillDutch(amountIn));
        tx.addInput(tokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: remainingReserve });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOut });
        tx.addOutput({ to: p2pkh(OWNER.pkh), amount: 1000n, token: { amount: amountIn, category: TOKEN_PUSD } });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: 1000n, token: { amount: 49_000n, category: TOKEN_PUSD } });
        tx.setLocktime(Number(START_TIME));
        return tx;
    });

    expectReject('Attacker cannot fill before auction start time (tx.locktime < startTime)', () => {
        const amountOut = (amountIn * START_PRICE_NUM * (10000n - FEE_BPS)) / (PRICE_DEN * 10000n);
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fillDutch(amountIn));
        tx.addInput(tokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: RESERVE_SATS - amountOut });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOut });
        // Attack: Locktime is before startTime
        tx.setLocktime(Number(START_TIME) - 100);
        return tx;
    });

    expectReject('Attacker cannot use block-height locktime (< 500,000,000)', () => {
        const amountOut = (amountIn * START_PRICE_NUM * (10000n - FEE_BPS)) / (PRICE_DEN * 10000n);
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fillDutch(amountIn));
        tx.addInput(tokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: RESERVE_SATS - amountOut });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOut });
        // Attack: Locktime set to block height 850,000 instead of UNIX timestamp
        tx.setLocktime(850000);
        return tx;
    });

    // ── 2. Linear Price Decay Curve Verification ──────────────────────────────
    section('2. Linear Price Decay Curve Verification');

    expectAccept('Honest fill midway (T+1800s, 50% decay, Price=8 sats/token)', () => {
        const halfwayTime = START_TIME + 1800n;
        const currentPriceNum = 8n; // 10 - (5 * 1800) / 3600 = 8
        const amountOut = (amountIn * 8n * (10000n - FEE_BPS)) / (PRICE_DEN * 10000n); // 7,976 sats
        const remainingReserve = RESERVE_SATS - amountOut;

        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fillDutch(amountIn));
        tx.addInput(tokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: remainingReserve });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOut });
        tx.addOutput({ to: p2pkh(OWNER.pkh), amount: 1000n, token: { amount: amountIn, category: TOKEN_PUSD } });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: 1000n, token: { amount: 49_000n, category: TOKEN_PUSD } });
        tx.setLocktime(Number(halfwayTime));
        return tx;
    });

    expectReject('Attacker cannot claim floor price (5 sats/token) at start of auction', () => {
        // Attacker claims floor price output (4,985 sats) but submits at T=0 where price is 10 sats (9,970 sats)
        const floorAmountOut = (amountIn * FLOOR_PRICE_NUM * (10000n - FEE_BPS)) / (PRICE_DEN * 10000n);

        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fillDutch(amountIn));
        tx.addInput(tokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        // Attack: At T=0, required amountOut is ~9,970 sats; delivering only 4,985 sats steals reserve
        tx.addOutput({ to: contract.address, amount: RESERVE_SATS - floorAmountOut });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: floorAmountOut });
        tx.setLocktime(Number(START_TIME));
        return tx;
    });

    // ── 3. Docking Security ───────────────────────────────────────────────────
    section('3. Owner Docking Security');

    expectAccept('Owner can dock Dutch decay reserve anytime', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.dock(OWNER.pub, OWNER.template));
        tx.addOutput({ to: p2pkh(OWNER.pkh), amount: RESERVE_SATS - 1000n });
        return tx;
    });

    expectReject('Attacker cannot dock Dutch decay reserve', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.dock(ATTACKER.pub, ATTACKER.template));
        tx.addOutput({ to: p2pkh(ATTACKER.pkh), amount: RESERVE_SATS - 1000n });
        return tx;
    });

    summary('DutchDecayStrategyCovenant Security Suite');
}

main();
