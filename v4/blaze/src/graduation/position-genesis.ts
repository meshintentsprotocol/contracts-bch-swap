import { binToHex, encodeTransaction, hashTransaction, hexToBin, type Output, type Transaction } from '@bitauth/libauth';
import { TransactionBuilder, type NetworkProvider, type SignatureTemplate } from 'cashscript';
import type { SeedPlan } from '../genesis/plan.js';

const fail = (message: string): never => { throw new Error(`Mesh Blaze position genesis: ${message}`); };
const validScript = (s: string) => /^(?:[0-9a-f]{2})+$/.test(s);

/** A separate seed creates exactly one non-minting creator control NFT. */
export function planCreatorPositionGenesis(provider: NetworkProvider, seed: SeedPlan,
  signer: SignatureTemplate, creatorScript: string, commitment: string, fee: bigint,
  changeScript: string, minFeeRate = 1) {
  if (!validScript(creatorScript) || !validScript(changeScript)) fail('invalid destination');
  if (!/^(?:[0-9a-f]{2}){1,128}$/.test(commitment)) fail('commitment must be nonempty and at most 128 bytes');
  if (hashTransaction(encodeTransaction(seed.transaction)) !== seed.category ||
      seed.transaction.outputs.length !== 1 || seed.outputSatoshis !== seed.transaction.outputs[0]!.valueSatoshis)
    fail('seed transaction/category mismatch');
  if (fee <= 0n || seed.outputSatoshis < fee + 1_000n) fail('insufficient seed value');
  if (!Number.isInteger(minFeeRate) || minFeeRate < 1 || minFeeRate > 100) fail('invalid minimum fee rate');
  const builder = new TransactionBuilder({ provider });
  builder.addInput({ txid: seed.category, vout: 0, satoshis: seed.outputSatoshis,
    lockingBytecode: binToHex(seed.transaction.outputs[0]!.lockingBytecode) }, signer.unlockP2PKH());
  builder.addOutput({ to: hexToBin(creatorScript), amount: 1_000n, token: {
    category: seed.category, amount: 0n, nft: { capability: 'none', commitment } } });
  const change = seed.outputSatoshis - fee - 1_000n;
  if (change >= 1_000n) builder.addOutput({ to: hexToBin(changeScript), amount: change });
  const transaction = (builder as any).buildLibauthTransaction(true) as Transaction;
  verifyCreatorPositionGenesis(transaction, seed.transaction.outputs, seed.category, creatorScript, commitment);
  const hex = binToHex(encodeTransaction(transaction));
  const paidFee = seed.outputSatoshis - transaction.outputs.reduce((sum, o) => sum + o.valueSatoshis, 0n);
  if (paidFee < BigInt(hex.length / 2) * BigInt(minFeeRate)) fail('fee below minimum sat/byte rate');
  return { transaction, hex, size: hex.length / 2, txid: hashTransaction(encodeTransaction(transaction)),
    category: seed.category, sourceOutputs: seed.transaction.outputs, paidFee };
}

/** Check the transaction independently before accepting its category as an owned-bin authority. */
export function verifyCreatorPositionGenesis(tx: Transaction, sources: readonly Output[], category: string,
  creatorScript: string, commitment: string): void {
  if (!/^[0-9a-f]{64}$/.test(category) || !validScript(creatorScript) ||
      !/^(?:[0-9a-f]{2}){1,128}$/.test(commitment)) fail('invalid expected position');
  if (tx.inputs.length !== 1 || sources.length !== 1 || sources[0]!.token ||
      tx.inputs[0]!.outpointIndex !== 0 || binToHex(tx.inputs[0]!.outpointTransactionHash) !== category)
    fail('category must derive from token-free seed output zero');
  const tokenOutputs = tx.outputs.filter((o) => o.token);
  if (tokenOutputs.length !== 1) fail('exactly one position token output required');
  const out = tokenOutputs[0]!;
  if (binToHex(out.token!.category) !== category || out.token!.amount !== 0n ||
      out.token!.nft?.capability !== 'none' || binToHex(out.token!.nft.commitment) !== commitment ||
      binToHex(out.lockingBytecode) !== creatorScript || out.valueSatoshis < 1_000n)
    fail('creator must receive the unique non-minting position NFT');
}
