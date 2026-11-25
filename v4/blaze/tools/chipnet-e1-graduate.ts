/** Graduate the completed BCH E1 curve. Dry run unless --broadcast. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { binToHex, cashAddressToLockingBytecode, createVirtualMachineBch2026,
  decodePrivateKeyWif, encodeCashAddress, hash160, hexToBin,
  lockingBytecodeToCashAddress, secp256k1, type Output } from '@bitauth/libauth';
import { ElectrumNetworkProvider, SignatureTemplate } from 'cashscript';
import { bchGraduationCurveFromManifestV1 } from '../src/graduation/bch-curve-v2.js';
import { bchGraduationTermsHashV2, planBchGraduationV2,
  type BchGraduationTermsV2 } from '../src/graduation/bch-handoff.js';
import { buildSignedBchGraduationV2 } from '../src/graduation/bch-signed-handoff.js';
import { checkTerminalPrice } from '../src/graduation/price-continuity.js';
import type { LaunchManifestV1 } from '../src/manifest/v1.js';
import type { BchMarketTermsV1 } from '../src/market/bch-market.js';

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
  if (existsSync(`${ROOT}graduation.json`)) throw new Error('graduation record already exists');
  const big = new Set(['amount', 'satoshis', 'totalSupply', 'virtualBase', 'virtualQuote',
    'graduationQuoteThreshold', 'quoteVaultCarrierSats', 'collectorCarrierSats',
    'bidNum', 'bidDen', 'askNum', 'askDen']);
  const saved = JSON.parse(readFileSync(`${ROOT}genesis-plan.json`, 'utf8'), (key, value) =>
    big.has(key) && typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : value);
  const claims = JSON.parse(readFileSync(`${ROOT}curve-fees.json`, 'utf8'));
  if (claims.length !== 3 || claims.some((claim: any, index: number) => claim.role !== index))
    throw new Error('all three curve fees must be claimed in order');
  const previousTxid = claims[2].txid as string;
  const provider = new ElectrumNetworkProvider('chipnet');
  const signer = signerFor(saved.funderAddress);
  const m = saved.manifest as LaunchManifestV1;
  const t = saved.terms as BchGraduationTermsV2;
  const market = saved.market as BchMarketTermsV1;
  if (bchGraduationTermsHashV2(t) !== saved.graduationTermsHash)
    throw new Error('graduation terms differ from the launch plan');
  const linked = bchGraduationCurveFromManifestV1(m, market, t,
    artifact('MeshBlazeBchCurveV2Prototype'), artifact('MeshBlazeBchFeeBinLockedV1'),
    artifact('MeshBlazeBchFeeCollectorV1'), artifact('MeshBlazeBchFeeBinOwnedV1'),
    artifact('MeshBlazeStateArchiveV1'), provider);
  const curveAddress = lockingBytecodeToCashAddress({ bytecode: hexToBin(linked.curve.lockingBytecode),
    prefix: 'bchtest', tokenSupport: true });
  if (typeof curveAddress === 'string') throw new Error(curveAddress);
  const [curveUtxos, walletUtxos] = await Promise.all([
    provider.getUtxos(curveAddress.address), provider.getUtxos(saved.funderAddress)]);
  const curveUtxo = curveUtxos.find((utxo) => utxo.txid === previousTxid && utxo.vout === 0 &&
    utxo.token?.category === m.tokenCategory);
  const sponsor = walletUtxos.find((utxo) => utxo.txid === previousTxid && utxo.vout === 2 && !utxo.token);
  if (!curveUtxo || !sponsor) throw new Error('final curve claim successor or sponsor output unavailable');
  checkTerminalPrice(m, market, curveUtxo.token!.amount);
  const walletLock = cashAddressToLockingBytecode(saved.funderAddress);
  if (typeof walletLock === 'string') throw new Error(walletLock);
  const plan = planBchGraduationV2(m,
    { ...curveUtxo, lockingBytecode: linked.curve.lockingBytecode },
    { ...sponsor, lockingBytecode: binToHex(walletLock.bytecode) },
    t, saved.graduationTermsHash, 4_000n);
  const built = buildSignedBchGraduationV2(provider, m, plan, linked.curve, signer);
  const verified = createVirtualMachineBch2026(true).verify({ transaction: built.transaction,
    sourceOutputs: built.sourceOutputs as Output[] });
  if (verified !== true) throw new Error(`graduation failed BCH VM: ${String(verified)}`);
  const record = { txid: built.txid, hex: built.hex, size: built.size,
    feeSats: built.paidFee.toString(), curveSource: `${curveUtxo.txid}:${curveUtxo.vout}`,
    sponsorSource: `${sponsor.txid}:${sponsor.vout}`, lockedBase: plan.split.lockedBase.toString(),
    lockedQuoteSats: plan.split.lockedQuote.toString(), creatorBase: plan.split.creatorBase.toString(),
    creatorQuoteSats: plan.split.creatorQuote.toString(), sent: false };
  console.log(JSON.stringify({ ...record, hex: '<saved locally only>' }));
  if (!process.argv.includes('--broadcast')) return;
  const sent = await provider.sendRawTransaction(built.hex);
  if (sent !== built.txid) throw new Error(`unexpected broadcast txid ${sent}`);
  record.sent = true;
  writeFileSync(`${ROOT}graduation.json`, JSON.stringify(record, null, 2) + '\n');
  console.log(`graduation sent ${sent}`);
}
main().then(() => process.exit(0)).catch((error) => {
  console.error(`chipnet E1 graduation: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
