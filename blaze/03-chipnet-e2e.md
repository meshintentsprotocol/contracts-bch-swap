# Chipnet end-to-end matrix and run log

Status: baseline check, 2026-11-17. Do not mark Blaze E2E green until the new scripts and builders exist and transactions have been verified on chipnet.

## Required lifecycle matrix

| Run | On-chain sequence | Proof to retain |
|---|---|---|
| E1 BCH DBC | seed → FT genesis → curve funding → buy → sell → final partial buy/refund → completion → V4 graduation → post-grad swap → three fee claims | txids, decoded outputs, reserve/fee ledger, ≥90% lock scripts |
| E2 token quote DBC | seed → FT genesis → paired vault funding → two-sided trades → final partial buy/refund → paired completion → direct token/token graduation → swap → fee claims | both vault input/output pairs, categories, sats carriers, market depth |
| E3 Presale success | funded sale → deposits → success → buyer claims → creator proceeds or precommitted handoff | receipt consumption, allocations, unsold supply |
| E4 Presale failure | funded sale → deposits → failure → every quote refund → creator recovers unallocated base | exact quote and fee refunds, no double claim |
| E5 Alpha fixed | pre-public fixed-price deposits → allocation settlement → claims/refunds → public activation | committed price, allocated supply, timing |
| E6 Alpha buy | pre-public deposits → guarded DBC buys → pro-rata claims and unused quote refunds → public activation | price bound, actual used quote, expiry behavior |
| E7 adversarial | malformed companion, category, output, fee, refund, lock or claim transactions | rejected VM reason and no accepted chipnet tx |

For every run, record network height, artifact and manifest hashes, source revision, exact txids, explorer links, decoded transaction diffs and balances. Use isolated funded chipnet wallets; never log WIFs. Do not reuse `wallet.json` in committed fixtures.

## Existing baseline, not Blaze E2E

The repo has `v4/tools/chipnet-position-genesis.ts` for a live position-NFT seed/genesis and `v4/tools/resolve-position-metadata.ts` for a read-only chain/BCMR verification. The V4 local suite is `npm.cmd test` in `v4`. The current run result and any chipnet query result are recorded below after execution. Neither script exercises a Blaze token launch, because Blaze contracts and builders are not implemented yet.

## Run log

| Check | Result | Evidence |
|---|---|---|
| Branch | `bchblaze` | `git branch --show-current` |
| Initial worktree | Clean | `git status --short` produced no paths |
| `npm.cmd test` in `v4` | **350 passed, 0 failed** outside sandbox | Initial sandbox run hit Node 24.11.1 `os.userInfo()` ENOMEM before assertions; rerun completed every V4 suite with exit 0 |
| Live chipnet read-only check | Chain and metadata assertions passed; process exit 1 | `resolve-position-metadata.ts` verified category `9b9b2ed9…10ad130`, genesis `1a64e4fc…d56b81`, authchain, BCMR hash, unspent identity output and NFT parse, then Node printed Windows libuv `UV_HANDLE_CLOSING` assertion after `resolved like a wallet: OK` |
| Blaze E1–E7 | Not runnable yet | Offline genesis and BCH curve prototypes plus a token-quote vault prototype exist; graduation, mature markets, Presale and Alpha artifacts/builders do not |
| Blaze genesis offline VM | **15 passed, 0 failed** | `v4/blaze/test/genesis.test.ts` compiled with the pinned V4 TypeScript toolchain and ran under Node; signed seed and fixed-supply genesis, including same-category mutable state NFT, passed BCH VM; minting NFT rejected by verifier |
| Blaze manifest offline | **14 passed, 0 failed** | `v4/blaze/test/manifest.test.ts` verifies deterministic binary encoding, golden hash, allocation and NFT commitment, fee/route and paired quote-vault sensitivity, 90% lock setting and genesis `MBLZ` hash output |
| Blaze BCH curve reference math | **8 passed, 0 failed** | `v4/blaze/test/curve-math.test.ts` checks buy/sell, fee and reserve conservation, partial final fill/refund, no virtual quote withdrawal and state commitment encoding |
| Blaze hosted BCMR verification | **4 passed, 0 failed** | `v4/blaze/test/metadata.test.ts` checks exact hosted bytes, changed bytes, HTTP failure and HTTPS requirement with stub responses |
| Blaze BCH curve prototype VM | **23 passed, 0 failed** | Compiled `v4/blaze/contracts/curve/MeshBlazeBchCurveV1.cash`; buy/sell, three fee claims, terminal refund, seller payout and fee-cap attacks tested in BCH VM; no graduation or chipnet lifecycle yet |
| Blaze BCH constructor and plans | **16 passed, 0 failed** | `v4/blaze/test/curve-contract.test.ts` reconstructs the committed script; manifest-derived buy, sell and claim plans pass BCH VM; unsafe reserve/fee products, diverted proceeds, altered recipients, slippage and insufficient funding are rejected |
| Blaze BCH VM cost samples | Measured locally | Buy 1,913 bytes and 136,571 op cost; sell 1,840/136,354; terminal buy 1,913/136,650; fee claim 1,700/136,256. All below VM maxima in this harness; chipnet relay and worst-case limits remain untested. |
| Blaze token quote-vault VM | **5 passed, 0 failed** | Compiled buy-side `MeshBlazeTokenQuoteVaultV1.cash`; initial quote vault buy and three tampered spends tested. Sample 1,088 bytes, 37,365/370,400 op cost for quote-vault input. Chipnet lifecycle absent. |
| Blaze paired token-quote VM and plan | **25 passed, 0 failed** | Both `MeshBlazeTokenBaseVaultV1.cash` and `MeshBlazeTokenQuoteVaultV1.cash` spend atomically for buy, sell and whole-balance fee claims; manifest-derived unsigned plans pass the BCH VM. Exact-funded and terminal refund buys pass; wrong price, fee split, script, category, refund, payout and ledger fail. Sample buy 3,420 bytes, base 155,495/1,440,800 and quote 103,366/898,400 op cost; sell and claim samples are in the [technical note](../v4/blaze/docs/token-quote-v1.md). Graduation and chipnet absent. |
| Blaze BCH graduation prototype VM | **14 passed, 0 failed** | A separate V2 prototype can fund the fee-bearing locked bin and all three collectors atomically from a completed BCH curve state. It rejects substituted bins, underlocked token or BCH, NFT alteration, redirected sponsor change, unclaimed curve fees and nonterminal state; the 100% lock path passes. OP_0 archive spend rejection passes VM; position NFT genesis and archive relay proof are not ready; no chipnet handoff. |
| Blaze BCH market fee collector and locked bin VM | **9 collector VM; 13 bin VM, 0 failed** | Collector supports BCH accrual and whole-balance claims. Locked bin buy/sell enforces exact LP/creator/partner/protocol fee allocation through three paired collector inputs. Creator-owned fee bin has 5 VM checks, including exit with claims preserved. Sample locked-bin transactions are 2,271/2,200 bytes; no manifest reconstruction, multi-bin or chipnet market lifecycle yet. |
| Blaze typecheck | Passed | `npm.cmd run typecheck` in `v4/` includes `v4/blaze/**/*.ts` |

The Node errors are execution environment/process-shutdown issues; the completed V4 suite itself passed. The chipnet verifier's nonzero exit remains an automation defect to fix before using it as a CI gate, even though every printed chain assertion passed. The Blaze genesis VM test is offline and does not prove a Blaze E2E lifecycle.
