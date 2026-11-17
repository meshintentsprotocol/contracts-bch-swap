import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { binToHex, hexToBin, sha256 } from '@bitauth/libauth';
import { Contract } from 'cashscript';
import { KEEPER, OWNER, TAKER, TOKEN_A, TOKEN_B, catVm, le, net } from '../../test/harness.js';
import { encodeCurveStateV1 } from '../src/curve/state.js';
import { bchFeeMarketFromManifestV1, validateBchMarketArithmeticV1,
  type BchMarketTermsV1 } from '../src/market/bch-market.js';
import type { LaunchManifestV1 } from '../src/manifest/v1.js';

const BIN = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeBchFeeBinLockedV1.json', 'utf8'));
const COLLECTOR = JSON.parse(readFileSync('blaze/artifacts/MeshBlazeBchFeeCollectorV1.json', 'utf8'));
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
console.log('Mesh Blaze BCH market constructor: 10 assertions passed');
