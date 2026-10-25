import { describe, expect, it } from 'vitest';
import { FakePaymentGateway } from '../src/payment';
import { ControlledPaymentGateway, buildTestApp, product } from './helpers';

describe('checkout', () => {
  it('places an order that records exactly what was bought', async () => {
    const { api, store, payment, cartWith } = buildTestApp();
    const cartId = await cartWith({ p_tshirt: 2, p_mug: 1 });

    const res = await api.post(`/carts/${cartId}/checkout`).send({}).expect(201);

    expect(res.body).toMatchObject({
      number: 1,
      cartId,
      lines: [
        { productId: 'p_tshirt', name: 'Cotton T-Shirt', unitPriceCents: 1999, quantity: 2, lineTotalCents: 3998 },
        { productId: 'p_mug', name: 'Ceramic Mug', unitPriceCents: 1250, quantity: 1, lineTotalCents: 1250 },
      ],
      subtotalCents: 5248,
      discountPercent: null,
      discountCents: 0,
      totalCents: 5248,
      couponCode: null,
    });
    expect(res.body.paymentId).toMatch(/^pay_/);
    expect((payment as FakePaymentGateway).charges).toEqual([{ amountCents: 5248, reference: cartId }]);

    expect(store.products.get('p_tshirt')).toMatchObject({ stock: 98, reserved: 0 });
    expect(store.products.get('p_mug')).toMatchObject({ stock: 49, reserved: 0 });

    const cart = await api.get(`/carts/${cartId}`).expect(200);
    expect(cart.body).toMatchObject({ status: 'CHECKED_OUT', orderId: res.body.id });

    const order = await api.get(`/orders/${res.body.id}`).expect(200);
    expect(order.body).toEqual(res.body);
  });

  it('keeps the order unchanged when the product changes afterwards', async () => {
    const { api, store, cartWith } = buildTestApp();
    const cartId = await cartWith({ p_cap: 1 });
    const placed = await api.post(`/carts/${cartId}/checkout`).send({}).expect(201);

    const cap = store.products.get('p_cap')!;
    cap.priceCents = 9999;
    cap.name = 'Renamed Cap';

    const order = await api.get(`/orders/${placed.body.id}`).expect(200);
    expect(order.body.lines[0]).toMatchObject({ name: 'Baseball Cap', unitPriceCents: 1599 });
    expect(order.body.totalCents).toBe(1599);
  });

  it('charges the current price if it changed after the item was added', async () => {
    const { api, store, cartWith } = buildTestApp();
    const cartId = await cartWith({ p_mug: 2 });
    store.products.get('p_mug')!.priceCents = 1500;

    const res = await api.post(`/carts/${cartId}/checkout`).send({}).expect(201);
    expect(res.body.totalCents).toBe(3000);
  });

  it('refuses to charge a total the client did not expect', async () => {
    const { api, store, cartWith } = buildTestApp();
    const cartId = await cartWith({ p_mug: 2 });
    store.products.get('p_mug')!.priceCents = 1500;

    const res = await api
      .post(`/carts/${cartId}/checkout`)
      .send({ expectedTotalCents: 2500 })
      .expect(409);

    expect(res.body.error).toMatchObject({
      code: 'TOTAL_MISMATCH',
      details: { expectedTotalCents: 2500, totalCents: 3000 },
    });
    expect(store.products.get('p_mug')).toMatchObject({ stock: 50, reserved: 0 });
    expect((await api.get(`/carts/${cartId}`)).body.status).toBe('OPEN');

    await api.post(`/carts/${cartId}/checkout`).send({ expectedTotalCents: 3000 }).expect(201);
  });

  it('rejects an empty cart', async () => {
    const { api, createCart } = buildTestApp();
    const cartId = await createCart();

    const res = await api.post(`/carts/${cartId}/checkout`).send({}).expect(422);
    expect(res.body.error.code).toBe('CART_EMPTY');
  });

  it('rejects an unknown cart and an unknown order', async () => {
    const { api } = buildTestApp();

    const checkout = await api.post('/carts/cart_missing/checkout').send({}).expect(404);
    expect(checkout.body.error.code).toBe('CART_NOT_FOUND');
    const order = await api.get('/orders/ord_missing').expect(404);
    expect(order.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it.each([
    ['a negative expected total', { expectedTotalCents: -1 }],
    ['a fractional expected total', { expectedTotalCents: 10.5 }],
    ['a misspelled field', { expectedTotal: 100 }],
  ])('rejects %s', async (_label, body) => {
    const { api, cartWith } = buildTestApp();
    const cartId = await cartWith({ p_mug: 1 });

    const res = await api.post(`/carts/${cartId}/checkout`).send(body).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('does not check out the same cart twice', async () => {
    const { api, store, cartWith } = buildTestApp();
    const cartId = await cartWith({ p_hoodie: 1 });
    const first = await api.post(`/carts/${cartId}/checkout`).send({}).expect(201);

    const second = await api.post(`/carts/${cartId}/checkout`).send({}).expect(409);
    expect(second.body.error).toMatchObject({
      code: 'CART_ALREADY_CHECKED_OUT',
      details: { orderId: first.body.id },
    });
    expect(store.orders.size).toBe(1);
    expect(store.products.get('p_hoodie')!.stock).toBe(24);
  });

  it('rejects checkout when stock ran out after the item was added', async () => {
    const { api, store, cartWith } = buildTestApp();
    const first = await cartWith({ p_sneakers: 2 });
    const second = await cartWith({ p_sneakers: 2, p_mug: 1 });

    await api.post(`/carts/${first}/checkout`).send({}).expect(201);
    const res = await api.post(`/carts/${second}/checkout`).send({}).expect(409);

    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_INVENTORY',
      details: { items: [{ productId: 'p_sneakers', requested: 2, available: 0 }] },
    });
    // Nothing from the failed checkout is held, and the cart can be fixed.
    expect(store.products.get('p_mug')).toMatchObject({ stock: 50, reserved: 0 });
    await api.delete(`/carts/${second}/items/p_sneakers`).expect(200);
    await api.post(`/carts/${second}/checkout`).send({}).expect(201);
  });

  it('releases stock and reopens the cart when payment is declined', async () => {
    const payment = new FakePaymentGateway(5);
    const { api, store, cartWith } = buildTestApp({ payment });
    const cartId = await cartWith({ p_sneakers: 2 });

    payment.declineNext();
    const res = await api.post(`/carts/${cartId}/checkout`).send({}).expect(402);

    expect(res.body.error.code).toBe('PAYMENT_DECLINED');
    expect(store.products.get('p_sneakers')).toMatchObject({ stock: 2, reserved: 0 });
    expect(store.orders.size).toBe(0);
    expect((await api.get(`/carts/${cartId}`)).body.status).toBe('OPEN');

    const retry = await api.post(`/carts/${cartId}/checkout`).send({}).expect(201);
    expect(retry.body.number).toBe(1);
    expect(store.products.get('p_sneakers')).toMatchObject({ stock: 0, reserved: 0 });
  });

  it('locks the cart while payment is pending', async () => {
    const payment = new ControlledPaymentGateway();
    const { api, cartWith } = buildTestApp({ payment });
    const cartId = await cartWith({ p_mug: 1 });

    const first = api.post(`/carts/${cartId}/checkout`).send({}).then((res) => res);
    await payment.waitForCharges(1);

    const edit = await api.put(`/carts/${cartId}/items/p_mug`).send({ quantity: 5 }).expect(409);
    expect(edit.body.error.code).toBe('CART_NOT_OPEN');
    const again = await api.post(`/carts/${cartId}/checkout`).send({}).expect(409);
    expect(again.body.error.code).toBe('CHECKOUT_IN_PROGRESS');

    payment.approve();
    const res = await first;
    expect(res.status).toBe(201);
    expect(res.body.lines[0].quantity).toBe(1);
  });

  it('skips the payment provider when the total is zero', async () => {
    const payment = new ControlledPaymentGateway();
    const { api, cartWith } = buildTestApp({ payment, products: [product('p_free', 0, 10)] });
    const cartId = await cartWith({ p_free: 3 });

    const res = await api.post(`/carts/${cartId}/checkout`).send({}).expect(201);
    expect(res.body).toMatchObject({ totalCents: 0, paymentId: null });
    expect(payment.pendingCount).toBe(0);
  });
});

describe('concurrent checkouts', () => {
  it('never sells more units than are in stock', async () => {
    const payment = new ControlledPaymentGateway();
    const { api, store, cartWith } = buildTestApp({
      payment,
      products: [product('p_scarce', 1000, 3)],
    });
    const carts = await Promise.all(Array.from({ length: 10 }, () => cartWith({ p_scarce: 1 })));

    const responses = Promise.all(
      carts.map((cartId) => api.post(`/carts/${cartId}/checkout`).send({}).then((res) => res)),
    );

    // While three payments are still pending, those units are held and no
    // other checkout can claim them.
    await payment.waitForCharges(3);
    expect(store.products.get('p_scarce')).toMatchObject({ stock: 3, reserved: 3 });
    for (let i = 0; i < 3; i++) payment.approve();

    const statuses = (await responses).map((res) => res.status).sort();
    expect(statuses).toEqual([201, 201, 201, 409, 409, 409, 409, 409, 409, 409]);
    expect(store.products.get('p_scarce')).toMatchObject({ stock: 0, reserved: 0 });
    expect(store.orders.size).toBe(3);
  });

  it('keeps stock consistent with orders under a random mix of quantities and declines', async () => {
    const payment = new FakePaymentGateway(10);
    const { api, store, cartWith } = buildTestApp({
      payment,
      products: [product('p_a', 500, 7), product('p_b', 300, 5)],
    });
    const orders: Record<string, number>[] = [
      { p_a: 2 },
      { p_a: 3, p_b: 1 },
      { p_b: 2 },
      { p_a: 1, p_b: 2 },
      { p_a: 2, p_b: 2 },
      { p_a: 1 },
      { p_b: 1 },
      { p_a: 3 },
    ];
    const carts = await Promise.all(orders.map((items) => cartWith(items)));
    payment.declineNext(2);

    const responses = await Promise.all(
      carts.map((cartId) => api.post(`/carts/${cartId}/checkout`).send({})),
    );

    expect(responses.every((res) => [201, 402, 409].includes(res.status))).toBe(true);
    for (const id of ['p_a', 'p_b']) {
      const sold = [...store.orders.values()]
        .flatMap((order) => order.lines)
        .filter((line) => line.productId === id)
        .reduce((sum, line) => sum + line.quantity, 0);
      const productState = store.products.get(id)!;
      const initial = id === 'p_a' ? 7 : 5;

      expect(productState.reserved).toBe(0);
      expect(productState.stock).toBe(initial - sold);
      expect(productState.stock).toBeGreaterThanOrEqual(0);
    }
    expect(store.orders.size).toBe(responses.filter((res) => res.status === 201).length);
  });
});
