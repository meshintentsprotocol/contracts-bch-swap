/**
 * MeshStrategyWithSurplusCapture Security & Adversarial Test Suite
 *
 * Verifies on-chain cryptographic enforcement of:
 *   1. Mode A: 100% of partner surplus passed to User (positive slippage bonus).
 *   2. Mode B: 100% of partner surplus retained by Frontend / SDK (Output 3).
 *   3. Mode C: Configurable Split between User and Frontend.
 *   4. Rejection when an adversarial solver/SDK omits the Treasury Output (Output 2).
 *   5. Rejection when an adversarial solver/SDK omits the Frontend Output (Output 3) in Mode B/C.
 *   6. Rejection when a solver redirects Treasury cut or Frontend cut to an attacker PKH.
 *   7. Rejection when a solver attempts to underpay the user below their guaranteed entitlement.
 *   8. Rejection when a solver tries to fill below the user's quoted minimum.
 *   9. Clean execution on zero-surplus trades (no fee penalty).
 *  10. Unconditional 0% LP dock exit.
 */

import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { secp256k1, hash160, binToHex } from '@bitauth/libauth';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Artifact ─────────────────────────────────────────────────────────────────
export const SURPLUS_STRATEGY_ARTIFACT = JSON.parse(
    readFileSync(join(__dirname, '..', 'artifacts', 'MeshStrategyWithSurplusCapture.json'), 'utf-8'),
);

// ── Keypairs ─────────────────────────────────────────────────────────────────
export interface Key {
    priv: Uint8Array;
    pub: Uint8Array;
    pkh: Uint8Array;
    template: SignatureTemplate;
}

function makeKey(seedByte: number): Key {
    const priv = new Uint8Array(32).fill(seedByte || 1);
    priv[31] = seedByte;
    const pub = secp256k1.derivePublicKeyCompressed(priv);
    if (typeof pub === 'string') throw new Error(`bad key seed ${seedByte}: ${pub}`);
    return { priv, pub, pkh: hash160(pub), template: new SignatureTemplate(priv) };
}

const LP_OWNER = makeKey(0x11);
const TREASURY = makeKey(0x99);
const FRONTEND = makeKey(0x77);
const USER_MAKER = makeKey(0x22);
const ATTACKER = makeKey(0x44);

