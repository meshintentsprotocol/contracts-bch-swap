# Position NFT specification

| | |
|---|---|
| Version | 1, 2026-10-16 (phase 2) |
| Code | `test/position.ts` (reference for the server: commitment codec, `checkGenesis`, BCMR) |
| Vectors | `test/vectors/positionNft.vectors.json` (7 commitments, 8 invalid, the parse bytecode) |
| Tests | `test/PositionNft.test.ts`: N1–N5, BCMR (schema and VM parse), vectors; 78 checks |
| Bin side | `docs/MeshBinV4.md` §3.2 (the owner path) |

## 1. What it is

A position is a set of `MeshBinV4` bins whose `ownerCat` is one CashTokens category. That category has exactly one NFT, and **whoever holds the NFT controls every bin**: they can withdraw, reprice, move, merge or split. Sending the NFT sends the position. No other key can take the funds: there's no admin and no recovery path (DECISIONS D3, D6).

## 2. Genesis

The NFT and the bins are created in **one transaction**. The server checks these rules before it registers a position. Consensus allows several shapes that break them, so the server's check is what enforces them.

| Rule | Requirement | Why |
|---|---|---|
| G1 | Input 0 spends an output with index 0; category = that outpoint's txid | CashTokens genesis; one fixed place to read the category from |
| G2 | No input already carries the category | It really is new |
| G3 | Exactly one output carries the category: one NFT, capability `none` or `mutable`, fungible amount 0 | A minting NFT could mint more owners; a fungible supply or a second NFT would also pass a bin's owner path |
| G4 | The NFT's commitment is a valid v1 commitment (§3) | Never empty: an immutable NFT needs a commitment to own its bins |
| G5 | Every listed bin names the category as `ownerCat` and matches the commitment (token, variant, manager, bin count). Each is funded in this transaction with only the pair's token (or none), no NFT, and ≥ 1,000 sats | No foreign or unfunded bins are registered under the position |

**Mutable is recommended**, so the holder can update the commitment later. Immutable is allowed. With D11 (DECISIONS), a mutable NFT owns its bins whatever its commitment, so clearing the commitment can't lock the position.

## 3. Commitment v1 (82 bytes)

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 1 | version | `0x01` |
| 1 | 1 | flags | bits 0–2 shape (0 spot, 1 curve, 2 bid-ask, 3 custom); bits 3–5 bin variant (0 default, 1 locked, 2 vesting, 3 fee schedule, 4 size fee); bits 6–7 zero |
| 2 | 32 | tokenCat | display order |
| 34 | 2 | binStepBps | LE unsigned, 1 … 10,000 |
| 36 | 4 | lowIndex | 4-byte VM number (sign-magnitude) |
| 40 | 4 | highIndex | same; lowIndex ≤ highIndex |
| 44 | 2 | binCount | LE unsigned, 1 … 32,767 |
| 46 | 32 | managerHash | the bins' `managerHash`; zeros = none |
| 78 | 4 | createdHeight | LE unsigned block height |

Nothing on chain reads it: bins check only the category. It's for wallets, indexers and the UI. The decoder is strict, and anything else fails G4.

## 4. Wallet metadata (BCMR)

`positionRegistry()` builds a BCMR v2 registry, with one identity per position category. It passes libauth's `importMetadataRegistry`. The NFTs are *parsable*: wallets run `PARSE_BYTECODE` on the NFT UTXO, which splits the commitment into fields. The version byte is the NFT type (`01`); numbers are normalised with `OP_BIN2NUM`.

```
00cf 517f7c6b 517f7c6b 01207f7c6b 527f7c816b 547f7c816b 547f7c816b 527f7c816b 01207f7c6b 816b
```

The suite runs the BCMR parsing transaction in the 2026 VM, exactly as the spec defines it for wallets, and checks every field, including negative grid indexes. A malformed commitment fails to parse rather than showing wrong values.

**Publishing:** for wallets to find the registry, the genesis carries `OP_RETURN 'BCMR' <sha256(registry bytes)> <URL without https://>`, from `bcmrPublicationChunks()`. The file must be served at that URL byte for byte.

## 5. Chipnet

`tools/chipnet-position-genesis.ts` mints a test position (an NFT and three BCH bins on the 1 % grid around 2,000 sats per pUSD unit).
- It is a dry run by default: it builds both transactions (a seed self-send to make an output #0, then the genesis), checks each with the VM and `checkGenesis`, and writes `data/chipnet/<date>/` (state + registry).
- `--broadcast` sends; `--to <token address>` sends the NFT to a wallet; `--bcmr-url` publishes the registry.
- `withdraw` mode spends the bins back through the owner path with the NFT: a live owner-path test.

The dry run against chipnet passes: genesis 468 B, VM ✓, `checkGenesis` ✓.
