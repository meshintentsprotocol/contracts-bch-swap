# Mesh V4: handoff (where to pick up)

Updated 2026-10-17 (phases 0–4 closed; phase 5 under way; phase 6 keeper drafted+tested as spike; phase 7 products designed in v4plan/05). Read this first in a new session. The plan is in `docs-site/docs/LPS/v4plan/` (01 phases, 02 contracts and CHIPs, 03 testing, 04 frontend) and the decisions are in **`v4plan/DECISIONS.md`**. Background is in `docs-site/docs/LPS/protocol discusions/` 06, 10 and 11.

## Where we are

**Phases 0–4 are closed: contracts, position NFT (live on chipnet, shown in Cashonize), the server V4a and the frontend V4a (headless browser run on chipnet green). Phase 5 (hardening and launch) is next.** Specs: `docs/MeshBinV4.md` (1.1, frozen for audit) and `docs/PositionNft.md`. `npm test` in `v4/`: **350 passed, 0 failed**. `npm run typecheck` is clean.

| Repo | State |
|---|---|
| `contracts-bch-swap` (branch `alpha`) | `v4/`: harness, spikes, MeshBinV4 + 4 variants, encoder, vectors, every suite. Commits `1617e79` → `8fe4f44` → `bf13160` → the phase 1 completion commit |
| `docs-site` | `v4plan/DECISIONS.md` (`50d23f5`, updated with the phase 1 numbers) |
| `BCHMesh/meshserver` | Phase 3: `dbdc23d` → `80c1f4a` (router/executor legs, reconciler, position API, activity, depth, migration plan, buy-cap fix). Jest 546/546. **Not deployed to Railway** |
| `frontend` | Phase 4: `d0c532c` → `b1c8f50` (lib `src/lib/mesh/v4`, builder engine switch, position page, withdraw/send, migration, depth split, raw broadcast fix, user guide). vitest lib/mesh 156/156 |

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

- **398 B per bin crossed** (buying), 433 B (selling), against ~1,100 for V3. The fill uses 7 % of its op-cost budget.
- **D11 (phase 2):** the owner path accepts a mutable NFT with any commitment, so a holder can't lock their position by clearing it (+7 B).
- P2S bin + validator: 244 B per bin, cheaper from 3 bins. Deferred to V4a.1 (D2).
- Manager draft: 99 bins per call (op-cost bound).
- **D10: the bin's `cooldown` (UTXO age) became an absolute `manageAfter` height**, because every fill resets a UTXO's age.
- D4: keeper rules live in the manager's own parameters; `managerHash` commits to them.

## Next steps, in order

1. **Decisions are confirmed (2026-10-16).**
   - **D2: slim bins first.** The user briefly chose P2S first, then switched back after the safety review.
   - The rest: NFT-only ownership (D3), keeper rules in the manager (D4, V4b), no recovery (D6), `manageAfter` (D10); the oracle band is decided at phase 6 (D5).
   - P2S + validator stays a possible V4a.1 "fine-bin mode".
