import type { Cents } from '../domain/money';
import { conflict, notFound } from '../errors';
import { type Product, type Store, availableQuantity } from '../store';

export interface ProductView {
  id: string;
  name: string;
  priceCents: Cents;
  availableQuantity: number;
}

export function toProductView(product: Product): ProductView {
  return {
    id: product.id,
    name: product.name,
    priceCents: product.priceCents,
    availableQuantity: availableQuantity(product),
  };
}

export function listProducts(store: Store): ProductView[] {
  return [...store.products.values()].map(toProductView);
}

/** What administrators see: includes stock held by pending checkouts. */
export interface AdminProductView extends ProductView {
  stock: number;
  reserved: number;
}

export interface ProductUpdate {
  name?: string;
  priceCents?: Cents;
  /** Absolute units on hand, so repeating the same update is harmless. */
  stock?: number;
}

export function toAdminProductView(product: Product): AdminProductView {
  return { ...toProductView(product), stock: product.stock, reserved: product.reserved };
}

/**
 * Changes a product for future carts and checkouts. Existing orders keep
 * their own copy of name and price, and a checkout already waiting for
 * payment keeps the price it reserved with.
 */
export function updateProduct(store: Store, productId: string, update: ProductUpdate): Product {
  const product = getProductOrThrow(store, productId);

  if (update.stock !== undefined && update.stock < product.reserved) {
    throw conflict(
      'STOCK_BELOW_RESERVED',
      `Stock cannot go below the ${product.reserved} units held by pending checkouts.`,
      { productId, reserved: product.reserved, requestedStock: update.stock },
    );
  }

  if (update.name !== undefined) product.name = update.name;
  if (update.priceCents !== undefined) product.priceCents = update.priceCents;
  if (update.stock !== undefined) product.stock = update.stock;
  return product;
}

export function getProductOrThrow(store: Store, productId: string): Product {
  const product = store.products.get(productId);
  if (!product) {
    throw notFound('PRODUCT_NOT_FOUND', `Product ${productId} does not exist.`, {
      productId,
    });
  }
  return product;
}
