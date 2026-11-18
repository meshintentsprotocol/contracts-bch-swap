import { binToHex, encodeTransaction, hashTransaction, hexToBin,
  type Output, type Transaction } from '@bitauth/libauth';
import { Contract, TransactionBuilder, type NetworkProvider,
  type SignatureTemplate } from 'cashscript';
import { generateLibauthSourceOutputs } from 'cashscript/dist/utils.js';
import type { LaunchManifestV1 } from '../manifest/v1.js';
import type { PlannedOutput } from './buy-plan.js';
import { verifyTokenPairBuyPlanV1, type TokenPairBuyPlanV1 } from './token-pair-buy-plan.js';
import { verifyTokenPairSellPlanV1, type TokenPairSellPlanV1 } from './token-pair-sell-plan.js';
import { verifyTokenPairClaimPlanV1, type TokenPairClaimPlanV1 } from './token-pair-claim-plan.js';

type Plan = TokenPairBuyPlanV1 | TokenPairSellPlanV1 | TokenPairClaimPlanV1;
type Action = 'buy' | 'sell' | 'claim';
const fail = (reason: string): never => { throw new Error(`Mesh Blaze signed token pair: ${reason}`); };

/** Sign the exact paired-vault plan and enforce the measured network fee. */
export function buildSignedTokenPairAction(provider: NetworkProvider, m: LaunchManifestV1,
  plan: Plan, base: Contract, quote: Contract, traderSigner: SignatureTemplate,
  action: Action, minFeeRate = 1) {
  if (action === 'buy') verifyTokenPairBuyPlanV1(m, plan as TokenPairBuyPlanV1);
  else if (action === 'sell') verifyTokenPairSellPlanV1(m, plan as TokenPairSellPlanV1);
  else verifyTokenPairClaimPlanV1(m, plan as TokenPairClaimPlanV1);
  if (base.lockingBytecode !== plan.baseInput.lockingBytecode ||
      quote.lockingBytecode !== plan.quoteInput.lockingBytecode)
    fail('contract scripts differ from planned inputs');
  const v2 = base.name === 'MeshBlazeTokenBaseVaultV2Prototype' &&
    quote.name === 'MeshBlazeTokenQuoteVaultV2Prototype';
  const v1 = base.name === 'MeshBlazeTokenBaseVaultV1' &&
    quote.name === 'MeshBlazeTokenQuoteVaultV1';
  if (!v1 && !v2) fail('unknown or mismatched paired-vault artifacts');
  if (plan.feeCap !== (v2 ? 10_000n : 5_000n)) fail('fee cap differs from paired-vault version');
  if (!Number.isInteger(minFeeRate) || minFeeRate < 1 || minFeeRate > 100)
    fail('minimum fee rate outside 1..100 sats/byte');
  const wallet = action === 'buy' ? (plan as TokenPairBuyPlanV1).buyerInput :
    action === 'sell' ? (plan as TokenPairSellPlanV1).sellerInput :
      (plan as TokenPairClaimPlanV1).sponsorInput;
  const role = action === 'claim' ? BigInt((plan as TokenPairClaimPlanV1).role) : 0n;
  const builder = new TransactionBuilder({ provider });
  builder.addInput(plan.baseInput, action === 'buy' ? (base.unlock as any).buy() :
    action === 'sell' ? (base.unlock as any).sell() : (base.unlock as any).claim(role));
  builder.addInput(plan.quoteInput, action === 'buy' ? (quote.unlock as any).buy() :
    action === 'sell' ? (quote.unlock as any).sell() : (quote.unlock as any).claim(role));
  builder.addInput(wallet, traderSigner.unlockP2PKH());
  for (const output of plan.outputs as readonly PlannedOutput[]) builder.addOutput({
    to: hexToBin(output.lockingBytecode), amount: output.satoshis,
    ...(output.token ? { token: output.token } : {}),
  });
  const transaction = (builder as any).buildLibauthTransaction(true) as Transaction;
  const hex = binToHex(encodeTransaction(transaction));
  const size = hex.length / 2;
  const paidFee = plan.baseInput.satoshis + plan.quoteInput.satoshis + wallet.satoshis -
    transaction.outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
  if (paidFee !== plan.networkFee || paidFee < BigInt(size) * BigInt(minFeeRate))
    fail(`actual fee ${paidFee} differs from plan ${plan.networkFee} or falls below ${size}-byte rate floor`);
  return { transaction, hex, size, paidFee,
    txid: hashTransaction(encodeTransaction(transaction)),
    sourceOutputs: generateLibauthSourceOutputs((builder as any).inputs) as Output[] };
}
