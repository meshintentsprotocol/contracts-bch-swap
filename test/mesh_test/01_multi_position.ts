/**
 * BCHMesh Test 01 — Multi-Position Strategy Covenant
 *
 * Tests:
 *   A. Open 3 concurrent BCH-reserve strategy positions at different prices
 *   B. Fill each position partially, verify covenant recreation
 *   C. Dock (exit) all remaining positions
 *
 * Positions opened:
 *   P1: 15,000 sats reserve @ 1 sat/token  (standard)
 *   P2: 20,000 sats reserve @ 2 sats/token (premium tier)
 *   P3: 10,000 sats reserve @ 1 sat/token  (low-reserve backup)
 */

import { Contract, TransactionBuilder } from 'cashscript';
import {
    loadWallet, loadArtifact, fundBchContract, dockContract,
    TOKEN_A, reverseHex, section, banner, log, ok, err, sleep,
    createResult, printSummary, contractLockingHex, findOutputIndex,
    type TestResult, type WalletCtx
} from './utils.js';

const ARTIFACT = 'StrategyCovenant';

interface Position {
    label: string;
    reserveSats: bigint;
    priceNum: bigint;
    priceDen: bigint;
    feeBps: bigint;
    contract: Contract;
    utxo: { txid: string; vout: number; satoshis: bigint };
}

async function openPosition(
    ctx: WalletCtx,
    artifact: any,
    label: string,
    reserveSats: bigint,
    priceNum: bigint,
    priceDen: bigint,
    feeBps: bigint
): Promise<Position> {
    const tokenCategoryInLE = `0x${reverseHex(TOKEN_A)}`;
    const contract = new Contract(
        artifact,
        [ctx.ownerPkhBytes, tokenCategoryInLE, '0x', priceNum, priceDen, feeBps],
        { provider: ctx.provider }
    );

    log(`[${label}] Contract: ${contract.address}`);
    log(`[${label}] Price: ${priceNum}/${priceDen} sat/token | Fee: ${feeBps}bps | Reserve: ${reserveSats} sats`);

    const { txid, vout } = await fundBchContract(ctx, contract.address, reserveSats, label);

    return {
        label, reserveSats, priceNum, priceDen, feeBps, contract,
        utxo: { txid, vout, satoshis: reserveSats }
    };
}

