/**
 * Runs every V4 VM suite, the harness self-test first. Exits non-zero on any failure.
 * Usage: npm test   (or npx tsx test/run_all.ts)
 */
import { resetStats, stats } from './harness.js';
import { run as selftest } from './selftest.js';
import { run as s1 } from './spikes/s1_bin_bytes.js';
import { run as s2 } from './spikes/s2_p2s_validator.js';
import { run as s3 } from './spikes/s3_manager_cost.js';
import { run as s4 } from './spikes/s4_grid_onchain.js';

const suites: Array<[string, () => void | Promise<void>]> = [
    ['harness self-test', selftest],
    ['spike S1 · slim bin bytes', s1],
    ['spike S2 · P2S bin + validator', s2],
    ['spike S3 · manager loop cost', s3],
    ['spike S4 · on-chain grid', s4],
];

let total = 0, bad = 0;
for (const [name, run] of suites) {
    resetStats();
    console.log(`\n████ ${name} ████`);
    await run();
    const s = stats();
    total += s.passed + s.failed; bad += s.failed;
    console.log(`\n═══ ${name}: ${s.passed} passed, ${s.failed} failed ═══`);
    if (s.failed) s.failures.forEach((f) => console.error(`     ✗ ${f}`));
}
console.log(`\n████ V4 total: ${total - bad} passed, ${bad} failed ████`);
if (bad) process.exit(1);
