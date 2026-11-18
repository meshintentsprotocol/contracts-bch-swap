import { binToHex, encodeTransaction, hashTransaction, hexToBin,
  type Output, type Transaction } from '@bitauth/libauth';
import { Contract, TransactionBuilder, type NetworkProvider,
  type SignatureTemplate } from 'cashscript';
import { generateLibauthSourceOutputs } from 'cashscript/dist/utils.js';
import type { LaunchManifestV1 } from '../manifest/v1.js';
import { verifyTokenPairGraduationPlanV1,
  type TokenPairGraduationPlanV1 } from './token-pair-handoff.js';

const fail = (reason: string): never => { throw new Error(`Mesh Blaze signed token graduation: ${reason}`); };

/** Sign a two-vault E2 graduation only after its exact output plan is verified. */
export function buildSignedTokenPairGraduationV1(provider: NetworkProvider, m: LaunchManifestV1,
  plan: TokenPairGraduationPlanV1, base: Contract, quote: Contract,
  sponsorSigner: SignatureTemplate, minFeeRate = 1) {
  verifyTokenPairGraduationPlanV1(m, plan);
  if (base.name !== 'MeshBlazeTokenBaseVaultV2Prototype' ||
      quote.name !== 'MeshBlazeTokenQuoteVaultV2Prototype')
    fail('graduation requires paired V2 artifacts');
  if (base.lockingBytecode !== plan.baseInput.lockingBytecode ||
      quote.lockingBytecode !== plan.quoteInput.lockingBytecode)
    fail('contract scripts differ from planned inputs');
  if (!Number.isInteger(minFeeRate) || minFeeRate < 1 || minFeeRate > 100)
    fail('minimum fee rate outside 1..100 sats/byte');
  const all = plan.split.creatorBase === 0n && plan.split.creatorQuote === 0n;
  const builder = new TransactionBuilder({ provider });
  builder.addInput(plan.baseInput, all ? (base.unlock as any).graduateAll() :
    (base.unlock as any).graduate());
  builder.addInput(plan.quoteInput, all ? (quote.unlock as any).graduateAll() :
    (quote.unlock as any).graduate());
  builder.addInput(plan.sponsorInput, sponsorSigner.unlockP2PKH());
  for (const output of plan.outputs) builder.addOutput({
    to: hexToBin(output.lockingBytecode), amount: output.satoshis,
    ...(output.token ? { token: output.token } : {}),
  });
  const transaction = (builder as any).buildLibauthTransaction(true) as Transaction;
  const hex = binToHex(encodeTransaction(transaction));
  const size = hex.length / 2;
  const paidFee = plan.baseInput.satoshis + plan.quoteInput.satoshis + plan.sponsorInput.satoshis -
    transaction.outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
  if (paidFee !== plan.networkFee || paidFee < BigInt(size) * BigInt(minFeeRate))
    fail(`actual fee ${paidFee} differs from plan ${plan.networkFee} or falls below ${size}-byte rate floor`);
  return { transaction, hex, size, paidFee,
    txid: hashTransaction(encodeTransaction(transaction)),
    sourceOutputs: generateLibauthSourceOutputs((builder as any).inputs) as Output[] };
}
