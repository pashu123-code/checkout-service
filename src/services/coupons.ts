import { randomInt } from 'node:crypto';
import type { Config } from '../config';
import { conflict, unprocessable } from '../errors';
import type { Coupon, Store } from '../store';

// No 0/O or 1/I/L, so codes survive being read aloud or retyped.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Codes are matched case-insensitively and ignoring surrounding spaces. */
export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Issues one coupon for the oldest milestone that has none yet. Milestones
 * are order counts n, 2n, 3n, ...; every successfully placed order counts,
 * including ones that used a coupon.
 *
 * Because coupons are always issued oldest-first and never deleted, the next
 * milestone is simply (coupons issued + 1) × n. That makes "at most one
 * coupon per milestone" true by construction.
 */
export function generateCoupon(store: Store, config: Pick<Config, 'nthOrder' | 'discountPercent'>): Coupon {
  const placedOrders = store.orders.size;
  const milestone = (store.coupons.size + 1) * config.nthOrder;

  if (placedOrders < milestone) {
    throw conflict('NO_ELIGIBLE_MILESTONE', 'No order milestone is waiting for a coupon.', {
      placedOrders,
      nextMilestone: milestone,
      ordersUntilNextMilestone: milestone - placedOrders,
    });
  }

  const coupon: Coupon = {
    code: uniqueCode(store, config.discountPercent),
    percent: config.discountPercent,
    milestone,
    status: 'AVAILABLE',
    reservedByCartId: null,
    redeemedByOrderId: null,
    createdAt: new Date().toISOString(),
    redeemedAt: null,
  };
  store.coupons.set(coupon.code, coupon);
  return coupon;
}

export function listCoupons(store: Store): Coupon[] {
  return [...store.coupons.values()];
}

/** Returns the coupon if this checkout may use it right now, otherwise throws. */
export function getRedeemableCoupon(store: Store, rawCode: string): Coupon {
  const code = normalizeCouponCode(rawCode);
  const coupon = store.coupons.get(code);

  if (!coupon) {
    throw unprocessable('COUPON_NOT_FOUND', 'This coupon code does not exist.', { code });
  }
  if (coupon.status === 'REDEEMED') {
    throw conflict('COUPON_ALREADY_REDEEMED', 'This coupon has already been used.', { code });
  }
  if (coupon.status === 'RESERVED') {
    // Another checkout holds it while its payment is pending. If that payment
    // fails the coupon becomes available again, so this is worth retrying.
    throw conflict('COUPON_IN_USE', 'This coupon is being used by another checkout.', { code });
  }
  return coupon;
}

function uniqueCode(store: Store, percent: number): string {
  for (;;) {
    let suffix = '';
    for (let i = 0; i < 8; i++) {
      suffix += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    const code = `SAVE${percent}-${suffix}`;
    if (!store.coupons.has(code)) return code;
  }
}
