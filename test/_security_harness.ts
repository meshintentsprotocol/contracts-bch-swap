/**
 * Shared harness for the adversarial covenant test suites.
 *
 * These tests run the REAL Bitcoin Cash VM offline via CashScript's
 * `MockNetworkProvider` + `TransactionBuilder.debug()`. `debug()` evaluates
 * every input's locking/unlocking script through libauth and THROWS
 * (`FailedRequireError` / `FailedTransactionEvaluationError`) when a covenant
 * `require()` fails. That gives us a deterministic, network-free way to assert
 * the security properties of LimitOrderSwap.cash / DutchAuctionSwap.cash —
 * specifically that a malicious resolver CANNOT shortchange or rob the maker.
 *
 * Endianness convention (matches the production relayer):
 *   - token category in an Output / Utxo  -> big-endian display hex (no 0x)
 *   - token category in a contract param   -> little-endian, 0x-prefixed
 */
import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { secp256k1, hash160, binToHex } from '@bitauth/libauth';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Artifacts ────────────────────────────────────────────────────────────────
export const LIMIT_ARTIFACT = JSON.parse(
    readFileSync(join(__dirname, '..', 'artifacts', 'LimitOrderSwap.json'), 'utf-8'),
);
export const DUTCH_ARTIFACT = JSON.parse(
    readFileSync(join(__dirname, '..', 'artifacts', 'DutchAuctionSwap.json'), 'utf-8'),
);

// ── Deterministic keypairs ─────────────────────────────────────────────────────
export interface Key {
    priv: Uint8Array;
    pub: Uint8Array;
    pkh: Uint8Array;
    template: SignatureTemplate;
}

function makeKey(seedByte: number): Key {
    const priv = new Uint8Array(32).fill(seedByte || 1);
    priv[31] = seedByte; // keep keys distinct even when fill byte clashes
    const pub = secp256k1.derivePublicKeyCompressed(priv);
    if (typeof pub === 'string') throw new Error(`bad key seed ${seedByte}: ${pub}`);
    return { priv, pub, pkh: hash160(pub), template: new SignatureTemplate(priv) };
}

export const MAKER = makeKey(0x11);
export const RESOLVER = makeKey(0x22);
export const ATTACKER = makeKey(0x33);

// ── Token category (PUSD on chipnet) ───────────────────────────────────────────
export const CAT = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
const reverseHex = (hex: string) => hex.match(/.{2}/g)!.reverse().join('');
/** Little-endian, 0x-prefixed form used for contract constructor params. */
export const catLE = `0x${reverseHex(CAT)}`;
/** Empty-bytes form for native BCH. */
export const BCH = '0x';

// ── Helpers ─────────────────────────────────────────────────────────────────
/** Raw P2PKH locking bytecode: OP_DUP OP_HASH160 <20> OP_EQUALVERIFY OP_CHECKSIG */
export function p2pkh(pkh: Uint8Array): Uint8Array {
    return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

export function provider(): MockNetworkProvider {
    return new MockNetworkProvider();
}

/** A deterministic fake outpoint. */
let nonce = 0;
export function fakeTxid(): string {
    nonce += 1;
    return binToHex(hash160(Uint8Array.from([nonce, nonce, nonce]))).padEnd(64, '0').slice(0, 64);
}

// ── Tiny test runner ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

/** The covenant must ACCEPT this transaction (debug must not throw). */
export function expectAccept(name: string, build: () => TransactionBuilder) {
    try {
        build().debug();
        passed++;
        console.log(`  ✅ ACCEPT  ${name}`);
    } catch (e: any) {
        failed++;
        console.error(`  ❌ ACCEPT  ${name}\n        expected success but covenant REJECTED: ${oneLine(e)}`);
    }
}

/**
 * The covenant must REJECT this transaction (debug must throw).
 * Optionally assert the failure message matches `reason` — useful to prove the
 * rejection came from the intended require(), not an unrelated error.
 */
export function expectReject(name: string, build: () => TransactionBuilder, reason?: RegExp) {
    let threw: any;
    try {
        build().debug();
    } catch (e: any) {
        threw = e;
    }
    if (!threw) {
        failed++;
        console.error(`  ❌ REJECT  ${name}\n        DANGER: covenant ACCEPTED a transaction it should have rejected`);
        return;
    }
    if (reason && !reason.test(`${threw.message ?? ''} ${threw.requireStatement?.message ?? ''}`)) {
        failed++;
        console.error(`  ❌ REJECT  ${name}\n        rejected, but for the wrong reason: ${oneLine(threw)}`);
        return;
    }
    passed++;
    console.log(`  ✅ REJECT  ${name}`);
}

function oneLine(e: any): string {
    return String(e?.message ?? e).split('\n')[0].slice(0, 200);
}

export function section(title: string) {
    console.log(`\n── ${title} ──`);
}

export function summary(suite: string): never {
    console.log(`\n═══ ${suite}: ${passed} passed, ${failed} failed ═══`);
    process.exit(failed > 0 ? 1 : 0);
}
