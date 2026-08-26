/**
 * BCHMesh Security Test Harness
 *
 * Runs CashScript's MockNetworkProvider + TransactionBuilder.debug()
 * to execute the Bitcoin Cash VM offline and verify covenant security invariants.
 */

import { Contract, MockNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { secp256k1, hash160, binToHex, sha256 } from '@bitauth/libauth';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// ── Artifact Loaders ──────────────────────────────────────────────────────────
export const STRATEGY_ARTIFACT = JSON.parse(
    readFileSync(join(ROOT, 'artifacts', 'StrategyCovenant.json'), 'utf-8')
);
export const ORACLE_ARTIFACT = JSON.parse(
    readFileSync(join(ROOT, 'artifacts', 'OracleStrategyCovenant.json'), 'utf-8')
);
export const RECYCLING_ARTIFACT = JSON.parse(
    readFileSync(join(ROOT, 'artifacts', 'MultiPairRecyclingCovenant.json'), 'utf-8')
);
export const DUTCH_ARTIFACT = JSON.parse(
    readFileSync(join(ROOT, 'artifacts', 'DutchDecayStrategyCovenant.json'), 'utf-8')
);

// ── Key Generation ────────────────────────────────────────────────────────────
export interface Key {
    priv: Uint8Array;
    pub: Uint8Array;
    pkh: Uint8Array;
    template: SignatureTemplate;
}

export function makeKey(seedByte: number): Key {
    const priv = new Uint8Array(32).fill(seedByte || 1);
    priv[31] = seedByte;
    const pub = secp256k1.derivePublicKeyCompressed(priv);
    if (typeof pub === 'string') throw new Error(`Invalid key seed ${seedByte}: ${pub}`);
    return { priv, pub, pkh: hash160(pub), template: new SignatureTemplate(priv) };
}

export const OWNER = makeKey(0x11);
export const TAKER = makeKey(0x22);
export const ATTACKER = makeKey(0x33);
export const ORACLE = makeKey(0x44);

// ── Token Categories ──────────────────────────────────────────────────────────
export const TOKEN_PUSD = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
export const TOKEN_MUSD = 'b4863d5773c7a269b6fe3b9f7ce2ce1098ab71c0b046ef2a39058d5e30b1f353';
export const TOKEN_FAKE = '1111111111111111111111111111111111111111111111111111111111111111';

export const reverseHex = (hex: string) => hex.match(/.{2}/g)!.reverse().join('');
export const pusdLE = `0x${reverseHex(TOKEN_PUSD)}`;
export const musdLE = `0x${reverseHex(TOKEN_MUSD)}`;
export const fakeTokenLE = `0x${reverseHex(TOKEN_FAKE)}`;
export const BCH = '0x';

// ── Helpers ───────────────────────────────────────────────────────────────────
export function p2pkh(pkh: Uint8Array): Uint8Array {
    return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

export function provider(): MockNetworkProvider {
    return new MockNetworkProvider();
}

let nonce = 0;
export function fakeTxid(): string {
    nonce += 1;
    return binToHex(hash160(Uint8Array.from([nonce, nonce, nonce]))).padEnd(64, '0').slice(0, 64);
}

// ── Assertion Runner ──────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

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
        console.error(`  ❌ REJECT  ${name}\n        rejected, but for unexpected reason: ${oneLine(threw)}`);
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

export function summary(suite: string): void {
    console.log(`\n═══ ${suite}: ${passed} passed, ${failed} failed ═══`);
    if (failed > 0) process.exit(1);
}

export function resetStats() {
    passed = 0;
    failed = 0;
}
