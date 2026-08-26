/**
 * BCHMesh Test 03 — Dutch Decay Strategy E2E
 *
 * Tests the DutchDecayStrategyCovenant:
 *   A. Fund the covenant with BCH reserve
 *   B. Fill at T+0   (near start price — expensive for taker)
 *   C. Fill at T+60  (25% decay — slightly cheaper)
 *   D. Fill at T+120 (50% decay — mid price)
 *   E. Dock remaining reserve
 *
 * Price: Decays from 10 sats/token → 5 sats/token over 240s
 * So:
 *   T+0:   price = 10 sats/token → 1000 tokens = 9970 sats out
 *   T+60:  price = 8.75 sats/token → 1000 tokens = ~8721 sats
 *   T+120: price = 7.5 sats/token → 1000 tokens = ~7477 sats
 */

import { Contract, TransactionBuilder } from 'cashscript';
import {
    loadWallet, loadArtifact, fundBchContract, dockContract,
    TOKEN_A, reverseHex, section, banner, log, ok, err, sleep,
    createResult, printSummary, contractLockingHex, findOutputIndex,
    type TestResult
} from './utils.js';

const ARTIFACT = 'DutchDecayStrategyCovenant';

async function fillDutch(
    ctx: ReturnType<typeof loadWallet> extends Promise<infer T> ? T : never,
    contract: Contract,
    currentUtxo: { txid: string; vout: number; satoshis: bigint },
    amountIn: bigint,
    startPriceNum: bigint,
    floorPriceNum: bigint,
    priceDen: bigint,
    startTime: bigint,
    duration: bigint,
    feeBps: bigint,
    targetLocktime: bigint,
    fillLabel: string
): Promise<{ txid: string; utxo: { txid: string; vout: number; satoshis: bigint } }> {
    const elapsed     = targetLocktime - startTime;
    const clamped     = elapsed < duration ? elapsed : duration;
    const priceDrop   = startPriceNum - floorPriceNum;
    const dropAmount  = (priceDrop * clamped) / duration;
    const currentPriceNum = startPriceNum - dropAmount;

    const amountOut       = (amountIn * currentPriceNum * (10000n - feeBps)) / (priceDen * 10000n);
    const remainingReserve = currentUtxo.satoshis - amountOut;

    log(`[${fillLabel}] T+${elapsed}s | Price: ${currentPriceNum}/${priceDen} | amountIn=${amountIn} | amountOut=${amountOut} | remaining=${remainingReserve}`);

    const tokenUtxos = await ctx.provider.getUtxos(ctx.tokenAddr);
    const tokenUtxo  = tokenUtxos.find(u => u.token?.category === TOKEN_A && u.token.amount >= amountIn);
    if (!tokenUtxo) throw new Error('No token UTXO');

    const bchUtxos = await ctx.provider.getUtxos(ctx.userAddr);
    const feeUtxo  = bchUtxos.find(u => !u.token && u.satoshis > 5000n);
    if (!feeUtxo) throw new Error('No BCH fee UTXO');

    const txBuilder = new TransactionBuilder({ provider: ctx.provider });
    txBuilder.addInput(currentUtxo, contract.unlock.fillDutch(amountIn));
    txBuilder.addInput(tokenUtxo, ctx.sig.unlockP2PKH());
    txBuilder.addInput(feeUtxo, ctx.sig.unlockP2PKH());

    txBuilder.addOutput({ to: contract.address, amount: remainingReserve });
    txBuilder.addOutput({ to: ctx.userAddr, amount: amountOut });
    txBuilder.addOutput({ to: ctx.tokenAddr, amount: 1000n, token: { amount: amountIn, category: TOKEN_A } });

    const tokenChange = tokenUtxo.token!.amount - amountIn;
    if (tokenChange > 0n) {
        txBuilder.addOutput({ to: ctx.tokenAddr, amount: 1000n, token: { amount: tokenChange, category: TOKEN_A } });
    }

    const totalBchIn  = currentUtxo.satoshis + tokenUtxo.satoshis + feeUtxo.satoshis;
    const dustForToken = (tokenChange > 0n ? 1000n : 0n) + 1000n;
    const bchChange   = totalBchIn - remainingReserve - amountOut - dustForToken - 2000n;
    if (bchChange > 546n) {
        txBuilder.addOutput({ to: ctx.userAddr, amount: bchChange });
    }

    // Dutch covenant requires tx.locktime >= startTime
    txBuilder.setLocktime(Number(targetLocktime));

    const tx = await txBuilder.send();
    ok(`[${fillLabel}] Dutch Fill TX: ${tx.txid}`);
    log(`   Explorer: https://chipnet.chaingraph.cash/tx/${tx.txid}`);

    const lbHex   = contractLockingHex(contract.address);
    const newVout = await findOutputIndex(ctx.provider, tx.txid, lbHex);

    return { txid: tx.txid, utxo: { txid: tx.txid, vout: newVout, satoshis: remainingReserve } };
}

