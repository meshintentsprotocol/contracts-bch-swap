import {
    Contract,
    ElectrumNetworkProvider,
    SignatureTemplate,
    TransactionBuilder,
} from 'cashscript';
import { createHash } from 'crypto';
import { decodeTransaction, hexToBin, binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import { TestNetWallet, Config } from 'mainnet-js';
import * as fs from 'fs';
import * as path from 'path';

// Force Chipnet
(Config as any).EnforceCashScript = false;
(Config as any).DefaultNetwork = "chipnet";

const WALLET_FILE = 'wallet.json';
const ARTIFACT_FILE = path.resolve('artifacts/DutchAuctionSwapWithFee.json');

const reverseHex = (hex: string) => hex.match(/.{2}/g)!.reverse().join('');

async function main() {
    console.log("=== Starting E2E Dutch Auction With Fee Test ===");

    if (!fs.existsSync(WALLET_FILE)) {
        throw new Error("Wallet file not found.");
    }
    const walletData = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
    const wallet = await TestNetWallet.fromWIF(walletData.wif);
    const userAddr = (wallet as any).address || (wallet as any).cashaddr;
    console.log(`User Wallet: ${userAddr}`);

    const categoryId = "b4863d5773c7a269b6fe3b9f7ce2ce1098ab71c0b046ef2a39058d5e30b1f353";

    if (!fs.existsSync(ARTIFACT_FILE)) {
        throw new Error(`Artifact not found. Did you run cashc?`);
    }
    const artifact = JSON.parse(fs.readFileSync(ARTIFACT_FILE, 'utf8'));

    const makerPkh = await (wallet as any).getPublicKeyHash();
    const feePkh = makerPkh; 
    
    const sellTokenCategoryLE = `0x${reverseHex(categoryId)}`;
    const buyTokenCategory = '0x'; // Native BCH
    const sellAmount = 1000n;
    
    const startBuyAmount = 5000n;
    const endBuyAmount = 4000n;
    const feeAmount = 1000n;

    const duration = 600n;
    // Use "30 days in the past" trick to avoid bad-txns-nonfinal MTP issues
    const fakeNow = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    const startTime = BigInt(fakeNow);

    const provider = new ElectrumNetworkProvider('chipnet');

    const contract = new Contract(artifact, [
        makerPkh,
        feePkh,
        sellTokenCategoryLE,
        buyTokenCategory,
        sellAmount,
        startBuyAmount,
        endBuyAmount,
        feeAmount,
        startTime,
        duration
    ], { provider });

    console.log(`Contract Address: ${contract.address}`);

    // Step 1: Consolidate wallet UTXOs into one large UTXO
    // The contract requires tx.inputs.length == 2 (covenant + exactly 1 solver UTXO)
    console.log("\n--- Consolidating wallet UTXOs ---");
    const consolidateResult = await wallet.sendMax(userAddr);
    console.log(`Consolidated TXID: ${consolidateResult.txId}`);
    await new Promise(r => setTimeout(r, 4000));

    console.log("\n--- Funding Contract ---");
    const fundAmount = 1000n;

    let fundingTxId: string;
    const result = await wallet.send([
        {
            cashaddr: contract.tokenAddress,
            value: 1000,
            unit: 'sat',
            category: categoryId,
            amount: fundAmount
        }
    ] as any);
    fundingTxId = result.txId ?? '';
    console.log(`Funded! TXID: ${fundingTxId}`);
    await new Promise(r => setTimeout(r, 4000));

    const rawTx = await provider.getRawTransaction(fundingTxId);
    const libauthTx = decodeTransaction(hexToBin(rawTx));
    if (typeof libauthTx === 'string') throw new Error("Failed to decode funding TX");

    const contractLocking = cashAddressToLockingBytecode(contract.tokenAddress);
    if (typeof contractLocking === 'string') throw new Error(contractLocking);
    const contractLockingHex = binToHex(contractLocking.bytecode);

    const tokenOutputIndex = libauthTx.outputs.findIndex((o: any) =>
        binToHex(o.lockingBytecode) === contractLockingHex &&
        o.token && binToHex(o.token.category) === categoryId
    );

    const utxo = {
        txid: fundingTxId,
        vout: tokenOutputIndex,
        satoshis: 1000n,
        token: { amount: fundAmount, category: categoryId },
    };

    // Get wallet UTXOs — after consolidation, there should be exactly one large pure-BCH UTXO
    const walletUtxos = await provider.getUtxos(userAddr);
    const pureBchUtxos = walletUtxos.filter((u: any) => !u.token);
    console.log(`Found ${pureBchUtxos.length} pure BCH UTXO(s)`);
    
    if (pureBchUtxos.length === 0) throw new Error("No wallet UTXOs found.");

    // Pick the single largest UTXO
    const solverUtxo = pureBchUtxos.sort((a: any, b: any) => Number(b.satoshis - a.satoshis))[0];
    console.log(`Using solver UTXO: ${solverUtxo.satoshis} sats`);

    try {
        console.log("\n--- Attempting Fill ---");
        const sigTemplate = new SignatureTemplate(walletData.wif);
        const txBuilder = new TransactionBuilder({ provider });

        const resolverPk = await wallet.getPublicKey();

        // Input 0: Covenant UTXO
        txBuilder.addInput(utxo, contract.unlock.fill(resolverPk, sigTemplate));

        // Input 1: Exactly ONE solver UTXO (contract requires tx.inputs.length == 2)
        txBuilder.addInput(solverUtxo, sigTemplate.unlockP2PKH());

        // Calculate Dutch Auction price — auction started 30 days ago, so it's fully decayed
        // clampedElapsed = min(elapsed, duration) → duration, so price = endBuyAmount
        const currentPrice = endBuyAmount;
        console.log(`Current price (fully decayed): ${currentPrice} sats`);

        // Use a locktime safely in the past but after startTime + duration
        const currentLocktime = fakeNow + Number(duration) + 60;

        // Output 0: Pay maker >= currentPrice
        txBuilder.addOutput({ to: userAddr, amount: currentPrice });

        // Output 1: Resolver gets sell tokens
        const resolverPkBytes = typeof resolverPk === 'string' ? Buffer.from(resolverPk, 'hex') : resolverPk;
        const sha256Hash = createHash('sha256').update(resolverPkBytes).digest();
        const ripemd160Hash = createHash('ripemd160').update(sha256Hash).digest();
        const p2pkhLockingBytecode = new Uint8Array([ 0x76, 0xa9, 0x14, ...ripemd160Hash, 0x88, 0xac ]);

        txBuilder.addOutput({
            to: p2pkhLockingBytecode,
            amount: 1000n,
            token: { amount: fundAmount, category: categoryId },
        });

        // Output 2: Frontend Fee
        txBuilder.addOutput({ to: userAddr, amount: feeAmount });

        // Output 3: Change
        const totalInput = utxo.satoshis + solverUtxo.satoshis;
        const totalOutput = currentPrice + feeAmount + 1000n;
        const fee = 1000n;
        const change = totalInput - totalOutput - fee;
        if (change > 546n) {
            txBuilder.addOutput({ to: userAddr, amount: change });
        }

        txBuilder.setLocktime(currentLocktime);
        const tx = await txBuilder.send();

        console.log(`\n✅ Dutch Auction (With Fee) Complete!`);
        console.log(`Explorer: https://chipnet.chaingraph.cash/tx/${tx.txid}`);

    } catch (e: any) {
        console.error("Fill failed! Reason:", e.message || e);
    }
}

main().catch(console.error);
