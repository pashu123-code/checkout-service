import request from 'supertest';
import { createApp } from '../src/app';
import type { Config } from '../src/config';
import { seedProducts } from '../src/seed';
import { type Product, createStore } from '../src/store';

export interface TestAppOptions {
  config?: Partial<Config>;
  products?: Product[];
}

/** A fresh app with its own in-memory store, so tests never share state. */
export function buildTestApp(options: TestAppOptions = {}) {
  const config: Config = {
    port: 0,
    nthOrder: 3,
    discountPercent: 10,
    paymentDelayMs: 20,
    ...options.config,
  };
  const store = createStore(options.products ?? seedProducts());
  const app = createApp({ store, config });
  const api = request(app);

  return {
    app,
    store,
    api,
    async createCart(): Promise<string> {
      const res = await api.post('/carts').expect(201);
      return res.body.id;
    },
    async cartWith(items: Record<string, number>): Promise<string> {
      const res = await api.post('/carts').expect(201);
      for (const [productId, quantity] of Object.entries(items)) {
        await api.put(`/carts/${res.body.id}/items/${productId}`).send({ quantity }).expect(200);
      }
      return res.body.id;
    },
  };
}
