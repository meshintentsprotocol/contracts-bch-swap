import { binToHex, encodeTransaction, hashTransaction, hexToBin, sha256, utf8ToBin,
  type Output, type Transaction } from '@bitauth/libauth';
import type { NetworkProvider } from 'cashscript';
import { launchManifestHashV1, type LaunchManifestV1 } from '../manifest/v1.js';
import { verifyCreatorPositionGenesis } from './position-genesis.js';
import { tokenPairGraduationTermsHashV1, type TokenPairGraduationTermsV1 } from './token-pair-handoff.js';
import { tokenPairV2FromManifest, type TokenMarketTermsV1, type TokenPairV2Artifacts } from './token-pair-v2.js';

/** Check the full E2 artifact graph and the unique creator-position NFT before MBND publication. */
export function verifyTokenPairLaunchBundleV1(m: LaunchManifestV1, market: TokenMarketTermsV1,
  terms: TokenPairGraduationTermsV1, positionGenesis: Transaction,
  positionGenesisSource: readonly Output[], creatorHolderScript: string,
  positionCommitment: string, artifacts: TokenPairV2Artifacts,
  provider: NetworkProvider): string {
  verifyCreatorPositionGenesis(positionGenesis, positionGenesisSource,
    terms.creatorPositionCategory, creatorHolderScript, positionCommitment);
  tokenPairV2FromManifest(m, market, terms, artifacts, provider);
  const fields = [launchManifestHashV1(m), tokenPairGraduationTermsHashV1(terms),
    hashTransaction(encodeTransaction(positionGenesis)),
    binToHex(sha256.hash(hexToBin(creatorHolderScript))),
    binToHex(sha256.hash(hexToBin(positionCommitment)))];
  const prefix = utf8ToBin('MeshBlaze/TokenPairLaunchBundle/v1\0');
  const bytes = Uint8Array.from([...prefix, ...fields.flatMap((field) => [...hexToBin(field)])]);
  return binToHex(sha256.hash(bytes));
}
