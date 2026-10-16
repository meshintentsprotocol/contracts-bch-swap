# mesh-metadata

Static Vercel project (`mesh-metadata`) serving BCMR registries for Mesh V4
position NFTs at `https://<domain>/bcmr/<category>.json`.

- Each file's sha256 is committed on chain in its position's genesis
  (`OP_RETURN 'BCMR' <sha256> <url>`). **Never edit a published file**:
  wallets would reject it. New metadata = a new file and a new on-chain
  publication from the identity output.
- `.gitattributes` keeps the bytes exactly as written (no line-ending changes).
- Deploy: `vercel --prod` from this directory. Nothing else lives here.
