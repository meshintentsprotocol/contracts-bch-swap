import assert from 'node:assert/strict';
import { binToHex } from '@bitauth/libauth';
import { makeKey, net, utxo, verify } from '../../test/harness.js';
import { createBcmrPublication, planSeed, planFixedSupplyGenesis, verifyFixedSupplyGenesis, MAX_FT_SUPPLY } from '../src/genesis/plan.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';
import { verifyBchLaunchGenesisCommitmentV1 } from '../src/graduation/launch-bundle.js';

const CREATOR = makeKey(0x69);
const CURVE = makeKey(0x6a);
const SALE = makeKey(0x6b);
const lock = (bytes: Uint8Array) => binToHex(bytes);

function makePlans() {
  const funding = utxo(CREATOR.lock, 100_000n);
  const seed = planSeed(net, funding, CREATOR.template, 600n);
  const allocations = [
    { name: 'curve', amount: 800_000n, satoshis: 1_000n, lockingBytecode: lock(CURVE.lock) },
    { name: 'presale', amount: 200_000n, satoshis: 1_000n, lockingBytecode: lock(SALE.lock) },
  ];
  const genesis = planFixedSupplyGenesis(net, seed, CREATOR.template, 1_000_000n, allocations, 900n, lock(CREATOR.lock));
  return { seed, genesis, allocations };
}

