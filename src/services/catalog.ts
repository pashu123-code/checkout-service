import type { Cents } from '../domain/money';
import { notFound } from '../errors';
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

export function getProductOrThrow(store: Store, productId: string): Product {
  const product = store.products.get(productId);
  if (!product) {
    throw notFound('PRODUCT_NOT_FOUND', `Product ${productId} does not exist.`, {
      productId,
    });
  }
  return product;
}
