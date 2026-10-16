/**
 * Phase 2 live check on chipnet: mint a Mesh V4 position NFT together with
 * three BCH-only bins (bid side, pUSD pair), then (optionally) withdraw the
 * bins through the owner path with that NFT.
 *
 * DRY RUN BY DEFAULT: builds every transaction, verifies it with the BCH 2026
 * VM and with checkGenesis, writes the BCMR registry and a state file, and
 * prints what it would send. Nothing is broadcast without --broadcast.
 *
 *   npx tsx tools/chipnet-position-genesis.ts genesis [--to <chipnet token address>] [--bcmr-url https://…/registry.json] [--broadcast]
 *   npx tsx tools/chipnet-position-genesis.ts withdraw [--broadcast]     (only when the funder holds the NFT)
 *
 * Funding key: FUNDER_WIF (environment, else BCHMesh/meshserver/.env), as the
 * meshserver live scripts use. Output: data/chipnet/<date>/ (gitignored).
 *
 * With --bcmr-url, the genesis carries OP_RETURN 'BCMR' <sha256> <url>; the
 * registry file written here must be uploaded to exactly that URL, byte for
 * byte, for wallets to show the position's name and fields.
 */
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import {
    binToHex, cashAddressToLockingBytecode, decodePrivateKeyWif, encodeCashAddress, encodeTransaction, hash160,
    hashTransaction, secp256k1, utf8ToBin,
} from '@bitauth/libauth';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildTx, verify, p2pkh, nft, type Tok } from '../test/harness.js';
import { binOf, type BinV4Params } from '../test/v4_encode.js';
import { gridFraction } from '../test/grid.js';
import { bcmrPublicationChunks, checkGenesis, encodeCommitment, positionRegistry, type PositionCommitment } from '../test/position.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = join(HERE, '..');
const PUSD = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
const STEP = 100, LEVELS = [760, 761, 762], BIN_SATS = 3_000n, NFT_SATS = 1_000n, FEE_RATE = 1.2;

const args = process.argv.slice(2);
const mode = args[0] ?? 'genesis';
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const BROADCAST = flag('--broadcast');
const OUT = opt('--out') ?? join(V4, 'data', 'chipnet', new Date().toISOString().slice(0, 10));
const STATE = join(OUT, 'position-genesis.json');

function envValue(file: string, name: string): string | undefined {
    if (!existsSync(file)) return undefined;
    const m = new RegExp(`^${name}=(.*)$`, 'm').exec(readFileSync(file, 'utf-8'));
    return m?.[1]?.trim().replace(/^["']|["']$/g, '');
}

function funder() {
    const wif = process.env.FUNDER_WIF ?? envValue(join(V4, '..', '..', 'BCHMesh', 'meshserver', '.env'), 'FUNDER_WIF');
    if (!wif) throw new Error('FUNDER_WIF not set (environment or BCHMesh/meshserver/.env)');
    const d = decodePrivateKeyWif(wif);
    if (typeof d === 'string') throw new Error(d);
    const pub = secp256k1.derivePublicKeyCompressed(d.privateKey);
    if (typeof pub === 'string') throw new Error(pub);
    const pkh = hash160(pub);
    const address = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkh', payload: pkh }).address;
    const tokenAddress = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: pkh }).address;
    return { sig: new SignatureTemplate(wif), lock: p2pkh(pkh), address, tokenAddress };
}

const lockOfAddress = (a: string) => { const r = cashAddressToLockingBytecode(a); if (typeof r === 'string') throw new Error(r); return r.bytecode; };
const sizeFee = (b: TransactionBuilder) => BigInt(Math.ceil(buildTx(b).size * FEE_RATE)) + 20n;

