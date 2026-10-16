/**
 * Runs every V4 VM suite, the harness self-test first. Exits non-zero on any failure.
 * Usage: npm test   (or npx tsx test/run_all.ts)
 */
import { resetStats, stats } from './harness.js';
import { run as selftest } from './selftest.js';

const suites: Array<[string, () => void | Promise<void>]> = [
    ['harness self-test', selftest],
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
