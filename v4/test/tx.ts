/**
 * Balanced test transactions: a case describes only the covenant legs (input
 * and output at the same index); `balanced()` adds the counterparty's inputs
 * and outputs so every category and the sats add up. Honest cases therefore
 * can't fail on bookkeeping, and an attack case fails only on the covenant
 * (expectReject's `at` option checks which input refused).
 *
 * Layout: [lead input/output] · legs at the same indices · extra inputs ·
 * counterparty inputs (one per category it must supply) → outputs: legs,
 * extra outputs, leftover tokens and NFTs to the counterparty, sats change.
 */
import type { Contract, TransactionBuilder, Unlocker } from 'cashscript';
import { hexToBin } from '@bitauth/libauth';
import { TAKER, tb, utxo, type Key, type Tok } from './harness.js';

export interface Leg {
    /** Covenant at this input (its lockingBytecode), or a raw locking bytecode for non-contract legs. */
    lock: string | Uint8Array;
    unlock: Unlocker;
    inS: bigint;
    inTok?: Tok;
    outS: bigint;
    outTok?: Tok;
    /** Output destination; defaults to the same locking bytecode (recreated in place). */
    outTo?: Uint8Array;
    sequence?: number;
    /** No output at this leg's index (the output slot is skipped and taken by the next one). */
    noOutput?: boolean;
}

export interface Extra { lock: string | Uint8Array; unlock: Unlocker; sats: bigint; tok?: Tok; sequence?: number }
export interface ExtraOut { to: Uint8Array; sats: bigint; tok?: Tok }

export interface BalanceOpts {
    party?: Key;                 // who supplies and receives the difference (default TAKER)
    lead?: { inp: Extra; out: ExtraOut };   // an input/output pair placed before the legs (index 0)
    extraIns?: Extra[];
    extraOuts?: ExtraOut[];
    locktime?: number;
    fee?: bigint;
    /** Leave leftover fungible tokens unclaimed (burned) instead of sending them to the party. */
    burnLeftovers?: boolean;
}

const lockHex = (l: string | Uint8Array) => (typeof l === 'string' ? l : Buffer.from(l).toString('hex'));
const lockBin = (l: string | Uint8Array) => (typeof l === 'string' ? hexToBin(l) : l);
const nftKey = (t: Tok) => `${t.category}|${t.nft!.capability}|${t.nft!.commitment}`;

export function balanced(legs: Leg[], o: BalanceOpts = {}): TransactionBuilder {
    const party = o.party ?? TAKER;
    const fee = o.fee ?? 2_000n;
    const b = tb();
    if (o.locktime !== undefined) b.setLocktime(o.locktime);

    type In = { lock: string | Uint8Array; unlock: Unlocker; sats: bigint; tok?: Tok; sequence?: number };
    type Out = { to: Uint8Array; sats: bigint; tok?: Tok };
    const ins: In[] = [];
    const outs: Out[] = [];
    if (o.lead) { ins.push(o.lead.inp); outs.push(o.lead.out); }
    for (const l of legs) {
        ins.push({ lock: l.lock, unlock: l.unlock, sats: l.inS, tok: l.inTok, sequence: l.sequence });
        if (!l.noOutput) outs.push({ to: l.outTo ?? lockBin(l.lock), sats: l.outS, tok: l.outTok });
    }
    for (const e of o.extraIns ?? []) ins.push(e);
    for (const e of o.extraOuts ?? []) outs.push(e);

    // Fungible balance per category.
    const fung = new Map<string, bigint>();
    for (const t of ins.map((i) => i.tok)) if (t?.amount) fung.set(t.category, (fung.get(t.category) ?? 0n) + t.amount);
    for (const t of outs.map((x) => x.tok)) if (t?.amount) fung.set(t.category, (fung.get(t.category) ?? 0n) - t.amount);

    // NFTs as a multiset: each output NFT consumes a matching input NFT, or the party supplies it.
    const unmatched = ins.filter((i) => i.tok?.nft).map((i) => i.tok!);
    const needed: Tok[] = [];
    for (const t of outs.map((x) => x.tok)) {
        if (!t?.nft) continue;
        const k = unmatched.findIndex((u) => nftKey(u) === nftKey(t));
        if (k >= 0) unmatched.splice(k, 1); else needed.push(t);
    }

    // The party supplies any deficit: one input per category (fungible), one per NFT.
    const partyIns: In[] = [];
    const pIn = (tok: Tok): In => ({ lock: party.lock, unlock: party.template.unlockP2PKH(), sats: 1_000n, tok });
    for (const [cat, bal] of fung) if (bal < 0n) partyIns.push(pIn({ amount: -bal, category: cat }));
    for (const t of needed) partyIns.push(pIn({ amount: 0n, category: t.category, nft: t.nft }));

    // Leftovers go to the party: fungible per category, then each unclaimed NFT.
    const partyOuts: Out[] = [];
    if (!o.burnLeftovers) for (const [cat, bal] of fung) if (bal > 0n) partyOuts.push({ to: party.lock, sats: 1_000n, tok: { amount: bal, category: cat } });
    for (const t of unmatched) partyOuts.push({ to: party.lock, sats: 1_000n, tok: { amount: 0n, category: t.category, nft: t.nft } });

    const all = [...ins, ...partyIns];
    const inSats = all.reduce((s, i) => s + i.sats, 0n);
    const outSats = [...outs, ...partyOuts].reduce((s, x) => s + x.sats, 0n);
    const deficit = outSats + fee - inSats;
    const funding = (deficit > 0n ? deficit : 0n) + 10_000n;
    const change = 10_000n + (deficit < 0n ? -deficit : 0n);

    for (const i of all) b.addInput(utxo(lockHex(i.lock), i.sats, i.tok), i.unlock, i.sequence !== undefined ? { sequence: i.sequence } : undefined);
    b.addInput(utxo(party.lock, funding), party.template.unlockP2PKH());
    // CashScript's dust guard is policy, not consensus: bypass it so a case can build any output the VM must judge.
    const raw = (b as any).outputs as any[];
    for (const x of [...outs, ...partyOuts]) raw.push({ to: x.to, amount: x.sats, ...(x.tok ? { token: x.tok } : {}) });
    raw.push({ to: party.lock, amount: change });
    return b;
}

/** A leg for a bin contract: in place by default. */
export function binLeg(c: Contract, inS: bigint, inTok: Tok | undefined, outS: bigint, outTok: Tok | undefined, more: Partial<Leg> = {}): Leg {
    return { lock: c.lockingBytecode, inS, inTok, outS, outTok, ...more, unlock: more.unlock ?? (c as any).unlock.fill() };
}
