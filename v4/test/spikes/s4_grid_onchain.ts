/**
 * Spike S4: can a bin derive its price on chain from (step, index)?
 *
 *   1. Parity: the on-chain gridPrice (contracts/lib/grid.cash) equals the
 *      server mirror (test/grid.ts) bit for bit, over fixed edge cases and
 *      random (step, index); expected + 1 and − 1 are refused.
 *   2. Cost: operation cost of gridPrice at growing |index|.
 *   3. The grid bin (MeshBinV4Grid): honest fills pass, 1-sat underpay fails;
 *      bytes per bin crossed against the slim bin (S1).
 *   4. The exact grid against V3's floating-point grid (relative deviation).
 *
 * Usage: npx tsx test/spikes/s4_grid_onchain.ts   (writes test/spikes/s4_results.json)
 */
import { Contract } from 'cashscript';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { hexToBin } from '@bitauth/libauth';
import {
    TAKER, TOKEN_A, TOKEN_B, net, tb, tok, utxo, lockOf, le, sle, catVm,
    buildTx, verify, inputMetrics, check, expectAccept, expectReject, section, summary,
} from '../harness.js';
import { gridPrice, gridFraction, ONE } from '../grid.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '..', '..', 'artifacts', 'spikes');
const PROBE = JSON.parse(readFileSync(join(ART, 'GridProbe.json'), 'utf-8'));
const GBIN = JSON.parse(readFileSync(join(ART, 'MeshBinV4Grid.json'), 'utf-8'));
const probe = new Contract(PROBE, [], { provider: net, contractType: 'p2sh32' });

const probeTx = (step: bigint, index: bigint, expected: bigint) => () => tb()
    .addInput(utxo(probe.lockingBytecode, 10_000n), probe.unlock.check(step, index, expected))
    .addOutput({ to: TAKER.lock, amount: 9_000n });

// Deterministic PRNG so failures reproduce.
let seed = 0x5eed;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

const gridBin = (step: number, index: number, spread: number) => new Contract(GBIN, [
    '0x' + catVm(TOKEN_A), '0x' + le(step, 2), '0x' + sle(index, 4),
    '0x' + le(spread, 2), '0x' + catVm(TOKEN_B), '0x' + 'cd'.repeat(32), '0x' + le(6, 2),
], { provider: net, contractType: 'p2sh32' });

