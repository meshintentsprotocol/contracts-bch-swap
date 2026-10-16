/**
 * Resolve a position NFT's metadata from chipnet the way a BCMR wallet does
 * (mainnet-js BCMR.buildAuthChain, used by Cashonize), and check every step:
 *
 *   1. the authbase is the transaction whose txid is the category (the seed);
 *   2. the authchain: the genesis spends the seed's output 0;
 *   3. the genesis carries one BCMR publication: OP_RETURN 'BCMR' <sha256> <uri>;
 *   4. the genesis's output 0 (identity) is unspent: the genesis is the authhead;
 *   5. the registry at the URI hashes to the published sha256 and passes
 *      libauth's BCMR validation, with an identity for the category;
 *   6. the NFT on chain has the category and a commitment the registry's parse
 *      script decodes, run in the VM as the BCMR spec defines.
 *
 *   npx tsx tools/resolve-position-metadata.ts <genesisTxid> [<category>]   (defaults from data/chipnet/position-test)
 */
import { ElectrumNetworkProvider } from 'cashscript';
import { binToHex, binToUtf8, decodeTransaction, hexToBin, importMetadataRegistry, sha256, utf8ToBin, type Output, type Transaction } from '@bitauth/libauth';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { vm } from '../test/harness.js';
import { decodeCommitment } from '../test/position.js';

const STATE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'chipnet', 'position-test', 'position-genesis.json');
const saved = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf-8')) : {};
const genesisTxid: string = process.argv[2] ?? saved.txid;
const category: string = process.argv[3] ?? saved.category;

const ok = (m: string) => console.log(`  ✅ ${m}`);
const bad = (m: string): never => { console.error(`  ❌ ${m}`); process.exit(1); };

/** Minimal-push parser for an OP_RETURN script. */
function pushes(script: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let i = 1; i < script.length;) {
        const op = script[i++]!;
        let n = op;
        if (op === 0x4c) n = script[i++]!;
        else if (op === 0x4d) { n = script[i]! | (script[i + 1]! << 8); i += 2; }
        else if (op > 0x4b) bad(`unexpected opcode 0x${op.toString(16)} in OP_RETURN`);
        out.push(script.slice(i, i + n)); i += n;
    }
    return out;
}

async function main() {
    if (!genesisTxid || !category) bad('usage: resolve-position-metadata.ts <genesisTxid> <category>');
    const provider = new ElectrumNetworkProvider('chipnet');
    const tx = (h: string) => provider.getRawTransaction(h).then((r) => { const d = decodeTransaction(hexToBin(r)); if (typeof d === 'string') bad(d); return d as Transaction; });
    console.log(`category ${category}\ngenesis  ${genesisTxid}`);

    const seed = await tx(category);
    ok(`authbase found on chain: the transaction whose txid is the category (${seed.outputs.length} outputs)`);
    const g = await tx(genesisTxid);
    const in0 = g.inputs[0]!;
    if (binToHex(in0.outpointTransactionHash) !== category || in0.outpointIndex !== 0) bad('genesis input 0 does not spend the authbase output 0');
    ok('authchain: genesis input 0 spends the authbase output 0 (and creates the category)');

    const bcmr = g.outputs.map((o) => o.lockingBytecode).filter((l) => binToHex(l).startsWith('6a0442434d52'));
    if (bcmr.length !== 1) bad(`${bcmr.length} BCMR publication outputs`);
    const [, hash, uri] = pushes(bcmr[0]!);
    const committed = binToHex(hash!);
    const url = `https://${binToUtf8(uri!)}`;
    ok(`publication: sha256 ${committed.slice(0, 16)}… at ${url}`);

    const identityUnspent = (await provider.getUtxosForLockingBytecode(g.outputs[0]!.lockingBytecode)).some((u) => u.txid === genesisTxid && u.vout === 0);
    if (!identityUnspent) bad('identity output 0 has been spent: the authhead moved past the genesis');
    ok('authhead: the genesis\'s identity output 0 is unspent, so its publication is the current one');

    const res = await fetch(url, { cache: 'no-store' } as any);
    if (!res.ok) bad(`GET ${url} → HTTP ${res.status}`);
    const text = await res.text();
    const got = binToHex(sha256.hash(utf8ToBin(text)));
    if (got !== committed) bad(`hosted sha256 ${got} ≠ committed ${committed}`);
    ok(`registry fetched; its sha256 matches the on-chain commitment (CORS: ${res.headers.get('access-control-allow-origin')})`);
    const reg = importMetadataRegistry(text);
    if (typeof reg === 'string') bad(`BCMR validation: ${reg}`);
    const ident = (reg as any).identities?.[category];
    const snap = ident && ident[Object.keys(ident)[0]!];
    if (!snap) bad('registry has no identity for the category');
    ok(`libauth BCMR validation passes; identity: "${snap.name}", symbol ${snap.token?.symbol}`);

    const nftIndex = g.outputs.findIndex((o) => o.token && binToHex(o.token.category) === category && o.token.nft);
    if (nftIndex < 0) bad('no NFT of the category in the genesis');
    const nftOut = g.outputs[nftIndex]!;
    const commitment = binToHex(nftOut.token!.nft!.commitment);
    const fields = decodeCommitment(commitment);
    const parse: Transaction = {
        version: 2, locktime: 0, outputs: [{ lockingBytecode: Uint8Array.of(0x6a), valueSatoshis: 0n }],
        inputs: [
            { outpointIndex: nftIndex, outpointTransactionHash: hexToBin(genesisTxid), sequenceNumber: 0, unlockingBytecode: Uint8Array.of() },
            { outpointIndex: 0, outpointTransactionHash: new Uint8Array(32), sequenceNumber: 0, unlockingBytecode: Uint8Array.of(0x51) },
        ],
    };
    const src: Output[] = [nftOut, { lockingBytecode: hexToBin(snap.token.nfts.parse.bytecode), valueSatoshis: 0n }];
    const st = vm.evaluate({ inputIndex: 1, sourceOutputs: src, transaction: parse }) as any;
    if (st.error || vm.stateSuccess(st) !== true) bad(`parse script failed: ${st.error}`);
    const alt: string[] = st.alternateStack.map((x: Uint8Array) => binToHex(x));
    const type = snap.token.nfts.parse.types[alt[0]!];
    if (!type) bad(`NFT type ${alt[0]} not in the registry`);
    ok(`NFT at output ${nftIndex} parses as "${type.name}": ${type.fields.map((k: string, i: number) => `${k}=${alt[i + 1]}`).join(' ')}`);
    ok(`decoded: ${fields.shape}, ${fields.binCount} bins at levels ${fields.lowIndex}–${fields.highIndex} (${fields.binStepBps} bps), token ${fields.tokenCat.slice(0, 8)}…, created at ${fields.createdHeight}`);
    console.log('resolved like a wallet: OK');
}

main().then(() => process.exit(0)).catch((e) => { console.error(`✗ ${e.message ?? e}`); process.exit(1); });
