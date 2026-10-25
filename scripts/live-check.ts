/**
 * Live edge-case check: sends real HTTP requests to a real running server and
 * reports PASS/FAIL for every edge case.
 *
 *   npm run live-check                       starts its own server (recommended)
 *   BASE_URL=http://localhost:3000 npm run live-check
 *                                            uses a server you started; it must be
 *                                            fresh and use DISCOUNT_PERCENT=10
 *
 * The started server uses NTH_ORDER=3 and a 600 ms payment delay, so there is
 * a clear window in which to send requests while a payment is pending.
 *
 * Payment declines can only be triggered from code, so those cases (and the
 * 100% coupon case) run against extra real HTTP servers started in-process.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createApp } from '../src/app';
import { FakePaymentGateway } from '../src/payment';
import { seedProducts } from '../src/seed';
import { createStore } from '../src/store';

// Response bodies are whatever the server sent; the checks inspect them loosely.
type Body = any;
interface Res {
  status: number;
  body: Body;
  headers: Headers;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

class Client {
  constructor(readonly base: string) {}

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const init: RequestInit = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] = 'application/json';
    }
    const res = await fetch(this.base + path, init);
    const text = await res.text();
    let parsed: Body = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON; keep the raw text.
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  get(p: string) {
    return this.call('GET', p);
  }
  post(p: string, body?: unknown, headers?: Record<string, string>) {
    return this.call('POST', p, body, headers);
  }
  put(p: string, body?: unknown) {
    return this.call('PUT', p, body);
  }
  del(p: string) {
    return this.call('DELETE', p);
  }
  patch(p: string, body?: unknown) {
    return this.call('PATCH', p, body);
  }

  async cart(items: Record<string, number> = {}): Promise<string> {
    const id = (await this.post('/carts')).body.id;
    for (const [productId, quantity] of Object.entries(items)) {
      const res = await this.put(`/carts/${id}/items/${productId}`, { quantity });
      if (res.status !== 200) {
        throw new Error(`setup: add ${productId} x${quantity} → ${res.status} ${res.body?.error?.code}`);
      }
    }
    return id;
  }
  checkout(cartId: string, body: object = {}, key: string = randomUUID()) {
    return this.post(`/carts/${cartId}/checkout`, body, { 'Idempotency-Key': key });
  }
  async product(id: string) {
    return (await this.get('/products')).body.items.find((p: Body) => p.id === id);
  }
  async setProduct(id: string, update: object) {
    const res = await this.patch(`/admin/products/${id}`, update);
    if (res.status !== 200) throw new Error(`setup: patch ${id} → ${res.status} ${res.body?.error?.code}`);
    return res.body;
  }
  async coupon(code: string) {
    return (await this.get('/admin/coupons')).body.items.find((c: Body) => c.code === code);
  }
  /** Places `count` orders at once; they overlap, so this takes one payment delay. */
  async placeOrders(count: number) {
    await this.setProduct('p_stickers', { stock: 500 });
    const carts = await Promise.all(Array.from({ length: count }, () => this.cart({ p_stickers: 1 })));
    const results = await Promise.all(carts.map((cartId) => this.checkout(cartId)));
    if (results.some((res) => res.status !== 201)) throw new Error('setup: placeOrders failed');
  }
  /** Issues every coupon that is currently due, then returns the 409 details. */
  async drainCoupons() {
    for (;;) {
      const res = await this.post('/admin/coupons');
      if (res.status === 409) return res.body.error.details;
    }
  }
  /** A newly issued, unused coupon code, placing orders first if needed. */
  async freshCoupon(): Promise<string> {
    let res = await this.post('/admin/coupons');
    if (res.status === 409) {
      await this.placeOrders(res.body.error.details.ordersUntilNextMilestone);
      res = await this.post('/admin/coupons');
    }
    if (res.status !== 201) throw new Error(`setup: coupon → ${res.status}`);
    return res.body.code;
  }
  async waitForCartStatus(cartId: string, status: string) {
    for (let i = 0; i < 600; i++) {
      if ((await this.get(`/carts/${cartId}`)).body.status === status) return;
      await sleep(5);
    }
    throw new Error(`cart never reached ${status}`);
  }
}

// ---------------------------------------------------------------- reporting

const results: { group: string; name: string; ok: boolean; note: string }[] = [];
let group = '';

async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    results.push({ group, name, ok: true, note: note ?? '' });
  } catch (error) {
    results.push({ group, name, ok: false, note: (error as Error).message });
  }
}

