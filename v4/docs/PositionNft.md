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

### 4.1 How wallets find the metadata (researched 2026-10-16)

BCH token metadata is **BCMR** (CHIP-BCMR v2). There's no other standard in use, and the alternatives (e.g. the Short Metadata Protocol CHIP) are proposals. Wallets resolve a category like this:

1. **Authbase:** the transaction whose txid *is* the category. For a position, that's the seed transaction that genesis input 0 spends.
2. **Authchain:** follow each transaction's **output 0** to the transaction that spends it. The last one, whose output 0 is unspent, is the **authhead**.
3. **Publication:** `OP_RETURN 'BCMR' <sha256> <uri…>`, at most one per transaction (the first matching output counts).
   - A URI with no protocol means https; a bare domain means `/.well-known/bitcoin-cash-metadata-registry.json`; `ipfs://` is supported.
   - The client downloads the file and **checks its sha256 against the exact bytes served**.
4. **Which publication counts:**
   - The spec reads it from the authhead.
   - mainnet-js (`BCMR.buildAuthChain`, used by Cashonize) collects every publication along the chain and uses the latest one.
   - Paytaca's indexer (`bcmr.paytaca.com`, chipnet: `bcmr-chipnet.paytaca.com`) indexes authchains and serves `/api/tokens/<category>/` and `/api/authchain/<category>/head/`.

### 4.2 What Mesh does

- **Identity output at index 0.** The genesis puts 800 sats for Mesh's metadata key at output 0 and the position NFT at output 1. The genesis therefore stays the authhead, which satisfies every resolver above, and only Mesh can publish new metadata, by spending output 0 with a new publication.
  - If the NFT were at output 0, every transfer of the position would become a link in the authchain, and the holder would control the metadata.
  - `checkGenesis` allows any NFT index, since third-party positions may differ; Mesh-built positions use this layout.
- **One immutable file per position:** `https://mesh-metadata.vercel.app/bcmr/<category>.json`.
  - It's a static Vercel project (`v4/mesh-metadata/`), separate from the app so releases can't touch it. It serves JSON with CORS.
  - A published file is **never edited**: its hash is on chain. New metadata means a new file and a new publication.
  - `.gitattributes` stops Git changing line endings, which would change the hash.
- **The publication is checked before broadcasting:** the script fetches the hosted URL and refuses to send unless its sha256 matches the hash in the genesis.

**Publishing:** for wallets to find the registry, the genesis carries `OP_RETURN 'BCMR' <sha256(registry bytes)> <URL without https://>`, from `bcmrPublicationChunks()`. The file must be served at that URL byte for byte.

## 5. Chipnet (done 2026-10-16)

`tools/chipnet-position-genesis.ts`:
- `plan` builds the seed and genesis, checks both (VM + `checkGenesis`), and saves the raw transactions and the registry. `--bcmr-url` accepts a `{category}` placeholder.
- `broadcast` re-checks that the seed coin is unspent and that the hosted hash matches, then sends the saved transactions unchanged.
- `withdraw` spends the bins back through the owner path (only when the funder holds the NFT).

`tools/resolve-position-metadata.ts` resolves the metadata from the chain the way a wallet does and checks every step.

**Live position:**

| | |
|---|---|
| Category (= seed txid) | `9b9b2ed979b07141b47c2c7c6bbeb2970022dd0f19739f1831643c9da10ad130` |
| Genesis | [`1a64e4fc…6b81`](https://chipnet.imaginary.cash/tx/1a64e4fc8faaec5512ba03b183beac9c407c9c308f9865d98551824ccdd56b81) (617 B): identity output 0, NFT output 1 to the user's wallet, 3 bins, BCMR publication |
| Registry | https://mesh-metadata.vercel.app/bcmr/9b9b2ed979b07141b47c2c7c6bbeb2970022dd0f19739f1831643c9da10ad130.json (sha256 `6beafbb5…0adc`) |
| Resolution | `resolve-position-metadata.ts` passes every step. Paytaca's chipnet indexer returns the name, the NFT parse definition, and the genesis as authchain head. **Cashonize shows the NFT with every field decoded** (confirmed by the user 2026-10-16) |
