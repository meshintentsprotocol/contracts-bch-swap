import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { KEEPER, OWNER, TAKER, TOKEN_A, TOKEN_B, catVm, le, net } from '../../test/harness.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';
import { bchFeeMarketFromManifestV1, validateBchMarketArithmeticV1,
  type BchMarketTermsV1 } from '../src/market/bch-market.js';
import { bchGraduationCurveFromManifestV1 } from '../src/graduation/bch-curve-v2.js';
import { validateTerminalPriceArithmetic, checkTerminalPrice } from '../src/graduation/price-continuity.js';
import type { BchGraduationTermsV2 } from '../src/graduation/bch-handoff.js';
import type { LaunchManifestV1 } from '../src/manifest/v1.js';

const BIN = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeBchFeeBinLockedV1.json', 'utf8'));
const COLLECTOR = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeBchFeeCollectorV1.json', 'utf8'));
const OWNED = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeBchFeeBinOwnedV1.json', 'utf8'));
const CURVE_V2 = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeBchCurveV2Prototype.json', 'utf8'));
const ARCHIVE = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeStateArchiveV1.json', 'utf8'));
const archive = new Contract(ARCHIVE, [], { provider: net, contractType: 'p2sh32' });
const hash = (script: string) => binToHex(sha256.hash(hexToBin(script)));
const terms: BchMarketTermsV1 = { bidNum: 7n, bidDen: 1n, askNum: 8n, askDen: 1n,
  tradingFeeBps: 30, collectorCarrierSats: 1_000n };
function fixture(): LaunchManifestV1 {
  const zero = '00'.repeat(32);
  const curveRights = { creator: { scriptHash: hash(binToHex(OWNER.lock)), bps: 50 },
    partner: { scriptHash: hash(binToHex(TAKER.lock)), bps: 25 },
    protocol: { scriptHash: hash(binToHex(KEEPER.lock)), bps: 25 } };
  const marketRights = { creator: { scriptHash: curveRights.creator.scriptHash, bps: 800 },
    partner: { scriptHash: curveRights.partner.scriptHash, bps: 200 },
    protocol: { scriptHash: curveRights.protocol.scriptHash, bps: 1_000 } };
  const collectorScripts = [marketRights.creator, marketRights.partner, marketRights.protocol].map((right) =>
    new Contract(COLLECTOR, [`0x${right.scriptHash}`, `0x${le(1_000n, 8)}`],
      { provider: net, contractType: 'p2sh32' }).lockingBytecode);
  const marketBin = new Contract(BIN, [`0x${catVm(TOKEN_A)}`, `0x${le(7n, 8)}`, `0x${le(1n, 8)}`,
    `0x${le(8n, 8)}`, `0x${le(1n, 8)}`, ...collectorScripts.map((s) => `0x${hash(s)}`),
    `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`],
    { provider: net, contractType: 'p2sh32' });
  return {
    version: 1, tokenCategory: TOKEN_A, quoteCategory: null, totalSupply: 100_000n,
    allocations: [{ name: 'curve', amount: 100_000n, satoshis: 1_000n,
      lockingBytecode: binToHex(OWNER.lock),
      nftCommitment: encodeCurveStateV1({ stage: 0, realQuote: 0n,
        creatorFees: 0n, partnerFees: 0n, protocolFees: 0n }) }],
    activationHeight: 400_000, alphaStartHeight: 0, alphaEndHeight: 0,
    presaleRoute: null, presaleScriptHash: zero, alphaModes: 0,
    alphaFixedScriptHash: zero, alphaBuyScriptHash: zero,
    virtualBase: 100_000n, virtualQuote: 1_000_000n, graduationQuoteThreshold: 500_000n,
    lockedLiquidityBps: 9_000, curveScriptHash: hash(binToHex(OWNER.lock)),
    quoteVaultScriptHash: zero, quoteVaultCarrierSats: 0n,
    graduationScriptHash: hash(binToHex(KEEPER.lock)), marketScriptHash: hash(marketBin.lockingBytecode),
    curveFees: curveRights, marketFees: marketRights,
  };
}
const m = fixture();
const built = bchFeeMarketFromManifestV1(m, terms, BIN, COLLECTOR, net);
const owned = new Contract(OWNED, [`0x${catVm(TOKEN_A)}`, `0x${catVm('11'.repeat(32))}`,
  `0x${le(7n, 8)}`, `0x${le(1n, 8)}`, `0x${le(8n, 8)}`, `0x${le(1n, 8)}`,
  ...[built.creatorCollector, built.partnerCollector, built.protocolCollector].map((c) => `0x${hash(c.lockingBytecode)}`),
  `0x${le(30n, 2)}`, `0x${le(800n, 2)}`, `0x${le(200n, 2)}`, `0x${le(1_000n, 2)}`],
  { provider: net, contractType: 'p2sh32' });
assert.equal(hash(built.bin.lockingBytecode), m.marketScriptHash);
assert.equal(hash(built.creatorCollector.lockingBytecode),
  hash(new Contract(COLLECTOR, [`0x${m.marketFees.creator.scriptHash}`, `0x${le(1_000n, 8)}`],
    { provider: net, contractType: 'p2sh32' }).lockingBytecode));
