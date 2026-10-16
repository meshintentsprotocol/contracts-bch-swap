/**
 * Harness self-test: proves the harness can't hand out false positives.
 *
 *   1. honest transactions are accepted by the BCH_2026_05 VM;
 *   2. known-bad transactions (wrong secret, redirected output, tampered after
 *      signing) are rejected, at the input under test;
 *   3. `expectReject` itself FAILS when given a valid transaction, a build
 *      error, a policy-only failure, or a failure at the wrong input;
 *   4. the VM really is 2026: a loop is accepted by it and refused by 2025.
 *
 * Usage: npx tsx test/selftest.ts
 */
import { Contract } from 'cashscript';
import { createVirtualMachineBch2025, hexToBin } from '@bitauth/libauth';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    OWNER, TAKER, ATTACKER, net, tb, utxo, lockOf, buildTx, verify, inputMetrics, failingInput,
    expectAccept, expectReject, check, captured, section, summary,
} from './harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELFTEST = JSON.parse(readFileSync(join(HERE, 'fixtures', 'SelfTest.json'), 'utf-8'));
const PROBE = JSON.parse(readFileSync(join(HERE, '..', 'probe', 'Probe.json'), 'utf-8'));

export function run() {
    const c = new Contract(SELFTEST, [OWNER.pkh], { provider: net, contractType: 'p2sh32' });

    const p2pkhSpend = (to = TAKER.lock, amount = 9_000n) => () => tb()
        .addInput(utxo(OWNER.lock, 10_000n), OWNER.template.unlockP2PKH())
        .addOutput({ to, amount });
    const covSpend = (secret: bigint, to = OWNER.lock, amount = 5_000n) => () => tb()
        .addInput(utxo(c.lockingBytecode, 10_000n), c.unlock.spend(secret))
        .addInput(utxo(TAKER.lock, 3_000n), TAKER.template.unlockP2PKH())
        .addOutput({ to, amount })
        .addOutput({ to: TAKER.lock, amount: 7_000n });

    section('1 · honest transactions are accepted');
    expectAccept('P2PKH → P2PKH', p2pkhSpend());
    expectAccept('SelfTest covenant with the right secret and output', covSpend(7n));

    section('2 · known-bad transactions are rejected at the input under test');
    expectReject('wrong secret', covSpend(8n), { at: 0 });
    expectReject('output redirected to the attacker', covSpend(7n, ATTACKER.lock), { at: 0 });
    expectReject('output below the covenant minimum', covSpend(7n, OWNER.lock, 1_999n), { at: 0 });
    {
        // Tampered after signing: the signature no longer covers the outputs.
        const built = buildTx(p2pkhSpend()());
        check('untampered transaction verifies', verify(built) === true);
        built.transaction.outputs[0]!.valueSatoshis = 9_500n;
        const r = verify(built);
        check('tampered output value is rejected (signature)', r !== true && failingInput(r) === 0, r === true ? 'ACCEPTED' : r.slice(0, 120));
        built.transaction.outputs[0]!.valueSatoshis = 9_000n;
        built.transaction.outputs[0]!.lockingBytecode = ATTACKER.lock;
        const r2 = verify(built);
        check('tampered output destination is rejected (signature)', r2 !== true && failingInput(r2) === 0);
    }

    section('3 · the assertions fail when they should (no false positives)');
    {
        const d1 = captured(() => expectReject('valid tx', covSpend(7n)));
        check('expectReject on a VALID transaction is reported as a failure', d1.failed === 1 && d1.passed === 0);

        const d2 = captured(() => expectReject('build error', () => { throw new Error('boom'); }));
        check('expectReject on a BUILD error is reported as a failure', d2.failed === 1 && d2.passed === 0);

        // Honest covenant spend whose only fault is a dust output (policy, not script).
        // CashScript refuses dust at addOutput, so slip it past the builder's guard.
        const dust = () => { const b = covSpend(7n)(); (b as any).outputs.push({ to: TAKER.lock, amount: 100n }); return b; };
        const rd = verify(buildTx(dust()));
        check('a dust-only fault is a policy error, not a script failure', rd !== true && !/evaluating input index/.test(rd), rd === true ? 'ACCEPTED' : rd.slice(0, 100));
        check('the same transaction passes consensus (only policy refuses it)', verify(buildTx(dust()), false) === true);
        const d3 = captured(() => expectReject('dust only', dust));
        check('expectReject on a policy-only fault (dust) is reported as a failure', d3.failed === 1 && d3.passed === 0);

        // Failure at input 0 (wrong secret) but the test claims input 1.
        const d4 = captured(() => expectReject('wrong input', covSpend(8n), { at: 1 }));
        check('expectReject at the wrong input is reported as a failure', d4.failed === 1 && d4.passed === 0);

        const d5 = captured(() => expectAccept('bad tx', covSpend(8n)));
        check('expectAccept on a BAD transaction is reported as a failure', d5.failed === 1 && d5.passed === 0);

        const d6 = captured(() => expectReject('reason mismatch', covSpend(8n), { at: 0, reason: /never-matches-anything/ }));
        check('expectReject with a non-matching reason is reported as a failure', d6.failed === 1);
    }

    section('4 · the VM is BCH_2026_05');
    {
        const probe = new Contract(PROBE, [15_000n], { provider: net, contractType: 'p2sh32' });
        const loop = (min: bigint) => () => tb()
            .addInput(utxo(probe.lockingBytecode, 10_000n), probe.unlock.spend())
            .addInput(utxo(TAKER.lock, 6_000n), TAKER.template.unlockP2PKH())
            .addOutput({ to: TAKER.lock, amount: 15_000n });
        const built = expectAccept('loop over every input (OP_BEGIN/OP_UNTIL), Σ 16,000 ≥ 15,000', loop(15_000n));
        if (built) {
            const r25 = createVirtualMachineBch2025(true).verify({ transaction: built.transaction, sourceOutputs: built.sourceOutputs });
            check('the same transaction is refused by the 2025 VM (loops not yet active)', r25 !== true, String(r25).slice(0, 80));
            const m = inputMetrics(built)[0]!;
            check('operation cost is measured', m.opCost > 0 && m.maxOpCost > m.opCost, `${m.opCost} / ${m.maxOpCost}`);
        }
        const tight = new Contract(PROBE, [16_001n], { provider: net, contractType: 'p2sh32' });
        expectReject('loop sum below the minimum', () => tb()
            .addInput(utxo(tight.lockingBytecode, 10_000n), tight.unlock.spend())
            .addInput(utxo(TAKER.lock, 6_000n), TAKER.template.unlockP2PKH())
            .addOutput({ to: TAKER.lock, amount: 15_000n }), { at: 0 });
        check('lockOf matches the contract', lockOf(c).length === 35 && hexToBin(c.lockingBytecode)[0] === 0xaa);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
    summary('harness self-test');
}
