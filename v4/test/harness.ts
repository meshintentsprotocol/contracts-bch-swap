/**
 * Mesh V4 VM harness.
 *
 * Transactions are built with CashScript 0.14 (`TransactionBuilder`, every UTXO
 * carries its `lockingBytecode`) and then verified EXPLICITLY with libauth's
 * `createVirtualMachineBch2026()`, the BCH_2026_05 rules (loops, functions,
 * bitwise, P2S). CashScript's own `debug()` is not used as the verdict.
 *
 * Guards against false positives (the alpha FRI e2e passed on a broken check):
 *   - a transaction that fails to BUILD is a harness error, never a "reject";
 *   - `expectReject` only counts a SCRIPT failure, and by default only at the
 *     input under test (`at`), so a bad signature elsewhere or a policy error
 *     (dust, size) can't stand in for the covenant refusing;
 *   - `selftest.ts` proves a known-bad transaction is refused and that
 *     `expectReject` reports a failure when handed a valid transaction.
 */
import { MockNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
// Deep import: the same conversion CashScript uses when it signs (no exports map).
import { generateLibauthSourceOutputs } from 'cashscript/dist/utils.js';
import {
    binToHex, createVirtualMachineBch2026, encodeTransaction, hash160, hexToBin, secp256k1,
    type Output as LibauthOutput, type Transaction as LibauthTransaction,
} from '@bitauth/libauth';

// ── Keys ──────────────────────────────────────────────────────────────────────
export interface Key { priv: Uint8Array; pub: Uint8Array; pkh: Uint8Array; template: SignatureTemplate; lock: Uint8Array }

export function makeKey(seedByte: number): Key {
    const priv = new Uint8Array(32).fill(seedByte || 1);
    priv[31] = seedByte;
    const pub = secp256k1.derivePublicKeyCompressed(priv);
    if (typeof pub === 'string') throw new Error(`invalid key seed ${seedByte}: ${pub}`);
    const pkh = hash160(pub);
    return { priv, pub, pkh, template: new SignatureTemplate(priv), lock: p2pkh(pkh) };
}

export function p2pkh(pkh: Uint8Array): Uint8Array {
    return Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]);
}

export const OWNER = makeKey(0x11);
export const TAKER = makeKey(0x22);
export const ATTACKER = makeKey(0x33);
export const KEEPER = makeKey(0x44);

// ── Categories (display order, as wallets and CashScript show them) ──────────
export const TOKEN_A = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
export const TOKEN_B = 'b4863d5773c7a269b6fe3b9f7ce2ce1098ab71c0b046ef2a39058d5e30b1f353';
export const TOKEN_FAKE = '1111111111111111111111111111111111111111111111111111111111111111';

// ── Builders ──────────────────────────────────────────────────────────────────
export const net = new MockNetworkProvider({ vmTarget: 'BCH_2026_05' });
export const tb = () => new TransactionBuilder({ provider: net, allowImplicitFungibleTokenBurn: true });

export interface Tok { amount: bigint; category: string; nft?: { capability: 'none' | 'mutable' | 'minting'; commitment: string } }
export const tok = (amount: bigint, category = TOKEN_A): Tok => ({ amount, category });
export const nft = (category: string, capability: 'none' | 'mutable' | 'minting' = 'none', commitment = '', amount = 0n): Tok =>
    ({ amount, category, nft: { capability, commitment } });

let nonce = 0;
export function fakeTxid(): string {
    nonce += 1;
    const b = new Uint8Array(32);
    new DataView(b.buffer).setUint32(0, nonce);
    b[31] = 0xab;
    return binToHex(b);
}

/** A UTXO locked by `lock` (a contract's lockingBytecode hex, or raw bytes). */
export function utxo(lock: Uint8Array | string, satoshis: bigint, token?: Tok, vout = 0, txid = fakeTxid()) {
    const lockingBytecode = typeof lock === 'string' ? lock : binToHex(lock);
    return { txid, vout, satoshis, lockingBytecode, ...(token ? { token } : {}) };
}

export const lockOf = (c: { lockingBytecode: string }) => hexToBin(c.lockingBytecode);

// ── Verification ──────────────────────────────────────────────────────────────
export const vm = createVirtualMachineBch2026(true);
export const vmConsensus = createVirtualMachineBch2026(false);

export interface Built { transaction: LibauthTransaction; sourceOutputs: LibauthOutput[]; size: number }

/** Build without CashScript's policy checks (fee, burn): the VM is the only judge. */
export function buildTx(b: TransactionBuilder): Built {
    const transaction = (b as any).buildLibauthTransaction(true) as LibauthTransaction;
    const sourceOutputs = generateLibauthSourceOutputs((b as any).inputs) as LibauthOutput[];
    return { transaction, sourceOutputs, size: encodeTransaction(transaction).length };
}

/** `true` or the VM's error string. */
export function verify(built: Built, standard = true): true | string {
    const r = (standard ? vm : vmConsensus).verify({ transaction: built.transaction, sourceOutputs: built.sourceOutputs });
    return r === true ? true : String(r);
}

export interface InputMetrics { index: number; ok: boolean; error?: string; opCost: number; maxOpCost: number; unlockingBytes: number; lockingBytes: number; instructions: number }