async function fillPosition(
    ctx: WalletCtx,
    pos: Position,
    amountIn: bigint
): Promise<string> {
    const amountOut = (amountIn * pos.priceNum * (10000n - pos.feeBps)) / (pos.priceDen * 10000n);
    const remainingReserve = pos.utxo.satoshis - amountOut;

    log(`[${pos.label}] Fill: ${amountIn} tokens → ${amountOut} sats (remaining: ${remainingReserve} sats)`);

    // Get taker token UTXO
    const tokenUtxos = await ctx.provider.getUtxos(ctx.tokenAddr);
    const tokenUtxo  = tokenUtxos.find(u => u.token?.category === TOKEN_A && u.token.amount >= amountIn);
    if (!tokenUtxo) throw new Error(`No token UTXO with ${amountIn} tokens`);

    // Get fee UTXO
    const bchUtxos = await ctx.provider.getUtxos(ctx.userAddr);
    const feeUtxo  = bchUtxos.find(u => !u.token && u.satoshis > 5000n);
    if (!feeUtxo) throw new Error('No BCH UTXO for fee');

    const txBuilder = new TransactionBuilder({ provider: ctx.provider });

    // Input 0: contract UTXO
    txBuilder.addInput(pos.utxo, pos.contract.unlock.fill(amountIn));
    // Input 1: taker token UTXO
    txBuilder.addInput(tokenUtxo, ctx.sig.unlockP2PKH());
    // Input 2: fee UTXO
    txBuilder.addInput(feeUtxo, ctx.sig.unlockP2PKH());

    // Output 0: covenant recreation with remaining reserve
    txBuilder.addOutput({ to: pos.contract.address, amount: remainingReserve });

    // Output 1: taker receives BCH
    txBuilder.addOutput({ to: ctx.userAddr, amount: amountOut });

    // Output 2: maker receives payment tokens (amountIn tokens)
    txBuilder.addOutput({
        to: ctx.tokenAddr,
        amount: 1000n,
        token: { amount: amountIn, category: TOKEN_A }
    });

    const tokenChange = tokenUtxo.token!.amount - amountIn;
    if (tokenChange > 0n) {
        txBuilder.addOutput({
            to: ctx.tokenAddr,
            amount: 1000n,
            token: { amount: tokenChange, category: TOKEN_A }
        });
    }

    const totalBchIn  = pos.utxo.satoshis + tokenUtxo.satoshis + feeUtxo.satoshis;
    const dustForToken = (tokenChange > 0n ? 1000n : 0n) + 1000n;
    const bchChange   = totalBchIn - remainingReserve - amountOut - dustForToken - 2000n;
    if (bchChange > 546n) {
        txBuilder.addOutput({ to: ctx.userAddr, amount: bchChange });
    }

    const tx = await txBuilder.send();
    ok(`[${pos.label}] Fill TX: ${tx.txid}`);
    log(`   Explorer: https://chipnet.chaingraph.cash/tx/${tx.txid}`);

    // Update position UTXO tracking
    const lbHex = contractLockingHex(pos.contract.address);
    const newVout = await findOutputIndex(ctx.provider, tx.txid, lbHex);
    pos.utxo = { txid: tx.txid, vout: newVout, satoshis: remainingReserve };

    return tx.txid;
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function runTest01(): Promise<TestResult[]> {
    banner('TEST 01 — Multi-Position Strategy Covenant', 'Open 3 positions → Fill each → Dock all');
    const results: TestResult[] = [];

    const ctx = await loadWallet();
    const artifact = loadArtifact(ARTIFACT);

    // ── Test 01-A: Open 3 concurrent positions ──────────────────────────────
    const t01a = createResult('01-A: Open 3 positions (3 different prices)');
    section('01-A: Open 3 concurrent StrategyCovenant positions');
    const positions: Position[] = [];
    try {
        await sleep(1000);
        positions.push(await openPosition(ctx, artifact, 'P1-Standard', 15_000n, 1n, 1n, 30n));
        await sleep(3000);
        positions.push(await openPosition(ctx, artifact, 'P2-Premium',  20_000n, 2n, 1n, 30n));
        await sleep(3000);
        positions.push(await openPosition(ctx, artifact, 'P3-Backup',   10_000n, 1n, 1n, 50n));
        await sleep(3000);

        ok(`All 3 positions opened with unique addresses:`);
        for (const p of positions) log(`  ${p.label}: ${p.contract.address}`);
        t01a.passed = true;
        t01a.txids  = positions.map(p => p.utxo.txid);
        t01a.notes  = ['P1=15k@1:1+30bps', 'P2=20k@2:1+30bps', 'P3=10k@1:1+50bps'];
    } catch (e: any) {
        err(`01-A failed: ${e.message}`);
        t01a.error = e.message;
    }
    t01a.durationMs = Date.now() - t01a.start;
    results.push(t01a);

    if (positions.length === 0) return results;

    // ── Test 01-B: Fill each position partially ─────────────────────────────
    const t01b = createResult('01-B: Partial fill each of 3 positions');
    section('01-B: Partial fill each position (1000 tokens each)');
    try {
        const fillTxids: string[] = [];
        for (const pos of positions) {
            await sleep(3000);
            const txid = await fillPosition(ctx, pos, 1000n);
            fillTxids.push(txid);
        }
        ok(`All 3 positions partially filled!`);
        t01b.passed = true;
        t01b.txids  = fillTxids;
        t01b.notes  = positions.map(p => `${p.label}: ${p.utxo.satoshis} sats remaining`);
    } catch (e: any) {
        err(`01-B failed: ${e.message}`);
        t01b.error = e.message;
    }
    t01b.durationMs = Date.now() - t01b.start;
    results.push(t01b);

    // ── Test 01-C: Dock all positions ───────────────────────────────────────
    const t01c = createResult('01-C: Dock all 3 remaining positions');
    section('01-C: Dock (exit) all remaining positions');
    try {
        const dockTxids: string[] = [];
        for (const pos of positions) {
            await sleep(3000);
            log(`Docking ${pos.label} (${pos.utxo.satoshis} sats)...`);
            const txid = await dockContract(ctx, pos.contract, pos.utxo);
            dockTxids.push(txid);
        }
        ok(`All 3 positions docked!`);
        t01c.passed = true;
        t01c.txids  = dockTxids;
    } catch (e: any) {
        err(`01-C failed: ${e.message}`);
        t01c.error = e.message;
    }
    t01c.durationMs = Date.now() - t01c.start;
    results.push(t01c);

    return results;
}

// Run standalone
if (process.argv[1].includes('01_multi_position')) {
    const results = await runTest01();
    printSummary(results);
    process.exit(results.every(r => r.passed) ? 0 : 1);
}
