import { randomUUID } from 'node:crypto';
import type { Cents } from '../domain/money';
import { type PriceBreakdown, priceLines } from '../domain/pricing';
import { AppError, conflict, unprocessable } from '../errors';
import { type PaymentGateway, PaymentDeclinedError } from '../payment';
import {
  type Cart,
  type Order,
  type OrderLine,
  type Product,
  type Store,
  availableQuantity,
} from '../store';
import { getCartOrThrow } from './carts';
import { getProductOrThrow } from './catalog';

export interface CheckoutRequest {
  cartId: string;
  /** If given, checkout fails instead of charging any other amount. */
  expectedTotalCents?: Cents;
}

/** Two checkout requests are "the same request" if these fields match. */
export function checkoutFingerprint({ cartId, expectedTotalCents }: CheckoutRequest): string {
  return JSON.stringify([cartId, expectedTotalCents ?? null]);
}

export interface CheckoutDeps {
  store: Store;
  payment: PaymentGateway;
}

/** Everything held for one checkout while it waits for payment. */
interface Reservation {
  cart: Cart;
  items: { product: Product; quantity: number }[];
  lines: OrderLine[];
  pricing: PriceBreakdown;
}

/**
 * Places an order for a cart in three phases:
 *
 * 1. Reserve: check the cart, stock and total, then hold the stock. This is
 *    synchronous, and Node runs one synchronous block at a time, so no other
 *    request can see or change state halfway through it.
 * 2. Pay: the only `await`. Other requests run meanwhile, but they see the
 *    held stock and the cart's CHECKING_OUT status, so they cannot take the
 *    same units or check out the same cart.
 * 3. Commit the order, or release everything if payment failed. Synchronous
 *    again, so it is all-or-nothing.
 */
export async function checkout(deps: CheckoutDeps, request: CheckoutRequest): Promise<Order> {
  const reservation = reserve(deps.store, request);

  let paymentId: string | null = null;
  try {
    const { totalCents } = reservation.pricing;
    if (totalCents > 0) {
      ({ paymentId } = await deps.payment.charge({
        amountCents: totalCents,
        reference: reservation.cart.id,
      }));
    }
  } catch (error) {
    // The fake gateway only fails with a clear decline. A real provider can
    // also time out with an unknown outcome; releasing then could give away
    // stock that was actually paid for, so that case would need reconciling.
    release(reservation);
    if (error instanceof PaymentDeclinedError) {
      throw new AppError(
        402,
        'PAYMENT_DECLINED',
        'Payment was declined. Nothing was charged and the cart is open again.',
      );
    }
    throw error;
  }

  return commit(deps.store, reservation, paymentId);
}

function reserve(store: Store, { cartId, expectedTotalCents }: CheckoutRequest): Reservation {
  const cart = getCartOrThrow(store, cartId);
  if (cart.status === 'CHECKED_OUT') {
    throw conflict('CART_ALREADY_CHECKED_OUT', 'This cart has already been checked out.', {
      cartId,
      orderId: cart.orderId,
    });
  }
  if (cart.status === 'CHECKING_OUT') {
    throw conflict('CHECKOUT_IN_PROGRESS', 'A checkout for this cart is already in progress.', {
      cartId,
    });
  }
  if (cart.items.size === 0) {
    throw unprocessable('CART_EMPTY', 'Cannot check out an empty cart.', { cartId });
  }

  const items = [...cart.items].map(([productId, quantity]) => ({
    product: getProductOrThrow(store, productId),
    quantity,
  }));

  const shortages = items
    .filter(({ product, quantity }) => quantity > availableQuantity(product))
    .map(({ product, quantity }) => ({
      productId: product.id,
      requested: quantity,
      available: availableQuantity(product),
    }));
  if (shortages.length > 0) {
    throw conflict(
      'INSUFFICIENT_INVENTORY',
      'Some items are no longer available in the requested quantity.',
      { items: shortages },
    );
  }

  const pricing = priceLines(
    items.map(({ product, quantity }) => ({
      productId: product.id,
      unitPriceCents: product.priceCents,
      quantity,
    })),
  );
  if (expectedTotalCents !== undefined && expectedTotalCents !== pricing.totalCents) {
    throw conflict('TOTAL_MISMATCH', 'The order total is not the total you expected.', {
      expectedTotalCents,
      totalCents: pricing.totalCents,
    });
  }

  // Every check passed: hold the stock. Nothing above has changed any state.
  for (const { product, quantity } of items) {
    product.reserved += quantity;
  }
  cart.status = 'CHECKING_OUT';

  return {
    cart,
    items,
    // Captured now so an edit made while payment is pending cannot leak in.
    lines: pricing.lines.map((line, index) => ({
      productId: line.productId,
      name: items[index]!.product.name,
      unitPriceCents: line.unitPriceCents,
      quantity: line.quantity,
      lineTotalCents: line.lineTotalCents,
    })),
    pricing,
  };
}

function commit(store: Store, reservation: Reservation, paymentId: string | null): Order {
  const { cart, items, lines, pricing } = reservation;

  for (const { product, quantity } of items) {
    product.reserved -= quantity;
    product.stock -= quantity;
  }

  const order: Order = {
    id: `ord_${randomUUID()}`,
    number: store.orders.size + 1,
    cartId: cart.id,
    lines,
    subtotalCents: pricing.subtotalCents,
    discountPercent: pricing.discountPercent,
    discountCents: pricing.discountCents,
    totalCents: pricing.totalCents,
    couponCode: null,
    paymentId,
    placedAt: new Date().toISOString(),
  };
  store.orders.set(order.id, order);

  cart.status = 'CHECKED_OUT';
  cart.orderId = order.id;
  cart.updatedAt = order.placedAt;
  return order;
}

function release({ cart, items }: Reservation): void {
  for (const { product, quantity } of items) {
    product.reserved -= quantity;
  }
  cart.status = 'OPEN';
}
