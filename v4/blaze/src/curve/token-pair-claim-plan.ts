import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import type { SpendableUtxo } from 'cashscript';
import { encodeCurveStateV1 } from './state.js';
import { readTokenPairVaultsV1 } from './token-pair-buy-plan.js';
import type { PlannedOutput } from './buy-plan.js';
import type { LaunchManifestV1 } from '../manifest/v1.js';

export type FeeRoleV1 = 0 | 1 | 2;
export interface TokenPairClaimPlanV1 {
  feeCap: bigint;
  baseInput: SpendableUtxo;
  quoteInput: SpendableUtxo;
  sponsorInput: SpendableUtxo;
  recipientLockingBytecode: string;
  role: FeeRoleV1;
  amount: bigint;
  networkFee: bigint;
  outputs: readonly [PlannedOutput, PlannedOutput, PlannedOutput, PlannedOutput];
}
function fail(message: string): never { throw new Error(`Mesh Blaze token-pair claim plan: ${message}`); }
function expected(m: LaunchManifestV1, base: SpendableUtxo, quote: SpendableUtxo, sponsor: SpendableUtxo,
  role: FeeRoleV1, recipient: string, fee: bigint, feeCap: bigint) {
  const { inventory, held } = readTokenPairVaultsV1(m, base, quote);
  if (![0, 1, 2].includes(role)) fail('invalid fee role');
  if (![5_000n, 10_000n].includes(feeCap) || fee < 0n || fee > feeCap)
    fail('network fee outside covenant cap');
  if (sponsor.token) fail('sponsor must be BCH only');
  if (binToHex(sha256.hash(hexToBin(recipient))) !==
      [m.curveFees.creator, m.curveFees.partner, m.curveFees.protocol][role]!.scriptHash) fail('recipient differs from manifest');
  const field = (['creatorFees', 'partnerFees', 'protocolFees'] as const)[role];
  const amount = inventory.state[field];
  if (amount <= 0n) fail('no accrued fees for role');
  const change = sponsor.satoshis - fee - 1_000n;
  if (change < 1_000n) fail('sponsor cannot fund token carrier and fee');
  const next = { ...inventory.state, [field]: 0n };
  const outputs: [PlannedOutput, PlannedOutput, PlannedOutput, PlannedOutput] = [
    { lockingBytecode: base.lockingBytecode, satoshis: base.satoshis,
      token: { category: m.tokenCategory, amount: inventory.base,
        nft: { capability: 'mutable', commitment: encodeCurveStateV1(next) } } },
    { lockingBytecode: quote.lockingBytecode, satoshis: quote.satoshis,
      token: { category: m.quoteCategory!, amount: held - amount } },
    { lockingBytecode: recipient, satoshis: 1_000n, token: { category: m.quoteCategory!, amount } },
    { lockingBytecode: sponsor.lockingBytecode, satoshis: change },
  ];
  return { amount, outputs };
}
export function planTokenPairClaimV1(m: LaunchManifestV1, baseInput: SpendableUtxo, quoteInput: SpendableUtxo,
  sponsorInput: SpendableUtxo, role: FeeRoleV1, recipientLockingBytecode: string,
  networkFee: bigint, feeCap = 5_000n): TokenPairClaimPlanV1 {
  const { amount, outputs } = expected(m, baseInput, quoteInput, sponsorInput,
    role, recipientLockingBytecode, networkFee, feeCap);
  const plan = { baseInput, quoteInput, sponsorInput, recipientLockingBytecode, role,
    amount, networkFee, feeCap, outputs };
  verifyTokenPairClaimPlanV1(m, plan);
  return plan;
}
export function verifyTokenPairClaimPlanV1(m: LaunchManifestV1, plan: TokenPairClaimPlanV1): void {
  const { amount, outputs } = expected(m, plan.baseInput, plan.quoteInput, plan.sponsorInput,
    plan.role, plan.recipientLockingBytecode, plan.networkFee, plan.feeCap);
  if (plan.amount !== amount || plan.outputs.length !== 4) fail('amount or output count differs');
  for (let i = 0; i < 4; i++) {
    const got = plan.outputs[i]!;
    const want = outputs[i]!;
    if (got.lockingBytecode !== want.lockingBytecode || got.satoshis !== want.satoshis ||
        got.token?.category !== want.token?.category || got.token?.amount !== want.token?.amount ||
        got.token?.nft?.capability !== want.token?.nft?.capability ||
        got.token?.nft?.commitment !== want.token?.nft?.commitment) fail(`output ${i} differs`);
  }
}
