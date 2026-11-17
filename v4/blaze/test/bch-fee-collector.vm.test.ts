import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { KEEPER, OWNER, TAKER, le, net, tb, utxo, buildTx, verify, lockOf, inputMetrics } from '../../test/harness.js';

const ARTIFACT = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeBchFeeCollectorV1.json', 'utf8'));
const collector = new Contract(ARTIFACT, [`0x${binToHex(sha256.hash(KEEPER.lock))}`, `0x${le(1_000n, 8)}`],
  { provider: net, contractType: 'p2sh32' });

function accrue(tamper: 'none' | 'drain' | 'redirect' | 'token' = 'none') {
  const b = tb();
  b.addInput(utxo(collector.lockingBytecode, 1_000n), collector.unlock.accrue());
  b.addInput(utxo(OWNER.lock, 5_000n,
    tamper === 'token' ? { category: '11'.repeat(32), amount: 1n } : undefined), OWNER.template.unlockP2PKH());
  b.addOutput({ to: tamper === 'redirect' ? TAKER.lock : lockOf(collector), amount: tamper === 'drain' ? 999n : 2_000n,
    ...(tamper === 'token' ? { token: { category: '11'.repeat(32), amount: 1n } } : {}) });
  b.addOutput({ to: OWNER.lock, amount: 3_000n });
  return b;
}
function claim(tamper: 'none' | 'recipient' | 'amount' | 'sponsor' | 'tooSmall' = 'none') {
  const b = tb();
  const held = tamper === 'tooSmall' ? 1_500n : 2_000n;
  b.addInput(utxo(collector.lockingBytecode, held), collector.unlock.claim());
  b.addInput(utxo(OWNER.lock, 5_000n), OWNER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(collector), amount: 1_000n });
  b.addOutput({ to: tamper === 'recipient' ? TAKER.lock : KEEPER.lock,
    amount: tamper === 'amount' ? 999n : held - 1_000n });
  b.addOutput({ to: tamper === 'sponsor' ? TAKER.lock : OWNER.lock, amount: 4_000n });
  return b;
}
function rejectAtCollector(b: ReturnType<typeof accrue> | ReturnType<typeof claim>) {
  const result = verify(buildTx(b));
  assert.equal(typeof result, 'string');
  assert.match(result as string, /input index 0/i);
}
const cases: Array<[string, () => void]> = [
  ['anyone can add BCH and preserve collector script', () => {
    const built = buildTx(accrue());
    assert.equal(verify(built), true);
    const metric = inputMetrics(built)[0]!;
    console.log(`COST collector accrue: ${built.size} bytes, ${metric.opCost}/${metric.maxOpCost} op cost`);
  }],
  ['collector rejects principal drain', () => rejectAtCollector(accrue('drain'))],
  ['collector rejects redirected successor', () => rejectAtCollector(accrue('redirect'))],
  ['collector rejects token substitution', () => rejectAtCollector(accrue('token'))],
  ['whole accrued balance pays committed recipient', () => {
    const built = buildTx(claim());
    assert.equal(verify(built), true);
    const metric = inputMetrics(built)[0]!;
    console.log(`COST collector claim: ${built.size} bytes, ${metric.opCost}/${metric.maxOpCost} op cost`);
  }],
  ['claim rejects wrong recipient', () => rejectAtCollector(claim('recipient'))],
  ['claim rejects short payout', () => rejectAtCollector(claim('amount'))],
  ['claim rejects redirected sponsor change', () => rejectAtCollector(claim('sponsor'))],
  ['builder cannot create a dust-sized fee claim', () => assert.throws(() => claim('tooSmall'), /required minimum/)],
];
let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}:`, error); }
}
console.log(`Mesh Blaze BCH fee collector VM: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
