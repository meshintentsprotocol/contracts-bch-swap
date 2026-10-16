/**
 * Spike S2: P2S bins (≤ 201 B locking script) checked by one looping validator.
 *
 * Measures the P2S bin size, the validator size, bytes per bin crossed, the
 * fixed cost of the validator input (+ its recreated output), the break-even
 * sweep size against the slim P2SH bin (S1), and the validator's operation
 * cost as the sweep grows. A few reject cases make sure the numbers come from
 * a validator that actually enforces the rules.
 *
 * Usage: npx tsx test/spikes/s2_p2s_validator.ts   (writes test/spikes/s2_results.json)
 */
import { Contract } from 'cashscript';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { binToHex, encodeTransactionInputs, encodeTransactionOutputs, hexToBin } from '@bitauth/libauth';
import {
    TAKER, ATTACKER, TOKEN_A, TOKEN_B, net, tb, tok, utxo, lockOf, catVm, le,
    buildTx, verify, inputMetrics, check, expectAccept, expectReject, section, summary,
} from '../harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '..', '..', 'artifacts', 'spikes');
const BIN = JSON.parse(readFileSync(join(ART, 'MeshBinP2S.json'), 'utf-8'));
const VAL = JSON.parse(readFileSync(join(ART, 'BinValidatorV4.json'), 'utf-8'));

// Body of the P2S bin: its locking script after the 135-byte parameter prefix.
const probeBin = new Contract(BIN, ['0x' + 'aa'.repeat(32), '0x' + le(1, 8), '0x' + le(1, 8), '0x' + le(1, 8), '0x' + le(1, 8), '0x' + 'bb'.repeat(32), '0x' + 'cc'.repeat(32)], { provider: net, contractType: 'p2s' });
const BODY = probeBin.bytecode.slice(135 * 2);
const validator = new Contract(VAL, ['0x' + BODY], { provider: net, contractType: 'p2sh32' });
const VAL_HASH = binToHex(lockOf(validator).slice(2, 34));

const ask = (k: number) => BigInt(2000 + 10 * k);
const bid = (k: number) => BigInt(1990 + 10 * k);
const p2sBin = (k: number, valHash = VAL_HASH) => new Contract(BIN, [
    '0x' + catVm(TOKEN_A), '0x' + le(bid(k), 8), '0x' + le(1, 8), '0x' + le(ask(k), 8), '0x' + le(1, 8),
    '0x' + catVm(TOKEN_B), '0x' + valHash,
], { provider: net, contractType: 'p2s' });

/** Trader buys all tokens from n P2S bins; validator at input 0 (recreated at the last output). */
function sweep(n: number, opts: { underpay?: number; noValidator?: boolean; tokens?: bigint; pad?: number } = {}) {
    const tokens = opts.tokens ?? 100n;
    const bins = Array.from({ length: n }, (_, k) => p2sBin(k));
    const b = tb();
    if (!opts.noValidator) b.addInput(utxo(validator.lockingBytecode, 1_000n), validator.unlock.validate("0x" + "00".repeat(opts.pad ?? 0)));
    let pay = 0n;
    bins.forEach((c, k) => { b.addInput(utxo(c.lockingBytecode, 1_000n, tok(tokens)), c.unlock.fill()); pay += tokens * ask(k); });
    b.addInput(utxo(TAKER.lock, pay + 10_000n), TAKER.template.unlockP2PKH());
    if (!opts.noValidator) b.addOutput({ to: TAKER.lock, amount: 1_000n }); // output 0 pairs with the validator input
    bins.forEach((c, k) => b.addOutput({ to: lockOf(c), amount: 1_000n + tokens * ask(k) - (opts.underpay === k ? 1n : 0n) }));
    b.addOutput({ to: TAKER.lock, amount: 1_000n, token: tok(tokens * BigInt(n)) });
    b.addOutput({ to: lockOf(validator), amount: 1_000n });  // a fresh validator UTXO for the next fill
    return b;
}

/**
 * Smallest padding that gives the validator enough budget for n bins, or −1
 * if it would need an unlocking script over 10,000 bytes. Cost is measured
 * with a generous pad (the pad's own push costs a little), then solved for.
 */
function padFor(n: number): number {
    const probe = inputMetrics(buildTx(sweep(n, { pad: 9_000 })))[0]!;
    if (!probe.ok) return -1;
    const base = probe.unlockingBytes - 9_000 - 3;               // unlocking without the pad and its push header
    let pad = Math.max(0, Math.ceil(probe.opCost / 800) - 41 - base - 3);
    for (; pad <= 9_990; pad++) {
        const m = inputMetrics(buildTx(sweep(n, { pad })))[0]!;
        if (m.ok) return m.unlockingBytes <= 10_000 ? pad : -1;
    }
    return -1;
}

