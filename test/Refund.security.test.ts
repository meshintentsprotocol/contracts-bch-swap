/**
 * cancel() refund-path — ADVERSARIAL covenant tests for BOTH contracts.
 *
 * The refund path is part of the "can user funds be drained / stranded?"
 * surface: a broken cancel() could let funds be reclaimed early, redirected
 * away from the maker, or short-changed. cancel() uses CLTV (tx.time), so the
 * spending input must carry a non-final sequence number.
 *
 * Run:  npx tsx test/Refund.security.test.ts
 */
import { Contract, TransactionBuilder } from 'cashscript';
import {
    LIMIT_ARTIFACT, DUTCH_ARTIFACT, MAKER, RESOLVER, ATTACKER, CAT, catLE, BCH,
    p2pkh, provider, fakeTxid,
    expectAccept, expectReject, section, summary,
} from './_security_harness.js';

const SELL_AMOUNT = 1000n;              // CAT token units locked by the maker
const SEQ = 0xfffffffe;                 // non-final → enables OP_CHECKLOCKTIMEVERIFY

// LimitOrder expiry == DutchAuction endTime, for convenience.
const EXPIRY = 1700003600;
const START_TIME = 1700000000;
const DURATION = 3600;                  // START_TIME + DURATION === EXPIRY

const AFTER = EXPIRY + 100;             // refund broadcastable
const BEFORE = EXPIRY - 100;            // too early

interface RefundOpts {
    locktime?: number;
    out0To?: Uint8Array;
    out0TokenAmount?: bigint;
}

/** Token-sell covenant (maker locked CAT, refund must return CAT to maker). */
function limitCancel(o: RefundOpts = {}): TransactionBuilder {
    const contract = new Contract(
        LIMIT_ARTIFACT,
        [MAKER.pkh, catLE, BCH, SELL_AMOUNT, 5000n, BigInt(EXPIRY)],
        { provider: provider() },
    );
    return buildCancel(contract, contract.unlock.cancel(), o);
}

function dutchCancel(o: RefundOpts = {}): TransactionBuilder {
    const contract = new Contract(
        DUTCH_ARTIFACT,
        [MAKER.pkh, catLE, BCH, SELL_AMOUNT, 10000n, 5000n, BigInt(START_TIME), BigInt(DURATION)],
        { provider: provider() },
    );
    return buildCancel(contract, contract.unlock.cancel(), o);
}

function buildCancel(contract: Contract, unlocker: any, o: RefundOpts): TransactionBuilder {
    const covenantUtxo = { txid: fakeTxid(), vout: 0, satoshis: 1000n, token: { amount: SELL_AMOUNT, category: CAT } };
    const feeUtxo = { txid: fakeTxid(), vout: 0, satoshis: 20000n };

    const tb = new TransactionBuilder({ provider: contract.provider, allowImplicitFungibleTokenBurn: true });
    tb.addInput(covenantUtxo, unlocker, { sequence: SEQ });
    tb.addInput(feeUtxo, RESOLVER.template.unlockP2PKH(), { sequence: SEQ });

    // output0 → maker gets the locked tokens back (covenant-enforced)
    tb.addOutput({
        to: o.out0To ?? p2pkh(MAKER.pkh),
        amount: 1000n,
        token: { amount: o.out0TokenAmount ?? SELL_AMOUNT, category: CAT },
    });
    // output1 → fee change back to whoever paid the fee
    tb.addOutput({ to: p2pkh(RESOLVER.pkh), amount: 1000n + 20000n - 1000n - 1500n });

    tb.setLocktime(o.locktime ?? AFTER);
    return tb;
}

function main() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║  cancel() Refund Path — Adversarial Covenant Tests     ║');
    console.log('╚════════════════════════════════════════════════════════╝');

    section('LimitOrderSwap.cancel()');
    expectAccept('refund to maker after expiry', () => limitCancel());
    expectReject('refund BEFORE expiry (tx.time < expiryTime)', () => limitCancel({ locktime: BEFORE }), /tx\.time|expiryTime|Locktime|require/i);
    expectReject('refund REDIRECTED to attacker', () => limitCancel({ out0To: p2pkh(ATTACKER.pkh) }), /lockingBytecode|outputs\[0\]|require/i);
    expectReject('refund SHORT-CHANGES maker tokens', () => limitCancel({ out0TokenAmount: 999n }), /tokenAmount|outputs\[0\]|require/i);

    section('DutchAuctionSwap.cancel()');
    expectAccept('refund to maker after auction end', () => dutchCancel());
    expectReject('refund BEFORE auction end', () => dutchCancel({ locktime: BEFORE }), /tx\.time|endTime|Locktime|require/i);
    expectReject('refund REDIRECTED to attacker', () => dutchCancel({ out0To: p2pkh(ATTACKER.pkh) }), /lockingBytecode|outputs\[0\]|require/i);
    expectReject('refund SHORT-CHANGES maker tokens', () => dutchCancel({ out0TokenAmount: 999n }), /tokenAmount|outputs\[0\]|require/i);

    summary('Refund.security');
}

main();
