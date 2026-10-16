/**
 * L2 property and fuzz tests for MeshBinV4 (v4plan 03 §2.1).
 *
 * Differential: an independent model of the bin's fill rule (below, written
 * from the spec, not from the script) predicts every verdict. Random
 * transactions with 1–4 bins, random prices and states, trades at and around
 * the exact price boundary, and random mutations (other destination, foreign
 * tokens, NFTs, sats under the minimum) go through the consensus VM. Any
 * disagreement fails: an acceptance the model refuses is a hole in the
 * covenant; a refusal the model accepts is a fill the bin wrongly blocks.
 *
 * On every accepted transaction the plan's properties are checked:
 *   P1 each bin's value at BOTH its bid and its ask never decreases;
 *   P2 sats and every token category are conserved (outputs ≤ inputs);
 *   P3 the counterparty's gain from each bin is at most the priced trade
 *      (P1 seen from the other side).
 *
 * Usage: npx tsx test/MeshBinV4.property.test.ts   (V4_FUZZ_N=5000 for a long run, V4_FUZZ_SEED=n to replay)
 */
import { fileURLToPath } from 'url';
import { ATTACKER, TOKEN_A, TOKEN_B, TOKEN_FAKE, net, tok, buildTx, verify, check, section, summary, type Tok, type Built } from './harness.js';
import { balanced, binLeg, type Leg } from './tx.js';
import { binOf, binV4Contract, type BinV4Params } from './v4_encode.js';
import { compileFile } from 'cashc';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { BASE } from './MeshBinV4.test.js';

// ── Deterministic randomness ──────────────────────────────────────────────────
let state = Number(process.env.V4_FUZZ_SEED ?? 0xc0ffee) >>> 0;
const rnd = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const big = (bits: number) => { let x = 0n; for (let b = 0; b < bits; b += 16) x = (x << 16n) | BigInt(int(0, 0xffff)); return x & ((1n << BigInt(bits)) - 1n); };
const pick = <T,>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

// ── The model: what the spec says a fill must satisfy ────────────────────────
interface Side { sats: bigint; tok?: Tok }
/** What OP_*TOKENCATEGORY shows: the category plus a capability byte for mutable/minting NFTs. */
const shownCat = (t?: Tok) => (!t ? '' : t.category + (t.nft?.capability === 'mutable' ? '01' : t.nft?.capability === 'minting' ? '02' : ''));
const shownCommit = (t?: Tok) => t?.nft?.commitment ?? '';
function modelAccepts(p: BinV4Params, inp: Side, out: Side, sameLock: boolean): boolean {
    if (!sameLock) return false;
    const okCat = (t?: Tok) => shownCat(t) === '' || shownCat(t) === p.tokenCat;
    if (!okCat(inp.tok) || !okCat(out.tok)) return false;
    if (shownCommit(out.tok) !== '') return false;
    if (out.sats < 1000n) return false;
    const amt = (t?: Tok) => (t && t.category === p.tokenCat ? t.amount : 0n);
    const dt = amt(out.tok) - amt(inp.tok);
    const ds = out.sats - inp.sats;
    const [n, d] = dt < 0n ? [p.askNum, p.askDen] : [p.bidNum, p.bidDen];
    if (n <= 0n || d <= 0n) return false;
    if (ds * d + dt * n < 0n) return false;
    return p.askNum * p.bidDen >= p.bidNum * p.askDen;
}

// ── Generators ────────────────────────────────────────────────────────────────
function randomParams(): BinV4Params {
    for (;;) {
        const p = randomParamsOnce();
        if ([p.bidNum, p.bidDen, p.askNum, p.askDen].every((x) => x > 0n && x < 1n << 63n)) return p;
    }
}
function randomParamsOnce(): BinV4Params {
    const bidDen = BigInt(int(1, 3) === 1 ? 1 : int(1, 1 << 20));
    const bidNum = 1n + big(int(1, 44));
    // ask ≥ bid most of the time; sometimes a misconfigured bin (ask < bid), which must refuse every fill
    const askDen = pick([bidDen, BigInt(int(1, 1 << 20))]);
    let askNum = ceilDiv(bidNum * askDen, bidDen) + big(int(0, 20));
    if (rnd() < 0.05 && askNum > 1n) askNum = askNum - 1n - big(4) % askNum;
    if (askNum <= 0n) askNum = 1n;
    return { ...BASE, bidNum, bidDen, askNum, askDen };
}

