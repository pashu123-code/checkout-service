export interface Config {
  port: number;
  /** Every nth successfully placed order unlocks one coupon. */
  nthOrder: number;
  /** Discount each coupon gives, as a whole percent (1-100). */
  discountPercent: number;
  /** Simulated payment latency, so concurrent checkouts really overlap. */
  paymentDelayMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: readInt(env, 'PORT', 3000, 0, 65_535),
    nthOrder: readInt(env, 'NTH_ORDER', 5, 1, 1_000_000),
    discountPercent: readInt(env, 'DISCOUNT_PERCENT', 10, 1, 100),
    paymentDelayMs: readInt(env, 'PAYMENT_DELAY_MS', 150, 0, 60_000),
  };
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}
