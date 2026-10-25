import type { Cents } from './domain/money';
import type { IdempotencyRecords } from './services/idempotency';

export interface Product {
  id: string;
  name: string;
  priceCents: Cents;
  /** Units on hand that have not been sold yet. */
  stock: number;
  /** Units held by checkouts that are waiting for payment. Always <= stock. */
  reserved: number;
}

export type CartStatus = 'OPEN' | 'CHECKING_OUT' | 'CHECKED_OUT';

export interface Cart {
  id: string;
  status: CartStatus;
  /** productId -> quantity, in the order items were first added. */
  items: Map<string, number>;
  orderId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A copy of what was bought, so later product edits never change an order. */
export interface OrderLine {
  productId: string;
  name: string;
  unitPriceCents: Cents;
  quantity: number;
  lineTotalCents: Cents;
}

export interface Order {
  id: string;
  /** 1 for the first successfully placed order, 2 for the second, and so on. */
  number: number;
  cartId: string;
  lines: OrderLine[];
  subtotalCents: Cents;
  discountPercent: number | null;
  discountCents: Cents;
  totalCents: Cents;
  couponCode: string | null;
  /** Null when nothing had to be charged (a zero total). */
  paymentId: string | null;
  placedAt: string;
}

/**
 * All application state. Everything lives in memory, so a restart starts
 * from the seed data again.
 */
export interface Store {
  products: Map<string, Product>;
  carts: Map<string, Cart>;
  /** Only successfully placed orders. Never deleted, so size = orders placed. */
  orders: Map<string, Order>;
  /** Checkout results by Idempotency-Key. */
  checkoutKeys: IdempotencyRecords<Order>;
}

export function createStore(products: readonly Product[]): Store {
  return {
    products: new Map(products.map((product) => [product.id, { ...product }])),
    carts: new Map(),
    orders: new Map(),
    checkoutKeys: new Map(),
  };
}

export function availableQuantity(product: Product): number {
  return product.stock - product.reserved;
}
