/**
 * BCHMesh Chipnet E2E Master Test Runner
 *
 * Runs all 4 mesh test suites in sequence on chipnet:
 *
 *   TEST 01 — Multi-Position Strategy Covenant
 *   TEST 02 — Sequential Partial Fills & Reserve Exhaustion
 *   TEST 03 — Dutch Decay Strategy (time-based pricing)
 *   TEST 04 — Liquidity Book Simulation (6 orders)
 *
 * Usage:
 *   npx tsx test/mesh_test/run_all.ts [--skip-dutch]
 *
 * Flags:
 *   --skip-dutch  Skip test 03 (takes ~3 min due to time delays)
 *   --only=01     Run only test 01
 *   --only=02     Run only test 02
 */

import { banner, printSummary, sleep, type TestResult } from './utils.js';
import { runTest01 } from './01_multi_position.js';
import { runTest02 } from './02_sequential_fills.js';
import { runTest03 } from './03_dutch_decay.js';
import { runTest04 } from './04_liquidity_book.js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skipDutch = process.argv.includes('--skip-dutch');
const onlyFlag  = process.argv.find(a => a.startsWith('--only='));
const onlyTest  = onlyFlag ? onlyFlag.split('=')[1] : null;

// ── Master Report ──────────────────────────────────────────────────────────────

