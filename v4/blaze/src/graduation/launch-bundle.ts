import { binToHex, encodeTransaction, hashTransaction, hexToBin, sha256, utf8ToBin,
  type Output, type Transaction } from '@bitauth/libauth';
import type { Artifact, NetworkProvider } from 'cashscript';
import { launchManifestHashV1, type LaunchManifestV1 } from '../manifest/v1.js';
import type { BchMarketTermsV1 } from '../market/bch-market.js';
import { bchGraduationCurveFromManifestV1 } from './bch-curve-v2.js';
import { bchGraduationTermsHashV2, type BchGraduationTermsV2 } from './bch-handoff.js';
import { verifyCreatorPositionGenesis } from './position-genesis.js';

export interface BchLaunchBundleArtifactsV1 {
  curve: Artifact;
  lockedBin: Artifact;
  ownedBin: Artifact;
  collector: Artifact;
  archive: Artifact;
}

/** The token genesis must publish the verified bundle hash in exactly one MBLZ OP_RETURN. */
export function verifyBchLaunchGenesisCommitmentV1(genesis: Transaction, bundleHash: string): void {
  if (!/^[0-9a-f]{64}$/.test(bundleHash)) throw new Error('Mesh Blaze launch bundle: invalid bundle hash');
  const expected = `6a044d424c5a20${bundleHash}`;
  if (genesis.outputs.filter((out) => binToHex(out.lockingBytecode).startsWith('6a044d424c5a')).length > 1)
    throw new Error('Mesh Blaze launch bundle: duplicate MBLZ commitment');
  const matches = genesis.outputs.filter((out) => binToHex(out.lockingBytecode) === expected &&
    out.valueSatoshis === 0n && !out.token);
  if (matches.length !== 1) throw new Error('Mesh Blaze launch bundle: genesis lacks exact MBLZ commitment');
}

/** Read-only verification before a launch bundle hash is published or shown in a UI. */
export function verifyBchLaunchBundleV1(m: LaunchManifestV1, market: BchMarketTermsV1,
  graduation: BchGraduationTermsV2, positionGenesis: Transaction,
  positionGenesisSource: readonly Output[], creatorHolderScript: string,
  positionCommitment: string, artifacts: BchLaunchBundleArtifactsV1, provider: NetworkProvider): string {
  const positionCategory = graduation.creatorPositionCategory;
  verifyCreatorPositionGenesis(positionGenesis, positionGenesisSource, positionCategory,
    creatorHolderScript, positionCommitment);
  bchGraduationCurveFromManifestV1(m, market, graduation, artifacts.curve, artifacts.lockedBin,
    artifacts.collector, artifacts.ownedBin, artifacts.archive, provider);
  const manifestHash = launchManifestHashV1(m);
  const termsHash = bchGraduationTermsHashV2(graduation);
  const positionTxid = hashTransaction(encodeTransaction(positionGenesis));
  const holderHash = binToHex(sha256.hash(hexToBin(creatorHolderScript)));
  const commitmentHash = binToHex(sha256.hash(hexToBin(positionCommitment)));
  const parts = [utf8ToBin('MeshBlaze/BchLaunchBundle/v1\0'),
    ...[manifestHash, termsHash, positionTxid, holderHash, commitmentHash].map(hexToBin)];
  const bytes = Uint8Array.from(parts.flatMap((part) => [...part]));
  return binToHex(sha256.hash(bytes));
}
