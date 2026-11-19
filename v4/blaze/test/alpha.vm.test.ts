import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { TAKER, OWNER, KEEPER, TOKEN_A, catVm, le, net, tok, nft, tb, utxo, buildTx, verify, lockOf } from '../../test/harness.js';
import {
  createAlphaFixedContract,
  encodeAlphaFixedState,
  type AlphaFixedTerms,
  createAlphaBuyContract,
  encodeAlphaBuyState,
  type AlphaBuyTerms,
} from '../src/alpha/contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_FIXED = JSON.parse(readFileSync(join(HERE, '..', 'artifacts', 'MeshBlazeAlphaFixedV1.json'), 'utf8'));
const ARTIFACT_BUY = JSON.parse(readFileSync(join(HERE, '..', 'artifacts', 'MeshBlazeAlphaBuyV1.json'), 'utf8'));

const CARRIER_SATS = 1_000n;
const START_HEIGHT = 800_000;
const END_HEIGHT = 801_000;
const EXPIRY_HEIGHT = 802_000;

// ============================================================================
// Mode A: Alpha Fixed Allocation Tests
// ============================================================================

function setupAlphaFixed(overrides?: Partial<AlphaFixedTerms>) {
  const terms: AlphaFixedTerms = {
    tokenCategory: TOKEN_A,
    totalSaleTokens: 100_000n,
    quotePricePerToken: 10_000n, // 1:1 ratio (1 sat per 1 token with 10k scaling)
    maxRaiseQuote: 100_000n,
    alphaStartHeight: START_HEIGHT,
    alphaEndHeight: END_HEIGHT,
    creatorLockingBytecode: binToHex(OWNER.lock),
    ...overrides,
  };
  const contract = createAlphaFixedContract(ARTIFACT_FIXED, terms, net);
  return { terms, contract };
}

// 1. Mode A: Honest deposit
{
  const { terms, contract } = setupAlphaFixed();
  const dep = 50_000n;
  const initial = encodeAlphaFixedState(0, 0n, 100_000n);
  const next = encodeAlphaFixedState(0, dep, 100_000n);

  const vaultUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, nft(TOKEN_A, 'mutable', initial, 100_000n));
  const userUtxo = utxo(TAKER.lock, dep + 5_000n);

  const b = tb();
  b.addInput(vaultUtxo, contract.unlock.deposit(le(dep, 8)));
  b.addInput(userUtxo, TAKER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS + dep, token: nft(TOKEN_A, 'mutable', next, 100_000n) });
  b.addOutput({ to: TAKER.lock, amount: 4_000n });
  b.setLocktime(START_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Alpha Mode A honest deposit must pass');
  console.log('PASS Alpha Mode A honest deposit passes BCH VM');
}

// 2. Mode A: Early deposit rejected
{
  const { terms, contract } = setupAlphaFixed();
  const dep = 50_000n;
  const initial = encodeAlphaFixedState(0, 0n, 100_000n);
  const next = encodeAlphaFixedState(0, dep, 100_000n);

  const vaultUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, nft(TOKEN_A, 'mutable', initial, 100_000n));
  const userUtxo = utxo(TAKER.lock, dep + 5_000n);

  const b = tb();
  b.addInput(vaultUtxo, contract.unlock.deposit(le(dep, 8)));
  b.addInput(userUtxo, TAKER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS + dep, token: nft(TOKEN_A, 'mutable', next, 100_000n) });
  b.addOutput({ to: TAKER.lock, amount: 4_000n });
  b.setLocktime(START_HEIGHT - 1); // Early

  const built = buildTx(b);
  const result = verify(built);
  assert.notEqual(result, true, 'Alpha Mode A early deposit must fail');
  console.log('PASS Alpha Mode A early deposit rejected');
}

