import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { TAKER, OWNER, KEEPER, TOKEN_A, catVm, le, net, tok, tb, utxo, buildTx, verify, inputMetrics } from '../../test/harness.js';
import { createVestingContract, type VestingTrancheTerms } from '../src/vesting/contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = JSON.parse(readFileSync(join(HERE, '..', 'artifacts', 'MeshBlazeVestingV1.json'), 'utf8'));

const TRANCHE_AMOUNT = 50_000n;
const UNLOCK_HEIGHT = 800_000;
const CARRIER_SATS = 1_500n;

function setupTranche(termsOverrides?: Partial<VestingTrancheTerms>) {
  const terms: VestingTrancheTerms = {
    tokenCategory: TOKEN_A,
    recipientLockingBytecode: binToHex(TAKER.lock),
    tokenAmount: TRANCHE_AMOUNT,
    unlockHeight: UNLOCK_HEIGHT,
    ...termsOverrides,
  };
  const contract = createVestingContract(ARTIFACT, terms, net);
  return { terms, contract };
}

// 1. Honest claim at or after unlock height
{
  const { terms, contract } = setupTranche();
  const trancheUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, tok(TRANCHE_AMOUNT, TOKEN_A));
  const sponsorUtxo = utxo(OWNER.lock, 10_000n);

  const b = tb();
  b.addInput(trancheUtxo, contract.unlock.release());
  b.addInput(sponsorUtxo, OWNER.template.unlockP2PKH());
  b.addOutput({ to: TAKER.lock, amount: CARRIER_SATS, token: tok(TRANCHE_AMOUNT, TOKEN_A) });
  b.addOutput({ to: OWNER.lock, amount: 10_000n - 1_000n });
  b.setLocktime(UNLOCK_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Honest vesting claim must pass VM');
  const metric = inputMetrics(built)[0]!;
  console.log(`PASS honest vesting claim passes BCH VM`);
  console.log(`COST vesting release: ${built.size} bytes, ${metric.opCost}/${metric.maxOpCost} op cost`);
}

// 2. Early claim rejected
{
  const { terms, contract } = setupTranche();
  const trancheUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, tok(TRANCHE_AMOUNT, TOKEN_A));
  const sponsorUtxo = utxo(OWNER.lock, 10_000n);

  const b = tb();
  b.addInput(trancheUtxo, contract.unlock.release());
  b.addInput(sponsorUtxo, OWNER.template.unlockP2PKH());
  b.addOutput({ to: TAKER.lock, amount: CARRIER_SATS, token: tok(TRANCHE_AMOUNT, TOKEN_A) });
  b.addOutput({ to: OWNER.lock, amount: 9_000n });
  b.setLocktime(UNLOCK_HEIGHT - 1);

  const built = buildTx(b);
  const result = verify(built);
  assert.notEqual(result, true, 'Early vesting claim must fail');
  console.log('PASS early claim rejected before unlock height');
}

// 3. Changed recipient rejected
{
  const { terms, contract } = setupTranche();
  const trancheUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, tok(TRANCHE_AMOUNT, TOKEN_A));
  const sponsorUtxo = utxo(OWNER.lock, 10_000n);

  const b = tb();
  b.addInput(trancheUtxo, contract.unlock.release());
  b.addInput(sponsorUtxo, OWNER.template.unlockP2PKH());
  // Redirection: tokens sent to KEEPER instead of TAKER
  b.addOutput({ to: KEEPER.lock, amount: CARRIER_SATS, token: tok(TRANCHE_AMOUNT, TOKEN_A) });
  b.addOutput({ to: OWNER.lock, amount: 9_000n });
  b.setLocktime(UNLOCK_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.notEqual(result, true, 'Redirection to unauthorized recipient must fail');
  console.log('PASS redirected recipient rejected');
}