export async function runTest03(): Promise<TestResult[]> {
    banner('TEST 03 — Dutch Decay Strategy E2E', 'Fund → Fill@T+300s → Fill@T+900s → Fill@T+1500s → Dock');
    const results: TestResult[] = [];

    const ctx      = await loadWallet();
    const artifact = loadArtifact(ARTIFACT);

    // Setting startTime 7200s (2 hours) in past ensures all test locktimes (1-2 hours ago) are strictly <= Chipnet MTP
    const startPriceNum = 10n;
    const floorPriceNum = 5n;
    const priceDen      = 1n;
    const duration      = 3600n; // 1 hour duration
    const feeBps        = 30n;
    const now           = BigInt(Math.floor(Date.now() / 1000));
    const startTime     = now - 7200n; // Started 2 hours ago
    const RESERVE       = 60_000n;

    const tokenCategoryInLE = `0x${reverseHex(TOKEN_A)}`;

    const contract = new Contract(
        artifact,
        [
            ctx.ownerPkhBytes,
            tokenCategoryInLE,    // tokenCategoryIn
            '0x',                 // tokenCategoryOut = BCH
            startPriceNum,
            floorPriceNum,
            priceDen,
            startTime,
            duration,
            feeBps
        ],
        { provider: ctx.provider }
    );

    log(`Dutch Contract: ${contract.address}`);
    log(`Price decay: ${startPriceNum} → ${floorPriceNum} sats/token over ${duration}s starting at T=${startTime}`);

    // ── Test 03-A: Fund ─────────────────────────────────────────────────────
    const t03a = createResult('03-A: Fund Dutch Decay position (60,000 sats)');
    section('03-A: Fund DutchDecayStrategyCovenant');
    let currentUtxo: { txid: string; vout: number; satoshis: bigint };
    try {
        const { txid, vout } = await fundBchContract(ctx, contract.address, RESERVE, 'Dutch-Position');
        currentUtxo = { txid, vout, satoshis: RESERVE };
        t03a.passed = true;
        t03a.txids  = [txid];
    } catch (e: any) {
        err(`03-A failed: ${e.message}`);
        t03a.error = e.message;
        t03a.durationMs = Date.now() - t03a.start;
        results.push(t03a);
        return results;
    }
    t03a.durationMs = Date.now() - t03a.start;
    results.push(t03a);

    // ── Test 03-B: Fill at T+600s (16.6% decay) ─────────────────────────────
    const t03b = createResult('03-B: Fill at T+600s (16.6% price decay)');
    section('03-B: Fill at T+600s (locktime verified)');
    try {
        await sleep(3000);
        const locktime1 = startTime + 600n;
        const result = await fillDutch(ctx, contract, currentUtxo, 1000n, startPriceNum, floorPriceNum, priceDen, startTime, duration, feeBps, locktime1, 'Fill@T+600s');
        currentUtxo = result.utxo;
        t03b.passed = true;
        t03b.txids  = [result.txid];
        t03b.notes  = ['Price≈9.17 sats/token'];
    } catch (e: any) {
        err(`03-B failed: ${e.message}`);
        t03b.error = e.message;
    }
    t03b.durationMs = Date.now() - t03b.start;
    results.push(t03b);

    // ── Test 03-C: Fill at T+1800s (50% decay) ──────────────────────────────
    const t03c = createResult('03-C: Fill at T+1800s (50% price decay)');
    section('03-C: Fill at T+1800s (locktime verified)');
    try {
        await sleep(3000);
        const locktime2 = startTime + 1800n;
        const result = await fillDutch(ctx, contract, currentUtxo, 1000n, startPriceNum, floorPriceNum, priceDen, startTime, duration, feeBps, locktime2, 'Fill@T+1800s');
        currentUtxo = result.utxo;
        t03c.passed = true;
        t03c.txids  = [result.txid];
        t03c.notes  = ['Price≈7.50 sats/token'];
    } catch (e: any) {
        err(`03-C failed: ${e.message}`);
        t03c.error = e.message;
    }
    t03c.durationMs = Date.now() - t03c.start;
    results.push(t03c);

    // ── Test 03-D: Fill at T+3000s (83.3% decay) ────────────────────────────
    const t03d = createResult('03-D: Fill at T+3000s (83.3% price decay)');
    section('03-D: Fill at T+3000s (locktime verified)');
    try {
        await sleep(3000);
        const locktime3 = startTime + 3000n;
        const result = await fillDutch(ctx, contract, currentUtxo, 1000n, startPriceNum, floorPriceNum, priceDen, startTime, duration, feeBps, locktime3, 'Fill@T+3000s');
        currentUtxo = result.utxo;
        t03d.passed = true;
        t03d.txids  = [result.txid];
        t03d.notes  = ['Price≈5.83 sats/token'];
    } catch (e: any) {
        err(`03-D failed: ${e.message}`);
        t03d.error = e.message;
    }
    t03d.durationMs = Date.now() - t03d.start;
    results.push(t03d);

    // ── Test 03-E: Dock remaining ───────────────────────────────────────────
    const t03e = createResult('03-E: Dock remaining Dutch reserve');
    section('03-E: Dock Remaining Reserve');
    try {
        await sleep(3000);
        const txid = await dockContract(ctx, contract, currentUtxo);
        t03e.passed = true;
        t03e.txids  = [txid];
        t03e.notes  = [`Reclaimed ${currentUtxo.satoshis} sats`];
    } catch (e: any) {
        err(`03-E failed: ${e.message}`);
        t03e.error = e.message;
    }
    t03e.durationMs = Date.now() - t03e.start;
    results.push(t03e);

    return results;
}

if (process.argv[1].includes('03_dutch_decay')) {
    const results = await runTest03();
    printSummary(results);
    process.exit(results.every(r => r.passed) ? 0 : 1);
}
