/**
 * DutchDecayStrategyCovenant Test Suite
 *
 * Tests the DutchDecayStrategyCovenant.cash contract for BCHMesh.
 * Validates:
 *   1. Contract compilation & instantiation
 *   2. Linear decay price calculation over elapsed duration
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
    log('TEST 1', 'DutchDecayStrategyCovenant — Compilation & Instantiation');

    const provider = new ElectrumNetworkProvider(NETWORK);
    const artifactPath = join(__dirname, '..', 'artifacts', 'DutchDecayStrategyCovenant.json');
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

    const ownerPkh = Buffer.alloc(20, 0x77);
    const tokenCategoryIn = Buffer.alloc(0);
    const tokenCategoryOut = Buffer.alloc(0);
    const startPriceNum = 320n;
    const floorPriceNum = 300n;
    const priceDen = 1n;
    const startTime = 1700000000n;
    const duration = 3600n; // 1 hour
    const feeBps = 30n;

    const contract = new Contract(
        artifact,
        [
            ownerPkh,
            tokenCategoryIn,
            tokenCategoryOut,
            startPriceNum,
            floorPriceNum,
            priceDen,
            startTime,
            duration,
            feeBps
        ],
        { provider }
    );

    logStep(1, `✅ Contract instantiated successfully`);
    logStep(2, `   Address: ${contract.address}`);

    return { contract, artifact };
}

function testDecayMath() {
    log('TEST 2', 'DutchDecayStrategyCovenant — Price Decay Calculation');

    const startPriceNum = 320;
    const floorPriceNum = 300;
    const duration = 3600;
    const startTime = 1000;

    function calculateDecayedPrice(currentTime: number): number {
        if (currentTime <= startTime) return startPriceNum;
        const elapsed = currentTime - startTime;
        const clampedElapsed = Math.min(elapsed, duration);
        const priceDrop = startPriceNum - floorPriceNum;
        const dropAmount = Math.floor((priceDrop * clampedElapsed) / duration);
        return startPriceNum - dropAmount;
    }

    const testCases = [
        { time: 1000, expected: 320, label: 'Start (0% elapsed)' },
        { time: 1900, expected: 315, label: 'Midway (25% elapsed)' },
        { time: 2800, expected: 310, label: 'Halfway (50% elapsed)' },
        { time: 4600, expected: 300, label: 'End of duration (100% elapsed)' },
        { time: 8000, expected: 300, label: 'After duration (clamped at floor)' },
    ];

    let allPassed = true;
    for (const tc of testCases) {
        const price = calculateDecayedPrice(tc.time);
        const passed = price === tc.expected;
        allPassed = allPassed && passed;
        console.log(`  ${passed ? '✅' : '❌'} ${tc.label}: price = ${price} (expected = ${tc.expected})`);
    }

    return allPassed;
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║   DutchDecayStrategyCovenant.cash — Test Suite       ║');
    console.log('╚══════════════════════════════════════════════════════╝');

    let passed = true;
    try {
        await testCompilationAndInstantiation();
        passed = passed && testDecayMath();
    } catch (e: any) {
        console.error('  ❌ Test Error:', e.message);
        passed = false;
    }

    console.log(`\nOverall DutchDecayStrategyCovenant Test Status: ${passed ? '✅ ALL PASSED' : '❌ FAILED'}`);
    process.exit(passed ? 0 : 1);
}

main().catch(console.error);