export function run() {
    const out: Record<string, unknown> = {};
    const s1 = JSON.parse(readFileSync(join(HERE, 's1_results.json'), 'utf-8'));

    section('S2 · sizes');
    const binLen = hexToBin(p2sBin(0).bytecode).length;
    const valRedeem = hexToBin(validator.bytecode).length;
    check('P2S bin locking script is ≤ 201 B (standard)', binLen <= 201, `${binLen} B (params 135 + body ${BODY.length / 2})`);
    check('validator redeem script', valRedeem < 10_000, `${valRedeem} B`);
    out.p2sBinBytes = binLen; out.p2sBodyBytes = BODY.length / 2; out.validatorRedeemBytes = valRedeem;

    section('S2 · the validator enforces the rules (so the numbers are real)');
    expectAccept('sweep of 3 P2S bins with the validator', () => sweep(3));
    expectReject('one bin underpaid by 1 sat → the validator refuses', () => sweep(3, { underpay: 1 }), { at: 0 });
    expectReject('P2S bins spent without the validator at input 0', () => sweep(2, { noValidator: true }), { at: 0 });
    expectReject('bin naming another validator rides along', () => {
        const b = sweep(1);
        const rogue = p2sBin(5, 'ee'.repeat(32));
        (b as any).inputs.splice(2, 0, { ...utxo(rogue.lockingBytecode, 1_000n, tok(100n)), unlocker: rogue.unlock.fill() });
        (b as any).outputs.splice(2, 0, { to: ATTACKER.lock, amount: 1_000n, token: tok(100n) });
        return b;
    }, { at: 2 });

    section('S2 · sweeps');
    // Without padding the validator's budget is (unlocking 280 + 41) × 800 = 224,000: about 8 bins.
    const unpadded = (n: number) => inputMetrics(buildTx(sweep(n)))[0]!.ok;
    let maxUnpadded = 1;
    while (unpadded(maxUnpadded + 1)) maxUnpadded++;
    out.maxBinsUnpadded = maxUnpadded;
    check('largest sweep with no padding', maxUnpadded >= 1, `${maxUnpadded} bins`);

    const sizes: Record<number, number> = {};
    const costs: Record<number, string> = {};
    const pads: Record<number, number> = {};
    for (const n of [1, 2, 8, 16, 24, 48]) {
        const pad = padFor(n);
        const built = buildTx(sweep(n, { pad }));
        const ok = verify(built);
        check(`sweep of ${n} P2S bin(s) accepted (pad ${pad} B)`, ok === true, ok === true ? `${built.size} B` : ok);
        sizes[n] = built.size; pads[n] = pad;
        const m = inputMetrics(built)[0]!;
        costs[n] = `${m.opCost} / ${m.maxOpCost}`;
        if (n === 1) {
            const vin = encodeTransactionInputs([built.transaction.inputs[0]!]).length - 1;
            const vout = encodeTransactionOutputs([built.transaction.outputs.at(-1)!]).length - 1;
            const bin = encodeTransactionInputs([built.transaction.inputs[1]!]).length - 1;
            const bout = encodeTransactionOutputs([built.transaction.outputs[1]!]).length - 1;
            out.validatorInputBytes = vin; out.validatorOutputBytes = vout; out.p2sBinInputBytes = bin; out.p2sBinOutputBytes = bout;
            check('validator input + recreated output (fixed per transaction)', true, `${vin} + ${vout} = ${vin + vout} B`);
            check('P2S bin input + output', true, `${bin} + ${bout} = ${bin + bout} B`);
        }
    }
    const perBin = (sizes[24]! - sizes[1]!) / 23;
    out.sweepSizes = sizes; out.validatorOpCost = costs; out.validatorPad = pads; out.bytesPerBinCrossed = perBin;
    check('marginal bytes per bin crossed (P2S)', true, `${perBin.toFixed(1)} B (slim P2SH: ${s1.bytesPerBinCrossed.toFixed(1)} B)`);
    for (const n of [1, 8, 24, 48]) check(`validator op cost at ${n} bins`, true, costs[n]!);

    // Break-even: P2S total (validator fixed + per bin) vs slim (per bin), same trader parts.
    const fixed = (out.validatorInputBytes as number) + (out.validatorOutputBytes as number) + 9; // + the paired output 0
    const saving = s1.bytesPerBinCrossed - perBin;
    const breakEven = Math.ceil(fixed / saving);
    out.validatorFixedBytes = fixed; out.breakEvenBins = breakEven;
    check('break-even sweep size against slim bins', saving > 0, `fixed ${fixed} B / saving ${saving.toFixed(1)} B per bin → P2S wins from ${breakEven} bins`);

    // Largest padded sweep: limited by the 10,000-byte unlocking script or the 100 KB transaction.
    const fits = (n: number) => { const pad = padFor(n); if (pad < 0) return false; const b = buildTx(sweep(n, { pad })); return verify(b) === true; };
    let lo = 48, hi = 96;
    while (fits(hi)) { lo = hi; hi *= 2; }
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
    const nextPad = padFor(lo + 1);
    const why = nextPad < 0 ? 'the padding would pass the 10,000-byte unlocking limit' : `transaction verify: ${String(verify(buildTx(sweep(lo + 1, { pad: nextPad })))).slice(0, 90)}`;
    out.maxBinsPerSweep = lo; out.maxBinsLimitedBy = why;
    check('largest P2S sweep in one transaction', lo >= 24, `${lo} bins; at ${lo + 1}: ${why}`);
    const padPerBin = (pads[48]! - pads[24]!) / 24;
    out.padBytesPerBin = padPerBin;
    out.bytesPerBinCrossedWithPad = perBin;
    check('padding needed per bin (included in the marginal size above)', true, `${padPerBin.toFixed(1)} B`);

    writeFileSync(join(HERE, 's2_results.json'), JSON.stringify(out, null, 2) + '\n');
    return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
    summary('spike S2');
}
