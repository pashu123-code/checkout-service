import { describe, expect, it } from 'vitest';
import { MoneyError, lineTotal, percentDiscount, sumCents } from '../src/domain/money';

describe('lineTotal', () => {
  it('multiplies integer cents exactly', () => {
    expect(lineTotal(1999, 3)).toBe(5997);
  });

  it('rejects fractional cents instead of rounding them', () => {
    expect(() => lineTotal(19.99, 1)).toThrow(MoneyError);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects quantity %s', (quantity) => {
    expect(() => lineTotal(100, quantity)).toThrow(MoneyError);
  });
});

describe('sumCents', () => {
  it('fails instead of losing precision past the safe-integer range', () => {
    expect(() => sumCents([Number.MAX_SAFE_INTEGER, 1])).toThrow(MoneyError);
  });
});

describe('percentDiscount', () => {
  it.each([
    [999, 10, 99], // 99.9 rounds down
    [1005, 15, 150], // 150.75 rounds down
    [1, 50, 0], // half a cent rounds down to nothing
    [2000, 10, 200], // exact
  ])('%i¢ at %i%% gives a %i¢ discount', (subtotal, percent, expected) => {
    expect(percentDiscount(subtotal, percent)).toBe(expected);
  });

  it('never exceeds the subtotal, even at 100%', () => {
    expect(percentDiscount(4321, 100)).toBe(4321);
  });

  it.each([0, 101, 12.5, -10, Number.NaN])('rejects percent %s', (percent) => {
    expect(() => percentDiscount(1000, percent)).toThrow(MoneyError);
  });

  it('fails rather than overflowing on huge subtotals', () => {
    expect(() => percentDiscount(Number.MAX_SAFE_INTEGER, 100)).toThrow(MoneyError);
  });
});
