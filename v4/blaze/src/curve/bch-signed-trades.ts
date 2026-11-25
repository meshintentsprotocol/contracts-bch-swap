import { binToHex, encodeTransaction, hashTransaction, hexToBin, type Output, type Transaction } from '@bitauth/libauth';
import { Contract, TransactionBuilder, type NetworkProvider, type SignatureTemplate } from 'cashscript';
import { generateLibauthSourceOutputs } from 'cashscript/dist/utils.js';
import type { LaunchManifestV1 } from '../manifest/v1.js';
import { verifyBchCurveBuyPlanV1, type BchCurveBuyPlanV1, type PlannedOutput } from './buy-plan.js';
import { verifyBchCurveSellPlanV1, verifyBchCurveClaimPlanV1,
  type BchCurveSellPlanV1, type BchCurveClaimPlanV1 } from './sell-claim-plan.js';

type TradePlan = BchCurveBuyPlanV1 | BchCurveSellPlanV1 | BchCurveClaimPlanV1;
type Action = 'buy' | 'sell' | 'claim';

/** Builds a signed offline curve spend for V1 or V2 with the same trade ABI. */
export function buildSignedBchCurveAction(provider: NetworkProvider, m: LaunchManifestV1,
  plan: TradePlan, curve: Contract, traderSigner: SignatureTemplate,
  action: Action, minFeeRate = 1) {
  if (action === 'buy') verifyBchCurveBuyPlanV1(m, plan as BchCurveBuyPlanV1);
  else if (action === 'sell') verifyBchCurveSellPlanV1(m, plan as BchCurveSellPlanV1);
  else verifyBchCurveClaimPlanV1(m, plan as BchCurveClaimPlanV1);
  if (curve.lockingBytecode !== plan.curveInput.lockingBytecode)
    throw new Error('Mesh Blaze signed curve: contract differs from plan');
  if (!Number.isInteger(minFeeRate) || minFeeRate < 1 || minFeeRate > 100)
    throw new Error('Mesh Blaze signed curve: invalid fee rate');
  const walletInput = action === 'buy' ? (plan as BchCurveBuyPlanV1).buyerInput :
    action === 'sell' ? (plan as BchCurveSellPlanV1).sellerInput : (plan as BchCurveClaimPlanV1).sponsorInput;
  const builder = new TransactionBuilder({ provider });
  builder.addInput(plan.curveInput, action === 'buy' ? (curve.unlock as any).buy() :
    action === 'sell' ? (curve.unlock as any).sell() :
      (curve.unlock as any).claim(BigInt((plan as BchCurveClaimPlanV1).role)));
  builder.addInput(walletInput, traderSigner.unlockP2PKH());
  for (const output of plan.outputs as readonly PlannedOutput[]) builder.addOutput({
    to: hexToBin(output.lockingBytecode), amount: output.satoshis,
    ...(output.token ? { token: output.token } : {}),
  });
  const transaction = (builder as any).buildLibauthTransaction(true) as Transaction;
  const hex = binToHex(encodeTransaction(transaction));
  const size = hex.length / 2;
  const paidFee = plan.curveInput.satoshis + walletInput.satoshis -
    transaction.outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
  if (paidFee !== plan.networkFee || paidFee < BigInt(size) * BigInt(minFeeRate))
    throw new Error('Mesh Blaze signed curve: actual fee differs or falls below rate');
  return { transaction, hex, size, txid: hashTransaction(encodeTransaction(transaction)), paidFee,
    sourceOutputs: generateLibauthSourceOutputs((builder as any).inputs) as Output[] };
}
