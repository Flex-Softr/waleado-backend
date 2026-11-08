import type { NextFunction, Request, Response } from "express";

/** Wraps an async route handler so rejected promises reach the error middleware. */
export function asyncHandler<Req extends Request = Request>(
  fn: (req: Req, res: Response) => Promise<void>
) {
  return (req: Req, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}
