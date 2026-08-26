# LimitOrderSwap: Maker-Initiated Early Cancellation

**Added:** 2026-07-04
**Contract:** [`contracts/LimitOrderSwap.cash`](../contracts/LimitOrderSwap.cash)
**Scope:** Limit Orders only. Dutch Auctions (`DutchAuctionSwap.cash`) are intentionally **not** changed — see [Why Dutch Auctions are out of scope](#why-dutch-auctions-are-out-of-scope).

## The problem

Before this change, `LimitOrderSwap` had exactly one exit path for an unfilled order: `cancel()`, gated on `require(tx.time >= expiryTime)`. That means once a maker broadcasts a limit order, their funds are **locked until expiry** — if the market moves against them, if they made a mistake, or if they simply change their mind, there was no way to get funds back early. Worse, because of Bitcoin Cash's Median Time Past (MTP) lag (~2 hours behind wall-clock time — see [`unfilled-orders.md`](../../cashtoken-relayer/docs/unfilled-orders.md)), the *real* wait after wall-clock expiry before `cancel()` becomes broadcastable is expiry + ~2h.

For a Dutch Auction this is more tolerable — the price decays in the solver's favor over time, so the order tends to get filled well before the maker would want to bail. For a Limit Order at a fixed price, there's no such natural pressure valve: an order priced away from the market can simply sit, un-fillable and un-cancellable, for its entire duration.

## The fix: `cancelEarly()`

A new covenant branch, authorized purely by the maker's own signature, with **no time constraint**:

```cashscript
function cancelEarly(pubkey makerPk, sig makerSig) {
    require(hash160(makerPk) == makerPkh);
    require(checkSig(makerSig, makerPk));

    bytes25 makerLockingBytecode = new LockingBytecodeP2PKH(makerPkh);
    require(tx.outputs[0].lockingBytecode == makerLockingBytecode);

    if (sellTokenCategory == 0x) {
        require(tx.outputs[0].value >= sellAmount);
    } else {
        require(tx.outputs[0].tokenCategory == sellTokenCategory);
        require(tx.outputs[0].tokenAmount >= sellAmount);
    }
}
```

Design notes:

- **Only the maker can invoke it.** `makerPk`/`makerSig` must hash and verify against `makerPkh`, the same pubkey hash baked into the contract at creation. No one else — not the relayer, not a resolver, not an attacker — holds that private key.
- **No time gate, at all.** The maker can cancel one second after funding the covenant, or a year later. This is the entire point: it closes the "locked until expiry" gap that `cancel()` leaves open.
- **Output constraints are identical to `cancel()`**, even though the maker is authorizing their own spend. This is deliberate defense-in-depth: even a buggy frontend client cannot misdirect or short-change the refund, because the covenant — not the client — enforces where the money goes and how much of it. The maker gets back `sellAmount` of `sellTokenCategory` (or BCH), full stop.
- **`tx.inputs.length` is intentionally unconstrained** (unlike `fill()`, which requires exactly 2 inputs to block third-party UTXO draining). Since only the maker's own signature can authorize this branch, there is no drain risk from extra inputs — they'd have to belong to the person invoking the spend anyway. This lets the maker (or their wallet) add however many fee-funding inputs it needs.
- **`cancel()` is untouched and still exists** as the permissionless, anyone-can-trigger post-expiry refund — useful as a fallback (e.g., if a maker loses their key material temporarily, or a relayer wants to sweep dust from truly abandoned orders after expiry, they still can).

## Security testing

New adversarial suite: [`test/LimitOrderCancelEarly.security.test.ts`](../test/LimitOrderCancelEarly.security.test.ts) (13 tests), using the same offline real-BCH-VM harness (`_security_harness.ts`) as the rest of the security suite. Covers, for both a token-locked order and a BCH-locked order:

| Property | Test |
|---|---|
| Maker can cancel immediately, no expiry wait | ✅ ACCEPT |
| Maker can cancel with unrelated extra inputs present | ✅ ACCEPT |
| Maker can overpay themselves (BCH case) | ✅ ACCEPT |
| Resolver cannot self-authorize a cancel with their own key | ✅ REJECT |
| Attacker cannot self-authorize a cancel with their own key | ✅ REJECT |
| Attacker cannot forge a signature while supplying the maker's real pubkey | ✅ REJECT |
| Refund cannot be redirected to a third party | ✅ REJECT |
| Refund cannot be short-changed (amount) | ✅ REJECT |
| Refund cannot be paid out in the wrong token category | ✅ REJECT |

Regression: all pre-existing suites (`LimitOrderSwap.security.test.ts` — 15 tests, `DutchAuctionSwap.security.test.ts` — 13 tests, `Refund.security.test.ts` — 8 tests, plus the functional `LimitOrderSwap.test.ts` / `DutchAuctionSwap.test.ts`) were re-run against the rebuilt artifact and pass unchanged — adding `cancelEarly()` does not alter `fill()` or `cancel()` behavior.

Run everything:
```bash
npm run test:security   # all 4 adversarial suites, 49 tests total
npm run test:all        # functional suites
```

## Compiled artifact / size impact

Recompiled with `cashc@0.12.1` (matching the `cashscript@^0.12.0` pragma — note the generic `npx cashc` without a pinned version resolves to whatever is newest, currently `0.13.2`, which rejects the `^0.12.0` pragma; `package.json`'s `build` script is now pinned to avoid this trap):

| | bytesize | opcount |
|---|---|---|
| Before (`fill` + `cancel`) | 193 bytes | 95 |
| After (`fill` + `cancel` + `cancelEarly`) | 250 bytes | 132 |

Well within BCH's script size limits; no address-type or funding-flow changes.

## Deployment / migration note

**Contract addresses derived from `LimitOrderSwap.json` change** because the compiled bytecode changed (constructor parameters — `makerPkh`, `sellTokenCategory`, `buyTokenCategory`, `sellAmount`, `buyAmount`, `expiryTime` — are unchanged, so nothing about intent creation needs new fields). Practically:

- **New limit orders**, created after the relayer/frontend pick up the new artifact, get `cancelEarly()` for free.
- **Orders already funded under the old artifact** (if any exist on chipnet from prior testing) keep the old two-function contract shape and cannot be early-cancelled — they still resolve normally via `fill()` or post-expiry `cancel()`. No migration action is needed; they simply age out on their original expiry.

## Relayer & frontend integration

The relayer and frontend changes that let a maker actually *use* `cancelEarly()` (a `POST /intent/:id/cancel` endpoint with on-chain verification, and a "Cancel Order" button in the limit-order UI) are tracked in `cashtoken-relayer`'s `MILESTONES.md` and documented in `cashtoken-relayer/docs/order-creation.md` / `unfilled-orders.md`.

## Why Dutch Auctions are out of scope

This change is scoped to `LimitOrderSwap.cash` only, per explicit product decision. `DutchAuctionSwap.cash` is unchanged and still only exposes `cancel()` (post-auction-end, permissionless). If early-cancel is ever wanted for Dutch Auctions too, it should get its own design pass rather than a copy-paste of this one — auctions have different maker incentives (the whole point is the price decays toward the market), so "cancel early" would more often be used to abandon a bad decay curve, and outputs would need the same defense-in-depth review as done here.
