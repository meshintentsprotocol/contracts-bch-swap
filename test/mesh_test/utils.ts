/**
 * BCHMesh Test Utilities — Shared helpers for all mesh_test scripts
 */

import {
    Contract,
    ElectrumNetworkProvider,
    SignatureTemplate,
    TransactionBuilder,
} from 'cashscript';
import { decodeTransaction, hexToBin, binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import { TestNetWallet } from 'mainnet-js';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, '..', '..');

// ── Well-known chipnet token categories ──────────────────────────────────────
// Confirmed balances in test wallet as of 2026-08-21
export const TOKEN_A = 'b4863d5773c7a269b6fe3b9f7ce2ce1098ab71c0b046ef2a39058d5e30b1f353'; // 936,000 FT
export const TOKEN_B = 'c30179768cb779a8175ec7bc9e87e51af39000cee7515a1fb01dd2d18e04a8b9'; // 1,000,000 FT
export const TOKEN_C = '4ea30da79868f1c0ac04d8df28c1f1912187202d5dc16c1931653afa23a9b61f'; // 1,000,000 FT

// Reverse hex for Little-Endian (CashScript introspection stack format)
export const reverseHex = (hex: string) => hex.match(/.{2}/g)!.reverse().join('');

// ── Logging helpers ──────────────────────────────────────────────────────────
export const log = (msg: string) => console.log(`  ${msg}`);
export const ok  = (msg: string) => console.log(`  ✅ ${msg}`);
export const err = (msg: string) => console.error(`  ❌ ${msg}`);
export const section = (title: string) =>
    console.log(`\n${'─'.repeat(62)}\n  ${title}\n${'─'.repeat(62)}`);
export const banner = (title: string, sub = '') => {
    console.log(`\n╔${'═'.repeat(60)}╗`);
    console.log(`║  ${title.padEnd(58)}║`);
    if (sub) console.log(`║  ${sub.padEnd(58)}║`);
    console.log(`╚${'═'.repeat(60)}╝`);
};

// ── PKH derivation ───────────────────────────────────────────────────────────
export function derivePkh(pkHex: string): Buffer {
    const pkBytes = Buffer.from(pkHex, 'hex');
    const sha256  = createHash('sha256').update(pkBytes).digest();
    return createHash('ripemd160').update(sha256).digest();
}

// ── Electrum helpers ─────────────────────────────────────────────────────────
export async function findOutputIndex(
    provider: ElectrumNetworkProvider,
    txid: string,
    lockingHex: string,
    tokenCategory?: string
): Promise<number> {
    const rawTx = await provider.getRawTransaction(txid);
    const decoded = decodeTransaction(hexToBin(rawTx));
    if (typeof decoded === 'string') throw new Error('Failed to decode TX: ' + decoded);
    return decoded.outputs.findIndex((o: any) => {
        const lbHex = binToHex(o.lockingBytecode);
        if (lbHex !== lockingHex) return false;
        if (tokenCategory) return o.token && binToHex(o.token.category) === tokenCategory;
        return true;
    });
}

export function contractLockingHex(address: string): string {
    const result = cashAddressToLockingBytecode(address);
    if (typeof result === 'string') throw new Error(result);
    return binToHex(result.bytecode);
}

// ── Wallet bootstrap ─────────────────────────────────────────────────────────
export interface WalletCtx {
    wallet: TestNetWallet;
    wif: string;
    userAddr: string;
    tokenAddr: string;
    ownerPkHex: string;
    ownerPkhBytes: Buffer;
    provider: ElectrumNetworkProvider;
    sig: SignatureTemplate;
}

export async function loadWallet(): Promise<WalletCtx> {
    const walletFile = join(ROOT, 'wallet.json');
    if (!existsSync(walletFile)) throw new Error('wallet.json not found');
    const { wif } = JSON.parse(readFileSync(walletFile, 'utf-8'));

    const wallet = await TestNetWallet.fromWIF(wif);
    const userAddr   = (wallet as any).address || (wallet as any).cashaddr;
    const tokenAddr  = (wallet as any).tokenaddr;
    const ownerPkHex = await (wallet as any).getPublicKey() as string;
    const ownerPkhBytes = derivePkh(ownerPkHex);
    const provider = new ElectrumNetworkProvider('chipnet');

    return { wallet, wif, userAddr, tokenAddr, ownerPkHex, ownerPkhBytes, provider, sig: new SignatureTemplate(wif) };
}