export function run() {
    const out: Record<string, unknown> = {};

    section('S4 · parity: on-chain gridPrice == server mirror');
    const fixed: Array<[number, number]> = [[100, 0], [100, 1], [100, -1], [100, 763], [100, -1843], [10, 18_420], [10, -18_420], [25, 1], [50, 4095], [100, 4096], [1, 1_000_000], [100, -2]];
    let ok = 0;
    const cases: Array<[number, number]> = [...fixed];
    for (let t = 0; t < 150; t++) cases.push([[1, 5, 10, 25, 50, 100, 200, 500][rnd(8)]!, rnd(40_001) - 20_000]);
    for (const [s, i] of cases) {
        const r = verify(buildTx(probeTx(BigInt(s), BigInt(i), gridPrice(s, i))()));
        if (r === true) ok++; else console.error(`     parity FAIL step ${s} index ${i}: ${r.slice(0, 100)}`);
    }
    check(`on-chain price equals the mirror for all ${cases.length} (step, index)`, ok === cases.length, `${ok}/${cases.length}`);
    out.parityCases = cases.length;
    for (const [s, i] of [[100, 763], [10, -18_420], [25, 1]] as Array<[number, number]>) {
        expectReject(`expected + 1 refused (step ${s}, index ${i})`, probeTx(BigInt(s), BigInt(i), gridPrice(s, i) + 1n), { at: 0 });
        expectReject(`expected − 1 refused (step ${s}, index ${i})`, probeTx(BigInt(s), BigInt(i), gridPrice(s, i) - 1n), { at: 0 });
    }

    section('S4 · cost of gridPrice as |index| grows');
    const cost: Record<string, string> = {};
    // Prices from 1e-8 to 1e8 sats per unit: |index| ≤ 1,852 at 100 bps, 18,430 at 10 bps, 184,216 at 1 bps.
    for (const [s, i] of [[100, 1], [100, 100], [100, 1_852], [100, -1_852], [10, 18_430], [1, 184_216], [1, -184_216]] as Array<[number, number]>) {
        const built = buildTx(probeTx(BigInt(s), BigInt(i), gridPrice(s, i))());
        const m = inputMetrics(built)[0]!;
        cost[`${s}bps/${i}`] = `${m.opCost} / ${m.maxOpCost}`;
        check(`step ${s} bps, index ${i} (≈ ${(Number(gridPrice(s, i)) / Number(ONE)).toPrecision(3)} sats/unit)`, m.ok, `op cost ${m.opCost} / ${m.maxOpCost}`);
    }
    out.gridPriceOpCost = cost;

    section('S4 · grid bin (prices derived on chain)');
    const g = gridBin(100, 763, 1);                    // ~ 2,000 sats per unit at 1 %
    const bid = gridPrice(100, 763), ask = gridPrice(100, 764);
    const priceStr = (p: bigint) => (Number(p) / Number(ONE)).toFixed(4);
    check('grid bin compiles to a constant-size redeem script', true, `${hexToBin(g.bytecode).length} B · bid ${priceStr(bid)} · ask ${priceStr(ask)} sats/unit`);
    const tokens = 100n;
    const cost100 = (tokens * ask + ONE - 1n) / ONE;           // ceil: the trader pays at least this
    const buy = (pay: bigint) => () => tb()
        .addInput(utxo(g.lockingBytecode, 1_000n, tok(tokens)), g.unlock.fill())
        .addInput(utxo(TAKER.lock, pay + 5_000n), TAKER.template.unlockP2PKH())
        .addOutput({ to: lockOf(g), amount: 1_000n + pay })
        .addOutput({ to: TAKER.lock, amount: 1_000n, token: tok(tokens) })
        .addOutput({ to: TAKER.lock, amount: 3_000n });
    expectAccept(`buy 100 tokens paying ceil(100 × ask) = ${cost100}`, buy(cost100));
    expectReject('buy paying 1 sat less', buy(cost100 - 1n), { at: 0 });
    const got = (tokens * bid) / ONE;                           // floor: the bin pays at most this
    const sell = (take: bigint) => () => tb()
        .addInput(utxo(g.lockingBytecode, 1_000n + 300_000n), g.unlock.fill())
        .addInput(utxo(TAKER.lock, 2_000n, tok(tokens)), TAKER.template.unlockP2PKH())
        .addOutput({ to: lockOf(g), amount: 1_000n + 300_000n - take, token: tok(tokens) })
        .addOutput({ to: TAKER.lock, amount: take });
    expectAccept(`sell 100 tokens taking floor(100 × bid) = ${got}`, sell(got));
    expectReject('sell taking 1 sat more', sell(got + 1n), { at: 0 });

    // Bytes per bin crossed: sweep of 1 and 24 grid bins (buy everything).
    const sweep = (n: number) => {
        const b = tb();
        let pay = 0n;
        const bins = Array.from({ length: n }, (_, k) => gridBin(100, 700 + 2 * k, 1));
        bins.forEach((c, k) => { b.addInput(utxo(c.lockingBytecode, 1_000n, tok(tokens)), c.unlock.fill()); pay += (tokens * gridPrice(100, 701 + 2 * k) + ONE - 1n) / ONE; });
        b.addInput(utxo(TAKER.lock, pay + 10_000n), TAKER.template.unlockP2PKH());
        bins.forEach((c, k) => b.addOutput({ to: lockOf(c), amount: 1_000n + (tokens * gridPrice(100, 701 + 2 * k) + ONE - 1n) / ONE }));
        b.addOutput({ to: TAKER.lock, amount: 1_000n, token: tok(tokens * BigInt(n)) });
        b.addOutput({ to: TAKER.lock, amount: 5_000n });
        return buildTx(b);
    };
    const s1b = sweep(1), s24 = sweep(24);
    check('grid sweeps of 1 and 24 bins verify', verify(s1b) === true && verify(s24) === true, `${s1b.size} B / ${s24.size} B`);
    const per = (s24.size - s1b.size) / 23;
    const s1 = JSON.parse(readFileSync(join(HERE, 's1_results.json'), 'utf-8'));
    const m = inputMetrics(s1b)[0]!;
    out.gridBinRedeemBytes = hexToBin(g.bytecode).length;
    out.gridBinBytesPerBinCrossed = per;
    out.gridBinFillOpCost = `${m.opCost} / ${m.maxOpCost}`;
    out.slimBytesPerBinCrossed = s1.bytesPerBinCrossed;
    check('bytes per bin crossed: grid bin vs slim bin', true, `${per.toFixed(1)} B vs ${s1.bytesPerBinCrossed.toFixed(1)} B (${(per - s1.bytesPerBinCrossed) >= 0 ? '+' : ''}${(per - s1.bytesPerBinCrossed).toFixed(1)} B)`);
    check('grid bin fill op cost', m.ok, `${m.opCost} / ${m.maxOpCost}`);

    section('S4 · exact grid vs the V3 floating-point grid');
    let worst = 0;
    for (const s of [10, 25, 50, 100]) for (let i = -2000; i <= 2000; i += 7) {
        const exact = Number(gridPrice(s, i)) / Number(ONE);
        const v3 = Math.exp(i * Math.log1p(s / 10_000));
        worst = Math.max(worst, Math.abs(exact / v3 - 1));
    }
    out.maxRelDeviationFromV3Grid = worst;
    check('largest relative deviation from (1+s)^i over |i| ≤ 2000', worst < 1e-9, worst.toExponential(2));
    const f = gridFraction(100, 763, 'up');
    check('a grid price fits a bytes8 fraction (for slim bins)', f.num < 1n << 63n && f.den < 1n << 63n, `ask ≈ ${f.num}/${f.den}`);

    writeFileSync(join(HERE, 's4_results.json'), JSON.stringify(out, null, 2) + '\n');
    return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
    summary('spike S4');
}
