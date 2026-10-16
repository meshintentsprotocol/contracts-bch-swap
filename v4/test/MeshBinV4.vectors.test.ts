/**
 * L3 parity: test/vectors/meshBinV4.vectors.json against the encoder and the
 * compiled artifacts. The server's encoder runs the same vectors, so contracts
 * and server build identical bytecode and addresses.
 *
 * Usage: npx tsx test/MeshBinV4.vectors.test.ts
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { binToHex, sha256, utf8ToBin } from '@bitauth/libauth';
import { check, section, summary } from './harness.js';
import { VARIANTS, binArtifact, validateBinV4, type BinV4Params } from './v4_encode.js';
import { describe, generate } from '../tools/gen-v4-vectors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = JSON.parse(readFileSync(join(HERE, 'vectors', 'meshBinV4.vectors.json'), 'utf-8'));

/** Params from JSON: decimal strings back to bigints where the encoder needs them. */
function revive(p: any): BinV4Params {
    const big = (x: any) => (x === undefined ? undefined : BigInt(x));
    return {
        ...p, bidNum: big(p.bidNum)!, bidDen: big(p.bidDen)!, askNum: big(p.askNum)!, askDen: big(p.askDen)!,
        ...(p.sizeFee ? { sizeFee: { ...p.sizeFee, refSize: big(p.sizeFee.refSize)! } } : {}),
    };
}

export function run() {
    section('L3 · artifacts pinned');
    for (const v of VARIANTS) {
        const a = binArtifact(v);
        const pin = FILE.artifacts[v];
        check(`${v}: artifact bytecode sha256 matches the vectors`, pin && binToHex(sha256.hash(utf8ToBin(a.bytecode))) === pin.bytecodeSha256, a.contractName);
    }
    const regenerated = generate();
    for (const v of VARIANTS) check(`${v}: body hex and prefix length match`, JSON.stringify(regenerated.artifacts[v]) === JSON.stringify(FILE.artifacts[v]), `prefix ${FILE.artifacts[v].prefixLen} B + body ${FILE.artifacts[v].bodyHex.length / 2} B`);

    section('L3 · every vector rebuilds exactly');
    for (const vec of FILE.vectors) {
        const d = describe(revive(vec.params));
        const same = ['args', 'redeemScriptHex', 'prefixHex', 'scriptHash', 'lockingBytecodeHex', 'chipnet', 'mainnet']
            .every((k) => JSON.stringify((d as any)[k]) === JSON.stringify(vec[k]));
        check(vec.name, same, vec.chipnet.address);
    }

    section('L3 · invalid params are refused by the encoder');
    for (const bad of FILE.invalid) {
        let threw = '';
        try { validateBinV4(revive(bad.params)); } catch (e: any) { threw = e.message; }
        check(bad.name, threw !== '', threw);
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    run();
    summary('MeshBinV4 vectors');
}
