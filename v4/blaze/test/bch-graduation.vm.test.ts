import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { KEEPER, OWNER, TAKER, TOKEN_A, TOKEN_B, catVm, le, net, nft, tb, utxo, buildTx, verify, lockOf } from '../../test/harness.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';

const artifact = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const CURVE = artifact('blaze/artifacts/MeshBlazeBchCurveV2Prototype.json');
const COLLECTOR = artifact('blaze/artifacts/MeshBlazeBchFeeCollectorV1.json');
const FEE_BIN = artifact('blaze/artifacts/MeshBlazeBchFeeBinLockedV1.json');
const FEE_OWNED = artifact('blaze/artifacts/MeshBlazeBchFeeBinOwnedV1.json');
const ARCHIVE = artifact('blaze/artifacts/MeshBlazeStateArchiveV1.json');
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
const archive = new Contract(ARCHIVE, [], { provider: net, contractType: 'p2sh32' });
const collectors = [OWNER, TAKER, KEEPER].map((key) => new Contract(COLLECTOR,
  [`0x${h(key.lock)}`, `0x${le(1_000n, 8)}`], { provider: net, contractType: 'p2sh32' }));
const feeLocked = new Contract(FEE_BIN, [`0x${catVm(TOKEN_A)}`, `0x${le(7n, 8)}`, `0x${le(1n, 8)}`,
  `0x${le(8n, 8)}`, `0x${le(1n, 8)}`, ...collectors.map((c) => `0x${h(lockOf(c))}`),
  `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`],
  { provider: net, contractType: 'p2sh32' });
const feeCreator = new Contract(FEE_OWNED, [`0x${catVm(TOKEN_A)}`, `0x${catVm('11'.repeat(32))}`,
  `0x${le(7n, 8)}`, `0x${le(1n, 8)}`, `0x${le(8n, 8)}`, `0x${le(1n, 8)}`,
  ...collectors.map((c) => `0x${h(lockOf(c))}`),
  `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`],
  { provider: net, contractType: 'p2sh32' });
function curveFor(lockBps: bigint, lockedScript = lockOf(locked), creatorScript = lockOf(creator)) { return new Contract(CURVE, [`0x${catVm(TOKEN_A)}`, `0x${le(100_000n, 8)}`,
  `0x${le(1_000_000n, 8)}`, `0x${le(500_003n, 8)}`, `0x${le(1_000n, 8)}`,
  `0x${le(50n, 2)}`, `0x${le(25n, 2)}`, `0x${le(25n, 2)}`,
  `0x${h(OWNER.lock)}`, `0x${h(TAKER.lock)}`, `0x${h(KEEPER.lock)}`,
  `0x${h(lockedScript)}`, `0x${h(creatorScript)}`, `0x${h(lockOf(archive))}`, `0x${le(lockBps, 2)}`,
  ...collectors.map((c) => `0x${h(lockOf(c))}`), `0x${le(1_000n, 8)}`,
], { provider: net, contractType: 'p2sh32' }); }
const curve = curveFor(9_000n);

function spend(tamper: 'none' | 'lockedScript' | 'creatorScript' | 'base' | 'quote' | 'archive' | 'collector' | 'sponsor' | 'fees' | 'stage' = 'none', feeMarket = false) {
  const sourceCurve = feeMarket ? curveFor(9_000n, lockOf(feeLocked), lockOf(feeCreator)) : curve;
  const s = tamper === 'fees' ? encodeCurveStateV1({ stage: 1, realQuote: 500_003n,
    creatorFees: 1n, partnerFees: 0n, protocolFees: 0n }) : tamper === 'stage' ?
      encodeCurveStateV1({ stage: 0, realQuote: 500_003n, creatorFees: 0n, partnerFees: 0n, protocolFees: 0n }) : state;
  const b = tb();
  b.addInput(utxo(sourceCurve.lockingBytecode, tamper === 'fees' ? 501_004n : 501_003n,
    nft(TOKEN_A, 'mutable', s, 100_001n)), sourceCurve.unlock.graduate());
  b.addInput(utxo(OWNER.lock, 10_000n), OWNER.template.unlockP2PKH());
  b.addOutput({ to: tamper === 'lockedScript' ? TAKER.lock : feeMarket ? lockOf(feeLocked) : lockOf(locked), amount: tamper === 'quote' ? 451_002n : 451_003n,
    token: { category: TOKEN_A, amount: tamper === 'base' ? 90_000n : 90_001n } });
  b.addOutput({ to: tamper === 'creatorScript' ? TAKER.lock : feeMarket ? lockOf(feeCreator) : lockOf(creator), amount: 51_000n,
    token: { category: TOKEN_A, amount: tamper === 'base' ? 10_001n : 10_000n } });
  b.addOutput({ to: lockOf(archive), amount: 1_000n, token: nft(TOKEN_A, 'mutable', tamper === 'archive' ? '01' : s) });
  for (let i = 0; i < 3; i++) b.addOutput({ to: tamper === 'collector' && i === 0 ? OWNER.lock : lockOf(collectors[i]!), amount: 1_000n });
  b.addOutput({ to: tamper === 'sponsor' ? TAKER.lock : OWNER.lock, amount: 4_000n });
  return b;
}
function spendAll(tamper: 'none' | 'base' | 'quote' = 'none') {
  const all = curveFor(10_000n, lockOf(feeLocked), lockOf(feeCreator));
  const b = tb();
  b.addInput(utxo(all.lockingBytecode, 501_003n, nft(TOKEN_A, 'mutable', state, 100_001n)), all.unlock.graduateAll());
  b.addInput(utxo(OWNER.lock, 10_000n), OWNER.template.unlockP2PKH());
  b.addOutput({ to: lockOf(feeLocked), amount: tamper === 'quote' ? 501_002n : 501_003n,
    token: { category: TOKEN_A, amount: tamper === 'base' ? 100_000n : 100_001n } });
  b.addOutput({ to: lockOf(archive), amount: 1_000n, token: nft(TOKEN_A, 'mutable', state) });
  for (const c of collectors) b.addOutput({ to: lockOf(c), amount: 1_000n });
  b.addOutput({ to: OWNER.lock, amount: 5_000n });
  return b;
}
const cases: Array<[string, () => void]> = [
  ['completed curve funds V4 locked and creator bins', () => assert.equal(verify(buildTx(spend())), true)],
  ['completed curve atomically funds locked and owned fee bins plus three collectors', () => assert.equal(verify(buildTx(spend('none', true))), true)],
  ['locked bin substitution fails at curve input', () => assert.match(verify(buildTx(spend('lockedScript'))) as string, /input index 0/i)],
  ['creator bin substitution fails at curve input', () => assert.match(verify(buildTx(spend('creatorScript', true))) as string, /input index 0/i)],
  ['underlocked launch FT fails', () => assert.match(verify(buildTx(spend('base'))) as string, /input index 0/i)],
  ['underlocked BCH fails', () => assert.match(verify(buildTx(spend('quote'))) as string, /input index 0/i)],
  ['state NFT alteration fails', () => assert.match(verify(buildTx(spend('archive'))) as string, /input index 0/i)],
  ['collector substitution fails', () => assert.match(verify(buildTx(spend('collector'))) as string, /input index 0/i)],
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
