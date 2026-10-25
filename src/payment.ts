import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Cents } from './domain/money';

export interface ChargeRequest {
  amountCents: Cents;
  /** Our identifier for the charge (the cart id). */
  reference: string;
}

export interface PaymentGateway {
  /** Resolves if the charge succeeded; rejects with PaymentDeclinedError if refused. */
  charge(request: ChargeRequest): Promise<{ paymentId: string }>;
}

export class PaymentDeclinedError extends Error {
  override name = 'PaymentDeclinedError';
}

/**
 * Stand-in for a real payment provider; no money moves. Every charge waits
 * `delayMs` before answering, which gives concurrent checkouts a real window
 * in which to overlap.
 */
export class FakePaymentGateway implements PaymentGateway {
  readonly charges: ChargeRequest[] = [];
  private pendingDeclines = 0;

  constructor(private readonly delayMs = 0) {}

  /** Makes the next `count` charges fail. Used by tests. */
  declineNext(count = 1): void {
    this.pendingDeclines += count;
  }

  async charge(request: ChargeRequest): Promise<{ paymentId: string }> {
    // Decided before waiting, so which charge fails never depends on timing.
    const decline = this.pendingDeclines > 0;
    if (decline) this.pendingDeclines--;

    await sleep(this.delayMs);

    if (decline) {
      throw new PaymentDeclinedError(`Charge for ${request.reference} was declined.`);
    }
    this.charges.push(request);
    return { paymentId: `pay_${randomUUID()}` };
  }
}
