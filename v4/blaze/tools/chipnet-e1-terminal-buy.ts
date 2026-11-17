/** Complete the chipnet E1 curve with a partial-fill buy. Dry run unless --broadcast. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { binToHex, cashAddressToLockingBytecode, createVirtualMachineBch2026,
  decodePrivateKeyWif, encodeCashAddress, hash160, hexToBin,
  lockingBytecodeToCashAddress, secp256k1, type Output } from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate } from 'cashscript';
import { bchGraduationCurveFromManifestV1 } from '../src/graduation/bch-curve-v2.js';
import { planBchCurveBuyV1 } from '../src/curve/buy-plan.js';
import { buildSignedBchCurveAction } from '../src/curve/bch-signed-trades.js';
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
  if (existsSync(`${ROOT}terminal-buy.json`)) throw new Error('terminal buy record already exists');
  const big = new Set(['amount', 'satoshis', 'totalSupply', 'virtualBase', 'virtualQuote',
    'graduationQuoteThreshold', 'quoteVaultCarrierSats', 'collectorCarrierSats',
    'bidNum', 'bidDen', 'askNum', 'askDen']);
  const saved = JSON.parse(readFileSync(`${ROOT}genesis-plan.json`, 'utf8'), (key, value) =>
    big.has(key) && typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : value);
  const sold = JSON.parse(readFileSync(`${ROOT}sell.json`, 'utf8'));
  if (!sold.sent) throw new Error('opening sell was not broadcast');
  const provider = new ElectrumNetworkProvider('chipnet');
  const signer = signerFor(saved.funderAddress);
  const m = saved.manifest as LaunchManifestV1;
  const linked = bchGraduationCurveFromManifestV1(m, saved.market as BchMarketTermsV1,
    saved.terms as BchGraduationTermsV2, artifact('MeshBlazeBchCurveV2Prototype'),
    artifact('MeshBlazeBchFeeBinLockedV1'), artifact('MeshBlazeBchFeeCollectorV1'),
    artifact('MeshBlazeBchFeeBinOwnedV1'), artifact('MeshBlazeStateArchiveV1'), provider);
  const curveAddress = lockingBytecodeToCashAddress({ bytecode: hexToBin(linked.curve.lockingBytecode),
    prefix: 'bchtest', tokenSupport: true });
  if (typeof curveAddress === 'string') throw new Error(curveAddress);
  const [curveUtxos, walletUtxos] = await Promise.all([
    provider.getUtxos(curveAddress.address), provider.getUtxos(saved.funderAddress)]);
  const curveUtxo = curveUtxos.find((utxo) => utxo.txid === sold.txid && utxo.vout === 0 &&
    utxo.token?.category === m.tokenCategory);
  if (!curveUtxo) throw new Error('sell curve successor is not unspent');
  const buyer = walletUtxos.filter((utxo) => !utxo.token && utxo.satoshis >= 600_000n)
    .sort((a, b) => a.satoshis < b.satoshis ? -1 : a.satoshis > b.satoshis ? 1 : 0)[0];
  if (!buyer) throw new Error('no BCH-only buyer UTXO above 600000 sats');
  const walletLock = cashAddressToLockingBytecode(saved.funderAddress);
  if (typeof walletLock === 'string') throw new Error(walletLock);
  const sourceCurve = { ...curveUtxo, lockingBytecode: linked.curve.lockingBytecode };
  const buyerInput = { ...buyer, lockingBytecode: binToHex(walletLock.bytecode) };
  const buy = planBchCurveBuyV1(m, sourceCurve, buyerInput, 800_000n, 4_000n, 1n);
  if (!buy.quote.complete || buy.quote.next.state.realQuote !== m.graduationQuoteThreshold ||
      buy.quote.refund <= 0n) throw new Error('buy does not partially fill to exact threshold');
  const built = buildSignedBchCurveAction(provider, m, buy, linked.curve, signer, 'buy');
  const verified = createVirtualMachineBch2026(true).verify({ transaction: built.transaction,
    sourceOutputs: built.sourceOutputs as Output[] });
  if (verified !== true) throw new Error(`terminal buy failed BCH VM: ${String(verified)}`);
  const record = { txid: built.txid, hex: built.hex, size: built.size,
    feeSats: built.paidFee.toString(), curveSource: `${curveUtxo.txid}:${curveUtxo.vout}`,
    buyerSource: `${buyer.txid}:${buyer.vout}`, baseOut: buy.quote.baseOut.toString(),
    usedGrossSats: buy.quote.usedGross.toString(), maxGrossSats: '800000',
    refundSats: buy.quote.refund.toString(), nextQuoteSats: buy.quote.next.state.realQuote.toString(),
    buyerChangeSats: buy.outputs[2].satoshis.toString(), sent: false };
  console.log(JSON.stringify({ ...record, hex: '<saved locally only>' }));
  if (!process.argv.includes('--broadcast')) return;
  const sent = await provider.sendRawTransaction(built.hex);
  if (sent !== built.txid) throw new Error(`unexpected broadcast txid ${sent}`);
  record.sent = true;
  writeFileSync(`${ROOT}terminal-buy.json`, JSON.stringify(record, null, 2) + '\n');
  console.log(`terminal buy sent ${sent}`);
}
main().then(() => process.exit(0)).catch((error) => {
  console.error(`chipnet E1 terminal buy: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
