import { binToHex, encodeTransaction, hashTransaction, hexToBin, type Output, type Transaction } from '@bitauth/libauth';
import { Contract, TransactionBuilder, type NetworkProvider, type SignatureTemplate } from 'cashscript';
import { generateLibauthSourceOutputs } from 'cashscript/dist/utils.js';
import type { LaunchManifestV1 } from '../manifest/v1.js';
import { verifyBchGraduationPlanV2, type BchGraduationPlanV2 } from './bch-handoff.js';

/** Signs only the sponsor input; the curve input is authorized by its covenant. No broadcast. */
export function buildSignedBchGraduationV2(provider: NetworkProvider, m: LaunchManifestV1,
  plan: BchGraduationPlanV2, curve: Contract, sponsorSigner: SignatureTemplate, minFeeRate = 1) {
  verifyBchGraduationPlanV2(m, plan);
  if (curve.lockingBytecode !== plan.curveInput.lockingBytecode)
    throw new Error('Mesh Blaze signed graduation: curve contract differs from plan');
  if (!Number.isInteger(minFeeRate) || minFeeRate < 1 || minFeeRate > 100)
    throw new Error('Mesh Blaze signed graduation: invalid fee rate');
  const builder = new TransactionBuilder({ provider });
  builder.addInput(plan.curveInput, plan.terms.lockedBps === 10_000 ?
    (curve.unlock as any).graduateAll() : (curve.unlock as any).graduate());
  builder.addInput(plan.sponsorInput, sponsorSigner.unlockP2PKH());
  for (const output of plan.outputs) builder.addOutput({ to: hexToBin(output.lockingBytecode),
    amount: output.satoshis, ...(output.token ? { token: output.token } : {}) });
  const transaction = (builder as any).buildLibauthTransaction(true) as Transaction;
  const hex = binToHex(encodeTransaction(transaction));
  const size = hex.length / 2;
  const paidFee = plan.curveInput.satoshis + plan.sponsorInput.satoshis -
    transaction.outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
  if (paidFee !== plan.networkFee || paidFee < BigInt(size) * BigInt(minFeeRate))
    throw new Error('Mesh Blaze signed graduation: actual fee differs or falls below rate');
  return { transaction, hex, size, txid: hashTransaction(encodeTransaction(transaction)), paidFee,
    sourceOutputs: generateLibauthSourceOutputs((builder as any).inputs) as Output[] };
}
