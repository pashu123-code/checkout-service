import { notFound } from '../errors';
import type { Order, Store } from '../store';

export function getOrderOrThrow(store: Store, orderId: string): Order {
  const order = store.orders.get(orderId);
  if (!order) {
    throw notFound('ORDER_NOT_FOUND', `Order ${orderId} does not exist.`, { orderId });
  }
  return order;
}
