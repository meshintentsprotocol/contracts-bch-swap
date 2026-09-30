/**
 * Live-pool drain & theft security test (offline VM, no broadcasting).
 *
 * Fetches every ACTIVE StrategyCovenantV2 pool from the meshserver, rebuilds
 * each covenant from its on-chain params, and confirms the rebuilt address
 * equals the live address — i.e. this is the exact bytecode locking real funds.
 * It then runs a battery of drain / theft transactions against each pool in
 * CashScript's VM (MockNetworkProvider + .debug()), which executes the same
 * script the chain would. An attack that the VM rejects is one the network
 * rejects. Honest fills are included to prove the covenant still works (the
 * rejections are not "everything fails").
 *
 * It also runs non-mutating server-layer checks (fake-pool registration,
 * param mismatch, unauthenticated admin) that only ever expect rejection, so
 * they cannot move funds or change server state.
 *
 * Nothing here signs with an owner key or broadcasts. Reserves are the real
 * at-risk amounts from the API.
 *
 *   MESH_URL=http://localhost:3001 npx tsx test/mesh_test/LivePools.security.test.ts
 */
import { Contract, TransactionBuilder } from 'cashscript';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
    OWNER, ATTACKER, p2pkh, provider, fakeTxid, expectAccept, expectReject, section, summary, resetStats,
} from './_mesh_security_harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const POOL = JSON.parse(readFileSync(join(ROOT, 'artifacts', 'StrategyCovenantV2.json'), 'utf-8'));
const MESH = process.env.MESH_URL ?? 'http://localhost:3001';
const net = provider();
const tb = () => new TransactionBuilder({ provider: net });

interface LivePool {
    address: string; tokenAddress: string; side: 'SELL_BCH' | 'SELL_TOKEN';
    constructorArgs: [string, string, string, string, string, string];
    tokenCategory: string; reserves: { sats: string; tokens: string }; availableOut: string;
}

const B = (v: string | bigint) => BigInt(v);
/** Covenant output for amountIn: floor(in * num * (10000 - fee) / (den * 10000)). */
const outFor = (amountIn: bigint, num: bigint, den: bigint, fee: bigint) => (amountIn * num * (10000n - fee)) / (den * 10000n);
/** Smallest amountIn whose covenant output is ≥ targetOut (inverse of outFor, rounded up). */
const inForTarget = (targetOut: bigint, num: bigint, den: bigint, fee: bigint) => {
    const inp = (targetOut * den * 10000n + num * (10000n - fee) - 1n) / (num * (10000n - fee));
    return inp > 0n ? inp : 1n;
};

function build(args: LivePool['constructorArgs']): Contract {
    return new Contract(POOL, [args[0], args[1], args[2], B(args[3]), B(args[4]), B(args[5])], { provider: net });
}

/** A pool covenant with one tampered param (attacker tries to swap in cheaper terms). */
function tampered(args: LivePool['constructorArgs']): Contract {
    const a = [...args] as LivePool['constructorArgs'];
    a[5] = '0';             // feeBps 30 → 0: attacker skims the fee
    a[0] = '0x' + '00'.repeat(20); // owner → null: attacker seizes dock rights
    return build(a);
}

