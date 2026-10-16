/**
 * Spike S3: how many bins can one PositionManagerV4 call handle?
 *
 * A manage transaction re-prices n bins (n in at inputs 1..n, n out at outputs
 * 0..n-1, every price moved up one level). The manager at input 0 rebuilds
 * each bin's address, sums both assets and checks bounds. We measure its
 * operation cost against its budget as n grows and find the largest n that
 * verifies, and what stops n + 1.
 *
 * Usage: npx tsx test/spikes/s3_manager_cost.ts   (writes test/spikes/s3_results.json)
 */
import { Contract } from 'cashscript';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { binToHex, hexToBin } from '@bitauth/libauth';
import {
    KEEPER, ATTACKER, OWNER, TOKEN_A, TOKEN_B, net, tb, tok, utxo, lockOf, le, catVm,
    buildTx, verify, inputMetrics, check, expectAccept, expectReject, section, summary,
} from '../harness.js';
import { binV4Contract, binV4Body, type BinV4Params } from '../v4_encode.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', 'artifacts');
const BIN = JSON.parse(readFileSync(join(ROOT, 'MeshBinV4.json'), 'utf-8'));
const MGR = JSON.parse(readFileSync(join(ROOT, 'spikes', 'PositionManagerV4.json'), 'utf-8'));
const BODY = binV4Body(BIN, net);
const COOLDOWN = 6;          // blocks between manage calls (manager parameter)
const NOW = 900_000;         // the manage transaction's locktime (a block height)
const LAST = NOW - 10;       // manageAfter of the bins being managed

function manager(keeperPkh = KEEPER.pkh, feeCap = 2_000n) {
    return new Contract(MGR, [
        '0x' + BODY, keeperPkh, '0x' + le(feeCap, 8), '0x' + le(COOLDOWN, 4),
        '0x' + le(1000, 8), '0x' + le(1, 8),      // floor: bid ≥ 1,000 sats per unit
        '0x' + le(100_000, 8), '0x' + le(1, 8),   // ceiling: ask ≤ 100,000
    ], { provider: net, contractType: 'p2sh32' });
}
const MANAGER = manager();
const MGR_HASH = binToHex(lockOf(MANAGER).slice(2, 34));

const level = (k: number) => ({ bid: BigInt(1990 + 10 * k), ask: BigInt(2000 + 10 * k) });
const params = (k: number, over: Partial<BinV4Params> = {}): BinV4Params => ({
    tokenCat: TOKEN_A, ownerCat: TOKEN_B, bidNum: level(k).bid, bidDen: 1n, askNum: level(k).ask, askDen: 1n,
    managerHash: MGR_HASH, manageAfter: LAST, ...over,
});
const rec = (p: BinV4Params) => le(p.askDen, 8) + le(p.askNum, 8) + le(p.bidDen, 8) + le(p.bidNum, 8);
const recIn = (p: BinV4Params) => rec(p) + le(p.manageAfter ?? 0, 4);
const shared = '0x' + catVm(TOKEN_A) + catVm(TOKEN_B);

interface ManageOpts {
    shiftBy?: number; satsShort?: bigint; tokShort?: bigint; outOver?: Partial<BinV4Params>;
    signer?: typeof KEEPER; mgr?: Contract; locktime?: number; nextAfter?: number; extraInput?: 'unlisted-bin' | 'none';
    noManager?: boolean; inAfter?: number;
}

/** Re-price n bins one level up; each holds 10,000 sats + 50 tokens. */
function manage(n: number, o: ManageOpts = {}) {
    const mgr = o.mgr ?? MANAGER;
    const locktime = o.locktime ?? NOW;
    const nextAfter = o.nextAfter ?? locktime + COOLDOWN;
    const ins = Array.from({ length: n }, (_, k) => params(k, o.inAfter !== undefined ? { manageAfter: o.inAfter } : {}));
    const outs = Array.from({ length: n }, (_, k) => params(k + (o.shiftBy ?? 1), { manageAfter: nextAfter, ...o.outOver }));
    const signer = o.signer ?? KEEPER;
    const b = tb().setLocktime(locktime);
    if (!o.noManager) {
        b.addInput(utxo(mgr.lockingBytecode, 1_000n), mgr.unlock.manage(
            shared, '0x' + ins.map(recIn).join(''), '0x' + outs.map(rec).join(''), '0x' + le(nextAfter, 4), signer.pub, signer.template,
        ));
    }
    ins.forEach((p) => {
        const c = binV4Contract(BIN, p, net);
        b.addInput(utxo(c.lockingBytecode, 10_000n, tok(50n)), c.unlock.manage());
    });
    if (o.extraInput === 'unlisted-bin') {
        const c = binV4Contract(BIN, params(99), net);
        b.addInput(utxo(c.lockingBytecode, 50_000n, tok(50n)), c.unlock.manage());
    }
    b.addInput(utxo(KEEPER.lock, 5_000n), KEEPER.template.unlockP2PKH());
    outs.forEach((p, j) => b.addOutput({
        to: lockOf(binV4Contract(BIN, p, net)),
        amount: 10_000n - (j === 0 ? o.satsShort ?? 0n : 0n),
        token: tok(50n - (j === 0 ? o.tokShort ?? 0n : 0n)),
    }));
    b.addOutput({ to: o.extraInput === 'unlisted-bin' ? ATTACKER.lock : KEEPER.lock, amount: o.extraInput === 'unlisted-bin' ? 50_000n : 4_000n, ...(o.extraInput === 'unlisted-bin' ? { token: tok(50n) } : {}) });
    return b;
}

