# Mesh Blaze implementation sequence and commit plan

Status: planning, 2026-11-17. All commits below belong on `bchblaze`, with small reviewed diffs. Commit messages use Mesh/Blaze terminology. Do not change V4 frozen artifacts as a shortcut; create versioned variants or adapters with separate vectors.

| Commit | Scope | Acceptance gate |
|---|---|---|
| `docs(blaze): define UTXO launch state and acceptance gates` | This plan, lifecycle diagrams, decision manifest, test matrix | Reviewable transaction/asset tables |
| `feat(blaze): add deterministic token genesis planner` | Seed/genesis, fixed-supply allocation, BCMR hash, offline verification | VM vectors, category/input-0 proof, no minting NFT, supply-sum checks |
| `feat(blaze): add BCH quote curve and integer reference math` | Curve script, exact-in buy/sell, fee accounting, builder | Positive/negative VM vectors, reserve conservation, slippage and rounding |
| `feat(blaze): add token quote paired curve` | Base/quote vaults, atomic trade builder, category checks | No one-sided successor or mixed-launch spends; VM/relay limits measured |
| `feat(blaze): add final fill and completion state` | Threshold branch, used-quote fee, excess refund, terminal script | Boundary vectors and chipnet final-buy lifecycle |
| `feat(blaze): add fee-bearing graduated markets` | BCH/token V4 variant and direct token/token market with locked principal and three fee claims | Both assets ≥90% locked; fees claimable without principal exit |
| `feat(blaze): add permissionless graduation` | Manifest-pinned output verification, creator share, keeper builder | Completion-to-market chipnet lifecycle for both quote types |
| `feat(blaze): add presale settlement and audited routes` | Sale receipts, success/failure claims, standalone default, optional committed handoff | Refund/claim/double-claim and route tests |
| `feat(blaze): add Alpha allocation and buy vaults` | Separate fixed-price and bounded pre-activation variants | No public bypass; expiry; pro-rata/refund and claims |
| `feat(blaze): add launch SDK and indexer fixtures` | Builders, manifest registry, lock proof, event fixtures | Reorg replay and chain-derived state parity |
| `test(blaze): add chipnet launch lifecycle` | Funded lifecycle scripts and recorded txids | Two quote types, presale and both Alpha modes, fee claims, graduation |
| `docs(blaze): publish audit artifacts and operator runbook` | Reproducible hashes, compiler version, fee/dust budgets, recovery rules | Independent review reproduces builds and lock claims |

## Package layout proposal

Create `blaze/contracts`, `blaze/test`, `blaze/tools`, `blaze/artifacts` and `blaze/docs` once code begins. Reuse V4's CashScript 0.14 harness where compatible, but keep Blaze outputs versioned and isolated. Define common binary config and reference math in a small library; the BCH and token-pair contracts should share economic vectors without assuming identical transaction layouts.

## Hard gates before a public release

1. Every promised fee recipient and locked share is enforced by compiled bytecode, not an API balance.
2. Chipnet end-to-end coverage includes seed/genesis, launch funding, buy/sell/final buy, graduation, post-grad trade and fee claim for BCH and token quotes; Presale success/failure and both Alpha paths are separate runs.
3. Reproducible artifacts and external audit cover the actual scripts, builder output checks and wallet signing paths.
4. The UI independently verifies chain state and explains unverified categories, incomplete funding and any creator-owned unlocked share.

`v4/test/run_all.ts` is a useful existing baseline, but passing it does not satisfy a Blaze gate. The token/token destination, DBC curve, post-grad fee rights, Presale and Alpha do not exist in this repo yet.
