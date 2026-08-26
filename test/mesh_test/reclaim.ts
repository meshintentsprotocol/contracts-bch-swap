import { loadWallet, loadArtifact, dockContract, reverseHex, TOKEN_A } from './utils.js';
import { Contract } from 'cashscript';

async function main() {
    const ctx = await loadWallet();
    const balance = await ctx.wallet.getBalance();
    console.log('Wallet BCH balance:', balance, 'satoshis');

    const artifact = loadArtifact('StrategyCovenant');
    const tokenCategoryInLE = '0x' + reverseHex(TOKEN_A);
    const contract = new Contract(artifact, [ctx.ownerPkhBytes, tokenCategoryInLE, '0x', 1n, 1n, 30n], { provider: ctx.provider });
    const utxos = await ctx.provider.getUtxos(contract.address);
    console.log('Open StrategyCovenant UTXOs:', utxos.length);
    for (const u of utxos) {
        console.log('Docking', u.txid, u.vout, u.satoshis);
        try {
            await dockContract(ctx, contract, u);
            console.log('Docked successfully!');
        } catch (e: any) {
            console.error('Dock error:', e.message);
        }
    }

    const newBalance = await ctx.wallet.getBalance();
    console.log('Updated wallet BCH balance:', newBalance, 'satoshis');
}

main().catch(console.error);