assert.throws(() => bchFeeMarketFromManifestV1(m, { ...terms, tradingFeeBps: 31 }, BIN, COLLECTOR, net), /script differs/);
assert.throws(() => bchFeeMarketFromManifestV1(m, { ...terms, askNum: 9n }, BIN, COLLECTOR, net), /script differs/);
assert.throws(() => bchFeeMarketFromManifestV1(m, { ...terms, collectorCarrierSats: 2_000n }, BIN, COLLECTOR, net), /script differs/);
assert.throws(() => bchFeeMarketFromManifestV1({ ...m, marketFees: {
  ...m.marketFees, creator: { ...m.marketFees.creator, scriptHash: hash(binToHex(KEEPER.lock)) } } },
  terms, BIN, COLLECTOR, net), /script differs/);
assert.throws(() => bchFeeMarketFromManifestV1({ ...m, marketFees: {
  ...m.marketFees, partner: { ...m.marketFees.partner, bps: 201 } } },
  terms, BIN, COLLECTOR, net), /script differs/);
assert.throws(() => validateBchMarketArithmeticV1(m, { ...terms, bidNum: 9n }), /crossed price/);
assert.throws(() => validateBchMarketArithmeticV1(m, { ...terms, askNum: (1n << 63n) / m.totalSupply + 1n }), /supply times price/);
assert.throws(() => validateBchMarketArithmeticV1({ ...m, quoteCategory: TOKEN_B }, terms), /quote must be BCH/);
const grad: BchGraduationTermsV2 = {
  lockedBinScript: built.bin.lockingBytecode, creatorBinScript: owned.lockingBytecode,
  stateArchiveScript: archive.lockingBytecode, lockedPositionCategory: TOKEN_B,
  creatorPositionCategory: '11'.repeat(32), lockedBps: 9_000,
  collectorScripts: [built.creatorCollector.lockingBytecode, built.partnerCollector.lockingBytecode,
    built.protocolCollector.lockingBytecode], collectorCarrierSats: 1_000n,
};
const curveV2 = new Contract(CURVE_V2, [`0x${catVm(TOKEN_A)}`,
  `0x${le(m.virtualBase, 8)}`, `0x${le(m.virtualQuote, 8)}`,
  `0x${le(m.graduationQuoteThreshold, 8)}`, `0x${le(1_000n, 8)}`,
  `0x${le(50n, 2)}`, `0x${le(25n, 2)}`, `0x${le(25n, 2)}`,
  `0x${m.curveFees.creator.scriptHash}`, `0x${m.curveFees.partner.scriptHash}`,
  `0x${m.curveFees.protocol.scriptHash}`, `0x${hash(grad.lockedBinScript)}`,
  `0x${hash(grad.creatorBinScript)}`, `0x${hash(grad.stateArchiveScript)}`,
  `0x${le(9_000n, 2)}`, ...grad.collectorScripts.map((script) => `0x${hash(script)}`),
  `0x${le(1_000n, 8)}`, `0x${le(7n, 8)}`, `0x${le(1n, 8)}`,
  `0x${le(8n, 8)}`, `0x${le(1n, 8)}`], { provider: net, contractType: 'p2sh32' });
const mV2 = { ...m, curveScriptHash: hash(curveV2.lockingBytecode),
  allocations: [{ ...m.allocations[0]!, lockingBytecode: curveV2.lockingBytecode }] };
const linked = bchGraduationCurveFromManifestV1(mV2, terms, grad, CURVE_V2, BIN, COLLECTOR, OWNED, ARCHIVE, net);
assert.equal(linked.curve.lockingBytecode, curveV2.lockingBytecode);
assert.equal(linked.market.bin.lockingBytecode, grad.lockedBinScript);
assert.equal(linked.creatorBin.lockingBytecode, grad.creatorBinScript);
assert.equal(linked.archive.bytecode, '00');
validateTerminalPriceArithmetic(mV2, terms);
checkTerminalPrice(mV2, terms, 100_000n);
assert.throws(() => checkTerminalPrice(mV2, terms, 33_333n), /outside terminal/);
assert.throws(() => validateTerminalPriceArithmetic(mV2,
  { ...terms, bidDen: (1n << 63n) - 1n }), /exceeds signed VM/);
assert.throws(() => bchGraduationCurveFromManifestV1(mV2, terms,
  { ...grad, creatorBinScript: binToHex(TAKER.lock) }, CURVE_V2, BIN, COLLECTOR, OWNED, ARCHIVE, net), /creator destination/);
assert.throws(() => bchGraduationCurveFromManifestV1(mV2, terms,
  { ...grad, lockedBinScript: binToHex(TAKER.lock) }, CURVE_V2, BIN, COLLECTOR, OWNED, ARCHIVE, net), /locked destination/);
assert.throws(() => bchGraduationCurveFromManifestV1(mV2, terms,
  { ...grad, stateArchiveScript: binToHex(OWNER.lock) }, CURVE_V2, BIN, COLLECTOR, OWNED, ARCHIVE, net), /state archive/);
assert.throws(() => bchGraduationCurveFromManifestV1(mV2, terms,
  { ...grad, collectorCarrierSats: 2_000n }, CURVE_V2, BIN, COLLECTOR, OWNED, ARCHIVE, net), /collector destinations/);
console.log('Mesh Blaze BCH market and graduation constructors: 20 assertions passed');
