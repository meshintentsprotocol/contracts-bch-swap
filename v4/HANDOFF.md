# Mesh V4: handoff (where to pick up)

Written 2026-10-16. Read this first in a new session. The plan itself is in `docs-site/docs/LPS/v4plan/` (01 phases, 02 contracts and CHIPs, 03 testing, 04 frontend). Background is in `docs-site/docs/LPS/protocol discusions/` 06, 10 and 11.

## Where we are

**V4 Phase 0 has started. Nothing else in V4 is built.** Everything before V4 is built, tested and committed (branch `alpha` in each repo):

| Repo | State |
|---|---|
| `BCHMesh/meshserver` (root repo) | V3 upgrades plus I-1 to I-6, last commit `24476da`. jest 451/451; VM checks green. **Not deployed to Railway** |
| `frontend` | V3 upgrade UI plus admin Market & Liquidity, last commit `40441c4`. `.env` (gitignored) points every Mesh URL at `http://localhost:3001` |
| `docs-site` | LPS course, protocol discussions, alphav3upgrades (R008 report), v4plan all committed |
| `contracts-bch-swap` | `v4/` scaffold, commit `c51e8c6` |

**Done in Phase 0:**
- `v4/` is an isolated package: cashc and cashscript **0.14.0**, libauth **3.1.0-next.8** (exports `createVirtualMachineBch2026`), tsx, typescript. `npm install` is done.
- **Deviation from plan item 0.1:** the plan says to move all repos to 0.14. Instead, V3 stays on cashc 0.12.1 at the repo root, so its artifacts don't change, and V4 lives in `v4/`. The server can build V4 locking and unlocking bytecode itself with libauth, without needing the cashscript upgrade. Record this as a decision.
- `probe/Probe.cash` compiles. A `for` loop emits `OP_BEGIN`/`OP_UNTIL`. A helper function used once was inlined, so no `OP_DEFINE` appeared; a helper used twice or more should produce one, so check this in S1.
- `v4/.gitignore` re-includes `artifacts/`, because the repo root ignores it and V4 artifacts are tracked.

## Next steps, in order

1. **VM harness** in `v4/test/`. Build transactions with cashscript 0.14 (`TransactionBuilder`; every UTXO needs `lockingBytecode`), then verify them **explicitly** with libauth `createVirtualMachineBch2026()`. Provide `expectAccept` and `expectReject`. Model it on `test/mesh_test/_mesh_security_harness.ts` and `v3_encode.ts`: keys OWNER, TAKER and ATTACKER; fixed-width little-endian encoding. Add a self-test proving that a known-bad transaction is rejected, so the harness can't give false positives (the alpha FRI e2e did).
2. **Spike S1:** a `contracts/MeshBinV4.cash` draft. The bin holds BCH and token and flips in place, with a bid and an ask price and paths `fill`, `owner` (position NFT holder) and `manage`. Measure the real bytes per bin crossed against the ~430 B estimate and the ~1,100 B measured for V3. Spec: v4plan 02 §2.
3. **Spike S2:** the same bin as a P2S locking script of 201 bytes or less, plus a looping validator. Measure both.
4. **Spike S3:** a `PositionManagerV4` draft that loops over N bins. Find the largest N that fits the operation-cost budget per input.
5. **Spike S4:** can a bin derive its price on chain from `(step, index)`, using exponentiation by squaring, fixed point and shifts, with rounding the server can reproduce? Go or no-go.
6. **`docs-site/docs/LPS/v4plan/DECISIONS.md`**: D1–D8 with the measured numbers, plus the toolchain-isolation decision. Commit it, then start **Phase 1**:
   - MeshBinV4 spec;
   - encoder plus `meshBinV4.vectors.json`;
   - VM suite B0–B10;
   - property and fuzz tests.

Phases 2–8 follow v4plan 01. The test cases are in v4plan 03: B, N and M for contracts; V1–V8 for the executor; the chipnet e2e steps S…C.

## CashScript 0.14 notes

- Helpers are top-level `function f(...) returns (T)` or void (`require` only). `checkSig` and `this.activeBytecode` are not allowed inside helpers. There is no `break` or `continue`.
- `new Contract(artifact, args, { provider, contractType: 'p2sh20' | 'p2sh32' | 'p2s' })`.
- Breaking changes from 0.12: `HashType` is now `SighashType`, odd-length hex is refused, and UTXOs need `lockingBytecode`.

## 2026 CHIP limits that shape V4

- **Live:** mainnet since 2026-05-15, chipnet since 2025-11-16.
- **Loops:** `OP_BEGIN`/`OP_UNTIL`. There is no iteration cap; loops are bounded by operation cost.
- **Functions:** `OP_DEFINE`/`OP_INVOKE`. The function table resets for each input, so functions can't be shared across inputs.
- **P2S:** standard locking scripts up to 201 B; unlocking scripts up to 10,000 B.
- **NFT commitments:** up to 128 B.
- **Data outputs:** several OP_RETURN outputs allowed, 223 B in total.

Details: protocol discussions 11.

## Rules (from the user; these override defaults)

- **No `Co-Authored-By` trailer in commits, ever.**
- **Don't deploy to Railway** until the user says so.
- Commit as each phase lands, with meaningful messages and no keys. Other sessions edit the same files, so check `git diff` before committing.
- Leave the docs-site build alone. Its navbar links to `/docs/LPS/00-*` are probably broken, and the user said not to fix them now.
- meshserver:
  - run jest with `--maxWorkers=2` (the machine has 8 GB of RAM);
  - stop the server and the bot before running `npm install`.
- Tooling on this machine:
  - there's no Python; use node or sed;
  - use the Edit tool for multi-line edits (node string-replace scripts failed to match before);
  - use WSL for Rust.

## Live state to remember

- The local meshserver on `:3001` runs the latest code. The frontend dev server is on `:5173`. The local balancer bot is not running.
- The **R008 test pools are still live on chipnet**. To clean them up, run this in meshserver:
  `OUT_DIR=data/v3up_live_2026-10-16 node node_modules/tsx/dist/cli.mjs test/e2e/e2e_v3_upgrades_live.ts cleanup`
- Open from the V3 list (alphav3upgrades 04 §4):
  - I-7: an arbitrage-sharing decision;
  - I-8: the R009 security and stress retest;
  - I-9: 7 days of liquidity-health history, which started 2026-10-16;
  - I-11: the Railway redeploy and a browser review.
