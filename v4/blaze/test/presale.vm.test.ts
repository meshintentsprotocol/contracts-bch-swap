import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { TAKER, OWNER, KEEPER, ATTACKER, TOKEN_A, catVm, le, net, tok, nft, tb, utxo, buildTx, verify, inputMetrics, lockOf } from '../../test/harness.js';
import { createPresaleContract, encodePresaleState, type PresaleTerms } from '../src/presale/contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = JSON.parse(readFileSync(join(HERE, '..', 'artifacts', 'MeshBlazePresaleV1.json'), 'utf8'));

const TOTAL_SALE_TOKENS = 1_000_000n;
const MIN_RAISE = 200_000n; // 200k sats
const MAX_RAISE = 500_000n; // 500k sats
const OPEN_HEIGHT = 800_000;
const CLOSE_HEIGHT = 805_000;
const CARRIER_SATS = 1_000n;

function setupPresale(overrides?: Partial<PresaleTerms>) {
  const terms: PresaleTerms = {
    tokenCategory: TOKEN_A,
    totalSaleTokens: TOTAL_SALE_TOKENS,
    minRaiseQuote: MIN_RAISE,
    maxRaiseQuote: MAX_RAISE,
    openHeight: OPEN_HEIGHT,
    closeHeight: CLOSE_HEIGHT,
    creatorLockingBytecode: binToHex(OWNER.lock),
    successDestinationLockingBytecode: binToHex(KEEPER.lock),
    ...overrides,
  };
  const contract = createPresaleContract(ARTIFACT, terms, net);
  return { terms, contract };
}

// 1. Honest contribution during open window
{
  const { terms, contract } = setupPresale();
  const contribAmount = 100_000n;
  const initialCommitment = encodePresaleState(0, 0n, TOTAL_SALE_TOKENS);
  const nextCommitment = encodePresaleState(0, contribAmount, TOTAL_SALE_TOKENS);

  const presaleUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, nft(TOKEN_A, 'mutable', initialCommitment, TOTAL_SALE_TOKENS));
  const userUtxo = utxo(TAKER.lock, contribAmount + 5_000n);

  const b = tb();
  b.addInput(presaleUtxo, contract.unlock.contribute(le(contribAmount, 8)));
  b.addInput(userUtxo, TAKER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS + contribAmount, token: nft(TOKEN_A, 'mutable', nextCommitment, TOTAL_SALE_TOKENS) });
  b.addOutput({ to: TAKER.lock, amount: 5_000n - 1_000n });
  b.setLocktime(OPEN_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Honest contribution must pass VM');
  console.log('PASS honest presale contribution passes BCH VM');
}

// 2. Contribution exceeding hard cap rejected
{
  const { terms, contract } = setupPresale();
  const contribAmount = MAX_RAISE + 1n; // Exceeds cap
  const initialCommitment = encodePresaleState(0, 0n, TOTAL_SALE_TOKENS);
  const nextCommitment = encodePresaleState(0, contribAmount, TOTAL_SALE_TOKENS);

  const presaleUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, nft(TOKEN_A, 'mutable', initialCommitment, TOTAL_SALE_TOKENS));
  const userUtxo = utxo(TAKER.lock, contribAmount + 5_000n);

  const b = tb();
  b.addInput(presaleUtxo, contract.unlock.contribute(le(contribAmount, 8)));
  b.addInput(userUtxo, TAKER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS + contribAmount, token: nft(TOKEN_A, 'mutable', nextCommitment, TOTAL_SALE_TOKENS) });
  b.addOutput({ to: TAKER.lock, amount: 4_000n });
  b.setLocktime(OPEN_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.notEqual(result, true, 'Contribution exceeding hard cap must fail');
  console.log('PASS contribution exceeding hard cap rejected');
}

// 3. Early contribution before openHeight rejected
{
  const { terms, contract } = setupPresale();
  const contribAmount = 50_000n;
  const initialCommitment = encodePresaleState(0, 0n, TOTAL_SALE_TOKENS);
  const nextCommitment = encodePresaleState(0, contribAmount, TOTAL_SALE_TOKENS);

  const presaleUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, nft(TOKEN_A, 'mutable', initialCommitment, TOTAL_SALE_TOKENS));
  const userUtxo = utxo(TAKER.lock, contribAmount + 5_000n);

  const b = tb();
  b.addInput(presaleUtxo, contract.unlock.contribute(le(contribAmount, 8)));
  b.addInput(userUtxo, TAKER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS + contribAmount, token: nft(TOKEN_A, 'mutable', nextCommitment, TOTAL_SALE_TOKENS) });
  b.addOutput({ to: TAKER.lock, amount: 4_000n });
  b.setLocktime(OPEN_HEIGHT - 1); // Before open

  const built = buildTx(b);
  const result = verify(built);
  assert.notEqual(result, true, 'Early contribution must fail');
  console.log('PASS early contribution rejected');
}

