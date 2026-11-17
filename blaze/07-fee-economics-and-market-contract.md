# Mesh Blaze fee economics and graduated market gate

Status: architecture decision proposal, 2026-11-17. No fee rate or recipient split in this document is live or approved for deployment. This applies the [Mesh production fee research](../../devrel-agent-context/MeshDocs/productiondoc/10-meteora-pool-monetization-and-mesh-design.md), [execution economics](../../devrel-agent-context/MeshDocs/productiondoc/02-monetization-and-execution-economics.md) and [upgrade sketch](../../devrel-agent-context/MeshDocs/productiondoc/11-upgrade-architecture-ideation.md) to Blaze. Existing funded V3/V4 contracts remain unchanged.

## What the current contracts actually collect

The Blaze curve prototypes account for creator, partner and protocol fees in their state NFT and allow whole-balance claims. Their example bps are test fixtures, not public launch pricing. `MeshBinV4.cash` earns through bid/ask inventory changes; `MeshBinV4Locked.cash` compounds that value without an owner exit. `MeshBinV4FeeSchedule.cash` and `MeshBinV4SizeFee.cash` change the price offered to the trader but allocate no protocol, creator or partner claim. Neither variant is a graduated Blaze fee market. The V2 graduation prototype points to those current bins only to prove asset conservation and script pinning; it cannot satisfy the agreed post-graduation fee promise.

## Recommended first market policy

1. Quote **one total market trading fee** against a defined bin exchange price. Split that fee into LP-compounding, creator, partner and protocol shares. The three recipients continue after graduation; the LP share remains market liquidity. Keep bid/ask spread separate in the quote and reporting. Do not count retained inventory or spread as a discrete treasury receipt.
2. Accrue small fee shares under covenant control in the traded quote asset and allow whole-balance claims once the asset's ordinary token/dust rules permit them. For BCH/token markets, use BCH for both buy and sell fee liabilities. For token/token markets, use the quote CashToken and fund its claim carrier BCH explicitly. This fixes the claim asset but does **not** fix a fee percentage.
3. Make the fee and split immutable per launch market. A later fee schedule needs a separately committed version and a full quote cap. Create a new market artifact and address; do not edit funded V4 bins or reinterpret their existing `fee` parameter as a protocol share.
4. Keep standard token creation, curve funding, liquidity deposit, graduation, ordinary withdrawal, tidy and position transfer free of an additional Mesh percentage in the first template. Users still pay actual network fees and required token carriers. Any future creation or migration charge requires an explicit new quote and committed payment obligation.
5. Quote execution cost and solver reward separately from the market trading fee. Partner compensation comes from the committed trading-fee allocation or a separately disclosed service fee, never an undisclosed add-on. An intent or hosted-route charge must appear in one combined user quote and total cost cap so the same trade is not silently charged twice.

An **illustration for economic testing only**: a 30-bps market fee could split 80% to LP liquidity, 10% to creator, 0–2% to partner and the remaining 8–10% to protocol, with the partner portion taken from an existing share. At 10% protocol share, the effective protocol charge is 3 bps of filled value. The production research proposes comparing 10% and 20% protocol portions; it does not approve either. Actual bps need small-trade, route-competitiveness and LP-return evidence. Open launches must use an explicit zero-partner rule and deterministic rounding destination.

## Required covenant accounting

| Event | Economic base | Required on-chain rule |
|---|---|---|
| Buy from BCH/token bin | Actual BCH paid for FT, excluding network/carrier transfers | Derive trade delta from input/output; calculate one fee; split with exact integer rounding; preserve principal pricing and accrue claimable BCH. |
| Sell to BCH/token bin | Actual gross BCH value of FT sold | Enforce seller net payout, fee split and bin principal; do not allow the builder to declare a favorable gross value. |
| CashToken/token trade | Actual quote-category FT delta | Enforce both token categories, quote fee ledger and carrier conservation atomically. |
| Claim | Accrued balance for one recipient | Pay committed script and correct asset exactly once; preserve reserves, other balances and all lock restrictions. |
| Owner/manager/rebalance | Principal and accrued fee liabilities | Never erase unpaid claims; any migration proves the same balances or settles them. Locked principal has no owner exit. |

