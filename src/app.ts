import express, { type Express, type Request } from 'express';
import { z } from 'zod';
import type { Config } from './config';
import { badRequest } from './errors';
import { errorHandler, routeNotFound } from './http/errorHandler';
import { parseBody } from './http/validate';
import type { PaymentGateway } from './payment';
import { listProducts, toAdminProductView, updateProduct } from './services/catalog';
import {
  MAX_LINE_QUANTITY,
  createCart,
  getCartOrThrow,
  removeItem,
  setItemQuantity,
  toCartView,
} from './services/carts';
import { checkout, checkoutFingerprint } from './services/checkout';
import { generateCoupon, listCoupons } from './services/coupons';
import { runIdempotent } from './services/idempotency';
import { getOrderOrThrow, listOrders } from './services/orders';
import { buildReport } from './services/report';
import type { Store } from './store';

export interface AppContext {
  store: Store;
  config: Config;
  payment: PaymentGateway;
}

// Strict objects reject unknown fields, so a typo such as "quantiy" or
// "expectedTotal" fails loudly instead of being silently ignored.
const setQuantityBody = z.strictObject({
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
});

const checkoutBody = z.strictObject({
  couponCode: z.string().trim().min(1).max(64).optional(),
  expectedTotalCents: z.number().int().min(0).optional(),
});

// Price is capped at $1,000,000 so that no cart total can approach the
// largest integer JavaScript stores exactly.
const updateProductBody = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    priceCents: z.number().int().min(0).max(100_000_000).optional(),
    stock: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Provide at least one of name, priceCents or stock.',
  });

export function createApp({ store, config, payment }: AppContext): Express {
  const app = express();
  app.use(express.json({ limit: '16kb' }));

  app.get('/products', (_req, res) => {
    res.json({ items: listProducts(store) });
  });

  app.post('/carts', (_req, res) => {
    res.status(201).json(toCartView(store, createCart(store)));
  });

  app.get('/carts/:cartId', (req, res) => {
    res.json(toCartView(store, getCartOrThrow(store, req.params.cartId)));
  });

  app.put('/carts/:cartId/items/:productId', (req, res) => {
    const { quantity } = parseBody(setQuantityBody, req.body);
    const cart = setItemQuantity(store, req.params.cartId, req.params.productId, quantity);
    res.json(toCartView(store, cart));
  });

  app.delete('/carts/:cartId/items/:productId', (req, res) => {
    const cart = removeItem(store, req.params.cartId, req.params.productId);
    res.json(toCartView(store, cart));
  });

  app.post('/carts/:cartId/checkout', async (req, res) => {
    const key = readIdempotencyKey(req);
    const request = { cartId: req.params.cartId, ...parseBody(checkoutBody, req.body) };

    const { value: order, replayed } = await runIdempotent(
      store.checkoutKeys,
      key,
      checkoutFingerprint(request),
      () => checkout({ store, payment }, request),
    );
    res.status(201).set('Idempotent-Replayed', String(replayed)).json(order);
  });

  app.get('/orders/:orderId', (req, res) => {
    res.json(getOrderOrThrow(store, req.params.orderId));
  });

  // Administrative operations. Authentication is out of scope; in production
  // these routes would sit behind an admin role.
  app.post('/admin/coupons', (_req, res) => {
    res.status(201).json(generateCoupon(store, config));
  });

  app.get('/admin/coupons', (_req, res) => {
    res.json({ items: listCoupons(store) });
  });

  app.get('/admin/orders', (_req, res) => {
    res.json({ items: listOrders(store) });
  });

  app.get('/admin/report', (_req, res) => {
    res.json(buildReport(store, config));
  });

  app.patch('/admin/products/:productId', (req, res) => {
    const update = parseBody(updateProductBody, req.body);
    res.json(toAdminProductView(updateProduct(store, req.params.productId, update)));
  });

  app.use(routeNotFound);
  app.use(errorHandler);
  return app;
}

/**
 * Checkout must be retry-safe, so the client has to say which attempt a
 * request belongs to. Without a key, a retry would look like a new checkout.
 */
function readIdempotencyKey(req: Request): string {
  const key = req.get('Idempotency-Key')?.trim();
  if (!key || key.length > 255) {
    throw badRequest(
      'IDEMPOTENCY_KEY_REQUIRED',
      'Send an Idempotency-Key header (1-255 characters) with every checkout.',
    );
  }
  return key;
}
