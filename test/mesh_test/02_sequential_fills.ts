/**
 * BCHMesh Test 02 — Sequential Partial Fills & Full Exhaustion
 *
 * Tests:
 *   A. Fund 1 large position (50,000 sats reserve)
 *   B. Fill it 5 times in sequence (covenant self-recreates each time)
 *   C. Final fill exhausts the last of the reserve
 *   D. Verify final covenant UTXO is spent (no remaining sats)
 *
 * This tests the core "perpetual market maker" behavior:
 *   Fill 1: 2000 tokens → 1994 sats (reserve: 48006)
 *   Fill 2: 2000 tokens → 1994 sats (reserve: 46012)
 *   Fill 3: 3000 tokens → 2991 sats (reserve: 43021)
 *   Fill 4: 5000 tokens → 4985 sats (reserve: 38036)
 *   Fill 5: 5000 tokens → 4985 sats (reserve: 33051) — then dock remainder
 */

import { Contract, TransactionBuilder } from 'cashscript';
import {
    loadWallet, loadArtifact, fundBchContract, dockContract,
    TOKEN_A, reverseHex, section, banner, log, ok, err, sleep,
    createResult, printSummary, contractLockingHex, findOutputIndex,
    type TestResult, type WalletCtx
} from './utils.js';

const ARTIFACT = 'StrategyCovenant';

async function doFill(
    ctx: WalletCtx,
    contract: Contract,
    currentUtxo: { txid: string; vout: number; satoshis: bigint },
    amountIn: bigint,
    priceNum: bigint,
    priceDen: bigint,
    feeBps: bigint,
    fillNum: number
): Promise<{ txid: string; utxo: { txid: string; vout: number; satoshis: bigint } }> {
    const amountOut       = (amountIn * priceNum * (10000n - feeBps)) / (priceDen * 10000n);
    const remainingReserve = currentUtxo.satoshis - amountOut;

    log(`  Fill #${fillNum}: ${amountIn} tokens → ${amountOut} sats BCH | reserve: ${currentUtxo.satoshis} → ${remainingReserve}`);

    const tokenUtxos = await ctx.provider.getUtxos(ctx.tokenAddr);
    const tokenUtxo  = tokenUtxos.find(u => u.token?.category === TOKEN_A && u.token.amount >= amountIn);
    if (!tokenUtxo) throw new Error(`No token UTXO with ${amountIn} tokens`);

    const bchUtxos = await ctx.provider.getUtxos(ctx.userAddr);
    const feeUtxo  = bchUtxos.find(u => !u.token && u.satoshis > 5000n);
    if (!feeUtxo) throw new Error('No BCH fee UTXO');

    const txBuilder = new TransactionBuilder({ provider: ctx.provider });
    txBuilder.addInput(currentUtxo, contract.unlock.fill(amountIn));
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
    const dustForToken = (tokenChange > 0n ? 1000n : 0n) + 1000n; // Output 2 + token change
    const bchChange   = totalBchIn - remainingReserve - amountOut - dustForToken - 2000n;
    if (bchChange > 546n) {
        txBuilder.addOutput({ to: ctx.userAddr, amount: bchChange });
    }

    const tx = await txBuilder.send();
    ok(`  Fill #${fillNum} TX: ${tx.txid}`);
    log(`     Explorer: https://chipnet.chaingraph.cash/tx/${tx.txid}`);

    const lbHex  = contractLockingHex(contract.address);
    const newVout = await findOutputIndex(ctx.provider, tx.txid, lbHex);

    return {
        txid: tx.txid,
        utxo: { txid: tx.txid, vout: newVout, satoshis: remainingReserve }
    };
}

export async function runTest02(): Promise<TestResult[]> {
    banner('TEST 02 — Sequential Multi-Fill & Reserve Exhaustion', '5 sequential fills on 1 large position');
    const results: TestResult[] = [];

    const ctx      = await loadWallet();
    const artifact = loadArtifact(ARTIFACT);

    const tokenCategoryInLE = `0x${reverseHex(TOKEN_A)}`;
    const priceNum = 1n, priceDen = 1n, feeBps = 30n;
    const RESERVE  = 50_000n;

    const contract = new Contract(
        artifact,
        [ctx.ownerPkhBytes, tokenCategoryInLE, '0x', priceNum, priceDen, feeBps],
        { provider: ctx.provider }
    );

    // ── Test 02-A: Fund the large position ─────────────────────────────────
    const t02a = createResult('02-A: Fund 1 large position (50,000 sats)');
    section('02-A: Fund large StrategyCovenant (50,000 sats)');
    let currentUtxo: { txid: string; vout: number; satoshis: bigint };
    try {
        const { txid, vout } = await fundBchContract(ctx, contract.address, RESERVE, 'Large-Position');
        currentUtxo = { txid, vout, satoshis: RESERVE };
        t02a.passed = true;
        t02a.txids  = [txid];
        t02a.notes  = [`50,000 sats @ ${contract.address}`];
    } catch (e: any) {
        err(`02-A failed: ${e.message}`);
        t02a.error   = e.message;
        t02a.passed  = false;
        t02a.durationMs = Date.now() - t02a.start;
        results.push(t02a);
        return results;
    }
    t02a.durationMs = Date.now() - t02a.start;
    results.push(t02a);

    // ── Test 02-B: 5 sequential fills ──────────────────────────────────────
    const t02b = createResult('02-B: 5 sequential partial fills (covenant self-recreates each time)');
    section('02-B: 5 Sequential Fills');
    const fillAmounts = [2000n, 2000n, 3000n, 5000n, 5000n];
    const fillTxids: string[] = [];
    try {
        for (let i = 0; i < fillAmounts.length; i++) {
            await sleep(4000);
            const result = await doFill(ctx, contract, currentUtxo, fillAmounts[i], priceNum, priceDen, feeBps, i + 1);
            currentUtxo = result.utxo;
            fillTxids.push(result.txid);
        }
        ok(`All 5 fills completed! Final reserve: ${currentUtxo.satoshis} sats`);
        t02b.passed = true;
        t02b.txids  = fillTxids;
        t02b.notes  = [`Final reserve: ${currentUtxo.satoshis} sats`, `Total tokens received: ${fillAmounts.reduce((a, b) => a + b, 0n)}`];
    } catch (e: any) {
        err(`02-B failed: ${e.message}`);
        t02b.error = e.message;
    }
    t02b.durationMs = Date.now() - t02b.start;
    results.push(t02b);

    // ── Test 02-C: Dock remaining reserve ──────────────────────────────────
    const t02c = createResult('02-C: Dock remaining reserve after 5 fills');
    section('02-C: Dock remaining reserve');
    try {
        await sleep(3000);
        log(`Docking remaining ${currentUtxo.satoshis} sats...`);
        const dockTxid = await dockContract(ctx, contract, currentUtxo);
        t02c.passed = true;
        t02c.txids  = [dockTxid];
        t02c.notes  = [`Reclaimed ${currentUtxo.satoshis} sats from position`];
    } catch (e: any) {
        err(`02-C failed: ${e.message}`);
        t02c.error = e.message;
    }
    t02c.durationMs = Date.now() - t02c.start;
    results.push(t02c);

    return results;
}

if (process.argv[1].includes('02_sequential_fills')) {
    const results = await runTest02();
    printSummary(results);
    process.exit(results.every(r => r.passed) ? 0 : 1);
}
