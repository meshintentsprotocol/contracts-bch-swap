/** Claim the three E1 curve fee balances. Dry run first role unless --broadcast. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { binToHex, cashAddressToLockingBytecode, createVirtualMachineBch2026,
  decodePrivateKeyWif, encodeCashAddress, hash160, hexToBin,
  lockingBytecodeToCashAddress, secp256k1, type Output } from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate } from 'cashscript';
import { bchGraduationCurveFromManifestV1 } from '../src/graduation/bch-curve-v2.js';
import { planBchCurveClaimV1, type FeeRole } from '../src/curve/sell-claim-plan.js';
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
  const big = new Set(['amount', 'satoshis', 'totalSupply', 'virtualBase', 'virtualQuote',
    'graduationQuoteThreshold', 'quoteVaultCarrierSats', 'collectorCarrierSats',
    'bidNum', 'bidDen', 'askNum', 'askDen']);
  const saved = JSON.parse(readFileSync(`${ROOT}genesis-plan.json`, 'utf8'), (key, value) =>
    big.has(key) && typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : value);
  const terminal = JSON.parse(readFileSync(`${ROOT}terminal-buy.json`, 'utf8'));
  if (!terminal.sent) throw new Error('terminal buy was not broadcast');
  const progress: Array<{ role: FeeRole; txid: string; hex: string; size: number; amountSats: string }> =
    existsSync(`${ROOT}curve-fees.json`) ? JSON.parse(readFileSync(`${ROOT}curve-fees.json`, 'utf8')) : [];
  if (progress.length > 3 || progress.some((item, index) => item.role !== index))
    throw new Error('curve claim progress is out of order');
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
  const walletLock = cashAddressToLockingBytecode(saved.funderAddress);
  if (typeof walletLock === 'string') throw new Error(walletLock);
  for (let role = progress.length as FeeRole; role < 3; role++) {
    const previousTxid = progress.length ? progress.at(-1)!.txid : terminal.txid;
    const [curveUtxos, walletUtxos] = await Promise.all([
      provider.getUtxos(curveAddress.address), provider.getUtxos(saved.funderAddress)]);
    const curveUtxo = curveUtxos.find((utxo) => utxo.txid === previousTxid && utxo.vout === 0 &&
      utxo.token?.category === m.tokenCategory);
    const sponsor = walletUtxos.find((utxo) => utxo.txid === previousTxid && utxo.vout === 2 && !utxo.token);
    if (!curveUtxo || !sponsor) throw new Error(`claim role ${role}: expected curve or sponsor output unavailable`);
    const claim = planBchCurveClaimV1(m,
      { ...curveUtxo, lockingBytecode: linked.curve.lockingBytecode },
      { ...sponsor, lockingBytecode: binToHex(walletLock.bytecode) }, role as FeeRole,
      binToHex(walletLock.bytecode), 4_000n);
    const built = buildSignedBchCurveAction(provider, m, claim, linked.curve, signer, 'claim');
    const verified = createVirtualMachineBch2026(true).verify({ transaction: built.transaction,
      sourceOutputs: built.sourceOutputs as Output[] });
    if (verified !== true) throw new Error(`claim role ${role} failed BCH VM: ${String(verified)}`);
    const amountSats = claim.outputs[1].satoshis.toString();
    console.log(JSON.stringify({ role, txid: built.txid, size: built.size,
      feeSats: built.paidFee.toString(), amountSats, sent: false }));
    if (!process.argv.includes('--broadcast')) return;
    const sent = await provider.sendRawTransaction(built.hex);
    if (sent !== built.txid) throw new Error(`claim role ${role} returned unexpected txid ${sent}`);
    progress.push({ role: role as FeeRole, txid: sent, hex: built.hex, size: built.size, amountSats });
    writeFileSync(`${ROOT}curve-fees.json`, JSON.stringify(progress, null, 2) + '\n');
    console.log(`curve fee role ${role} sent ${sent}`);
  }
}
main().then(() => process.exit(0)).catch((error) => {
  console.error(`chipnet E1 curve claims: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
