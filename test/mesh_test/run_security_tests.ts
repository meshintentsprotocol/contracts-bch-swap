/**
 * Master Security & Adversarial Test Runner for BCHMesh Covenants
 *
 * Runs offline Bitcoin Cash VM adversarial security test suites:
 * 1. StrategyCovenant.security.test.ts (11 tests)
 * 2. MultiPairRecyclingCovenant.security.test.ts (7 tests)
 * 3. DutchDecayStrategyCovenant.security.test.ts (7 tests)
 * 4. OracleStrategyCovenant.security.test.ts (7 tests)
 *
 * Total: 32 adversarial test assertions covering VM-level security invariants.
 */

import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const suites = [
    { name: 'StrategyCovenant', file: 'StrategyCovenant.security.test.ts' },
    { name: 'MultiPairRecyclingCovenant', file: 'MultiPairRecyclingCovenant.security.test.ts' },
    { name: 'DutchDecayStrategyCovenant', file: 'DutchDecayStrategyCovenant.security.test.ts' },
    { name: 'OracleStrategyCovenant', file: 'OracleStrategyCovenant.security.test.ts' },
];

console.log('╔════════════════════════════════════════════════════════════════════╗');
console.log('║        BCHMesh Covenant Adversarial Security Test Suite            ║');
console.log('║        Executing 32 Offline Bitcoin Cash VM Invariant Checks       ║');
console.log('╚════════════════════════════════════════════════════════════════════╝\n');

let totalPassed = 0;
let totalFailed = 0;

for (const suite of suites) {
    const fullPath = join(__dirname, suite.file);
    try {
        const output = execSync(`node ./node_modules/tsx/dist/cli.mjs "${fullPath}"`, {
            cwd: join(__dirname, '..', '..'),
            encoding: 'utf-8'
        });
        console.log(output);
        totalPassed++;
    } catch (e: any) {
        console.error(e.stdout || e.message);
        totalFailed++;
    }
}

console.log('════════════════════════════════════════════════════════════════════');
if (totalFailed === 0) {
    console.log(`🎉 ALL 4 COVENANT SECURITY SUITES PASSED (32 VM-level attack vectors tested)`);
} else {
    console.error(`❌ ${totalFailed} SUITE(S) FAILED`);
    process.exit(1);
}