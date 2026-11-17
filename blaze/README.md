# Mesh Blaze contract implementation plan

Status: implementation started, 2026-11-17. Work branch: `bchblaze`. This directory is the contract-repo execution plan; executable code begins in `v4/blaze/`. Product decisions live in `devrel-agent-context/blaze-dbc`. No Blaze covenant is deployed.

Read in order:

1. [Token genesis and curve funding](01-token-genesis-and-funding.md)
2. [Contract sequence and meaningful commits](02-implementation-and-commits.md)
3. [Chipnet end-to-end test plan and current result](03-chipnet-e2e.md)
4. [Proposed repository and contract tree](04-repository-tree.md)
5. [Delivery phases and current status](05-phase-tracker.md)

## Contract boundary

Mesh V3 and V4 remain separate deployed families. Blaze adds launch-token genesis builders, BCH and token-quote curves, sale/Alpha vaults, completion and graduation covenants, and fee-bearing graduated markets. Existing `v4/contracts/MeshBinV4.cash` is a BCH/token bin, not a token/token DBC or a post-graduation three-recipient fee ledger. `v4/contracts/spikes/PositionManagerV4.cash` is research code, not a production manager.

The first public release covers open and curated launches, BCH and any fungible CashToken quote, a final partial fill with excess returned, at least 90% permanent lock of each graduated asset, a disclosed creator-owned unlocked share, creator/partner/protocol fees during and after the curve, fixed-supply verified launches, standalone Presale with optional committed market handoff, and both Alpha settlement modes before public trading.

## Definition of ready to code

Each contract gets a byte-level transaction layout, asset-conservation table, integer reference vectors, failure cases, artifact/version scheme, builder interface, and chipnet lifecycle before its source is promoted. The on-chain script must enforce claimed asset movement; a server plan or indexer label is not a substitute.
