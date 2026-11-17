/** Resume-safe broadcast of the four signed E1 genesis transactions. Run from v4/. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { decodeTransaction, encodeTransaction, hashTransaction, hexToBin } from '@bitauth/libauth';
import { ElectrumNetworkProvider } from 'cashscript';
import { checkChipnetE1Plan } from './chipnet-e1-check.js';

const PLAN = 'data/chipnet/blaze-e1/genesis-plan.json';
const PROGRESS = 'data/chipnet/blaze-e1/genesis-broadcast.json';
type Stage = 'positionSeed' | 'positionGenesis' | 'launchSeed' | 'launchGenesis';
const stages: Stage[] = ['positionSeed', 'positionGenesis', 'launchSeed', 'launchGenesis'];
const parent: Partial<Record<Stage, Stage>> = { positionGenesis: 'positionSeed', launchGenesis: 'launchSeed' };
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Electrum request exceeded ${ms} ms`)), ms))]);
}
async function seen(provider: ElectrumNetworkProvider, txid: string): Promise<boolean> {
  try {
    const raw = await withTimeout(provider.getRawTransaction(txid), 5_000);
    const decoded = decodeTransaction(hexToBin(raw));
    return typeof decoded !== 'string' && hashTransaction(encodeTransaction(decoded)) === txid;
  } catch { return false; }
}
async function main() {
  if (!process.argv.includes('--broadcast')) {
    await checkChipnetE1Plan();
    console.log('dry run only; no transaction sent');
    return;
  }
  const plan = JSON.parse(readFileSync(PLAN, 'utf8'));
  const exists = existsSync(PROGRESS);
  if (!exists) await checkChipnetE1Plan();
  const progress: { bundleHash: string; sent: Partial<Record<Stage, string>> } = exists ?
    JSON.parse(readFileSync(PROGRESS, 'utf8')) : { bundleHash: plan.bundleHash, sent: {} };
  if (progress.bundleHash !== plan.bundleHash) throw new Error('broadcast state belongs to another plan');
  const provider = new ElectrumNetworkProvider('chipnet');
  for (const stage of stages) {
    const saved = plan.transactions[stage];
    const decoded = decodeTransaction(hexToBin(saved.hex));
    if (typeof decoded === 'string' || hashTransaction(encodeTransaction(decoded)) !== saved.txid)
      throw new Error(`${stage} signed bytes or txid changed`);
    if (progress.sent[stage] === saved.txid) {
      console.log(`${stage}: previously sent ${saved.txid}`);
      continue;
    }
    const dependency = parent[stage];
    if (dependency && progress.sent[dependency] !== plan.transactions[dependency].txid)
      throw new Error(`${stage} parent seed has not been sent`);
    if (await seen(provider, saved.txid)) {
      progress.sent[stage] = saved.txid;
      writeFileSync(PROGRESS, JSON.stringify(progress, null, 2) + '\n');
      console.log(`${stage}: already visible ${saved.txid}`);
      continue;
    }
    if (stage === 'positionSeed' || stage === 'launchSeed') {
      const sourceIndex = stage === 'launchSeed' ? 0 : 1;
      const live = await withTimeout(provider.getUtxos(plan.funderAddress), 10_000);
      if (!live.some((utxo) => !utxo.token && `${utxo.txid}:${utxo.vout}` === plan.sourceOutpoints[sourceIndex]))
        throw new Error(`${stage} source is spent or unavailable; inspect chain before retrying`);
    }
    const announced = await withTimeout(provider.sendRawTransaction(saved.hex), 30_000);
    if (announced !== saved.txid) throw new Error(`${stage} returned unexpected txid ${announced}`);
    progress.sent[stage] = saved.txid;
    writeFileSync(PROGRESS, JSON.stringify(progress, null, 2) + '\n');
    console.log(`${stage}: sent ${saved.txid}`);
  }
}
main().then(() => process.exit(0)).catch((error) => {
  console.error(`chipnet E1 genesis broadcast: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
