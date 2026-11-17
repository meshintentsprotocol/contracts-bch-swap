/** Recheck saved signed E1 genesis plan against current chipnet UTXOs. Read-only. */
import { readFileSync } from 'node:fs';
import { binToHex, cashAddressToLockingBytecode, createVirtualMachineBch2026,
  decodeTransaction, encodeTransaction, hashTransaction, hexToBin,
  type Output, type Transaction } from '@bitauth/libauth';
import { ElectrumNetworkProvider } from 'cashscript';
import { launchManifestHashV1, verifyGenesisAgainstManifestV1,
  type LaunchManifestV1 } from '../src/manifest/v1.js';
import { bchGraduationTermsHashV2, type BchGraduationTermsV2 } from '../src/graduation/bch-handoff.js';
import { verifyBchLaunchBundleV1, verifyBchLaunchGenesisCommitmentV1 } from '../src/graduation/launch-bundle.js';
import type { BchMarketTermsV1 } from '../src/market/bch-market.js';

const PLAN = 'data/chipnet/blaze-e1/genesis-plan.json';
const decode = (hex: string): Transaction => {
  const tx = decodeTransaction(hexToBin(hex));
  if (typeof tx === 'string') throw new Error(`invalid saved transaction: ${tx}`);
  return tx;
};
const vm = createVirtualMachineBch2026(true);
function checkVm(name: string, transaction: Transaction, sourceOutputs: Output[]) {
  const result = vm.verify({ transaction, sourceOutputs });
  if (result !== true) throw new Error(`${name} failed BCH VM: ${String(result)}`);
}
function artifact(name: string) {
  return JSON.parse(readFileSync(`blaze/artifacts/${name}.json`, 'utf8'));
}
async function main() {
  const bigInts = new Set(['amount', 'satoshis', 'totalSupply', 'virtualBase', 'virtualQuote',
    'graduationQuoteThreshold', 'quoteVaultCarrierSats', 'collectorCarrierSats',
    'bidNum', 'bidDen', 'askNum', 'askDen']);
  const plan = JSON.parse(readFileSync(PLAN, 'utf8'), (key, value) =>
    bigInts.has(key) && typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : value);
  if (plan.network !== 'chipnet' || plan.sourceOutpoints?.length !== 2)
    throw new Error('invalid E1 plan network or source outpoints');
  const provider = new ElectrumNetworkProvider('chipnet');
  const addressLock = cashAddressToLockingBytecode(plan.funderAddress);
  if (typeof addressLock === 'string') throw new Error('invalid funder address');
  const [height, all] = await Promise.all([provider.getBlockHeight(), provider.getUtxos(plan.funderAddress)]);
  const sources: Output[] = [];
  for (const outpoint of plan.sourceOutpoints as string[]) {
    const coin = all.find((utxo) => `${utxo.txid}:${utxo.vout}` === outpoint && !utxo.token);
    if (!coin) throw new Error(`planned BCH source already spent or unavailable: ${outpoint}`);
    sources.push({ lockingBytecode: addressLock.bytecode, valueSatoshis: coin.satoshis });
  }
  const txs = plan.transactions;
  const positionSeed = decode(txs.positionSeed.hex);
  const positionGenesis = decode(txs.positionGenesis.hex);
  const launchSeed = decode(txs.launchSeed.hex);
  const launchGenesis = decode(txs.launchGenesis.hex);
  for (const [name, tx] of [['positionSeed', positionSeed], ['positionGenesis', positionGenesis],
    ['launchSeed', launchSeed], ['launchGenesis', launchGenesis]] as const) {
    if (hashTransaction(encodeTransaction(tx)) !== txs[name].txid)
      throw new Error(`${name} txid differs from saved plan`);
  }
  if (plan.creatorPositionCategory !== txs.positionSeed.txid ||
      plan.tokenCategory !== txs.launchSeed.txid)
    throw new Error('CashToken categories differ from seed txids');
  checkVm('position seed', positionSeed, [sources[1]!]);
  checkVm('launch seed', launchSeed, [sources[0]!]);
  checkVm('position genesis', positionGenesis, [positionSeed.outputs[0]!]);
  checkVm('launch genesis', launchGenesis, [launchSeed.outputs[0]!]);
  const m = plan.manifest as LaunchManifestV1;
  const t = plan.terms as BchGraduationTermsV2;
  const market = plan.market as BchMarketTermsV1;
  if (launchManifestHashV1(m) !== plan.manifestHash ||
      bchGraduationTermsHashV2(t) !== plan.graduationTermsHash)
    throw new Error('manifest or graduation terms hash differs');
  const bundleHash = verifyBchLaunchBundleV1(m, market, t, positionGenesis,
    [positionSeed.outputs[0]!], binToHex(addressLock.bytecode), plan.positionCommitment,
    { curve: artifact('MeshBlazeBchCurveV2Prototype'), lockedBin: artifact('MeshBlazeBchFeeBinLockedV1'),
      ownedBin: artifact('MeshBlazeBchFeeBinOwnedV1'), collector: artifact('MeshBlazeBchFeeCollectorV1'),
      archive: artifact('MeshBlazeStateArchiveV1') }, provider);
  if (bundleHash !== plan.bundleHash) throw new Error('launch bundle hash differs');
  verifyGenesisAgainstManifestV1({ transaction: launchGenesis, hex: txs.launchGenesis.hex,
    size: txs.launchGenesis.hex.length / 2, txid: txs.launchGenesis.txid,
    category: plan.tokenCategory, manifestHash: plan.manifestHash, bundleHash,
    paidFee: launchSeed.outputs[0]!.valueSatoshis -
      launchGenesis.outputs.reduce((sum, out) => sum + out.valueSatoshis, 0n),
    allocationIndexes: { curve: 0 }, sourceOutputs: [launchSeed.outputs[0]!] }, m);
  verifyBchLaunchGenesisCommitmentV1(launchGenesis, bundleHash);
  console.log(JSON.stringify({ status: 'READY_OFFLINE_ONLY', height,
    sourceOutpoints: plan.sourceOutpoints, tokenCategory: plan.tokenCategory,
    creatorPositionCategory: plan.creatorPositionCategory, manifestHash: plan.manifestHash,
    bundleHash, signedTransactionsVmValid: 4 }));
}
main().then(() => process.exit(0)).catch((error) => {
  console.error(`chipnet E1 check: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
