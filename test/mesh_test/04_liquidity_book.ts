/**
 * BCHMesh Test 04 — Liquidity Book Simulation
 *
 * Simulates a real order book on BCH with 6 limit orders at different prices:
 *
 *   BID SIDE (BCH buying tokens):
 *     BID-1: 10,000 sats reserve @ 1 sat/token  (best bid)
 *     BID-2: 10,000 sats reserve @ 0.9 sat/token
 *     BID-3:  8,000 sats reserve @ 0.8 sat/token
 *
 *   ASK SIDE (token selling for BCH) — reverse strategies:
 *     ASK-1: 10,000 sats reserve @ 1.1 sat/token (best ask)
 *     ASK-2: 10,000 sats reserve @ 1.2 sat/token
 *     ASK-3: 10,000 sats reserve @ 1.3 sat/token
 *
 * Then:
 *   - Fills BID-1 (best bid)  with 2000 tokens
 *   - Fills ASK-1 (best ask)  with 2000 tokens
 *   - Docks all remaining positions
 *
 * This demonstrates BCHMesh as a real CLOB (Central Limit Order Book)
 * on-chain using covenants instead of an AMM.
 */

import { Contract, TransactionBuilder } from 'cashscript';
import {
    loadWallet, loadArtifact, fundBchContract, dockContract,
    TOKEN_A, TOKEN_B, reverseHex, section, banner, log, ok, err, sleep,
    createResult, printSummary, contractLockingHex, findOutputIndex,
    type TestResult, type WalletCtx
} from './utils.js';

const ARTIFACT = 'StrategyCovenant';

interface Order {
    side: 'BID' | 'ASK';
    label: string;
    reserveSats: bigint;
    priceNum: bigint;  // sats per token * 10 (to handle 0.9 sats)
    priceDen: bigint;  // denominator for fractional prices
    feeBps: bigint;
    contract: Contract;
    utxo: { txid: string; vout: number; satoshis: bigint };
}

async function openOrder(
    ctx: WalletCtx,
    artifact: any,
    side: 'BID' | 'ASK',
    label: string,
    reserveSats: bigint,
    priceNum: bigint,
    priceDen: bigint,
    feeBps: bigint
): Promise<Order> {
    // BID: tokenCategoryIn = TOKEN_A, tokenCategoryOut = BCH (0x)
    // ASK: tokenCategoryIn = TOKEN_B, tokenCategoryOut = BCH (same for simplicity in this test)
    const inCat = side === 'BID'
        ? `0x${reverseHex(TOKEN_A)}`
        : `0x${reverseHex(TOKEN_B)}`;

    const contract = new Contract(
        artifact,
        [ctx.ownerPkhBytes, inCat, '0x', priceNum, priceDen, feeBps],
        { provider: ctx.provider }
    );

    log(`[${label}] ${side} contract: ${contract.address}`);
    log(`[${label}] ${reserveSats} sats | Price: ${priceNum}/${priceDen} | Fee: ${feeBps}bps`);

    const { txid, vout } = await fundBchContract(ctx, contract.address, reserveSats, label);

    return {
        side, label, reserveSats, priceNum, priceDen, feeBps, contract,
        utxo: { txid, vout, satoshis: reserveSats }
    };
}

async function fillOrder(
    ctx: WalletCtx,
    order: Order,
    amountIn: bigint
): Promise<string> {
    const amountOut        = (amountIn * order.priceNum * (10000n - order.feeBps)) / (order.priceDen * 10000n);
    const remainingReserve = order.utxo.satoshis - amountOut;

    log(`[${order.label}] Fill: ${amountIn} tokens → ${amountOut} sats BCH`);

    const tokenCat = order.side === 'BID' ? TOKEN_A : TOKEN_B;

    const tokenUtxos = await ctx.provider.getUtxos(ctx.tokenAddr);
    const tokenUtxo  = tokenUtxos.find(u => u.token?.category === tokenCat && u.token.amount >= amountIn);
    if (!tokenUtxo) throw new Error(`No ${tokenCat.slice(0,8)} token UTXO`);

    const bchUtxos = await ctx.provider.getUtxos(ctx.userAddr);
    const feeUtxo  = bchUtxos.find(u => !u.token && u.satoshis > 5000n);
    if (!feeUtxo) throw new Error('No fee UTXO');

    const txBuilder = new TransactionBuilder({ provider: ctx.provider });
    txBuilder.addInput(order.utxo, order.contract.unlock.fill(amountIn));
    txBuilder.addInput(tokenUtxo, ctx.sig.unlockP2PKH());
    txBuilder.addInput(feeUtxo, ctx.sig.unlockP2PKH());

    txBuilder.addOutput({ to: order.contract.address, amount: remainingReserve });
    txBuilder.addOutput({ to: ctx.userAddr, amount: amountOut });
    txBuilder.addOutput({ to: ctx.tokenAddr, amount: 1000n, token: { amount: amountIn, category: tokenCat } });

    const tokenChange = tokenUtxo.token!.amount - amountIn;
    if (tokenChange > 0n) {
        txBuilder.addOutput({ to: ctx.tokenAddr, amount: 1000n, token: { amount: tokenChange, category: tokenCat } });
    }

    const totalBchIn  = order.utxo.satoshis + tokenUtxo.satoshis + feeUtxo.satoshis;
    const dustForToken = (tokenChange > 0n ? 1000n : 0n) + 1000n;
    const bchChange   = totalBchIn - remainingReserve - amountOut - dustForToken - 2000n;
    if (bchChange > 546n) {
        txBuilder.addOutput({ to: ctx.userAddr, amount: bchChange });
    }

    const tx = await txBuilder.send();
    ok(`[${order.label}] Fill TX: ${tx.txid}`);
    log(`   Explorer: https://chipnet.chaingraph.cash/tx/${tx.txid}`);

    // Update UTXO
    const lbHex  = contractLockingHex(order.contract.address);
    const newVout = await findOutputIndex(ctx.provider, tx.txid, lbHex);
    order.utxo = { txid: tx.txid, vout: newVout, satoshis: remainingReserve };
    return tx.txid;
}

