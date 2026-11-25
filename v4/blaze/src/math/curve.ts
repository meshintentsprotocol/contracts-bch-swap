import type { CurveStateV1 } from '../curve/state.js';

const MAX = (1n << 63n) - 1n;
const DEN = 10_000n;

export interface FeeWeights { creatorBps: number; partnerBps: number; protocolBps: number }
export interface CurveConfig {
  virtualBase: bigint;
  virtualQuote: bigint;
  quoteThreshold: bigint;
  fees: FeeWeights;
}
export interface CurveInventory { base: bigint; state: CurveStateV1 }
export interface FeeSplit { total: bigint; creator: bigint; partner: bigint; protocol: bigint }
export interface BuyQuote {
  usedGross: bigint;
  netQuote: bigint;
  baseOut: bigint;
  refund: bigint;
  fees: FeeSplit;
  complete: boolean;
  next: CurveInventory;
}
export interface SellQuote {
  baseIn: bigint;
  grossQuote: bigint;
  traderQuote: bigint;
  fees: FeeSplit;
  next: CurveInventory;
}

function invalid(message: string): never { throw new Error(`Mesh Blaze curve math: ${message}`); }
function amount(value: bigint, label: string) { if (typeof value !== 'bigint' || value < 0n || value > MAX) invalid(`${label} outside signed VM range`); }
function validate(config: CurveConfig, inventory: CurveInventory) {
  amount(config.virtualBase, 'virtual base'); amount(config.virtualQuote, 'virtual quote'); amount(config.quoteThreshold, 'threshold');
  amount(inventory.base, 'base inventory'); amount(inventory.state.realQuote, 'real quote');
  if (!config.virtualBase || !config.virtualQuote || !config.quoteThreshold || !inventory.base) invalid('curve reserves and inventory must be positive');
  if (inventory.state.stage !== 0) invalid('curve trading is complete');
  if (inventory.state.realQuote >= config.quoteThreshold) invalid('real quote already at threshold');
  const weights = [config.fees.creatorBps, config.fees.partnerBps, config.fees.protocolBps];
  if (weights.some((w) => !Number.isInteger(w) || w < 0 || w > 10_000) || weights.reduce((a, b) => a + b, 0) >= 10_000) invalid('invalid fee bps');
}

export function splitQuoteFee(gross: bigint, weights: FeeWeights): FeeSplit {
  amount(gross, 'fee base');
  const totalBps = weights.creatorBps + weights.partnerBps + weights.protocolBps;
  if (!Number.isInteger(totalBps) || totalBps < 0 || totalBps >= 10_000 || [weights.creatorBps, weights.partnerBps, weights.protocolBps].some((x) => !Number.isInteger(x) || x < 0)) invalid('invalid fee weights');
  const total = gross * BigInt(totalBps) / DEN;
  if (totalBps === 0) return { total, creator: 0n, partner: 0n, protocol: 0n };
  let creator = total * BigInt(weights.creatorBps) / BigInt(totalBps);
  let partner = total * BigInt(weights.partnerBps) / BigInt(totalBps);
  let protocol = total * BigInt(weights.protocolBps) / BigInt(totalBps);
  const remainder = total - creator - partner - protocol;
  if (weights.protocolBps) protocol += remainder;
  else if (weights.creatorBps) creator += remainder;
  else partner += remainder;
  return { total, creator, partner, protocol };
}

function addFees(state: CurveStateV1, fee: FeeSplit): CurveStateV1 {
  const next = { ...state, creatorFees: state.creatorFees + fee.creator, partnerFees: state.partnerFees + fee.partner, protocolFees: state.protocolFees + fee.protocol };
  amount(next.creatorFees, 'creator fees'); amount(next.partnerFees, 'partner fees'); amount(next.protocolFees, 'protocol fees');
  return next;
}

function netQuote(gross: bigint, weights: FeeWeights) { return gross - splitQuoteFee(gross, weights).total; }

/** Exact-in buy; if the threshold is crossed, spend the smallest gross reaching it and refund the rest. */
export function quoteBuy(config: CurveConfig, inventory: CurveInventory, grossInput: bigint): BuyQuote {
  validate(config, inventory); amount(grossInput, 'gross input');
  if (grossInput <= 0n) invalid('buy input must be positive');
  const remaining = config.quoteThreshold - inventory.state.realQuote;
  let usedGross = grossInput;
  if (netQuote(grossInput, config.fees) >= remaining) {
    let low = 0n, high = grossInput;
    while (low < high) {
      const mid = (low + high) >> 1n;
      if (netQuote(mid, config.fees) >= remaining) high = mid;
      else low = mid + 1n;
    }
    usedGross = low;
  }
  const fees = splitQuoteFee(usedGross, config.fees);
  const net = usedGross - fees.total;
  const x = inventory.base + config.virtualBase;
  const y = inventory.state.realQuote + config.virtualQuote;
  const baseOut = x * net / (y + net);
  if (net <= 0n || baseOut <= 0n || baseOut > inventory.base) invalid('buy exceeds available base or rounds to zero');
  const realQuote = inventory.state.realQuote + net;
  amount(realQuote, 'next real quote');
  const complete = realQuote === config.quoteThreshold;
  return {
    usedGross, netQuote: net, baseOut, refund: grossInput - usedGross, fees, complete,
    next: { base: inventory.base - baseOut, state: { ...addFees(inventory.state, fees), realQuote, stage: complete ? 1 : 0 } },
  };
}

/** Exact-in sell; virtual quote never authorizes paying more than actual real quote. */
export function quoteSell(config: CurveConfig, inventory: CurveInventory, baseIn: bigint): SellQuote {
  validate(config, inventory); amount(baseIn, 'base input');
  if (baseIn <= 0n) invalid('sell input must be positive');
  const x = inventory.base + config.virtualBase;
  const y = inventory.state.realQuote + config.virtualQuote;
  const grossQuote = y * baseIn / (x + baseIn);
  if (grossQuote <= 0n || grossQuote > inventory.state.realQuote) invalid('sell cannot draw from virtual quote or round to zero');
  const fees = splitQuoteFee(grossQuote, config.fees);
  const nextBase = inventory.base + baseIn;
  amount(nextBase, 'next base inventory');
  return {
    baseIn, grossQuote, traderQuote: grossQuote - fees.total, fees,
    next: { base: nextBase, state: { ...addFees(inventory.state, fees), realQuote: inventory.state.realQuote - grossQuote } },
  };
}
