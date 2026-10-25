import { describe, expect, it } from 'vitest';
import { FakePaymentGateway } from '../src/payment';
import { ControlledPaymentGateway, buildTestApp, product } from './helpers';

describe('admin report', () => {
  it('starts at zero with every product listed', async () => {
    const { api } = buildTestApp();
    const res = await api.get('/admin/report').expect(200);

    expect(res.body).toMatchObject({
      placedOrders: 0,
      totalItemsPurchased: 0,
      grossRevenueCents: 0,
      totalDiscountCents: 0,
      netRevenueCents: 0,
      coupons: { generated: 0, available: 0, reserved: 0, redeemed: 0 },
      milestones: { nthOrder: 3, discountPercent: 10, nextMilestone: 3, couponAvailableToGenerate: false },
    });
    expect(res.body.itemsPurchased).toHaveLength(6);
    expect(res.body.itemsPurchased.every((item: { quantity: number }) => item.quantity === 0)).toBe(true);
  });

  it('reconciles with the orders and coupons the API returns', async () => {
    const payment = new FakePaymentGateway(5);
    const { api, cartWith, checkout } = buildTestApp({ payment });
    const generate = () => api.post('/admin/coupons').send();

    // Three plain orders unlock a coupon; one checkout fails on payment and
    // one on stock, and neither may show up in the report.
    await checkout(await cartWith({ p_tshirt: 2, p_mug: 1 })).expect(201);
    await checkout(await cartWith({ p_sneakers: 1 })).expect(201);
    payment.declineNext();
    await checkout(await cartWith({ p_hoodie: 3 })).expect(402);
    await checkout(await cartWith({ p_cap: 1, p_stickers: 4 })).expect(201);
    const firstCoupon = (await generate().expect(201)).body.code;

    await checkout(await cartWith({ p_hoodie: 1, p_sneakers: 1 }), { couponCode: firstCoupon }).expect(201);
    const soldOut = await cartWith({ p_mug: 1 });
    await api.patch('/admin/products/p_mug').send({ stock: 0 }).expect(200);
    await checkout(soldOut).expect(409);
    await api.patch('/admin/products/p_mug').send({ stock: 10 }).expect(200);
    await checkout(await cartWith({ p_mug: 3 })).expect(201);
    await checkout(await cartWith({ p_stickers: 1 })).expect(201);
    await generate().expect(201); // milestone 6, left unused

    const report = (await api.get('/admin/report').expect(200)).body;
    const orders = (await api.get('/admin/orders').expect(200)).body.items;
    const coupons = (await api.get('/admin/coupons').expect(200)).body.items;
    const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

    expect(report.placedOrders).toBe(orders.length);
    expect(report.placedOrders).toBe(6);
    expect(report.grossRevenueCents).toBe(sum(orders.map((o: { subtotalCents: number }) => o.subtotalCents)));
    expect(report.totalDiscountCents).toBe(sum(orders.map((o: { discountCents: number }) => o.discountCents)));
    expect(report.netRevenueCents).toBe(sum(orders.map((o: { totalCents: number }) => o.totalCents)));
    expect(report.netRevenueCents).toBe(report.grossRevenueCents - report.totalDiscountCents);
    expect(report.totalDiscountCents).toBe(Math.floor((4999 + 12999) / 10));

    const lines = orders.flatMap((o: { lines: { productId: string; quantity: number }[] }) => o.lines);
    for (const item of report.itemsPurchased) {
      const bought = lines.filter((line: { productId: string }) => line.productId === item.productId);
      expect(item.quantity).toBe(sum(bought.map((line: { quantity: number }) => line.quantity)));
    }
    expect(report.itemsPurchased.find((i: { productId: string }) => i.productId === 'p_hoodie').quantity).toBe(1);
    expect(sum(report.itemsPurchased.map((i: { grossRevenueCents: number }) => i.grossRevenueCents))).toBe(
      report.grossRevenueCents,
    );

    expect(report.coupons).toEqual({ generated: 2, available: 1, reserved: 0, redeemed: 1 });
    expect(coupons.filter((c: { status: string }) => c.status === 'REDEEMED')).toHaveLength(1);
    expect(orders.filter((o: { couponCode: string | null }) => o.couponCode !== null)).toHaveLength(1);
    expect(report.milestones).toMatchObject({ nextMilestone: 9, couponAvailableToGenerate: false });
  });

  it('flags a coupon as ready to generate exactly at the milestone', async () => {
    const { api, cartWith, checkout } = buildTestApp();
    const flag = async () =>
      (await api.get('/admin/report').expect(200)).body.milestones.couponAvailableToGenerate;

    for (let i = 0; i < 2; i++) await checkout(await cartWith({ p_mug: 1 })).expect(201);
    expect(await flag()).toBe(false);

    await checkout(await cartWith({ p_mug: 1 })).expect(201);
    expect(await flag()).toBe(true);

    await api.post('/admin/coupons').send().expect(201);
    expect(await flag()).toBe(false);
  });

  it('returns the same answer every time and changes nothing', async () => {
    const { api, store, cartWith, checkout } = buildTestApp();
    await checkout(await cartWith({ p_tshirt: 1 })).expect(201);
    const before = JSON.stringify({
      products: [...store.products.values()],
      orders: [...store.orders.values()],
      coupons: [...store.coupons.values()],
    });

    const reports = await Promise.all(Array.from({ length: 5 }, () => api.get('/admin/report')));

    expect(new Set(reports.map((res) => JSON.stringify(res.body))).size).toBe(1);
    const after = JSON.stringify({
      products: [...store.products.values()],
      orders: [...store.orders.values()],
      coupons: [...store.coupons.values()],
    });
    expect(after).toBe(before);
  });

  it('does not count a checkout that is still waiting for payment', async () => {
    const payment = new ControlledPaymentGateway();
    const { api, cartWith, checkout } = buildTestApp({ payment });

    const pending = checkout(await cartWith({ p_mug: 2 })).then((res) => res);
    await payment.waitForCharges(1);

    let report = (await api.get('/admin/report').expect(200)).body;
    expect(report.placedOrders).toBe(0);
    expect(report.grossRevenueCents).toBe(0);

    payment.approve();
    expect((await pending).status).toBe(201);
    report = (await api.get('/admin/report').expect(200)).body;
    expect(report).toMatchObject({ placedOrders: 1, grossRevenueCents: 2500 });
  });

  it('shows a coupon as reserved while its checkout is paying', async () => {
    const payment = new ControlledPaymentGateway();
    const { api, cartWith, checkout } = buildTestApp({ payment, config: { nthOrder: 1 } });

    const first = checkout(await cartWith({ p_mug: 1 })).then((res) => res);
    await payment.waitForCharges(1);
    payment.approve();
    await first;
    const { code } = (await api.post('/admin/coupons').send().expect(201)).body;

    const discounted = checkout(await cartWith({ p_mug: 1 }), { couponCode: code }).then((res) => res);
    await payment.waitForCharges(1);
    const report = (await api.get('/admin/report').expect(200)).body;
    expect(report.coupons).toEqual({ generated: 1, available: 0, reserved: 1, redeemed: 0 });

    payment.decline();
    expect((await discounted).status).toBe(402);
    const after = (await api.get('/admin/report').expect(200)).body;
    expect(after.coupons).toEqual({ generated: 1, available: 1, reserved: 0, redeemed: 0 });
  });
});