type Mutation = 'none' | 'dest-attacker' | 'dest-other-bin' | 'foreign-out' | 'foreign-in' | 'nft-mutable' | 'nft-minting' | 'nft-commit' | 'nft-empty' | 'under-min';
const MUTATIONS: Mutation[] = ['dest-attacker', 'dest-other-bin', 'foreign-out', 'foreign-in', 'nft-mutable', 'nft-minting', 'nft-commit', 'nft-empty', 'under-min'];

interface Case { p: BinV4Params; inp: Side; out: Side; outTo?: Uint8Array; mutation: Mutation; kind: string }

function randomCase(): Case {
    const p = randomParams();
    const inT = rnd() < 0.3 ? 0n : 1n + big(int(1, 40));
    const inS = 1_000n + big(int(8, 44));
    const delta = BigInt(pick([0, 0, 0, -1, 1, -2, 2, int(-1000, 1000)]));
    let kind: string;
    let outS: bigint, outT: bigint;
    const r = rnd();
    // Keep every trade under 10^14 sats so the transaction stays below the 21M BCH supply.
    const MAX_COST = 100_000_000_000_000n;
    const maxBuy = (MAX_COST * p.askDen) / p.askNum;
    if (r < 0.45 && inT > 0n && maxBuy >= 1n) {         // buy q tokens at the ask
        kind = 'buy';
        const lim = inT < maxBuy ? inT : maxBuy;
        const q = 1n + big(60) % lim;
        outT = inT - q;
        outS = inS + ceilDiv(q * p.askNum, p.askDen) + delta;
    } else if (r < 0.85) {                               // sell q tokens at the bid
        kind = 'sell';
        const q = 1n + big(int(1, 40));
        outT = inT + q;
        outS = inS - (q * p.bidNum) / p.bidDen + delta;
    } else {                                             // top-up / no-op / drain
        kind = 'other';
        outT = inT + BigInt(int(-2, 3)) * (rnd() < 0.5 ? 1n : 0n);
        outS = inS + BigInt(int(-3, 3)) * (rnd() < 0.5 ? 1n : 0n);
        if (outT < 0n) outT = 0n;
    }
    if (outS < 0n) outS = 0n;
    const mutation: Mutation = rnd() < 0.15 ? pick(MUTATIONS) : 'none';
    let inTok: Tok | undefined = inT > 0n ? tok(inT) : undefined;
    let outTok: Tok | undefined = outT > 0n ? tok(outT) : undefined;
    let outTo: Uint8Array | undefined;
    switch (mutation) {
        case 'dest-attacker': outTo = ATTACKER.lock; break;
        case 'dest-other-bin': { const q = { ...p, bidNum: p.bidNum + 1n, askNum: p.askNum + 1n }; outTo = Uint8Array.from(Buffer.from(binOf(q, net).lockingBytecode, 'hex')); break; }
        case 'foreign-out': outTok = tok(outT > 0n ? outT : 1n, pick([TOKEN_FAKE, TOKEN_B])); break;
        case 'foreign-in': inTok = tok(inT > 0n ? inT : 1n, TOKEN_FAKE); break;
        case 'nft-mutable': outTok = { amount: outT, category: TOKEN_A, nft: { capability: 'mutable', commitment: '' } }; break;
        case 'nft-minting': outTok = { amount: outT, category: TOKEN_A, nft: { capability: 'minting', commitment: '' } }; break;
        case 'nft-commit': outTok = { amount: outT, category: TOKEN_A, nft: { capability: 'none', commitment: 'c0de' } }; break;
        case 'nft-empty': outTok = { amount: outT, category: TOKEN_A, nft: { capability: 'none', commitment: '' } }; break;
        case 'under-min': outS = BigInt(int(546, 999)); break;
    }
    return { p, inp: { sats: inS, tok: inTok }, out: { sats: outS, tok: outTok }, outTo, mutation, kind };
}

