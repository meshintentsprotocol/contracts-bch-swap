import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { KEEPER, OWNER, TAKER, TOKEN_A, TOKEN_B, catVm, le, net, nft, tb, utxo, buildTx, verify, lockOf } from '../../test/harness.js';

const OWNED = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeBchFeeBinOwnedV1.json', 'utf8'));
const COLLECTOR = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeBchFeeCollectorV1.json', 'utf8'));
const h = (bytes: Uint8Array) => binToHex(sha256.hash(bytes));
const collectors = [OWNER, TAKER, KEEPER].map((key) => new Contract(COLLECTOR,
  [`0x${h(key.lock)}`, `0x${le(1_000n, 8)}`], { provider: net, contractType: 'p2sh32' }));
const bin = new Contract(OWNED, [`0x${catVm(TOKEN_A)}`, `0x${catVm(TOKEN_B)}`,
  `0x${le(7n, 8)}`, `0x${le(1n, 8)}`, `0x${le(8n, 8)}`, `0x${le(1n, 8)}`,
  ...collectors.map((c) => `0x${h(lockOf(c))}`),
  `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`],
  { provider: net, contractType: 'p2sh32' });

function withdraw(ownerToken: 'valid' | 'wrong' | 'fungible') {
  const token = ownerToken === 'valid' ? nft(TOKEN_B, 'mutable', '01') :
    ownerToken === 'wrong' ? nft(TOKEN_A, 'mutable', '01') : { category: TOKEN_B, amount: 1n };
  const b = tb();
  b.addInput(utxo(bin.lockingBytecode, 10_000n, { category: TOKEN_A, amount: 1_000n }), bin.unlock.owner(1n));
  b.addInput(utxo(OWNER.lock, 1_000n, token), OWNER.template.unlockP2PKH());
  b.addOutput({ to: OWNER.lock, amount: 9_000n, token: { category: TOKEN_A, amount: 1_000n } });
  b.addOutput({ to: OWNER.lock, amount: 1_000n, token });
  return b;
}
function buy() {
  const b = tb();
  b.addInput(utxo(bin.lockingBytecode, 100_000n, { category: TOKEN_A, amount: 10_000n }), bin.unlock.buy());
  for (const c of collectors) b.addInput(utxo(c.lockingBytecode, 1_000n), c.unlock.accrue());
  b.addInput(utxo(TAKER.lock, 50_000n), TAKER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(bin), amount: 140_096n, token: { category: TOKEN_A, amount: 5_000n } });
  b.addOutput({ to: lockOf(collectors[0]!), amount: 1_009n });
  b.addOutput({ to: lockOf(collectors[1]!), amount: 1_002n });
  b.addOutput({ to: lockOf(collectors[2]!), amount: 1_013n });
  b.addOutput({ to: TAKER.lock, amount: 1_000n, token: { category: TOKEN_A, amount: 5_000n } });
  b.addOutput({ to: TAKER.lock, amount: 7_880n });
  return b;
}
const cases: Array<[string, () => void]> = [
  ['creator-owned bin trades with same three-way fee split', () => assert.equal(verify(buildTx(buy())), true)],
  ['position NFT holder withdraws only owned-bin principal', () => assert.equal(verify(buildTx(withdraw('valid'))), true)],
  ['wrong NFT category cannot withdraw', () => assert.match(verify(buildTx(withdraw('wrong'))) as string, /input index 0/i)],
  ['fungible position-category token cannot withdraw', () => assert.match(verify(buildTx(withdraw('fungible'))) as string, /input index 0/i)],
  ['accrued recipient fee remains claimable after owner exit', () => {
    const b = tb();
    b.addInput(utxo(collectors[0]!.lockingBytecode, 1_500n), collectors[0]!.unlock.claim());
    b.addInput(utxo(TAKER.lock, 5_000n), TAKER.template.unlockP2PKH());
    b.addOutput({ to: lockOf(collectors[0]!), amount: 1_000n });
    b.addOutput({ to: OWNER.lock, amount: 546n });
    b.addOutput({ to: TAKER.lock, amount: 3_954n });
    assert.equal(verify(buildTx(b)), true);
  }],
];
let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}:`, error); }
}
console.log(`Mesh Blaze creator-owned BCH fee bin VM: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