export function run() {
    const out: Record<string, unknown> = {};

    section('S3 · sizes');
    const mgrBytes = hexToBin(MANAGER.bytecode).length;
    check('manager redeem script (incl. the 160-byte bin body)', mgrBytes < 10_000, `${mgrBytes} B`);
    out.managerRedeemBytes = mgrBytes;

    section('S3 · the draft enforces its rules (so the cost is of a real check)');
    expectAccept('keeper re-prices 3 bins one level up', () => manage(3));
    expectReject('1 sat short beyond the fee cap', () => manage(3, { satsShort: 2_001n }), { at: 0 });
    expectAccept('sats short within the fee cap (2,000)', () => manage(3, { satsShort: 2_000n }));
    expectReject('1 token short', () => manage(3, { tokShort: 1n }), { at: 0 });
    expectReject('new bin above the ceiling', () => manage(2, { outOver: { askNum: 100_001n } }), { at: 0 });
    expectReject('new bin with another owner', () => manage(2, { outOver: { ownerCat: TOKEN_A.replace(/^d/, 'e') } }), { at: 0 });
    expectReject('signed by someone other than the keeper', () => manage(2, { signer: ATTACKER }), { at: 0 });
    expectReject('an unlisted bin of the position slipped in', () => manage(2, { extraInput: 'unlisted-bin' }), { at: 0 });
    expectReject('bin manage() with no manager at input 0', () => manage(2, { noManager: true }), { at: 0 });
    expectReject('bin managed before its manageAfter height (locktime one block early)', () => manage(2, { inAfter: NOW + 1 }), { at: 1 });
    expectReject('new bins open to the next manage too soon (cooldown − 1)', () => manage(2, { nextAfter: NOW + COOLDOWN - 1 }), { at: 0 });
    expectAccept('new bins open exactly one cooldown later', () => manage(2, { nextAfter: NOW + COOLDOWN }));
    expectReject('locktime given as a time, not a height', () => manage(2, { locktime: 1_800_000_000, inAfter: 0, nextAfter: 1_800_000_010 }), { at: 0 });

    section('S3 · cost as n grows');
    const rows: Record<number, unknown> = {};
    for (const n of [1, 4, 8, 16, 32, 64]) {
        const built = buildTx(manage(n));
        const ok = verify(built);
        const m = inputMetrics(built)[0]!;
        rows[n] = { size: built.size, opCost: m.opCost, maxOpCost: m.maxOpCost, unlocking: m.unlockingBytes };
        check(`manage ${n} bin(s)`, ok === true, ok === true
            ? `tx ${built.size} B · manager op cost ${m.opCost} / ${m.maxOpCost} (${Math.round((100 * m.opCost) / m.maxOpCost)}%) · unlocking ${m.unlockingBytes} B`
            : ok.slice(0, 160));
    }
    out.byN = rows;

    const fits = (n: number) => verify(buildTx(manage(n))) === true;
    let lo = 1, hi = 2;
    while (fits(hi)) { lo = hi; hi *= 2; if (hi > 4096) break; }
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
    const fail = verify(buildTx(manage(lo + 1)));
    out.maxBinsPerCall = lo; out.limitAtNext = String(fail).slice(0, 200);
    check('largest n in one manage call', lo >= 8, `${lo} bins; at ${lo + 1}: ${String(fail).slice(0, 140)}`);

    writeFileSync(join(HERE, 's3_results.json'), JSON.stringify(out, null, 2) + '\n');
    return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
    summary('spike S3');
}