// ── Properties on an accepted transaction ────────────────────────────────────
function properties(built: Built, cases: Case[]): string[] {
    const errs: string[] = [];
    const tx = built.transaction, src = built.sourceOutputs;
    const sIn = src.reduce((s, o) => s + o.valueSatoshis, 0n), sOut = tx.outputs.reduce((s, o) => s + o.valueSatoshis, 0n);
    if (sOut > sIn) errs.push(`P2 sats created: ${sOut} > ${sIn}`);
    const cats = new Map<string, bigint>();
    for (const o of src) if (o.token) cats.set(String(o.token.category), (cats.get(String(o.token.category)) ?? 0n) + o.token.amount);
    for (const o of tx.outputs) if (o.token) cats.set(String(o.token.category), (cats.get(String(o.token.category)) ?? 0n) - o.token.amount);
    for (const [c, bal] of cats) if (bal < 0n) errs.push(`P2 tokens created in ${c.slice(0, 8)}`);
    cases.forEach((c, k) => {
        const inS = src[k]!.valueSatoshis, outS = tx.outputs[k]!.valueSatoshis;
        const amt = (t: any): bigint => (t && binToHexCat(t.category) === c.p.tokenCat ? t.amount : 0n);
        const dt = amt(tx.outputs[k]!.token) - amt(src[k]!.token), ds = outS - inS;
        if (ds * c.p.bidDen + dt * c.p.bidNum < 0n) errs.push(`P1 bin ${k} lost value at its bid`);
        if (ds * c.p.askDen + dt * c.p.askNum < 0n) errs.push(`P1 bin ${k} lost value at its ask`);
        // P3: what the counterparty took from bin k (−ds sats, −dt tokens), valued at the price it traded at, is ≤ 0.
        const [n, d] = dt < 0n ? [c.p.askNum, c.p.askDen] : [c.p.bidNum, c.p.bidDen];
        if (-ds * d - dt * n > 0n) errs.push(`P3 counterparty gained beyond the priced trade on bin ${k}`);
    });
    return errs;
}
const binToHexCat = (c: Uint8Array | string) => (typeof c === 'string' ? c : Buffer.from(c).toString('hex'));

/** Run N random transactions against `artifact` (default: the real MeshBinV4) and compare with the model. */
function fuzz(N: number, artifact?: any, log = true) {
    let agree = 0, accepted = 0, rejected = 0, disagree = 0, propFails = 0, buildErr = 0;
    const byMutation = new Map<string, { n: number; acc: number }>();
    const firstErrors: string[] = [];
    for (let it = 0; it < N; it++) {
        const cases = Array.from({ length: int(1, 4) }, randomCase);
        const legs: Leg[] = cases.map((c) => binLeg(artifact ? binV4Contract(artifact, c.p, net) : binOf(c.p, net), c.inp.sats, c.inp.tok, c.out.sats, c.out.tok, c.outTo ? { outTo: c.outTo } : {}));
        const expected = cases.every((c) => modelAccepts(c.p, c.inp, c.out, !c.outTo));
        let built: Built;
        try { built = buildTx(balanced(legs)); } catch (e: any) { buildErr++; if (firstErrors.length < 5) firstErrors.push(`build: ${e.message}`); continue; }
        const r = verify(built, false);
        const got = r === true;
        for (const c of cases) { const m = byMutation.get(c.mutation) ?? { n: 0, acc: 0 }; m.n++; if (got) m.acc++; byMutation.set(c.mutation, m); }
        if (got !== expected) {
            disagree++;
            if (firstErrors.length < 8) firstErrors.push(`#${it} model ${expected ? 'ACCEPTS' : 'REFUSES'}, VM ${got ? 'ACCEPTS' : 'REFUSES: ' + String(r).slice(0, 120)} · ${cases.map((c) => `${c.kind}/${c.mutation} in(${c.inp.sats},${c.inp.tok?.amount ?? 0}) out(${c.out.sats},${c.out.tok?.amount ?? 0}) bid ${c.p.bidNum}/${c.p.bidDen} ask ${c.p.askNum}/${c.p.askDen}`).join(' | ')}`);
            continue;
        }
        agree++;
        if (got) {
            accepted++;
            const errs = properties(built, cases);
            if (verify(built, true) !== true) errs.push('accepted by consensus but not standard');
            if (errs.length) { propFails++; if (firstErrors.length < 8) firstErrors.push(`#${it} ${errs.join('; ')}`); }
        } else rejected++;
    }
    if (log) firstErrors.forEach((e) => console.error(`     ${e}`));
    return { agree, accepted, rejected, disagree, propFails, buildErr, byMutation };
}

