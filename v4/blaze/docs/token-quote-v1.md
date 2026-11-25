# Mesh Blaze CashToken-quote paired vault draft

Status: paired buy, sell and fee-claim prototype, 2026-11-17. `MeshBlazeTokenBaseVaultV1.cash` and `MeshBlazeTokenQuoteVaultV1.cash` compile; 25 paired constructor/VM/plan checks and five isolated quote-vault checks pass. The base covenant enforces curve price, fee split, threshold, token inventory and the exact quote-vault script. Graduation and chipnet execution remain missing, so this is not a usable public DBC.

## Why there are two UTXOs

A BCH output can hold one CashToken category. The launch-category fungible inventory and its unique mutable state NFT live in the **base vault**. Quote-category fungible tokens live in a separate **quote vault**. No quote-category NFT is assumed, so the design can accept an arbitrary fungible CashToken quote. The launch NFT is unique because fixed-supply genesis creates exactly one mutable NFT and no minting authority; every paired spend must carry it forward once.

The quote vault script commits the launch and quote categories and an independent BCH carrier. The draft manifest commits the quote-vault locking-bytecode hash and carrier. The base covenant commits the quote-vault redeem-script hash in its constructor; the quote vault checks the unique launch NFT and both successors. `tokenPairFromManifestV1` constructs quote first, then base, and checks both locking bytecodes against the manifest. This one-way dependency avoids a circular address commitment.

## Initial buy layout

| Index | Input | Output |
|---:|---|---|
| 0 | Base FT + mutable launch NFT | Base FT + successor launch NFT |
| 1 | BCH-only quote vault at first trade; later quote FT | Quote FT reserve + accrued fee rights |
| 2 | Buyer quote FT and carrier BCH | Buyer launch FT |
| 3 | — | Buyer quote FT remainder, only when positive |

The quote vault keeps its own BCH carrier unchanged. Its token amount equals `real quote reserve + creator fees + partner fees + protocol fees` decoded from the launch NFT. The buyer receives launch FT and any unused quote FT at the same script as the buyer input. An exactly funded trade has three outputs; a trade with unused quote has four, including an exact token refund. Both branches reach the terminal stage when their used gross is the smallest amount that fills the threshold. The base vault enforces the curve equation, fee split, threshold, stage and token inventory. The atomic test spends **both** covenant inputs in the same transaction. A separate quote-side test uses a P2PKH base input only to isolate quote-vault checks.

## Evidence and next gates

The isolated quote-vault fixture is 1,088 serialized bytes and 37,365 of 370,400 available VM op cost for the quote input. Current atomic paired samples are: buy 3,420 bytes (base 155,495/1,440,800 op cost; quote 103,366/898,400), sell 3,351 bytes (base 155,216/1,440,800; quote 103,312/898,400), and claim 3,387 bytes (base 155,249/1,441,600; quote 103,349/899,200). These are samples, not worst-case or relay-policy bounds. Paired attacks reject wrong price, fee accounting, quote-vault identity, quote category, refund, payout recipient, reserve ledger and sponsor change. The buy, sell and claim plans under `src/curve/` build outputs from the manifest and live UTXOs without signing, then independently verify them. Claims pay the whole accrued balance of one creator, partner or protocol role, including after curve completion. Next: paired graduation, chipnet bootstrap and relay-policy tests.
