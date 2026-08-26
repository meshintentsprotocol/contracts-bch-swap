import { loadWallet } from './utils.js';

async function main() {
    const ctx = await loadWallet();
    const utxos = await ctx.provider.getUtxos(ctx.userAddr);
    console.log(`UTXOs at ${ctx.userAddr}:`, utxos.length);
    for (const u of utxos) {
        console.log(`  ${u.txid}:${u.vout} = ${u.satoshis} sats (token: ${u.token ? u.token.category : 'none'})`);
    }

    const tokenUtxos = await ctx.provider.getUtxos(ctx.tokenAddr);
    console.log(`UTXOs at ${ctx.tokenAddr}:`, tokenUtxos.length);
    for (const u of tokenUtxos) {
        console.log(`  ${u.txid}:${u.vout} = ${u.satoshis} sats (token: ${u.token ? u.token.category : 'none'})`);
    }
}
main().catch(console.error);
