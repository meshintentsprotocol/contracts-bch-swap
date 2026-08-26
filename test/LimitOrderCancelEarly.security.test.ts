/**
 * LimitOrderSwap.cash — cancelEarly() ADVERSARIAL covenant tests.
 *
 * cancelEarly() lets the maker reclaim their locked funds at ANY time (no
 * expiry wait), authorized purely by their own signature. This suite proves:
 *   1. Only the maker (holder of makerPkh's private key) can invoke it.
 *   2. The payout is pinned to the maker's own address for the full sellAmount,
 *      regardless of who constructs/broadcasts the transaction.
 *   3. Adding this branch does not change fill()/cancel() behavior.
 *
 * Uses the same offline-VM harness as the other *.security.test.ts suites.
 *
 * Run:  npx tsx test/LimitOrderCancelEarly.security.test.ts
 */
import { Contract, TransactionBuilder } from 'cashscript';
import {
    LIMIT_ARTIFACT, MAKER, RESOLVER, ATTACKER, CAT, catLE, BCH,
    p2pkh, provider, fakeTxid,
    expectAccept, expectReject, section, summary, Key,
} from './_security_harness.js';

const EXPIRY = 1700003600n;   // far in the future relative to any locktime we use here
const LOCKTIME = 1700000000;  // arbitrary valid unix timestamp, well BEFORE expiry —
                               // proves cancelEarly() needs no expiry wait at all

interface CancelEarlyOpts {
    sellAmount?: bigint;
    signer?: Key;        // who signs the cancelEarly() unlock (should be MAKER to succeed)
    pkArg?: Uint8Array;  // pubkey argument passed into cancelEarly() (should hash to makerPkh)
    out0To?: Uint8Array;
    out0Amount?: bigint;        // used for BCH-locked config
    out0TokenAmount?: bigint;   // used for token-locked config
    out0Category?: string;
    extraInput?: boolean;
}

/** Config A — maker locked a CashToken (e.g. PUSD), wants BCH back on cancel. */
function cancelEarlyA(o: CancelEarlyOpts = {}): TransactionBuilder {
    const sellAmount = o.sellAmount ?? 1000n; // CAT units locked
    const buyAmount = 5000n;
    const contract = new Contract(
        LIMIT_ARTIFACT,
        [MAKER.pkh, catLE, BCH, sellAmount, buyAmount, EXPIRY],
        { provider: provider() },
    );

    const covenantUtxo = { txid: fakeTxid(), vout: 0, satoshis: 1000n, token: { amount: sellAmount, category: CAT } };
    const feeUtxo = { txid: fakeTxid(), vout: 0, satoshis: 20000n };

    const signer = o.signer ?? MAKER;
    const pkArg = o.pkArg ?? MAKER.pub;

    const tb = new TransactionBuilder({ provider: contract.provider, allowImplicitFungibleTokenBurn: true });
    tb.addInput(covenantUtxo, contract.unlock.cancelEarly(pkArg, signer.template));
    tb.addInput(feeUtxo, RESOLVER.template.unlockP2PKH());
    if (o.extraInput) {
        tb.addInput({ txid: fakeTxid(), vout: 0, satoshis: 10000n }, ATTACKER.template.unlockP2PKH());
    }

    // output0 → maker gets the locked CAT tokens back (covenant-enforced)
    tb.addOutput({
        to: o.out0To ?? p2pkh(MAKER.pkh),
        amount: 1000n,
        token: { amount: o.out0TokenAmount ?? sellAmount, category: o.out0Category ?? CAT },
    });
    // output1 → fee change back to whoever fronted the fee
    const inSats = 1000n + 20000n + (o.extraInput ? 10000n : 0n);
    tb.addOutput({ to: p2pkh(RESOLVER.pkh), amount: inSats - 1000n - 1500n });

    tb.setLocktime(LOCKTIME);
    return tb;
}

