/**
 * MeshStrategyWithSurplusCapture — Unit Test Suite
 *
 * Tests the configurable Frontend/SDK surplus distribution mechanics.
 * Validates:
 *   1. Contract compilation & instantiation
 *   2. Surplus Math across Mode A (100% to User), Mode B (100% to Frontend), and Mode C (50/50 Split)
 *   3. Address Determinism & Parameter Isolation
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
    log('TEST 1', 'MeshStrategyWithSurplusCapture — Compilation & Instantiation');

    const provider = new ElectrumNetworkProvider(NETWORK);
    const artifactPath = join(__dirname, '..', 'artifacts', 'MeshStrategyWithSurplusCapture.json');
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf-8'));

    const ownerPkh = Buffer.alloc(20, 0x11);
    const protocolTreasuryPkh = Buffer.alloc(20, 0x99); // Treasury PKH
    const tokenCategoryIn = Buffer.alloc(0);  // native BCH
    const tokenCategoryOut = Buffer.alloc(0); // native BCH
    const priceNumerator = 304n;
    const priceDenominator = 1n;
    const lpFeeBps = 25n; // 0.25%

    const contract = new Contract(
        artifact,
        [ownerPkh, protocolTreasuryPkh, tokenCategoryIn, tokenCategoryOut, priceNumerator, priceDenominator, lpFeeBps],
        { provider }
    );

    logStep(1, `✅ Contract instantiated successfully`);
    logStep(2, `   Address: ${contract.address}`);
    logStep(3, `   Token Address: ${contract.tokenAddress}`);

    return { contract, artifact };
}

function testSurplusMathModes() {
    log('TEST 2', 'MeshStrategyWithSurplusCapture — Frontend/SDK Surplus Allocation Modes');

    const priceNumerator = 304n;
    const priceDenominator = 1n;
    const lpFeeBps = 25n; // 0.25%

    function computeSplit(amountIn: bigint, userQuotedMinOut: bigint, userSurplusShare: bigint) {
        const grossAmountOut = (amountIn * priceNumerator * (10000n - lpFeeBps)) / (priceDenominator * 10000n);
        const totalSurplus = grossAmountOut - userQuotedMinOut;
        const protocolShare = totalSurplus / 2n;
        const nonProtocolSurplus = totalSurplus - protocolShare;

        const frontendShare = nonProtocolSurplus - userSurplusShare;
        const finalUserPayout = userQuotedMinOut + userSurplusShare;

        return {
            grossAmountOut,
            totalSurplus,
            protocolShare,
            nonProtocolSurplus,
            frontendShare,
            finalUserPayout
        };
    }

    const testCases = [
        {
            label: 'Mode A: 100% Partner Surplus Passed to User (Full Positive Slippage)',
            amountIn: 10n,
            userQuotedMinOut: 3000n,
            userSurplusShare: 16n, // full 16 to user
            expectedGross: 3032n,
            expectedSurplus: 32n,
            expectedProtocol: 16n,
            expectedFrontend: 0n,
            expectedUserPayout: 3016n
        },
        {
            label: 'Mode B: 100% Partner Surplus Retained by Frontend (Monetized)',
            amountIn: 10n,
            userQuotedMinOut: 3000n,
            userSurplusShare: 0n,  // 0 to user, full 16 to frontend
            expectedGross: 3032n,
            expectedSurplus: 32n,
            expectedProtocol: 16n,
            expectedFrontend: 16n,
            expectedUserPayout: 3000n // user gets 100% of quote
        },
        {
            label: 'Mode C: 50/50 Split between User and Frontend (8 to User, 8 to Frontend)',
            amountIn: 10n,
            userQuotedMinOut: 3000n,
            userSurplusShare: 8n,  // half to user, half to frontend
            expectedGross: 3032n,
            expectedSurplus: 32n,
            expectedProtocol: 16n,
            expectedFrontend: 8n,
            expectedUserPayout: 3008n
        },
        {
            label: 'Zero Surplus Trade (Exact Fill)',
            amountIn: 10n,
            userQuotedMinOut: 3032n,
            userSurplusShare: 0n,
            expectedGross: 3032n,
            expectedSurplus: 0n,
            expectedProtocol: 0n,
            expectedFrontend: 0n,
            expectedUserPayout: 3032n
        }
    ];

    let allPassed = true;
    for (const tc of testCases) {
        const res = computeSplit(tc.amountIn, tc.userQuotedMinOut, tc.userSurplusShare);
        const passed = res.grossAmountOut === tc.expectedGross &&
                       res.totalSurplus === tc.expectedSurplus &&
                       res.protocolShare === tc.expectedProtocol &&
                       res.frontendShare === tc.expectedFrontend &&
                       res.finalUserPayout === tc.expectedUserPayout;

        allPassed = allPassed && passed;
        console.log(`  ${passed ? '✅' : '❌'} ${tc.label}`);
        console.log(`     Gross: ${res.grossAmountOut} | Surplus: ${res.totalSurplus}`);
        console.log(`     User: ${res.finalUserPayout} | Treasury: ${res.protocolShare} | Frontend: ${res.frontendShare}`);
    }

    return allPassed;
}

async function testAddressDeterminism() {
    log('TEST 3', 'MeshStrategyWithSurplusCapture — Determinism & Treasury Binding');

    const provider = new ElectrumNetworkProvider(NETWORK);
    const artifact = JSON.parse(readFileSync(join(__dirname, '..', 'artifacts', 'MeshStrategyWithSurplusCapture.json'), 'utf-8'));

    const ownerPkh = Buffer.alloc(20, 0x11);
    const treasuryA = Buffer.alloc(20, 0x99);
    const treasuryB = Buffer.alloc(20, 0x88);

    const contractA = new Contract(artifact, [ownerPkh, treasuryA, Buffer.alloc(0), Buffer.alloc(0), 304n, 1n, 25n], { provider });
    const contractB = new Contract(artifact, [ownerPkh, treasuryA, Buffer.alloc(0), Buffer.alloc(0), 304n, 1n, 25n], { provider });
    const contractC = new Contract(artifact, [ownerPkh, treasuryB, Buffer.alloc(0), Buffer.alloc(0), 304n, 1n, 25n], { provider });

    const isMatch = contractA.address === contractB.address;
    console.log(`  ${isMatch ? '✅' : '❌'} Identical Treasury produces identical address: ${contractA.address}`);

    const isDiff = contractA.address !== contractC.address;
    console.log(`  ${isDiff ? '✅' : '❌'} Changing Treasury binds to unique address: ${contractC.address}`);

    return isMatch && isDiff;
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════════╗');
    console.log('║   MeshStrategyWithSurplusCapture.cash — Unit & Math Suite        ║');
    console.log('╚══════════════════════════════════════════════════════════════════╝');

    let passed = true;
    try {
        await testCompilationAndInstantiation();
        passed = passed && testSurplusMathModes();
        passed = passed && await testAddressDeterminism();
    } catch (e: any) {
        console.error('  ❌ Test Error:', e.message);
        passed = false;
    }

    console.log(`\nOverall Surplus Unit Test Status: ${passed ? '✅ ALL PASSED' : '❌ FAILED'}`);
    process.exit(passed ? 0 : 1);
}

main().catch(console.error);
