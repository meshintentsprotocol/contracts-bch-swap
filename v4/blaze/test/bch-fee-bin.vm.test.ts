import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { KEEPER, OWNER, TAKER, TOKEN_A, le, catVm, net, tb, utxo, buildTx, verify, lockOf, inputMetrics } from '../../test/harness.js';

const BIN = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeBchFeeBinLockedV1.json', 'utf8'));
const COLLECTOR = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeBchFeeCollectorV1.json', 'utf8'));
const hash = (bytes: Uint8Array) => binToHex(sha256.hash(bytes));
const collectors = [OWNER, TAKER, KEEPER].map((key) => new Contract(COLLECTOR,
  [`0x${hash(key.lock)}`, `0x${le(1_000n, 8)}`], { provider: net, contractType: 'p2sh32' }));
const bin = new Contract(BIN, [`0x${catVm(TOKEN_A)}`, `0x${le(7n, 8)}`, `0x${le(1n, 8)}`,
  `0x${le(8n, 8)}`, `0x${le(1n, 8)}`,
  ...collectors.map((c) => `0x${hash(lockOf(c))}`),
  `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`],
  { provider: net, contractType: 'p2sh32' });
type Tamper = 'none' | 'creatorFee' | 'partnerFee' | 'protocolFee' | 'binValue' | 'payout' | 'change' | 'collectorScript';
function buy(tamper: Tamper = 'none') {
  const b = tb();
  b.addInput(utxo(bin.lockingBytecode, 100_000n, { category: TOKEN_A, amount: 10_000n }), bin.unlock.buy());
  for (const c of collectors) b.addInput(utxo(c.lockingBytecode, 1_000n), c.unlock.accrue());
  b.addInput(utxo(TAKER.lock, 50_000n), TAKER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(bin), amount: tamper === 'binValue' ? 140_095n : 140_096n,
    token: { category: TOKEN_A, amount: 5_000n } });
  b.addOutput({ to: tamper === 'collectorScript' ? OWNER.lock : lockOf(collectors[0]!),
    amount: tamper === 'creatorFee' ? 1_008n : 1_009n });
  b.addOutput({ to: lockOf(collectors[1]!), amount: tamper === 'partnerFee' ? 1_001n : 1_002n });
  b.addOutput({ to: lockOf(collectors[2]!), amount: tamper === 'protocolFee' ? 1_012n : 1_013n });
  b.addOutput({ to: tamper === 'payout' ? OWNER.lock : TAKER.lock, amount: 1_000n,
    token: { category: TOKEN_A, amount: 5_000n } });
  b.addOutput({ to: tamper === 'change' ? OWNER.lock : TAKER.lock, amount: 7_880n });
  return b;
}
function sell(tamper: 'none' | 'creatorFee' | 'protocolFee' | 'binValue' | 'payout' = 'none') {
  const b = tb();
  b.addInput(utxo(bin.lockingBytecode, 108_019n, { category: TOKEN_A, amount: 9_000n }), bin.unlock.sell());
  b.addInput(utxo(collectors[0]!.lockingBytecode, 1_001n), collectors[0]!.unlock.accrue());
  b.addInput(utxo(collectors[1]!.lockingBytecode, 1_000n), collectors[1]!.unlock.accrue());
  b.addInput(utxo(collectors[2]!.lockingBytecode, 1_004n), collectors[2]!.unlock.accrue());
  b.addInput(utxo(TAKER.lock, 5_000n, { category: TOKEN_A, amount: 1_000n }), TAKER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(bin), amount: tamper === 'binValue' ? 101_034n : 101_035n,
    token: { category: TOKEN_A, amount: 10_000n } });
  b.addOutput({ to: lockOf(collectors[0]!), amount: tamper === 'creatorFee' ? 1_001n : 1_002n });
  b.addOutput({ to: lockOf(collectors[1]!), amount: 1_000n });
  b.addOutput({ to: lockOf(collectors[2]!), amount: tamper === 'protocolFee' ? 1_007n : 1_008n });
  b.addOutput({ to: tamper === 'payout' ? OWNER.lock : TAKER.lock, amount: 10_979n });
  return b;
}
function rejectAtBin(b: ReturnType<typeof buy> | ReturnType<typeof sell>) {
  const result = verify(buildTx(b));
  assert.equal(typeof result, 'string');
  assert.match(result as string, /input index 0/i);
}
const cases: Array<[string, () => void]> = [
  ['locked bin buy pays exact recipient fees and compounds LP share', () => {
    const built = buildTx(buy());
    assert.equal(verify(built), true);
    const metrics = inputMetrics(built);
    assert.ok(metrics.slice(0, 4).every((m) => m.ok));
    console.log(`COST fee-bin buy: ${built.size} bytes, bin ${metrics[0]!.opCost}/${metrics[0]!.maxOpCost}`);
  }],
  ['buy rejects missing creator fee', () => rejectAtBin(buy('creatorFee'))],
  ['buy rejects missing partner fee', () => rejectAtBin(buy('partnerFee'))],
  ['buy rejects missing protocol fee', () => rejectAtBin(buy('protocolFee'))],
  ['buy rejects reduced LP share', () => rejectAtBin(buy('binValue'))],
  ['buy rejects redirected token payout', () => rejectAtBin(buy('payout'))],
  ['buy rejects redirected buyer change', () => rejectAtBin(buy('change'))],
  ['buy rejects substituted collector script', () => rejectAtBin(buy('collectorScript'))],
  ['locked bin sell pays exact recipient fees and compounds LP share', () => {
    const built = buildTx(sell());
    assert.equal(verify(built), true);
    const metrics = inputMetrics(built);
    assert.ok(metrics.slice(0, 4).every((m) => m.ok));
    console.log(`COST fee-bin sell: ${built.size} bytes, bin ${metrics[0]!.opCost}/${metrics[0]!.maxOpCost}`);
  }],
  ['sell rejects missing creator fee', () => rejectAtBin(sell('creatorFee'))],
  ['sell rejects missing protocol fee', () => rejectAtBin(sell('protocolFee'))],
  ['sell rejects excessive BCH release', () => rejectAtBin(sell('binValue'))],
  ['sell rejects redirected BCH payout', () => rejectAtBin(sell('payout'))],
];
let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}:`, error); }
}
console.log(`Mesh Blaze BCH fee bin VM: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