// 3. Mode A: Settle proceeds to creator
{
  const { terms, contract } = setupAlphaFixed();
  const collected = 80_000n;
  const openCommit = encodeAlphaFixedState(0, collected, 100_000n);
  const settledCommit = encodeAlphaFixedState(1, collected, 100_000n);

  const vaultUtxo = utxo(contract.lockingBytecode, CARRIER_SATS + collected, nft(TOKEN_A, 'mutable', openCommit, 100_000n));
  const sponsorUtxo = utxo(OWNER.lock, 10_000n);

  const b = tb();
  b.addInput(vaultUtxo, contract.unlock.settle());
  b.addInput(sponsorUtxo, OWNER.template.unlockP2PKH());

  // Output 0: State moves to SETTLED (1), retains tokens & carrier
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS, token: nft(TOKEN_A, 'mutable', settledCommit, 100_000n) });
  // Output 1: Sends quote proceeds to creator (OWNER)
  b.addOutput({ to: OWNER.lock, amount: collected });
  // Output 2: Sponsor change
  b.addOutput({ to: OWNER.lock, amount: 10_000n - 1_200n });
  b.setLocktime(END_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Alpha Mode A settle must pass');
  console.log('PASS Alpha Mode A settle proceeds passes BCH VM');
}

// 4. Mode A: Claim tokens
{
  const { terms, contract } = setupAlphaFixed();
  const collected = 80_000n;
  const userDep = 40_000n; // Entitled to 40_000 tokens
  const settledCommit = encodeAlphaFixedState(1, collected, 100_000n);
  const nextCommit = encodeAlphaFixedState(1, collected, 100_000n - 40_000n);

  const vaultUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, nft(TOKEN_A, 'mutable', settledCommit, 100_000n));
  const sponsorUtxo = utxo(TAKER.lock, 10_000n);

  const b = tb();
  b.addInput(vaultUtxo, contract.unlock.claim(le(userDep, 8), binToHex(sha256.hash(TAKER.lock))));
  b.addInput(sponsorUtxo, TAKER.template.unlockP2PKH());

  // Output 0: Next state retains remaining tokens (60_000)
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS, token: nft(TOKEN_A, 'mutable', nextCommit, 60_000n) });
  // Output 1: Sends 40,000 tokens to TAKER
  b.addOutput({ to: TAKER.lock, amount: CARRIER_SATS, token: tok(40_000n, TOKEN_A) });
  // Output 2: Sponsor change
  b.addOutput({ to: TAKER.lock, amount: 10_000n - CARRIER_SATS - 1_000n });

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Alpha Mode A claim must pass');
  console.log('PASS Alpha Mode A claim passes BCH VM');
}

// ============================================================================
// Mode B: Alpha Bounded Curve Buy Tests
// ============================================================================

function setupAlphaBuy(overrides?: Partial<AlphaBuyTerms>) {
  const terms: AlphaBuyTerms = {
    tokenCategory: TOKEN_A,
    curveScriptHash: binToHex(sha256.hash(KEEPER.lock)), // Simulated authentic curve script
    maxGrossQuote: 200_000n,
    minTokenOutput: 50_000n,
    alphaStartHeight: START_HEIGHT,
    alphaEndHeight: END_HEIGHT,
    expiryHeight: EXPIRY_HEIGHT,
    ...overrides,
  };
  const contract = createAlphaBuyContract(ARTIFACT_BUY, terms, net);
  return { terms, contract };
}

// 5. Mode B: Deposit quote
{
  const { terms, contract } = setupAlphaBuy();
  const dep = 100_000n;
  const initial = encodeAlphaBuyState(0, 0n, 0n, 0n);
  const next = encodeAlphaBuyState(0, dep, 0n, 0n);

  const vaultUtxo = utxo(contract.lockingBytecode, CARRIER_SATS, nft(TOKEN_A, 'mutable', initial, 0n));
  const userUtxo = utxo(TAKER.lock, dep + 5_000n);

  const b = tb();
  b.addInput(vaultUtxo, contract.unlock.deposit(le(dep, 8)));
  b.addInput(userUtxo, TAKER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS + dep, token: nft(TOKEN_A, 'mutable', next, 0n) });
  b.addOutput({ to: TAKER.lock, amount: 4_000n });
  b.setLocktime(START_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Alpha Mode B deposit must pass');
  console.log('PASS Alpha Mode B deposit passes BCH VM');
}

