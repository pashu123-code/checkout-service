/**
 * All money in this service is an integer number of cents (USD).
 *
 * Amounts are checked whenever they are created or combined, so a fractional
 * cent or an unsafe integer fails loudly instead of quietly turning into a
 * floating-point rounding error somewhere downstream.
 */
export type Cents = number;

export class MoneyError extends Error {
  override name = 'MoneyError';
}

export function assertCents(value: number, label = 'amount'): Cents {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new MoneyError(
      `${label} must be a non-negative integer number of cents, got ${value}`,
    );
  }
  // -0 passes the checks above (JSON.parse('-0') produces it); store plain 0.
  return value === 0 ? 0 : value;
}

export function assertQuantity(quantity: number): number {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new MoneyError(`quantity must be a positive integer, got ${quantity}`);
  }
  return quantity;
}

/** Coupon discounts are whole percentages from 1 to 100. */
export function assertDiscountPercent(percent: number): number {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new MoneyError(
      `discount percent must be an integer from 1 to 100, got ${percent}`,
    );
  }
  return percent;
}

export function lineTotal(unitPriceCents: Cents, quantity: number): Cents {
  assertCents(unitPriceCents, 'unit price');
  assertQuantity(quantity);
  return assertCents(unitPriceCents * quantity, 'line total');
}

export function sumCents(amounts: readonly Cents[]): Cents {
  let total = 0;
  for (const amount of amounts) {
    total = assertCents(total + assertCents(amount), 'sum');
  }
  return total;
}

/**
 * `percent`% of `subtotalCents`, rounded down to a whole cent.
 *
 * Rounding down means the store never gives away more than the advertised
 * percentage. Because percent is capped at 100, the discount can never exceed
 * the subtotal, so an order total can never go negative.
 */
export function percentDiscount(subtotalCents: Cents, percent: number): Cents {
  assertCents(subtotalCents, 'subtotal');
  assertDiscountPercent(percent);
  const scaled = assertCents(subtotalCents * percent, 'subtotal × percent');
  return Math.floor(scaled / 100);
}
