import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { OWNER, TAKER, TOKEN_B, catVm, le, net, tb, utxo, buildTx, verify, lockOf, inputMetrics } from '../../test/harness.js';

const artifact = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeTokenFeeCollectorV1.json', 'utf8'));
const collector = new Contract(artifact, [`0x${catVm(TOKEN_B)}`,
  `0x${binToHex(sha256.hash(OWNER.lock))}`, `0x${le(1_000n, 8)}`],
{ provider: net, contractType: 'p2sh32' });
function accrue(tokenAmount = 10n, recipient = lockOf(collector), before = 0n) {
  const builder = tb();
  builder.addInput(utxo(collector.lockingBytecode, 1_000n,
    before > 0n ? { category: TOKEN_B, amount: before } : undefined), collector.unlock.accrue());
  builder.addInput(utxo(TAKER.lock, 3_000n, { category: TOKEN_B, amount: 10n }), TAKER.template.unlockP2PKH());
  builder.addOutput({ to: recipient, amount: 1_000n, token: { category: TOKEN_B, amount: tokenAmount } });
  builder.addOutput({ to: TAKER.lock, amount: 1_000n });
  return buildTx(builder);
}
function claim(recipient = OWNER.lock, amount = 10n, sponsorChange = 1_000n) {
  const builder = tb();
  builder.addInput(utxo(collector.lockingBytecode, 1_000n, { category: TOKEN_B, amount: 10n }), collector.unlock.claim());
  builder.addInput(utxo(TAKER.lock, 3_000n), TAKER.template.unlockP2PKH());
  builder.addOutput({ to: lockOf(collector), amount: 1_000n });
  builder.addOutput({ to: recipient, amount: 1_000n, token: { category: TOKEN_B, amount } });
  builder.addOutput({ to: TAKER.lock, amount: sponsorChange });
  return buildTx(builder);
}
function rejectedAtCollector(tx: ReturnType<typeof buildTx>) {
  assert.notEqual(verify(tx), true);
  assert.equal(inputMetrics(tx)[0]!.ok, false);
}
assert.equal(verify(accrue()), true);
assert.equal(verify(claim()), true);
rejectedAtCollector(accrue(9n, lockOf(collector), 10n));
rejectedAtCollector(accrue(10n, OWNER.lock));
rejectedAtCollector(claim(TAKER.lock));
rejectedAtCollector(claim(OWNER.lock, 9n));
rejectedAtCollector(claim(OWNER.lock, 10n, 2_500n));
console.log('Mesh Blaze quote-token fee collector VM: 7 checks passed');
