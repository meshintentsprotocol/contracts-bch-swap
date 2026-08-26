import { Contract, ElectrumNetworkProvider, SignatureTemplate } from 'cashscript';
import { ripemd160, sha256, hexToBin, binToHex, cashAddressToLockingBytecode } from '@bitauth/libauth';
import StrategyCovenantArtifact from '../../artifacts/StrategyCovenant.json' with { type: 'json' };
import OracleStrategyCovenantArtifact from '../../artifacts/OracleStrategyCovenant.json' with { type: 'json' };
import DutchDecayStrategyCovenantArtifact from '../../artifacts/DutchDecayStrategyCovenant.json' with { type: 'json' };
import MultiPairRecyclingCovenantArtifact from '../../artifacts/MultiPairRecyclingCovenant.json' with { type: 'json' };

export const reverseHex = (hex: string): string => {
  const clean = typeof hex === 'string' && hex.startsWith('0x') ? hex.slice(2) : String(hex || '');
  if (!clean || clean.length === 0) return '';
  const match = clean.match(/.{2}/g);
  return match ? match.reverse().join('') : clean;
};

export function toHex(input: string | Uint8Array | Buffer): string {
  if (typeof input === 'string') {
    return input.startsWith('0x') ? input.slice(2) : input;
  }
  if (input instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(input))) {
    return binToHex(new Uint8Array(input));
  }
  if (input && typeof input === 'object') {
    return binToHex(new Uint8Array(Object.values(input)));
  }
  return String(input || '');
}

export function toBytes(input: string | Uint8Array | Buffer): Uint8Array {
  if (typeof input === 'string') {
    const clean = input.startsWith('0x') ? input.slice(2) : input;
    return hexToBin(clean);
  }
  if (input instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(input))) {
    return new Uint8Array(input);
  }
  if (input && typeof input === 'object') {
    return new Uint8Array(Object.values(input));
  }
  return new Uint8Array(0);
}

export function derivePkh(pubKey: string | Uint8Array | Buffer): Uint8Array {
  const pkBytes = toBytes(pubKey);
  return ripemd160.hash(sha256.hash(pkBytes));
}

async function runTest() {
  console.log('🧪 Testing CashScript 0.12+ Contract Initialization & ABI Variables...\n');

  const testPkHex = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  const ownerPkh = derivePkh(testPkHex);
  console.log(`✅ Derived PKH: ${binToHex(ownerPkh)}`);

  // Provider
  const provider = new ElectrumNetworkProvider('chipnet');

  // 1. Straight Strategy
  const tokenInLE = '0x' + reverseHex('dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b');
  const tokenOutLE = '0x';
  const straightContract = new Contract(
    StrategyCovenantArtifact as any,
    [ownerPkh, tokenInLE, tokenOutLE, 300n, 1n, 30n],
    { provider }
  );
  console.log(`✅ StrategyCovenant Address: ${straightContract.address}`);
  console.log(`   Functions: ${Object.keys(straightContract.functions).join(', ')}`);

  // 2. Oracle Strategy
  const oraclePk = toBytes('02' + '00'.repeat(32));
  const oracleContract = new Contract(
    OracleStrategyCovenantArtifact as any,
    [ownerPkh, oraclePk, 1n, 50n, 30n, tokenInLE, tokenOutLE],
    { provider }
  );
  console.log(`✅ OracleStrategyCovenant Address: ${oracleContract.address}`);
  console.log(`   Functions: ${Object.keys(oracleContract.functions).join(', ')}`);

  // 3. Dutch Strategy
  const dutchContract = new Contract(
    DutchDecayStrategyCovenantArtifact as any,
    [ownerPkh, tokenInLE, tokenOutLE, 350n, 250n, 1n, BigInt(Math.floor(Date.now() / 1000)), 3600n, 30n],
    { provider }
  );
  console.log(`✅ DutchDecayStrategyCovenant Address: ${dutchContract.address}`);
  console.log(`   Functions: ${Object.keys(dutchContract.functions).join(', ')}`);

  console.log('\n🎉 ALL CASH SCRIPT CONTRACTS INITIALIZE AND BIND CLEANLY!');
  process.exit(0);
}

runTest().catch(console.error);