// 4. Finalize SUCCESS when collected >= minRaiseQuote
{
  const { terms, contract } = setupPresale();
  const collected = 300_000n; // Above MIN_RAISE (200k)
  const openCommitment = encodePresaleState(0, collected, TOTAL_SALE_TOKENS);
  const successCommitment = encodePresaleState(1, collected, TOTAL_SALE_TOKENS);

  const presaleUtxo = utxo(contract.lockingBytecode, CARRIER_SATS + collected, nft(TOKEN_A, 'mutable', openCommitment, TOTAL_SALE_TOKENS));
  const sponsorUtxo = utxo(OWNER.lock, 10_000n);

  const b = tb();
  b.addInput(presaleUtxo, contract.unlock.finalize());
  b.addInput(sponsorUtxo, OWNER.template.unlockP2PKH());

  // Output 0: Presale state moves to stage 1 (SUCCESS), keeping tokens and carrier
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS, token: nft(TOKEN_A, 'mutable', successCommitment, TOTAL_SALE_TOKENS) });
  // Output 1: Collected quote sent to success destination (KEEPER)
  b.addOutput({ to: KEEPER.lock, amount: collected });
  // Output 2: Sponsor change
  b.addOutput({ to: OWNER.lock, amount: 10_000n - 1_200n });
  b.setLocktime(CLOSE_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Finalize SUCCESS must pass VM');
  console.log('PASS finalize SUCCESS passes BCH VM');
}

// 5. Claim tokens after successful presale
{
  const { terms, contract } = setupPresale();
  const collected = 300_000n;
  const userContrib = 150_000n; // Contributed 50% of raise -> entitled to 500,000 tokens
  const tokenEntitlement = (userContrib * TOTAL_SALE_TOKENS) / collected; // 500,000n

  const successCommitment = encodePresaleState(1, collected, TOTAL_SALE_TOKENS);
  const nextCommitment = encodePresaleState(1, collected, TOTAL_SALE_TOKENS - tokenEntitlement);

  const presaleUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, nft(TOKEN_A, 'mutable', successCommitment, TOTAL_SALE_TOKENS));
  const sponsorUtxo = utxo(TAKER.lock, 10_000n);

  const b = tb();
  b.addInput(presaleUtxo, contract.unlock.claimTokens(le(userContrib, 8), binToHex(sha256.hash(TAKER.lock))));
  b.addInput(sponsorUtxo, TAKER.template.unlockP2PKH());

  // Output 0: Presale state retains remaining tokens (500,000n)
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS, token: nft(TOKEN_A, 'mutable', nextCommitment, TOTAL_SALE_TOKENS - tokenEntitlement) });
  // Output 1: Delivers entitlement tokens to TAKER
  b.addOutput({ to: TAKER.lock, amount: CARRIER_SATS, token: tok(tokenEntitlement, TOKEN_A) });
  // Output 2: Sponsor change
  b.addOutput({ to: TAKER.lock, amount: 10_000n - CARRIER_SATS - 1_000n });

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Token claim must pass VM');
  console.log('PASS token claim after SUCCESS passes BCH VM');
}

// 6. Finalize FAILED when collected < minRaiseQuote
{
  const { terms, contract } = setupPresale();
  const collected = 100_000n; // Below MIN_RAISE (200k)
  const openCommitment = encodePresaleState(0, collected, TOTAL_SALE_TOKENS);
  const failedCommitment = encodePresaleState(2, collected, 0n);

  const presaleUtxo = utxo(contract.lockingBytecode, CARRIER_SATS + collected, nft(TOKEN_A, 'mutable', openCommitment, TOTAL_SALE_TOKENS));
  const sponsorUtxo = utxo(OWNER.lock, 10_000n);

  const b = tb();
  b.addInput(presaleUtxo, contract.unlock.finalize());
  b.addInput(sponsorUtxo, OWNER.template.unlockP2PKH());

  // Output 0: Presale state moves to stage 2 (FAILED), keeps quote for refunds
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS + collected, token: nft(TOKEN_A, 'mutable', failedCommitment, 0n) });
  // Output 1: Unsold tokens returned to creator (OWNER)
  b.addOutput({ to: OWNER.lock, amount: CARRIER_SATS, token: tok(TOTAL_SALE_TOKENS, TOKEN_A) });
  // Output 2: Sponsor change
  b.addOutput({ to: OWNER.lock, amount: 10_000n - CARRIER_SATS - 1_200n });
  b.setLocktime(CLOSE_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Finalize FAILED must pass VM');
  console.log('PASS finalize FAILED passes BCH VM');
}

// 7. Claim exact refund after failed presale
{
  const { terms, contract } = setupPresale();
  const collected = 100_000n;
  const userContrib = 50_000n;

  const failedCommitment = encodePresaleState(2, collected, 0n);
  const nextCommitment = encodePresaleState(2, collected - userContrib, 0n);

  const presaleUtxo = utxo(contract.lockingBytecode, CARRIER_SATS + collected, nft(TOKEN_A, 'mutable', failedCommitment, 0n));
  const sponsorUtxo = utxo(TAKER.lock, 10_000n);

  const b = tb();
  b.addInput(presaleUtxo, contract.unlock.refund(le(userContrib, 8), binToHex(sha256.hash(TAKER.lock))));
  b.addInput(sponsorUtxo, TAKER.template.unlockP2PKH());

  // Output 0: Presale state retains remaining quote
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS + (collected - userContrib), token: nft(TOKEN_A, 'mutable', nextCommitment, 0n) });
  // Output 1: Exact quote refunded to TAKER
  b.addOutput({ to: TAKER.lock, amount: userContrib });
  // Output 2: Sponsor change
  b.addOutput({ to: TAKER.lock, amount: 10_000n - 1_000n });

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Quote refund must pass VM');
  console.log('PASS exact quote refund after FAILED passes BCH VM');
}

console.log('Mesh Blaze Presale VM: 7 passed, 0 failed');