function attackBchGivingPool(p: LivePool) {
    // Pool holds `reserveSats` BCH, receives token `tokenCategory` (= args[1] display). Gives BCH.
    const [, , , numS, denS, feeS] = p.constructorArgs;
    const num = B(numS), den = B(denS), fee = B(feeS);
    const cat = p.tokenCategory;
    const reserveSats = B(p.reserves.sats);
    const heldTokens = B(p.reserves.tokens); // tokens already accumulated in the pool
    const c = build(p.constructorArgs);
    const tok = (amount: bigint, category = cat) => ({ amount, category });
    const poolIn = () => ({ txid: fakeTxid(), vout: 0, satoshis: reserveSats, ...(heldTokens > 0n ? { token: tok(heldTokens) } : {}) });

    // Size an honest fill to about a quarter of available depth (so out > 0 and ≤ reserve).
    const amountIn = inForTarget(B(p.availableOut) / 4n || 1n, num, den, fee);
    const out = outFor(amountIn, num, den, fee);

    expectAccept(`honest fill: deliver ${amountIn} units, take ${out} sats at the covenant price`, () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 3_000n, token: tok(amountIn) }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: c.tokenAddress, amount: reserveSats - out, token: tok(heldTokens + amountIn) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: out + 1_000n });
        return b;
    });
    expectReject(`DRAIN: take ${p.availableOut} sats delivering only 1 token unit`, () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 3_000n, token: tok(1n) }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: c.tokenAddress, amount: 1_000n, token: tok(heldTokens + 1n) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: reserveSats - 1_000n });
        return b;
    });
    expectReject('DRAIN: take the reserve paying nothing (recreated pool holds no new token)', () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 3_000n }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: c.tokenAddress, amount: 1_000n, token: tok(heldTokens || 1n) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: reserveSats - 1_000n });
        return b;
    });
    expectReject(`over-take: pay for ${amountIn} units but withdraw 1 sat beyond the price`, () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 3_000n, token: tok(amountIn) }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: c.tokenAddress, amount: reserveSats - out - 1n, token: tok(heldTokens + amountIn) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: out + 1_001n });
        return b;
    });
    expectReject('deliver a worthless token category instead of the real one', () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 3_000n, token: tok(amountIn, '11'.repeat(32)) }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: c.tokenAddress, amount: reserveSats - out, token: tok(amountIn, '11'.repeat(32)) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: out + 1_000n });
        return b;
    });
    expectReject('recreate the pool at a different output index', () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 3_000n, token: tok(amountIn) }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: out + 1_000n });                            // pool at [1] not [0]
        b.addOutput({ to: c.tokenAddress, amount: reserveSats - out, token: tok(heldTokens + amountIn) });
        return b;
    });
    expectReject('swap in a tampered covenant (fee 0, owner nulled) as the recreated pool', () => {
        const t = tampered(p.constructorArgs);
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 3_000n, token: tok(amountIn) }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: t.tokenAddress, amount: reserveSats - out, token: tok(heldTokens + amountIn) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: out + 1_000n });
        return b;
    });
    expectReject('double-count: two pool UTXOs share one recreated output', () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 3_000n, token: tok(amountIn) }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: c.tokenAddress, amount: reserveSats - out, token: tok(heldTokens + amountIn) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: reserveSats + out });
        return b;
    });
    expectReject('attacker docks the pool (no owner key)', () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.dock(ATTACKER.pub, ATTACKER.template));
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: reserveSats - 1_000n, ...(heldTokens > 0n ? { token: tok(heldTokens) } : {}) });
        return b;
    });
    return c;
}

function attackTokenGivingPool(p: LivePool) {
    // Pool holds `reserveTokens` of `tokenCategory`, receives BCH. Gives tokens.
    const [, , , numS, denS, feeS] = p.constructorArgs;
    const num = B(numS), den = B(denS), fee = B(feeS);
    const cat = p.tokenCategory;
    const reserveSats = B(p.reserves.sats);
    const reserveTokens = B(p.reserves.tokens);
    const c = build(p.constructorArgs);
    const tok = (amount: bigint, category = cat) => ({ amount, category });
    const poolIn = () => ({ txid: fakeTxid(), vout: 0, satoshis: reserveSats, token: tok(reserveTokens) });

    // Size an honest fill to about a quarter of the token depth (so out > 0 and ≤ reserve).
    const amountIn = inForTarget(reserveTokens / 4n || 1n, num, den, fee);
    const out = outFor(amountIn, num, den, fee);

    expectAccept(`honest fill: pay ${amountIn} sats, take ${out} token units at the covenant price`, () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: amountIn + 50_000n }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: c.tokenAddress, amount: reserveSats + amountIn, token: tok(reserveTokens - out) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(out) });
        return b;
    });
    expectReject(`DRAIN: take ${p.availableOut} token units paying ~0 sats`, () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 3_000n }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: c.tokenAddress, amount: reserveSats, token: tok(1n) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(reserveTokens - 1n) });
        return b;
    });
    expectReject('over-take: pay the price but take 1 token unit extra', () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 40_000n }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: c.tokenAddress, amount: reserveSats + amountIn, token: tok(reserveTokens - out - 1n) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(out + 1n) });
        return b;
    });
    expectReject('recreate the pool at a different output index', () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 40_000n }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(out) });
        b.addOutput({ to: c.tokenAddress, amount: reserveSats + amountIn, token: tok(reserveTokens - out) });
        return b;
    });
    expectReject('swap in a tampered covenant (fee 0, owner nulled) as the recreated pool', () => {
        const t = tampered(p.constructorArgs);
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 40_000n }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: t.tokenAddress, amount: reserveSats + amountIn, token: tok(reserveTokens - out) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(out) });
        return b;
    });
    expectReject('steal the token reserve to a plain (non-covenant) address', () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.fill());
        b.addInput({ txid: fakeTxid(), vout: 0, satoshis: 40_000n }, ATTACKER.template.unlockP2PKH());
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: reserveSats, token: tok(reserveTokens) });
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n });
        return b;
    });
    expectReject('attacker docks the pool (no owner key)', () => {
        const b = tb();
        b.addInput(poolIn(), c.unlock.dock(ATTACKER.pub, ATTACKER.template));
        b.addOutput({ to: p2pkh(ATTACKER.pkh), amount: 1_000n, token: tok(reserveTokens) });
        return b;
    });
    return c;
}

