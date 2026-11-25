import { binToHex, sha256 } from '@bitauth/libauth';

/** Verify hosted bytes exactly match the hash committed to the genesis BCMR output. */
export async function verifyHostedBcmr(
  httpsUrl: string,
  expectedHash: string,
  fetcher: typeof fetch = fetch,
): Promise<{ byteLength: number; hash: string }> {
  if (!/^https:\/\/[^\s#@]+$/.test(httpsUrl)) throw new Error('Mesh Blaze BCMR: canonical HTTPS URL required');
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) throw new Error('Mesh Blaze BCMR: invalid expected hash');
  const response = await fetcher(httpsUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Mesh Blaze BCMR: hosted registry HTTP ${response.status}`);
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > 100_000) throw new Error('Mesh Blaze BCMR: hosted registry too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 100_000) throw new Error('Mesh Blaze BCMR: hosted registry empty or too large');
  const hash = binToHex(sha256.hash(bytes));
  if (hash !== expectedHash) throw new Error(`Mesh Blaze BCMR: hosted bytes hash ${hash} differs from committed ${expectedHash}`);
  return { byteLength: bytes.length, hash };
}
