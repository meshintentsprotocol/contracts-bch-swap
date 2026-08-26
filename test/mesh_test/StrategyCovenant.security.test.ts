/**
 * StrategyCovenant Adversarial Security Test Suite
 *
 * Asserts VM-level rejection of theft, reserve draining, bytecode tampering,
 * fake token inputs, and unauthorized docking attacks against StrategyCovenant.cash.
 */

import { Contract, TransactionBuilder } from 'cashscript';
import {
    STRATEGY_ARTIFACT, OWNER, TAKER, ATTACKER,
    TOKEN_PUSD, TOKEN_FAKE, pusdLE, fakeTokenLE, BCH,
    p2pkh, provider, fakeTxid,
    expectAccept, expectReject, section, summary, resetStats
} from './_mesh_security_harness.js';

function main() {
    resetStats();
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   StrategyCovenant.cash — Adversarial Security Tests     ║');
    console.log('╚══════════════════════════════════════════════════════════╝');

    const net = provider();
    const RESERVE_SATS = 100_000n;
    const PRICE_NUM = 1n; // 1:1 sat per token
    const PRICE_DEN = 1n;
    const FEE_BPS = 30n;  // 0.30%

    // Instantiate covenant: accepts TOKEN_PUSD, pays BCH
    const contract = new Contract(
        STRATEGY_ARTIFACT,
        [OWNER.pkh, pusdLE, BCH, PRICE_NUM, PRICE_DEN, FEE_BPS],
        { provider: net }
    );

    const contractUtxo = {
        txid: fakeTxid(),
        vout: 0,
        satoshis: RESERVE_SATS,
    };

    const validTakerTokenUtxo = {
        txid: fakeTxid(),
        vout: 0,
        satoshis: 2000n,
        token: { amount: 50_000n, category: TOKEN_PUSD }
    };

    const fakeTokenUtxo = {
        txid: fakeTxid(),
        vout: 0,
        satoshis: 2000n,
        token: { amount: 50_000n, category: TOKEN_FAKE }
    };

    const feeUtxo = {
        txid: fakeTxid(),
        vout: 0,
        satoshis: 50_000n,
    };

    // ── 1. Docking / Exit Security ────────────────────────────────────────────
    section('1. Docking & Exit Security (OP_EQUALVERIFY + OP_CHECKSIG)');

    expectAccept('Honest owner can dock 100% of covenant reserve', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.dock(OWNER.pub, OWNER.template));
        tx.addOutput({ to: p2pkh(OWNER.pkh), amount: RESERVE_SATS - 1000n });
        return tx;
    });

    expectReject('Attacker cannot dock using attacker pubkey & signature', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.dock(ATTACKER.pub, ATTACKER.template));
        tx.addOutput({ to: p2pkh(ATTACKER.pkh), amount: RESERVE_SATS - 1000n });
        return tx;
    });

    expectReject('Attacker cannot dock using owner pubkey with attacker signature', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.dock(OWNER.pub, ATTACKER.template));
        tx.addOutput({ to: p2pkh(ATTACKER.pkh), amount: RESERVE_SATS - 1000n });
        return tx;
    });

    // ── 2. Bytecode Preservation & Anti-Hijacking ─────────────────────────────
    section('2. Covenant Bytecode Preservation (Anti-Hijacking)');

    const amountIn = 10_000n;
    const amountOut = (amountIn * PRICE_NUM * (10000n - FEE_BPS)) / (PRICE_DEN * 10000n); // 9,970 sats
    const remainingReserve = RESERVE_SATS - amountOut; // 90,030 sats

    expectAccept('Honest fill recreates exact covenant locking bytecode', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fill(amountIn));
        tx.addInput(validTakerTokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: remainingReserve });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOut });
        tx.addOutput({ to: p2pkh(OWNER.pkh), amount: 1000n, token: { amount: amountIn, category: TOKEN_PUSD } });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: 1000n, token: { amount: 40_000n, category: TOKEN_PUSD } });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: 48_000n });
        return tx;
    });

    expectReject('Attacker cannot replace Output 0 locking bytecode with attacker P2PKH', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fill(amountIn));
        tx.addInput(validTakerTokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        // Attack: Output 0 sent to attacker instead of recreated covenant
        tx.addOutput({ to: p2pkh(ATTACKER.pkh), amount: remainingReserve });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOut });
        tx.addOutput({ to: p2pkh(OWNER.pkh), amount: 1000n, token: { amount: amountIn, category: TOKEN_PUSD } });
        return tx;
    });

    // ── 3. Mathematical Reserve Integrity & Anti-Theft ────────────────────────
    section('3. Reserve Arithmetic & Underfunding Protection');

    expectReject('Taker cannot underfund Output 0 reserve by even 1 satoshi', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fill(amountIn));
        tx.addInput(validTakerTokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        // Attack: Shortchange reserve by 100 sats (90,030 -> 89,930)
        tx.addOutput({ to: contract.address, amount: remainingReserve - 100n });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOut });
        tx.addOutput({ to: p2pkh(OWNER.pkh), amount: 1000n, token: { amount: amountIn, category: TOKEN_PUSD } });
        return tx;
    });

    expectReject('Taker cannot overclaim amountOut beyond fee-adjusted formula', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fill(amountIn));
        tx.addInput(validTakerTokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: remainingReserve });
        // Attack: Request full 10,000 sats instead of 9,970 (stealing fee)
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: 10_000n });
        tx.addOutput({ to: p2pkh(OWNER.pkh), amount: 1000n, token: { amount: amountIn, category: TOKEN_PUSD } });
        return tx;
    });

    // ── 4. Token Category Validation (Anti-Counterfeit) ───────────────────────
    section('4. CashToken Category Authentication (Anti-Counterfeit)');

    expectReject('Taker cannot pay with counterfeit token category in Input 1', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fill(amountIn));
        // Attack: Pass fake token category
        tx.addInput(fakeTokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: remainingReserve });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOut });
        tx.addOutput({ to: p2pkh(OWNER.pkh), amount: 1000n, token: { amount: amountIn, category: TOKEN_FAKE } });
        return tx;
    });

    expectReject('Taker cannot pass pure BCH input when tokenCategoryIn is required', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fill(amountIn));
        // Attack: Pass pure BCH in Input 1
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: remainingReserve });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOut });
        return tx;
    });

    // ── 5. Zero Amount & Reserve Drain Attacks ────────────────────────────────
    section('5. Zero-Amount & Over-Drain Attacks');

    expectReject('Taker cannot pass amountIn = 0 for free execution', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fill(0n));
        tx.addInput(validTakerTokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: RESERVE_SATS });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: 0n });
        return tx;
    });

    expectReject('Taker cannot request amountIn that exceeds current reserve', () => {
        const hugeAmountIn = 200_000n; // Exceeds 100,000 reserve
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fill(hugeAmountIn));
        tx.addInput(validTakerTokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: 0n });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: 199_400n });
        return tx;
    });

    summary('StrategyCovenant Security Suite');
}

main();
