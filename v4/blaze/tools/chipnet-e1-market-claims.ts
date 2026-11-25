/** Claim the three market fee balances with dust top-ups. Dry run first role unless --broadcast. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { binToHex, cashAddressToLockingBytecode, createVirtualMachineBch2026,
  decodePrivateKeyWif, encodeCashAddress, encodeTransaction, hash160,
  hashTransaction, hexToBin, lockingBytecodeToCashAddress, secp256k1,
  type Output, type Transaction } from '@bitauth/libauth';
import { Contract, ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import { generateLibauthSourceOutputs } from 'cashscript/dist/utils.js';
import { bchGraduationCurveFromManifestV1 } from '../src/graduation/bch-curve-v2.js';
import type { LaunchManifestV1 } from '../src/manifest/v1.js';
import type { BchMarketTermsV1 } from '../src/market/bch-market.js';
import type { BchGraduationTermsV2 } from '../src/graduation/bch-handoff.js';

const ROOT = 'data/chipnet/blaze-e1/';
const artifact = (name: string) => JSON.parse(readFileSync(`blaze/artifacts/${name}.json`, 'utf8'));
function signerFor(address: string) {
  const fallback = '../../BCHMesh/meshserver/.env';
  const text = existsSync(fallback) ? readFileSync(fallback, 'utf8') : '';
  const wif = process.env.CHIPNET_WIF ?? process.env.FUNDER_WIF ?? /^FUNDER_WIF=(.*)$/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (!wif) throw new Error('chipnet test funder WIF unavailable');
  const decoded = decodePrivateKeyWif(wif);
  if (typeof decoded === 'string') throw new Error('invalid chipnet WIF');
  const pub = secp256k1.derivePublicKeyCompressed(decoded.privateKey);
  if (typeof pub === 'string') throw new Error('invalid chipnet key');
  const derived = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: hash160(pub) }).address;
  if (derived !== address) throw new Error('configured signer does not own planned funder address');
  return new SignatureTemplate(wif);
}
async function main() {
  const big = new Set(['amount', 'satoshis', 'totalSupply', 'virtualBase', 'virtualQuote',
    'graduationQuoteThreshold', 'quoteVaultCarrierSats', 'collectorCarrierSats',
    'bidNum', 'bidDen', 'askNum', 'askDen']);
  const saved = JSON.parse(readFileSync(`${ROOT}genesis-plan.json`, 'utf8'), (key, value) =>
    big.has(key) && typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : value);
  const marketBuy = JSON.parse(readFileSync(`${ROOT}market-buy.json`, 'utf8'));
  if (!marketBuy.sent) throw new Error('market buy was not broadcast');
  const progress: Array<{ role: number; txid: string; hex: string; size: number; payoutSats: string }> =
    existsSync(`${ROOT}market-claims.json`) ? JSON.parse(readFileSync(`${ROOT}market-claims.json`, 'utf8')) : [];
  if (progress.length > 3 || progress.some((claim, index) => claim.role !== index))
    throw new Error('market claim progress is out of order');
  const provider = new ElectrumNetworkProvider('chipnet');
  const signer = signerFor(saved.funderAddress);
  const m = saved.manifest as LaunchManifestV1;
  const linked = bchGraduationCurveFromManifestV1(m, saved.market as BchMarketTermsV1,
    saved.terms as BchGraduationTermsV2, artifact('MeshBlazeBchCurveV2Prototype'),
    artifact('MeshBlazeBchFeeBinLockedV1'), artifact('MeshBlazeBchFeeCollectorV1'),
    artifact('MeshBlazeBchFeeBinOwnedV1'), artifact('MeshBlazeStateArchiveV1'), provider);
  const collectors = [linked.market.creatorCollector, linked.market.partnerCollector,
    linked.market.protocolCollector] as [Contract, Contract, Contract];
  const collectorAddress = lockingBytecodeToCashAddress({ bytecode: hexToBin(collectors[0].lockingBytecode),
    prefix: 'bchtest' });
  if (typeof collectorAddress === 'string') throw new Error(collectorAddress);
  const walletLock = cashAddressToLockingBytecode(saved.funderAddress);
  if (typeof walletLock === 'string') throw new Error(walletLock);
  for (let role = progress.length; role < 3; role++) {
    const sponsorTxid = progress.length ? progress.at(-1)!.txid : marketBuy.txid;
    const sponsorVout = progress.length ? 2 : 5;
    const [collectorUtxos, walletUtxos] = await Promise.all([
      provider.getUtxos(collectorAddress.address), provider.getUtxos(saved.funderAddress)]);
    const collector = collectors[role]!;
    const feeUtxo = collectorUtxos.find((utxo) => utxo.txid === marketBuy.txid &&
      utxo.vout === role + 1 && !utxo.token);
    const sponsor = walletUtxos.find((utxo) => utxo.txid === sponsorTxid &&
      utxo.vout === sponsorVout && !utxo.token);
    if (!feeUtxo || !sponsor) throw new Error(`market claim ${role}: collector or sponsor unavailable`);
    const accrued = feeUtxo.satoshis - 1_000n;
    if (accrued <= 0n || accrued >= 546n) throw new Error('expected a positive dust-sized market fee');
    const topUp = 546n - accrued;
    const change = sponsor.satoshis - topUp - 4_000n;
    if (change < 546n) throw new Error('market claim sponsor change below dust');
    const builder = new TransactionBuilder({ provider });
    builder.addInput({ ...feeUtxo, lockingBytecode: collector.lockingBytecode },
      (collector.unlock as any).claim());
    builder.addInput({ ...sponsor, lockingBytecode: binToHex(walletLock.bytecode) },
      signer.unlockP2PKH());
    builder.addOutput({ to: hexToBin(collector.lockingBytecode), amount: 1_000n });
    builder.addOutput({ to: walletLock.bytecode, amount: 546n });
    builder.addOutput({ to: walletLock.bytecode, amount: change });
    const transaction = (builder as any).buildLibauthTransaction(true) as Transaction;
    const sourceOutputs = generateLibauthSourceOutputs((builder as any).inputs) as Output[];
    const verified = createVirtualMachineBch2026(true).verify({ transaction, sourceOutputs });
    if (verified !== true) throw new Error(`market claim ${role} failed BCH VM: ${String(verified)}`);
    const hex = binToHex(encodeTransaction(transaction));
    const txid = hashTransaction(encodeTransaction(transaction));
    const size = hex.length / 2;
    if (size > 4_000) throw new Error('market claim fee below 1 sat/byte');
    console.log(JSON.stringify({ role, txid, size, accruedSats: accrued.toString(),
      payoutSats: '546', sponsorTopUpSats: topUp.toString(), sent: false }));
    if (!process.argv.includes('--broadcast')) return;
    const sent = await provider.sendRawTransaction(hex);
    if (sent !== txid) throw new Error(`market claim ${role} returned unexpected txid ${sent}`);
    progress.push({ role, txid: sent, hex, size, payoutSats: '546' });
    writeFileSync(`${ROOT}market-claims.json`, JSON.stringify(progress, null, 2) + '\n');
    console.log(`market fee role ${role} sent ${sent}`);
  }
}
main().then(() => process.exit(0)).catch((error) => {
  console.error(`chipnet E1 market claims: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
