# Mesh Blaze allocation vesting boundary

Status: design only, 2026-11-17. No vesting covenant, builder or chipnet claim exists. Vesting applies to allocated launch FT; the graduated market liquidity lock is a different covenant and must be disclosed separately.

## First release shape

Use fixed-supply genesis allocations to fund one vesting UTXO **per tranche**. Commit each tranche's amount, recipient script hash, vesting artifact hash, unlock height and schedule identifier before genesis. The sum of curve, presale, Alpha, treasury, team and vesting allocations must equal the fixed genesis supply. A creator cannot change a schedule after the launch commitment or reclaim its tokens early.

Start with height-based cliff and discrete tranches. Each tranche holds only launch-category FT and its BCH carrier. Once its unlock height arrives, the covenant pays its entire FT amount to the committed recipient. A claim can combine several matured tranche inputs if each covenant can validate the shared output layout; otherwise claim them separately. A sponsor can fund the network fee and recipient token carrier without taking FT. Claim rights may be permissionless if the payout script is immutable. Do not use a server-maintained balance as authorization.

This format needs no mutable vesting NFT or successor state. A BCH output can hold only one CashToken category, so a separate-category state NFT cannot share a tranche output with the launch FT. Per-tranche UTXOs increase carrier cost; the launch builder must calculate that cost before funding. Continuous vesting would require a separate versioned state model and is deferred.

## Safety gates

The covenant must reject claims before unlock, partial or excess claims, changed recipients, substituted token categories or NFT capabilities, duplicate input/output accounting, and carrier/network-fee siphoning. Confirm the first, middle and final tranches on chipnet, including a late claim. The UI should show total, claimed, presently claimable and next unlock height from verified UTXOs. Presale and Alpha settlement may fund vesting only if their route and schedule were committed before deposits.

This is a distinct release gate after E2's paired graduation. The first public launch template can omit vested allocations until the covenant and chain evidence pass; any launch that advertises vesting must use the verified covenant.
