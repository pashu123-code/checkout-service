import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, type ErrorCode } from '../errors';

export function errorBody(code: ErrorCode, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

export const routeNotFound: RequestHandler = (req, res) => {
  res
    .status(404)
    .json(errorBody('ROUTE_NOT_FOUND', `No route for ${req.method} ${req.path}.`));
};

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.status).json(errorBody(error.code, error.message, error.details));
    return;
  }

  // Errors raised by express.json() while reading the request body.
  if (error?.type === 'entity.parse.failed') {
    res.status(400).json(errorBody('INVALID_JSON', 'Request body must be valid JSON.'));
    return;
  }
  if (error?.type === 'entity.too.large') {
    res.status(413).json(errorBody('PAYLOAD_TOO_LARGE', 'Request body is too large.'));
    return;
  }

  console.error(error);
  res.status(500).json(errorBody('INTERNAL_ERROR', 'Something went wrong on our side.'));
};
