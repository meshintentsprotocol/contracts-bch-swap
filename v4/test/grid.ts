/**
 * Server mirror of contracts/lib/grid.cash: the V4 price grid in Q64.
 *
 *   price(step, index) = r^index   (sats per token unit × 2^64)
 *
 * Same operations in the same order as the script (exponentiation by squaring,
 * floor after every multiply), so the result is the identical integer. Any
 * change here or there must keep the S4 parity test green.
 */
export const Q = 64n;
export const ONE = 1n << Q;

export function gridPrice(step: bigint | number, index: bigint | number): bigint {
    const s = BigInt(step);
    let e = BigInt(index);
    let base = (ONE * (10000n + s)) / 10000n;
    if (e < 0n) {
        base = (ONE * 10000n) / (10000n + s);
        e = -e;
    }
    let result = ONE;
    while (e > 0n) {
        if (e % 2n === 1n) result = (result * base) >> Q;
        base = (base * base) >> Q;
        e >>= 1n;
    }
    return result;
}

/** Grid price as a bytes8-sized fraction num/den with den a power of two, rounded down (bid) or up (ask). */
export function gridFraction(step: number, index: number, round: 'down' | 'up'): { num: bigint; den: bigint } {
    const p = gridPrice(step, index);
    let shift = 0n;
    while ((p >> shift) >= 1n << 62n) shift++;
    const den = ONE >> shift;
    if (den === 0n) throw new RangeError('price too large for a bytes8 fraction');
    const floor = p >> shift;
    const num = round === 'up' && (floor << shift) !== p ? floor + 1n : floor;
    // den = 2^(64-shift) must also fit bytes8 (< 2^63): drop one more bit of precision if needed.
    if (den >= 1n << 63n) {
        const n2 = round === 'up' ? (num + 1n) >> 1n : num >> 1n;
        return { num: n2, den: den >> 1n };
    }
    return { num, den };
}
