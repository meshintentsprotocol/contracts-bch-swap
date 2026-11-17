import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { KEEPER, OWNER, TAKER, TOKEN_A, TOKEN_B, catVm, le, net, nft, tb, utxo, buildTx, verify, lockOf } from '../../test/harness.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';

const artifact = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const CURVE = artifact('blaze/artifacts/MeshBlazeBchCurveV2Prototype.json');
const LOCKED = artifact('artifacts/variants/MeshBinV4Locked.json');
const CREATOR = artifact('artifacts/MeshBinV4.json');
const h = (bytes: Uint8Array) => binToHex(sha256.hash(bytes));
const state = encodeCurveStateV1({ stage: 1, realQuote: 500_003n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n });
function bin(a: object, ownerCat: string) {
  return new Contract(a as any, [`0x${catVm(TOKEN_A)}`, `0x${le(7n, 8)}`, `0x${le(1n, 8)}`,
    `0x${le(8n, 8)}`, `0x${le(1n, 8)}`, `0x${catVm(ownerCat)}`,
    `0x${'00'.repeat(32)}`, `0x${le(0n, 4)}`], { provider: net, contractType: 'p2sh32' });
}
const locked = bin(LOCKED, TOKEN_B);
const creator = bin(CREATOR, '11'.repeat(32));
function curveFor(lockBps: bigint) { return new Contract(CURVE, [`0x${catVm(TOKEN_A)}`, `0x${le(100_000n, 8)}`,
  `0x${le(1_000_000n, 8)}`, `0x${le(500_003n, 8)}`, `0x${le(1_000n, 8)}`,
  `0x${le(50n, 2)}`, `0x${le(25n, 2)}`, `0x${le(25n, 2)}`,
  `0x${h(OWNER.lock)}`, `0x${h(TAKER.lock)}`, `0x${h(KEEPER.lock)}`,
  `0x${h(lockOf(locked))}`, `0x${h(lockOf(creator))}`, `0x${h(KEEPER.lock)}`, `0x${le(lockBps, 2)}`,
], { provider: net, contractType: 'p2sh32' }); }
const curve = curveFor(9_000n);

function spend(tamper: 'none' | 'lockedScript' | 'base' | 'quote' | 'archive' | 'sponsor' | 'fees' | 'stage' = 'none') {
  const s = tamper === 'fees' ? encodeCurveStateV1({ stage: 1, realQuote: 500_003n,
    creatorFees: 1n, partnerFees: 0n, protocolFees: 0n }) : tamper === 'stage' ?
      encodeCurveStateV1({ stage: 0, realQuote: 500_003n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n }) : state;
  const b = tb();
  b.addInput(utxo(curve.lockingBytecode, tamper === 'fees' ? 501_004n : 501_003n,
    nft(TOKEN_A, 'mutable', s, 100_001n)), curve.unlock.graduate());
  b.addInput(utxo(OWNER.lock, 5_000n), OWNER.template.unlockP2PKH());
  b.addOutput({ to: tamper === 'lockedScript' ? TAKER.lock : lockOf(locked), amount: tamper === 'quote' ? 451_002n : 451_003n,
    token: { category: TOKEN_A, amount: tamper === 'base' ? 90_000n : 90_001n } });
  b.addOutput({ to: lockOf(creator), amount: 51_000n,
    token: { category: TOKEN_A, amount: tamper === 'base' ? 10_001n : 10_000n } });
  b.addOutput({ to: KEEPER.lock, amount: 1_000n, token: nft(TOKEN_A, 'mutable', tamper === 'archive' ? '01' : s) });
  b.addOutput({ to: tamper === 'sponsor' ? TAKER.lock : OWNER.lock, amount: 2_000n });
  return b;
}
function spendAll(tamper: 'none' | 'base' | 'quote' = 'none') {
  const all = curveFor(10_000n);
  const b = tb();
  b.addInput(utxo(all.lockingBytecode, 501_003n, nft(TOKEN_A, 'mutable', state, 100_001n)), all.unlock.graduateAll());
  b.addInput(utxo(OWNER.lock, 5_000n), OWNER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(locked), amount: tamper === 'quote' ? 501_002n : 501_003n,
    token: { category: TOKEN_A, amount: tamper === 'base' ? 100_000n : 100_001n } });
  b.addOutput({ to: KEEPER.lock, amount: 1_000n, token: nft(TOKEN_A, 'mutable', state) });
  b.addOutput({ to: OWNER.lock, amount: 3_000n });
  return b;
}
const cases: Array<[string, () => void]> = [
  ['completed curve funds V4 locked and creator bins', () => assert.equal(verify(buildTx(spend())), true)],
  ['locked bin substitution fails at curve input', () => assert.match(verify(buildTx(spend('lockedScript'))) as string, /input index 0/i)],
  ['underlocked launch FT fails', () => assert.match(verify(buildTx(spend('base'))) as string, /input index 0/i)],
  ['underlocked BCH fails', () => assert.match(verify(buildTx(spend('quote'))) as string, /input index 0/i)],
  ['state NFT alteration fails', () => assert.match(verify(buildTx(spend('archive'))) as string, /input index 0/i)],
  ['sponsor change diversion fails', () => assert.match(verify(buildTx(spend('sponsor'))) as string, /input index 0/i)],
  ['unclaimed curve fee blocks graduation', () => assert.match(verify(buildTx(spend('fees'))) as string, /input index 0/i)],
  ['nonterminal stage blocks graduation', () => assert.match(verify(buildTx(spend('stage'))) as string, /input index 0/i)],
  ['100 percent lock funds one V4 locked bin', () => assert.equal(verify(buildTx(spendAll())), true)],
  ['100 percent lock rejects missing launch FT', () => assert.match(verify(buildTx(spendAll('base'))) as string, /input index 0/i)],
  ['100 percent lock rejects missing BCH', () => assert.match(verify(buildTx(spendAll('quote'))) as string, /input index 0/i)],
];
let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`PASS ${name}`); }
  catch (e) { failed++; console.error(`FAIL ${name}:`, e); }
}
console.log(`Mesh Blaze BCH graduation prototype VM: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