// 6. Mode B: Claim pro-rata tokens and pro-rata unused quote refund
{
  const { terms, contract } = setupAlphaBuy();
  const totalDep = 150_000n;
  const tokensBought = 80_000n;
  const unusedQuote = 30_000n; // 120k spent, 30k unused

  const userDep = 75_000n; // 50% depositor
  const userTokens = (userDep * tokensBought) / totalDep; // 40_000 tokens
  const userRefund = (userDep * unusedQuote) / totalDep; // 15_000 sats

  const boughtCommit = encodeAlphaBuyState(1, totalDep, tokensBought, unusedQuote);
  const nextCommit = encodeAlphaBuyState(1, totalDep, tokensBought, unusedQuote);

  const vaultUtxo = utxo(contract.lockingBytecode, CARRIER_SATS + unusedQuote, nft(TOKEN_A, 'mutable', boughtCommit, tokensBought));
  const sponsorUtxo = utxo(TAKER.lock, 10_000n);

  const b = tb();
  b.addInput(vaultUtxo, contract.unlock.claim(le(userDep, 8), binToHex(sha256.hash(TAKER.lock))));
  b.addInput(sponsorUtxo, TAKER.template.unlockP2PKH());

  // Output 0: Next vault state
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS + (unusedQuote - userRefund), token: nft(TOKEN_A, 'mutable', nextCommit, tokensBought - userTokens) });
  // Output 1: Sends token share + quote refund to TAKER
  b.addOutput({ to: TAKER.lock, amount: CARRIER_SATS + userRefund, token: tok(userTokens, TOKEN_A) });
  // Output 2: Sponsor change
  b.addOutput({ to: TAKER.lock, amount: 10_000n - CARRIER_SATS - 1_000n });

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Alpha Mode B claim must pass');
  console.log('PASS Alpha Mode B pro-rata tokens + refund claim passes BCH VM');
}

// 7. Mode B: 100% refund on expiry
{
  const { terms, contract } = setupAlphaBuy();
  const totalDep = 100_000n;
  const userDep = 50_000n;

  const depositCommit = encodeAlphaBuyState(0, totalDep, 0n, 0n);

  const vaultUtxo = utxo(contract.lockingBytecode, CARRIER_SATS + totalDep, nft(TOKEN_A, 'mutable', depositCommit, 0n));
  const sponsorUtxo = utxo(TAKER.lock, 10_000n);

  const b = tb();
  b.addInput(vaultUtxo, contract.unlock.refund(le(userDep, 8), binToHex(sha256.hash(TAKER.lock))));
  b.addInput(sponsorUtxo, TAKER.template.unlockP2PKH());

  // Output 0: Vault state decrements quote
  b.addOutput({ to: lockOf(contract), amount: CARRIER_SATS + (totalDep - userDep), token: nft(TOKEN_A, 'mutable', depositCommit, 0n) });
  // Output 1: Exact 100% refund to user
  b.addOutput({ to: TAKER.lock, amount: userDep });
  // Output 2: Sponsor change
  b.addOutput({ to: TAKER.lock, amount: 10_000n - 1_000n });
  b.setLocktime(EXPIRY_HEIGHT);

  const built = buildTx(b);
  const result = verify(built);
  assert.equal(result, true, 'Alpha Mode B expiry refund must pass');
  console.log('PASS Alpha Mode B 100% expiry refund passes BCH VM');
}

console.log('Mesh Blaze Alpha VM: 7 passed, 0 failed');
