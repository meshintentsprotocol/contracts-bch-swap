import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { OWNER, TAKER, KEEPER, TOKEN_A, TOKEN_B, catVm, le, net, nft, tb, utxo, buildTx, verify, lockOf, inputMetrics } from '../../test/harness.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';
import { tokenQuoteVaultFromManifestV1 } from '../src/curve/quote-vault.js';
import type { LaunchManifestV1 } from '../src/manifest/v1.js';

const ARTIFACT = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'artifacts', 'MeshBlazeTokenQuoteVaultV1.json'), 'utf8'));
function vault() {
  return new Contract(ARTIFACT, [`0x${catVm(TOKEN_A)}`, `0x${catVm(TOKEN_B)}`, `0x${le(1_000n, 8)}`],
    { provider: net, contractType: 'p2sh32' });
}
function manifestForVault(c: Contract): LaunchManifestV1 {
  const hash = (lock: Uint8Array) => binToHex(sha256.hash(lock));
  const zero = '00'.repeat(32);
  const fees = { creator: { scriptHash: hash(OWNER.lock), bps: 50 },
    partner: { scriptHash: hash(TAKER.lock), bps: 25 }, protocol: { scriptHash: hash(KEEPER.lock), bps: 25 } };
  return {
    version: 1, tokenCategory: TOKEN_A, quoteCategory: TOKEN_B, totalSupply: 1_000_000n,
    allocations: [{ name: 'curve', amount: 1_000_000n, satoshis: 1_000n, lockingBytecode: binToHex(OWNER.lock),
      nftCommitment: encodeCurveStateV1({ stage: 0, realQuote: 0n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n }) }],
    activationHeight: 400_000, alphaStartHeight: 0, alphaEndHeight: 0, presaleRoute: null, presaleScriptHash: zero,
    alphaModes: 0, alphaFixedScriptHash: zero, alphaBuyScriptHash: zero,
    virtualBase: 100_000n, virtualQuote: 1_000_000n, graduationQuoteThreshold: 500_000n, lockedLiquidityBps: 9_000,
    curveScriptHash: hash(OWNER.lock), quoteVaultScriptHash: hash(hexToBin(c.lockingBytecode)), quoteVaultCarrierSats: 1_000n,
    graduationScriptHash: hash(TAKER.lock), marketScriptHash: hash(KEEPER.lock), curveFees: fees, marketFees: fees,
  };
}
function quoteVaultBuy(tamper: 'none' | 'ledger' | 'baseScript' | 'change' = 'none') {
  const c = vault();
  const before = encodeCurveStateV1({ stage: 0, realQuote: 0n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n });
  const after = encodeCurveStateV1({ stage: 0, realQuote: 9_900n, creatorFees: 50n, partnerFees: 25n, protocolFees: 25n });
  const b = tb();
  b.addInput(utxo(OWNER.lock, 1_000n, nft(TOKEN_A, 'mutable', before, 1_000_000n)), OWNER.template.unlockP2PKH());
  b.addInput(utxo(c.lockingBytecode, 1_000n), c.unlock.buy());
  b.addInput(utxo(TAKER.lock, 5_000n, { category: TOKEN_B, amount: 20_000n }), TAKER.template.unlockP2PKH());
  b.addOutput({ to: tamper === 'baseScript' ? KEEPER.lock : OWNER.lock, amount: 1_000n,
    token: nft(TOKEN_A, 'mutable', after, 990_000n) });
  b.addOutput({ to: lockOf(c), amount: 1_000n, token: { category: TOKEN_B, amount: tamper === 'ledger' ? 10_001n : 10_000n } });
  b.addOutput({ to: TAKER.lock, amount: 1_000n, token: { category: TOKEN_A, amount: 10_000n } });
  b.addOutput({ to: tamper === 'change' ? KEEPER.lock : TAKER.lock, amount: 2_000n,
    token: { category: TOKEN_B, amount: tamper === 'ledger' ? 9_999n : 10_000n } });
  return b;
}
function rejectsAtQuote(result: true | string) {
  assert.equal(typeof result, 'string');
  assert.match(result as string, /input index 1/i);
}
const cases: Array<[string, () => void]> = [
  ['manifest reconstructs the paired quote-vault script', () => {
    const c = vault();
    const m = manifestForVault(c);
    assert.equal(tokenQuoteVaultFromManifestV1(ARTIFACT, m, net).lockingBytecode, c.lockingBytecode);
    assert.throws(() => tokenQuoteVaultFromManifestV1(ARTIFACT, { ...m, quoteVaultCarrierSats: 2_000n }, net), /script differs/);
  }],
  ['initial paired buy passes quote-vault BCH VM path', () => {
    const built = buildTx(quoteVaultBuy());
    assert.equal(verify(built), true);
    const metrics = inputMetrics(built)[1]!;
    assert.equal(metrics.ok, true);
    console.log(`COST quote-vault buy: ${built.size} bytes, ${metrics.opCost}/${metrics.maxOpCost} op cost`);
  }],
  ['quote amount must equal real reserve plus three fee balances', () => {
    rejectsAtQuote(verify(buildTx(quoteVaultBuy('ledger'))));
  }],
  ['base NFT successor must remain under its previous script', () => {
    rejectsAtQuote(verify(buildTx(quoteVaultBuy('baseScript'))));
  }],
  ['buyer quote-token remainder cannot be redirected', () => {
    rejectsAtQuote(verify(buildTx(quoteVaultBuy('change'))));
  }],
];
let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}:`, error); }
}
console.log(`Mesh Blaze token quote-vault VM: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
