import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors';
import { FakePaymentGateway } from '../src/payment';
import { type IdempotencyRecords, runIdempotent } from '../src/services/idempotency';
import { buildTestApp } from './helpers';

/** A promise the test settles by hand, so ordering is fully deterministic. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runIdempotent', () => {
  it('runs once for concurrent requests and gives all of them the result', async () => {
    const records: IdempotencyRecords<string> = new Map();
    const pending = deferred<string>();
    const operation = vi.fn(() => pending.promise);

    const first = runIdempotent(records, 'key-1', 'same', operation);
    const second = runIdempotent(records, 'key-1', 'same', operation);
    pending.resolve('order-1');

    expect(await first).toEqual({ value: 'order-1', replayed: false });
    expect(await second).toEqual({ value: 'order-1', replayed: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('replays a completed result without running again', async () => {
    const records: IdempotencyRecords<string> = new Map();
    const operation = vi.fn(async () => 'order-1');

    await runIdempotent(records, 'key-1', 'same', operation);
    const replay = await runIdempotent(records, 'key-1', 'same', operation);

    expect(replay).toEqual({ value: 'order-1', replayed: true });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight failure, then lets a later retry run again', async () => {
    const records: IdempotencyRecords<string> = new Map();
    const pending = deferred<string>();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce('order-2');

    const first = runIdempotent(records, 'key-1', 'same', operation);
    const joined = runIdempotent(records, 'key-1', 'same', operation);
    pending.reject(new Error('declined'));

    await expect(first).rejects.toThrow('declined');
    await expect(joined).rejects.toThrow('declined');
    expect(records.has('key-1')).toBe(false);

    const retry = await runIdempotent(records, 'key-1', 'same', operation);
    expect(retry).toEqual({ value: 'order-2', replayed: false });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('rejects a key reused for a different request, even while the first is running', async () => {
    const records: IdempotencyRecords<string> = new Map();
    const pending = deferred<string>();
    const first = runIdempotent(records, 'key-1', 'cart-A', () => pending.promise);

    const reused = runIdempotent(records, 'key-1', 'cart-B', async () => 'never');
    await expect(reused).rejects.toBeInstanceOf(AppError);
    await expect(reused).rejects.toMatchObject({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });

    pending.resolve('order-1');
    expect((await first).value).toBe('order-1');
  });
});

describe('checkout retries over HTTP', () => {
  it('requires an Idempotency-Key and changes nothing without one', async () => {
    const { api, store, cartWith } = buildTestApp();
    const cartId = await cartWith({ p_mug: 1 });

    const res = await api.post(`/carts/${cartId}/checkout`).send({}).expect(400);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const tooLong = await api
      .post(`/carts/${cartId}/checkout`)
      .set('Idempotency-Key', 'k'.repeat(256))
      .send({})
      .expect(400);
    expect(tooLong.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    expect(store.orders.size).toBe(0);
    expect(store.products.get('p_mug')).toMatchObject({ stock: 50, reserved: 0 });
  });

  it('returns the original order when a completed checkout is retried', async () => {
    const { store, payment, cartWith, checkout } = buildTestApp();
    const cartId = await cartWith({ p_sneakers: 1 });

    const first = await checkout(cartId, {}, 'retry-key').expect(201);
    const retry = await checkout(cartId, {}, 'retry-key').expect(201);

    expect(first.headers['idempotent-replayed']).toBe('false');
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(store.orders.size).toBe(1);
    expect(store.products.get('p_sneakers')).toMatchObject({ stock: 1, reserved: 0 });
    expect((payment as FakePaymentGateway).charges).toHaveLength(1);
  });

  it('creates one order when the same request is sent many times at once', async () => {
    const payment = new FakePaymentGateway(30);
    const { store, cartWith, checkout } = buildTestApp({ payment });
    const cartId = await cartWith({ p_hoodie: 2 });

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => checkout(cartId, {}, 'double-click')),
    );

    expect(responses.map((res) => res.status)).toEqual(Array(8).fill(201));
    expect(new Set(responses.map((res) => res.body.id)).size).toBe(1);
    expect(responses.filter((res) => res.headers['idempotent-replayed'] === 'false')).toHaveLength(1);
    expect(store.orders.size).toBe(1);
    expect(store.products.get('p_hoodie')).toMatchObject({ stock: 23, reserved: 0 });
    expect(payment.charges).toHaveLength(1);
  });

  it('rejects the same key with a different body or a different cart', async () => {
    const { cartWith, checkout } = buildTestApp();
    const cartA = await cartWith({ p_mug: 1 });
    const cartB = await cartWith({ p_mug: 1 });
    await checkout(cartA, {}, 'shared-key').expect(201);

    const otherBody = await checkout(cartA, { expectedTotalCents: 1250 }, 'shared-key').expect(422);
    expect(otherBody.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const otherCart = await checkout(cartB, {}, 'shared-key').expect(422);
    expect(otherCart.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('lets a declined checkout be retried with the same key', async () => {
    const payment = new FakePaymentGateway(5);
    const { store, cartWith, checkout } = buildTestApp({ payment });
    const cartId = await cartWith({ p_cap: 1 });

    payment.declineNext();
    await checkout(cartId, {}, 'card-retry').expect(402);
    const retry = await checkout(cartId, {}, 'card-retry').expect(201);

    expect(retry.headers['idempotent-replayed']).toBe('false');
    expect(store.orders.size).toBe(1);
  });

  it('does not let a new key check out a cart a second time', async () => {
    const { cartWith, checkout } = buildTestApp();
    const cartId = await cartWith({ p_mug: 1 });
    const first = await checkout(cartId, {}, 'first-key').expect(201);

    const res = await checkout(cartId, {}, 'second-key').expect(409);
    expect(res.body.error).toMatchObject({
      code: 'CART_ALREADY_CHECKED_OUT',
      details: { orderId: first.body.id },
    });
  });
});
