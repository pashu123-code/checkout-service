/**
 * Every error code the API can return. Clients should branch on `code`, never
 * on `message`, which is for humans and may change.
 */
export type ErrorCode =
  | 'INVALID_JSON'
  | 'PAYLOAD_TOO_LARGE'
  | 'VALIDATION_FAILED'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'ROUTE_NOT_FOUND'
  | 'PRODUCT_NOT_FOUND'
  | 'CART_NOT_FOUND'
  | 'CART_NOT_OPEN'
  | 'CART_EMPTY'
  | 'CART_ALREADY_CHECKED_OUT'
  | 'CHECKOUT_IN_PROGRESS'
  | 'INSUFFICIENT_INVENTORY'
  | 'TOTAL_MISMATCH'
  | 'PAYMENT_DECLINED'
  | 'ORDER_NOT_FOUND'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  override name = 'AppError';

  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(400, code, message, details);

export const notFound = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(404, code, message, details);

/** The request is valid, but the current state of a resource forbids it. */
export const conflict = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

/** The request is well-formed JSON but its contents are not acceptable. */
export const unprocessable = (code: ErrorCode, message: string, details?: unknown) =>
  new AppError(422, code, message, details);
