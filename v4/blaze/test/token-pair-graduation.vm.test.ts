import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, encodeTransaction, hash256, hashTransaction, hexToBin, sha256 } from '@bitauth/libauth';
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
const MARKET_BASE_LOCKED = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenMarketBaseLockedV1.json', 'utf8'));
const MARKET_QUOTE_LOCKED = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenMarketQuoteLockedV1.json', 'utf8'));
const MARKET_BASE_OWNED = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenMarketBaseOwnedV1.json', 'utf8'));
const MARKET_QUOTE_OWNED = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenMarketQuoteOwnedV1.json', 'utf8'));
const COLLECTOR = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenFeeCollectorV1.json', 'utf8'));
const h = (script: Uint8Array) => binToHex(sha256.hash(script));
const archive = new Contract(ARCHIVE, [], { provider: net, contractType: 'p2sh32' });
const terminal = { stage: 1 as const, realQuote: 500_003n,
  creatorFees: 0n, partnerFees: 0n, protocolFees: 0n };
const rights = { creator: { scriptHash: h(OWNER.lock), bps: 50 },
  partner: { scriptHash: h(TAKER.lock), bps: 25 }, protocol: { scriptHash: h(KEEPER.lock), bps: 25 } };
function fixture(lockedBps: 9_000 | 10_000, marketBid = 7n, marketAsk = 8n) {
  const collectors = [OWNER, TAKER, KEEPER].map((key) => new Contract(COLLECTOR,
    [`0x${catVm(TOKEN_B)}`, `0x${h(key.lock)}`, `0x${le(1_000n, 8)}`],
    { provider: net, contractType: 'p2sh32' }));
  const marketArgs = [`0x${catVm(TOKEN_A)}`, `0x${catVm(TOKEN_B)}`,
    `0x${le(marketBid, 8)}`, `0x${le(1n, 8)}`, `0x${le(marketAsk, 8)}`, `0x${le(1n, 8)}`,
    `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`,
    ...collectors.map((collector) => `0x${h(lockOf(collector))}`),
    `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`];
  const lockedQuote = new Contract(MARKET_QUOTE_LOCKED, marketArgs,
    { provider: net, contractType: 'p2sh32' });
  const lockedBase = new Contract(MARKET_BASE_LOCKED, [marketArgs[0]!, marketArgs[1]!,
    `0x${binToHex(hash256(hexToBin(lockedQuote.bytecode)))}`, ...marketArgs.slice(2)],
    { provider: net, contractType: 'p2sh32' });
  const ownerCat = '11'.repeat(32);
  const ownedQuote = new Contract(MARKET_QUOTE_OWNED,
    [marketArgs[0]!, marketArgs[1]!, `0x${catVm(ownerCat)}`, ...marketArgs.slice(2)],
    { provider: net, contractType: 'p2sh32' });
  const ownedBase = new Contract(MARKET_BASE_OWNED,
    [marketArgs[0]!, marketArgs[1]!, `0x${catVm(ownerCat)}`,
      `0x${binToHex(hash256(hexToBin(ownedQuote.bytecode)))}`, ...marketArgs.slice(2)],
    { provider: net, contractType: 'p2sh32' });
  const terms: TokenPairGraduationTermsV1 = {
    lockedBaseScript: lockedBase.lockingBytecode, lockedQuoteScript: lockedQuote.lockingBytecode,
    creatorBaseScript: ownedBase.lockingBytecode, creatorQuoteScript: ownedQuote.lockingBytecode,
    archiveScript: archive.lockingBytecode,
    collectorScripts: collectors.map((collector) => collector.lockingBytecode) as [string, string, string],
    lockedBps, marketCarrierSats: 1_000n, collectorCarrierSats: 1_000n,
  };
  const hashes = [terms.lockedBaseScript, terms.lockedQuoteScript, terms.creatorBaseScript,
    terms.creatorQuoteScript, terms.archiveScript, ...terms.collectorScripts].map((script) => `0x${h(hexToBin(script))}`);
  const q = new Contract(QUOTE, [`0x${catVm(TOKEN_A)}`, `0x${catVm(TOKEN_B)}`,
    `0x${le(1_000n, 8)}`, `0x${le(500_003n, 8)}`,
    `0x${le(100_000n, 8)}`, `0x${le(1_000_000n, 8)}`, `0x${le(1_000n, 8)}`,
    `0x${le(BigInt(lockedBps), 2)}`, `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`, ...hashes,
    `0x${le(marketBid, 8)}`, `0x${le(1n, 8)}`, `0x${le(marketAsk, 8)}`, `0x${le(1n, 8)}`],
  { provider: net, contractType: 'p2sh32' });
  const b = new Contract(BASE, [`0x${catVm(TOKEN_A)}`, `0x${catVm(TOKEN_B)}`,
    `0x${binToHex(hash256(hexToBin(q.bytecode)))}`,
    `0x${le(100_000n, 8)}`, `0x${le(1_000_000n, 8)}`, `0x${le(500_003n, 8)}`,
    `0x${le(1_000n, 8)}`, `0x${le(50n, 2)}`, `0x${le(25n, 2)}`, `0x${le(25n, 2)}`,
    `0x${h(OWNER.lock)}`, `0x${h(TAKER.lock)}`, `0x${h(KEEPER.lock)}`,
    `0x${le(1_000n, 8)}`, `0x${le(BigInt(lockedBps), 2)}`,
    `0x${le(1_000n, 8)}`, `0x${le(1_000n, 8)}`, ...hashes,
    `0x${le(marketBid, 8)}`, `0x${le(1n, 8)}`, `0x${le(marketAsk, 8)}`, `0x${le(1n, 8)}`],
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
    marketScriptHash: h(lockOf(lockedBase)), curveFees: rights, marketFees: rights,
  };
  const base = utxo(b.lockingBytecode, 1_000n,
    nft(TOKEN_A, 'mutable', encodeCurveStateV1(terminal), 100_001n));
  const quote = utxo(q.lockingBytecode, 1_000n, { category: TOKEN_B, amount: 500_003n });
  const sponsor = utxo(TAKER.lock, 20_000n);
  const plan = planTokenPairGraduationV1(m, base, quote, sponsor, terms,
    tokenPairGraduationTermsHashV1(terms), 1_000n);
  return { b, q, base, quote, sponsor, plan, lockedBase, lockedQuote, ownedBase, ownedQuote, collectors };
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
const badPrice = build(fixture(9_000, 5n, 8n));
assert.notEqual(verify(badPrice), true);
assert.equal(inputMetrics(badPrice)[0]!.ok, false);
assert.equal(inputMetrics(badPrice)[1]!.ok, false);
const graduated = build(ninety);
const graduatedTxid = hashTransaction(encodeTransaction(graduated.transaction));
const marketBuy = tb();
marketBuy.addInput(utxo(ninety.lockedBase.lockingBytecode, 1_000n,
  { category: TOKEN_A, amount: 90_001n }, 0, graduatedTxid), ninety.lockedBase.unlock.buy());
marketBuy.addInput(utxo(ninety.lockedQuote.lockingBytecode, 1_000n,
  { category: TOKEN_B, amount: 450_003n }, 1, graduatedTxid), ninety.lockedQuote.unlock.buy());
for (let i = 0; i < 3; i++) marketBuy.addInput(utxo(ninety.collectors[i]!.lockingBytecode,
  1_000n, undefined, i + 5, graduatedTxid), ninety.collectors[i]!.unlock.accrue());
marketBuy.addInput(utxo(TAKER.lock, 5_000n, { category: TOKEN_B, amount: 80_240n }),
  TAKER.template.unlockP2PKH());
marketBuy.addOutput({ to: lockOf(ninety.lockedBase), amount: 1_000n,
  token: { category: TOKEN_A, amount: 80_001n } });
marketBuy.addOutput({ to: lockOf(ninety.lockedQuote), amount: 1_000n,
  token: { category: TOKEN_B, amount: 530_195n } });
for (const [i, amount] of [19n, 4n, 25n].entries()) marketBuy.addOutput({
  to: lockOf(ninety.collectors[i]!), amount: 1_000n,
  token: { category: TOKEN_B, amount },
});
marketBuy.addOutput({ to: TAKER.lock, amount: 1_000n,
  token: { category: TOKEN_A, amount: 10_000n } });
const marketBought = buildTx(marketBuy);
assert.equal(verify(marketBought), true);
const marketTxid = hashTransaction(encodeTransaction(marketBought.transaction));
for (const [i, amount] of [19n, 4n, 25n].entries()) {
  const claim = tb();
  const collector = ninety.collectors[i]!;
  claim.addInput(utxo(collector.lockingBytecode, 1_000n,
    { category: TOKEN_B, amount }, i + 2, marketTxid), collector.unlock.claim());
  claim.addInput(utxo(TAKER.lock, 5_000n), TAKER.template.unlockP2PKH());
  claim.addOutput({ to: lockOf(collector), amount: 1_000n });
  claim.addOutput({ to: [OWNER, TAKER, KEEPER][i]!.lock, amount: 1_000n,
    token: { category: TOKEN_B, amount } });
  claim.addOutput({ to: TAKER.lock, amount: 1_000n });
  assert.equal(verify(buildTx(claim)), true, `collector ${i} claim`);
}
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
console.log('Mesh Blaze paired graduation VM: 11 checks passed, including price-band rejection and linked market claims');