The first BCH fee-bearing market should be a new, **locked** V4-style artifact with no owner withdrawal path. A separate creator-owned artifact may permit withdrawal of its disclosed principal, but it must settle or preserve all accrued fee liabilities first. The unique launch state NFT currently travels to an archive output on graduation; it cannot also be a mutable fee-state NFT in multiple market bins. Solve fee-state representation and the one-category-per-UTXO limit before coding multiple fee-bearing bins. A shared fee accumulator creates contention; per-bin accrual needs independently authenticated state and robust claim/exit rules. An accounting database entry alone does not make external solver payment enforceable.

### BCH collector spike

`MeshBlazeBchFeeCollectorV1.cash` now compiles and has eight BCH VM checks plus one builder dust rejection. A BCH-only UTXO at a recipient-bound script can grow at the same input/output index; anyone may claim its entire accrued balance to the immutable recipient while a sponsor pays the network fee. The sample accrue transaction is 492 bytes; the sample claim is 526 bytes. **The collector alone does not collect a trading fee.** The paired locked market bin below requires exact collector deltas on each prototype fill. A single collector per role can serialize fills, so the market should allow per-bin or sharded collector UTXOs and prove that old balances remain independently claimable. Three collector inputs per fill may be too costly; measure a complete paired trade before accepting this design. Token-quote markets need a separate token collector and carrier policy.

### Paired locked-bin spike

`MeshBlazeBchFeeBinLockedV1.cash` now compiles. Its fixed transaction layout spends one bin, three recipient-bound BCH collectors and one trader input. It recreates the bin and collectors at their same indices, derives notional from the actual FT delta and immutable bid/ask, charges one explicit fee with ceiling rounding, and distributes exact creator/partner/protocol accrual while retaining the LP share in bin BCH. The protocol receives the integer split remainder; a positive protocol share is required. A buy and sell plus 11 hostile-output checks pass the BCH VM. Sample buy: 2,226 bytes, bin op cost 77,042/772,800. Sample sell: 2,155 bytes, bin op cost 76,973/772,800. These are single-bin examples, not worst-case or relay-policy bounds.

The collector and bin together enforce recipient payment against a third-party trader on this prototype path. Remaining blockers: manifest-pinned reconstruction, safe arithmetic bounds for every price/trade product, realistic multi-bin routing cost, dust and claim liveness, fee-collector UTXO discovery/concurrency, creator-owned market variant with debt-safe exit, token/token market, terminal-price continuity and chipnet. The current V2 graduation prototype still funds old fee-less V4 bins; **do not connect it to this fee-bin artifact or advertise a complete fee-bearing graduation yet**.

## Changes we can include during Blaze development

- Define the market's total fee, four-way split, fee asset, integer rounding order, claim threshold, recipient scripts and claim carriers in a **versioned manifest extension** before public funding. Validate the combined maximum trading and execution quote in SDK/UI.
- Replace the current graduation prototype's destination hashes with fee-bearing market and archive artifact hashes. Reject existing V4 locked/owner bin scripts as production launch destinations until their economics match the launch terms.
- Add market VM attacks for omitted/redirected fee, wrong notional, small fee dust, duplicate payment across bins, fee-state rewrite, owner/manager exit debt, partial fill, mixed-version routing and reorg-aware accounting. Check serialized size and op cost for realistic multi-bin trades.
- Track **accrued**, **claimed** and **confirmed received** amounts separately in indexer/admin. Keep miner fees, carrier deposits, principal and LP price edge out of protocol revenue.

## Decisions before the fee market artifact

The starting recommendation is fee included in one displayed market quote, quote-asset accrual, 10% protocol share of the explicit market fee as a trial hypothesis, and no extra creation/graduation/exit percentage. The exact total bps, LP/creator/partner/protocol allocation, rounding owner, minimum claim amount, state layout and whether the creator share also uses the fee-bearing market need to be fixed together. They must be encoded in immutable artifacts and verified against economic examples before any chipnet launch lifecycle is called complete.