export function run() {
    const N = Number(process.env.V4_FUZZ_N ?? 400);
    section(`L2 · differential fuzz (${N} transactions, 1–4 bins, seed ${process.env.V4_FUZZ_SEED ?? '0xc0ffee'})`);
    const { agree, accepted, rejected, disagree, propFails, buildErr, byMutation } = fuzz(N);
    check('the VM agrees with the model on every transaction', disagree === 0, `${agree}/${N - buildErr} agree · ${accepted} accepted · ${rejected} refused`);
    check('P1–P3 hold on every accepted transaction', propFails === 0, `${accepted} checked`);
    check('the generator exercised both outcomes', accepted > N / 10 && rejected > N / 10, `${accepted} accepted / ${rejected} refused`);
    check('no case failed to build', buildErr === 0, `${buildErr}`);
    const muts = [...byMutation.entries()].filter(([m]) => m !== 'none');
    check('every mutation kind was generated', muts.length === MUTATIONS.length, muts.map(([m, v]) => `${m} ${v.n}`).join(', '));
    const leaked = muts.filter(([m, v]) => m !== 'nft-empty' && v.acc > 0);
    check('no mutated bin was ever part of an accepted transaction (except the documented invisible NFT)', leaked.length === 0, leaked.map(([m, v]) => `${m}: ${v.acc}`).join(', ') || 'none');

    // ── Mutation testing: the fuzzer must catch a bin with any one rule broken ──
    section('L2 · mutation test: each mutant bin (one rule removed) must be caught');
    const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts');
    const lib = readFileSync(join(src, 'lib', 'bin.cash'), 'utf-8');
    const main = readFileSync(join(src, 'MeshBinV4.cash'), 'utf-8');
    const mutants: Array<[string, string, string, string]> = [
        ['no bin minimum', 'lib', 'require(tx.outputs[i].value >= 1000);', ''],
        ['no NFT-commitment check', 'lib', 'require(tx.outputs[i].nftCommitment == 0x);', ''],
        ['no output category check', 'lib', 'require(outCat == tokenCat || outCat == 0x);', ''],
        ['no input category check', 'lib', 'require(inCat == tokenCat || inCat == 0x);', ''],
        ['no same-bytecode check', 'lib', 'require(tx.outputs[i].lockingBytecode == tx.inputs[i].lockingBytecode);', ''],
        ['price off by one sat-unit', 'main', 'require(ds * d + dt * n >= 0);', 'require(ds * d + dt * n >= 0 - d);'],
        ['bid used for buys', 'main', 'if (dt < 0) {', 'if (dt < 0 - 9223372036854775807) {'],
        ['no ask ≥ bid check', 'main', 'require(int(askNum) * int(bidDen) >= int(bidNum) * int(askDen));', ''],
    ];
    const dir = join(tmpdir(), 'mesh-v4-mutants');
    mkdirSync(join(dir, 'lib'), { recursive: true });
    const M = Number(process.env.V4_MUTANT_N ?? 300);
    for (const [name, where, from, to] of mutants) {
        const l = where === 'lib' ? lib.replace(from, to) : lib;
        const m = where === 'main' ? main.replace(from, to) : main;
        if (l === lib && m === main) { check(`mutant "${name}" applies`, false, 'source text not found'); continue; }
        writeFileSync(join(dir, 'lib', 'bin.cash'), l);
        writeFileSync(join(dir, 'MeshBinV4.cash'), m);
        const art = compileFile(join(dir, 'MeshBinV4.cash'));
        const r = fuzz(M, art, false);
        check(`mutant caught: ${name}`, r.disagree + r.propFails > 0, `${r.disagree} disagreements, ${r.propFails} property failures in ${M}`);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
    summary('MeshBinV4 L2 property + fuzz');
}
