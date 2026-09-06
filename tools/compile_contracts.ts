import { compileFile } from 'cashscript';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.join(__dirname, '..', 'contracts');
const artifactsDir = path.join(__dirname, '..', 'artifacts');

if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true });
}

const contractFiles = [
    'MeshStrategyWithSurplusCapture.cash',
    'StrategyCovenant.cash',
    'OracleStrategyCovenant.cash',
    'MultiPairRecyclingCovenant.cash',
    'DutchDecayStrategyCovenant.cash',
    'DutchAuctionSwap.cash',
    'LimitOrderSwap.cash',
    'DutchAuctionSwapWithFee.cash',
    'LimitOrderSwapWithFee.cash',
];

for (const file of contractFiles) {
    const contractPath = path.join(contractsDir, file);
    if (fs.existsSync(contractPath)) {
        try {
            console.log(`Compiling ${file}...`);
            const artifact = compileFile(contractPath);
            const artifactName = file.replace('.cash', '.json');
            fs.writeFileSync(path.join(artifactsDir, artifactName), JSON.stringify(artifact, null, 2));
            console.log(`✅ Successfully compiled ${file} -> artifacts/${artifactName}`);
        } catch (err: any) {
            console.error(`❌ Failed to compile ${file}:`, err.message);
        }
    }
}
