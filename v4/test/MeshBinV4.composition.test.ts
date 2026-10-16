/**
 * B7 composition: a V4 bin in the same transaction as an intent
 * (LimitOrderSwapV2), a V3 pool (MeshPoolV3) and a Cauldron pool (PoolV0).
 * Each covenant checks only its own indices, so they compose; each one must
 * still hold when another leg is honest.
 *
 * The V2/V3 artifacts are the repo-root ones compiled with cashc 0.12.1 (their
 * on-chain bytecode); they load in CashScript 0.14 unchanged. The V3 args come
 * from V3's own encoder. Cauldron PoolV0's script is copied from
 * @cashlab/cauldron 1.0.3 (out/binutil.js), the library meshserver trades with.
 *
 * Usage: npx tsx test/MeshBinV4.composition.test.ts
 */
import { Contract, type Unlocker } from 'cashscript';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { binToHex, encodeDataPush, hash160, hexToBin } from '@bitauth/libauth';
import { OWNER, TAKER, ATTACKER, TOKEN_A, net, tok, catVm, expectAccept, expectReject, check, section, summary } from './harness.js';
import { balanced, binLeg, type Leg } from './tx.js';
import { binOf } from './v4_encode.js';
import { BASE } from './MeshBinV4.test.js';
import { v3Args } from '../../test/mesh_test/v3_encode.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const rootArt = (n: string) => JSON.parse(readFileSync(join(HERE, '..', '..', 'artifacts', `${n}.json`), 'utf-8'));
const LIMIT = rootArt('LimitOrderSwapV2');
const V3 = rootArt('MeshPoolV3');

// ── Cauldron PoolV0 (trade path: unlocking is just the redeem script push) ─────
const CAULDRON_PRE = '746376a914';
const CAULDRON_POST = '88ac67c0d1c0ce88c25288c0cdc0c788c0c6c0d095c0c6c0cc9490539502e80396c0cc7c94c0d3957ca268';
const cauldronRedeem = (pkh: Uint8Array) => hexToBin(CAULDRON_PRE + binToHex(pkh) + CAULDRON_POST);
const cauldronLock = (pkh: Uint8Array) => Uint8Array.from([0xa9, 0x14, ...hash160(cauldronRedeem(pkh)), 0x87]);
const cauldronTrade = (pkh: Uint8Array): Unlocker => ({ generateUnlockingBytecode: () => encodeDataPush(cauldronRedeem(pkh)) });
/**
 * Smallest sats a Cauldron pool must end with after giving `give` tokens. Its trade rule:
 *   (sOut − fee) · tOut ≥ sIn · tIn,   fee = floor(|sIn − sOut| · 3 / 1000)
 */
function cauldronBuyCost(sIn: bigint, tIn: bigint, give: bigint): bigint {
    const tOut = tIn - give;
    const ok = (sOut: bigint) => (sOut - ((sOut - sIn) * 3n) / 1000n) * tOut >= sIn * tIn;
    let lo = sIn, hi = sIn * 2n;
    while (hi - lo > 1n) { const m = (lo + hi) / 2n; if (ok(m)) hi = m; else lo = m; }
    return hi;
}

const T0 = 1_800_000_000;               // a time locktime: LimitOrderSwapV2 requires one
const EXP = BigInt(T0 + 3_600);
const MAKER = TAKER;
const SOLVER = ATTACKER;                 // the filler is not the LP
const LP_POOL = OWNER;

