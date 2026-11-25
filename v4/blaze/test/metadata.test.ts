import assert from 'node:assert/strict';
import { createBcmrPublication } from '../src/genesis/plan.js';
import { verifyHostedBcmr } from '../src/genesis/metadata.js';

const registry = '{"name":"Mesh Blaze"}\n';
const url = 'https://example.org/bcmr.json';
const hash = createBcmrPublication(registry, url).registryHash;
const serve = (body: string, status = 200): typeof fetch => async () => new Response(body, { status });

const cases: Array<[string, () => Promise<void>]> = [
  ['exact hosted bytes match the committed hash', async () => {
    const result = await verifyHostedBcmr(url, hash, serve(registry));
    assert.equal(result.hash, hash);
    assert.equal(result.byteLength, Buffer.byteLength(registry));
  }],
  ['one changed newline fails the hash', async () => {
    await assert.rejects(verifyHostedBcmr(url, hash, serve(registry.trimEnd())), /differs from committed/);
  }],
  ['HTTP error is rejected', async () => {
    await assert.rejects(verifyHostedBcmr(url, hash, serve('missing', 404)), /HTTP 404/);
  }],
  ['non-HTTPS URL is rejected before fetch', async () => {
    await assert.rejects(verifyHostedBcmr('http://example.org/bcmr.json', hash, serve(registry)), /canonical HTTPS/);
  }],
];

let failed = 0;
for (const [name, run] of cases) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}:`, error); }
}
console.log(`Mesh Blaze metadata: ${cases.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
