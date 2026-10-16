/**
 * Phase 2 live check on chipnet: mint a Mesh V4 position NFT with three
 * BCH-only bins (bid side, pUSD pair) and BCMR metadata, then (optionally)
 * withdraw the bins through the owner path.
 *
 *   plan       [--to <chipnet token address>] [--bcmr-url https://…/<file>.json]
 *              Builds the seed and genesis transactions, verifies both with the
 *              BCH 2026 VM and checkGenesis, and saves the raw transactions, the
 *              BCMR registry and a state file. Sends nothing.
 *   broadcast  Sends the saved plan unchanged, after checking that the seed
 *              coin is still unspent and (with a BCMR URL) that the URL serves
 *              the registry with exactly the sha256 committed on chain.
 *   withdraw   [--broadcast]  Spends the bins back to the funder through the
 *              owner path (only when the NFT went to the funder).
 *
 * Layout of the genesis (BCMR authchain, see docs/PositionNft.md §4):
 *   output 0  identity output, 800 sats to the Mesh metadata key (here: the
 *             funder). Whoever spends it can publish new metadata, so the
 *             genesis stays the authchain head until Mesh updates it.
 *   output 1  the position NFT (mutable, commitment v1) to --to
 *   2..4      the bins
 *   then      OP_RETURN 'BCMR' <sha256(registry)> <url>, change
 * The category is the seed transaction's txid (the authbase).
 *
 * Funding key: FUNDER_WIF (environment, else BCHMesh/meshserver/.env).
 * Output: data/chipnet/position-test/ (gitignored), or --out.
 */
