/**
 * LimitOrderSwap.cash — ADVERSARIAL covenant tests.
 *
 * Proves the maker-protection properties hold against a malicious resolver,
 * by evaluating the real BCH VM offline (see _security_harness.ts).
 *
 * Run:  npx tsx test/LimitOrderSwap.security.test.ts
 */
import { Contract, TransactionBuilder } from 'cashscript';
import {
    LIMIT_ARTIFACT, MAKER, RESOLVER, ATTACKER, CAT, catLE, BCH,
    p2pkh, provider, fakeTxid,
    expectAccept, expectReject, section, summary, Key,
} from './_security_harness.js';

const EXPIRY = 1700003600n;
const LOCKTIME_OK = 1700000000; // < expiry, >= 500_000_000

// ─────────────────────────────────────────────────────────────────────────────
// Config A — maker SELLS a token, WANTS BCH   (e.g. PUSD → BCH)
//   covenant holds CAT;  output0 pays maker BCH;  output1 returns CAT to resolver
// ─────────────────────────────────────────────────────────────────────────────
interface FillAOpts {
    sellAmount?: bigint; buyAmount?: bigint; expiry?: bigint;
    locktime?: number;
    extraInput?: boolean;
    out0To?: Uint8Array; out0Amount?: bigint;
    out1To?: Uint8Array; out1TokenAmount?: bigint;
    covPub?: Uint8Array; covSigner?: Key;
}

function fillA(o: FillAOpts = {}): TransactionBuilder {
    const sellAmount = o.sellAmount ?? 1000n;   // token units locked
    const buyAmount = o.buyAmount ?? 5000n;     // sats owed to maker
    const expiry = o.expiry ?? EXPIRY;
    const covPub = o.covPub ?? RESOLVER.pub;
    const covSigner = o.covSigner ?? RESOLVER;

    const contract = new Contract(
        LIMIT_ARTIFACT,
        [MAKER.pkh, catLE, BCH, sellAmount, buyAmount, expiry],
        { provider: provider() },
    );

    const covenantUtxo = { txid: fakeTxid(), vout: 0, satoshis: 1000n, token: { amount: sellAmount, category: CAT } };
    const fundingUtxo = { txid: fakeTxid(), vout: 0, satoshis: 20000n };

    const tb = new TransactionBuilder({ provider: contract.provider, allowImplicitFungibleTokenBurn: true });
    tb.addInput(covenantUtxo, contract.unlock.fill(covPub, covSigner.template));
    tb.addInput(fundingUtxo, RESOLVER.template.unlockP2PKH());
    if (o.extraInput) {
        tb.addInput({ txid: fakeTxid(), vout: 0, satoshis: 10000n }, ATTACKER.template.unlockP2PKH());
    }

    // output0 → maker (BCH)
    tb.addOutput({ to: o.out0To ?? p2pkh(MAKER.pkh), amount: o.out0Amount ?? buyAmount });
    // output1 → resolver (CAT)
    tb.addOutput({ to: o.out1To ?? p2pkh(RESOLVER.pkh), amount: 1000n, token: { amount: o.out1TokenAmount ?? sellAmount, category: CAT } });
    // output2 → change to resolver (keeps fee sane)
    const inSats = 1000n + 20000n + (o.extraInput ? 10000n : 0n);
    tb.addOutput({ to: p2pkh(RESOLVER.pkh), amount: inSats - (o.out0Amount ?? buyAmount) - 1000n - 1500n });

    tb.setLocktime(o.locktime ?? LOCKTIME_OK);
    return tb;
}

// ─────────────────────────────────────────────────────────────────────────────
// Config B — maker SELLS BCH, WANTS a token   (e.g. BCH → PUSD)
//   covenant holds BCH;  output0 pays maker the token;  output1 returns BCH
// ─────────────────────────────────────────────────────────────────────────────
interface FillBOpts {
    sellAmount?: bigint; buyAmount?: bigint;
    locktime?: number;
    out0To?: Uint8Array; out0TokenAmount?: bigint; out0Category?: string;
    out1Amount?: bigint;
}

