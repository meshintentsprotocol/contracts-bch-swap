import assert from 'node:assert/strict';
import { binToHex, sha256 } from '@bitauth/libauth';
import { makeKey, net, utxo, verify } from '../../test/harness.js';
import { planFixedSupplyGenesis, planSeed } from '../src/genesis/plan.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';
import { encodeLaunchManifestV1, launchManifestHashV1, verifyGenesisAgainstManifestV1, type LaunchManifestV1 } from '../src/manifest/v1.js';

const CREATOR = makeKey(0x70);
const CURVE = makeKey(0x71);
const SALE = makeKey(0x72);
const scriptHash = (lock: Uint8Array) => binToHex(sha256.hash(lock));
const lock = (bytes: Uint8Array) => binToHex(bytes);
const fees = () => ({
  creator: { scriptHash: scriptHash(CREATOR.lock), bps: 50 },
  partner: { scriptHash: scriptHash(SALE.lock), bps: 25 },
  protocol: { scriptHash: scriptHash(CURVE.lock), bps: 25 },
});

function fixture() {
  const seed = planSeed(net, utxo(CREATOR.lock, 100_000n, undefined, 0, 'ab'.repeat(32)), CREATOR.template, 600n);
  const allocations = [
    { name: 'sale', amount: 200_000n, satoshis: 1_000n, lockingBytecode: lock(SALE.lock) },
    { name: 'curve', amount: 800_000n, satoshis: 1_000n, lockingBytecode: lock(CURVE.lock), nftCommitment: encodeCurveStateV1({ stage: 0, realQuote: 0n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n }) },
  ];
  const manifest: LaunchManifestV1 = {
    version: 1, tokenCategory: seed.category, quoteCategory: null,
    totalSupply: 1_000_000n, allocations,
    activationHeight: 400_000, alphaStartHeight: 399_900, alphaEndHeight: 399_999,
    presaleRoute: 'standalone', presaleScriptHash: scriptHash(SALE.lock),
    alphaModes: 3, alphaFixedScriptHash: scriptHash(CREATOR.lock), alphaBuyScriptHash: scriptHash(CURVE.lock),
    virtualBase: 2_000_000n, virtualQuote: 200_000n, graduationQuoteThreshold: 1_000_000n,
    lockedLiquidityBps: 9_000,
    curveScriptHash: scriptHash(CURVE.lock), quoteVaultScriptHash: '00'.repeat(32), quoteVaultCarrierSats: 0n,
    graduationScriptHash: scriptHash(SALE.lock), marketScriptHash: scriptHash(CREATOR.lock),
    curveFees: fees(), marketFees: fees(),
  };
  const genesis = planFixedSupplyGenesis(net, seed, CREATOR.template, 1_000_000n, allocations, 900n, lock(CREATOR.lock), undefined, launchManifestHashV1(manifest));
  return { genesis, manifest };
}