const cases: Array<[string, () => void]> = [
  ['genesis commits one exact launch bundle hash', () => {
    const { seed, allocations } = makePlans();
    const hash = 'ab'.repeat(32);
    const manifestHash = 'cd'.repeat(32);
    const genesis = planFixedSupplyGenesis(net, seed, CREATOR.template, 1_000_000n,
      allocations, 900n, lock(CREATOR.lock), undefined, manifestHash, 1, hash);
    assert.equal(verify(genesis), true);
    verifyBchLaunchGenesisCommitmentV1(genesis.transaction, hash);
    assert.equal(genesis.transaction.outputs.filter((o) => binToHex(o.lockingBytecode) === `6a044d424c5a20${manifestHash}`).length, 1);
    assert.throws(() => verifyBchLaunchGenesisCommitmentV1(genesis.transaction, 'ef'.repeat(32)), /lacks exact/);
    const duplicated = structuredClone(genesis.transaction);
    duplicated.outputs.push(structuredClone(duplicated.outputs.find((o) => binToHex(o.lockingBytecode).startsWith('6a044d424e44'))!));
    assert.throws(() => verifyBchLaunchGenesisCommitmentV1(duplicated, hash), /duplicate/);
  }],
  ['seed and genesis pass the BCH VM', () => {
    const { seed, genesis } = makePlans();
    assert.equal(verify(seed), true);
    assert.equal(verify(genesis), true);
    assert.equal(binToHex(genesis.transaction.inputs[0]!.outpointTransactionHash), seed.category);
    assert.equal(genesis.transaction.inputs[0]!.outpointIndex, 0);
  }],
  ['fixed supply and allocation destinations are exact', () => {
    const { seed, genesis } = makePlans();
    assert.equal(genesis.category, seed.category);
    assert.deepEqual(genesis.allocationIndexes, { curve: 0, presale: 1 });
    assert.equal(genesis.transaction.outputs[0]!.token!.amount, 800_000n);
    assert.equal(genesis.transaction.outputs[1]!.token!.amount, 200_000n);
    assert.equal(genesis.transaction.outputs.some((o) => o.token?.nft), false);
  }],
  ['same-category mutable state NFT can accompany curve FT without mint authority', () => {
    const { seed, allocations } = makePlans();
    const withState = [{ ...allocations[0]!, nftCommitment: encodeCurveStateV1({ stage: 0, realQuote: 0n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n }) }, allocations[1]!];
    const genesis = planFixedSupplyGenesis(net, seed, CREATOR.template, 1_000_000n, withState, 900n, lock(CREATOR.lock));
    assert.equal(verify(genesis), true);
    assert.equal(genesis.transaction.outputs[0]!.token!.nft?.capability, 'mutable');
    assert.equal(binToHex(genesis.transaction.outputs[0]!.token!.category), seed.category);
  }],
  ['state NFT on non-curve allocation is rejected', () => {
    const { seed, allocations } = makePlans();
    const withState = [allocations[0]!, { ...allocations[1]!, nftCommitment: '00'.repeat(32) }];
    assert.throws(() => planFixedSupplyGenesis(net, seed, CREATOR.template, 1_000_000n, withState, 900n, lock(CREATOR.lock)), /invalid mutable state NFT/);
  }],
  ['BCMR publication commits exact registry bytes in genesis', () => {
    const { seed, allocations } = makePlans();
    const publication = createBcmrPublication('{"name":"Mesh Blaze"}\n', 'https://example.org/bcmr.json');
    const genesis = planFixedSupplyGenesis(net, seed, CREATOR.template, 1_000_000n, allocations, 900n, lock(CREATOR.lock), publication.chunks);
    assert.equal(verify(genesis), true);
    assert.equal(genesis.transaction.outputs.some((o) => binToHex(o.lockingBytecode).includes(publication.registryHash)), true);
  }],
  ['BCMR publication rejects noncanonical and insecure URLs', () => {
    assert.throws(() => createBcmrPublication('{}', 'http://example.org/bcmr.json'), /canonical HTTPS/);
    assert.throws(() => createBcmrPublication('{}', 'https://example.org/bcmr.json#copy'), /canonical HTTPS/);
  }],
  ['wrong allocation sum is rejected', () => {
    const { seed, allocations } = makePlans();
    assert.throws(() => planFixedSupplyGenesis(net, seed, CREATOR.template, 1_000_001n, allocations, 900n, lock(CREATOR.lock)), /allocation sum/);
  }],
  ['seed fee below relay floor is rejected', () => {
    assert.throws(() => planSeed(net, utxo(CREATOR.lock, 100_000n), CREATOR.template, 1n), /seed fee below minimum/);
  }],
  ['genesis fee below relay floor is rejected', () => {
    const { seed, allocations } = makePlans();
    assert.throws(() => planFixedSupplyGenesis(net, seed, CREATOR.template, 1_000_000n, allocations, 1n, lock(CREATOR.lock)), /genesis fee below minimum/);
  }],
  ['a forged seed output amount is rejected', () => {
    const { seed, allocations } = makePlans();
    assert.throws(() => planFixedSupplyGenesis(net, { ...seed, outputSatoshis: seed.outputSatoshis + 10_000n }, CREATOR.template, 1_000_000n, allocations, 900n, lock(CREATOR.lock)), /seed output amount mismatch/);
  }],
  ['duplicate allocation names are rejected', () => {
    const { seed, allocations } = makePlans();
    assert.throws(() => planFixedSupplyGenesis(net, seed, CREATOR.template, 1_000_000n, [allocations[0]!, { ...allocations[1]!, name: 'curve' }], 900n, lock(CREATOR.lock)), /unique/);
  }],
  ['supply above CashToken limit is rejected', () => {
    const { seed, allocations } = makePlans();
    assert.throws(() => planFixedSupplyGenesis(net, seed, CREATOR.template, MAX_FT_SUPPLY + 1n, allocations, 900n, lock(CREATOR.lock)), /supply outside/);
  }],
  ['genesis with minting NFT is rejected by verifier', () => {
    const { seed, genesis, allocations } = makePlans();
    const tx = structuredClone(genesis.transaction);
    tx.outputs[0]!.token!.nft = { capability: 'minting', commitment: new Uint8Array() };
    assert.throws(() => verifyFixedSupplyGenesis(tx, genesis.sourceOutputs, 1_000_000n, allocations, seed.category), /NFT/);
  }],
  ['genesis with changed recipient is rejected by verifier', () => {
    const { seed, genesis, allocations } = makePlans();
    const tx = structuredClone(genesis.transaction);
    tx.outputs[0]!.lockingBytecode = SALE.lock;
    assert.throws(() => verifyFixedSupplyGenesis(tx, genesis.sourceOutputs, 1_000_000n, allocations, seed.category), /differs from plan/);
  }],
  ['genesis with wrong input index is rejected', () => {
    const { seed, genesis, allocations } = makePlans();
    const tx = structuredClone(genesis.transaction);
    tx.inputs[0]!.outpointIndex = 1;
    assert.throws(() => verifyFixedSupplyGenesis(tx, genesis.sourceOutputs, 1_000_000n, allocations, seed.category), /seed output 0/);
  }],
];

let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}:`, error); }
}
console.log(`Mesh Blaze genesis: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
