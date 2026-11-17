import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, hash256, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { OWNER, TAKER, KEEPER, TOKEN_A, TOKEN_B, catVm, le, net, nft,
  tb, utxo, buildTx, verify, lockOf, inputMetrics } from '../../test/harness.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';
import { tokenPairGraduationTermsHashV1, planTokenPairGraduationV1,
  type TokenPairGraduationTermsV1 } from '../src/graduation/token-pair-handoff.js';
import type { LaunchManifestV1 } from '../src/manifest/v1.js';

const BASE = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenBaseVaultV2Prototype.json', 'utf8'));
const QUOTE = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenQuoteVaultV2Prototype.json', 'utf8'));
const ARCHIVE = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeStateArchiveV1.json', 'utf8'));
const h = (script: Uint8Array) => binToHex(sha256.hash(script));
const archive = new Contract(ARCHIVE, [], { provider: net, contractType: 'p2sh32' });
const terminal = { stage: 1 as const, realQuote: 500_003n,
  creatorFees: 0n, partnerFees: 0n, protocolFees: 0n };
const rights = { creator: { scriptHash: h(OWNER.lock), bps: 50 },
  partner: { scriptHash: h(TAKER.lock), bps: 25 }, protocol: { scriptHash: h(KEEPER.lock), bps: 25 } };
function fixture(lockedBps: 9_000 | 10_000) {
  const terms: TokenPairGraduationTermsV1 = {
    lockedBaseScript: binToHex(KEEPER.lock), lockedQuoteScript: binToHex(KEEPER.lock),
    creatorBaseScript: binToHex(OWNER.lock), creatorQuoteScript: binToHex(OWNER.lock),
    archiveScript: archive.lockingBytecode,
    collectorScripts: [binToHex(OWNER.lock), binToHex(TAKER.lock), binToHex(KEEPER.lock)],
    lockedBps, marketCarrierSats: 1_000n, collectorCarrierSats: 1_000n,
  };
  const hashes = [terms.lockedBaseScript, terms.lockedQuoteScript, terms.creatorBaseScript,
    terms.creatorQuoteScript, terms.archiveScript, ...terms.collectorScripts].map((script) => `0x${h(hexToBin(script))}`);
  const q = new Contract(QUOTE, [`0x${catVm(TOKEN_A)}`, `0x${catVm(TOKEN_B)}`,
    `0x${le(1_000n, 8)}`, `0x${le(500_003n, 8)}`, `0x${le(1_000n, 8)}`,
    `0x${le(BigInt(lockedBps), 2)}`, `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`, ...hashes],
  { provider: net, contractType: 'p2sh32' });
  const b = new Contract(BASE, [`0x${catVm(TOKEN_A)}`, `0x${catVm(TOKEN_B)}`,
    `0x${binToHex(hash256(hexToBin(q.bytecode)))}`,
    `0x${le(100_000n, 8)}`, `0x${le(1_000_000n, 8)}`, `0x${le(500_003n, 8)}`,
    `0x${le(1_000n, 8)}`, `0x${le(50n, 2)}`, `0x${le(25n, 2)}`, `0x${le(25n, 2)}`,
    `0x${h(OWNER.lock)}`, `0x${h(TAKER.lock)}`, `0x${h(KEEPER.lock)}`,
    `0x${le(1_000n, 8)}`, `0x${le(BigInt(lockedBps), 2)}`,
    `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`, ...hashes],
  { provider: net, contractType: 'p2sh32' });
  const zero = '00'.repeat(32);
  const m: LaunchManifestV1 = {
    version: 1, tokenCategory: TOKEN_A, quoteCategory: TOKEN_B, totalSupply: 1_000_000n,
    allocations: [{ name: 'curve', amount: 1_000_000n, satoshis: 1_000n,
      lockingBytecode: b.lockingBytecode,
      nftCommitment: encodeCurveStateV1({ ...terminal, stage: 0, realQuote: 0n }) }],
    activationHeight: 400_000, alphaStartHeight: 0, alphaEndHeight: 0, presaleRoute: null,
    presaleScriptHash: zero, alphaModes: 0, alphaFixedScriptHash: zero, alphaBuyScriptHash: zero,
    virtualBase: 100_000n, virtualQuote: 1_000_000n, graduationQuoteThreshold: 500_003n,
    lockedLiquidityBps: lockedBps, curveScriptHash: h(lockOf(b)), quoteVaultScriptHash: h(lockOf(q)),
    quoteVaultCarrierSats: 1_000n, graduationScriptHash: h(OWNER.lock),
    marketScriptHash: h(KEEPER.lock), curveFees: rights, marketFees: rights,
  };
  const base = utxo(b.lockingBytecode, 1_000n,
    nft(TOKEN_A, 'mutable', encodeCurveStateV1(terminal), 100_001n));
  const quote = utxo(q.lockingBytecode, 1_000n, { category: TOKEN_B, amount: 500_003n });
  const sponsor = utxo(TAKER.lock, 20_000n);
  const plan = planTokenPairGraduationV1(m, base, quote, sponsor, terms,
    tokenPairGraduationTermsHashV1(terms), 1_000n);
  return { b, q, base, quote, sponsor, plan };
}
function build(f: ReturnType<typeof fixture>, mutate?: (outputs: typeof f.plan.outputs) => void) {
  const outputs = structuredClone(f.plan.outputs);
  mutate?.(outputs);
  const builder = tb();
  builder.addInput(f.base, f.b.unlock[f.plan.outputs.length === 9 ? 'graduate' : 'graduateAll']());
  builder.addInput(f.quote, f.q.unlock[f.plan.outputs.length === 9 ? 'graduate' : 'graduateAll']());
  builder.addInput(f.sponsor, TAKER.template.unlockP2PKH());
  for (const output of outputs) builder.addOutput({ to: hexToBin(output.lockingBytecode),
    amount: output.satoshis, ...(output.token ? { token: output.token } : {}) });
  return buildTx(builder);
}
const ninety = fixture(9_000);
assert.equal(verify(build(ninety)), true);
assert.equal(verify(build(fixture(10_000))), true);
function rejectsBoth(mutate: (outputs: typeof ninety.plan.outputs) => void) {
  const tx = build(ninety, mutate);
  assert.notEqual(verify(tx), true);
  const inputs = inputMetrics(tx);
  assert.equal(inputs[0]!.ok, false, 'base covenant must reject');
  assert.equal(inputs[1]!.ok, false, 'quote covenant must reject');
}
rejectsBoth((outputs) => { outputs[1]!.token!.amount -= 1n; });
rejectsBoth((outputs) => { outputs[1]!.lockingBytecode = binToHex(OWNER.lock); });
rejectsBoth((outputs) => { outputs[8]!.satoshis -= 5_001n; });
rejectsBoth((outputs) => { outputs[4]!.token!.nft!.commitment = '00'; });
console.log('Mesh Blaze paired graduation VM: 6 checks passed');
