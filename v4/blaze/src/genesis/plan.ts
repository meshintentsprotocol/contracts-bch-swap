import { binToHex, encodeTransaction, hashTransaction, hexToBin, sha256, utf8ToBin, type Output, type Transaction } from '@bitauth/libauth';
import { TransactionBuilder, type NetworkProvider, type SignatureTemplate } from 'cashscript';

export const MIN_TOKEN_CARRIER = 1_000n;
export const MAX_FT_SUPPLY = (1n << 63n) - 1n;

export interface FundingCoin {
  txid: string;
  vout: number;
  satoshis: bigint;
  lockingBytecode: string;
}

export interface Allocation {
  name: string;
  amount: bigint;
  satoshis: bigint;
  lockingBytecode: string;
  /** Optional mutable state NFT of this same launch category; only the curve allocation may carry one. */
  nftCommitment?: string;
}

export interface SeedPlan {
  transaction: Transaction;
  hex: string;
  size: number;
  category: string;
  outputSatoshis: bigint;
  sourceOutputs: Output[];
}

export interface GenesisPlan {
  transaction: Transaction;
  hex: string;
  size: number;
  txid: string;
  category: string;
  manifestHash?: string;
  bundleHash?: string;
  paidFee: bigint;
  allocationIndexes: Record<string, number>;
  sourceOutputs: Output[];
}

const isHash = (s: string) => /^[0-9a-f]{64}$/.test(s);
const isBytecode = (s: string) => /^(?:[0-9a-f]{2})+$/.test(s);

function fail(message: string): never { throw new Error(`Mesh Blaze genesis: ${message}`); }