/** Throws unless the response has this status (and error code); returns what happened. */
function expectRes(res: Res, status: number, code?: string): string {
  const actual = `${res.status}${res.body?.error?.code ? ` ${res.body.error.code}` : ''}`;
  if (res.status !== status || (code !== undefined && res.body?.error?.code !== code)) {
    throw new Error(`expected ${status}${code ? ` ${code}` : ''}, got ${actual}`);
  }
  return actual;
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function counts(statuses: number[]) {
  const tally: Record<number, number> = {};
  for (const status of statuses) tally[status] = (tally[status] ?? 0) + 1;
  return Object.entries(tally)
    .map(([status, n]) => `${n}×${status}`)
    .join(', ');
}

// ---------------------------------------------------------------- main server

async function liveServer(L: Client) {
  const nth = (await L.get('/admin/report')).body.milestones.nthOrder;

  group = 'Validation and routing';
  await check('Unknown route', async () => expectRes(await L.get('/nope'), 404, 'ROUTE_NOT_FOUND'));
  await check('Unknown cart', async () => expectRes(await L.get('/carts/cart_missing'), 404, 'CART_NOT_FOUND'));
  await check('Unknown order', async () => expectRes(await L.get('/orders/ord_missing'), 404, 'ORDER_NOT_FOUND'));
  await check('Unknown product is rejected and the cart stays empty', async () => {
    const cart = await L.cart();
    const note = expectRes(await L.put(`/carts/${cart}/items/p_unicorn`, { quantity: 1 }), 404, 'PRODUCT_NOT_FOUND');
    assert((await L.get(`/carts/${cart}`)).body.items.length === 0, 'cart not empty');
    return note;
  });
  const badQuantities = [
    ['0', 0],
    ['-1', -1],
    ['1.5', 1.5],
    ['"2" (string)', '2'],
    ['null', null],
    ['1001 (over limit)', 1001],
  ] as const;
  for (const [label, quantity] of badQuantities) {
    await check(`Quantity ${label} is rejected`, async () => {
      const res = await L.put(`/carts/${await L.cart()}/items/p_mug`, { quantity });
      const note = expectRes(res, 422, 'VALIDATION_FAILED');
      assert(res.body.error.details[0].field === 'quantity', 'wrong field reported');
      return note;
    });
  }
  await check('Missing body is rejected', async () =>
    expectRes(await L.put(`/carts/${await L.cart()}/items/p_mug`), 422, 'VALIDATION_FAILED'));
  await check('Misspelled field ("quantiy") is rejected, not ignored', async () =>
    expectRes(await L.put(`/carts/${await L.cart()}/items/p_mug`, { quantiy: 1 }), 422, 'VALIDATION_FAILED'));
  await check('Malformed JSON', async () =>
    expectRes(await L.put(`/carts/${await L.cart()}/items/p_mug`, '{"quantity": '), 400, 'INVALID_JSON'));
  await check('Body over 16 KB', async () =>
    expectRes(
      await L.put(`/carts/${await L.cart()}/items/p_mug`, { quantity: 1, pad: 'x'.repeat(20_000) }),
      413,
      'PAYLOAD_TOO_LARGE',
    ));
  await check('More units than in stock (3 sneakers, 2 left)', async () => {
    await L.setProduct('p_sneakers', { stock: 2 });
    const res = await L.put(`/carts/${await L.cart()}/items/p_sneakers`, { quantity: 3 });
    const note = expectRes(res, 409, 'INSUFFICIENT_INVENTORY');
    assert(res.body.error.details.items[0].available === 2, 'wrong available count');
    return `${note} (available: 2)`;
  });
  await check('Same quantity sent 3 times = one line, quantity 2', async () => {
    const cart = await L.cart();
    for (let i = 0; i < 3; i++) await L.put(`/carts/${cart}/items/p_cap`, { quantity: 2 });
    const items = (await L.get(`/carts/${cart}`)).body.items;
    assert(items.length === 1 && items[0].quantity === 2, JSON.stringify(items));
    return '1 line, quantity 2';
  });
  await check('Removing an item that is not in the cart is a harmless no-op', async () => {
    const cart = await L.cart({ p_mug: 1 });
    await L.del(`/carts/${cart}/items/p_cap`);
    const res = await L.del(`/carts/${cart}/items/p_cap`);
    assert(res.status === 200 && res.body.items.length === 1, 'unexpected');
    return '200, mug still there';
  });

  group = 'Checkout basics';
  await check('Empty cart', async () => expectRes(await L.checkout(await L.cart()), 422, 'CART_EMPTY'));
  await check('No Idempotency-Key', async () =>
    expectRes(await L.post(`/carts/${await L.cart({ p_mug: 1 })}/checkout`, {}), 400, 'IDEMPOTENCY_KEY_REQUIRED'));
  await check('Idempotency-Key longer than 255 characters', async () =>
    expectRes(await L.checkout(await L.cart({ p_mug: 1 }), {}, 'k'.repeat(256)), 400, 'IDEMPOTENCY_KEY_REQUIRED'));

  const happyCart = await L.cart({ p_tshirt: 2, p_mug: 1 });
  const happyKey = randomUUID();
  let happyOrder: Body;
  await check('Happy path: correct totals, stock reduced, cart closed', async () => {
    const [tshirtBefore, mugBefore] = [await L.product('p_tshirt'), await L.product('p_mug')];
    const res = await L.checkout(happyCart, {}, happyKey);
    expectRes(res, 201);
    happyOrder = res.body;
    assert(res.body.subtotalCents === 5248 && res.body.totalCents === 5248, `total ${res.body.totalCents}`);
    const [tshirtAfter, mugAfter] = [await L.product('p_tshirt'), await L.product('p_mug')];
    assert(tshirtBefore.availableQuantity - tshirtAfter.availableQuantity === 2, 'tshirt stock');
    assert(mugBefore.availableQuantity - mugAfter.availableQuantity === 1, 'mug stock');
    const cart = (await L.get(`/carts/${happyCart}`)).body;
    assert(cart.status === 'CHECKED_OUT' && cart.orderId === res.body.id, 'cart state');
    const stored = (await L.get(`/orders/${res.body.id}`)).body;
    assert(JSON.stringify(stored) === JSON.stringify(res.body), 'GET order differs');
    return `201, order #${res.body.number}, total 5248¢`;
  });
  await check('Retry with the same key returns the same order, stock untouched', async () => {
    const before = await L.product('p_tshirt');
    const res = await L.checkout(happyCart, {}, happyKey);
    expectRes(res, 201);
    assert(res.body.id === happyOrder.id, 'different order');
    assert(res.headers.get('idempotent-replayed') === 'true', 'not marked replayed');
    assert((await L.product('p_tshirt')).availableQuantity === before.availableQuantity, 'stock changed');
    return '201, same order id, Idempotent-Replayed: true';
  });
  await check('New key on an already checked-out cart', async () => {
    const res = await L.checkout(happyCart);
    const note = expectRes(res, 409, 'CART_ALREADY_CHECKED_OUT');
    assert(res.body.error.details.orderId === happyOrder.id, 'missing orderId');
    return `${note} (points to the existing order)`;
  });
  await check('Same key reused for a different cart', async () =>
    expectRes(await L.checkout(await L.cart({ p_mug: 1 }), {}, happyKey), 422, 'IDEMPOTENCY_KEY_REUSED'));
  await check('Same key reused with a different body', async () =>
    expectRes(await L.checkout(happyCart, { expectedTotalCents: 5248 }, happyKey), 422, 'IDEMPOTENCY_KEY_REUSED'));
  await check('Editing a checked-out cart', async () =>
    expectRes(await L.put(`/carts/${happyCart}/items/p_mug`, { quantity: 3 }), 409, 'CART_NOT_OPEN'));
  const badCheckoutBodies = [
    ['expectedTotalCents -1', { expectedTotalCents: -1 }],
    ['expectedTotalCents 10.5', { expectedTotalCents: 10.5 }],
    ['misspelled "expectedTotal"', { expectedTotal: 100 }],
    ['empty couponCode', { couponCode: '' }],
    ['blank couponCode', { couponCode: '   ' }],
    ['numeric couponCode', { couponCode: 123 }],
  ] as const;
  for (const [label, body] of badCheckoutBodies) {
    await check(`Checkout body with ${label}`, async () =>
      expectRes(await L.checkout(await L.cart({ p_mug: 1 }), body), 422, 'VALIDATION_FAILED'));
  }
  await check('Expected total does not match → refused, then accepted with the right total', async () => {
    const cart = await L.cart({ p_mug: 2 });
    const res = await L.checkout(cart, { expectedTotalCents: 1 });
    const note = expectRes(res, 409, 'TOTAL_MISMATCH');
    assert(res.body.error.details.totalCents === 2500, 'wrong actual total');
    assert((await L.get(`/carts/${cart}`)).body.status === 'OPEN', 'cart not open');
    expectRes(await L.checkout(cart, { expectedTotalCents: 2500 }), 201);
    return `${note}, then 201`;
  });
  let capOrderId = '';
  await check('Price raised after adding → cart and checkout use the new price', async () => {
    const cart = await L.cart({ p_cap: 1 });
    await L.setProduct('p_cap', { priceCents: 2000 });
    assert((await L.get(`/carts/${cart}`)).body.subtotalCents === 2000, 'cart not repriced');
    const res = await L.checkout(cart);
    expectRes(res, 201);
    capOrderId = res.body.id;
    assert(res.body.totalCents === 2000, `charged ${res.body.totalCents}`);
    return 'charged 2000¢ (new price)';
  });
  await check('Order is unchanged after the product is renamed and repriced', async () => {
    await L.setProduct('p_cap', { priceCents: 9999, name: 'Renamed Cap' });
    const order = (await L.get(`/orders/${capOrderId}`)).body;
    await L.setProduct('p_cap', { priceCents: 1599, name: 'Baseball Cap' });
    assert(
      order.lines[0].unitPriceCents === 2000 && order.lines[0].name === 'Baseball Cap',
      JSON.stringify(order.lines[0]),
    );
    return 'still 2000¢, "Baseball Cap"';
  });
  await check('Stock sold out after adding → checkout refused, nothing held, cart fixable', async () => {
    await L.setProduct('p_sneakers', { stock: 2 });
    const first = await L.cart({ p_sneakers: 2 });
    const second = await L.cart({ p_sneakers: 2, p_mug: 1 });
    const mugBefore = (await L.product('p_mug')).availableQuantity;
    expectRes(await L.checkout(first), 201);
    const res = await L.checkout(second);
    const note = expectRes(res, 409, 'INSUFFICIENT_INVENTORY');
    assert(res.body.error.details.items[0].available === 0, 'details wrong');
    assert((await L.product('p_mug')).availableQuantity === mugBefore, 'mug was held');
    assert((await L.get(`/carts/${second}`)).body.status === 'OPEN', 'cart not open');
    await L.del(`/carts/${second}/items/p_sneakers`);
    expectRes(await L.checkout(second), 201);
    return `${note}, then 201 after removing sneakers`;
  });

  group = 'Concurrency on the real server';
  await check('10 customers race for the last 3 units', async () => {
    await L.setProduct('p_sneakers', { stock: 3 });
    const carts = await Promise.all(Array.from({ length: 10 }, () => L.cart({ p_sneakers: 1 })));
    const res = await Promise.all(carts.map((cartId) => L.checkout(cartId)));
    const ok = res.filter((r) => r.status === 201).length;
    const rejected = res.filter((r) => r.body?.error?.code === 'INSUFFICIENT_INVENTORY').length;
    assert(ok === 3 && rejected === 7, counts(res.map((r) => r.status)));
    assert((await L.product('p_sneakers')).availableQuantity === 0, 'stock not 0');
    return `${counts(res.map((r) => r.status))}; stock now 0`;
  });
  await check('Same checkout sent 8 times at once (double-click storm)', async () => {
    const cart = await L.cart({ p_hoodie: 2 });
    const before = (await L.product('p_hoodie')).availableQuantity;
    const key = randomUUID();
    const res = await Promise.all(Array.from({ length: 8 }, () => L.checkout(cart, {}, key)));
    assert(res.every((r) => r.status === 201), counts(res.map((r) => r.status)));
    assert(new Set(res.map((r) => r.body.id)).size === 1, 'more than one order');
    assert(res.filter((r) => r.headers.get('idempotent-replayed') === 'false').length === 1, 'replay flags wrong');
    assert(before - (await L.product('p_hoodie')).availableQuantity === 2, 'stock charged more than once');
    return '8×201, 1 order, stock reduced once';
  });
  await check('Editing the cart while its payment is pending', async () => {
    const cart = await L.cart({ p_mug: 1 });
    const pending = L.checkout(cart);
    await L.waitForCartStatus(cart, 'CHECKING_OUT');
    const note = expectRes(await L.put(`/carts/${cart}/items/p_mug`, { quantity: 5 }), 409, 'CART_NOT_OPEN');
    assert((await pending).body.lines[0].quantity === 1, 'edit leaked into order');
    return `${note}; order kept quantity 1`;
  });
  await check('Second checkout of the same cart (new key) while paying', async () => {
    const cart = await L.cart({ p_mug: 1 });
    const pending = L.checkout(cart);
    await L.waitForCartStatus(cart, 'CHECKING_OUT');
    const note = expectRes(await L.checkout(cart), 409, 'CHECKOUT_IN_PROGRESS');
    expectRes(await pending, 201);
    return note;
  });
  await check('Same key repeated while paying waits and gets the same order', async () => {
    const cart = await L.cart({ p_mug: 1 });
    const key = randomUUID();
    const first = L.checkout(cart, {}, key);
    await L.waitForCartStatus(cart, 'CHECKING_OUT');
    const second = await L.checkout(cart, {}, key);
    const firstRes = await first;
    assert(second.status === 201 && second.body.id === firstRes.body.id, 'different result');
    return '201, same order id';
  });
  await check('Admin cuts stock below units held by a pending payment', async () => {
    await L.setProduct('p_cap', { stock: 5 });
    const cart = await L.cart({ p_cap: 3 });
    const pending = L.checkout(cart);
    await L.waitForCartStatus(cart, 'CHECKING_OUT');
    const note = expectRes(await L.patch('/admin/products/p_cap', { stock: 2 }), 409, 'STOCK_BELOW_RESERVED');
    expectRes(await L.patch('/admin/products/p_cap', { stock: 3 }), 200);
    expectRes(await pending, 201);
    assert((await L.product('p_cap')).availableQuantity === 0, 'stock wrong');
    await L.setProduct('p_cap', { stock: 40 });
    return `${note}; stock 3 accepted; payment completed`;
  });
  await check('Admin changes the price while payment is pending', async () => {
    const cart = await L.cart({ p_mug: 2 });
    const pending = L.checkout(cart);
    await L.waitForCartStatus(cart, 'CHECKING_OUT');
    await L.setProduct('p_mug', { priceCents: 9999 });
    const order = (await pending).body;
    await L.setProduct('p_mug', { priceCents: 1250 });
    assert(order.totalCents === 2500 && order.lines[0].unitPriceCents === 1250, `total ${order.totalCents}`);
    return 'order kept 1250¢ each (2500¢)';
  });
  await check('Report while a payment is pending does not count it', async () => {
    const before = (await L.get('/admin/report')).body.placedOrders;
    const cart = await L.cart({ p_mug: 1 });
    const pending = L.checkout(cart);
    await L.waitForCartStatus(cart, 'CHECKING_OUT');
    const during = (await L.get('/admin/report')).body.placedOrders;
    await pending;
    const after = (await L.get('/admin/report')).body.placedOrders;
    assert(during === before && after === before + 1, `${before} → ${during} → ${after}`);
    return `placed orders ${before} → ${during} (pending) → ${after}`;
  });
  await check('Random mix of quantities on 2 scarce products, all at once', async () => {
    await L.setProduct('p_tshirt', { stock: 7 });
    await L.setProduct('p_hoodie', { stock: 5 });
    const carts = await Promise.all(MIXED_CARTS.map((items) => L.cart(items)));
    const res = await Promise.all(carts.map((cartId) => L.checkout(cartId)));
    await expectStockMatchesOrders(L, res, { p_tshirt: 7, p_hoodie: 5 });
    await L.setProduct('p_tshirt', { stock: 100 });
    await L.setProduct('p_hoodie', { stock: 25 });
    return `${counts(res.map((r) => r.status))}; stock = start − sold for both`;
  });

  group = 'Coupons';
  await check('Generate before the next milestone', async () => {
    await L.drainCoupons();
    const res = await L.post('/admin/coupons');
    const note = expectRes(res, 409, 'NO_ELIGIBLE_MILESTONE');
    const d = res.body.error.details;
    return `${note} (${d.placedOrders} orders, next at ${d.nextMilestone}, ${d.ordersUntilNextMilestone} to go)`;
  });
  await check('Reaching the milestone issues exactly one coupon', async () => {
    const d = await L.drainCoupons();
    await L.placeOrders(d.ordersUntilNextMilestone);
    const res = await L.post('/admin/coupons');
    expectRes(res, 201);
    assert(res.body.milestone === d.nextMilestone && /^SAVE10-[A-Z2-9]{8}$/.test(res.body.code), JSON.stringify(res.body));
    expectRes(await L.post('/admin/coupons'), 409, 'NO_ELIGIBLE_MILESTONE');
    return `201 for milestone ${res.body.milestone} (${res.body.code}), then 409`;
  });
  await check('6 admins generate at the same moment', async () => {
    const d = await L.drainCoupons();
    await L.placeOrders(d.ordersUntilNextMilestone);
    const res = await Promise.all(Array.from({ length: 6 }, () => L.post('/admin/coupons')));
    assert(res.filter((r) => r.status === 201).length === 1, counts(res.map((r) => r.status)));
    return counts(res.map((r) => r.status));
  });
  await check('Skipped milestones are caught up oldest first, one per request', async () => {
    const d = await L.drainCoupons();
    await L.placeOrders(d.ordersUntilNextMilestone + nth);
    const first = await L.post('/admin/coupons');
    const second = await L.post('/admin/coupons');
    const third = await L.post('/admin/coupons');
    assert(first.status === 201 && second.status === 201 && third.status === 409, `${first.status} ${second.status} ${third.status}`);
    assert(second.body.milestone === first.body.milestone + nth, 'not consecutive');
    return `milestones ${first.body.milestone} then ${second.body.milestone}, then 409`;
  });
  let redeemed = '';
  await check('Coupon gives 10% off, rounded down (999¢ → 99¢ off)', async () => {
    const code = await L.freshCoupon();
    await L.setProduct('p_stickers', { priceCents: 999 });
    const res = await L.checkout(await L.cart({ p_stickers: 1 }), { couponCode: code });
    await L.setProduct('p_stickers', { priceCents: 299 });
    expectRes(res, 201);
    assert(
      res.body.discountCents === 99 && res.body.totalCents === 900 && res.body.couponCode === code,
      JSON.stringify(res.body),
    );
    const coupon = await L.coupon(code);
    assert(coupon.status === 'REDEEMED' && coupon.redeemedByOrderId === res.body.id, 'coupon state');
    redeemed = code;
    return 'discount 99¢, total 900¢, coupon REDEEMED';
  });
  await check('Code typed in lowercase with spaces still works', async () => {
    const code = await L.freshCoupon();
    const res = await L.checkout(await L.cart({ p_mug: 1 }), { couponCode: `  ${code.toLowerCase()} ` });
    expectRes(res, 201);
    assert(res.body.couponCode === code, 'code not normalised');
    return `201, stored as ${code}`;
  });
  await check('Unknown coupon code → refused, nothing held', async () => {
    const cart = await L.cart({ p_mug: 1 });
    const note = expectRes(await L.checkout(cart, { couponCode: 'SAVE10-NOPE' }), 422, 'COUPON_NOT_FOUND');
    assert((await L.get(`/carts/${cart}`)).body.status === 'OPEN', 'cart not open');
    return note;
  });
  await check('Using an already redeemed coupon', async () =>
    expectRes(await L.checkout(await L.cart({ p_mug: 1 }), { couponCode: redeemed }), 409, 'COUPON_ALREADY_REDEEMED'));
  await check('Retrying a discounted order replays it (not "coupon already used")', async () => {
    const code = await L.freshCoupon();
    const cart = await L.cart({ p_cap: 2 });
    const key = randomUUID();
    const first = await L.checkout(cart, { couponCode: code }, key);
    const retry = await L.checkout(cart, { couponCode: code }, key);
    assert(first.status === 201 && retry.status === 201 && retry.body.id === first.body.id, `${first.status} ${retry.status}`);
    return '201 twice, same order';
  });
  await check('Adding a coupon when retrying an already placed order', async () => {
    const code = await L.freshCoupon();
    const cart = await L.cart({ p_mug: 1 });
    const key = randomUUID();
    expectRes(await L.checkout(cart, {}, key), 201);
    const note = expectRes(await L.checkout(cart, { couponCode: code }, key), 422, 'IDEMPOTENCY_KEY_REUSED');
    assert((await L.coupon(code)).status === 'AVAILABLE', 'coupon consumed');
    return `${note}; coupon still AVAILABLE`;
  });
  await check('A checkout that fails (wrong total) does not use up the coupon', async () => {
    const code = await L.freshCoupon();
    const cart = await L.cart({ p_mug: 1 });
    const note = expectRes(await L.checkout(cart, { couponCode: code, expectedTotalCents: 1 }), 409, 'TOTAL_MISMATCH');
    const coupon = await L.coupon(code);
    assert(coupon.status === 'AVAILABLE' && coupon.reservedByCartId === null, coupon.status);
    return `${note}; coupon still AVAILABLE`;
  });
  await check('Coupon is held while another checkout pays, then used up', async () => {
    const code = await L.freshCoupon();
    const cartA = await L.cart({ p_mug: 1 });
    const cartB = await L.cart({ p_cap: 1 });
    const pending = L.checkout(cartA, { couponCode: code });
    await L.waitForCartStatus(cartA, 'CHECKING_OUT');
    const coupon = await L.coupon(code);
    assert(coupon.status === 'RESERVED' && coupon.reservedByCartId === cartA, 'not reserved');
    const reserved = (await L.get('/admin/report')).body.coupons.reserved;
    const during = expectRes(await L.checkout(cartB, { couponCode: code }), 409, 'COUPON_IN_USE');
    expectRes(await pending, 201);
    const after = expectRes(await L.checkout(cartB, { couponCode: code }), 409, 'COUPON_ALREADY_REDEEMED');
    return `RESERVED (report: ${reserved} reserved) → ${during} → ${after}`;
  });
  await check('10 checkouts try the same coupon at once', async () => {
    const code = await L.freshCoupon();
    const carts = await Promise.all(Array.from({ length: 10 }, () => L.cart({ p_mug: 1 })));
    const res = await Promise.all(carts.map((cartId) => L.checkout(cartId, { couponCode: code })));
    const winners = res.filter((r) => r.status === 201);
    assert(winners.length === 1, counts(res.map((r) => r.status)));
    assert(res.filter((r) => r.body?.error?.code === 'COUPON_IN_USE').length === 9, 'losers wrong');
    assert((await L.coupon(code)).redeemedByOrderId === winners[0]!.body.id, 'redeemed by wrong order');
    return '1×201, 9×409 COUPON_IN_USE';
  });

  group = 'Admin report';
  await check('Report reconciles with /admin/orders and /admin/coupons', async () => {
    const [report, orders, coupons] = await Promise.all([
      L.get('/admin/report').then((r) => r.body),
      L.get('/admin/orders').then((r) => r.body.items),
      L.get('/admin/coupons').then((r) => r.body.items),
    ]);
    assert(report.placedOrders === orders.length, 'order count');
    assert(report.grossRevenueCents === sum(orders.map((o: Body) => o.subtotalCents)), 'gross');
    assert(report.totalDiscountCents === sum(orders.map((o: Body) => o.discountCents)), 'discounts');
    assert(report.netRevenueCents === sum(orders.map((o: Body) => o.totalCents)), 'net');
    assert(report.netRevenueCents === report.grossRevenueCents - report.totalDiscountCents, 'net != gross - discount');
    const lines = orders.flatMap((o: Body) => o.lines);
    for (const item of report.itemsPurchased) {
      const bought = lines.filter((l: Body) => l.productId === item.productId);
      assert(item.quantity === sum(bought.map((l: Body) => l.quantity)), item.productId);
    }
    assert(sum(report.itemsPurchased.map((i: Body) => i.grossRevenueCents)) === report.grossRevenueCents, 'per-product gross');
    const byStatus = (status: string) => coupons.filter((c: Body) => c.status === status).length;
    assert(
      report.coupons.available === byStatus('AVAILABLE') &&
        report.coupons.redeemed === byStatus('REDEEMED') &&
        report.coupons.generated === coupons.length,
      'coupon counts',
    );
    assert(report.coupons.redeemed === orders.filter((o: Body) => o.couponCode).length, 'redeemed != discounted orders');
    return `${report.placedOrders} orders, gross ${report.grossRevenueCents}¢ − discounts ${report.totalDiscountCents}¢ = net ${report.netRevenueCents}¢, ${report.coupons.generated} coupons`;
  });
  await check('5 simultaneous report reads are identical and change nothing', async () => {
    const snapshot = async () =>
      JSON.stringify(await Promise.all(['/admin/orders', '/admin/coupons', '/products'].map((p) => L.get(p).then((r) => r.body))));
    const before = await snapshot();
    const reads = await Promise.all(Array.from({ length: 5 }, () => L.get('/admin/report')));
    assert(new Set(reads.map((r) => JSON.stringify(r.body))).size === 1, 'reads differ');
    assert((await snapshot()) === before, 'state changed');
    return 'identical, state unchanged';
  });
  await check('"Coupon ready" flag flips exactly at the milestone', async () => {
    const flag = async () => (await L.get('/admin/report')).body.milestones.couponAvailableToGenerate;
    const d = await L.drainCoupons();
    if (d.ordersUntilNextMilestone > 1) await L.placeOrders(d.ordersUntilNextMilestone - 1);
    const below = await flag();
    await L.placeOrders(1);
    const at = await flag();
    await L.post('/admin/coupons');
    const afterIssuing = await flag();
    assert(below === false && at === true && afterIssuing === false, `${below} ${at} ${afterIssuing}`);
    return 'false (1 short) → true (at milestone) → false (after issuing)';
  });

  group = 'Admin product updates';
  const badUpdates = [
    ['empty update', {}],
    ['negative price', { priceCents: -1 }],
    ['fractional price', { priceCents: 9.99 }],
    ['price over $1M cap', { priceCents: 100_000_001 }],
    ['negative stock', { stock: -1 }],
    ['unknown field', { discount: 5 }],
  ] as const;
  for (const [label, body] of badUpdates) {
    await check(`Rejects ${label}`, async () => expectRes(await L.patch('/admin/products/p_mug', body), 422, 'VALIDATION_FAILED'));
  }
  await check('Unknown product', async () =>
    expectRes(await L.patch('/admin/products/p_nope', { stock: 1 }), 404, 'PRODUCT_NOT_FOUND'));
  await check('Restocking a sold-out product makes it buyable again', async () => {
    await L.setProduct('p_sneakers', { stock: 0 });
    const cart = await L.cart();
    expectRes(await L.put(`/carts/${cart}/items/p_sneakers`, { quantity: 1 }), 409, 'INSUFFICIENT_INVENTORY');
    await L.setProduct('p_sneakers', { stock: 2 });
    expectRes(await L.put(`/carts/${cart}/items/p_sneakers`, { quantity: 2 }), 200);
    expectRes(await L.checkout(cart), 201);
    return '409 when 0, 201 after restock';
  });
}

const MIXED_CARTS: Record<string, number>[] = [
  { p_tshirt: 2 },
  { p_tshirt: 3, p_hoodie: 1 },
  { p_hoodie: 2 },
  { p_tshirt: 1, p_hoodie: 2 },
  { p_tshirt: 2, p_hoodie: 2 },
  { p_tshirt: 1 },
  { p_hoodie: 1 },
  { p_tshirt: 3 },
];

/** Asserts that, for each product, units left = starting stock − units in the new orders. */
async function expectStockMatchesOrders(client: Client, responses: Res[], initial: Record<string, number>) {
  const ids = new Set(responses.filter((r) => r.status === 201).map((r) => r.body.id));
  const orders = (await client.get('/admin/orders')).body.items.filter((o: Body) => ids.has(o.id));
  const lines = orders.flatMap((o: Body) => o.lines);
  for (const [productId, start] of Object.entries(initial)) {
    const sold = sum(lines.filter((l: Body) => l.productId === productId).map((l: Body) => l.quantity));
    const left = (await client.product(productId)).availableQuantity;
    assert(left === start - sold && left >= 0, `${productId}: ${start} − ${sold} ≠ ${left}`);
  }
}

// ---------------------------------------------------------------- extra servers

/** A real HTTP server in this process, so the test can make its payments decline. */
async function startInProcess(config: { nthOrder: number; discountPercent: number }) {
  const payment = new FakePaymentGateway(200);
  const app = createApp({
    store: createStore(seedProducts()),
    payment,
    config: { port: 0, paymentDelayMs: 200, ...config },
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { client: new Client(`http://localhost:${port}`), payment, close: () => server.close() };
}

async function paymentFailures() {
  group = 'Payment declined (second real server; declines triggered from code)';
  const { client: P, payment, close } = await startInProcess({ nthOrder: 2, discountPercent: 10 });
  try {
    await check('Declined payment → 402, stock released, cart reopened, same key retry works', async () => {
      const cart = await P.cart({ p_sneakers: 2 });
      const key = randomUUID();
      payment.declineNext();
      const note = expectRes(await P.checkout(cart, {}, key), 402, 'PAYMENT_DECLINED');
      assert((await P.product('p_sneakers')).availableQuantity === 2, 'stock still held');
      assert((await P.get(`/carts/${cart}`)).body.status === 'OPEN', 'cart not reopened');
      assert((await P.get('/admin/orders')).body.items.length === 0, 'order created');
      const retry = await P.checkout(cart, {}, key);
      expectRes(retry, 201);
      assert(retry.headers.get('idempotent-replayed') === 'false', 'should have run again');
      return `${note} → retry 201`;
    });
    await check('Declined payments do not count toward the coupon milestone', async () => {
      payment.declineNext();
      expectRes(await P.checkout(await P.cart({ p_mug: 1 })), 402);
      const report = (await P.get('/admin/report')).body;
      assert(report.placedOrders === 1, `placedOrders ${report.placedOrders}`);
      return `still ${report.placedOrders} order (milestone at 2)`;
    });
    await check('Declined payment gives the coupon back', async () => {
      const code = await P.freshCoupon();
      const cart = await P.cart({ p_mug: 1 });
      payment.declineNext();
      expectRes(await P.checkout(cart, { couponCode: code }), 402);
      const coupon = await P.coupon(code);
      assert(coupon.status === 'AVAILABLE' && coupon.reservedByCartId === null, coupon.status);
      const res = await P.checkout(cart, { couponCode: code });
      expectRes(res, 201);
      assert(res.body.couponCode === code, 'coupon not applied');
      return 'AVAILABLE after decline, then redeemed on retry';
    });
    await check('Two 5¢ items at 10% → 1¢ off (rounded once per order)', async () => {
      await P.setProduct('p_mug', { priceCents: 5 });
      await P.setProduct('p_cap', { priceCents: 5 });
      const code = await P.freshCoupon();
      const res = await P.checkout(await P.cart({ p_mug: 1, p_cap: 1 }), { couponCode: code });
      expectRes(res, 201);
      assert(res.body.discountCents === 1 && res.body.totalCents === 9, JSON.stringify(res.body));
      return 'discount 1¢, total 9¢';
    });
    await check('Free product → order placed without charging', async () => {
      await P.setProduct('p_stickers', { priceCents: 0 });
      const before = payment.charges.length;
      const res = await P.checkout(await P.cart({ p_stickers: 3 }));
      expectRes(res, 201);
      assert(res.body.totalCents === 0 && res.body.paymentId === null && payment.charges.length === before, 'charged');
      return 'total 0¢, paymentId null, no charge';
    });
    await check('Mixed burst with 2 declines: stock always matches orders', async () => {
      await P.setProduct('p_tshirt', { stock: 7 });
      await P.setProduct('p_hoodie', { stock: 5 });
      const carts = await Promise.all(MIXED_CARTS.map((items) => P.cart(items)));
      payment.declineNext(2);
      const res = await Promise.all(carts.map((cartId) => P.checkout(cartId)));
      await expectStockMatchesOrders(P, res, { p_tshirt: 7, p_hoodie: 5 });
      assert(res.filter((r) => r.status === 402).length === 2, 'expected 2 declines');
      return `${counts(res.map((r) => r.status))}; stock = start − sold`;
    });
  } finally {
    close();
  }

  group = '100% coupon (third real server; DISCOUNT_PERCENT=100)';
  const { client: Q, payment: qPayment, close: closeQ } = await startInProcess({ nthOrder: 1, discountPercent: 100 });
  try {
    await check('100% coupon → total exactly 0, never negative, no charge', async () => {
      const code = await Q.freshCoupon();
      const before = qPayment.charges.length;
      const res = await Q.checkout(await Q.cart({ p_hoodie: 1 }), { couponCode: code });
      expectRes(res, 201);
      assert(
        res.body.discountCents === 4999 && res.body.totalCents === 0 && res.body.paymentId === null,
        JSON.stringify(res.body),
      );
      assert(qPayment.charges.length === before, 'charged');
      return 'discount 4999¢, total 0¢, paymentId null';
    });
  } finally {
    closeQ();
  }
}

// ---------------------------------------------------------------- main

/** Starts `src/server.ts` as its own process, exactly like `npm start`. */
async function startServerProcess(): Promise<{ base: string; stop: () => void }> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), NTH_ORDER: '3', DISCOUNT_PERCENT: '10', PAYMENT_DELAY_MS: '600' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const stop = () => child.kill();
  process.once('exit', stop);

  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) resolve();
    });
    child.once('exit', (code) => reject(new Error(`server exited early (code ${code})`)));
  });
  return { base: `http://localhost:${port}`, stop };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function main() {
  const started = Date.now();
  const external = process.env.BASE_URL;
  const server = external ? null : await startServerProcess();
  const base = external ?? server!.base;
  console.log(`Running live edge cases against ${base}${external ? '' : ' (server started by this script)'}`);

  try {
    const report = (await new Client(base).get('/admin/report')).body;
    if (report.milestones?.discountPercent !== 10 || report.placedOrders !== 0) {
      throw new Error('The server must be freshly started with DISCOUNT_PERCENT=10.');
    }
    await liveServer(new Client(base));
    await paymentFailures();
  } finally {
    server?.stop();
  }

  let current = '';
  for (const r of results) {
    if (r.group !== current) {
      current = r.group;
      console.log(`\n${current}`);
    }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.note ? `  →  ${r.note}` : ''}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