export function run() {
    const intent = new Contract(LIMIT, [MAKER.pkh, '0x' + catVm(TOKEN_A), '0x', 20n, 35_000n, EXP], { provider: net, contractType: 'p2sh32' });
    const v3 = new Contract(V3, v3Args({ ownerPkh: LP_POOL.pkh, reserve: 'BCH', slots: [{ cat: TOKEN_A, num: 2000n, den: 1n }], feeBps: 30, mode: 0 }), { provider: net, contractType: 'p2sh32' });
    const bin = binOf(BASE, net);                         // bid 1,990 / ask 2,000
    const CPKH = hash160(Uint8Array.from([7, 7, 7]));
    const cauldron = cauldronLock(CPKH);
    const v3Out10 = (10n * 2000n * (10_000n - 30n)) / 10_000n;   // 19,940
    const C_S = 1_000_000n, C_T = 500n;
    const cOut = cauldronBuyCost(C_S, C_T, 5n);
    check('Cauldron leg priced from its own K rule', cOut > C_S, `5 tokens cost ${cOut - C_S} sats`);

    /**
     * [0] intent: maker sells 20 tokens, wants ≥ 35,000 sats at output 0
     * [1] V4 bin buys 10 of them at its bid (19,900)
     * [2] V3 pool buys the other 10 (19,940); its proceeds slot is output 2 + 5 = 7
     * [3] Cauldron: the solver buys 5 tokens
     * [4] solver funding (added by balanced(); the solver receives the change and the 5 tokens)
     */
    interface Bad { makerPay?: bigint; binPay?: bigint; v3Pay?: bigint; proceedsTo?: Uint8Array; cauldronSats?: bigint }
    const compose = (bad: Bad = {}) => () => {
        const makerPay = bad.makerPay ?? 19_900n + v3Out10;
        const legs: Leg[] = [
            { lock: intent.lockingBytecode, unlock: (intent as any).unlock.fill(), inS: 1_000n, inTok: tok(20n), outS: makerPay, outTo: MAKER.lock },
            binLeg(bin, 100_000n, undefined, 100_000n - (bad.binPay ?? 19_900n), tok(10n)),
            { lock: v3.lockingBytecode, unlock: (v3 as any).unlock.fill(), inS: 100_000n, outS: 100_000n - (bad.v3Pay ?? v3Out10) },
            { lock: cauldron, unlock: cauldronTrade(CPKH), inS: C_S, inTok: tok(C_T), outS: bad.cauldronSats ?? cOut, outTok: tok(C_T - 5n) },
        ];
        // Outputs 4–6 are free for the solver; output 7 is the V3 proceeds slot (input count 5).
        return balanced(legs, {
            party: SOLVER, locktime: T0,
            extraOuts: [
                { to: SOLVER.lock, sats: 1_000n }, { to: SOLVER.lock, sats: 1_000n }, { to: SOLVER.lock, sats: 1_000n },
                { to: bad.proceedsTo ?? LP_POOL.lock, sats: 1_000n, tok: tok(10n) },
            ],
        });
    };

    section('B7 · bin + intent + V3 pool + Cauldron in one transaction');
    expectAccept('all four covenants hold: maker 39,840 sats, bin +10 tokens, V3 proceeds to its LP, Cauldron K kept', compose());
    expectReject('the bin pays 1 sat over its bid', compose({ binPay: 19_901n, makerPay: 19_901n + v3Out10 }), { at: 1 });  // (a custom Cauldron unlocker: no CashScript attribution here)
    expectReject('the intent\'s maker paid below 35,000', compose({ makerPay: 34_999n }), { at: 0 });
    expectReject('the V3 pool over-drawn by 1 sat', compose({ v3Pay: v3Out10 + 1n, makerPay: 19_900n + v3Out10 + 1n }), { at: 2 });
    expectReject('the V3 proceeds diverted to the solver', compose({ proceedsTo: SOLVER.lock }), { at: 2 });
    expectReject('the Cauldron pool paid 1 sat short of its K', compose({ cauldronSats: cOut - 1n }), { at: 3 });

    section('B7 · a bin and a V3 pool of the same LP side by side (mixed-version sweep)');
    expectAccept('trader buys 10 tokens from a V4 bin and sells 10 into a V3 pool in one transaction', () => balanced([
        binLeg(bin, 1_000n, tok(100n), 21_000n, tok(90n)),
        { lock: v3.lockingBytecode, unlock: (v3 as any).unlock.fill(), inS: 100_000n, outS: 100_000n - v3Out10 },
    ], { extraOuts: [{ to: TAKER.lock, sats: 1_000n }, { to: TAKER.lock, sats: 1_000n }, { to: LP_POOL.lock, sats: 1_000n, tok: tok(10n) }] }));  // V3 proceeds at 1 + 3 inputs = output 4
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
    summary('MeshBinV4 B7 composition');
}
