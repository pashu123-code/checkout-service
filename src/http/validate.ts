import type { z } from 'zod';
import { unprocessable } from '../errors';

/** Parses a request body against a schema, turning failures into a 422. */
export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    throw unprocessable(
      'VALIDATION_FAILED',
      'Request body is invalid.',
      result.error.issues.map((issue) => ({
        field: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
