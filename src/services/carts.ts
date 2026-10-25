import { randomUUID } from 'node:crypto';
import type { Cents } from '../domain/money';
import { priceLines } from '../domain/pricing';
import { conflict, notFound } from '../errors';
import { type Cart, type CartStatus, type Store, availableQuantity } from '../store';
import { getProductOrThrow } from './catalog';

/** Upper bound per line, so no single request can push totals toward overflow. */
export const MAX_LINE_QUANTITY = 1000;

export interface CartLineView {
  productId: string;
  name: string;
  unitPriceCents: Cents;
  quantity: number;
  lineTotalCents: Cents;
  /** Units that could still be bought right now; may be below `quantity`. */
  availableQuantity: number;
}

export interface CartView {
  id: string;
  status: CartStatus;
  orderId: string | null;
  items: CartLineView[];
  itemCount: number;
  /** Uses current prices. The price actually charged is fixed at checkout. */
  subtotalCents: Cents;
  createdAt: string;
  updatedAt: string;
}

export function createCart(store: Store): Cart {
  const now = new Date().toISOString();
  const cart: Cart = {
    id: `cart_${randomUUID()}`,
    status: 'OPEN',
    items: new Map(),
    orderId: null,
    createdAt: now,
    updatedAt: now,
  };
  store.carts.set(cart.id, cart);
  return cart;
}

export function getCartOrThrow(store: Store, cartId: string): Cart {
  const cart = store.carts.get(cartId);
  if (!cart) {
    throw notFound('CART_NOT_FOUND', `Cart ${cartId} does not exist.`, { cartId });
  }
  return cart;
}

/**
 * Sets the quantity of a product in the cart, adding the line if needed.
 * Setting an absolute quantity (rather than "add one more") makes retries of
 * this request harmless.
 */
export function setItemQuantity(
  store: Store,
  cartId: string,
  productId: string,
  quantity: number,
): Cart {
  const cart = getOpenCartOrThrow(store, cartId);
  const product = getProductOrThrow(store, productId);

  // Early feedback only: stock is not held for carts, so checkout checks again.
  const available = availableQuantity(product);
  if (quantity > available) {
    throw conflict('INSUFFICIENT_INVENTORY', `Only ${available} of ${product.name} available.`, {
      items: [{ productId, requested: quantity, available }],
    });
  }

  cart.items.set(productId, quantity);
  cart.updatedAt = new Date().toISOString();
  return cart;
}

/** Removing a product that is not in the cart is a no-op, so retries are safe. */
export function removeItem(store: Store, cartId: string, productId: string): Cart {
  const cart = getOpenCartOrThrow(store, cartId);
  getProductOrThrow(store, productId);

  if (cart.items.delete(productId)) {
    cart.updatedAt = new Date().toISOString();
  }
  return cart;
}

export function toCartView(store: Store, cart: Cart): CartView {
  const products = [...cart.items.keys()].map((id) => getProductOrThrow(store, id));
  const pricing = priceLines(
    products.map((product) => ({
      productId: product.id,
      unitPriceCents: product.priceCents,
      quantity: cart.items.get(product.id) ?? 0,
    })),
  );

  return {
    id: cart.id,
    status: cart.status,
    orderId: cart.orderId,
    items: pricing.lines.map((line, index) => ({
      productId: line.productId,
      name: products[index]!.name,
      unitPriceCents: line.unitPriceCents,
      quantity: line.quantity,
      lineTotalCents: line.lineTotalCents,
      availableQuantity: availableQuantity(products[index]!),
    })),
    itemCount: pricing.lines.reduce((count, line) => count + line.quantity, 0),
    subtotalCents: pricing.subtotalCents,
    createdAt: cart.createdAt,
    updatedAt: cart.updatedAt,
  };
}

function getOpenCartOrThrow(store: Store, cartId: string): Cart {
  const cart = getCartOrThrow(store, cartId);
  if (cart.status !== 'OPEN') {
    throw conflict('CART_NOT_OPEN', `Cart ${cartId} can no longer be changed.`, {
      cartId,
      status: cart.status,
    });
  }
  return cart;
}