import { ElectrumNetworkProvider, SignatureTemplate, TransactionBuilder } from 'cashscript';
import {
    binToHex, cashAddressToLockingBytecode, decodePrivateKeyWif, decodeTransaction, encodeCashAddress, encodeTransaction,
    hash160, hashTransaction, hexToBin, secp256k1, sha256, utf8ToBin,
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
const STEP = 100, LEVELS = [760, 761, 762], BIN_SATS = 3_000n, NFT_SATS = 1_000n, IDENTITY_SATS = 800n, FEE_RATE = 1.2;

const args = process.argv.slice(2);
const mode = args[0] ?? 'plan';
const flag = (n: string) => args.includes(n);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const OUT = opt('--out') ?? join(V4, 'data', 'chipnet', 'position-test');
const STATE = join(OUT, 'position-genesis.json');
const REGISTRY = join(OUT, 'bcmr-registry.json');

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
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
const plainBins = (bins: BinV4Params[]) => bins.map((p) => JSON.parse(JSON.stringify(p, (_k, x) => (typeof x === 'bigint' ? String(x) : x))));
const reviveBins = (raw: any[]): BinV4Params[] => raw.map((p) => ({ ...p, bidNum: BigInt(p.bidNum), bidDen: BigInt(p.bidDen), askNum: BigInt(p.askNum), askDen: BigInt(p.askDen) }));

/** Fetch the hosted registry and compare its exact bytes' sha256 with the committed hash (as mainnet-js does). */
async function hostedHash(url: string): Promise<string> {
    const r = await fetch(url, { cache: 'no-store' } as any);
    if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
    return binToHex(sha256.hash(utf8ToBin(await r.text())));
}

async function plan(provider: ElectrumNetworkProvider, f: ReturnType<typeof funder>) {
    const height = await provider.getBlockHeight();
    const utxos = (await provider.getUtxos(f.address)).filter((u) => !u.token);
    console.log(`chipnet height ${height}; funder ${f.address} has ${utxos.length} BCH-only UTXOs, ${utxos.reduce((s, u) => s + u.satoshis, 0n)} sats`);
    const need = BIN_SATS * BigInt(LEVELS.length) + NFT_SATS + IDENTITY_SATS + 5_000n;

    // 1. Seed: a self-send whose output #0 the genesis spends. Its txid becomes the category (the authbase).
    const pay = utxos.sort((a, b) => Number(b.satoshis - a.satoshis))[0];
    if (!pay || pay.satoshis < need + 2_000n) throw new Error(`funder needs a UTXO of at least ${need + 2_000n} sats`);
    const sb = new TransactionBuilder({ provider }).addInput(pay, f.sig.unlockP2PKH());
    (sb as any).outputs.push({ to: f.lock, amount: pay.satoshis - 1_000n });
    (sb as any).outputs[0].amount = pay.satoshis - sizeFee(sb);
    const seedBuilt = buildTx(sb);
    const sv = verify(seedBuilt);
    if (sv !== true) throw new Error(`seed tx invalid: ${sv}`);
    const seedHex = binToHex(encodeTransaction(seedBuilt.transaction));
    const category = hashTransaction(encodeTransaction(seedBuilt.transaction));
    const seedOut = seedBuilt.transaction.outputs[0]!.valueSatoshis;

    // 2. Genesis.
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
    const url = opt('--bcmr-url')?.replace('{category}', category);  // e.g. https://mesh-metadata.vercel.app/bcmr/{category}.json
    const registry = positionRegistry([{
        category, name: 'Mesh V4 test position BCH/pUSD',
        description: 'Chipnet test of a Mesh V4 position NFT: three BCH bins on the 1% grid around 2,000 sats per pUSD unit. Whoever holds this NFT controls the bins.',
    }], new Date().toISOString());
    const registryBytes = utf8ToBin(JSON.stringify(registry, null, 2) + '\n');
    const registryHash = binToHex(sha256.hash(registryBytes));

    const seedUtxo = { txid: category, vout: 0, satoshis: seedOut, lockingBytecode: binToHex(f.lock) };
    const b = new TransactionBuilder({ provider }).addInput(seedUtxo as any, f.sig.unlockP2PKH());
    const outs = (b as any).outputs as any[];
    outs.push({ to: f.lock, amount: IDENTITY_SATS });                                              // 0: identity output
    outs.push({ to: lockOfAddress(to), amount: NFT_SATS, token: nft(category, 'mutable', cHex) }); // 1: position NFT
    bins.forEach((p) => outs.push({ to: hexBytes(binOf(p, provider as any).lockingBytecode), amount: BIN_SATS }));
    if (url) b.addOpReturnOutput(bcmrPublicationChunks(registryBytes, url));
    const spent = IDENTITY_SATS + NFT_SATS + BIN_SATS * BigInt(bins.length);
    outs.push({ to: f.lock, amount: seedOut - spent - 1_000n });
    outs.at(-1).amount = seedOut - spent - sizeFee(b);
    const built = buildTx(b);
    const v = verify(built);
    if (v !== true) throw new Error(`genesis invalid in the VM: ${v}`);
    const reg = checkGenesis(built.transaction, built.sourceOutputs, bins, provider as any);
    if (reg.nftIndex !== 1) throw new Error('NFT expected at output 1');
    const genesisHex = binToHex(encodeTransaction(built.transaction));
    const txid = hashTransaction(encodeTransaction(built.transaction));

    mkdirSync(OUT, { recursive: true });
    writeFileSync(REGISTRY, registryBytes);
    const state = {
        category, seedTxid: category, txid, seedHex, genesisHex, seedSpends: `${pay.txid}:${pay.vout}`,
        recipient: to, bcmrUrl: url ?? null, registryHash, commitment, cHex, bins: plainBins(bins),
        nftOutput: reg.nftIndex, binOutputs: reg.binIndexes, plannedAt: new Date().toISOString(), broadcast: null as null | string,
    };
    writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
    console.log(`seed     ${category} (self-send; its txid is the category)`);
    console.log(`genesis  ${txid}: ${built.size} B · VM ✓ · checkGenesis ✓ · identity output 0 → funder · NFT output 1 → ${to} · bins at ${reg.binIndexes}`);
    console.log(url ? `BCMR     publication → ${url}\n         sha256 ${registryHash}\n         upload ${REGISTRY} to that URL byte for byte, then run: broadcast`
        : 'BCMR     none (no --bcmr-url): wallets will show the raw NFT');
    console.log(`plan saved in ${OUT}. Nothing sent.`);
}

async function broadcast(provider: ElectrumNetworkProvider, f: ReturnType<typeof funder>) {
    const s = JSON.parse(readFileSync(STATE, 'utf-8'));
    if (s.broadcast) throw new Error(`already broadcast at ${s.broadcast}`);
    const [ptx, pvout] = s.seedSpends.split(':');
    const still = (await provider.getUtxos(f.address)).some((u) => u.txid === ptx && u.vout === Number(pvout));
    if (!still) throw new Error('the seed coin has been spent since planning: run plan again (the category and registry will change)');
    if (s.bcmrUrl) {
        const h = await hostedHash(s.bcmrUrl);
        if (h !== s.registryHash) throw new Error(`the hosted registry's sha256 is ${h}, the genesis commits to ${s.registryHash}: upload ${REGISTRY} unchanged`);
        console.log(`hosted registry matches the committed hash ✓ (${s.bcmrUrl})`);
    }
    for (const [name, hex] of [['seed', s.seedHex], ['genesis', s.genesisHex]] as const) {
        if (typeof decodeTransaction(hexToBin(hex)) === 'string') throw new Error(`${name}: saved transaction does not decode`);
    }
    console.log(`seed sent:    ${await provider.sendRawTransaction(s.seedHex)}`);
    console.log(`genesis sent: ${await provider.sendRawTransaction(s.genesisHex)}`);
    s.broadcast = new Date().toISOString();
    writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n');
    console.log(`https://chipnet.imaginary.cash/tx/${s.txid}\ncategory ${s.category}`);
}

async function withdraw(provider: ElectrumNetworkProvider, f: ReturnType<typeof funder>) {
    const s = JSON.parse(readFileSync(STATE, 'utf-8'));
    if (s.recipient !== f.tokenAddress) throw new Error('the NFT went to another wallet: withdraw from that wallet');
    const nftUtxo = (await provider.getUtxos(f.tokenAddress)).find((u) => u.token?.category === s.category && u.token?.nft);
    if (!nftUtxo) throw new Error('the funder does not hold the position NFT');
    const bins = reviveBins(s.bins);
    const b = new TransactionBuilder({ provider });
    bins.forEach((p, k) => {
        const c = binOf(p, provider as any);
        b.addInput({ txid: s.txid, vout: s.binOutputs[k], satoshis: BIN_SATS, lockingBytecode: c.lockingBytecode } as any, (c as any).unlock.owner(BigInt(bins.length)));
    });
    b.addInput(nftUtxo, f.sig.unlockP2PKH());
    const outs = (b as any).outputs as any[];
    outs.push({ to: f.lock, amount: nftUtxo.satoshis, token: nftUtxo.token as Tok });
    const sats = BIN_SATS * BigInt(bins.length);
    outs.push({ to: f.lock, amount: sats - 1_000n });
    outs.at(-1).amount = sats - sizeFee(b);
    const built = buildTx(b);
    const v = verify(built);
    if (v !== true) throw new Error(`withdraw invalid in the VM: ${v}`);
    console.log(`withdraw of ${bins.length} bins through the owner path: ${built.size} B, VM ✓`);
    if (!flag('--broadcast')) { console.log('dry run: nothing sent (add --broadcast).'); return; }
    console.log(`withdraw sent: ${await provider.sendRawTransaction(binToHex(encodeTransaction(built.transaction)))}`);
}

async function main() {
    const provider = new ElectrumNetworkProvider('chipnet');
    const f = funder();
    if (mode === 'plan') return plan(provider, f);
    if (mode === 'broadcast') return broadcast(provider, f);
    if (mode === 'withdraw') return withdraw(provider, f);
    throw new Error(`unknown mode ${mode} (plan | broadcast | withdraw)`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(`✗ ${e.message ?? e}`); process.exit(1); });
