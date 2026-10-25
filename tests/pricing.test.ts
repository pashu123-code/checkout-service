import { describe, expect, it } from 'vitest';
import { priceLines } from '../src/domain/pricing';

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

  it('prices an empty cart at zero', () => {
    expect(priceLines([])).toMatchObject({ subtotalCents: 0, totalCents: 0 });
  });

  it('gives the same result for the same input', () => {
    expect(priceLines(lines, 15)).toEqual(priceLines(lines, 15));
  });
});
