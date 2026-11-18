# E2 local token/token lifecycle evidence

Status: local BCH VM evidence, 2026-11-17. This is not chipnet evidence or a public deployment claim.

The linked fixture in `v4/blaze/test/token-pair-graduation.vm.test.ts` signs 22 transactions. Each live input is reconstructed from the preceding transaction output, rather than substituting an unrelated fixture UTXO. The signed sequence contains:

| Transactions | Stage |
|---:|---|
| 1–6 | Launch and quote CashToken genesis, manifest and MBND publication, creator position NFT genesis, and initial curve seeding |
| 7–8 | Quote-vault and buyer funding |
| 9–13 | Opening buy, seller funding, sell, terminal buyer funding, and threshold-crossing partial buy with excess refund |
| 14–16 | Creator, partner, and protocol curve fee claims |
| 17 | Atomic paired-vault graduation to locked and creator-owned market positions |
| 18–19 | Market buyer funding and locked-market buy |
| 20–22 | Creator, partner, and protocol market fee claims |

The fixture checks final conservation of 1,000,000 launch FT and 1,000,000 quote FT. Separate fixtures check 90% and 100% locked graduation layouts, owned and locked market trades, and adverse cases. The linked path exercises a 90% lock. It does not establish relay acceptance, confirmation, or liquidity on chipnet.

Measured serialized sizes in the local VM: V2 curve buy 6,224 bytes, V2 graduation 6,557 bytes, E2 market buy 4,203 bytes. V2 curve trade and graduation covenants permit up to 10,000 sats network fee; V1 curve contracts retain 5,000 sats. Builders enforce the cap selected by artifact version. These are bounds, not a claim that every transaction uses the maximum fee. The chipnet sequence must record actual serialized size and fee for each transaction.

Verification: `npm run typecheck` passed. `tsx` startup in the restricted Windows sandbox failed in Node's `os.userInfo` with `uv_os_get_passwd` ENOMEM before tests ran. Compiling with `tsc -p . --noEmit false --outDir .tmp-e2-emit` and running the emitted plan and VM test files with Node passed: 19 plan assertions; 22 signed VM transactions; 14 graduation lifecycle checks plus artifact reconstruction. The generated `.tmp-e2-emit` directory is disposable and must not be committed.

Next gate: fund the independently issued quote CashToken and BCH carriers on chipnet, broadcast the same ordered flow, save txids and actual UTXOs, verify both token supplies and market fee claims, then wait for confirmations. An external covenant review remains necessary before production.
