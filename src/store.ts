import type { Cents } from './domain/money';

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

/**
 * All application state. Everything lives in memory, so a restart starts
 * from the seed data again.
 */
export interface Store {
  products: Map<string, Product>;
  carts: Map<string, Cart>;
}

export function createStore(products: readonly Product[]): Store {
  return {
    products: new Map(products.map((product) => [product.id, { ...product }])),
    carts: new Map(),
  };
}

export function availableQuantity(product: Product): number {
  return product.stock - product.reserved;
}
