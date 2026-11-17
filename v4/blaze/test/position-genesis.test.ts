import assert from 'node:assert/strict';
import { binToHex } from '@bitauth/libauth';
import { makeKey, net, utxo, verify } from '../../test/harness.js';
import { planSeed } from '../src/genesis/plan.js';
import { planCreatorPositionGenesis, verifyCreatorPositionGenesis } from '../src/graduation/position-genesis.js';

const creator = makeKey(0x71);
const other = makeKey(0x72);
const script = binToHex(creator.lock);
const commitment = '01' + 'ab'.repeat(32);
const seed = planSeed(net, utxo(creator.lock, 100_000n), creator.template, 600n);
const plan = planCreatorPositionGenesis(net, seed, creator.template, script, commitment, 900n, script);
assert.equal(verify(seed), true);
assert.equal(verify(plan), true);
assert.equal(plan.category, seed.category);
assert.equal(plan.transaction.outputs[0]!.token!.nft?.capability, 'none');
assert.equal(plan.transaction.outputs[0]!.token!.amount, 0n);
assert.equal(binToHex(plan.transaction.outputs[0]!.lockingBytecode), script);

function reject(edit: (tx: typeof plan.transaction) => void, pattern: RegExp) {
  const tx = structuredClone(plan.transaction);
  edit(tx);
  assert.throws(() => verifyCreatorPositionGenesis(tx, plan.sourceOutputs, seed.category, script, commitment), pattern);
}
reject((tx) => { tx.outputs[0]!.token!.nft!.capability = 'minting'; }, /non-minting/);
reject((tx) => { tx.outputs[0]!.token!.nft!.capability = 'mutable'; }, /non-minting/);
reject((tx) => { tx.outputs[0]!.lockingBytecode = other.lock; }, /creator/);
reject((tx) => { tx.outputs[0]!.token!.amount = 1n; }, /non-minting/);
reject((tx) => { tx.outputs[1]!.token = structuredClone(tx.outputs[0]!.token); }, /exactly one/);
reject((tx) => { tx.inputs[0]!.outpointIndex = 1; }, /seed output zero/);
assert.throws(() => verifyCreatorPositionGenesis(plan.transaction, [{ ...plan.sourceOutputs[0]!,
  token: plan.transaction.outputs[0]!.token }], seed.category, script, commitment), /token-free/);
console.log('creator position genesis: 9 assertions passed');
