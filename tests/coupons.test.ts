import { describe, expect, it } from 'vitest';
import { FakePaymentGateway } from '../src/payment';
import { ControlledPaymentGateway, type TestAppOptions, buildTestApp } from './helpers';

/** Test app (n = 3, x = 10 by default) plus a helper that places plain orders. */
function couponApp(options: TestAppOptions = {}) {
  const app = buildTestApp(options);
  return {
    ...app,
    async placeOrders(count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        const cartId = await app.cartWith({ p_stickers: 1 });
        await app.checkout(cartId).expect(201);
      }
    },
    async generate() {
      return app.api.post('/admin/coupons').send();
    },
  };
}

describe('coupon generation', () => {
  it('refuses before the first milestone and says how far away it is', async () => {
    const { placeOrders, generate } = couponApp();
    await placeOrders(2);

    const res = await generate();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'NO_ELIGIBLE_MILESTONE',
      details: { placedOrders: 2, nextMilestone: 3, ordersUntilNextMilestone: 1 },
    });
  });

  it('issues exactly one coupon per milestone', async () => {
    const { placeOrders, generate } = couponApp();
    await placeOrders(3);

    const first = await generate();
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      percent: 10,
      milestone: 3,
      status: 'AVAILABLE',
      reservedByCartId: null,
      redeemedByOrderId: null,
    });
    expect(first.body.code).toMatch(/^SAVE10-[A-Z2-9]{8}$/);

    const second = await generate();
    expect(second.status).toBe(409);
    expect(second.body.error.details).toMatchObject({ placedOrders: 3, nextMilestone: 6 });
  });

  it('catches up on skipped milestones, oldest first, one per request', async () => {
    const { store, placeOrders, generate } = couponApp();
    await placeOrders(7);

    expect((await generate()).body.milestone).toBe(3);
    expect((await generate()).body.milestone).toBe(6);
    expect((await generate()).status).toBe(409);
    expect(store.coupons.size).toBe(2);
  });

  it('issues only one coupon when admins request it at the same time', async () => {
    const { store, placeOrders, generate } = couponApp();
    await placeOrders(3);

    const responses = await Promise.all(Array.from({ length: 6 }, () => generate()));

    expect(responses.map((res) => res.status).sort()).toEqual([201, 409, 409, 409, 409, 409]);
    expect(store.coupons.size).toBe(1);
  });

  it('does not count failed checkouts toward a milestone', async () => {
    const payment = new FakePaymentGateway(5);
    const { placeOrders, generate, cartWith, checkout } = couponApp({ payment });
    await placeOrders(2);

    payment.declineNext();
    await checkout(await cartWith({ p_mug: 1 })).expect(402);
    await checkout(await cartWith({ p_mug: 1 }), { expectedTotalCents: 1 }).expect(409);

    expect((await generate()).status).toBe(409);
    await placeOrders(1);
    expect((await generate()).status).toBe(201);
  });

  it('lists generated coupons for administrators', async () => {
    const { api, placeOrders, generate } = couponApp();
    await placeOrders(3);
    const coupon = (await generate()).body;

    const res = await api.get('/admin/coupons').expect(200);
    expect(res.body.items).toEqual([coupon]);
  });
});

