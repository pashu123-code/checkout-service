import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  assertCents,
  lineTotal,
  percentDiscount,
  sumCents,
} from '../src/domain/money';

const MAX = Number.MAX_SAFE_INTEGER;

// Request bodies are parsed JSON, so at runtime a "number" can be anything.
const junkValues: unknown[] = ['100', null, undefined, true, [], {}, 10n];

describe('assertCents', () => {
  it.each([0, 1, MAX])('accepts %s', (value) => {
    expect(assertCents(value)).toBe(value);
  });

  it.each([-1, 0.5, MAX + 1, Number.NaN, Infinity, -Infinity])(
    'rejects %s',
    (value) => {
      expect(() => assertCents(value)).toThrow(MoneyError);
    },
  );

  it.each(junkValues)('rejects non-number %s', (value) => {
    expect(() => assertCents(value as number)).toThrow(MoneyError);
  });

  it('turns -0 into 0 so it never shows up as "-0"', () => {
    // JSON.parse('-0') produces -0, and toBe() tells the two apart.
    expect(assertCents(JSON.parse('-0'))).toBe(0);
  });
});

describe('lineTotal', () => {
  it('multiplies integer cents exactly', () => {
    expect(lineTotal(1999, 3)).toBe(5997);
  });

  it('allows a free item', () => {
    expect(lineTotal(0, 5)).toBe(0);
  });

  it('rejects fractional cents instead of rounding them', () => {
    expect(() => lineTotal(19.99, 1)).toThrow(MoneyError);
  });

  it.each([0, -1, 1.5, Number.NaN, Infinity, ...junkValues])(
    'rejects quantity %s',
    (quantity) => {
      expect(() => lineTotal(100, quantity as number)).toThrow(MoneyError);
    },
  );

  it('accepts a total exactly at the safe limit and rejects one past it', () => {
    expect(lineTotal(MAX, 1)).toBe(MAX);
    expect(() => lineTotal(MAX, 2)).toThrow(MoneyError);
  });
});

describe('sumCents', () => {
  it('sums nothing to zero', () => {
    expect(sumCents([])).toBe(0);
  });

  it('accepts a sum exactly at the safe limit', () => {
    expect(sumCents([MAX - 1, 1])).toBe(MAX);
  });

  it('fails instead of losing precision past the safe-integer range', () => {
    expect(() => sumCents([MAX, 1])).toThrow(MoneyError);
  });

  it.each([-5, 2.5, Number.NaN])('rejects a bad amount (%s) in the list', (bad) => {
    expect(() => sumCents([100, bad, 100])).toThrow(MoneyError);
  });
});

describe('percentDiscount', () => {
  it.each([
    [999, 10, 99], // 99.9 rounds down
    [1005, 15, 150], // 150.75 rounds down
    [1, 50, 0], // half a cent rounds down to nothing
    [1, 99, 0], // 0.99¢ rounds down to nothing
    [2000, 10, 200], // exact
    [0, 100, 0], // empty subtotal
  ])('%i¢ at %i%% gives a %i¢ discount', (subtotal, percent, expected) => {
    expect(percentDiscount(subtotal, percent)).toBe(expected);
  });

  it('accepts the 1% and 100% boundaries', () => {
    expect(percentDiscount(10_000, 1)).toBe(100);
    expect(percentDiscount(4321, 100)).toBe(4321);
  });

  it.each([0, 101, 12.5, 99.999, -10, Number.NaN, Infinity, ...junkValues])(
    'rejects percent %s',
    (percent) => {
      expect(() => percentDiscount(1000, percent as number)).toThrow(MoneyError);
    },
  );

  it('rejects a bad subtotal', () => {
    expect(() => percentDiscount(-1, 10)).toThrow(MoneyError);
    expect(() => percentDiscount(10.5, 10)).toThrow(MoneyError);
  });

  it('works right up to the overflow limit and fails one cent past it', () => {
    const largest = Math.floor(MAX / 100);
    expect(percentDiscount(largest, 100)).toBe(largest);
    expect(() => percentDiscount(largest + 1, 100)).toThrow(MoneyError);
  });

  it('matches exact integer arithmetic for every percent across all magnitudes', () => {
    const random = seededRandom(20261025);
    let checked = 0;

    for (let percent = 1; percent <= 100; percent++) {
      const limit = Math.floor(MAX / percent);
      const subtotals = [0, 1, 99, 100, 101, limit - 1, limit];
      for (let digits = 1; digits <= 16; digits++) {
        subtotals.push(Math.floor(random() * Math.min(10 ** digits, limit)));
      }

      for (const subtotal of subtotals) {
        // BigInt division truncates, which is floor for non-negative values.
        const exact = Number((BigInt(subtotal) * BigInt(percent)) / 100n);
        const discount = percentDiscount(subtotal, percent);

        expect(discount).toBe(exact);
        expect(discount).toBeLessThanOrEqual(subtotal);
        checked++;
      }
    }

    expect(checked).toBe(100 * 23);
  });
});

/** Small deterministic PRNG (mulberry32) so the random checks are repeatable. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
