import { randomUUID } from 'node:crypto';
import { type Server, createServer } from 'node:http';
import request from 'supertest';
import { afterEach } from 'vitest';
import { createApp } from '../src/app';
import type { Config } from '../src/config';
import {
  type ChargeRequest,
  FakePaymentGateway,
  type PaymentGateway,
  PaymentDeclinedError,
} from '../src/payment';
import { seedProducts } from '../src/seed';
import { type Product, createStore } from '../src/store';

export interface TestAppOptions {
  config?: Partial<Config>;
  products?: Product[];
  payment?: PaymentGateway;
}

const openServers = new Set<Server>();

afterEach(() => {
  for (const server of openServers) {
    server.closeAllConnections();
    server.close();
  }
  openServers.clear();
});

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
  const payment = options.payment ?? new FakePaymentGateway(config.paymentDelayMs);
  const app = createApp({ store, config, payment });

  // One real listening server per test app. Concurrent requests then hit the
  // same server, just as they would in production.
  const server = createServer(app).listen(0);
  openServers.add(server);
  const api = request(server);

  return {
    app,
    store,
    api,
    payment,
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
    /** A checkout request; uses a fresh Idempotency-Key unless one is given. */
    checkout(cartId: string, body: object = {}, key: string = randomUUID()) {
      return api.post(`/carts/${cartId}/checkout`).set('Idempotency-Key', key).send(body);
    },
  };
}

export function product(id: string, priceCents: number, stock: number): Product {
  return { id, name: `Product ${id}`, priceCents, stock, reserved: 0 };
}

interface PendingCharge {
  request: ChargeRequest;
  resolve: (result: { paymentId: string }) => void;
  reject: (error: Error) => void;
}

/**
 * A payment gateway whose charges wait until the test approves or declines
 * them. Lets a test pause a checkout mid-payment and send competing requests
 * at exactly that point, instead of relying on timing.
 */
export class ControlledPaymentGateway implements PaymentGateway {
  private pending: PendingCharge[] = [];
  private wakeWaiters: (() => void)[] = [];

  charge(request: ChargeRequest): Promise<{ paymentId: string }> {
    return new Promise((resolve, reject) => {
      this.pending.push({ request, resolve, reject });
      this.wakeWaiters.splice(0).forEach((wake) => wake());
    });
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Resolves once at least `count` charges are waiting for a decision. */
  async waitForCharges(count = 1): Promise<void> {
    while (this.pending.length < count) {
      await new Promise<void>((wake) => this.wakeWaiters.push(wake));
    }
  }

  approve(): void {
    const charge = this.take();
    charge.resolve({ paymentId: `pay_${charge.request.reference}` });
  }

  decline(): void {
    this.take().reject(new PaymentDeclinedError('Declined by test.'));
  }

  private take(): PendingCharge {
    const charge = this.pending.shift();
    if (!charge) throw new Error('No charge is waiting.');
    return charge;
  }
}
