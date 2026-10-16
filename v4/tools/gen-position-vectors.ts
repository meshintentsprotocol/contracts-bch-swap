/**
 * Position NFT parity vectors for the meshserver and frontend: commitment
 * fields ↔ hex, the BCMR parse result for each, the parse bytecode, and
 * commitments the decoder must refuse.
 *
 * Usage: npx tsx tools/gen-position-vectors.ts
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { COMMITMENT_V1_LEN, PARSE_BYTECODE, encodeCommitment, type PositionCommitment } from '../test/position.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'test', 'vectors', 'positionNft.vectors.json');

const PUSD = 'dfe50223c8d5cba8dcef8dff6d92b61deb88a8ba44947367f2b746487b56039b';
const base: PositionCommitment = {
    version: 1, shape: 'curve', variant: 'default', tokenCat: PUSD, binStepBps: 100,
    lowIndex: 760, highIndex: 762, binCount: 3, managerHash: '00'.repeat(32), createdHeight: 900_000,
};

export const CASES: Array<[string, PositionCommitment]> = [
    ['curve-default-no-manager', base],
    ['spot-with-manager', { ...base, shape: 'spot', managerHash: 'cd'.repeat(32), binCount: 21, lowIndex: 750, highIndex: 770 }],
    ['bidask-negative-indexes', { ...base, shape: 'bidAsk', lowIndex: -1852, highIndex: -1, binCount: 1852, binStepBps: 10 }],
    ['custom-sizefee-extremes', { ...base, shape: 'custom', variant: 'sizeFee', lowIndex: -(2 ** 31 - 1), highIndex: 2 ** 31 - 1, binCount: 32_767, binStepBps: 10_000, createdHeight: 499_999_999 }],
    ['vesting', { ...base, variant: 'vesting' }],
    ['locked', { ...base, variant: 'locked' }],
    ['fee-schedule', { ...base, variant: 'feeSchedule' }],
];

export function generate() {
    const ok = encodeCommitment(base);
    return {
        description: 'Mesh V4 position NFT commitment v1 vectors. tokenCat in display order; indexes are signed; `hex` is the NFT commitment.',
        commitmentLength: COMMITMENT_V1_LEN,
        parseBytecode: PARSE_BYTECODE,
        vectors: CASES.map(([name, c]) => ({ name, fields: c, hex: encodeCommitment(c) })),
        invalid: [
            { name: 'empty', hex: '' },
            { name: 'one byte short', hex: ok.slice(0, -2) },
            { name: 'version 2', hex: '02' + ok.slice(2) },
            { name: 'reserved flag bits', hex: ok.slice(0, 2) + 'c1' + ok.slice(4) },
            { name: 'unknown shape', hex: ok.slice(0, 2) + '07' + ok.slice(4) },
            { name: 'unknown variant', hex: ok.slice(0, 2) + '39' + ok.slice(4) },
            { name: 'bin step 0', hex: ok.slice(0, 68) + '0000' + ok.slice(72) },
            { name: 'bin count 0', hex: ok.slice(0, 88) + '0000' + ok.slice(92) },
        ],
    };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const out = generate();
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${out.vectors.length} commitments and ${out.invalid.length} invalid → ${OUT}`);
}