2. **Phase 2 is done (2026-10-16).** Position 9b9b2ed9… minted on chipnet (genesis 1a64e4fc…) with BCMR metadata at https://mesh-metadata.vercel.app/bcmr/<category>.json (static Vercel project `v4/mesh-metadata`); Paytaca's chipnet indexer resolves it; `tools/resolve-position-metadata.ts` checks it from chain. **Confirmed in Cashonize** by the user (all fields decoded); see docs/PositionNft.md §4–5.
3. **Phase 3: server V4a** in meshserver: port `v4_encode.ts` and `position.ts` with both vector files (L3 parity in jest), register positions with `checkGenesis`, index bins by `ownerCat`, add V4 legs to the router and executor, and add `scripts/check-v4-fills.ts` (V1–V8). A manage transaction can't also fill intents (height vs time locktime).
4. **Phase 3 is done (2026-10-16).** meshserver `src/pools/v4/` (binV4, grid, position, v4Pools, positionStore/Registry/Planner, metadataPublisher) and `/api/v1/v4` (preview, metadata pin, register, list/holder, detail, activity, withdraw-plan, migrate/plan, bins, grid). Live run: `test/e2e/e2e_v4_api_live.ts` (steps S D M F R H T W A G C), results in `data/v4_api_live_2026-10-16/`. Needs from the user: a pinning key (`PINATA_JWT`, or Filebase via kubo RPC) and `V4_IDENTITY_ADDRESS` for a real server; the Sanity import of the two docs pages.
5. **Phase 4 is done (2026-10-16).** Frontend: `src/lib/mesh/v4` (encoder with inlined template bodies, vector parity, `verify.ts` checks every server plan before signing, builders), `components/mesh/v4`, `pages/MeshPositionPage.tsx` (`/mesh/position/:category`). Headless Playwright run on chipnet against local :3001 (started with `V4_IDENTITY_ADDRESS` = the funder's address, env only) passed: deploy (seed step), position page, depth split, withdraw one bin, send NFT, V3 range → V4 in one signature, My positions. **Gotcha:** cashscript 0.12 `send()` debug-evaluates in a pre-2026 VM that refuses NFT commitments > 40 bytes; V4 sends use `signer.send(b, p, { raw: true })`. External wallets (Paytaca/Cashonize via WalletConnect) are untested with the 82-byte commitment. Not built: split position, admin positions page, V3 card "moved to V4" lineage.
6. **Phase 5 next:** chipnet E2E/stress (R009/R010 with V4), security review, audit #1 booking, capped mainnet (needs the user).
7. Phase 6 later: turn the S3 draft into `PositionManagerV4`. Consume the price list as it loops (its cost is quadratic now), use `gridPrice` for the K bound, and add tests M1–M10.

## Phase 5–7 progress (2026-10-17)

- **Admin V4 (phase 4.5):** meshserver `/api/v1/admin/v4/{positions,health,migration}` (src/api/routes/adminV4.ts) + frontend `/admin/v4` (src/admin/pages/V4PositionsPage.tsx). Registry, engine split, one-UTXO-per-bin invariant. jest 34/34; verified headless on chipnet (5 positions).
- **Pinning:** Pinata key in meshserver/.env (METADATA_PIN_PROVIDER=pinata + PINATA_JWT, gitignored — secret not in git/memory). Verified: Pinata stores at our raw-leaves CIDv1, live /metadata pins, resolves on gateway.pinata.cloud. Deploy panel auto-pins.
- **Phase 5.2 live attacks:** `meshserver/scripts/attack-v4-live.ts` broadcasts 3 hostile V4 spends to chipnet (under-pay, redirect, owner-path-no-NFT); all rejected code 16 (OP_VERIFY / OP_EQUALVERIFY / OP_SPLIT). Results in data/v4_attacks_live_<date>/. Phase 5.1 = e2e_v4_api_live.ts (done).
- **Phase 6 keeper:** spike `contracts/spikes/PositionManagerV4.cash` already enforces M1–M5, M8 and passes 21/21 (test/spikes/s3_manager_cost.ts): 803 B redeem, 99 bins/call. **Not promoted to contracts/ and not wired live** (post-audit-#1). Remaining: the K-bound (max centre move — the hard design, flagged in this handoff), oracle band (M6), keeper service (6.2), hostile-keeper simulation (M7), M9/M10 tests, audit #2.
- **Phase 7 products:** designed in `docs-site/docs/LPS/v4plan/05-v4c-products.md` (Meteora map + covenant sketches). Document only, per the user.
- **Known gaps:** split a position into a new NFT; external-wallet test of the 82-byte commitment; server-side V3→V4 lineage link (frontend records per-browser).
- **Remaining for the user:** V4_IDENTITY_ADDRESS on any real server; the Sanity import of the two docs pages; audit bookings (#1 V4a, #2 V4b); mainnet caps/go-ahead.

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
