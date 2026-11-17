# Launch token genesis and curve funding

Status: offline seed/genesis builder implemented and BCH VM tested, 2026-11-17; funded chipnet genesis and launch funding remain open. This explains how Mesh creates a fixed-supply CashToken and funds a DBC curve on the UTXO ledger.

## CashToken category and supply

CashToken genesis requires input 0 to spend output 0 of an existing funding transaction. The funding transaction's txid becomes the new category. Use the V4 position-genesis builder as a **pattern for seed/genesis ordering**, but mint a fungible launch token rather than a position NFT. Keep launch category separate from any position NFT category and separate from a CashToken quote category.

1. **Seed transaction:** spend creator BCH, make a spendable output 0 reserved for genesis, and fund transaction fees/carrier sats. Persist unsigned and signed plans, txid, network and expiry. Avoid relying on an arbitrary wallet coin-selection result once the category is previewed.
2. **Genesis transaction:** spend the seed output as input 0; create the full committed fungible supply across curve inventory, presale allocation, Alpha fixed allocation, team/community vesting, creator allocation and explicit leftovers. Each token-bearing output needs BCH carrier sats. Publish a BCMR registry commitment and category metadata in a verifiable authchain. Reserve an identity output if updates to metadata are allowed; metadata authority must be disclosed separately from mint authority.
3. **Fixed-supply verified template:** do not create or retain a minting-capability NFT. A **mutable state NFT of the same launch-token category** may accompany the curve's fungible inventory to carry fee/reserve counters; it cannot mint new FT. The verifier must inspect the genesis and later history before labeling supply fixed; a UI checkbox or absent NFT in the curve output is insufficient. If a user imports an existing category with unknown issuance history, launch can remain open but cannot receive the fixed-supply badge without chain proof.
4. **Launch manifest:** commit category, total supply, all allocations, quote category or BCH marker, curve parameters, fee recipients/rates, activation and Alpha windows, graduation scripts, 90% lock floor, creator position share, vesting and sale routes. Hash the canonical binary manifest and pin its bytes/version in every launch covenant constructor or state. BCMR is display metadata, not the covenant's sole source of economic truth.

## Funding sequence and atomicity choices

The safest target is one genesis transaction that places launch FT directly into the curve and required allocation vaults and commits every script. This avoids an interim creator-controlled supply. If transaction size or wallet signing prevents it, use a two-step `genesis -> funding` sequence where **public activation is impossible until funding completes** and the manifest proves both transactions. No buyer or presale deposit may be accepted in a half-funded state. The seed transaction is necessary to know the category before constructing token outputs.

The curve does **not mint per trade**. Its base inventory is pre-funded from fixed genesis supply; buys transfer FT out, sells return FT to the curve. Virtual reserves affect the price formula, not the actual supply. The graduation base-token allocation and fixed-supply leftovers must be explicit so the curve cannot promise more FT than it holds.

| Quote | Curve custody | Genesis/funding requirement |
|---|---|---|
| BCH | One launch-FT state UTXO carries token inventory and BCH reserve/carrier | Supply portion and initial real BCH/carrier pinned; virtual BCH reserve is a number, not spendable BCH |
| Fungible CashToken | Paired launch-FT and quote-FT UTXOs, atomically spent by trades | Two categories cannot occupy one token output; funding must create both reserve vaults and enough BCH carriers |

For either quote, distinguish **real quote reserve**, **virtual reserve**, **carrier BCH**, **accrued fees**, **presale proceeds** and **miner fee budget** in formulas and outputs. A final buyer pays only for the used portion and receives any excess in an explicit refund output. Fee rounding must never silently move reserve or buyer funds into an operator-controlled output.

## Supply and sale accounting invariant

`genesis FT = curve inventory + presale inventory + Alpha fixed inventory + vesting inventory + creator/community inventory + explicit remainder` at genesis. Later movements preserve that total except provable burns. Alpha's pool-buy mode holds **quote**, then buys FT from the curve before public activation; it does not get a second launch-FT allocation. Presale defaults to standalone settlement. If an audited presale template seeds DBC or a direct market, the chosen destination and exact portion of proceeds are fixed before deposits open.

## Builder outputs and verification

Implement `planSeed`, `planGenesis`, `verifyGenesis`, `planCurveFunding`, and `verifyLaunchManifest` with dry-run VM checks before broadcasting. Expose deterministic tx hex, category, funding sources, output indices and sums, required signers, fees, metadata hash and destination script hashes. Never print private keys in logs or commit wallet files. Chipnet E2E must independently fetch seed/genesis and assert category, fixed supply, allocation outputs and BCMR hash.
