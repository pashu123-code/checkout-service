import { unprocessable } from '../errors';

export interface IdempotencyRecord<T> {
  /** Identifies the request the key was first used with. */
  fingerprint: string;
  /** Shared by every request with this key, whether still running or settled. */
  result: Promise<T>;
}

export type IdempotencyRecords<T> = Map<string, IdempotencyRecord<T>>;

/**
 * Runs `operation` at most once per key and returns the same result to every
 * request that uses that key.
 *
 * - A repeat that arrives while the first is still running waits for it,
 *   instead of running the operation a second time.
 * - A repeat that arrives after success gets the stored result.
 * - Reusing a key for a different request is rejected.
 * - A failed attempt is forgotten, so retrying with the same key runs the
 *   operation again. Failures here never leave anything behind (no order, no
 *   held stock), so running again cannot double anything.
 *
 * The lookup and the insert happen in the same synchronous step, so two
 * requests with the same key cannot both miss the map and both run.
 */
export async function runIdempotent<T>(
  records: IdempotencyRecords<T>,
  key: string,
  fingerprint: string,
  operation: () => Promise<T>,
): Promise<{ value: T; replayed: boolean }> {
  const existing = records.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw unprocessable(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request.',
        { idempotencyKey: key },
      );
    }
    return { value: await existing.result, replayed: true };
  }

  const result = operation();
  records.set(key, { fingerprint, result });
  try {
    return { value: await result, replayed: false };
  } catch (error) {
    if (records.get(key)?.result === result) records.delete(key);
    throw error;
  }
}
