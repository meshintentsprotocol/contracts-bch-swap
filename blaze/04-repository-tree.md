# Proposed Mesh Blaze repository tree

Status: proposed structure, 2026-11-17. File names are working names until transaction layouts and compiled VM limits are proven. `v4/` remains the existing Mesh market family; Blaze source is isolated under `blaze/` on `bchblaze`.

```text
contracts-bch-swap/
├─ contracts/                         # existing legacy/V3 contracts
├─ v4/
│  ├─ contracts/                       # existing V4; keep frozen artifacts intact
│  ├─ test/                            # existing V4 VM suites
│  └─ tools/                           # existing position NFT genesis/checks
└─ blaze/
   ├─ README.md
   ├─ 01-token-genesis-and-funding.md
   ├─ 02-implementation-and-commits.md
   ├─ 03-chipnet-e2e.md
   ├─ 04-repository-tree.md
   ├─ contracts/
   │  ├─ curve/
   │  │  ├─ MeshBlazeBchCurveV1.cash          # BCH quote: buy/sell/final buy
   │  │  ├─ MeshBlazeBaseVaultV1.cash         # launch FT side of token quote
   │  │  ├─ MeshBlazeQuoteVaultV1.cash        # CashToken quote side
   │  │  └─ MeshBlazeCompleteV1.cash          # terminal state, if distinct script wins
   │  ├─ graduation/
   │  │  ├─ MeshBlazeBchGraduateV1.cash       # completed BCH curve → market outputs
   │  │  └─ MeshBlazePairGraduateV1.cash      # completed token pair → paired market
   │  ├─ market/
   │  │  ├─ MeshBlazeBchBinFeeV1.cash         # fee-bearing BCH/token V4 derivative
   │  │  ├─ MeshBlazePairBaseBinV1.cash       # token/token base reserve
   │  │  ├─ MeshBlazePairQuoteBinV1.cash      # token/token quote reserve
   │  │  └─ MeshBlazeFeeClaimV1.cash          # only if separate fee pot is chosen
   │  ├─ sale/
   │  │  ├─ MeshBlazePresaleBchV1.cash        # BCH quote escrow/claims/refunds
   │  │  ├─ MeshBlazePresaleTokenV1.cash      # token quote paired custody
   │  │  └─ MeshBlazeSaleReceiptV1.cash       # participant claim right, if separate
   │  ├─ alpha/
   │  │  ├─ MeshBlazeAlphaFixedV1.cash        # fixed-price pre-public allocation
   │  │  └─ MeshBlazeAlphaBuyV1.cash          # bounded pre-activation DBC buys
   │  └─ vesting/
   │     └─ MeshBlazeTokenVestingV1.cash      # only if launch template offers vesting
   ├─ src/                               # TypeScript builders and independent checks
   │  ├─ genesis/                       # seed/genesis, fixed-supply allocations, BCMR
   │  ├─ manifest/                      # canonical config encoding and artifact pinning
   │  ├─ math/                          # integer curve/fee/refund reference math
   │  ├─ curve/                         # BCH and paired-token tx builders
   │  ├─ graduation/                    # market output planning and lock verifier
   │  ├─ market/                        # mature-market swaps and fee claims
   │  ├─ sale/                          # presale receipts, claims and refunds
   │  └─ alpha/                         # two distinct pre-public modes
   ├─ test/
   │  ├─ vectors/                       # fixed JSON math and byte-layout vectors
   │  ├─ vm/                            # accepted/rejected covenant transactions
   │  ├─ properties/                    # conservation, rounding, paired atomicity
   │  └─ chipnet/                       # funded E1–E7 lifecycle scripts
   ├─ tools/                             # dry-run plans, artifact checks, chain verifier
   ├─ artifacts/                         # generated, reproducible CashScript artifacts
   └─ docs/                              # ABI, state diagrams, audit and release records
```

## Why these boundaries

- **Genesis is builder code, not a covenant.** CashToken category comes from the seed transaction's txid; the genesis transaction mints fixed FT supply once and funds committed destinations. No continuing mint authority is allowed for a verified launch.
- **Curve is custody plus pricing.** BCH quote can live in one token-bearing state UTXO with BCH; token quote needs two UTXOs because each output can carry only one token category. Both vaults must agree on one atomic trade and state transition.
- **Completion and graduation are separate permissions.** Normal trades stop at threshold. A permissionless graduate path can move reserves only to manifest-pinned market scripts and allocations.
- **Market contracts are distinct from the launch curve.** Existing V4 cannot directly trade token/token or distribute continuing creator/partner/protocol fees. New fee-bearing derivatives or paired-market contracts are needed; lock proof applies to both assets.
- **Presale and Alpha have different obligations.** Presale can fail and refund. Alpha fixed allocates pre-funded FT at a committed price. Alpha buy holds quote, trades against the authentic curve before public activation and refunds unused quote.
- **Fee claim shape is provisional.** A separate pot contract may be unnecessary if safe accrued balances and claims fit inside the market state. Keep the file conditional until VM prototypes decide.

## First directory to implement

Start with `src/genesis`, `src/manifest`, `src/math`, and `test/vectors` before writing `contracts/curve`. The first implementation commit should produce a deterministic seed/genesis plan, exact supply-sum proof and dry-run verification. It must not broadcast or consume a funded wallet by default.