// ── Artifact loader ──────────────────────────────────────────────────────────
export function loadArtifact(name: string) {
    const p = join(ROOT, 'artifacts', `${name}.json`);
    if (!existsSync(p)) throw new Error(`Artifact not found: ${p}`);
    return JSON.parse(readFileSync(p, 'utf-8'));
}

// ── Sleep helper ─────────────────────────────────────────────────────────────
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Fund a BCH-reserve contract from wallet ──────────────────────────────────
export async function fundBchContract(
    ctx: WalletCtx,
    contractAddress: string,
    reserveSats: bigint,
    label: string
): Promise<{ txid: string; vout: number }> {
    log(`[${label}] Funding with ${reserveSats} sats BCH...`);
    const result = await ctx.wallet.send([
        { cashaddr: contractAddress, value: Number(reserveSats), unit: 'sat' }
    ] as any);
    const txid = result.txId!;
    ok(`[${label}] Funded → TXID: ${txid}`);
    log(`   Explorer: https://chipnet.chaingraph.cash/tx/${txid}`);
    await sleep(4000);

    const lbHex = contractLockingHex(contractAddress);
    const vout  = await findOutputIndex(ctx.provider, txid, lbHex);
    if (vout === -1) throw new Error(`[${label}] Could not find contract output in funding TX`);
    return { txid, vout };
}

// ── Dock (owner withdraws) a contract UTXO ──────────────────────────────────
export async function dockContract(
    ctx: WalletCtx,
    contract: Contract,
    contractUtxo: { txid: string; vout: number; satoshis: bigint }
): Promise<string> {
    const dockBuilder = new TransactionBuilder({ provider: ctx.provider });
    dockBuilder.addInput(contractUtxo, contract.unlock.dock(Buffer.from(ctx.ownerPkHex, 'hex'), ctx.sig));

    const DOCK_FEE = 1000n;
    if (contractUtxo.satoshis > (546n + DOCK_FEE)) {
        // Contract UTXO self-funds the withdrawal in a clean 1-in 1-out TX
        dockBuilder.addOutput({ to: ctx.userAddr, amount: contractUtxo.satoshis - DOCK_FEE });
    } else {
        // Fallback: pull an external fee UTXO
        const bchUtxos = await ctx.provider.getUtxos(ctx.userAddr);
        const feeUtxo  = bchUtxos.find(u => !u.token && u.satoshis > 3000n);
        if (feeUtxo) {
            dockBuilder.addInput(feeUtxo, ctx.sig.unlockP2PKH());
            dockBuilder.addOutput({ to: ctx.userAddr, amount: contractUtxo.satoshis + feeUtxo.satoshis - DOCK_FEE });
        } else {
            dockBuilder.addOutput({ to: ctx.userAddr, amount: contractUtxo.satoshis - DOCK_FEE });
        }
    }

    const tx = await dockBuilder.send();
    ok(`Dock → TXID: ${tx.txid}`);
    log(`   Explorer: https://chipnet.chaingraph.cash/tx/${tx.txid}`);
    return tx.txid;
}

// ── Test result tracker ──────────────────────────────────────────────────────
export interface TestResult {
    name: string;
    passed: boolean;
    txids: string[];
    notes: string[];
    error?: string;
    durationMs: number;
}

export function createResult(name: string): TestResult & { start: number } {
    return { name, passed: false, txids: [], notes: [], durationMs: 0, start: Date.now() };
}

export function printSummary(results: TestResult[]) {
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    console.log(`\n${'═'.repeat(62)}`);
    console.log(`  📊 BCHMesh Chipnet E2E Test Summary`);
    console.log(`${'═'.repeat(62)}`);
    for (const r of results) {
        const icon = r.passed ? '✅' : '❌';
        console.log(`  ${icon} ${r.name.padEnd(44)} ${r.durationMs}ms`);
        for (const txid of r.txids) {
            console.log(`     TX: https://chipnet.chaingraph.cash/tx/${txid}`);
        }
        if (!r.passed && r.error) console.log(`     Error: ${r.error}`);
    }
    console.log(`${'─'.repeat(62)}`);
    console.log(`  PASSED: ${passed}  |  FAILED: ${failed}  |  TOTAL: ${results.length}`);
    console.log(`${'═'.repeat(62)}\n`);
    return { passed, failed };
}
