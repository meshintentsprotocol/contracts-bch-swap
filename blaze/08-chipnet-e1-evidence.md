# BCH-quoted launch E1: chipnet evidence

Run date: 2026-11-17. Source branch: `bchblaze`. Independent verification at chipnet height **335370** returned `CONFIRMED_E1`: **15 transactions**, at least **9 confirmations** each, **49,000 sats (0.00049 tBCH)** in total network fees. The verifier fetched public raw transactions and their funding parents, reconstructed inputs, checked each spend with the BCH 2026 VM, checked the launch and graduation commitments, and found the final covenant UTXOs unspent. Run from `v4`: `npm.cmd exec -- tsx blaze/tools/chipnet-e1-verify.ts`. Private signed plans and wallet data are gitignored under `v4/data/chipnet/blaze-e1/`.

| Stage | Chipnet transaction |
|---|---|
| Creator position category seed | [540b03440efab94e2f714f87717df9178113b9c8c9a921d6ccb7aa3cf8b0ae9a](https://chipnet.imaginary.cash/tx/540b03440efab94e2f714f87717df9178113b9c8c9a921d6ccb7aa3cf8b0ae9a) |
| Creator position NFT genesis | [1d779550a7a6a022f4494f7a0970c50ce92094243b528a8e8ea1361608e15ec1](https://chipnet.imaginary.cash/tx/1d779550a7a6a022f4494f7a0970c50ce92094243b528a8e8ea1361608e15ec1) |
| Launch category seed | [a724ecf34e5dbc9d8e7c85d02d8fa0f9a221eded0537123639efa4dc571ea671](https://chipnet.imaginary.cash/tx/a724ecf34e5dbc9d8e7c85d02d8fa0f9a221eded0537123639efa4dc571ea671) |
| Fixed-supply launch genesis | [90bb29d0112a2712e69d5acc2e38fca10b620f9187109119b8b2df25de774ddb](https://chipnet.imaginary.cash/tx/90bb29d0112a2712e69d5acc2e38fca10b620f9187109119b8b2df25de774ddb) |
| Opening curve buy | [b9352a8f8a9e4b590f38574762a040dd219360eaa8ada3fc42a7e0a79c8f41b3](https://chipnet.imaginary.cash/tx/b9352a8f8a9e4b590f38574762a040dd219360eaa8ada3fc42a7e0a79c8f41b3) |
| Curve sell | [7ab1ea2a347f565ce7bfde1573349c1cf5a4ddff9143ef51e1633f68ef9382c2](https://chipnet.imaginary.cash/tx/7ab1ea2a347f565ce7bfde1573349c1cf5a4ddff9143ef51e1633f68ef9382c2) |
| Terminal partial buy and excess refund | [17f110cca904de78d0feae8156ee15fa0117989bdcfcb07dbb29c39cc28ff8f7](https://chipnet.imaginary.cash/tx/17f110cca904de78d0feae8156ee15fa0117989bdcfcb07dbb29c39cc28ff8f7) |
| Curve creator fee claim | [1db5bb8af35944b8f28e52157744c90211399e36ec996351763f8cb702584a9d](https://chipnet.imaginary.cash/tx/1db5bb8af35944b8f28e52157744c90211399e36ec996351763f8cb702584a9d) |
| Curve partner fee claim | [de04dce1f60bc6625f7669b0b6121fdbc62462a9de96f841dd31683e582e8e3c](https://chipnet.imaginary.cash/tx/de04dce1f60bc6625f7669b0b6121fdbc62462a9de96f841dd31683e582e8e3c) |
| Curve protocol fee claim | [941c121358189daf862909c40e0008727e1b9b4e781ee654b4eb5944557d1fef](https://chipnet.imaginary.cash/tx/941c121358189daf862909c40e0008727e1b9b4e781ee654b4eb5944557d1fef) |
| Graduation and permanent lock | [678040e3042fbba22c6d1260b4a90bf6378ed5e0e6584698a050162c8063a081](https://chipnet.imaginary.cash/tx/678040e3042fbba22c6d1260b4a90bf6378ed5e0e6584698a050162c8063a081) |
| Post-graduation market buy | [23b518d264ba670c4eba28d0980e32eec17f37af6021ace930a8c3c16fc4e094](https://chipnet.imaginary.cash/tx/23b518d264ba670c4eba28d0980e32eec17f37af6021ace930a8c3c16fc4e094) |
| Market creator fee claim | [8f377661d82cc0f54cd4dc5adf0121b9b763aeb8e071e8df6c8fb687877edb7b](https://chipnet.imaginary.cash/tx/8f377661d82cc0f54cd4dc5adf0121b9b763aeb8e071e8df6c8fb687877edb7b) |
| Market partner fee claim | [86f7b6e042706905913cd6679931a946c017cb3dd5c6020a487cf4232f7c31d9](https://chipnet.imaginary.cash/tx/86f7b6e042706905913cd6679931a946c017cb3dd5c6020a487cf4232f7c31d9) |
| Market protocol fee claim | [d9c3760a982f46b6ddd8f01fe23e18f1c20fe6f2c56c465db6ec32337b8f97ee](https://chipnet.imaginary.cash/tx/d9c3760a982f46b6ddd8f01fe23e18f1c20fe6f2c56c465db6ec32337b8f97ee) |

## Commitments and balances

- Launch token category: `a724ecf34e5dbc9d8e7c85d02d8fa0f9a221eded0537123639efa4dc571ea671`; fixed genesis supply **1,000,000 FT**, with no mint authority. Position NFT category: `540b03440efab94e2f714f87717df9178113b9c8c9a921d6ccb7aa3cf8b0ae9a`.
- Genesis `MBLZ` manifest hash: `9f167434132331f120fb23d845991511e77268476272fe63ad3e613e47bf7c7c`; `MBND` launch bundle hash: `5bf61a0df4f8e7da3eed1eec94c206b87b0316d9fde5c5e8e1b50b44325613c0`. Graduation terms hash: `ab27768aafbe41af9ce8bc7b64f95954a41bc18f8e06a38577d12eb65b52f10d`.
- The terminal buy used **505,052 sats** of an **800,000-sat** gross cap; the remaining **294,948 sats** were excess under that cap. The curve reached **500,003 sats** real quote. The terminal buyer received **366,667 FT**.
- Graduation funded a no-owner locked bin with **570,000 FT** and **450,003 quote sats** plus a 1,000-sat carrier. The creator-owned bin received **63,333 FT** and **50,000 quote sats** plus a 1,000-sat carrier. The mutable state NFT was archived in an unspent `OP_0` output. Three fee collector states survived graduation.
- The post-graduation buy transferred **10,000 FT** from the locked bin and accrued creator/partner/protocol fees of **5/1/7 sats**. Each collector claim used a sponsor top-up to produce a 546-sat payout. At verification, the locked market bin held **560,000 FT** and **472,053 sats**; the creator bin held **63,333 FT**. Together with the terminal buyer and market buyer outputs, these account for the full **1,000,000 FT** supply.

## Scope and next gates

This is one BCH-quoted laboratory launch using an existing test funder. The same test script represents creator, partner and protocol; hosted BCMR and a dedicated launch wallet were not used. It proves a live fixed-supply genesis, BCH curve buy/sell/final fill, three curve fee claims, 90% graduation split, one locked-bin market buy and three sponsored market fee claims. The no-owner locked-bin covenant has no principal exit; its BCH reserve changes through authorized swaps.

The first release still needs the CashToken-quoted E2 lifecycle, presale success/failure, both Alpha modes, adversarial chipnet probes, wallet/SDK/indexer/UI integration, reorg handling, artifact/ABI freeze, worst-case policy and cost checks, and external security review. E1 confirmation is not a public deployment or audit claim.