function generateMarkdownReport(allResults: TestResult[], totalMs: number): string {
    const passed = allResults.filter(r => r.passed).length;
    const failed = allResults.filter(r => !r.passed).length;
    const ts     = new Date().toISOString();

    const rows = allResults.map(r => {
        const status = r.passed ? '✅ PASS' : '❌ FAIL';
        const txLinks = r.txids.map(txid =>
            `[${txid.slice(0, 10)}...](https://chipnet.chaingraph.cash/tx/${txid})`
        ).join('<br>');
        return `| ${r.name} | ${status} | ${r.durationMs}ms | ${txLinks} |`;
    }).join('\n');

    const txSection = allResults.flatMap(r =>
        r.txids.map(txid => `- [${r.name}](https://chipnet.chaingraph.cash/tx/${txid})`)
    ).join('\n');

    return `# BCHMesh Chipnet E2E Test Report

> **Generated:** ${ts}
> **Network:** Chipnet (BCH Testnet)
> **Contracts:** StrategyCovenant, DutchDecayStrategyCovenant
> **Total Duration:** ${(totalMs / 1000).toFixed(1)}s

---

## 📊 Results Summary

| Test | Status | Duration | Transaction(s) |
|------|--------|----------|----------------|
${rows}

**Total: ${passed} PASSED / ${failed} FAILED out of ${allResults.length} tests**

---

## 📋 Test Descriptions

### TEST 01 — Multi-Position Strategy Covenant
Opens 3 concurrent \`StrategyCovenant\` positions at different price tiers (1:1, 2:1, 1:1+50bps),
partially fills each one (500 tokens), then docks all remaining reserves.
- Validates: concurrent position uniqueness via P2SH32 address derivation
- Validates: partial fill with covenant self-recreation at correct remaining reserve
- Validates: owner-only \`dock()\` exit via \`OP_CHECKDATASIG\`

### TEST 02 — Sequential Partial Fills (Perpetual Market Maker)
Opens 1 large position (50,000 sats), performs 5 sequential partial fills
(2000, 2000, 3000, 5000, 5000 tokens), each time verifying the covenant recreates itself
with the correct remaining reserve.
- Validates: perpetual self-recreation through 5 sequential on-chain TXs
- Validates: monotonically decreasing reserve arithmetic
- Validates: maker earns tokens atomically on each fill

### TEST 03 — Dutch Decay Strategy
Opens a \`DutchDecayStrategyCovenant\` (10→5 sats/token over 240s), then fills at
T+0 (start price), T+60 (25% decay), and T+120 (50% decay) to demonstrate real
block-time-based price decay verified on-chain via \`tx.locktime\`.
- Validates: \`tx.locktime >= startTime\` constraint
- Validates: linear price decay formula evaluated on-chain
- Validates: fill price progressively cheaper as time advances

### TEST 04 — Liquidity Book Simulation (CLOB)
Spawns 6 concurrent strategy positions: 3 BID-side (BCH buying TOKEN_A at 0.8/0.9/1.0 sat)
and 3 ASK-side (BCH selling for TOKEN_B at 1.1/1.2/1.3 sat). Executes market orders
against the best BID and best ASK, then docks all positions.
- Validates: BCHMesh as a CLOB with independent strategy UTXOs
- Validates: bid-ask spread (0.1 sats) maintained on-chain
- Validates: multi-token support (TOKEN_A for BIDs, TOKEN_B for ASKs)

---

## 🔗 On-Chain Transactions

${txSection}

---

## 🏗️ Contract Addresses (This Run)

_See individual test logs for deployed contract addresses._

---

## 🔬 Key Observations

- **Covenant Recreation:** Every partial fill produces \`Output 0\` with the exact same locking bytecode as the input, confirmed by CashScript's \`tx.inputs[this.activeInputIndex].lockingBytecode\` constraint.
- **No Admin Key:** All strategy UTXOs are self-enforcing — no relayer or admin can modify terms mid-flight.
- **Dock Security:** Only \`hash160(ownerPk) == ownerPkh\` allows exit; all other spend attempts fail at the script level.
- **Token Accounting:** All fungible token inputs must appear in outputs (BCH UTXO model). Payment tokens are routed to the maker's token address on every fill.
`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    banner(
        '🌊  BCHMesh — Full Chipnet E2E Test Suite',
        '  Tests 01–04 | StrategyCovenant + DutchDecay'
    );
    console.log(`  Skip Dutch (--skip-dutch): ${skipDutch}`);
    if (onlyTest) console.log(`  Running only test: ${onlyTest}`);
    console.log('');

    const allResults: TestResult[] = [];
    const startMs = Date.now();

    try {
        if (!onlyTest || onlyTest === '01') {
            console.log('\n' + '█'.repeat(62));
            console.log('█  RUNNING: TEST 01 — Multi-Position Strategy Covenant');
            console.log('█'.repeat(62));
            const r01 = await runTest01();
            allResults.push(...r01);
            await sleep(5000);
        }

        if (!onlyTest || onlyTest === '02') {
            console.log('\n' + '█'.repeat(62));
            console.log('█  RUNNING: TEST 02 — Sequential Partial Fills');
            console.log('█'.repeat(62));
            const r02 = await runTest02();
            allResults.push(...r02);
            await sleep(5000);
        }

        if ((!onlyTest || onlyTest === '03') && !skipDutch) {
            console.log('\n' + '█'.repeat(62));
            console.log('█  RUNNING: TEST 03 — Dutch Decay Strategy (~3 min)');
            console.log('█'.repeat(62));
            const r03 = await runTest03();
            allResults.push(...r03);
            await sleep(5000);
        } else if (skipDutch) {
            console.log('\n⏭️  Skipping TEST 03 (--skip-dutch flag set)');
        }

        if (!onlyTest || onlyTest === '04') {
            console.log('\n' + '█'.repeat(62));
            console.log('█  RUNNING: TEST 04 — Liquidity Book (6 Orders)');
            console.log('█'.repeat(62));
            const r04 = await runTest04();
            allResults.push(...r04);
        }
    } catch (fatalErr: any) {
        console.error('\n❌ FATAL ERROR IN TEST RUNNER:', fatalErr.message);
    }

    const totalMs = Date.now() - startMs;

    // Print console summary
    const { passed, failed } = printSummary(allResults);

    // Generate and save markdown report
    const reportPath = join(__dirname, '..', '..', '..', 'devrel-agent-context', 'MeshDocs', 'MeshContracts', 'chipnet-e2e-report.md');
    try {
        const md = generateMarkdownReport(allResults, totalMs);
        writeFileSync(reportPath, md, 'utf-8');
        console.log(`\n📄 Full report saved to: ${reportPath}`);
    } catch (e: any) {
        console.warn(`  Could not save report: ${e.message}`);
    }

    process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error('\n❌ Fatal error:', e.message ?? e);
    process.exit(1);
});
