# Mesh Blaze to V4 graduation contract boundary

Status: prototype gate, 2026-11-17. The production candidate BCH-quote V1 curve has no graduation path. A separate `MeshBlazeBchCurveV2Prototype.cash` compiles and its `graduate()` and `graduateAll()` paths pass 13 BCH VM checks, including atomic funding of the fee-bearing locked bin and three collectors. The draft V2 terms hash and unsigned handoff plan under `v4/blaze/src/graduation/` have 17 local assertions. Neither artifact is release ready.

## BCH quote: actual V4 funding

The completed curve UTXO holds the remaining launch FT, one mutable state NFT of the launch category, and BCH equal to `curve carrier + real quote reserve + unclaimed curve fees`. A permissionless graduation transaction must spend that UTXO and create V4 bin outputs directly. `MeshBinV4Locked.cash` is the base for the permanent portion. An independently owned `MeshBinV4.cash` position is the base for the disclosed creator portion. V4 bins hold BCH and the launch FT at a fixed bid/ask level; there is no single fungible LP token to deposit.

The first handoff should require all three curve fee balances to be claimed before graduation. That leaves `carrier + realQuote` in the curve, makes the graduation asset ledger unambiguous, and keeps pre-graduation fees independent of post-graduation rights. The network fee and any extra bin dust must come from an explicit sponsor input; the curve reserve must not pay the keeper. The state NFT must go to a committed, permanently unspendable sink or a purpose-built archive covenant. A plain burn or arbitrary output is insufficient until its CashToken conservation and relay behavior are proven in the BCH VM.

The V2 prototype checks terminal state, exact threshold, zero unclaimed fees, exact launch FT conservation, both BCH and FT lock percentages, destination script hashes, NFT commitment preservation, fixed curve carrier, sponsor change and a 5,000-sat fee cap. It has a two-bin path for 90–99.99% locked and a one-bin path for 100% locked. Both atomically create three recipient-bound collector UTXOs with exact BCH carriers; a VM fixture funds the new fee-bearing locked bin. The lock comparison uses quotient and remainder to avoid an intermediate signed-VM multiplication overflow. The state NFT now goes to `MeshBlazeStateArchiveV1.cash`, whose sole redeem script is `OP_0`; the BCH VM rejects an attempted spend. Relay acceptance and a funded chipnet lifecycle remain untested. The creator bin is still the old V4 owner variant, which does not enforce the Blaze market fee. These are release blockers.

The [market fee plan](07-fee-economics-and-market-contract.md) resolves the economic boundary: existing V4 spread and fee variants do not pay the launch's creator/partner/protocol shares. The production graduation destination must be a new fee-bearing market family with an LP-compounding share and claimable recipient shares; the graduation script must pin that family's exact artifacts and terms.

For remaining base amount `B` and real quote `Q`, committed lock setting `L` basis points (at least 9,000) requires `lockedBase >= ceil(B*L/10000)` and `lockedQuote >= ceil(Q*L/10000)`. The creator portion is at most the remainder of **each** asset, separately. Both destination scripts, bin prices, carriers, output order, position ownership and NFT disposition must be enforced by the graduation covenant, not merely checked by a wallet builder. A sponsor may pay fees and supply extra BCH, but cannot redirect either asset.

## Why current artifacts cannot safely implement this yet

- `MeshBlazeBchCurveV1.cash` commits only curve economics and pre-graduation fee recipients. It has no graduation destination or output validation. The separate V2 prototype commits exact market, collector, creator and archive output script hashes in constructor arguments. `bchGraduationCurveFromManifestV1` reconstructs the V2 script from market and graduation terms, then checks the manifest's curve hash and allocation. The creator market remains incomplete; the archive is VM-tested but not relay-tested.
- Manifest V1 has one `marketScriptHash` and one `graduationScriptHash`. Those do not identify the complete set of V4 bin scripts, prices, locked and creator position categories, required BCH carriers, state NFT destination, or fee-rights mechanism.
- `MeshBinV4Locked.cash` removes the owner withdrawal path and lets spread compound in the bin. It does not distribute creator, partner and protocol fees. A graduated market with continuing three-way fees needs a versioned V4 fee-bearing variant or an equally enforced settlement covenant. An off-chain revenue promise does not meet the launch commitment.
- `MeshBinV4.cash` lets the position NFT holder withdraw without output restrictions. That is suitable only for the disclosed creator share, which must never exceed 10% of either graduated asset at creation.
- Position NFT ownership uses a separate category from the launch FT. Its genesis and transfer to the lock or creator must be part of the verified launch history. The curve's mutable launch NFT is not a V4 position NFT.

## Contract and builder work order

1. Specify a versioned graduation terms commitment with exact destination scripts or a bounded Merkle commitment to a finite bin set. The draft `bchGraduationTermsHashV2` commits six exact scripts, one shared collector carrier, two position categories and the lock percentage; the unsigned plan checks it against a supplied hash. The prototype curve constructor pins the scripts and collector carrier indirectly through `curveScriptHash`, but the complete terms hash has no dedicated Manifest V1 field. Extend the commitment to cover verified artifact identities, price/depth continuity, output order and state-NFT archive semantics before freezing it.
2. Implement a V4 BCH/token fee-bearing locked-bin variant and a creator-share variant, or a composite settlement design, with claimable three-way fees and no locked-principal exit. Prove fees cannot be taken from principal or bypassed by a fill.
3. Add `graduate()` to a new versioned BCH curve artifact. Require stage 1, exact threshold, zero curve fee balances, unchanged category and total asset accounting, committed bin outputs, lock minimums for **both** assets, and fixed NFT destination. Test malicious output substitution, rounding, underfunded dust, fee theft and forged position ownership.
4. Build an unsigned graduation plan from the manifest and live UTXOs, then independently verify all outputs. Sign and execute a full chipnet lifecycle; record curve completion, fee claims, graduation, post-grad swap and three market fee claims as txids with decoded output proof.

## CashToken quote route

The paired curve's base and quote vault UTXOs must graduate atomically. Existing V4 bins each hold BCH and at most one fungible category, so they cannot directly represent a CashToken/CashToken pair. A direct token/token market needs its own paired vault or equivalent market covenant with a separately proved permanent lock and three-way fee ledger. Reusing the BCH V4 bin as if its satoshis were an arbitrary CashToken quote would misprice and misaccount the market.

## Release gate

Do not enable public funding or claim a V4 graduation path until the destination contracts, terms commitment, transaction builder, BCH VM adversarial tests, relay-policy check and chipnet lifecycle all pass. Existing V4 deployed artifacts remain unchanged; new variants receive distinct names and hashes.