export async function runTest04(): Promise<TestResult[]> {
    banner('TEST 04 — Liquidity Book: 6 Orders (BID+ASK)', '3 BIDs + 3 ASKs → fill best BID + best ASK → dock all');
    const results: TestResult[] = [];

    const ctx      = await loadWallet();
    const artifact = loadArtifact(ARTIFACT);

    // ── Test 04-A: Open the order book ─────────────────────────────────────
    const t04a = createResult('04-A: Open 6-order liquidity book');
    section('04-A: Open 6 Orders (3 BID + 3 ASK)');
    const orders: Order[] = [];
    try {
        // BID side (pay TOKEN_A, receive BCH)
        orders.push(await openOrder(ctx, artifact, 'BID', 'BID-1 (best)', 10_000n, 10n, 10n, 30n)); await sleep(3000);
        orders.push(await openOrder(ctx, artifact, 'BID', 'BID-2', 10_000n,  9n, 10n, 30n)); await sleep(3000);
        orders.push(await openOrder(ctx, artifact, 'BID', 'BID-3', 8_000n,   8n, 10n, 30n)); await sleep(3000);
        // ASK side (pay TOKEN_B, receive BCH at higher prices)
        orders.push(await openOrder(ctx, artifact, 'ASK', 'ASK-1 (best)', 10_000n, 11n, 10n, 30n)); await sleep(3000);
        orders.push(await openOrder(ctx, artifact, 'ASK', 'ASK-2', 10_000n, 12n, 10n, 30n)); await sleep(3000);
        orders.push(await openOrder(ctx, artifact, 'ASK', 'ASK-3', 10_000n, 13n, 10n, 30n)); await sleep(3000);

        ok(`6 orders open. BID spread: 0.8-1.0 sat/token | ASK spread: 1.1-1.3 sat/token`);
        log(`Bid-Ask Spread: 0.1 sats/token`);
        t04a.passed = true;
        t04a.txids  = orders.map(o => o.utxo.txid);
        t04a.notes  = ['BID: 1.0|0.9|0.8 sat/token', 'ASK: 1.1|1.2|1.3 sat/token', 'Spread: 0.1 sat'];
    } catch (e: any) {
        err(`04-A failed: ${e.message}`);
        t04a.error = e.message;
    }
    t04a.durationMs = Date.now() - t04a.start;
    results.push(t04a);

    if (orders.length < 6) return results;

    // ── Test 04-B: Fill best BID and best ASK ──────────────────────────────
    const t04b = createResult('04-B: Fill best BID + best ASK (market orders)');
    section('04-B: Execute Market Orders Against Best Bid & Ask');
    try {
        log('Filling BID-1 (best bid) with 2000 TOKEN_A tokens...');
        const bidTxid = await fillOrder(ctx, orders[0], 2000n);
        await sleep(3000);

        log('Filling ASK-1 (best ask) with 2000 TOKEN_B tokens...');
        const askTxid = await fillOrder(ctx, orders[3], 2000n);

        t04b.passed = true;
        t04b.txids  = [bidTxid, askTxid];
        t04b.notes  = ['BID-1 filled at 1.0 sat/token', 'ASK-1 filled at 1.1 sat/token'];
    } catch (e: any) {
        err(`04-B failed: ${e.message}`);
        t04b.error = e.message;
    }
    t04b.durationMs = Date.now() - t04b.start;
    results.push(t04b);

    // ── Test 04-C: Dock all 6 orders ───────────────────────────────────────
    const t04c = createResult('04-C: Dock all 6 orders');
    section('04-C: Dock All 6 Remaining Orders');
    const dockTxids: string[] = [];
    let dockPassed = true;
    for (const order of orders) {
        try {
            await sleep(3000);
            log(`Docking ${order.label} (${order.utxo.satoshis} sats)...`);
            const txid = await dockContract(ctx, order.contract, order.utxo);
            dockTxids.push(txid);
        } catch (e: any) {
            err(`Dock ${order.label} failed: ${e.message}`);
            dockPassed = false;
        }
    }
    t04c.passed = dockPassed;
    t04c.txids  = dockTxids;
    t04c.notes  = [`${dockTxids.length}/6 orders docked`];
    t04c.durationMs = Date.now() - t04c.start;
    results.push(t04c);

    return results;
}

if (process.argv[1].includes('04_liquidity_book')) {
    const results = await runTest04();
    printSummary(results);
    process.exit(results.every(r => r.passed) ? 0 : 1);
}
