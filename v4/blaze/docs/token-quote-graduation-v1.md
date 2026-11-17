# Mesh Blaze CashToken-quote graduation boundary

Status: implementation contract for E2, 2026-11-17. This document specifies the next covenant and builder boundary. No paired graduation or token/token market is compiled or chipnet-proved yet. The [BCH E1 evidence](../../../blaze/08-chipnet-e1-evidence.md) does not prove this path.

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

The quote-vault carrier must return to the sponsor or be explicitly assigned to a disclosed successor output; it cannot disappear into an unaccounted network fee. Choose one fixed layout before coding and include it in the graduation terms hash. A separate sponsor-change output is preferable to silently merging the quote carrier into a market reserve. Outputs with token FT need enough BCH for relay. Market collector state must be denominated in the **quote CashToken**, with a token-aware claim path; the BCH fee collector used by E1 cannot collect these fees.

Both vault contracts must require: the exact input token categories; one and only one state NFT preserved in the archive output; exact base and quote FT sums; exact carrier satoshis; output script hashes bound to immutable launch/graduation terms; no unaccounted token output; a bounded network fee funded by the sponsor; and no post-completion trade path. The quote vault must independently check that input 0 is the committed base script and that its completed NFT state matches input 1's quote amount. The base vault must check that input 1 is the committed quote-vault script. Hashes alone must be backed by actual output checks in the covenants.

## Destination contract family

Implement a distinct token/token market family; do not reuse the BCH-quote fee bin. Each bin consists of paired base and quote UTXOs spent together for every swap. The locked pair has no owner principal exit. The creator pair may exit only under the committed creator position NFT and must preserve already-accrued fee rights. Both paths enforce one disclosed trade fee with LP, creator, partner and protocol shares. Quote-denominated recipient collectors need a dust-safe claim/sponsor rule. A market buy and sell must preserve exact category amounts in both UTXOs and deliver bought assets to the taker.

Suggested new artifacts:

- `MeshBlazeTokenBaseVaultV2.cash` and `MeshBlazeTokenQuoteVaultV2.cash`: retain V1 trade/claim behavior and add terminal graduation, with new artifact hashes.
- `MeshBlazeTokenMarketBaseLockedV1.cash` and `MeshBlazeTokenMarketQuoteLockedV1.cash`: paired no-owner market.
- `MeshBlazeTokenMarketBaseOwnedV1.cash` and `MeshBlazeTokenMarketQuoteOwnedV1.cash`: paired creator market with position-NFT exit.
- `MeshBlazeTokenFeeCollectorV1.cash`: quote-token recipient fees and sponsored claims.
- An unsigned graduation plan and independent verifier, followed by a signed builder and a read-only chipnet evidence verifier.

## Build and proof order

1. Freeze a versioned graduation terms encoding that commits both market scripts, both creator scripts, archive script, three collectors, position category, carrier assignments, fee cap and lock share. Reconstruct every script from the manifest and terms before signing.
2. Add paired graduation to the V2 curve vaults. Test 90% and 100% paths in the BCH VM, including a quote-vault failure when the base input is substituted.
3. Implement the locked token/token market pair and quote-token collectors. Prove buy, sell, fee accrual and fee claims locally, then add the creator pair and NFT-controlled exit.
4. Sign a linked local sequence from fresh fixed-supply genesis through buy, sell, terminal partial buy/refund, all curve fee claims, paired graduation, market swap and all market fee claims.
5. Run the same sequence on chipnet with an independently issued quote CashToken; retain txids, actual source outputs, VM results, final UTXOs, token supply conservation and confirmation depth. Reject a public E2 claim until this evidence exists.

Attack fixtures must mutate every input index, category, NFT capability and commitment, reserve amount, recipient script, fee split, refund, lock share, market price and sponsor change. Include a no-quote-NFT case, zero-fee claim, one-sided creator rounding, dust-carrier failure, owner exit against a locked pair, and claim after market exit. Measure actual serialized size and VM cost at boundary values rather than relying on current paired trade samples.
