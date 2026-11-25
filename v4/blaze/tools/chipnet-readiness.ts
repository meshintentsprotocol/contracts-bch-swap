/** Read-only chipnet wallet funding check. No signing, planning files or broadcast. */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decodePrivateKeyWif, encodeCashAddress, hash160, secp256k1 } from '@bitauth/libauth';
import { ElectrumNetworkProvider } from 'cashscript';

const TARGET = 1_000_000n;
function walletAddress(): string {
  const addressIndex = process.argv.indexOf('--address');
  if (addressIndex >= 0) {
    const address = process.argv[addressIndex + 1];
    if (!address?.startsWith('bchtest:')) throw new Error('expected a bchtest: chipnet address');
    return address;
  }
  const fallback = join(process.cwd(), '..', '..', 'BCHMesh', 'meshserver', '.env');
  const text = existsSync(fallback) ? readFileSync(fallback, 'utf8') : '';
  const wif = process.env.CHIPNET_WIF ?? process.env.FUNDER_WIF ?? /^FUNDER_WIF=(.*)$/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (!wif) throw new Error('set CHIPNET_WIF or FUNDER_WIF, or use --address bchtest:...');
  const decoded = decodePrivateKeyWif(wif);
  if (typeof decoded === 'string') throw new Error('invalid wallet WIF');
  const pub = secp256k1.derivePublicKeyCompressed(decoded.privateKey);
  if (typeof pub === 'string') throw new Error('invalid wallet key');
  return encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(pub) }).address;
}

async function main() {
  const address = walletAddress();
  const provider = new ElectrumNetworkProvider('chipnet');
  const [height, utxos] = await Promise.all([provider.getBlockHeight(), provider.getUtxos(address)]);
  const bch = utxos.filter((utxo) => !utxo.token);
  const spendable = bch.reduce((sum, utxo) => sum + utxo.satoshis, 0n);
  const largest = bch.reduce((max, utxo) => utxo.satoshis > max ? utxo.satoshis : max, 0n);
  const gap = spendable >= TARGET ? 0n : TARGET - spendable;
  console.log(JSON.stringify({ network: 'chipnet', height, address,
    bchOnlyUtxos: bch.length, tokenUtxos: utxos.length - bch.length,
    bchOnlySats: spendable.toString(), largestBchOnlyUtxoSats: largest.toString(),
    targetSats: TARGET.toString(), shortfallSats: gap.toString() }, null, 2));
}
main().then(() => process.exit(0)).catch((error) => {
  console.error(`chipnet readiness: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
