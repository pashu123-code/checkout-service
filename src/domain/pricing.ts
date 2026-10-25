import { type Cents, lineTotal, percentDiscount, sumCents } from './money';

export interface LineInput {
  productId: string;
  unitPriceCents: Cents;
  quantity: number;
}

export interface PricedLine extends LineInput {
  lineTotalCents: Cents;
}

export interface PriceBreakdown {
  lines: PricedLine[];
  subtotalCents: Cents;
  discountPercent: number | null;
  discountCents: Cents;
  totalCents: Cents;
}

/**
 * The single place where cart and order totals are calculated, so the cart
 * view, checkout, and stored orders can never disagree about the arithmetic.
 *
 * The discount is applied once to the whole subtotal rather than per line.
 * Rounding once keeps the result independent of how items are split across
 * lines (two 5¢ lines at 10% give a 1¢ discount, not 0¢ + 0¢).
 */
export function priceLines(
  inputs: readonly LineInput[],
  discountPercent: number | null = null,
): PriceBreakdown {
  const lines = inputs.map((input) => ({
    ...input,
    lineTotalCents: lineTotal(input.unitPriceCents, input.quantity),
  }));
  const subtotalCents = sumCents(lines.map((line) => line.lineTotalCents));
  const discountCents =
    discountPercent === null ? 0 : percentDiscount(subtotalCents, discountPercent);

  return {
    lines,
    subtotalCents,
    discountPercent,
    discountCents,
    totalCents: subtotalCents - discountCents,
  };
}