/** Evaluate each input on its own and report its operation cost. */
export function inputMetrics(built: Built): InputMetrics[] {
    return built.transaction.inputs.map((input, index) => {
        const state = vm.evaluate({ inputIndex: index, sourceOutputs: built.sourceOutputs, transaction: built.transaction }) as any;
        const m = state.metrics;
        return {
            index,
            ok: state.error === undefined && vm.stateSuccess(state) === true,
            error: state.error,
            opCost: m.operationCost,
            maxOpCost: m.maximumOperationCost,
            unlockingBytes: input.unlockingBytecode.length,
            lockingBytes: built.sourceOutputs[index]!.lockingBytecode.length,
            instructions: m.evaluatedInstructionCount,
        };
    });
}

/** Input index named in a libauth verify error ("Error in evaluating input index 2: …"). */
export function failingInput(error: string): number | undefined {
    const m = /input index (\d+)/.exec(error);
    return m ? Number(m[1]) : undefined;
}

// ── Assertions ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function pass(line: string) { passed++; console.log(`  ✅ ${line}`); }
function fail(line: string, why: string) { failed++; failures.push(line); console.error(`  ❌ ${line}\n        ${why}`); }
const short = (s: string) => s.split('\n')[0]!.slice(0, 240);

export function expectAccept(name: string, build: () => TransactionBuilder): Built | undefined {
    let built: Built;
    try { built = buildTx(build()); } catch (e: any) { fail(`ACCEPT  ${name}`, `HARNESS: could not build: ${short(e?.message ?? String(e))}`); return; }
    const r = verify(built);
    if (r === true) { pass(`ACCEPT  ${name}`); return built; }
    fail(`ACCEPT  ${name}`, `expected success but the VM REJECTED: ${short(r)}`);
    return;
}

export interface RejectOptions {
    /** The input that must be the one failing (the covenant under test). Default: any script failure. */
    at?: number;
    /** Must also match the VM error. */
    reason?: RegExp;
    /** Accept a standardness (policy) failure as the rejection. Off by default. */
    policy?: boolean;
}

export function expectReject(name: string, build: () => TransactionBuilder, opts: RejectOptions = {}): void {
    let built: Built;
    try { built = buildTx(build()); } catch (e: any) { fail(`REJECT  ${name}`, `HARNESS: could not build (a build error is not a rejection): ${short(e?.message ?? String(e))}`); return; }
    const r = verify(built);
    if (r === true) { fail(`REJECT  ${name}`, 'DANGER: the VM ACCEPTED a transaction that must be rejected'); return; }
    const scriptFailure = /evaluating input index \d+/.test(r);
    if (!scriptFailure && !opts.policy) {
        fail(`REJECT  ${name}`, `rejected for a non-script reason (policy/structure), which proves nothing about the covenant: ${short(r)}`);
        return;
    }
    if (opts.at !== undefined) {
        // Standard verify stops at the first failing input; re-check the target input on its own.
        const m = inputMetrics(built)[opts.at];
        if (!m || m.ok) { fail(`REJECT  ${name}`, `input ${opts.at} PASSED on its own; the rejection came from elsewhere: ${short(r)}`); return; }
    }
    if (opts.reason && !opts.reason.test(r)) { fail(`REJECT  ${name}`, `rejected for an unexpected reason: ${short(r)}`); return; }
    pass(`REJECT  ${name}`);
}

export function check(name: string, ok: boolean, detail = ''): void {
    if (ok) pass(`CHECK   ${name}${detail ? `  (${detail})` : ''}`);
    else fail(`CHECK   ${name}`, detail || 'condition false');
}

export function section(title: string) { console.log(`\n── ${title} ──`); }

export function stats() { return { passed, failed, failures: [...failures] }; }
export function resetStats() { passed = 0; failed = 0; failures.length = 0; }

/** Run assertions without counting them; returns how many passed and failed (harness self-test). */
export function captured(fn: () => void): { passed: number; failed: number } {
    const saved = { passed, failed, n: failures.length };
    const log = console.log, err = console.error;
    console.log = () => {}; console.error = () => {};
    try { fn(); } finally { console.log = log; console.error = err; }
    const delta = { passed: passed - saved.passed, failed: failed - saved.failed };
    passed = saved.passed; failed = saved.failed; failures.length = saved.n;
    return delta;
}

export function summary(suite: string): void {
    console.log(`\n═══ ${suite}: ${passed} passed, ${failed} failed ═══`);
    if (failed > 0) process.exitCode = 1;
}

// ── Fixed-width encoding (VM byte order) ─────────────────────────────────────
/** Little-endian signed-positive integer of exactly `bytes` bytes, as hex. */
export function le(v: bigint | number, bytes: number): string {
    let x = BigInt(v);
    if (x < 0n || x >= 1n << BigInt(bytes * 8 - 1)) throw new Error(`value ${v} does not fit ${bytes} signed bytes`);
    let out = '';
    for (let i = 0; i < bytes; i++) { out += (x & 0xffn).toString(16).padStart(2, '0'); x >>= 8n; }
    return out;
}

/** VM number of exactly `bytes` bytes, signed (sign-magnitude: top bit of the last byte), as hex. */
export function sle(v: bigint | number, bytes: number): string {
    const x = BigInt(v);
    const mag = le(x < 0n ? -x : x, bytes);
    if (x >= 0n) return mag;
    const last = parseInt(mag.slice(-2), 16) | 0x80;
    return mag.slice(0, -2) + last.toString(16).padStart(2, '0');
}

/** Display-order category → the order the VM's introspection pushes. */
export const catVm = (c: string) => c.match(/.{2}/g)!.reverse().join('');
