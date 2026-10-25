import express, { type Express } from 'express';
import { z } from 'zod';
import type { Config } from './config';
import { errorHandler, routeNotFound } from './http/errorHandler';
import { parseBody } from './http/validate';
import { listProducts } from './services/catalog';
import {
  MAX_LINE_QUANTITY,
  createCart,
  getCartOrThrow,
  removeItem,
  setItemQuantity,
  toCartView,
} from './services/carts';
import type { Store } from './store';

export interface AppContext {
  store: Store;
  config: Config;
}

const setQuantityBody = z.object({
  quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
});

export function createApp({ store }: AppContext): Express {
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

  app.use(routeNotFound);
  app.use(errorHandler);
  return app;
}