// ── Helpers ──────────────────────────────────────────────────────────────────
function p2pkh(pkh: Uint8Array): Uint8Array {
    return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

let nonce = 0;
function fakeTxid(): string {
    nonce += 1;
    return binToHex(hash160(Uint8Array.from([nonce, nonce, nonce]))).padEnd(64, '0').slice(0, 64);
}

let passed = 0;
let failed = 0;

function expectAccept(name: string, build: () => TransactionBuilder) {
    try {
        build().debug();
        passed++;
        console.log(`  ✅ ACCEPT  ${name}`);
    } catch (e: any) {
        failed++;
        console.error(`  ❌ ACCEPT  ${name}\n        expected success but covenant REJECTED: ${e?.message ?? e}`);
    }
}

function expectReject(name: string, build: () => TransactionBuilder) {
    let threw: any;
    try {
        build().debug();
    } catch (e: any) {
        threw = e;
    }
    if (!threw) {
        failed++;
        console.error(`  ❌ REJECT  ${name}\n        DANGER: covenant ACCEPTED a transaction it should have rejected!`);
        return;
    }
    passed++;
    console.log(`  ✅ REJECT  ${name}`);
}

// ── Main Test Runner ─────────────────────────────────────────────────────────
async function runSecurityTests() {
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║ MeshStrategyWithSurplusCapture — Full Security & Anti-Bypass    ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');

    // Strategy: Sells BCH, Takes BCH
    // Multiplier: 3.0x (priceNum = 300, priceDen = 100)
    // lpFeeBps = 0
    const priceNum = 300n;
    const priceDen = 100n;
    const lpFeeBps = 0n;

    const contract = new Contract(
        SURPLUS_STRATEGY_ARTIFACT,
        [LP_OWNER.pkh, TREASURY.pkh, '0x', '0x', priceNum, priceDen, lpFeeBps],
        { provider: new MockNetworkProvider() }
    );

    const initialReserve = 100000n; // 100,000 sats
    const amountIn = 10000n;        // 10,000 sats in -> grossAmountOut = 30,000 sats

    function createTx(opts: {
        quotedMinOut?: bigint;
        userSurplusShare?: bigint;
        frontendPkh?: Uint8Array;
        out0Amount?: bigint;
        out0To?: Uint8Array;
        out1Amount?: bigint;
        out1To?: Uint8Array;
        out2Amount?: bigint;
        out2To?: Uint8Array;
        omitOutput2?: boolean;
        out3Amount?: bigint;
        out3To?: Uint8Array;
        omitOutput3?: boolean;
    } = {}): TransactionBuilder {
        const quotedMinOut = opts.quotedMinOut ?? 28000n;
        const totalSurplus = 30000n - quotedMinOut;
        const protocolShare = totalSurplus / 2n;
        const nonProtocolSurplus = totalSurplus - protocolShare;

        // default: 100% of nonProtocolSurplus to user
        const userSurplusShare = opts.userSurplusShare ?? nonProtocolSurplus;
        const frontendPkh = opts.frontendPkh ?? FRONTEND.pkh;

        const strategyUtxo = { txid: fakeTxid(), vout: 0, satoshis: initialReserve };
        const userFundingUtxo = { txid: fakeTxid(), vout: 0, satoshis: amountIn + 5000n };

        const tb = new TransactionBuilder({ provider: contract.provider });
        
        tb.addInput(userFundingUtxo, USER_MAKER.template.unlockP2PKH());
        tb.addInput(
            strategyUtxo,
            contract.unlock.fillWithSurplusCapture(
                amountIn,
                USER_MAKER.pkh,
                frontendPkh,
                quotedMinOut,
                userSurplusShare
            )
        );

        // Output 0: Recreated Strategy Reserve (Remaining = 70,000)
        tb.addOutput({
            to: opts.out0To ?? contract.address,
            amount: opts.out0Amount ?? 70000n,
        });

        // Output 1: User Payout
        const expectedUserPayout = quotedMinOut + userSurplusShare;
        tb.addOutput({
            to: opts.out1To ?? p2pkh(USER_MAKER.pkh),
            amount: opts.out1Amount ?? expectedUserPayout,
        });

        // Output 2: Protocol Treasury
        if (!opts.omitOutput2 && protocolShare > 0) {
            tb.addOutput({
                to: opts.out2To ?? p2pkh(TREASURY.pkh),
                amount: opts.out2Amount ?? protocolShare,
            });
        }

        // Output 3: Frontend Share (if frontendShare > 0)
        const frontendShare = nonProtocolSurplus - userSurplusShare;
        if (frontendShare > 0 && !opts.omitOutput3) {
            tb.addOutput({
                to: opts.out3To ?? p2pkh(frontendPkh),
                amount: opts.out3Amount ?? frontendShare,
            });
        }

        return tb;
    }

    console.log('\n── 1. Honest Multi-Mode Surplus Execution ──');

    // Mode A: 100% partner surplus to User (User gets 28k + 1k = 29k, Treasury gets 1k, Frontend gets 0)
    expectAccept('Mode A: 100% of partner surplus to User (Full positive slippage)', () => {
        return createTx({ userSurplusShare: 1000n });
    });

    // Mode B: 100% partner surplus to Frontend (User gets 28k, Treasury gets 1k, Frontend gets 1k)
    expectAccept('Mode B: 100% of partner surplus to Frontend (Monetized)', () => {
        return createTx({ userSurplusShare: 0n });
    });

    // Mode C: 50/50 Split (User gets 28k + 1000 = 29k, Treasury gets 2k, Frontend gets 1000)
    // Using 4000 total surplus (quotedMinOut = 26,000) so that 50% split (1,000 sats) is safely above 546 sat dust limit
    expectAccept('Mode C: 50/50 Split between User (+1000) and Frontend (+1000)', () => {
        return createTx({
            quotedMinOut: 26000n,       // Total surplus = 4000 -> Treasury = 2000, Non-Protocol = 2000
            userSurplusShare: 1000n,    // User gets 1000, Frontend gets 1000
            out1Amount: 27000n,         // User payout = 26000 + 1000 = 27000
            out2Amount: 2000n,          // Treasury payout = 2000
            out3Amount: 1000n,          // Frontend payout = 1000 (well above 546 sat dust limit)
        });
    });

    console.log('\n── 2. Adversarial Solver Bypass Attacks ──');

    // Attack 1: Solver tries to omit Treasury Output 2
    expectReject('Adversarial Solver omits Output 2 (Treasury Fee Bypass)', () => {
        return createTx({ omitOutput2: true });
    });

    // Attack 2: Solver redirects Treasury to Attacker PKH
    expectReject('Adversarial Solver redirects Treasury Output to Attacker PKH', () => {
        return createTx({ out2To: p2pkh(ATTACKER.pkh) });
    });

    // Attack 3: In Mode B, Solver tries to omit Output 3 (stealing Frontend revenue)
    expectReject('Adversarial Solver omits Output 3 (Frontend Fee Bypass in Mode B)', () => {
        return createTx({ userSurplusShare: 0n, omitOutput3: true });
    });

    // Attack 4: In Mode B, Solver redirects Frontend Output 3 to Attacker PKH
    expectReject('Adversarial Solver redirects Frontend Output to Attacker PKH', () => {
        return createTx({ userSurplusShare: 0n, out3To: p2pkh(ATTACKER.pkh) });
    });

    // Attack 5: Solver tries to underpay User (paying only 28k when userSurplusShare is 1k)
    expectReject('Adversarial Solver short-changes User on positive slippage', () => {
        return createTx({ userSurplusShare: 1000n, out1Amount: 28000n });
    });

    // Attack 6: Solver underpays Treasury (pays 500 instead of 1,000)
    expectReject('Adversarial Solver underpays Protocol Treasury', () => {
        return createTx({ out2Amount: 500n });
    });

    // Attack 7: Solver attempts to fill when gross < quoted minimum
    expectReject('Solver attempts to fill when gross yield < user quoted minimum', () => {
        return createTx({ quotedMinOut: 35000n });
    });

    console.log('\n── 3. Zero-Surplus & Docking Execution ──');

    // Case 8: Zero Surplus Fill (Gross == Quoted Min)
    expectAccept('Zero Surplus Fill (Gross == Quoted Min) executes cleanly with 0 protocol cut', () => {
        const strategyUtxo = { txid: fakeTxid(), vout: 0, satoshis: initialReserve };
        const userFundingUtxo = { txid: fakeTxid(), vout: 0, satoshis: amountIn + 5000n };

        const tb = new TransactionBuilder({ provider: contract.provider });
        tb.addInput(userFundingUtxo, USER_MAKER.template.unlockP2PKH());
        tb.addInput(
            strategyUtxo,
            contract.unlock.fillWithSurplusCapture(
                amountIn,
                USER_MAKER.pkh,
                FRONTEND.pkh,
                30000n, // quotedMinOut == grossAmountOut
                0n      // userSurplusShare
            )
        );

        tb.addOutput({ to: contract.address, amount: 70000n });
        tb.addOutput({ to: p2pkh(USER_MAKER.pkh), amount: 30000n });
        return tb;
    });

    // Case 9: Unconditional LP Dock Exit
    expectAccept('LP Owner docks funds with 0% exit fee', () => {
        const strategyUtxo = { txid: fakeTxid(), vout: 0, satoshis: initialReserve };
        const tb = new TransactionBuilder({ provider: contract.provider });
        tb.addInput(strategyUtxo, contract.unlock.dock(LP_OWNER.pub, LP_OWNER.template));
        tb.addOutput({ to: p2pkh(LP_OWNER.pkh), amount: initialReserve - 1000n });
        return tb;
    });

    console.log(`\n═══ Security Suite Results: ${passed} passed, ${failed} failed ═══`);
    process.exit(failed > 0 ? 1 : 0);
}

runSecurityTests().catch(console.error);
