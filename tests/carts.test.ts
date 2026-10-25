import { describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers';

describe('products', () => {
  it('lists seeded products with available quantity', async () => {
    const { api } = buildTestApp();
    const res = await api.get('/products').expect(200);

    expect(res.body.items.length).toBeGreaterThanOrEqual(5);
    expect(res.body.items).toContainEqual({
      id: 'p_sneakers',
      name: 'Limited Edition Sneakers',
      priceCents: 12999,
      availableQuantity: 2,
    });
  });
});

describe('carts', () => {
  it('creates an empty open cart', async () => {
    const { api } = buildTestApp();
    const res = await api.post('/carts').expect(201);

    expect(res.body).toMatchObject({
      status: 'OPEN',
      orderId: null,
      items: [],
      itemCount: 0,
      subtotalCents: 0,
    });
  });

  it('adds, updates and removes items with correct totals', async () => {
    const { api, createCart } = buildTestApp();
    const cartId = await createCart();

    await api.put(`/carts/${cartId}/items/p_tshirt`).send({ quantity: 2 }).expect(200);
    let res = await api.put(`/carts/${cartId}/items/p_mug`).send({ quantity: 1 }).expect(200);
    expect(res.body.subtotalCents).toBe(2 * 1999 + 1250);
    expect(res.body.itemCount).toBe(3);

    res = await api.put(`/carts/${cartId}/items/p_tshirt`).send({ quantity: 5 }).expect(200);
    expect(res.body.items[0]).toMatchObject({
      productId: 'p_tshirt',
      quantity: 5,
      lineTotalCents: 5 * 1999,
    });

    res = await api.delete(`/carts/${cartId}/items/p_tshirt`).expect(200);
    expect(res.body.items.map((item: { productId: string }) => item.productId)).toEqual(['p_mug']);
    expect(res.body.subtotalCents).toBe(1250);
  });

  it('treats repeated quantity updates and removals as harmless retries', async () => {
    const { api, createCart } = buildTestApp();
    const cartId = await createCart();

    for (let attempt = 0; attempt < 3; attempt++) {
      await api.put(`/carts/${cartId}/items/p_cap`).send({ quantity: 2 }).expect(200);
    }
    let res = await api.get(`/carts/${cartId}`).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].quantity).toBe(2);

    await api.delete(`/carts/${cartId}/items/p_cap`).expect(200);
    res = await api.delete(`/carts/${cartId}/items/p_cap`).expect(200);
    expect(res.body.items).toEqual([]);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['a string', '2'],
    ['null', null],
    ['above the per-line limit', 1001],
  ])('rejects a quantity that is %s', async (_label, quantity) => {
    const { api, createCart } = buildTestApp();
    const cartId = await createCart();

    const res = await api
      .put(`/carts/${cartId}/items/p_mug`)
      .send({ quantity })
      .expect(422);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details[0].field).toBe('quantity');
    expect((await api.get(`/carts/${cartId}`)).body.items).toEqual([]);
  });

  it('rejects a missing body', async () => {
    const { api, createCart } = buildTestApp();
    const cartId = await createCart();

    const res = await api.put(`/carts/${cartId}/items/p_mug`).expect(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects malformed JSON', async () => {
    const { api, createCart } = buildTestApp();
    const cartId = await createCart();

    const res = await api
      .put(`/carts/${cartId}/items/p_mug`)
      .set('Content-Type', 'application/json')
      .send('{"quantity": ')
      .expect(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('rejects an unknown product without changing the cart', async () => {
    const { api, createCart } = buildTestApp();
    const cartId = await createCart();

    const res = await api
      .put(`/carts/${cartId}/items/p_unicorn`)
      .send({ quantity: 1 })
      .expect(404);
    expect(res.body.error).toMatchObject({
      code: 'PRODUCT_NOT_FOUND',
      details: { productId: 'p_unicorn' },
    });
    expect((await api.get(`/carts/${cartId}`)).body.items).toEqual([]);
  });

  it('rejects more units than are in stock', async () => {
    const { api, createCart } = buildTestApp();
    const cartId = await createCart();

    const res = await api
      .put(`/carts/${cartId}/items/p_sneakers`)
      .send({ quantity: 3 })
      .expect(409);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_INVENTORY',
      details: { items: [{ productId: 'p_sneakers', requested: 3, available: 2 }] },
    });
  });

  it('returns 404 for an unknown cart', async () => {
    const { api } = buildTestApp();

    const res = await api.get('/carts/cart_missing').expect(404);
    expect(res.body.error.code).toBe('CART_NOT_FOUND');
    await api.put('/carts/cart_missing/items/p_mug').send({ quantity: 1 }).expect(404);
    await api.delete('/carts/cart_missing/items/p_mug').expect(404);
  });

  it('returns a structured 404 for unknown routes', async () => {
    const { api } = buildTestApp();

    const res = await api.get('/nope').expect(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});
