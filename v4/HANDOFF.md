# Mesh V4: handoff (where to pick up)

Updated 2026-10-16 (end of the phase 0 + phase 1 session). Read this first in a new session. The plan is in `docs-site/docs/LPS/v4plan/` (01 phases, 02 contracts and CHIPs, 03 testing, 04 frontend) and the decisions are in **`v4plan/DECISIONS.md`**. Background is in `docs-site/docs/LPS/protocol discusions/` 06, 10 and 11.

## Where we are

**Phase 0 is closed and phase 1 (`MeshBinV4`) is built.** The phase 1 exit criteria are met: all VM suites are green, byte figures are published, and the spec is frozen for audit in `docs/MeshBinV4.md`. `npm test` in `v4/`: **270 passed, 0 failed**. `npm run typecheck` is clean.

| Repo | State |
|---|---|
| `contracts-bch-swap` (branch `alpha`) | `v4/`: harness, spikes, MeshBinV4 + 4 variants, encoder, vectors, every suite. Commits `1617e79` → `8fe4f44` → `bf13160` → the phase 1 completion commit |
| `docs-site` | `v4plan/DECISIONS.md` (`50d23f5`, updated with the phase 1 numbers) |
| `BCHMesh/meshserver`, `frontend` | Unchanged since the V3 work (`24476da`, `40441c4`). **Not deployed to Railway** |

## What's in `v4/`

| Path | What |
|---|---|
| `contracts/MeshBinV4.cash` + `contracts/lib/bin.cash` | The bin. P2SH32; 300 B redeem script (140-byte prefix + 160-byte body); paths fill / owner(k) / manage |
| `contracts/variants/` | Locked, Vesting, FeeSchedule, SizeFee: separate small contracts sharing `lib/bin.cash` |
| `contracts/lib/grid.cash` | On-chain Q64 grid price; bit-exact with `test/grid.ts` |
| `contracts/spikes/` | S2 P2S bin + validator, S3 `PositionManagerV4` draft (already on `manageAfter` + cooldown), S4 grid bin and probe |
| `test/harness.ts` | Build with CashScript 0.14, verify with libauth `createVirtualMachineBch2026`. `expectReject` options: `at` (the failing input), `rule` (the failing `require` source text, attributed via CashScript's debug VM as a second evaluator), `reason`, `policy` |
| `test/tx.ts` | `balanced(legs)`: a case lists only covenant legs; the counterparty's inputs and outputs are added per category, so honest cases can't fail on bookkeeping |
| `test/v4_encode.ts` | Encoder for all variants, `validateBinV4`, prefix/lock/address rebuild |
| `test/vectors/meshBinV4.vectors.json` | 10 vectors + 14 invalid cases, artifacts pinned by sha256. Regenerate with `npm run vectors` **only** after a reviewed contract change |
| `docs/MeshBinV4.md` | The frozen spec (for auditors and the server encoder) |

## Key results (details in DECISIONS)

- **391 B per bin crossed** (buying), 426 B (selling), against ~1,100 for V3. The fill uses 7 % of its op-cost budget.
- P2S bin + validator: 244 B per bin, cheaper from 3 bins. Deferred to V4a.1 (D2).
- Manager draft: 99 bins per call (op-cost bound).
- **D10: the bin's `cooldown` (UTXO age) became an absolute `manageAfter` height**, because every fill resets a UTXO's age.
- D4: keeper rules live in the manager's own parameters; `managerHash` commits to them.

## Next steps, in order

1. **User review** of DECISIONS D2 (slim now, P2S later), D3 (NFT only), D4 (rules in the manager), D6 (no recovery), and **D10** (the `manageAfter` change to the plan).
2. **Phase 2: position NFT** (v4plan 01 §Phase 2; tests N1–N5 in 03 §2.2).
   - Genesis rules: input 0 spends an output #0; exactly one mutable NFT with a **non-empty commitment**; no minting NFT, no fungible supply.
   - 128-byte commitment layout (02 §3.2; the keeper fields can shrink now that D4 puts them in the manager).
   - `positionNft.vectors.json`.
   - The genesis + bins transaction as a VM test.
   - BCMR metadata.
   - A wallet showing the NFT on chipnet (Paytaca, Cashonize).
3. **Phase 3: server V4a** in meshserver: port `v4_encode.ts` and the vectors (L3 parity in jest), index bins by `ownerCat`, add V4 legs to the router and executor, and add `scripts/check-v4-fills.ts` (V1–V8). A manage transaction can't also fill intents (height vs time locktime).
4. Phase 6 later: turn the S3 draft into `PositionManagerV4`. Consume the price list as it loops (its cost is quadratic now), use `gridPrice` for the K bound, and add tests M1–M10.

## Rules (from the user; these override defaults)

- **No `Co-Authored-By` trailer in commits, ever.**
- **Don't deploy to Railway** until the user says so.
- Commit as each phase lands, with meaningful messages and no keys. Other sessions edit the same files, so check `git status`/`git diff` before committing.
- Leave the docs-site build alone (navbar links to `/docs/LPS/00-*` may be broken; the user said not to fix them now).
- meshserver: run jest with `--maxWorkers=2` (8 GB RAM); stop the server and the bot before `npm install`.
- Tooling on this machine:
  - there's no Python; use node or sed;
  - use the Edit tool for multi-line edits;
  - inside `node -e '…'`, regex backslashes get eaten, so prefer plain substrings;
  - use WSL for Rust.

## CashScript 0.14 notes (learned here)

- Helpers: top-level `function f(...) returns (T, U)`, then `return a, b;` (no parentheses) and `int a, int b = f();`.
  - A contract function must **end with a `require`**, so make helpers return a bool and `require(helper(...))`.
  - `tx.time` can only appear in a `require`.
  - Typed parameters (`bytes32`, `bytes4`) are needed for `LockingBytecodeP2SH32(...)` and the like. `bytes32(x)` casts are refused; use `toPaddedBytes` / `unsafe_bytes32`.
- A helper used once is inlined; one used twice becomes `OP_DEFINE`/`OP_INVOKE`.
- `import "./lib/x.cash";` works (paths relative to the file).
- `<<`/`>>` compile to `OP_LSHIFTNUM`/`OP_RSHIFTNUM`; `for`/`while` compile to `OP_BEGIN`/`OP_UNTIL`.
- `contract.bytecode` is the redeem script (P2SH) or the locking script (P2S). `contractType: 'p2s'` puts the whole script in the output.
- `addOutput({ to })` takes an address or **raw bytes** (a hex string is parsed as an address). UTXOs need `lockingBytecode`.
- The op-cost budget per input is (unlocking bytes + 41) × 800. A loop in one input buys budget with unlocking padding.
- cashc 0.12 artifacts (V2/V3) load in CashScript 0.14 unchanged.

## Live state to remember

- The local meshserver on `:3001` runs the latest V3 code; the frontend dev server is on `:5173`; the local balancer bot is not running.
- The **R008 test pools are still live on chipnet**. To clean them up, run this in meshserver: `OUT_DIR=data/v3up_live_2026-10-16 node node_modules/tsx/dist/cli.mjs test/e2e/e2e_v3_upgrades_live.ts cleanup`
- Open from the V3 list (alphav3upgrades 04 §4): I-7 arbitrage sharing, I-8 the R009 retest, I-9 7-day liquidity history (started 2026-10-16), I-11 the Railway redeploy and browser review.