async function main() {
    const provider = new ElectrumNetworkProvider('chipnet');
    const f = funder();
    mkdirSync(OUT, { recursive: true });
    console.log(`${BROADCAST ? 'LIVE' : 'DRY RUN'} · funder ${f.address} · out ${OUT}`);

    if (mode === 'genesis') {
        const height = await provider.getBlockHeight();
        const utxos = (await provider.getUtxos(f.address)).filter((u) => !u.token);
        const total = utxos.reduce((s, u) => s + u.satoshis, 0n);
        console.log(`chipnet height ${height}; funder has ${utxos.length} BCH-only UTXOs, ${total} sats`);
        const need = BIN_SATS * BigInt(LEVELS.length) + NFT_SATS + 5_000n;

        // 1. A UTXO at output #0 to create the category from (a self-send if none exists).
        let seed = utxos.find((u) => u.vout === 0 && u.satoshis >= need);
        let prep: { hex: string; txid: string } | undefined;
        if (!seed) {
            const pay = utxos.sort((a, b) => Number(b.satoshis - a.satoshis))[0];
            if (!pay || pay.satoshis < need + 2_000n) throw new Error(`funder needs a UTXO of at least ${need + 2_000n} sats`);
            const b = new TransactionBuilder({ provider }).addInput(pay, f.sig.unlockP2PKH());
            (b as any).outputs.push({ to: f.lock, amount: pay.satoshis - 1_000n });
            const fee = sizeFee(b);
            (b as any).outputs[0].amount = pay.satoshis - fee;
            const built = buildTx(b);
            const v = verify(built);
            if (v !== true) throw new Error(`seed tx invalid: ${v}`);
            const hex = binToHex(encodeTransaction(built.transaction));
            prep = { hex, txid: hashTransaction(encodeTransaction(built.transaction)) };
            seed = { txid: prep.txid, vout: 0, satoshis: pay.satoshis - fee, lockingBytecode: binToHex(f.lock) };
            console.log(`seed: self-send to create an output #0 (${seed.satoshis} sats), txid ${prep.txid}`);
        }
        const category = seed.txid;

        // 2. Genesis: NFT + 3 bins (BCH bids at grid levels 760–762, about 1,970–2,010 sats per pUSD unit).
        const commitment: PositionCommitment = {
            version: 1, shape: 'spot', variant: 'default', tokenCat: PUSD, binStepBps: STEP,
            lowIndex: LEVELS[0]!, highIndex: LEVELS.at(-1)!, binCount: LEVELS.length, managerHash: '00'.repeat(32), createdHeight: height,
        };
        const cHex = encodeCommitment(commitment);
        const bins: BinV4Params[] = LEVELS.map((i) => {
            const bid = gridFraction(STEP, i, 'down'), ask = gridFraction(STEP, i + 1, 'up');
            return { tokenCat: PUSD, ownerCat: category, bidNum: bid.num, bidDen: bid.den, askNum: ask.num, askDen: ask.den };
        });
        const to = opt('--to') ?? f.tokenAddress;
        const registry = positionRegistry([{ category, name: 'Mesh V4 test position BCH/pUSD', description: 'Chipnet test of a Mesh V4 position NFT: three BCH bins on the 1 % grid around 2,000 sats per pUSD unit.' }], new Date().toISOString());
        const registryBytes = utf8ToBin(JSON.stringify(registry, null, 2) + '\n');
        writeFileSync(join(OUT, 'bcmr-registry.json'), registryBytes);

        const b = new TransactionBuilder({ provider }).addInput(seed as any, f.sig.unlockP2PKH());
        const outs = (b as any).outputs as any[];
        outs.push({ to: lockOfAddress(to), amount: NFT_SATS, token: nft(category, 'mutable', cHex) });
        bins.forEach((p) => outs.push({ to: hexBytes(binOf(p, provider as any).lockingBytecode), amount: BIN_SATS }));
        const url = opt('--bcmr-url');
        if (url) b.addOpReturnOutput(bcmrPublicationChunks(registryBytes, url));
        const spent = NFT_SATS + BIN_SATS * BigInt(bins.length);
        outs.push({ to: f.lock, amount: seed.satoshis - spent - 1_000n });
        outs.at(-1).amount = seed.satoshis - spent - sizeFee(b);
        const built = buildTx(b);
        const v = verify(built);
        if (v !== true) throw new Error(`genesis invalid in the VM: ${v}`);
        const reg = checkGenesis(built.transaction, built.sourceOutputs, bins, provider as any);
        const hex = binToHex(encodeTransaction(built.transaction));
        const txid = hashTransaction(encodeTransaction(built.transaction));
        console.log(`genesis ${txid}: ${built.size} B, VM ✓, checkGenesis ✓ (category ${reg.category}, NFT at output ${reg.nftIndex}, bins at ${reg.binIndexes})`);
        console.log(`NFT → ${to}${url ? ` · BCMR published at ${url} (upload ${join(OUT, 'bcmr-registry.json')} there, unchanged)` : ' · no BCMR publication (wallets show the raw NFT)'}`);

        const state = { category, txid, seedTxid: prep?.txid ?? null, recipient: to, commitment, cHex, bins: bins.map((p) => JSON.parse(JSON.stringify(p, (_k, x) => (typeof x === 'bigint' ? String(x) : x)))), binOutputs: reg.binIndexes, nftOutput: reg.nftIndex, broadcast: BROADCAST, at: new Date().toISOString() };
        writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
        if (!BROADCAST) { console.log(`dry run: nothing sent. State and registry in ${OUT}. Re-run with --broadcast to send.`); return; }
        if (prep) console.log(`seed sent: ${await provider.sendRawTransaction(prep.hex)}`);
        console.log(`genesis sent: ${await provider.sendRawTransaction(hex)}`);
        console.log(`https://chipnet.imaginary.cash/tx/${txid}`);
       
        return;
    }

    if (mode === 'withdraw') {
        const s = JSON.parse(readFileSync(STATE, 'utf-8'));
        if (s.recipient !== f.tokenAddress) throw new Error('the NFT went to another wallet: withdraw from that wallet');
        const nftUtxo = (await provider.getUtxos(f.tokenAddress)).find((u) => u.token?.category === s.category && u.token?.nft);
        if (!nftUtxo) throw new Error('the funder no longer holds the position NFT');
        const bins: BinV4Params[] = s.bins.map((p: any) => ({ ...p, bidNum: BigInt(p.bidNum), bidDen: BigInt(p.bidDen), askNum: BigInt(p.askNum), askDen: BigInt(p.askDen) }));
        const b = new TransactionBuilder({ provider });
        let sats = 0n;
        bins.forEach((p, k) => {
            const c = binOf(p, provider as any);
            const u = { txid: s.txid, vout: s.binOutputs[k], satoshis: BIN_SATS, lockingBytecode: c.lockingBytecode };
            b.addInput(u as any, (c as any).unlock.owner(BigInt(bins.length)));   // the NFT input follows the bins
            sats += BIN_SATS;
        });
        b.addInput(nftUtxo, f.sig.unlockP2PKH());
        const outs = (b as any).outputs as any[];
        outs.push({ to: f.lock, amount: nftUtxo.satoshis, token: nftUtxo.token as Tok });
        outs.push({ to: f.lock, amount: sats - 1_000n });
        outs.at(-1).amount = sats - sizeFee(b);
        const built = buildTx(b);
        const v = verify(built);
        if (v !== true) throw new Error(`withdraw invalid in the VM: ${v}`);
        const hex = binToHex(encodeTransaction(built.transaction));
        console.log(`withdraw of ${bins.length} bins through the owner path: ${built.size} B, VM ✓`);
        if (!BROADCAST) { console.log('dry run: nothing sent.'); return; }
        console.log(`withdraw sent: ${await provider.sendRawTransaction(hex)}`);
       
        return;
    }
    throw new Error(`unknown mode ${mode} (genesis | withdraw)`);
}

const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

main().catch((e) => { console.error(`✗ ${e.message ?? e}`); process.exit(1); });
