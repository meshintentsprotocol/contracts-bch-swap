/** Buy from the graduated locked BCH fee bin. Dry run unless --broadcast. */
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
function address(script: string, tokenSupport: boolean) {
  const decoded = lockingBytecodeToCashAddress({ bytecode: hexToBin(script),
    prefix: 'bchtest', tokenSupport });
  if (typeof decoded === 'string') throw new Error(decoded);
  return decoded.address;
}
async function main() {
  if (existsSync(`${ROOT}market-buy.json`)) throw new Error('market buy record already exists');
  const big = new Set(['amount', 'satoshis', 'totalSupply', 'virtualBase', 'virtualQuote',
    'graduationQuoteThreshold', 'quoteVaultCarrierSats', 'collectorCarrierSats',
    'bidNum', 'bidDen', 'askNum', 'askDen']);
  const saved = JSON.parse(readFileSync(`${ROOT}genesis-plan.json`, 'utf8'), (key, value) =>
    big.has(key) && typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : value);
  const graduation = JSON.parse(readFileSync(`${ROOT}graduation.json`, 'utf8'));
  if (!graduation.sent) throw new Error('graduation was not broadcast');
  const provider = new ElectrumNetworkProvider('chipnet');
  const signer = signerFor(saved.funderAddress);
  const m = saved.manifest as LaunchManifestV1;
  const market = saved.market as BchMarketTermsV1;
  const linked = bchGraduationCurveFromManifestV1(m, market, saved.terms as BchGraduationTermsV2,
    artifact('MeshBlazeBchCurveV2Prototype'), artifact('MeshBlazeBchFeeBinLockedV1'),
    artifact('MeshBlazeBchFeeCollectorV1'), artifact('MeshBlazeBchFeeBinOwnedV1'),
    artifact('MeshBlazeStateArchiveV1'), provider);
  const collectors = [linked.market.creatorCollector, linked.market.partnerCollector,
    linked.market.protocolCollector] as [Contract, Contract, Contract];
  const [binUtxos, collectorUtxos, walletUtxos] = await Promise.all([
    provider.getUtxos(address(linked.market.bin.lockingBytecode, true)),
    provider.getUtxos(address(collectors[0].lockingBytecode, false)),
    provider.getUtxos(saved.funderAddress)]);
  const bin = binUtxos.find((utxo) => utxo.txid === graduation.txid && utxo.vout === 0 &&
    utxo.token?.category === m.tokenCategory);
  const collectorInputs = collectors.map((_collector, index) => collectorUtxos.find((utxo) =>
    utxo.txid === graduation.txid && utxo.vout === index + 3 && !utxo.token));
  const buyer = walletUtxos.find((utxo) => utxo.txid === graduation.txid && utxo.vout === 6 && !utxo.token);
  if (!bin || collectorInputs.some((utxo) => !utxo) || !buyer)
    throw new Error('graduated bin, collector or sponsor successor is unavailable');
  const walletLock = cashAddressToLockingBytecode(saved.funderAddress);
  if (typeof walletLock === 'string') throw new Error(walletLock);
  const baseOut = 10_000n;
  if (bin.token!.amount <= baseOut) throw new Error('locked bin lacks FT inventory');
  const quote = (baseOut * market.askNum + market.askDen - 1n) / market.askDen;
  const fee = (quote * BigInt(market.tradingFeeBps) + 9_999n) / 10_000n;
  const lpFee = fee * BigInt(10_000 - m.marketFees.creator.bps - m.marketFees.partner.bps - m.marketFees.protocol.bps) / 10_000n;
  const cFee = fee * BigInt(m.marketFees.creator.bps) / 10_000n;
  const pFee = fee * BigInt(m.marketFees.partner.bps) / 10_000n;
  const rFee = fee - lpFee - cFee - pFee;
  if (cFee <= 0n || pFee <= 0n || rFee <= 0n) throw new Error('all market fee roles must accrue');
  const binDelta = quote + lpFee;
  const change = buyer.satoshis - binDelta - cFee - pFee - rFee - 1_000n - 4_000n;
  if (change < 546n) throw new Error('buyer change below dust');
  const builder = new TransactionBuilder({ provider });
  builder.addInput({ ...bin, lockingBytecode: linked.market.bin.lockingBytecode },
    (linked.market.bin.unlock as any).buy());
  for (let i = 0; i < collectors.length; i++) builder.addInput({ ...collectorInputs[i]!,
    lockingBytecode: collectors[i]!.lockingBytecode }, (collectors[i]!.unlock as any).accrue());
  builder.addInput({ ...buyer, lockingBytecode: binToHex(walletLock.bytecode) }, signer.unlockP2PKH());
  builder.addOutput({ to: hexToBin(linked.market.bin.lockingBytecode), amount: bin.satoshis + binDelta,
    token: { category: m.tokenCategory, amount: bin.token!.amount - baseOut } });
  for (let i = 0; i < collectors.length; i++) builder.addOutput({
    to: hexToBin(collectors[i]!.lockingBytecode),
    amount: collectorInputs[i]!.satoshis + [cFee, pFee, rFee][i]!,
  });
  builder.addOutput({ to: walletLock.bytecode, amount: 1_000n,
    token: { category: m.tokenCategory, amount: baseOut } });
  builder.addOutput({ to: walletLock.bytecode, amount: change });
  const transaction = (builder as any).buildLibauthTransaction(true) as Transaction;
  const sourceOutputs = generateLibauthSourceOutputs((builder as any).inputs) as Output[];
  const verified = createVirtualMachineBch2026(true).verify({ transaction, sourceOutputs });
  if (verified !== true) throw new Error(`market buy failed BCH VM: ${String(verified)}`);
  const hex = binToHex(encodeTransaction(transaction));
  const txid = hashTransaction(encodeTransaction(transaction));
  const size = hex.length / 2;
  if (size > 4_000) throw new Error('market buy fee below 1 sat/byte');
  const record = { txid, hex, size, feeSats: '4000', baseOut: baseOut.toString(),
    quoteSats: quote.toString(), collectorFeesSats: [cFee, pFee, rFee].map(String),
    buyerChangeSats: change.toString(), sent: false };
  console.log(JSON.stringify({ ...record, hex: '<saved locally only>' }));
  if (!process.argv.includes('--broadcast')) return;
  const sent = await provider.sendRawTransaction(hex);
  if (sent !== txid) throw new Error(`unexpected broadcast txid ${sent}`);
  record.sent = true;
  writeFileSync(`${ROOT}market-buy.json`, JSON.stringify(record, null, 2) + '\n');
  console.log(`market buy sent ${sent}`);
}
main().then(() => process.exit(0)).catch((error) => {
  console.error(`chipnet E1 market buy: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