// 4. Under-payout rejected
{
  const { terms, contract } = setupTranche();
  const trancheUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, tok(TRANCHE_AMOUNT, TOKEN_A));
  const sponsorUtxo = utxo(OWNER.lock, 10_000n);

  const b = tb();
  b.addInput(trancheUtxo, contract.unlock.release());
  b.addInput(sponsorUtxo, OWNER.template.unlockP2PKH());
  b.addOutput({ to: TAKER.lock, amount: CARRIER_SATS, token: tok(TRANCHE_AMOUNT - 1n, TOKEN_A) });
  b.addOutput({ to: OWNER.lock, amount: 9_000n });
  b.setLocktime(UNLOCK_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.notEqual(result, true, 'Under-paying tokens must fail');
  console.log('PASS partial token claim rejected');
}

// 5. Category substitution rejected
{
  const { terms, contract } = setupTranche();
  const FAKE_TOKEN = '11'.repeat(32);
  const trancheUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, tok(TRANCHE_AMOUNT, TOKEN_A));
  const sponsorUtxo = utxo(OWNER.lock, 10_000n);

  const b = tb();
  b.addInput(trancheUtxo, contract.unlock.release());
  b.addInput(sponsorUtxo, OWNER.template.unlockP2PKH());
  b.addOutput({ to: TAKER.lock, amount: CARRIER_SATS, token: tok(TRANCHE_AMOUNT, FAKE_TOKEN) });
  b.addOutput({ to: OWNER.lock, amount: 9_000n });
  b.setLocktime(UNLOCK_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.notEqual(result, true, 'Substituted token category must fail');
  console.log('PASS substituted token category rejected');
}

// 6. Carrier siphoning rejected
{
  const { terms, contract } = setupTranche();
  const trancheUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, tok(TRANCHE_AMOUNT, TOKEN_A));
  const sponsorUtxo = utxo(OWNER.lock, 10_000n);

  const b = tb();
  b.addInput(trancheUtxo, contract.unlock.release());
  b.addInput(sponsorUtxo, OWNER.template.unlockP2PKH());
  // Siphoned carrier: output only gets 1000 sats instead of 1500
  b.addOutput({ to: TAKER.lock, amount: CARRIER_SATS - 500n, token: tok(TRANCHE_AMOUNT, TOKEN_A) });
  b.addOutput({ to: OWNER.lock, amount: 9_500n });
  b.setLocktime(UNLOCK_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.notEqual(result, true, 'Siphoning carrier satoshis must fail');
  console.log('PASS carrier siphoning rejected');
}

// 7. Multi-tranche batched claim in single transaction
{
  const { terms: t1, contract: c1 } = setupTranche({ tokenAmount: 20_000n, unlockHeight: 800_000 });
  const { terms: t2, contract: c2 } = setupTranche({ tokenAmount: 30_000n, unlockHeight: 800_000 });

  const u1 = utxo(c1.lockingBytecode, CARRIER_SATS, tok(20_000n, TOKEN_A));
  const u2 = utxo(c2.lockingBytecode, CARRIER_SATS, tok(30_000n, TOKEN_A));
  const sponsor = utxo(OWNER.lock, 10_000n);

  const b = tb();
  b.addInput(u1, c1.unlock.release());
  b.addInput(u2, c2.unlock.release());
  b.addInput(sponsor, OWNER.template.unlockP2PKH());

  // Output 0 corresponds to Input 0
  b.addOutput({ to: TAKER.lock, amount: CARRIER_SATS, token: tok(20_000n, TOKEN_A) });
  // Output 1 corresponds to Input 1
  b.addOutput({ to: TAKER.lock, amount: CARRIER_SATS, token: tok(30_000n, TOKEN_A) });
  // Output 2 is sponsor change
  b.addOutput({ to: OWNER.lock, amount: 10_000n - 1_200n });
  b.setLocktime(UNLOCK_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Batched multi-tranche claim must pass VM');
  console.log('PASS multi-tranche batched claim passes BCH VM');
}

console.log('Mesh Blaze Vesting VM: 7 passed, 0 failed');
