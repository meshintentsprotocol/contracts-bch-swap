/**
 * MultiPairRecyclingCovenant Adversarial Security Test Suite
 *
 * Asserts VM-level rejection of reverse strategy theft, token redirection,
 * parameter tampering, and unauthorized docking attacks against MultiPairRecyclingCovenant.cash.
 */

import { Contract, TransactionBuilder } from 'cashscript';
import {
    RECYCLING_ARTIFACT, OWNER, TAKER, ATTACKER,
    TOKEN_PUSD, TOKEN_MUSD, TOKEN_FAKE, pusdLE, musdLE, fakeTokenLE, BCH,
    p2pkh, provider, fakeTxid,
    expectAccept, expectReject, section, summary, resetStats
} from './_mesh_security_harness.js';
import { sha256 } from '@bitauth/libauth';

function main() {
    resetStats();
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   MultiPairRecyclingCovenant — Adversarial Security      ║');
    console.log('╚══════════════════════════════════════════════════════════╝');

    const net = provider();
    const RESERVE_SATS = 100_000n;
    const PUSD_PRICE_NUM = 1n; // 1:1 sat per token
    const PUSD_PRICE_DEN = 1n;
    const MUSD_PRICE_NUM = 2n; // 2:1 sats per token
    const MUSD_PRICE_DEN = 1n;
    const FEE_BPS = 30n;       // 0.30%

    // 32-byte hash for reverse strategy (P2SH32)
    const reverseScriptHash = new Uint8Array(32).fill(0x77);

    const contract = new Contract(
        RECYCLING_ARTIFACT,
        [
            OWNER.pkh,
            BCH,                  // tokenCategoryOut = BCH
            pusdLE,
            PUSD_PRICE_NUM,
            PUSD_PRICE_DEN,
            musdLE,
            MUSD_PRICE_NUM,
            MUSD_PRICE_DEN,
            FEE_BPS,
            reverseScriptHash
        ],
        { provider: net }
    );

    const contractUtxo = {
        txid: fakeTxid(),
        vout: 0,
        satoshis: RESERVE_SATS,
    };

    const pusdTokenUtxo = {
        txid: fakeTxid(),
        vout: 0,
        satoshis: 2000n,
        token: { amount: 50_000n, category: TOKEN_PUSD }
    };

    const musdTokenUtxo = {
        txid: fakeTxid(),
        vout: 0,
        satoshis: 2000n,
        token: { amount: 50_000n, category: TOKEN_MUSD }
    };

    const feeUtxo = {
        txid: fakeTxid(),
        vout: 0,
        satoshis: 50_000n,
    };

    // P2SH32 locking bytecode: OP_HASH256 <32> OP_EQUAL
    const reverseLockingBytecode = Uint8Array.from([0xaa, 0x20, ...reverseScriptHash, 0x87]);

    // ── 1. Reverse Strategy UTXO Enforcement (Output 1) ───────────────────────
    section('1. Reverse Strategy UTXO Enforcement (Output 1)');

    const amountIn = 10_000n;
    const amountOutPusd = (amountIn * PUSD_PRICE_NUM * (10000n - FEE_BPS)) / (PUSD_PRICE_DEN * 10000n); // 9,970 sats
    const remainingReservePusd = RESERVE_SATS - amountOutPusd;

    expectAccept('Honest fill with pUSD seeds reverse strategy UTXO at Output 1', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fillAndRecycle(amountIn, 1n));
        tx.addInput(pusdTokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        // Output 0: Recreated BCH reserve
        tx.addOutput({ to: contract.address, amount: remainingReservePusd });
        // Output 1: AUTO-SEEDED REVERSE STRATEGY UTXO
        tx.addOutput({
            to: reverseLockingBytecode,
            amount: 1000n,
            token: { amount: amountIn, category: TOKEN_PUSD }
        });
        // Output 2: Deliver BCH to taker
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOutPusd });
        // Output 3: Token change back to taker
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: 1000n, token: { amount: 40_000n, category: TOKEN_PUSD } });
        return tx;
    });

    expectReject('Attacker cannot redirect payment tokens in Output 1 to attacker address', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fillAndRecycle(amountIn, 1n));
        tx.addInput(pusdTokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: remainingReservePusd });
        // Attack: Output 1 sent to ATTACKER instead of reverseScriptHash
        tx.addOutput({
            to: p2pkh(ATTACKER.pkh),
            amount: 1000n,
            token: { amount: amountIn, category: TOKEN_PUSD }
        });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOutPusd });
        return tx;
    });

    expectReject('Attacker cannot underfund reverse strategy (depositing fewer tokens than amountIn)', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fillAndRecycle(amountIn, 1n));
        tx.addInput(pusdTokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: remainingReservePusd });
        // Attack: Only deposit 5,000 tokens instead of 10,000
        tx.addOutput({
            to: reverseLockingBytecode,
            amount: 1000n,
            token: { amount: 5000n, category: TOKEN_PUSD }
        });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOutPusd });
        return tx;
    });

    // ── 2. Multi-Token Pricing Selection ──────────────────────────────────────
    section('2. Multi-Token Dynamic Pricing Integrity');

    const amountOutMusd = (amountIn * MUSD_PRICE_NUM * (10000n - FEE_BPS)) / (MUSD_PRICE_DEN * 10000n); // 19,940 sats
    const remainingReserveMusd = RESERVE_SATS - amountOutMusd;

    expectAccept('Honest fill with mUSD applies Tier-2 pricing', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.fillAndRecycle(amountIn, 2n));
        tx.addInput(musdTokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: remainingReserveMusd });
        tx.addOutput({
            to: reverseLockingBytecode,
            amount: 1000n,
            token: { amount: amountIn, category: TOKEN_MUSD }
        });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOutMusd });
        // Token change back to taker
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: 1000n, token: { amount: 40_000n, category: TOKEN_MUSD } });
        return tx;
    });

    expectReject('Attacker cannot pay with token 1 while selecting token 2 pricing', () => {
        const tx = new TransactionBuilder({ provider: net });
        // Attack: Select tokenType 2 (mUSD, 2:1 price) but provide pUSD in Output 1
        tx.addInput(contractUtxo, contract.unlock.fillAndRecycle(amountIn, 2n));
        tx.addInput(pusdTokenUtxo, TAKER.template.unlockP2PKH());
        tx.addInput(feeUtxo, TAKER.template.unlockP2PKH());

        tx.addOutput({ to: contract.address, amount: remainingReserveMusd });
        tx.addOutput({
            to: reverseLockingBytecode,
            amount: 1000n,
            token: { amount: amountIn, category: TOKEN_PUSD } // Category mismatch!
        });
        tx.addOutput({ to: p2pkh(TAKER.pkh), amount: amountOutMusd });
        return tx;
    });

    // ── 3. Docking Security ───────────────────────────────────────────────────
    section('3. Owner Docking Security');

    expectAccept('Owner can dock multi-pair covenant reserve', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.dock(OWNER.pub, OWNER.template));
        tx.addOutput({ to: p2pkh(OWNER.pkh), amount: RESERVE_SATS - 1000n });
        return tx;
    });

    expectReject('Attacker cannot dock multi-pair covenant reserve', () => {
        const tx = new TransactionBuilder({ provider: net });
        tx.addInput(contractUtxo, contract.unlock.dock(ATTACKER.pub, ATTACKER.template));
        tx.addOutput({ to: p2pkh(ATTACKER.pkh), amount: RESERVE_SATS - 1000n });
        return tx;
    });

    summary('MultiPairRecyclingCovenant Security Suite');
}

main();
