# MeshBinV4 specification

| | |
|---|---|
| Version | 1.1, 2026-10-16. 1.1 changes the owner rule (phase 2: a mutable NFT owns with any commitment, so a holder can't lock the position by clearing it) |
| Status | **Frozen for audit #1** unless a finding reopens it |
| Source | `contracts/MeshBinV4.cash`, `contracts/lib/bin.cash`, `contracts/variants/*.cash` (cashc 0.14.0) |
| Artifacts | `artifacts/MeshBinV4.json`, `artifacts/variants/*.json`, pinned by sha256 in `test/vectors/meshBinV4.vectors.json` |
| Decisions | `docs-site/docs/LPS/v4plan/DECISIONS.md` (D0–D10) |
| VM | BCH 2026-05 (`BCH_2026_05`); standard (relay) rules |

## 1. What a bin is

A bin is one UTXO at one price level of a position. It holds BCH and at most one fungible token, the pair's `tokenCat`, and trades in place. A fill spends the bin at input `i` and recreates it at output `i` with identical locking bytecode. Its sats and tokens change, and nothing else does. A position is a set of bins sharing an `ownerCat`: the category of the position NFT, whose holder controls every bin.

There's no proceeds output, no mirror UTXO and no index offset. A bin that is sold out of tokens keeps its UTXO and can be bought back through.

## 2. Parameters and encoding

P2SH32. The redeem script is the parameter pushes followed by the template body. Pushes run last argument first, and every value has a fixed width, so the prefix length is constant (a 1-byte value would be minimally encoded as `OP_N` and break that).

| # | Parameter | Type | Encoding | Meaning |
|---|---|---|---|---|
| 1 | `tokenCat` | bytes32 | category, **VM byte order** (reversed display hex) | The pair's token; BCH is the other side |
| 2 | `bidNum` | bytes8 | LE, 1 … 2^63−1 | The bin **buys** tokens at `bidNum/bidDen` sats per token unit |
| 3 | `bidDen` | bytes8 | LE, 1 … 2^63−1 | |
| 4 | `askNum` | bytes8 | LE, 1 … 2^63−1 | The bin **sells** tokens at `askNum/askDen`; ask ≥ bid |
| 5 | `askDen` | bytes8 | LE, 1 … 2^63−1 | |
| 6 | `ownerCat` | bytes32 | category, VM byte order | Position NFT category |
| 7 | `managerHash` | bytes32 | script hash | `hash256` of the position manager's redeem script; 32 zero bytes = no manager |
| 8 | `manageAfter` | bytes4 | LE, block height 0 … 499,999,999 | `manage()` is closed before this height |

**Prefix (140 bytes):** `04 manageAfter · 20 managerHash · 20 ownerCat · 08 askDen · 08 askNum · 08 bidDen · 08 bidNum · 20 tokenCat`. Body: 167 bytes. Redeem script: 307 bytes.

So anyone, including the manager on chain, can rebuild a bin's address from its parameters: `P2SH32(hash256(prefix ‖ body))`.

## 3. Paths

The unlocking data selects a path (`0` fill, `1` owner, `2` manage) and pushes the redeem script.

### 3.1 `fill()`: anyone

With `i` the bin's own input index:

1. `outputs[i].lockingBytecode == inputs[i].lockingBytecode`.
2. The input's and output's token category are each either `tokenCat` exactly, or empty (no token).
3. `outputs[i].nftCommitment` is empty.
4. `outputs[i].value ≥ 1,000`.
5. `dt = outputs[i].tokenAmount − inputs[i].tokenAmount`, `ds = outputs[i].value − inputs[i].value`.
6. Side: `(n, d) = (askNum, askDen)` if `dt < 0` (the trader buys tokens), else `(bidNum, bidDen)` (the trader sells, or a top-up).
7. `min(n, d) > 0`.
8. **`ds · d + dt · n ≥ 0`**: the bin's value at the side's price doesn't fall.
9. `askNum · bidDen ≥ bidNum · askDen` (ask ≥ bid).

**Rounding.** Rule 8 is exact integer arithmetic with no division (the 2025 VM's integers are big enough for the products). Any fractional amount is therefore the trader's to round up (buys) or down (sells), never the bin's. Examples: at ask 7/3, 2 tokens cost at least 5 sats; at bid 5/3, 2 tokens pay at most 3.

**What 2 and 3 cover.** A mutable or minting NFT adds a capability byte to the category, so it fails 2. An immutable NFT with a commitment fails 3. An immutable NFT with an **empty** commitment can't be seen by introspection: it can ride along and goes to the owner on withdraw. It can't change the bin's value.

**Why 7 and 9.** Integers are signed (sign-magnitude), and a denominator of 0 makes rule 8 vacuous. A bin created with ask < bid could be drained by a buy-then-sell round trip. The encoder refuses both cases. The script refuses them too, so a mis-built bin can't lose funds through `fill()`.

### 3.2 `owner(int k)`: the position NFT holder

1. `inputs[k].tokenCategory`, first 32 bytes, `== ownerCat`.
2. `length(inputs[k].tokenCategory) + length(inputs[k].nftCommitment) > 32`: a mutable or minting NFT (33-byte category, the capability byte) passes with any commitment; an immutable NFT (32-byte category) needs a non-empty commitment.

There are no output rules: withdraw, reprice, move, merge or split freely. Rule 2 stops a *fungible* token of `ownerCat` from passing: it shows a 32-byte category and an empty commitment, like an immutable NFT with an empty commitment, which is therefore refused too. A mutable NFT can never lock its position, even if its holder clears the commitment. Genesis gives the NFT a non-empty commitment and leaves no minting NFT and no fungible supply (`test/position.ts` `checkGenesis`, N1–N3). A minting NFT of the category would also pass, by design: whoever holds one can mint owners anyway.

### 3.3 `manage()`: the position manager

1. `inputs[0].lockingBytecode == P2SH32(managerHash)`.
2. `tx.time ≥ manageAfter` (`OP_CHECKLOCKTIMEVERIFY`): the transaction's locktime is a block height at or after `manageAfter`, and the input isn't final.

The manager (V4b) checks everything else: the listed bins, conservation, bounds, the keeper's signature, and each new bin's `manageAfter ≥ locktime + cooldown`.

`manageAfter` is an absolute height carried in the bytecode, so fills don't move it. A relative age (`OP_CSV`) would reset on every fill, and anyone could reset it with a zero-change fill (D10).

## 4. Option variants

Separate contracts, not flags: an unused flag would still cost bytes on every fill of every bin. Extra parameters come after `manageAfter`, so they're pushed first.

| Variant | Extra parameters (push order: last first) | Prefix · body · redeem | Rule changes |
|---|---|---|---|
| `MeshBinV4` | — | 140 · 167 · 307 | — |
| `MeshBinV4Locked` | — | 140 · 136 · 276 | No `owner` path: permanent liquidity. Fills and the manager still work |
| `MeshBinV4Vesting` | `unlockHeight` bytes4 | 145 · 173 · 318 | `owner` also needs `tx.time ≥ unlockHeight` |
| `MeshBinV4FeeSchedule` | `fee0` bytes2 · `h1` bytes4 · `fee1` bytes2 · `h2` bytes4 · `fee2` bytes2 | 159 · 247 · 406 | `fill(int tier)`. Tier 0 is always open; tier k > 0 needs `tx.time ≥ hk`; fee in [0, 10000). Rule 8 becomes `ds·d·10000 + dt·n·(10000 ± fee) ≥ 0` (+ on buys, − on sells). Encoder: fee0 ≥ fee1 ≥ fee2, h1 ≤ h2 |
| `MeshBinV4SizeFee` | `baseFee` bytes2 · `slope` bytes2 · `refSize` bytes8 · `maxFee` bytes2 | 158 · 265 · 423 | `F = min(maxFee·ref, baseFee·ref + slope·max(0, |dt| − ref))`; rule 8 becomes `ds·d·10000·ref + dt·n·(10000·ref ± F) ≥ 0`. Exact (no division) |

Note on the fee schedule: a time-based locktime can't satisfy `tx.time ≥ hk` when hk is a height. Tier 0 needs no locktime.

## 5. Composition

Every check is on index `i`, input 0 (manage) or input `k` (owner), so a bin composes with any other covenant that also checks only its own indices. The VM suite builds one transaction holding a V4 bin, a `LimitOrderSwapV2` intent, a `MeshPoolV3` pool and a Cauldron PoolV0 pool, and each covenant still refuses its own violation (B7). Two constraints:

- A bin's output is at its own index, so a V3 pool in the same transaction still finds its proceeds slot at `i + inputCount`.
- `manage()` needs a height locktime, and `LimitOrderSwapV2` needs a time locktime. **A manage transaction can't also fill intents.**

## 6. Invariants (tested)

| | Property | Where |
|---|---|---|
| P1 | After any accepted fill, the bin's value at its bid **and** at its ask has not decreased | L2 fuzz |
| P2 | Sats and every token category are conserved by the transaction | L2 fuzz |
| P3 | No counterparty gains from a bin beyond the priced trade | L2 fuzz |
| P4 | Each bin's output is at its own index; two bins can't share or swap outputs | B7 |
| P5 | Only the NFT holder, or the named manager after `manageAfter`, can spend a bin other than by a priced fill | B8, B9 |

## 7. Sizes

| | Bytes |
|---|---|
| Bin input (outpoint, sequence, unlocking 311) | 354 |
| Bin output, no token / with token | 44 / 79 |
| **Per bin crossed** (24-bin sweep, buy / sell) | **398 / 433** (V3: ~1,100) |
| Op cost of a fill | 19,271 of 281,600 (7 %) |

## 8. What the server must check before funding a bin

`validateBinV4` in `test/v4_encode.ts` is the reference; the vectors include 14 invalid cases.
- Categories are 64-char lowercase hex; `ownerCat ≠ tokenCat`; `tokenCat` is non-zero.
- Prices are 1 … 2^63−1, with ask ≥ bid.
- `manageAfter` (and `unlockHeight`, `h1`, `h2`) are block heights below 500,000,000.
- Fees are below 10,000 bps and don't rise over time.
- The size fee satisfies 0 ≤ base ≤ max, `refSize` > 0 and `slope` < 2^15.
- Variant extras appear only on their variant.

## 9. Tests

| Suite | File | Cases |
|---|---|---|
| Harness self-test | `test/selftest.ts` | 21 |
| L3 vectors | `test/MeshBinV4.vectors.test.ts` | 34 |
| B0–B9 | `test/MeshBinV4.test.ts` | 77 |
| Position NFT (N1–N5, BCMR, vectors) | `test/PositionNft.test.ts` | 78 |
| B10 options | `test/MeshBinV4.options.test.ts` | 34 |
| B7 composition | `test/MeshBinV4.composition.test.ts` | 8 |
| L2 property, fuzz, mutants | `test/MeshBinV4.property.test.ts` | 400 random transactions per run (`V4_FUZZ_N` for more); 8 mutant bins must each be caught |

Every rejection must come from the bin's own input. Most also name the exact `require` that fails, checked against CashScript's debug VM as a second evaluator. Run everything with `npm test`.
