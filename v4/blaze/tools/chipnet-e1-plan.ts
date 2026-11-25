/** Signed, offline chipnet E1 genesis plan. Never broadcasts. Run from v4/. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { binToHex, createVirtualMachineBch2026, decodePrivateKeyWif, encodeCashAddress,
  hash160, hexToBin, secp256k1, sha256, type Output, type Transaction } from '@bitauth/libauth';
import { Contract, ElectrumNetworkProvider, SignatureTemplate } from 'cashscript';
import { encodeCommitment } from '../../test/position.js';
import { planSeed, planFixedSupplyGenesis, type FundingCoin } from '../src/genesis/plan.js';
import { planCreatorPositionGenesis } from '../src/graduation/position-genesis.js';
import { bchGraduationTermsHashV2, type BchGraduationTermsV2 } from '../src/graduation/bch-handoff.js';
import { verifyBchLaunchBundleV1, verifyBchLaunchGenesisCommitmentV1 } from '../src/graduation/launch-bundle.js';
import { launchManifestHashV1, verifyGenesisAgainstManifestV1, type LaunchManifestV1 } from '../src/manifest/v1.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';
import type { BchMarketTermsV1 } from '../src/market/bch-market.js';

const OUT = join('data', 'chipnet', 'blaze-e1', 'genesis-plan.json');
const ZERO = '00'.repeat(32);
const vm = createVirtualMachineBch2026(true);
const artifact = (name: string) => JSON.parse(readFileSync(join('blaze', 'artifacts', `${name}.json`), 'utf8'));
const hash = (script: string) => binToHex(sha256.hash(hexToBin(script)));
function le(value: bigint, bytes: number): string {
  if (value < 0n || value >= 1n << BigInt(bytes * 8)) throw new Error('constructor value outside byte range');
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) out[i] = Number((value >> BigInt(8 * i)) & 255n);
  return `0x${binToHex(out)}`;
}
function verifyVm(name: string, transaction: Transaction, sourceOutputs: readonly Output[]) {
  const result = vm.verify({ transaction, sourceOutputs: [...sourceOutputs] });
  if (result !== true) throw new Error(`${name} failed BCH VM: ${String(result)}`);
}
function funder() {
  const fallback = join(process.cwd(), '..', '..', 'BCHMesh', 'meshserver', '.env');
  const text = existsSync(fallback) ? readFileSync(fallback, 'utf8') : '';
  const wif = process.env.CHIPNET_WIF ?? process.env.FUNDER_WIF ?? /^FUNDER_WIF=(.*)$/m.exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (!wif) throw new Error('set CHIPNET_WIF or FUNDER_WIF for the offline signing plan');
  const decoded = decodePrivateKeyWif(wif);
  if (typeof decoded === 'string') throw new Error('invalid funder WIF');
  const pub = secp256k1.derivePublicKeyCompressed(decoded.privateKey);
  if (typeof pub === 'string') throw new Error('invalid funder key');
  const pkh = hash160(pub);
  const script = binToHex(Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]));
  const address = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address;
  return { signer: new SignatureTemplate(wif), script, address };
}

async function main() {
  if (existsSync(OUT)) throw new Error(`plan already exists at ${OUT}; review it before creating another`);
  const provider = new ElectrumNetworkProvider('chipnet');
  const wallet = funder();
  const [height, all] = await Promise.all([provider.getBlockHeight(), provider.getUtxos(wallet.address)]);
  const coins = all.filter((utxo) => !utxo.token).sort((a, b) =>
    a.satoshis === b.satoshis ? 0 : a.satoshis > b.satoshis ? -1 : 1);
  if (coins.length < 2 || coins[0]!.satoshis < 1_000_000n || coins[1]!.satoshis < 10_000n)
    throw new Error('need separate BCH-only UTXOs for launch and position seeds');
  const source = (utxo: typeof coins[number]): FundingCoin => ({ txid: utxo.txid, vout: utxo.vout,
    satoshis: utxo.satoshis, lockingBytecode: wallet.script });
  const launchSeed = planSeed(provider, source(coins[0]!), wallet.signer, 1_000n);
  const positionSeed = planSeed(provider, source(coins[1]!), wallet.signer, 1_000n);
  verifyVm('launch seed', launchSeed.transaction, launchSeed.sourceOutputs);
  verifyVm('position seed', positionSeed.transaction, positionSeed.sourceOutputs);
  const positionCommitment = encodeCommitment({ version: 1, shape: 'custom', variant: 'default',
    tokenCat: launchSeed.category, binStepBps: 100, lowIndex: 0, highIndex: 0,
    binCount: 1, managerHash: ZERO, createdHeight: height });
  const position = planCreatorPositionGenesis(provider, positionSeed, wallet.signer,
    wallet.script, positionCommitment, 1_000n, wallet.script);
  verifyVm('creator position genesis', position.transaction, position.sourceOutputs);

  const COLLECTOR = artifact('MeshBlazeBchFeeCollectorV1');
  const BIN = artifact('MeshBlazeBchFeeBinLockedV1');
  const OWNED = artifact('MeshBlazeBchFeeBinOwnedV1');
  const ARCHIVE = artifact('MeshBlazeStateArchiveV1');
  const CURVE = artifact('MeshBlazeBchCurveV2Prototype');
  // E1 lab setup: all three disclosed fee roles use the test funder's script.
  const recipientHash = hash(wallet.script);
  const collectors = [0, 1, 2].map(() => new Contract(COLLECTOR,
    [`0x${recipientHash}`, le(1_000n, 8)], { provider, contractType: 'p2sh32' }));
  const tokenVm = `0x${binToHex(hexToBin(launchSeed.category).reverse())}`;
  const market: BchMarketTermsV1 = { bidNum: 2n, bidDen: 1n, askNum: 21n, askDen: 10n,
    tradingFeeBps: 30, collectorCarrierSats: 1_000n };
  const price = [le(market.bidNum, 8), le(market.bidDen, 8),
    le(market.askNum, 8), le(market.askDen, 8)];
  const fees = [...collectors.map((collector) => `0x${hash(collector.lockingBytecode)}`),
    le(30n, 2), le(800n, 2), le(200n, 2), le(1_000n, 2)];
  const locked = new Contract(BIN, [tokenVm, ...price, ...fees], { provider, contractType: 'p2sh32' });
  const owned = new Contract(OWNED, [tokenVm,
    `0x${binToHex(hexToBin(position.category).reverse())}`, ...price, ...fees],
    { provider, contractType: 'p2sh32' });
  const archive = new Contract(ARCHIVE, [], { provider, contractType: 'p2sh32' });
  const terms: BchGraduationTermsV2 = { lockedBinScript: locked.lockingBytecode,
    creatorBinScript: owned.lockingBytecode, stateArchiveScript: archive.lockingBytecode,
    creatorPositionCategory: position.category, lockedBps: 9_000,
    collectorScripts: [collectors[0]!.lockingBytecode, collectors[1]!.lockingBytecode,
      collectors[2]!.lockingBytecode], collectorCarrierSats: 1_000n };
  const curve = new Contract(CURVE, [tokenVm, le(100_000n, 8), le(1_000_000n, 8),
    le(500_003n, 8), le(1_000n, 8), le(50n, 2), le(25n, 2), le(25n, 2),
    `0x${recipientHash}`, `0x${recipientHash}`, `0x${recipientHash}`,
    `0x${hash(locked.lockingBytecode)}`, `0x${hash(owned.lockingBytecode)}`,
    `0x${hash(archive.lockingBytecode)}`, le(9_000n, 2),
    ...collectors.map((collector) => `0x${hash(collector.lockingBytecode)}`),
    le(1_000n, 8), ...price], { provider, contractType: 'p2sh32' });
  const curveRights = { creator: { scriptHash: recipientHash, bps: 50 },
    partner: { scriptHash: recipientHash, bps: 25 },
    protocol: { scriptHash: recipientHash, bps: 25 } };
  const marketRights = { creator: { scriptHash: recipientHash, bps: 800 },
    partner: { scriptHash: recipientHash, bps: 200 },
    protocol: { scriptHash: recipientHash, bps: 1_000 } };
  const manifest: LaunchManifestV1 = {
    version: 1, tokenCategory: launchSeed.category, quoteCategory: null, totalSupply: 1_000_000n,
    allocations: [{ name: 'curve', amount: 1_000_000n, satoshis: 1_000n,
      lockingBytecode: curve.lockingBytecode, nftCommitment: encodeCurveStateV1({ stage: 0,
        realQuote: 0n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n }) }],
    activationHeight: height + 1, alphaStartHeight: 0, alphaEndHeight: 0,
    presaleRoute: null, presaleScriptHash: ZERO, alphaModes: 0,
    alphaFixedScriptHash: ZERO, alphaBuyScriptHash: ZERO,
    virtualBase: 100_000n, virtualQuote: 1_000_000n,
    graduationQuoteThreshold: 500_003n, lockedLiquidityBps: 9_000,
    curveScriptHash: hash(curve.lockingBytecode), quoteVaultScriptHash: ZERO,
    quoteVaultCarrierSats: 0n, graduationScriptHash: hash(curve.lockingBytecode),
    marketScriptHash: hash(locked.lockingBytecode), curveFees: curveRights,
    marketFees: marketRights,
  };
  const artifacts = { curve: CURVE, lockedBin: BIN, ownedBin: OWNED,
    collector: COLLECTOR, archive: ARCHIVE };
  const bundleHash = verifyBchLaunchBundleV1(manifest, market, terms,
    position.transaction, position.sourceOutputs, wallet.script, positionCommitment,
    artifacts, provider);
  const manifestHash = launchManifestHashV1(manifest);
  const genesis = planFixedSupplyGenesis(provider, launchSeed, wallet.signer,
    manifest.totalSupply, manifest.allocations, 2_000n, wallet.script,
    undefined, manifestHash, 1, bundleHash);
  verifyVm('launch token genesis', genesis.transaction, genesis.sourceOutputs);
  verifyGenesisAgainstManifestV1(genesis, manifest);
  verifyBchLaunchGenesisCommitmentV1(genesis.transaction, bundleHash);
  const record = { network: 'chipnet', plannedAtHeight: height, funderAddress: wallet.address,
    sourceOutpoints: [coins[0]!, coins[1]!].map((coin) => `${coin.txid}:${coin.vout}`),
    tokenCategory: launchSeed.category, creatorPositionCategory: position.category,
    manifestHash, graduationTermsHash: bchGraduationTermsHashV2(terms), bundleHash,
    transactions: { positionSeed: { txid: positionSeed.category, hex: positionSeed.hex },
      positionGenesis: { txid: position.txid, hex: position.hex },
      launchSeed: { txid: launchSeed.category, hex: launchSeed.hex },
      launchGenesis: { txid: genesis.txid, hex: genesis.hex } },
    manifest, market, terms, positionCommitment,
    note: 'Offline signed plan only. All fee roles use the test funder. No BCMR URL or broadcast.' };
  mkdirSync(join('data', 'chipnet', 'blaze-e1'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(record, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
  console.log(`E1 genesis plan passed BCH VM; ${OUT}`);
  console.log(JSON.stringify({ tokenCategory: launchSeed.category,
    creatorPositionCategory: position.category, manifestHash, bundleHash,
    positionSeedBytes: positionSeed.size, positionGenesisBytes: position.size,
    launchSeedBytes: launchSeed.size, launchGenesisBytes: genesis.size }));
}
main().then(() => process.exit(0)).catch((error) => {
  console.error(`chipnet E1 plan: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