function fillB(o: FillBOpts = {}): TransactionBuilder {
    const sellAmount = o.sellAmount ?? 5000n;   // sats locked
    const buyAmount = o.buyAmount ?? 1000n;     // token units owed to maker

    const contract = new Contract(
        LIMIT_ARTIFACT,
        [MAKER.pkh, BCH, catLE, sellAmount, buyAmount, EXPIRY],
        { provider: provider() },
    );

    // Resolver funds exactly what it pays out (token conservation); the
    // category is always CAT, so a wrong-category payout is caught by the
    // covenant VM check before any conservation issue is reached.
    const fundedTokens = o.out0TokenAmount ?? buyAmount;
    const covenantUtxo = { txid: fakeTxid(), vout: 0, satoshis: sellAmount };
    const fundingUtxo = { txid: fakeTxid(), vout: 0, satoshis: 20000n, token: { amount: fundedTokens, category: CAT } };

    const tb = new TransactionBuilder({ provider: contract.provider, allowImplicitFungibleTokenBurn: true });
    tb.addInput(covenantUtxo, contract.unlock.fill(RESOLVER.pub, RESOLVER.template));
    tb.addInput(fundingUtxo, RESOLVER.template.unlockP2PKH());

    // output0 → maker (token + dust)
    tb.addOutput({
        to: o.out0To ?? p2pkh(MAKER.pkh),
        amount: 1000n,
        token: { amount: o.out0TokenAmount ?? buyAmount, category: o.out0Category ?? CAT },
    });
    // output1 → resolver (BCH)
    tb.addOutput({ to: p2pkh(RESOLVER.pkh), amount: o.out1Amount ?? sellAmount });
    // output2 → change to resolver
    tb.addOutput({ to: p2pkh(RESOLVER.pkh), amount: sellAmount + 20000n - 1000n - (o.out1Amount ?? sellAmount) - 1500n });

    tb.setLocktime(o.locktime ?? LOCKTIME_OK);
    return tb;
}

// ─────────────────────────────────────────────────────────────────────────────
function main() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║  LimitOrderSwap.cash — Adversarial Covenant Test Suite ║');
    console.log('╚════════════════════════════════════════════════════════╝');

    section('Happy paths (must ACCEPT)');
    expectAccept('TOKEN→BCH: correct fill', () => fillA());
    expectAccept('TOKEN→BCH: resolver OVERPAYS maker', () => fillA({ out0Amount: 6000n }));
    expectAccept('BCH→TOKEN: correct fill', () => fillB());
    expectAccept('BCH→TOKEN: resolver OVERPAYS maker', () => fillB({ out0TokenAmount: 1200n }));

    section('Price enforcement — resolver cannot shortchange the maker (must REJECT)');
    expectReject('TOKEN→BCH: underpay maker by 1 sat', () => fillA({ out0Amount: 4999n }), /value|outputs\[0\]|require/i);
    expectReject('TOKEN→BCH: pay maker nothing (zero)', () => fillA({ out0Amount: 0n }));
    expectReject('BCH→TOKEN: underpay maker tokens', () => fillB({ out0TokenAmount: 999n }), /tokenAmount|outputs\[0\]|require/i);
    expectReject('BCH→TOKEN: pay maker a WORTHLESS/wrong token category', () =>
        fillB({ out0Category: 'aa'.repeat(32) }), /tokenCategory|outputs\[0\]|require/i);

    section('Recipient enforcement — funds must go to the maker (must REJECT)');
    expectReject('TOKEN→BCH: redirect maker payout to ATTACKER', () => fillA({ out0To: p2pkh(ATTACKER.pkh) }), /lockingBytecode|outputs\[0\]|require/i);
    expectReject('BCH→TOKEN: redirect maker payout to ATTACKER', () => fillB({ out0To: p2pkh(ATTACKER.pkh) }), /lockingBytecode|outputs\[0\]|require/i);

    section('Input constraint — no 3rd-party UTXO drain (must REJECT)');
    expectReject('TOKEN→BCH: smuggle a 3rd input', () => fillA({ extraInput: true }), /inputs\.length|require/i);

    section('Time / expiry enforcement (must REJECT)');
    expectReject('fill AFTER expiry', () => fillA({ locktime: Number(EXPIRY) + 10 }), /expiryTime|currentTime|require/i);
    expectReject('fill with block-height locktime (< 500M)', () => fillA({ locktime: 499_999_999 }), /500000000|currentTime|require/i);

    section('Signature enforcement (must REJECT)');
    expectReject('covenant sig from a key that is not resolverPk', () =>
        fillA({ covSigner: ATTACKER }), /checkSig|signature|require|NULLFAIL/i);
    expectReject('resolverPk mismatched with output[1] recipient', () =>
        // sign correctly for ATTACKER, but tokens still routed to RESOLVER → outputs[1] check fails
        fillA({ covPub: ATTACKER.pub, covSigner: ATTACKER, out1To: p2pkh(RESOLVER.pkh) }), /outputs\[1\]|lockingBytecode|require/i);

    summary('LimitOrderSwap.security');
}

main();
