# Mesh Blaze curve reference model

Status: compiled BCH curve **prototype** plus reference math, 2026-11-17. `contracts/curve/MeshBlazeBchCurveV1.cash` has buy/sell, terminal-buy refund layout and whole-balance fee claims with 23 VM checks; constructor, arithmetic and transaction plans have 16 checks. Graduation, wallet signing, chipnet relay and a full security audit remain open. It must not be funded for a public launch. Source: `src/math/curve.ts`, `src/curve/state.ts`, `src/curve/buy-plan.ts`, `src/curve/sell-claim-plan.ts` and the curve tests.

## One-category state NFT

The curve allocation from fixed-supply genesis may hold fungible launch tokens plus one **mutable NFT of the same category**. The NFT is a state marker, not a minting authority. Genesis and manifest verifiers require mutable capability and commit its initial bytes. The BCH VM accepts this shape in the local genesis test. The NFT must be carried to exactly one successor on every trade, with the same token category and covenant script.

The draft state commitment is 34 bytes: `version (1) | stage (1) | real quote reserve (8 LE) | creator fee balance (8 LE) | partner fee balance (8 LE) | protocol fee balance (8 LE)`. Stage `0` trades; stage `1` completes. All counters fit signed 64-bit VM arithmetic. Neither the state nor the covenant constructor contains the manifest hash: the manifest commits the curve script hash, and putting the manifest hash back in that script would create a circular dependency. `src/curve/contract.ts` reconstructs the script from the manifest economics and compares both its SHA-256 hash and locking bytecode to the committed curve allocation. The genesis verifier independently checks that allocation and the on-chain manifest publication. For BCH quote, covenant satoshis must equal `carrier + real quote + all fee balances`. For CashToken quote, the paired quote vault's token amount must equal `real quote + all fee balances`, while its BCH carrier is separate. The base vault's NFT mirrors the shared state; both vaults must spend and recreate atomically.

## Price and fee math

Let `B` be actual base inventory, `Q` real quote reserve, `Vb` virtual base, `Vq` virtual quote, and `F` total fee bps. Virtual reserves are pricing numbers; they are never spendable assets. The quote threshold is measured against `Q`, excluding claimable fees.

- Buy gross quote `G`: fee `floor(G*F/10000)`, net quote `N=G-fee`, base out `floor((B+Vb)*N/(Q+Vq+N))`. Reject zero token output or output greater than actual `B`. Increase `Q` by `N`; add fee entitlements to state.
- Sell base `T`: gross quote out `floor((Q+Vq)*T/(B+Vb+T))`. Reject if gross exceeds actual `Q`; seller receives gross less fee. Decrease `Q` by gross; add fee entitlements to state.
- A threshold-crossing buy uses the **smallest gross** amount whose net after fee equals `threshold-Q`. Any unspent gross is an explicit quote refund. The fee function uses the total bps first, making net quote monotone for `F<10000`; the fee is then split by weights. Rounding remainder goes to an enabled recipient, never to a zero-share party.

Both trade directions require the post-trade effective-reserve product to be at least the pre-trade product. Output accounting must also preserve the actual assets and NFT. Buyer slippage limits belong in the signed transaction builder and can be enforced by a dedicated output check; the covenant must not treat virtual quote as real withdrawable reserve.

For BCH launches, manifest encoding now rejects configurations whose worst-case reserve or fee products exceed the signed VM integer range. It bounds `(totalSupply + Vb) * threshold`, `(threshold + Vq) * totalSupply`, and `maxTerminalGross * totalFeeBps`, with `maxTerminalGross = ceil(threshold * 10000 / (10000 - totalFeeBps))`. This is a conservative launch-time liveness check; it does not replace on-chain arithmetic checks, asset conservation, or worst-case transaction policy testing.

## Required transaction checks before script promotion

1. State input `i` and successor output `i` use the same committed script, launch category, mutable NFT and 34-byte commitment format.
2. Input/output token amounts and satoshis agree with the decoded state and exact fee balances; arbitrary extra token inputs cannot fake reserve deltas.
3. Fee claim transactions reduce only the matching accrued balance, pay its committed recipient, preserve `Q` and the locked/principal buckets, and prevent double claim.
4. Final fill records stage `1`, exact threshold, and explicit refund. No ordinary buy or sell succeeds from stage `1`.
5. For token quote, both base and quote vaults authenticate each other, the same manifest and transaction; no one-sided successor or substituted category is valid.
6. Bound all intermediate products and division cost under the target BCH VM and standard relay rules. TypeScript uses arbitrary-precision `bigint`; that does **not** prove equivalent on-chain arithmetic yet.

The prototype's buy/sell ABI uses the state NFT and exact integer reserve/fee checks. Buy fixes a two-input, three-output layout: curve at index 0, buyer at index 1, curve successor at output 0, buyer token payout at output 1, and BCH change at output 2. The buyer's locking bytecode receives both payout outputs. Network fee is capped at 5,000 sats. A terminal buy must use the smallest gross amount that reaches the real quote threshold; any excess buyer input stays in the buyer change output. This layout supports one buyer funding input and needs policy/relay testing before chipnet use.

A sell fixes a two-input, two-output layout. The seller input must carry only fungible launch tokens, the curve receives exactly those tokens, and BCH proceeds return to the seller's input script with at most 5,000 sats of network fee. A claim consumes one complete accrued fee balance, keeps the real quote reserve, token inventory and stage unchanged, and requires output `i + 1` to pay that balance to a SHA-256 committed script. Any party can submit the spend; balances below 1,000 sats wait until they reach claim size. Graduation remains open. No current market launch should rely on this prototype alone.

`src/curve/buy-plan.ts` accepts a manifest, current curve UTXO, one BCH-only buyer UTXO, maximum gross input, explicit network fee and minimum token output. It produces exactly the three covenant outputs and has a separate wallet-side verifier. The builder checks the source NFT, script, category, satoshi ledger, fee cap, slippage and dust-safe change. It does not select UTXOs from the network or sign.

`src/curve/sell-claim-plan.ts` likewise builds and verifies the seller's two outputs. Its claim plan uses a separate BCH sponsor input for network fees, pays the entire accrued balance to the manifest's recipient script, and returns sponsor change to the sponsor script. These plans are unsigned output instructions; wallet integration still needs UTXO selection, fee estimation, exact transaction review, signing and broadcast.

## Sample BCH VM cost

The current local harness samples one honest transaction per path. These are measured under `BCH_2026_05`; they are not chipnet relay acceptance or worst-case bounds.

| Path | Serialized bytes | Covenant op cost / VM maximum |
|---|---:|---:|
| Buy | 1,913 | 136,571 / 1,228,000 |
| Sell | 1,840 | 136,354 / 1,228,000 |
| Terminal buy | 1,913 | 136,650 / 1,228,000 |
| Fee claim | 1,700 | 136,256 / 1,228,800 |
