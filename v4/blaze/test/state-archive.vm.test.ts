import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Contract } from 'cashscript';
import { OWNER, TOKEN_A, net, nft, tb, utxo, buildTx, verify } from '../../test/harness.js';

const artifact = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeStateArchiveV1.json', 'utf8'));
const archive = new Contract(artifact, [], { provider: net, contractType: 'p2sh32' });
assert.equal(archive.bytecode, '00');
assert.equal(artifact.abi.length, 1);
const commitment = '0101' + '00'.repeat(32);
const builder = tb();
builder.addInput(utxo(archive.lockingBytecode, 1_000n,
  nft(TOKEN_A, 'mutable', commitment)), archive.unlock.archive());
builder.addInput(utxo(OWNER.lock, 5_000n), OWNER.template.unlockP2PKH());
builder.addOutput({ to: OWNER.lock, amount: 1_000n, token: nft(TOKEN_A, 'mutable', commitment) });
builder.addOutput({ to: OWNER.lock, amount: 4_000n });
const result = verify(buildTx(builder));
assert.equal(typeof result, 'string');
assert.match(result as string, /input index 0/i);
console.log('Mesh Blaze state archive: OP_0 bytecode and BCH VM spend rejection passed');
