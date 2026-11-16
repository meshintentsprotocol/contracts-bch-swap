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
| Blaze E1–E7 | Not runnable yet | No Blaze contract source, artifacts or transaction builders |

The Node errors are execution environment/process-shutdown issues; the completed V4 suite itself passed. The chipnet verifier's nonzero exit remains an automation defect to fix before using it as a CI gate, even though every printed chain assertion passed. Neither result proves a Blaze E2E lifecycle.