const cases: Array<[string, () => void]> = [
  ['manifest is deterministic regardless of allocation input order', () => {
    const { manifest } = fixture();
    assert.equal(launchManifestHashV1(manifest), '938a472796bc02c99b938c20aca1712c8301ff6c149c8c81903572a28cc76f6b');
    const reversed = { ...manifest, allocations: [...manifest.allocations].reverse() };
    assert.deepEqual(encodeLaunchManifestV1(manifest), encodeLaunchManifestV1(reversed));
    assert.equal(launchManifestHashV1(manifest), launchManifestHashV1(reversed));
  }],
  ['genesis allocations match manifest', () => {
    const { genesis, manifest } = fixture();
    verifyGenesisAgainstManifestV1(genesis, manifest);
  }],
  ['genesis publishes manifest commitment on chain', () => {
    const { genesis, manifest } = fixture();
    const hash = launchManifestHashV1(manifest);
    assert.equal(genesis.transaction.outputs.some((o) => binToHex(o.lockingBytecode) === `6a044d424c5a20${hash}`), true);
    assert.equal(verify(genesis), true);
  }],
  ['a different fee recipient changes the commitment', () => {
    const { manifest } = fixture();
    const changed = { ...manifest, marketFees: { ...manifest.marketFees, partner: { ...manifest.marketFees.partner, scriptHash: scriptHash(CREATOR.lock) } } };
    assert.notEqual(launchManifestHashV1(manifest), launchManifestHashV1(changed));
  }],
  ['changing curve state commitment changes manifest hash', () => {
    const { manifest } = fixture();
    const changed = { ...manifest, allocations: manifest.allocations.map((a) => a.name === 'curve' ? { ...a, nftCommitment: '01'.repeat(32) } : a) };
    assert.notEqual(launchManifestHashV1(manifest), launchManifestHashV1(changed));
  }],
  ['changing the precommitted presale route changes the hash', () => {
    const { manifest } = fixture();
    assert.notEqual(launchManifestHashV1(manifest), launchManifestHashV1({ ...manifest, presaleRoute: 'dbc' }));
  }],
  ['Alpha modes require matching script hashes', () => {
    const { manifest } = fixture();
    assert.throws(() => encodeLaunchManifestV1({ ...manifest, alphaModes: 1 }), /Alpha buy script must match mode/);
  }],
  ['a changed sale allocation fails genesis comparison', () => {
    const { genesis, manifest } = fixture();
    const changed = { ...manifest, allocations: manifest.allocations.map((a) => ({ ...a, amount: a.amount + (a.name === 'sale' ? 1n : -1n) })) };
    assert.throws(() => verifyGenesisAgainstManifestV1(genesis, changed), /manifest hash differs/);
  }],
  ['lock below 90 percent is rejected', () => {
    const { manifest } = fixture();
    assert.throws(() => encodeLaunchManifestV1({ ...manifest, lockedLiquidityBps: 8_999 }), /90..100 percent/);
  }],
  ['duplicate allocation names are rejected', () => {
    const { manifest } = fixture();
    const duplicate = { ...manifest, allocations: [manifest.allocations[0]!, { ...manifest.allocations[1]!, name: manifest.allocations[0]!.name }] };
    assert.throws(() => encodeLaunchManifestV1(duplicate), /unique/);
  }],
  ['Alpha window cannot extend past public activation', () => {
    const { manifest } = fixture();
    assert.throws(() => encodeLaunchManifestV1({ ...manifest, alphaEndHeight: 400_001 }), /Alpha window/);
  }],
  ['launch token cannot quote itself', () => {
    const { manifest } = fixture();
    assert.throws(() => encodeLaunchManifestV1({ ...manifest, quoteCategory: manifest.tokenCategory }), /must differ/);
  }],
  ['CashToken quote requires a committed paired vault and BCH carrier', () => {
    const { manifest } = fixture();
    const quoteCategory = '11'.repeat(32);
    assert.throws(() => encodeLaunchManifestV1({ ...manifest, quoteCategory }), /quote vault commitment/);
    const paired = { ...manifest, quoteCategory, quoteVaultScriptHash: scriptHash(SALE.lock), quoteVaultCarrierSats: 1_000n };
    assert.match(launchManifestHashV1(paired), /^[0-9a-f]{64}$/);
    assert.notEqual(launchManifestHashV1(paired), launchManifestHashV1({ ...paired, quoteVaultCarrierSats: 2_000n }));
    assert.notEqual(launchManifestHashV1(paired), launchManifestHashV1({ ...paired, quoteVaultScriptHash: scriptHash(CREATOR.lock) }));
    assert.throws(() => launchManifestHashV1({ ...paired, virtualBase: (1n << 63n) / paired.graduationQuoteThreshold }), /buy reserve product/);
  }],
  ['BCH quote forbids a phantom paired quote vault', () => {
    const { manifest } = fixture();
    assert.throws(() => encodeLaunchManifestV1({ ...manifest, quoteVaultScriptHash: scriptHash(SALE.lock) }), /quote vault commitment/);
    assert.throws(() => encodeLaunchManifestV1({ ...manifest, quoteVaultCarrierSats: 1_000n }), /quote vault commitment/);
  }],
];

let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}:`, error); }
}
console.log(`Mesh Blaze manifest: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