describe('coupon redemption', () => {
  it('applies the discount and marks the coupon redeemed by that order', async () => {
    const { api, placeOrders, generate, cartWith, checkout } = couponApp();
    await placeOrders(3);
    const { code } = (await generate()).body;
    const cartId = await cartWith({ p_hoodie: 1, p_tshirt: 1 }); // 4999 + 1999 = 6998

    const res = await checkout(cartId, { couponCode: code }).expect(201);
    expect(res.body).toMatchObject({
      subtotalCents: 6998,
      discountPercent: 10,
      discountCents: 699, // 699.8 rounded down
      totalCents: 6299,
      couponCode: code,
    });

    const coupons = await api.get('/admin/coupons').expect(200);
    expect(coupons.body.items[0]).toMatchObject({
      status: 'REDEEMED',
      redeemedByOrderId: res.body.id,
      reservedByCartId: null,
    });
  });

  it('accepts the code in any case and with surrounding spaces', async () => {
    const { placeOrders, generate, cartWith, checkout } = couponApp();
    await placeOrders(3);
    const { code } = (await generate()).body;

    const res = await checkout(await cartWith({ p_mug: 1 }), {
      couponCode: `  ${code.toLowerCase()} `,
    }).expect(201);
    expect(res.body.couponCode).toBe(code);
  });

  it('rejects an unknown code without holding anything', async () => {
    const { store, cartWith, checkout } = couponApp();
    const cartId = await cartWith({ p_mug: 1 });

    const res = await checkout(cartId, { couponCode: 'SAVE10-NOPE' }).expect(422);
    expect(res.body.error).toMatchObject({ code: 'COUPON_NOT_FOUND' });
    expect(store.products.get('p_mug')).toMatchObject({ reserved: 0 });
    await checkout(cartId).expect(201);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['not a string', 123],
  ])('rejects a coupon code that is %s', async (_label, couponCode) => {
    const { cartWith, checkout } = couponApp();
    const res = await checkout(await cartWith({ p_mug: 1 }), { couponCode }).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a coupon that was already redeemed', async () => {
    const { placeOrders, generate, cartWith, checkout } = couponApp();
    await placeOrders(3);
    const { code } = (await generate()).body;
    await checkout(await cartWith({ p_mug: 1 }), { couponCode: code }).expect(201);

    const res = await checkout(await cartWith({ p_mug: 1 }), { couponCode: code }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'COUPON_ALREADY_REDEEMED', details: { code } });
  });

  it('replays a discounted order on retry instead of reporting the coupon as used', async () => {
    const { store, placeOrders, generate, cartWith, checkout } = couponApp();
    await placeOrders(3);
    const { code } = (await generate()).body;
    const cartId = await cartWith({ p_cap: 2 });

    const first = await checkout(cartId, { couponCode: code }, 'coupon-retry').expect(201);
    const retry = await checkout(cartId, { couponCode: code }, 'coupon-retry').expect(201);

    expect(retry.body).toEqual(first.body);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(store.coupons.get(code)!.redeemedByOrderId).toBe(first.body.id);
  });

  it('treats adding a coupon on retry as a different request', async () => {
    const { placeOrders, generate, cartWith, checkout } = couponApp();
    await placeOrders(3);
    const { code } = (await generate()).body;
    const cartId = await cartWith({ p_mug: 1 });

    await checkout(cartId, {}, 'same-key').expect(201);
    const res = await checkout(cartId, { couponCode: code }, 'same-key').expect(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('gives the coupon back when payment is declined', async () => {
    const payment = new FakePaymentGateway(5);
    const { store, placeOrders, generate, cartWith, checkout } = couponApp({ payment });
    await placeOrders(3);
    const { code } = (await generate()).body;
    const cartId = await cartWith({ p_mug: 1 });

    payment.declineNext();
    await checkout(cartId, { couponCode: code }).expect(402);
    expect(store.coupons.get(code)).toMatchObject({ status: 'AVAILABLE', reservedByCartId: null });

    const res = await checkout(cartId, { couponCode: code }).expect(201);
    expect(res.body.couponCode).toBe(code);
  });

  it('does not use up the coupon when checkout fails for another reason', async () => {
    const { store, placeOrders, generate, cartWith, checkout } = couponApp();
    await placeOrders(3);
    const { code } = (await generate()).body;
    const first = await cartWith({ p_sneakers: 2 });
    const second = await cartWith({ p_sneakers: 2 });
    await checkout(first).expect(201);

    await checkout(second, { couponCode: code }).expect(409); // sneakers sold out
    await checkout(second, { couponCode: code, expectedTotalCents: 1 }).expect(409);

    expect(store.coupons.get(code)).toMatchObject({ status: 'AVAILABLE', reservedByCartId: null });
  });

  it('can never bring a total below zero, even at 100%', async () => {
    const payment = new FakePaymentGateway(0);
    const { placeOrders, generate, cartWith, checkout } = couponApp({
      payment,
      config: { discountPercent: 100 },
    });
    await placeOrders(3);
    const { code } = (await generate()).body;

    const res = await checkout(await cartWith({ p_hoodie: 1 }), { couponCode: code }).expect(201);
    expect(res.body).toMatchObject({ subtotalCents: 4999, discountCents: 4999, totalCents: 0, paymentId: null });
    // Only the three setup orders were charged; the free order skipped payment.
    expect(payment.charges).toHaveLength(3);
  });
});

describe('concurrent coupon use', () => {
  it('lets only one of two simultaneous checkouts use a coupon', async () => {
    const payment = new ControlledPaymentGateway();
    const { store, generate, cartWith, checkout } = couponApp({ payment });

    // Reach the milestone, approving each payment as it arrives.
    for (let i = 0; i < 3; i++) {
      const pending = checkout(await cartWith({ p_stickers: 1 })).then((res) => res);
      await payment.waitForCharges(1);
      payment.approve();
      expect((await pending).status).toBe(201);
    }
    const { code } = (await generate()).body;
    const cartA = await cartWith({ p_mug: 1 });
    const cartB = await cartWith({ p_cap: 1 });

    const first = checkout(cartA, { couponCode: code }).then((res) => res);
    await payment.waitForCharges(1);
    expect(store.coupons.get(code)).toMatchObject({ status: 'RESERVED', reservedByCartId: cartA });

    const second = await checkout(cartB, { couponCode: code }).expect(409);
    expect(second.body.error.code).toBe('COUPON_IN_USE');

    payment.approve();
    expect((await first).status).toBe(201);
    const late = await checkout(cartB, { couponCode: code }).expect(409);
    expect(late.body.error.code).toBe('COUPON_ALREADY_REDEEMED');
  });

  it('redeems a coupon exactly once across many simultaneous checkouts', async () => {
    const payment = new FakePaymentGateway(20);
    const { store, placeOrders, generate, cartWith, checkout } = couponApp({ payment });
    await placeOrders(3);
    const { code } = (await generate()).body;
    const carts = await Promise.all(Array.from({ length: 10 }, () => cartWith({ p_mug: 1 })));

    const responses = await Promise.all(carts.map((cartId) => checkout(cartId, { couponCode: code })));

    const succeeded = responses.filter((res) => res.status === 201);
    expect(succeeded).toHaveLength(1);
    expect(responses.filter((res) => res.status === 409).map((res) => res.body.error.code)).toEqual(
      Array(9).fill('COUPON_IN_USE'),
    );
    expect(store.coupons.get(code)).toMatchObject({
      status: 'REDEEMED',
      redeemedByOrderId: succeeded[0]!.body.id,
    });
    const ordersWithCoupon = [...store.orders.values()].filter((order) => order.couponCode === code);
    expect(ordersWithCoupon).toHaveLength(1);
  });
});