async function serverChecks() {
    section('Server layer (non-mutating — every request must be rejected)');
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
        const res = await fetch(`${MESH}${path}`, {
            method, headers: { 'Content-Type': 'application/json', ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
    };
    const PUSD = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
    const owner = 'b3a72f09c83d91b966fe14ed0f31e0746331198a';
    const expectStatus = async (name: string, want: number[], run: () => Promise<{ status: number }>) => {
        try {
            const { status } = await run();
            if (want.includes(status)) { console.log(`  ✅ ${name} → ${status}`); (globalThis as any).__p++; }
            else { console.error(`  ❌ ${name} → ${status}, expected ${want.join('/')}`); (globalThis as any).__f++; }
        } catch (e: any) { console.error(`  ❌ ${name} threw ${e.message}`); (globalThis as any).__f++; }
    };

    await expectStatus('register a pool at a non-existent outpoint', [404], () =>
        call('POST', '/api/v1/pools', { pools: [{ txid: 'ab'.repeat(32), vout: 0, ownerPkh: owner, tokenCategoryIn: PUSD, tokenCategoryOut: '0x', priceNum: 2000, priceDen: 1, feeBps: 30 }] }));
    await expectStatus('register with params that do not match the address', [404], () =>
        call('POST', '/api/v1/pools', { pools: [{ txid: 'cd'.repeat(32), vout: 0, ownerPkh: owner, tokenCategoryIn: PUSD, tokenCategoryOut: '0x', priceNum: 999999, priceDen: 1, feeBps: 30 }] }));
    await expectStatus('register a V1 (drainable) contract type', [400], () =>
        call('POST', '/api/v1/pools', { pools: [{ txid: 'ef'.repeat(32), vout: 0, ownerPkh: owner, tokenCategoryIn: PUSD, tokenCategoryOut: '0x', priceNum: 2000, priceDen: 1, feeBps: 30, contractType: 'StrategyCovenant' }] }));
    await expectStatus('register a token-to-token pool (both sides non-BCH)', [400, 404], () =>
        call('POST', '/api/v1/pools', { pools: [{ txid: 'aa'.repeat(32), vout: 0, ownerPkh: owner, tokenCategoryIn: PUSD, tokenCategoryOut: '11'.repeat(32), priceNum: 1, priceDen: 1, feeBps: 30 }] }));
    await expectStatus('pause routes with no admin key', [401, 503], () =>
        call('POST', '/api/v1/admin/routes/control', { meshEnabled: false }));
    await expectStatus('pause routes with a wrong admin key', [401, 503], () =>
        call('POST', '/api/v1/admin/routes/control', { meshEnabled: false }, { 'x-admin-key': 'not-the-key' }));
    await expectStatus('sweep the solver with no admin key', [401, 503], () =>
        call('POST', '/api/v1/admin/refunds/sweep', {}));
    await expectStatus('dock a fake outpoint (read-only reconcile)', [404], () =>
        call('POST', '/api/v1/positions/dock', { txid: '00'.repeat(32), vout: 0 }));
}

async function main() {
    resetStats();
    (globalThis as any).__p = 0; (globalThis as any).__f = 0;

    section(`Fetching live active pools from ${MESH}`);
    const res = await fetch(`${MESH}/api/v1/pools?status=active&limit=500`);
    const { pools } = (await res.json()) as { pools: LivePool[] };
    console.log(`  ${pools.length} active pools`);
    if (pools.length === 0) throw new Error('no active pools to test');

    let atRisk = 0n;
    for (const p of pools) {
        const c = build(p.constructorArgs);
        const matches = c.address === p.address;
        section(`${p.side} pool ${p.address.slice(0, 24)}…  reserve ${p.reserves.sats} sats / ${p.reserves.tokens} tokens`);
        if (!matches) {
            console.error(`  ❌ rebuilt address ${c.address} != live ${p.address} — skipping`);
            (globalThis as any).__f++;
            continue;
        }
        console.log(`  ✅ rebuilt covenant reproduces the live address (same bytecode locking the funds)`);
        atRisk += B(p.reserves.sats);
        if (p.side === 'SELL_BCH') attackBchGivingPool(p);
        else attackTokenGivingPool(p);
    }

    await serverChecks();

    console.log(`\nTotal BCH reserve exercised against drain attacks: ${atRisk} sats across ${pools.length} pools.`);
    console.log(`Server-layer checks: ${(globalThis as any).__p} passed, ${(globalThis as any).__f} failed.`);
    if ((globalThis as any).__f > 0) process.exitCode = 1;
    summary('Live-pool drain & theft security');
}

main().catch(e => { console.error(`FATAL: ${e?.stack ?? e}`); process.exit(2); });
