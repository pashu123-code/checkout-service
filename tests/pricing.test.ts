import { describe, expect, it } from 'vitest';
import { MoneyError } from '../src/domain/money';
import { type LineInput, priceLines } from '../src/domain/pricing';

describe('priceLines', () => {
  const lines = [
    { productId: 'p_keyboard', unitPriceCents: 1999, quantity: 3 },
    { productId: 'p_cable', unitPriceCents: 250, quantity: 1 },
  ];

  it('totals lines without a discount', () => {
    const result = priceLines(lines);

    expect(result.lines.map((line) => line.lineTotalCents)).toEqual([5997, 250]);
    expect(result.subtotalCents).toBe(6247);
    expect(result.discountPercent).toBeNull();
    expect(result.discountCents).toBe(0);
    expect(result.totalCents).toBe(6247);
  });

  it('applies the discount once to the subtotal and rounds down', () => {
    const result = priceLines(lines, 10);

    expect(result.discountCents).toBe(624); // 624.7
    expect(result.totalCents).toBe(5623);
    expect(result.totalCents).toBe(result.subtotalCents - result.discountCents);
  });

  it('rounds at order level, not per line', () => {
    const result = priceLines(
      [
        { productId: 'p_a', unitPriceCents: 5, quantity: 1 },
        { productId: 'p_b', unitPriceCents: 5, quantity: 1 },
      ],
      10,
    );

    // Per-line rounding would give 0¢ + 0¢; one rounding on 10¢ gives 1¢.
    expect(result.discountCents).toBe(1);
  });

  it('brings a 100% discount to zero, never below', () => {
    expect(priceLines(lines, 100).totalCents).toBe(0);
  });

  it('prices an empty cart at zero, with or without a discount', () => {
    expect(priceLines([])).toMatchObject({ subtotalCents: 0, totalCents: 0 });
    expect(priceLines([], 50)).toMatchObject({ discountCents: 0, totalCents: 0 });
  });

  it('treats an omitted discount the same as no discount', () => {
    expect(priceLines(lines, undefined)).toEqual(priceLines(lines, null));
  });

  it('rejects 0% — "no discount" is null, not zero', () => {
    expect(() => priceLines(lines, 0)).toThrow(MoneyError);
  });

  it('fails the whole calculation if any line is invalid', () => {
    const withBadLine = [...lines, { productId: 'p_bad', unitPriceCents: 100, quantity: 0 }];
    expect(() => priceLines(withBadLine)).toThrow(MoneyError);
  });

  it('fails when the lines together overflow, even if each line is fine', () => {
    const half = Math.ceil(Number.MAX_SAFE_INTEGER / 2);
    const huge = [
      { productId: 'p_a', unitPriceCents: half, quantity: 1 },
      { productId: 'p_b', unitPriceCents: half, quantity: 1 },
    ];
    expect(() => priceLines(huge)).toThrow(MoneyError);
  });

  it('does not modify the lines it is given', () => {
    const input = structuredClone(lines);
    priceLines(input, 25);
    expect(input).toEqual(lines);
  });

  it('gives the same result for the same input', () => {
    expect(priceLines(lines, 15)).toEqual(priceLines(lines, 15));
  });

  it('keeps every total consistent across many random carts', () => {
    const random = seededRandom(42);

    for (let run = 0; run < 2000; run++) {
      const cart: LineInput[] = Array.from({ length: Math.floor(random() * 6) }, (_, i) => ({
        productId: `p_${i}`,
        unitPriceCents: Math.floor(random() * 100_000),
        quantity: 1 + Math.floor(random() * 20),
      }));
      const percent = random() < 0.3 ? null : 1 + Math.floor(random() * 100);

      const result = priceLines(cart, percent);
      const lineSum = result.lines.reduce((sum, line) => sum + line.lineTotalCents, 0);

      expect(result.subtotalCents).toBe(lineSum);
      expect(result.totalCents).toBe(result.subtotalCents - result.discountCents);
      expect(result.discountCents).toBeGreaterThanOrEqual(0);
      expect(result.discountCents).toBeLessThanOrEqual(result.subtotalCents);
      expect(result.totalCents).toBeGreaterThanOrEqual(0);
      expect(Number.isSafeInteger(result.totalCents)).toBe(true);
    }
  });
});

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
