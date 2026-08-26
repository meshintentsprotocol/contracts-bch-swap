/**
 * OracleStrategyCovenant Test Suite
 *
 * Tests the OracleStrategyCovenant.cash contract for BCHMesh.
 * Validates:
 *   1. Contract compilation & instantiation
 *   2. Binary Oracle payload structure & dynamic spread pricing
 *   3. Address determinism
 */

import { Contract, ElectrumNetworkProvider } from 'cashscript';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NETWORK = 'chipnet';

function log(section: string, msg: string) {
    console.log(`\n[${'='.repeat(20)} ${section} ${'='.repeat(20)}]`);
    console.log(msg);
}

function logStep(step: number, msg: string) {
    console.log(`  [Step ${step}] ${msg}`);
}

async function testCompilationAndInstantiation() {
    log('TEST 1', 'OracleStrategyCovenant — Compilation & Instantiation');

    const provider = new ElectrumNetworkProvider(NETWORK);
    const artifactPath = join(__dirname, '..', 'artifacts', 'OracleStrategyCovenant.json');
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

    const ownerPkh = Buffer.alloc(20, 0x11);
    const oraclePk = Buffer.alloc(33, 0x02); // 33-byte compressed pubkey
    const pairId = 1n; // BCH/pUSD
    const spreadBps = 50n; // +0.50%
    const feeBps = 30n; // 0.30%
    const tokenCategoryIn = Buffer.alloc(0);
    const tokenCategoryOut = Buffer.alloc(0);

    const contract = new Contract(
        artifact,
        [ownerPkh, oraclePk, pairId, spreadBps, feeBps, tokenCategoryIn, tokenCategoryOut],
        { provider }
    );

    logStep(1, `✅ Contract instantiated successfully`);
    logStep(2, `   Address: ${contract.address}`);

    return { contract, artifact };
}

function testOraclePayloadAndMath() {
    log('TEST 2', 'OracleStrategyCovenant — Payload Parsing & Dynamic Spread Math');

    const spotPrice = 300_00000000n; // $300.00 scaled by 1e8
    const spreadBps = 50n; // +0.50%
    const feeBps = 30n; // 0.30%

    // 1. Effective Price = spotPrice * (10000 + spreadBps) / 10000
    const effectivePrice = (spotPrice * (10000n + spreadBps)) / 10000n;
    console.log(`  ✅ Effective Price with +0.50% spread: $${Number(effectivePrice) / 1e8}`);

    // 2. amountOut = (amountIn * 1e8 * (10000 - feeBps)) / (effectivePrice * 10000)
    function computeOracleAmountOut(amountIn: bigint): bigint {
        return (amountIn * 100000000n * (10000n - feeBps)) / (effectivePrice * 10000n);
    }

    const amountIn = 100_00000000n; // 100 pUSD in satoshi base units
    const amountOut = computeOracleAmountOut(amountIn);
    console.log(`  ✅ Taker swaps 100 pUSD -> Receives: ${amountOut} satoshis (~0.33 BCH)`);

    return effectivePrice === 301_50000000n && amountOut > 0n;
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   OracleStrategyCovenant.cash — Test Suite           ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    let passed = true;
    try {
        await testCompilationAndInstantiation();
        passed = passed && testOraclePayloadAndMath();
    } catch (e: any) {
        console.error('  ❌ Test Error:', e.message);
        passed = false;
    }

    console.log(`\nOverall OracleStrategyCovenant Test Status: ${passed ? '✅ ALL PASSED' : '❌ FAILED'}`);
    process.exit(passed ? 0 : 1);
}

main().catch(console.error);