describe('admin product updates', () => {
  it('changes price for carts but not for existing orders', async () => {
    const { api, cartWith, checkout } = buildTestApp();
    const order = (await checkout(await cartWith({ p_cap: 1 })).expect(201)).body;
    const cartId = await cartWith({ p_cap: 1 });

    const res = await api.patch('/admin/products/p_cap').send({ priceCents: 2500, name: 'Wool Cap' }).expect(200);
    expect(res.body).toMatchObject({ id: 'p_cap', name: 'Wool Cap', priceCents: 2500, stock: 39, reserved: 0 });

    expect((await api.get(`/carts/${cartId}`)).body.subtotalCents).toBe(2500);
    const stored = (await api.get(`/orders/${order.id}`)).body;
    expect(stored.lines[0]).toMatchObject({ name: 'Baseball Cap', unitPriceCents: 1599 });
  });

  it('restocks a sold-out product', async () => {
    const { api, cartWith, checkout } = buildTestApp();
    await checkout(await cartWith({ p_sneakers: 2 })).expect(201);
    await api.put(`/carts/${await cartWith({})}/items/p_sneakers`).send({ quantity: 1 }).expect(409);

    await api.patch('/admin/products/p_sneakers').send({ stock: 5 }).expect(200);
    await checkout(await cartWith({ p_sneakers: 5 })).expect(201);
  });

  it('will not cut stock below what pending checkouts hold', async () => {
    const payment = new ControlledPaymentGateway();
    const { api, cartWith, checkout } = buildTestApp({ payment, products: [product('p_x', 100, 5)] });

    const pending = checkout(await cartWith({ p_x: 3 })).then((res) => res);
    await payment.waitForCharges(1);

    const res = await api.patch('/admin/products/p_x').send({ stock: 2 }).expect(409);
    expect(res.body.error).toMatchObject({
      code: 'STOCK_BELOW_RESERVED',
      details: { reserved: 3, requestedStock: 2 },
    });
    await api.patch('/admin/products/p_x').send({ stock: 3 }).expect(200);

    payment.approve();
    expect((await pending).status).toBe(201);
    const products = (await api.get('/products')).body.items;
    expect(products[0]).toMatchObject({ id: 'p_x', availableQuantity: 0 });
  });

  it('keeps the reserved price if the price changes during payment', async () => {
    const payment = new ControlledPaymentGateway();
    const { api, cartWith, checkout } = buildTestApp({ payment });

    const pending = checkout(await cartWith({ p_mug: 2 })).then((res) => res);
    await payment.waitForCharges(1);
    await api.patch('/admin/products/p_mug').send({ priceCents: 9999 }).expect(200);
    payment.approve();

    const order = (await pending).body;
    expect(order.totalCents).toBe(2500);
    expect(order.lines[0].unitPriceCents).toBe(1250);
  });

  it.each([
    ['an empty update', {}],
    ['a negative price', { priceCents: -1 }],
    ['a fractional price', { priceCents: 9.99 }],
    ['a price above the cap', { priceCents: 100_000_001 }],
    ['negative stock', { stock: -1 }],
    ['an unknown field', { discount: 5 }],
  ])('rejects %s', async (_label, body) => {
    const { api } = buildTestApp();
    const res = await api.patch('/admin/products/p_mug').send(body).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns 404 for an unknown product', async () => {
    const { api } = buildTestApp();
    const res = await api.patch('/admin/products/p_nope').send({ stock: 1 }).expect(404);
    expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
  });
});