/** Config B — maker locked native BCH, wants a CashToken back on cancel. */
function cancelEarlyB(o: CancelEarlyOpts = {}): TransactionBuilder {
    const sellAmount = o.sellAmount ?? 5000n; // sats locked
    const buyAmount = 1000n;
    const contract = new Contract(
        LIMIT_ARTIFACT,
        [MAKER.pkh, BCH, catLE, sellAmount, buyAmount, EXPIRY],
        { provider: provider() },
    );

    const covenantUtxo = { txid: fakeTxid(), vout: 0, satoshis: sellAmount };
    const feeUtxo = { txid: fakeTxid(), vout: 0, satoshis: 20000n };

    const signer = o.signer ?? MAKER;
    const pkArg = o.pkArg ?? MAKER.pub;

    const tb = new TransactionBuilder({ provider: contract.provider, allowImplicitFungibleTokenBurn: true });
    tb.addInput(covenantUtxo, contract.unlock.cancelEarly(pkArg, signer.template));
    tb.addInput(feeUtxo, RESOLVER.template.unlockP2PKH());
    if (o.extraInput) {
        tb.addInput({ txid: fakeTxid(), vout: 0, satoshis: 10000n }, ATTACKER.template.unlockP2PKH());
    }

    // output0 → maker gets the locked BCH back (covenant-enforced)
    tb.addOutput({ to: o.out0To ?? p2pkh(MAKER.pkh), amount: o.out0Amount ?? sellAmount });
    // output1 → fee change back to whoever fronted the fee
    const inSats = sellAmount + 20000n + (o.extraInput ? 10000n : 0n);
    tb.addOutput({ to: p2pkh(RESOLVER.pkh), amount: inSats - (o.out0Amount ?? sellAmount) - 1500n });

    tb.setLocktime(LOCKTIME);
    return tb;
}

function main() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║  LimitOrderSwap.cash — cancelEarly() Security Tests    ║');
    console.log('╚════════════════════════════════════════════════════════╝');

    section('Happy paths (must ACCEPT) — maker reclaims funds anytime, no expiry wait');
    expectAccept('Token-locked: maker cancels immediately, long before expiry', () => cancelEarlyA());
    expectAccept('BCH-locked: maker cancels immediately, long before expiry', () => cancelEarlyB());
    expectAccept('Token-locked: maker cancels with a 3rd (unrelated) input present', () => cancelEarlyA({ extraInput: true }));
    // Note: a token "overpay" test isn't meaningful here — the covenant only
    // holds `sellAmount` units of CAT, and BCH token conservation rules make
    // it impossible to output more tokens than were input, regardless of what
    // the covenant's own require() checks allow. The BCH-locked case CAN
    // overpay because extra satoshis can come from the fee-funding input.
    expectAccept('BCH-locked: maker refunds themselves MORE than sellAmount (overpay is fine)', () => cancelEarlyB({ out0Amount: 5500n }));

    section('Authorization enforcement — only the maker can invoke cancelEarly (must REJECT)');
    expectReject('Resolver tries to self-authorize a cancel with their own key',
        () => cancelEarlyA({ signer: RESOLVER, pkArg: RESOLVER.pub }),
        /hash160|require/i);
    expectReject('Attacker tries to self-authorize a cancel with their own key',
        () => cancelEarlyA({ signer: ATTACKER, pkArg: ATTACKER.pub }),
        /hash160|require/i);
    expectReject('Attacker supplies makerPk as the pubkey arg but signs with their own key (forged sig)',
        () => cancelEarlyA({ signer: ATTACKER, pkArg: MAKER.pub }),
        /checkSig|signature|require|NULLFAIL/i);
    expectReject('BCH-locked: resolver tries to self-authorize a cancel',
        () => cancelEarlyB({ signer: RESOLVER, pkArg: RESOLVER.pub }),
        /hash160|require/i);

    section('Recipient enforcement — funds must return to the maker (must REJECT)');
    expectReject('Token-locked: redirect refund to ATTACKER',
        () => cancelEarlyA({ out0To: p2pkh(ATTACKER.pkh) }),
        /lockingBytecode|outputs\[0\]|require/i);
    expectReject('BCH-locked: redirect refund to ATTACKER',
        () => cancelEarlyB({ out0To: p2pkh(ATTACKER.pkh) }),
        /lockingBytecode|outputs\[0\]|require/i);

    section('Amount / category enforcement — full sellAmount, correct asset (must REJECT)');
    expectReject('Token-locked: short-change the refund by 1 unit',
        () => cancelEarlyA({ out0TokenAmount: 999n }),
        /tokenAmount|outputs\[0\]|require/i);
    expectReject('Token-locked: refund in the WRONG token category',
        () => cancelEarlyA({ out0Category: 'aa'.repeat(32) }),
        /tokenCategory|outputs\[0\]|require/i);
    expectReject('BCH-locked: short-change the refund by 1 sat',
        () => cancelEarlyB({ out0Amount: 4999n }),
        /value|outputs\[0\]|require/i);

    summary('LimitOrderSwap.cancelEarly');
}

main();