/** Exact UTF-8 bytes to publish must be hosted unchanged before broadcasting genesis. */
export function createBcmrPublication(registryText: string, httpsUrl: string) {
  if (!registryText || utf8ToBin(registryText).length > 100_000) fail('invalid BCMR registry bytes');
  let url: URL;
  try { url = new URL(httpsUrl); } catch { return fail('invalid BCMR URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href !== httpsUrl) fail('BCMR URL must be canonical HTTPS without credentials or fragment');
  const registryHash = binToHex(sha256.hash(utf8ToBin(registryText)));
  return { registryHash, chunks: ['BCMR', `0x${registryHash}`, httpsUrl.slice('https://'.length)] };
}

/** Build an offline seed transaction. Its txid is the new CashToken category. */
export function planSeed(
  provider: NetworkProvider,
  funding: FundingCoin,
  signer: SignatureTemplate,
  fee: bigint,
  minFeeRate = 1,
): SeedPlan {
  if (!Number.isInteger(minFeeRate) || minFeeRate < 1 || minFeeRate > 100) fail('minimum fee rate must be 1..100 sats/byte');
  if (!isHash(funding.txid) || !isBytecode(funding.lockingBytecode)) fail('invalid funding outpoint or locking bytecode');
  if (!Number.isInteger(funding.vout) || funding.vout < 0) fail('invalid funding output index');
  if (fee <= 0n || funding.satoshis - fee < MIN_TOKEN_CARRIER) fail('seed fee or output is too small');
  const b = new TransactionBuilder({ provider });
  b.addInput(funding, signer.unlockP2PKH());
  b.addOutput({ to: hexToBin(funding.lockingBytecode), amount: funding.satoshis - fee });
  const transaction = (b as any).buildLibauthTransaction(true) as Transaction;
  const sourceOutputs = [{ lockingBytecode: hexToBin(funding.lockingBytecode), valueSatoshis: funding.satoshis }];
  const hex = binToHex(encodeTransaction(transaction));
  if (fee < BigInt(hex.length / 2) * BigInt(minFeeRate)) fail('seed fee below minimum sat/byte rate');
  return { transaction, hex, size: hex.length / 2, category: hashTransaction(encodeTransaction(transaction)), outputSatoshis: transaction.outputs[0]!.valueSatoshis, sourceOutputs };
}

/** Build one fixed-supply genesis from a signed seed plan. No network calls or broadcasts. */
export function planFixedSupplyGenesis(
  provider: NetworkProvider,
  seed: SeedPlan,
  signer: SignatureTemplate,
  totalSupply: bigint,
  allocations: readonly Allocation[],
  fee: bigint,
  changeLockingBytecode: string,
  publicationChunks?: string[],
  manifestHash?: string,
  minFeeRate = 1,
  bundleHash?: string,
): GenesisPlan {
  if (!Number.isInteger(minFeeRate) || minFeeRate < 1 || minFeeRate > 100) fail('minimum fee rate must be 1..100 sats/byte');
  if (!isHash(seed.category) || hashTransaction(encodeTransaction(seed.transaction)) !== seed.category) fail('seed transaction/category mismatch');
  if (seed.transaction.outputs.length !== 1 || !seed.transaction.outputs[0]) fail('seed must have exactly one output');
  if (seed.outputSatoshis !== seed.transaction.outputs[0].valueSatoshis) fail('seed output amount mismatch');
  if (totalSupply <= 0n || totalSupply > MAX_FT_SUPPLY) fail('supply outside CashToken fungible range');
  if (allocations.length === 0 || allocations.length > 32) fail('allocation count must be 1..32');
  if (!isBytecode(changeLockingBytecode)) fail('invalid change locking bytecode');
  const names = new Set<string>();
  let allocated = 0n;
  let carrier = 0n;
  for (const a of allocations) {
    if (!a.name || names.has(a.name)) fail('allocation names must be nonempty and unique');
    names.add(a.name);
    if (a.amount <= 0n || a.satoshis < MIN_TOKEN_CARRIER || !isBytecode(a.lockingBytecode)) fail(`invalid allocation ${a.name}`);
    if (a.nftCommitment !== undefined && (a.name !== 'curve' || !/^(?:[0-9a-f]{2}){1,128}$/.test(a.nftCommitment))) fail(`invalid mutable state NFT on ${a.name}`);
    allocated += a.amount;
    carrier += a.satoshis;
  }
  if (allocated !== totalSupply) fail(`allocation sum ${allocated} differs from supply ${totalSupply}`);
  if (fee <= 0n || seed.outputSatoshis < carrier + fee) fail('insufficient seed sats for carriers and fee');
  const b = new TransactionBuilder({ provider });
  b.addInput({ txid: seed.category, vout: 0, satoshis: seed.outputSatoshis, lockingBytecode: binToHex(seed.transaction.outputs[0]!.lockingBytecode) }, signer.unlockP2PKH());
  const allocationIndexes: Record<string, number> = {};
  for (const a of allocations) {
    allocationIndexes[a.name] = b.outputs.length;
    b.addOutput({ to: hexToBin(a.lockingBytecode), amount: a.satoshis, token: { category: seed.category, amount: a.amount, ...(a.nftCommitment === undefined ? {} : { nft: { capability: 'mutable' as const, commitment: a.nftCommitment } }) } });
  }
  if (publicationChunks) b.addOpReturnOutput(publicationChunks);
  if (manifestHash) {
    if (!isHash(manifestHash)) fail('manifest hash must be 32-byte lowercase hex');
    b.addOpReturnOutput(['MBLZ', `0x${manifestHash}`]);
  }
  if (bundleHash) {
    if (!isHash(bundleHash)) fail('bundle hash must be 32-byte lowercase hex');
    b.addOpReturnOutput(['MBND', `0x${bundleHash}`]);
  }
  const change = seed.outputSatoshis - carrier - fee;
  if (change >= MIN_TOKEN_CARRIER) b.addOutput({ to: hexToBin(changeLockingBytecode), amount: change });
  const transaction = (b as any).buildLibauthTransaction(true) as Transaction;
  const sourceOutputs = [seed.transaction.outputs[0]!];
  verifyFixedSupplyGenesis(transaction, sourceOutputs, totalSupply, allocations, seed.category);
  const hex = binToHex(encodeTransaction(transaction));
  const paidFee = seed.outputSatoshis - transaction.outputs.reduce((n, o) => n + o.valueSatoshis, 0n);
  if (paidFee < BigInt(hex.length / 2) * BigInt(minFeeRate)) fail('genesis fee below minimum sat/byte rate');
  return { transaction, hex, size: hex.length / 2, txid: hashTransaction(encodeTransaction(transaction)), category: seed.category, manifestHash, bundleHash, paidFee, allocationIndexes, sourceOutputs };
}

/** Rejects minting NFTs, hidden category outputs and mismatched allocation destinations. */
export function verifyFixedSupplyGenesis(
  tx: Transaction,
  sourceOutputs: readonly Output[],
  totalSupply: bigint,
  allocations: readonly Allocation[],
  category: string,
): void {
  if (!isHash(category) || tx.inputs.length !== sourceOutputs.length || tx.inputs.length !== 1) fail('invalid genesis inputs');
  if (tx.inputs[0]!.outpointIndex !== 0 || binToHex(tx.inputs[0]!.outpointTransactionHash) !== category) fail('input 0 must spend seed output 0');
  if (sourceOutputs.some((o) => o.token)) fail('genesis source must have no token');
  let sum = 0n;
  let count = 0;
  tx.outputs.forEach((o, index) => {
    if (!o.token) return;
    count++;
    if (binToHex(o.token.category) !== category) fail('foreign category in genesis');
    const a = allocations[index];
    if (o.token.nft ? (a?.name !== 'curve' || o.token.nft.capability !== 'mutable' || binToHex(o.token.nft.commitment) !== a.nftCommitment) : a?.nftCommitment !== undefined) fail('unexpected or mismatched state NFT in genesis');
    if (!a || o.token.amount !== a.amount || o.valueSatoshis !== a.satoshis || binToHex(o.lockingBytecode) !== a.lockingBytecode) fail(`allocation output ${index} differs from plan`);
    sum += o.token.amount;
  });
  if (count !== allocations.length || sum !== totalSupply) fail('genesis supply or allocation count differs from plan');
}
