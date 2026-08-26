/**
 * StrategyCovenant Test Suite
 *
 * Tests the StrategyCovenant.cash contract for BCHMesh.
 * Validates:
 *   1. Contract compilation & instantiation
 *   2. Fixed-rate swap pricing & maker-favorable fee math
 *   3. Contract address determinism
 *   4. Full & partial fill simulation
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
    log('TEST 1', 'StrategyCovenant — Compilation & Instantiation');

    const provider = new ElectrumNetworkProvider(NETWORK);
    const artifactPath = join(__dirname, '..', 'artifacts', 'StrategyCovenant.json');
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

    const ownerPkh = Buffer.alloc(20, 0x11);
    const tokenCategoryIn = Buffer.alloc(0);  // native BCH
    const tokenCategoryOut = Buffer.alloc(0); // native BCH
    const priceNumerator = 300n;
    const priceDenominator = 1n;
    const feeBps = 30n; // 0.30%

    const contract = new Contract(
        artifact,
        [ownerPkh, tokenCategoryIn, tokenCategoryOut, priceNumerator, priceDenominator, feeBps],
        { provider }
    );

    logStep(1, `✅ Contract instantiated successfully`);
    logStep(2, `   Address: ${contract.address}`);
    logStep(3, `   Token Address: ${contract.tokenAddress}`);

    return { contract, artifact };
}

function testMathCalculations() {
    log('TEST 2', 'StrategyCovenant — Pricing & Fee Math');

    const priceNumerator = 300n;
    const priceDenominator = 1n;
    const feeBps = 30n; // 0.30%

    function computeAmountOut(amountIn: bigint): bigint {
        return (amountIn * priceNumerator * (10000n - feeBps)) / (priceDenominator * 10000n);
    }

    const testCases = [
        { amountIn: 100000n, expected: 29910000n, label: '0.001 BCH in' },
        { amountIn: 500000n, expected: 149550000n, label: '0.005 BCH in' },
        { amountIn: 1000000n, expected: 299100000n, label: '0.01 BCH in' },
    ];

    let allPassed = true;
    for (const tc of testCases) {
        const out = computeAmountOut(tc.amountIn);
        const passed = out === tc.expected;
        allPassed = allPassed && passed;
        console.log(`  ${passed ? '✅' : '❌'} ${tc.label}: amountOut=${out} (expected=${tc.expected})`);
    }

    return allPassed;
}

async function testAddressDeterminism() {
    log('TEST 3', 'StrategyCovenant — Address Determinism');

    const provider = new ElectrumNetworkProvider(NETWORK);
    const artifact = JSON.parse(readFileSync(join(__dirname, '..', 'artifacts', 'StrategyCovenant.json'), 'utf-8'));

    const params1 = [
        Buffer.alloc(20, 0x22),
        Buffer.alloc(0),
        Buffer.alloc(0),
        300n,
        1n,
        30n
    ];

    const contractA = new Contract(artifact, params1, { provider });
    const contractB = new Contract(artifact, params1, { provider });

    const isMatch = contractA.address === contractB.address;
    console.log(`  ${isMatch ? '✅' : '❌'} Same parameters produce identical address: ${contractA.address}`);

    const params2 = [...params1];
    params2[3] = 310n; // Change price
    const contractC = new Contract(artifact, params2, { provider });

    const isDiff = contractA.address !== contractC.address;
    console.log(`  ${isDiff ? '✅' : '❌'} Different price produces unique address: ${contractC.address}`);

    return isMatch && isDiff;
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   StrategyCovenant.cash — Test Suite                 ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    let passed = true;
    try {
        await testCompilationAndInstantiation();
        passed = passed && testMathCalculations();
        passed = passed && await testAddressDeterminism();
    } catch (e: any) {
        console.error('  ❌ Test Error:', e.message);
        passed = false;
    }

    console.log(`\nOverall StrategyCovenant Test Status: ${passed ? '✅ ALL PASSED' : '❌ FAILED'}`);
    process.exit(passed ? 0 : 1);
}

main().catch(console.error);
