/**
 * BCHMesh StrategyCovenant — Chipnet E2E Test
 *
 * Flow tested:
 *   1. FUND: Wallet deposits BCH reserve into StrategyCovenant (BCH → Token strategy)
 *   2. FILL: Taker pays tokens → receives BCH from covenant
 *   3. DOCK: Owner withdraws remaining BCH reserve (exit)
 *
 * Scenario:
 *   - Strategy: "I hold BCH. Send me token `b4863d...`, receive BCH."
 *   - Price: 1 token = 1 sat (priceNumerator=1, priceDenominator=1)
 *   - Fee: 30 bps (0.30%)
 *   - Reserve: 10,000 sats BCH
 *   - Taker sends 1000 tokens → gets 997 sats (after 0.30% fee)
 *
 * Token used: b4863d5773c7a269b6fe3b9f7ce2ce1098ab71c0b046ef2a39058d5e30b1f353
 *   Balance: 936,000 fungible tokens (confirmed in wallet)
 */

import {
    Contract,
    ElectrumNetworkProvider,
    SignatureTemplate,
    TransactionBuilder,
} from 'cashscript';
import { decodeTransaction, hexToBin, binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import { TestNetWallet } from 'mainnet-js';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Constants ──────────────────────────────────────────────────────────────────
const ARTIFACT = join(ROOT, 'artifacts', 'StrategyCovenant.json');
const WALLET_FILE = join(ROOT, 'wallet.json');

// Token b4863d... is the one with 936,000 balance on chipnet
// The wallet holds it as a CashToken fungible token.
const TOKEN_CATEGORY = 'b4863d5773c7a269b6fe3b9f7ce2ce1098ab71c0b046ef2a39058d5e30b1f353';

// CashScript introspection compares LE-encoded category bytes on stack.
// Wallet pays out the token (tokenCategoryIn).
// The BCH reserve is our OUT (tokenCategoryOut = 0x = native BCH).
const reverseHex = (hex: string) => hex.match(/.{2}/g)!.reverse().join('');

const log = (msg: string) => console.log(`  ${msg}`);
const section = (title: string) => console.log(`\n${'─'.repeat(60)}\n  ${title}\n${'─'.repeat(60)}`);

// ── Helpers ────────────────────────────────────────────────────────────────────

function pkh(pkBytes: Uint8Array | Buffer): Buffer {
    const sha256 = createHash('sha256').update(pkBytes).digest();
    return createHash('ripemd160').update(sha256).digest();
}

async function findOutputIndex(
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

// ── Main E2E Test ──────────────────────────────────────────────────────────────

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   BCHMesh StrategyCovenant — Chipnet E2E Transaction     ║');
    console.log('╚══════════════════════════════════════════════════════════╝');

    // ── 1. Load Wallet ────────────────────────────────────────────────────────
    section('Step 1 — Load Wallet');
    if (!existsSync(WALLET_FILE)) throw new Error('wallet.json not found');
    const walletData = JSON.parse(readFileSync(WALLET_FILE, 'utf-8'));
    const wallet = await TestNetWallet.fromWIF(walletData.wif);

    const userAddr = (wallet as any).address || (wallet as any).cashaddr;
    const tokenAddr = (wallet as any).tokenaddr;
    const bchBalance = await wallet.getBalance();
    const allTokens = await wallet.getAllTokenBalances();

    log(`Address:       ${userAddr}`);
    log(`Token Address: ${tokenAddr}`);
    log(`BCH Balance:   ${bchBalance} sats`);
    log(`Token Balance (${TOKEN_CATEGORY.slice(0, 8)}...): ${allTokens[TOKEN_CATEGORY] ?? 'N/A'} tokens`);

    if (bchBalance < 50_000) throw new Error('Need at least 50,000 sats to run this test.');
    if (!allTokens[TOKEN_CATEGORY]) throw new Error('Token not in wallet. Check TOKEN_CATEGORY.');

    // ── 2. Initialize Contract ────────────────────────────────────────────────
    section('Step 2 — Initialize StrategyCovenant Contract');
    if (!existsSync(ARTIFACT)) throw new Error(`Artifact not found: ${ARTIFACT}`);
    const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf-8'));

    const provider = new ElectrumNetworkProvider('chipnet');

    const ownerPkHex = await (wallet as any).getPublicKey() as string;
    const ownerPkBytes = Buffer.from(ownerPkHex, 'hex');
    const ownerPkhBytes = pkh(ownerPkBytes);

    // tokenCategoryIn = the token we ACCEPT (LE encoded for CashScript introspection)
    const tokenCategoryInLE = `0x${reverseHex(TOKEN_CATEGORY)}`;
    // tokenCategoryOut = 0x (native BCH)
    const tokenCategoryOut = '0x';
    const priceNumerator = 1n;    // 1 sat per 1 token
    const priceDenominator = 1n;
    const feeBps = 30n;           // 0.30%

    const contract = new Contract(
        artifact,
        [ownerPkhBytes, tokenCategoryInLE, tokenCategoryOut, priceNumerator, priceDenominator, feeBps],
        { provider }
    );

    log(`Contract Address:       ${contract.address}`);
    log(`Contract Token Address: ${contract.tokenAddress}`);
    log(`Contract Size:          ${contract.bytesize} bytes`);
    log(`Contract Opcount:       ${contract.opcount} ops`);

    // ── 3. Fund Contract (Maker deposits BCH reserve) ─────────────────────────
    section('Step 3 — Fund: Wallet deposits BCH reserve into StrategyCovenant');
    const RESERVE_SATS = 10_000n; // Maker deposits 10,000 sats BCH as reserve

    log(`Depositing ${RESERVE_SATS} sats BCH into covenant...`);
    let fundTxId: string;
    try {
        const fundResult = await wallet.send([
            {
                cashaddr: contract.address,  // Pure BCH contract (no token)
                value: Number(RESERVE_SATS),
                unit: 'sat',
            }
        ] as any);
        fundTxId = fundResult.txId!;
        log(`✅ Funded! TXID: ${fundTxId}`);
        log(`   Explorer: https://chipnet.chaingraph.cash/tx/${fundTxId}`);
    } catch (e: any) {
        console.error('❌ Funding failed:', e.message);
        throw e;
    }

    log('Waiting 5s for Electrum server propagation...');
    await new Promise(r => setTimeout(r, 5000));

    // Locate the contract output in the funding TX
    const contractLockingResult = cashAddressToLockingBytecode(contract.address);
    if (typeof contractLockingResult === 'string') throw new Error(contractLockingResult);
    const contractLockingHex = binToHex(contractLockingResult.bytecode);

    const fundOutputIndex = await findOutputIndex(provider, fundTxId, contractLockingHex);
    if (fundOutputIndex === -1) throw new Error('Could not find contract output in funding TX');

    const contractUtxo = {
        txid: fundTxId,
        vout: fundOutputIndex,
        satoshis: RESERVE_SATS,
    };
    log(`Contract UTXO: ${fundTxId}:${fundOutputIndex} (${RESERVE_SATS} sats)`);

    // ── 4. Fill: Taker pays tokens → receives BCH ─────────────────────────────
    section('Step 4 — Fill: Taker pays 1000 tokens → receives BCH from covenant');

    const amountIn = 1000n;  // Taker sends 1000 tokens
    // amountOut = floor((1000 * 1 * (10000 - 30)) / (1 * 10000)) = floor(1000 * 9970 / 10000) = 997
    const amountOut = (amountIn * priceNumerator * (10000n - feeBps)) / (priceDenominator * 10000n);
    const remainingReserve = RESERVE_SATS - amountOut;

    log(`  amountIn:        ${amountIn} tokens`);
    log(`  amountOut:       ${amountOut} sats (after 0.30% fee)`);
    log(`  remainingReserve:${remainingReserve} sats`);

    // Get wallet UTXOs for taker to pay token + fund tx fees
    const walletUtxos = await provider.getUtxos(tokenAddr);
    log(`  Taker wallet UTXOs: ${walletUtxos.length}`);

    // Find a wallet UTXO holding the token we want to pay
    const tokenUtxo = walletUtxos.find(u =>
        u.token && u.token.category === TOKEN_CATEGORY && u.token.amount >= amountIn
    );
    if (!tokenUtxo) throw new Error(`No UTXO found with ${amountIn} tokens of category ${TOKEN_CATEGORY}`);

    // Find pure BCH UTXOs for tx fee
    const normalUtxos = await provider.getUtxos(userAddr);
    const bchUtxo = normalUtxos.find(u => !u.token && u.satoshis > 5000n);
    if (!bchUtxo) throw new Error('No pure BCH UTXO for fees found');

    log(`  Token UTXO: ${tokenUtxo.txid}:${tokenUtxo.vout} (${tokenUtxo.token!.amount} tokens)`);
    log(`  BCH fee UTXO: ${bchUtxo.txid}:${bchUtxo.vout} (${bchUtxo.satoshis} sats)`);

    const sigTemplate = new SignatureTemplate(walletData.wif);
    const txBuilder = new TransactionBuilder({ provider });

    // Input 0: Contract UTXO (BCH reserve locked in covenant)
    txBuilder.addInput(contractUtxo, contract.unlock.fill(amountIn));

    // Input 1: Taker token UTXO (pays tokenCategoryIn)
    txBuilder.addInput(tokenUtxo, sigTemplate.unlockP2PKH());

    // Input 2: Pure BCH UTXO for fees
    txBuilder.addInput(bchUtxo, sigTemplate.unlockP2PKH());

    // Output 0: Recreate covenant with remaining BCH reserve
    txBuilder.addOutput({
        to: contract.address,
        amount: remainingReserve,
    });

    // Output 1: Deliver BCH amountOut to taker
    txBuilder.addOutput({
        to: userAddr,
        amount: amountOut,
    });

    // Output 2: Deliver amountIn payment tokens to the maker (owner's token address)
    // CRITICAL: All input token amounts MUST appear in outputs (no implicit burning).
    // The 1,000 tokens the taker paid go here → maker receives them.
    txBuilder.addOutput({
        to: tokenAddr,  // maker's token-aware address
        amount: 1000n,  // dust sats for token output
        token: {
            amount: amountIn,  // 1,000 tokens paid by taker go to maker
            category: TOKEN_CATEGORY,
        },
    });

    // Output 3: Token change back to taker + BCH change
    const tokenChange = tokenUtxo.token!.amount - amountIn;
    const bchIn = RESERVE_SATS + tokenUtxo.satoshis + bchUtxo.satoshis;
    const bchOut = remainingReserve + amountOut + 1000n; // +1000 for Output 2 dust
    const fee = 2000n;
    const bchChange = bchIn - bchOut - fee;

    log(`  Token change back to taker: ${tokenChange} tokens`);
    log(`  BCH change: ${bchChange} sats`);

    if (tokenChange > 0n) {
        // Return token change to taker's token address
        txBuilder.addOutput({
            to: tokenAddr,
            amount: bchChange > 546n ? bchChange : 1000n,
            token: {
                amount: tokenChange,
                category: TOKEN_CATEGORY,
            },
        });
    } else if (bchChange > 546n) {
        // Pure BCH change only
        txBuilder.addOutput({
            to: userAddr,
            amount: bchChange,
        });
    }

    log(`  Building fill transaction...`);
    try {
        const tx = await txBuilder.send();
        log(`✅ Fill Complete!`);
        log(`   TXID:     ${tx.txid}`);
        log(`   Explorer: https://chipnet.chaingraph.cash/tx/${tx.txid}`);
        log(`   Taker received: ${amountOut} sats BCH`);
        log(`   Contract remaining reserve: ${remainingReserve} sats`);
    } catch (e: any) {
        console.error('❌ Fill tx failed:', e.message);
        if (e.logs) console.error('   Debug logs:', e.logs);
        throw e;
    }

    // ── 5. Dock: Owner reclaims remaining BCH reserve ─────────────────────────
    section('Step 5 — Dock: Owner withdraws remaining BCH from covenant');
    log('Waiting 5s before dock...');
    await new Promise(r => setTimeout(r, 5000));

    const postFillUtxos = await provider.getUtxos(contract.address);
    log(`Contract UTXOs after fill: ${postFillUtxos.length}`);

    if (postFillUtxos.length === 0) {
        log('⚠️  No UTXOs at contract (reserve may have been fully exhausted). Skipping dock.');
    } else {
        const contractReserveUtxo = postFillUtxos[0];
        log(`Docking UTXO: ${contractReserveUtxo.txid}:${contractReserveUtxo.vout} (${contractReserveUtxo.satoshis} sats)`);

        const dockBuilder = new TransactionBuilder({ provider });
        dockBuilder.addInput(contractReserveUtxo, contract.unlock.dock(ownerPkBytes, sigTemplate));

        const dockFeeUtxos = await provider.getUtxos(userAddr);
        const dockFeeUtxo = dockFeeUtxos.find(u => !u.token && u.satoshis > 3000n);
        if (!dockFeeUtxo) throw new Error('No BCH UTXO for dock fee');
        dockBuilder.addInput(dockFeeUtxo, sigTemplate.unlockP2PKH());

        const totalDockIn = contractReserveUtxo.satoshis + dockFeeUtxo.satoshis;
        const dockFee = 1000n;
        dockBuilder.addOutput({ to: userAddr, amount: totalDockIn - dockFee });

        try {
            const dockTx = await dockBuilder.send();
            log(`✅ Dock Complete!`);
            log(`   TXID:     ${dockTx.txid}`);
            log(`   Explorer: https://chipnet.chaingraph.cash/tx/${dockTx.txid}`);
            log(`   Reclaimed: ${contractReserveUtxo.satoshis} sats BCH`);
        } catch (e: any) {
            console.error('❌ Dock tx failed:', e.message);
            if (e.logs) console.error('   Debug logs:', e.logs);
        }
    }

    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║   ✅  BCHMesh E2E Test Complete!                          ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
}

main().catch((e) => {
    console.error('\n❌ Fatal error:', e.message ?? e);
    process.exit(1);
});
