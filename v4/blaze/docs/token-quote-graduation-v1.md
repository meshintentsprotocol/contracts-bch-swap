# Mesh Blaze CashToken-quote graduation boundary

Status: E2 local prototype, 2026-11-17. `src/graduation/token-pair-handoff.ts` verifies the 90% and 100% layouts with 19 focused assertions. V2 base and quote vaults compile; local VM fixtures verify buy, sell, fee claim, graduation into compiled locked and creator-owned markets, locked-market buy and all three quote-token fee claims. Both vaults reject an out-of-band terminal price. Locked market buy/sell and eight attacks pass; the creator pair passes buy/sell, atomic NFT exit and five attacks. The quote-token collector passes eight VM checks, including zero-fee accrual. `token-pair-v2.ts` independently reconstructs all E2 artifacts, and `token-pair-launch-bundle.ts` binds the manifest, graduation terms and verified non-minting position NFT genesis into a distinct MBND hash. A linked 22-transaction signed local VM sequence now runs from token genesis through all curve and market fee claims, conserving both token supplies. See [local E2 evidence](../09-local-e2-evidence.md). Chipnet E2 and external review remain open. The [BCH E1 evidence](../../../blaze/08-chipnet-e1-evidence.md) does not prove this path.

## Asset model

The completed base vault holds launch-category FT and the sole mutable launch state NFT. The paired quote vault holds quote-category FT equal to `realQuote + creatorFees + partnerFees + protocolFees`. Graduation is permitted only at the exact threshold with all three curve fee balances zero. Therefore the quote vault holds exactly `realQuote` quote FT. Each vault keeps its own BCH carrier; the sponsor funds all new market and collector carriers plus the network fee.

Use `graduationSplitV1(baseFT, quoteFT, lockedBps)` for both assets, rounding **each locked amount upward**. Require `9000 <= lockedBps <= 10000`, positive reserves, and either both creator amounts positive or both zero. A one-sided creator position requires a separate versioned design. The locked amounts must be deposited into scripts with no principal withdrawal path; a fee claim must never be an exit path for either reserve.

## Atomic transaction layout

Input 0 is the completed base vault; input 1 is its exact paired quote vault; input 2 is a BCH-only sponsor. No other inputs are allowed in V1. The two vaults must validate the same transaction and identical output positions. Output count is determined by whether the creator share is zero.

| Output | 90–99.99% locked | 100% locked |
|---:|---|---|
| 0 | locked market **base** FT + new carrier | locked market **base** FT + new carrier |
| 1 | locked market **quote** FT + new carrier | locked market **quote** FT + new carrier |
| 2 | creator-owned market **base** FT + new carrier | archived mutable state NFT + original base carrier |
| 3 | creator-owned market **quote** FT + new carrier | creator collector + new carrier |
| 4 | archived mutable state NFT + original base carrier | partner collector + new carrier |
| 5 | creator collector + new carrier | protocol collector + new carrier |
| 6 | partner collector + new carrier | sponsor BCH change |
| 7 | protocol collector + new carrier | — |
| 8 | sponsor BCH change | — |

The quote-vault carrier returns in the sponsor-change output, after exact new-output carriers and a capped network fee. It cannot disappear into an unaccounted fee or market reserve. Outputs with token FT need enough BCH for relay. Market collector state must be denominated in the **quote CashToken**, with a token-aware claim path; the BCH fee collector used by E1 cannot collect these fees.

Both vault contracts must require: the exact input token categories; one and only one state NFT preserved in the archive output; exact base and quote FT sums; exact carrier satoshis; output script hashes bound to immutable launch/graduation terms; no unaccounted token output; a bounded network fee funded by the sponsor; and no post-completion trade path. The base vault pins input 1 to the quote-vault redeem-script hash. The quote vault independently checks the completed state NFT, its quote ledger, output categories, amounts and destinations. It cannot also pin the base script hash: both constructors would then depend on each other's final hash. This one-way binding requires the **base covenant** to check the full output layout, while the quote covenant enforces its own reserve conservation and shared state checks. Hashes alone must be backed by actual output checks in the covenants.

## Destination contract family

Implement a distinct token/token market family; do not reuse the BCH-quote fee bin. Each bin consists of paired base and quote UTXOs spent together for every swap. The locked pair has no owner principal exit. The creator pair may exit only under the committed creator position NFT and must preserve already-accrued fee rights. Both paths enforce one disclosed trade fee with LP, creator, partner and protocol shares. Quote-denominated recipient collectors need a dust-safe claim/sponsor rule. A market buy and sell must preserve exact category amounts in both UTXOs and deliver bought assets to the taker.

Suggested new artifacts:

- `MeshBlazeTokenBaseVaultV2.cash` and `MeshBlazeTokenQuoteVaultV2.cash`: retain V1 trade/claim behavior and add terminal graduation, with new artifact hashes.
- `MeshBlazeTokenMarketBaseLockedV1.cash` and `MeshBlazeTokenMarketQuoteLockedV1.cash`: paired no-owner market.
- `MeshBlazeTokenMarketBaseOwnedV1.cash` and `MeshBlazeTokenMarketQuoteOwnedV1.cash`: paired creator market with position-NFT exit.
- `MeshBlazeTokenFeeCollectorV1.cash`: quote-token recipient fees and sponsored claims.
- An unsigned graduation plan and independent verifier, followed by a signed builder and a read-only chipnet evidence verifier.

## Build and proof order

1. Freeze the versioned graduation terms encoding, including both market pairs, archive, collectors, creator position category, carriers and lock share. The current hash and E2 bundle verifier reconstruct these from artifacts; the genesis MBND publication and full chain evidence still need execution. The market fee cap comes from the curve covenant and terms-derived script hashes.
2. Extend the V2 graduation VM fixtures with substituted base/quote inputs and more hostile outputs. The retained buy, sell and claim methods pass local VM checks against the V2 hashes; the 10% terminal price bound and compiled market destinations also pass.
3. The linked local VM fixture now starts with separately signed launch and quote token genesis transactions, derives each subsequent UTXO from its predecessor, and covers curve buy, sell, terminal partial buy/refund and all curve fee claims.
4. The same 22-transaction fixture signs paired graduation, market swap and all three market fee claims. The V2 trade and graduation fee caps are 10,000 sats because measured transactions reach 6,224 and 6,557 bytes; V1 curve contracts retain their 5,000-sat cap. Verify relay policy and actual fees on chipnet before deployment.
5. Run the same sequence on chipnet with an independently issued quote CashToken; retain txids, actual source outputs, VM results, final UTXOs, token supply conservation and confirmation depth. Reject a public E2 claim until this evidence exists.

Attack fixtures must mutate every input index, category, NFT capability and commitment, reserve amount, recipient script, fee split, refund, lock share, market price and sponsor change. Include a no-quote-NFT case, zero-fee claim, one-sided creator rounding, dust-carrier failure, owner exit against a locked pair, and claim after market exit. Measure actual serialized size and VM cost at boundary values rather than relying on current paired trade samples.
