# Mesh Blaze launch manifest v1 draft

Status: pre-ABI draft, 2026-11-17. Encoder: `src/manifest/v1.ts`. This format is a deterministic **commitment** for builders and indexers. It becomes a security boundary only when each covenant validates the fields and actual transaction outputs relevant to its spend path. The format may change before the first deployed launch; once deployed, its version and hash must remain stable.

## Encoding

All integers are unsigned little-endian. Hashes and token categories are 32 bytes in the same display order used by the SDK. Strings are ASCII identifiers. The SHA-256 of the full byte sequence is published in the genesis as `OP_RETURN 'MBLZ' <32-byte hash>`.

| Order | Field | Width |
|---|---|---:|
| 1 | Magic `MBLZ`, version `1` | 5 |
| 2 | Launch token category, quote kind (`0` BCH, `1` CashToken), quote category (zero for BCH) | 65 |
| 3 | Fixed total supply; public activation, Alpha start/end heights | 20 |
| 4 | Presale route (`0` none, `1` standalone, `2` DBC, `3` market) and presale script hash | 33 |
| 5 | Alpha mode mask (`1` fixed, `2` curve buy) and fixed/buy script hashes | 65 |
| 6 | Virtual base, virtual quote, graduation quote threshold; permanent lock bps | 26 |
| 7 | Curve script hash, paired quote-vault script hash, paired quote-vault BCH carrier, graduation and mature-market script hashes | 136 |
| 8 | Curve fees: creator, partner, protocol each script hash and bps | 102 |
| 9 | Market fees: creator, partner, protocol each script hash and bps | 102 |
| 10 | Allocation count, then name-sorted entries | Variable |

Each allocation entry is `name length (u8) | ASCII name | FT amount (u64) | carrier sats (u64) | SHA-256(locking bytecode) | mutable NFT commitment length (u8) | commitment bytes`. Zero commitment length means no NFT. Only the curve allocation may carry a mutable NFT of the same launch category; minting capability is forbidden. Names are unique lowercase identifiers. The sum of allocation FT amounts must equal fixed supply. A nonzero fee share cannot point to the zero hash. The permanent lock floor is 9,000 bps. An enabled Alpha mode requires its script hash and a window ending before public activation. The selected Presale route and script hash are committed before deposits. Both quote types must pass conservative signed-VM reserve and fee product bounds before encoding.

The fixed portion before allocations is 555 bytes. BCH-quote launches set the quote-vault hash and carrier to zero. CashToken-quote launches commit a nonzero quote-vault script hash and at least 1,000 sats of independent carrier BCH. The hash does not include BCMR text; BCMR has its own exact-byte hash publication. The manifest does not prove that metadata is truthful or that a script actually locks liquidity. Those require chain history and artifact verification.

## Golden vector and checks

The fixed BCH fixture in `test/manifest.test.ts` produces SHA-256 `938a472796bc02c99b938c20aca1712c8301ff6c149c8c81903572a28cc76f6b`. Tests require order-independent encoding, exact genesis allocation match, one on-chain hash publication, sensitivity to fee recipients, Presale route and quote-vault identity, a minimum 90% lock setting, and pre-public Alpha timing. The genesis transaction carrying this publication passes the BCH VM in the local harness.

## Before ABI freeze

Specify fee caps, curve formula and terminal price continuity; settle the mature-market artifact hashes; decide whether vesting and sale cap terms need separate committed extension records; then review maximum manifest/preimage size against covenant VM limits. A hash comparison alone never authorizes graduation to arbitrary output scripts. The graduation covenant must verify actual outputs against committed destination terms.
