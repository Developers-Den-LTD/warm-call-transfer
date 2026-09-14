import type { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 doesn't catch rejected promises from async handlers — an
// unhandled rejection takes the whole process down. Wrap every async route
// with this instead of trusting Express to do it for you.
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
