import type { Config } from '../config';
import { type Cents, sumCents } from '../domain/money';
import type { CouponStatus, Order, Store } from '../store';

export interface ProductSales {
  productId: string;
  name: string;
  quantity: number;
  grossRevenueCents: Cents;
}

export interface Report {
  placedOrders: number;
  itemsPurchased: ProductSales[];
  totalItemsPurchased: number;
  /** Sum of order subtotals, before discounts. */
  grossRevenueCents: Cents;
  totalDiscountCents: Cents;
  /** Sum of order totals; always gross minus discounts. */
  netRevenueCents: Cents;
  coupons: {
    generated: number;
    available: number;
    /** Held by a checkout whose payment is still pending. */
    reserved: number;
    redeemed: number;
  };
  milestones: {
    nthOrder: number;
    discountPercent: number;
    nextMilestone: number;
    /** True when POST /admin/coupons would issue a coupon right now. */
    couponAvailableToGenerate: boolean;
  };
}

/**
 * Computed from the stored orders and coupons on every call, rather than
 * from running counters, so it always reconciles with them and reading it
 * never changes anything. Orders still waiting for payment are not orders
 * yet, so they are not counted.
 */
export function buildReport(
  store: Store,
  config: Pick<Config, 'nthOrder' | 'discountPercent'>,
): Report {
  const orders = [...store.orders.values()];

  const itemsPurchased = [...store.products.values()].map((product) => {
    const lines = orders
      .flatMap((order) => order.lines)
      .filter((line) => line.productId === product.id);
    return {
      productId: product.id,
      name: product.name,
      quantity: lines.reduce((count, line) => count + line.quantity, 0),
      grossRevenueCents: sumCents(lines.map((line) => line.lineTotalCents)),
    };
  });

  const couponCounts: Record<CouponStatus, number> = { AVAILABLE: 0, RESERVED: 0, REDEEMED: 0 };
  for (const coupon of store.coupons.values()) {
    couponCounts[coupon.status]++;
  }

  const nextMilestone = (store.coupons.size + 1) * config.nthOrder;

  return {
    placedOrders: orders.length,
    itemsPurchased,
    totalItemsPurchased: itemsPurchased.reduce((count, item) => count + item.quantity, 0),
    grossRevenueCents: sumOrders(orders, 'subtotalCents'),
    totalDiscountCents: sumOrders(orders, 'discountCents'),
    netRevenueCents: sumOrders(orders, 'totalCents'),
    coupons: {
      generated: store.coupons.size,
      available: couponCounts.AVAILABLE,
      reserved: couponCounts.RESERVED,
      redeemed: couponCounts.REDEEMED,
    },
    milestones: {
      nthOrder: config.nthOrder,
      discountPercent: config.discountPercent,
      nextMilestone,
      couponAvailableToGenerate: orders.length >= nextMilestone,
    },
  };
}

function sumOrders(
  orders: Order[],
  field: 'subtotalCents' | 'discountCents' | 'totalCents',
): Cents {
  return sumCents(orders.map((order) => order[field]));
}
