import type { NextFunction, Request, Response } from 'express';
import { DomainError } from '@bitgo-agent-wallet/shared';
import { ZodError } from 'zod';

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof DomainError) {
    res.status(err.httpStatus).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.message, issues: err.issues } });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } });
}

export function asyncHandler<Req extends Request>(
  fn: (req: Req, res: Response) => Promise<void>,
) {
  return (req: Req, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}
