/**
 * Spike S1: real bytes per bin crossed for the slim MeshBinV4 (P2SH32).
 *
 * Builds sweeps of N bins (trader buys every bin's tokens in one transaction),
 * verifies each with the BCH 2026 VM, and reports the marginal size per bin
 * (size(N) − size(1)) / (N − 1), the bin's input and output sizes, and the
 * operation cost of a bin input against its budget.
 *
 * Usage: npx tsx test/spikes/s1_bin_bytes.ts   (writes test/spikes/s1_results.json)
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { binToHex, encodeTransactionInputs, encodeTransactionOutputs } from '@bitauth/libauth';
import { OWNER, TAKER, TOKEN_A, TOKEN_B, net, tb, tok, utxo, lockOf, buildTx, verify, inputMetrics, check, section, summary } from '../harness.js';
import { PREFIX_LEN, binV4Contract, binV4Prefix, binV4Body, binV4Lock, redeemBytes, type BinV4Params } from '../v4_encode.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = JSON.parse(readFileSync(join(HERE, '..', '..', 'artifacts', 'MeshBinV4.json'), 'utf-8'));
const OWNER_CAT = TOKEN_B;

export const binParams = (k: number, over: Partial<BinV4Params> = {}): BinV4Params => ({
    tokenCat: TOKEN_A, ownerCat: OWNER_CAT,
    bidNum: BigInt(1990 + 10 * k), bidDen: 1n, askNum: BigInt(2000 + 10 * k), askDen: 1n,
    managerHash: 'cd'.repeat(32), cooldown: 6, ...over,
});

/** Trader buys all `tokens` from each of n bins at their ask. */
function sweep(n: number, tokens = 100n) {
    const bins = Array.from({ length: n }, (_, k) => binV4Contract(BIN, binParams(k), net));
    const b = tb();
    let pay = 0n;
    bins.forEach((c, k) => {
        b.addInput(utxo(c.lockingBytecode, 1_000n, tok(tokens)), c.unlock.fill());
        pay += tokens * binParams(k).askNum;
    });
    b.addInput(utxo(TAKER.lock, pay + 10_000n), TAKER.template.unlockP2PKH());
    bins.forEach((c, k) => b.addOutput({ to: lockOf(c), amount: 1_000n + tokens * binParams(k).askNum }));
    b.addOutput({ to: TAKER.lock, amount: 1_000n, token: tok(tokens * BigInt(n)) });
    b.addOutput({ to: TAKER.lock, amount: 5_000n });
    return b;
}

/** Trader sells `tokens` into each of n BCH-only bins at their bid (bins end holding tokens). */
function sellSweep(n: number, tokens = 100n) {
    const bins = Array.from({ length: n }, (_, k) => binV4Contract(BIN, binParams(k), net));
    const b = tb();
    bins.forEach((c, k) => b.addInput(utxo(c.lockingBytecode, 1_000n + tokens * binParams(k).bidNum), c.unlock.fill()));
    b.addInput(utxo(TAKER.lock, 2_000n, tok(tokens * BigInt(n))), TAKER.template.unlockP2PKH());
    let got = 0n;
    bins.forEach((c, k) => { b.addOutput({ to: lockOf(c), amount: 1_000n, token: tok(tokens) }); got += tokens * binParams(k).bidNum; });
    b.addOutput({ to: TAKER.lock, amount: got });
    return b;
}

export function run() {
    const out: Record<string, unknown> = {};

    section('S1 · encoding');
    const c0 = binV4Contract(BIN, binParams(0), net);
    const c1 = binV4Contract(BIN, binParams(7, { cooldown: 300, managerHash: '00'.repeat(32), bidNum: 1n, askNum: (1n << 62n) }), net);
    const r0 = redeemBytes(c0), r1 = redeemBytes(c1);
    const body = binV4Body(BIN, net);
    check('redeem script length is the same for any parameters', r0.length === r1.length, `${r0.length} B`);
    check(`parameter prefix is ${PREFIX_LEN} bytes and the body is shared`, binToHex(r0).slice(PREFIX_LEN * 2) === body && binToHex(r1).slice(PREFIX_LEN * 2) === body, `body ${body.length / 2} B`);
    check('hand-built prefix equals the compiled prefix', binToHex(r0).startsWith(binV4Prefix(binParams(0))));
    check('rebuilt P2SH32 equals the contract locking bytecode', binToHex(binV4Lock(binParams(0), body)) === c0.lockingBytecode);
    out.redeemBytes = r0.length; out.prefixBytes = PREFIX_LEN; out.bodyBytes = body.length / 2;

    section('S1 · sweeps (trader buys every bin)');
    const sizes: Record<number, number> = {};
    for (const n of [1, 2, 8, 16, 24]) {
        const built = buildTx(sweep(n));
        const ok = verify(built);
        check(`sweep of ${n} bin(s) is accepted by the 2026 VM`, ok === true, ok === true ? `${built.size} B` : ok);
        sizes[n] = built.size;
        if (n === 1) {
            const inBytes = encodeTransactionInputs([built.transaction.inputs[0]!]).length - 1;
            const outBytes = encodeTransactionOutputs([built.transaction.outputs[0]!]).length - 1;
            const m = inputMetrics(built)[0]!;
            out.binInputBytes = inBytes; out.binOutputBytes = outBytes;
            out.unlockingBytes = m.unlockingBytes;
            out.opCost = m.opCost; out.maxOpCost = m.maxOpCost;
            check('bin input + its output', true, `input ${inBytes} B (unlocking ${m.unlockingBytes}) + output ${outBytes} B = ${inBytes + outBytes} B`);
            check('bin input operation cost is within budget', m.opCost <= m.maxOpCost, `${m.opCost} / ${m.maxOpCost} (${Math.round((100 * m.opCost) / m.maxOpCost)}%)`);
        }
    }
    const perBin = (sizes[24]! - sizes[1]!) / 23;
    out.sweepSizes = sizes; out.bytesPerBinCrossed = perBin;
    check('marginal bytes per bin crossed', perBin > 0, `${perBin.toFixed(1)} B (V3 measured ~1,100; plan estimate ~430)`);
    check('24-bin sweep stays under the 100 KB standard size', sizes[24]! < 100_000, `${sizes[24]} B`);

    section('S1 · sell sweeps (bins end holding tokens: output carries a token prefix)');
    const sell: Record<number, number> = {};
    for (const n of [1, 24]) {
        const built = buildTx(sellSweep(n));
        const ok = verify(built);
        check(`sell sweep of ${n} bin(s) is accepted`, ok === true, ok === true ? `${built.size} B` : ok);
        sell[n] = built.size;
        if (n === 1) out.binOutputBytesWithToken = encodeTransactionOutputs([built.transaction.outputs[0]!]).length - 1;
    }
    out.bytesPerBinCrossedSell = (sell[24]! - sell[1]!) / 23;
    check('marginal bytes per bin crossed (sell)', true, `${(out.bytesPerBinCrossedSell as number).toFixed(1)} B; bin output with token ${out.binOutputBytesWithToken} B`);

    writeFileSync(join(HERE, 's1_results.json'), JSON.stringify(out, null, 2) + '\n');
    return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
    summary('spike S1');
}
