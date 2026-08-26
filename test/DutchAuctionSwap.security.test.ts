/**
 * DutchAuctionSwap.cash — ADVERSARIAL covenant tests.
 *
 * Proves the maker-protection properties of the decaying-price covenant against
 * a malicious resolver, evaluating the real BCH VM offline (_security_harness.ts).
 *
 * Also documents the economic reality of the price FLOOR: because the resolver
 * controls tx.locktime, it can always wait for full decay and fill at
 * endBuyAmount. The covenant correctly enforces endBuyAmount as the hard floor —
 * so endBuyAmount, not startBuyAmount, is what a maker is really guaranteed.
 *
 * Run:  npx tsx test/DutchAuctionSwap.security.test.ts
 */
import { Contract, TransactionBuilder } from 'cashscript';
import {
    DUTCH_ARTIFACT, MAKER, RESOLVER, ATTACKER, CAT, catLE, BCH,
    p2pkh, provider, fakeTxid,
    expectAccept, expectReject, section, summary, Key,
} from './_security_harness.js';

// Auction: price decays 10000 → 5000 sats over 3600s.  (Maker sells CAT, wants BCH.)
const SELL_AMOUNT = 1000n;       // token units locked
const START_BUY = 10000n;        // sats (max price, t=0)
const END_BUY = 5000n;           // sats (floor, t>=duration)
const START_TIME = 1700000000;
const DURATION = 3600;

const T_HALF = START_TIME + 1800; // price = 7500
const PRICE_HALF = 7500n;
const T_ENDED = START_TIME + 7200; // past duration → price = END_BUY (floor)

interface FillOpts {
    locktime?: number;
    out0Amount?: bigint;
    out0To?: Uint8Array;
    out1To?: Uint8Array; out1TokenAmount?: bigint;
    extraInput?: boolean;
    covPub?: Uint8Array; covSigner?: Key;
}

function fill(o: FillOpts = {}): TransactionBuilder {
    const covPub = o.covPub ?? RESOLVER.pub;
    const covSigner = o.covSigner ?? RESOLVER;

    const contract = new Contract(
        DUTCH_ARTIFACT,
        [MAKER.pkh, catLE, BCH, SELL_AMOUNT, START_BUY, END_BUY, BigInt(START_TIME), BigInt(DURATION)],
        { provider: provider() },
    );

    const covenantUtxo = { txid: fakeTxid(), vout: 0, satoshis: 1000n, token: { amount: SELL_AMOUNT, category: CAT } };
    const fundingUtxo = { txid: fakeTxid(), vout: 0, satoshis: 40000n };

    const tb = new TransactionBuilder({ provider: contract.provider, allowImplicitFungibleTokenBurn: true });
    tb.addInput(covenantUtxo, contract.unlock.fill(covPub, covSigner.template));
    tb.addInput(fundingUtxo, RESOLVER.template.unlockP2PKH());
    if (o.extraInput) {
        tb.addInput({ txid: fakeTxid(), vout: 0, satoshis: 10000n }, ATTACKER.template.unlockP2PKH());
    }

    const out0Amount = o.out0Amount ?? PRICE_HALF;
    tb.addOutput({ to: o.out0To ?? p2pkh(MAKER.pkh), amount: out0Amount });
    tb.addOutput({ to: o.out1To ?? p2pkh(RESOLVER.pkh), amount: 1000n, token: { amount: o.out1TokenAmount ?? SELL_AMOUNT, category: CAT } });
    const inSats = 1000n + 40000n + (o.extraInput ? 10000n : 0n);
    tb.addOutput({ to: p2pkh(RESOLVER.pkh), amount: inSats - out0Amount - 1000n - 1500n });

    tb.setLocktime(o.locktime ?? T_HALF);
    return tb;
}

function main() {
    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║ DutchAuctionSwap.cash — Adversarial Covenant Test Suite║');
    console.log('╚════════════════════════════════════════════════════════╝');

    section('Decaying-price happy paths (must ACCEPT)');
    expectAccept('fill at exact current price (t=half → 7500)', () => fill({ locktime: T_HALF, out0Amount: PRICE_HALF }));
    expectAccept('resolver OVERPAYS at half-time', () => fill({ locktime: T_HALF, out0Amount: 9000n }));
    expectAccept('fill at start price (t=0 → 10000)', () => fill({ locktime: START_TIME, out0Amount: START_BUY }));
    expectAccept('fill at FLOOR after full decay (t>dur → 5000)', () => fill({ locktime: T_ENDED, out0Amount: END_BUY }));

    section('Price enforcement — cannot pay below the decayed price (must REJECT)');
    expectReject('underpay vs current price (7499 < 7500 @ half)', () => fill({ locktime: T_HALF, out0Amount: 7499n }), /value|outputs\[0\]|require/i);
    expectReject('pay the floor while price is still high (5000 @ half)', () => fill({ locktime: T_HALF, out0Amount: END_BUY }), /value|outputs\[0\]|require/i);
    expectReject('underpay below the floor after full decay (4999)', () => fill({ locktime: T_ENDED, out0Amount: 4999n }), /value|outputs\[0\]|require/i);
    expectReject('pay maker nothing', () => fill({ locktime: T_HALF, out0Amount: 0n }));

    section('Recipient enforcement (must REJECT)');
    expectReject('redirect maker payout to ATTACKER', () => fill({ out0To: p2pkh(ATTACKER.pkh) }), /lockingBytecode|outputs\[0\]|require/i);

    section('Time enforcement (must REJECT)');
    expectReject('fill BEFORE auction start', () => fill({ locktime: START_TIME - 10 }), /startTime|currentTime|require/i);
    expectReject('block-height locktime (< 500M)', () => fill({ locktime: 499_999_999 }), /500000000|currentTime|require/i);

    section('Input constraint — no 3rd-party UTXO drain (must REJECT)');
    expectReject('smuggle a 3rd input', () => fill({ extraInput: true }), /inputs\.length|require/i);

    section('Signature enforcement (must REJECT)');
    expectReject('covenant sig from a non-resolver key', () => fill({ covSigner: ATTACKER }), /checkSig|signature|require|NULLFAIL/i);

    summary('DutchAuctionSwap.security');
}

main();
