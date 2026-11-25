# Mesh Blaze repository tree

Status: implementation layout, 2026-11-17. Runtime code lives under `v4/blaze/` so it resolves the pinned CashScript 0.14 and BCH 2026 VM dependencies already used by Mesh V4. The old V4 contract artifacts and tests stay separate. Documentation and run reports live in root `blaze/`. Names for unimplemented scripts are provisional.

```text
contracts-bch-swap/
|-- contracts/                         existing V3 and legacy contracts
|-- blaze/                             Mesh Blaze plans and reports
|   |-- README.md
|   |-- 01-token-genesis-and-funding.md
|   |-- 02-implementation-and-commits.md
|   |-- 03-chipnet-e2e.md
|   |-- 04-repository-tree.md
|   `-- 05-phase-tracker.md
`-- v4/
    |-- contracts/                      existing V4 scripts; frozen variants stay intact
    |-- test/                           existing V4 suites
    |-- tools/                          existing V4 chipnet tools
    `-- blaze/
        |-- src/
        |   |-- genesis/               seed and fixed-supply genesis planner (started)
        |   |-- manifest/              canonical config and artifact pinning
        |   |-- math/                  integer price, fee and refund reference math
        |   |-- curve/                 trade and final-fill builders
        |   |-- graduation/            output plans and lock proof
        |   |-- market/                graduated trades and fee claims
        |   |-- sale/                  presale receipts and settlement
        |   `-- alpha/                 two pre-public settlement modes
        |-- contracts/
        |   |-- curve/
        |   |   |-- MeshBlazeBchCurveV1.cash
        |   |   |-- MeshBlazeTokenBaseVaultV1.cash  compiled buy-side prototype
        |   |   |-- MeshBlazeTokenQuoteVaultV1.cash compiled buy-side prototype
        |   |   `-- MeshBlazeCompleteV1.cash       if a separate terminal script wins
        |   |-- graduation/
        |   |   |-- MeshBlazeBchGraduateV1.cash
        |   |   `-- MeshBlazePairGraduateV1.cash
        |   |-- market/
        |   |   |-- MeshBlazeBchBinFeeV1.cash
        |   |   |-- MeshBlazePairBaseBinV1.cash
        |   |   |-- MeshBlazePairQuoteBinV1.cash
        |   |   `-- MeshBlazeFeeClaimV1.cash       if a separate fee pot wins
        |   |-- sale/
        |   |   |-- MeshBlazePresaleBchV1.cash
        |   |   |-- MeshBlazePresaleTokenV1.cash
        |   |   `-- MeshBlazeSaleReceiptV1.cash    if separate receipts win
        |   |-- alpha/
        |   |   |-- MeshBlazeAlphaFixedV1.cash
        |   |   `-- MeshBlazeAlphaBuyV1.cash
        |   `-- vesting/
        |       `-- MeshBlazeTokenVestingV1.cash   if template offers vesting
        |-- test/
        |   |-- genesis.test.ts        first offline VM test (started)
        |   |-- vectors/
        |   |-- vm/
        |   |-- properties/
        |   `-- chipnet/
        |-- tools/                      dry-run and independent chain verification
        |-- artifacts/                  reproducible compiler outputs
        `-- docs/                       ABI, state diagrams and audit notes
```

Genesis is a transaction builder, not a covenant. BCH quote has one token-bearing curve UTXO; CashToken quote requires atomically paired base and quote vaults. Graduation moves completed reserves only to manifest-pinned market scripts. Presale and the two Alpha modes have distinct custody and refund rules. Fee claims must never withdraw permanently locked principal.

The first executable slice is `v4/blaze/src/genesis/plan.ts` and `v4/blaze/test/genesis.test.ts`. It builds signed offline seed/genesis transactions with the existing V4 toolchain and checks fixed-supply allocation. It makes no network call and never broadcasts.
