/** Independently verify the public chipnet E1 transaction chain and final UTXOs. */
import { readFileSync } from 'node:fs';
import { binToHex, createVirtualMachineBch2026, decodeTransaction,
  encodeTransaction, hashTransaction, hexToBin, lockingBytecodeToCashAddress,
  type Output, type Transaction } from '@bitauth/libauth';
import { ElectrumNetworkProvider } from 'cashscript';
import { decodeCurveStateV1 } from '../src/curve/state.js';

const ROOT = 'data/chipnet/blaze-e1/';
const read = (name: string) => JSON.parse(readFileSync(`${ROOT}${name}.json`, 'utf8'));
const fail = (message: string): never => { throw new Error(`chipnet E1 verification: ${message}`); };
const expect = (condition: unknown, message: string) => { if (!condition) fail(message); };
function address(script: string, tokenSupport: boolean) {
  const result = lockingBytecodeToCashAddress({ bytecode: hexToBin(script),
    prefix: 'bchtest', tokenSupport });
  if (typeof result === 'string') throw new Error(result);
  return result.address;
}
async function main() {
  const genesis = read('genesis-plan');
  const opening = read('opening-buy');
  const sell = read('sell');
  const terminal = read('terminal-buy');
  const curveClaims = read('curve-fees');
  const graduation = read('graduation');
  const marketBuy = read('market-buy');
  const marketClaims = read('market-claims');
  expect(curveClaims.length === 3 && marketClaims.length === 3, 'missing recipient claims');
  const stages = [
    ['positionSeed', genesis.transactions.positionSeed.txid],
    ['positionGenesis', genesis.transactions.positionGenesis.txid],
    ['launchSeed', genesis.transactions.launchSeed.txid],
    ['launchGenesis', genesis.transactions.launchGenesis.txid],
    ['openingBuy', opening.txid], ['sell', sell.txid], ['terminalBuy', terminal.txid],
    ...curveClaims.map((claim: any, i: number) => [`curveClaim${i}`, claim.txid]),
    ['graduation', graduation.txid], ['marketBuy', marketBuy.txid],
    ...marketClaims.map((claim: any, i: number) => [`marketClaim${i}`, claim.txid]),
  ] as Array<[string, string]>;
  const provider = new ElectrumNetworkProvider('chipnet');
  const cache = new Map<string, Transaction>();
  const confirmation = new Map<string, number>();
  async function fetch(txid: string): Promise<Transaction> {
    const existing = cache.get(txid);
    if (existing) return existing;
    const verbose = await provider.performRequest('blockchain.transaction.get', txid, true) as any;
    if (verbose?.txid !== txid || typeof verbose.hex !== 'string') fail(`transaction ${txid} not visible`);
    const decoded = decodeTransaction(hexToBin(verbose.hex));
    if (typeof decoded === 'string') throw new Error(`transaction ${txid} did not decode`);
    if (hashTransaction(encodeTransaction(decoded)) !== txid)
      fail(`raw transaction ${txid} differs`);
    cache.set(txid, decoded);
    confirmation.set(txid, Number(verbose.confirmations ?? 0));
    return decoded;
  }
  const tx = new Map<string, Transaction>();
  for (const [name, txid] of stages) tx.set(name, await fetch(txid));
  const vm = createVirtualMachineBch2026(true);
  for (const [name] of stages) {
    const current = tx.get(name)!;
    const sourceOutputs: Output[] = [];
    for (const input of current.inputs) {
      const parent = await fetch(binToHex(input.outpointTransactionHash));
      const source = parent.outputs[input.outpointIndex];
      if (!source) fail(`${name} references missing parent output`);
      sourceOutputs.push(source);
    }
    const result = vm.verify({ transaction: current, sourceOutputs });
    if (result !== true) fail(`${name} failed BCH VM: ${String(result)}`);
  }
  const category = genesis.tokenCategory;
  const token = (name: string, index: number) => tx.get(name)!.outputs[index]?.token;
  expect(token('launchGenesis', 0)?.amount === 1_000_000n, 'launch FT genesis supply');
  expect(token('launchGenesis', 0)?.nft?.capability === 'mutable', 'curve NFT capability');
  expect(binToHex(token('launchGenesis', 0)!.category) === category, 'launch category');
  expect(binToHex(token('positionGenesis', 0)!.category) === genesis.creatorPositionCategory,
    'creator position category');
  expect(token('positionGenesis', 0)?.nft?.capability === 'none', 'creator position mint authority');
  expect(decodeCurveStateV1(binToHex(token('openingBuy', 0)!.nft!.commitment)).realQuote === 99_000n,
    'opening curve quote');
  expect(decodeCurveStateV1(binToHex(token('sell', 0)!.nft!.commitment)).realQuote === 1n,
    'sell curve quote');
  expect(decodeCurveStateV1(binToHex(token('terminalBuy', 0)!.nft!.commitment)).realQuote === 500_003n,
    'terminal quote threshold');
  expect(decodeCurveStateV1(binToHex(token('curveClaim2', 0)!.nft!.commitment)).creatorFees === 0n,
    'creator curve fees not emptied');
  const grad = tx.get('graduation')!;
  expect(grad.outputs[0]!.valueSatoshis === 451_003n && token('graduation', 0)?.amount === 570_000n,
    'locked graduation allocation');
  expect(grad.outputs[1]!.valueSatoshis === 51_000n && token('graduation', 1)?.amount === 63_333n,
    'creator graduation allocation');
  expect(binToHex(grad.outputs[0]!.lockingBytecode) === genesis.terms.lockedBinScript,
    'locked destination script');
  expect(binToHex(grad.outputs[1]!.lockingBytecode) === genesis.terms.creatorBinScript,
    'creator destination script');
  expect(binToHex(grad.outputs[2]!.lockingBytecode) === genesis.terms.stateArchiveScript &&
    token('graduation', 2)?.nft?.capability === 'mutable', 'state archive output');
  const market = tx.get('marketBuy')!;
  expect(token('marketBuy', 0)?.amount === 560_000n && token('marketBuy', 4)?.amount === 10_000n,
    'market token transfer');
  expect(market.outputs[0]!.valueSatoshis === 472_053n, 'locked market BCH balance');
  expect([1_005n, 1_001n, 1_007n].every((value, i) => market.outputs[i + 1]!.valueSatoshis === value),
    'market fee split');
  for (let i = 0; i < 3; i++) {
    const claim = tx.get(`marketClaim${i}`)!;
    expect(claim.outputs[0]!.valueSatoshis === 1_000n &&
      claim.outputs[1]!.valueSatoshis === 546n, `market fee claim ${i}`);
  }
  const finalTokenSum = token('marketBuy', 0)!.amount + token('graduation', 1)!.amount +
    token('terminalBuy', 1)!.amount + token('marketBuy', 4)!.amount;
  expect(finalTokenSum === 1_000_000n, 'final FT supply conservation');
  const [locked, owned, archive, collectorUtxos] = await Promise.all([
    provider.getUtxos(address(genesis.terms.lockedBinScript, true)),
    provider.getUtxos(address(genesis.terms.creatorBinScript, true)),
    provider.getUtxos(address(genesis.terms.stateArchiveScript, true)),
    provider.getUtxos(address(genesis.terms.collectorScripts[0], false)),
  ]);
  expect(locked.some((utxo) => utxo.txid === marketBuy.txid && utxo.vout === 0),
    'current locked bin UTXO unavailable');
  expect(owned.some((utxo) => utxo.txid === graduation.txid && utxo.vout === 1),
    'creator bin UTXO unavailable');
  expect(archive.some((utxo) => utxo.txid === graduation.txid && utxo.vout === 2),
    'state archive UTXO unavailable');
  for (let i = 0; i < 3; i++) expect(collectorUtxos.some((utxo) =>
    utxo.txid === marketClaims[i].txid && utxo.vout === 0), `collector ${i} successor unavailable`);
  const minConfirmations = Math.min(...stages.map(([_name, txid]) => confirmation.get(txid) ?? 0));
  console.log(JSON.stringify({ status: minConfirmations > 0 ? 'CONFIRMED_E1' : 'VISIBLE_UNCONFIRMED_E1',
    network: 'chipnet', height: await provider.getBlockHeight(), transactions: stages.length,
    minimumConfirmations: minConfirmations, tokenCategory: category,
    lockedBase: '560000', lockedBchSats: '472053', creatorBase: '63333',
    archiveTxid: graduation.txid, finalTokenSupply: finalTokenSum.toString() }));
}
main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.message : 'chipnet E1 verification failed');
  process.exit(1);
});
