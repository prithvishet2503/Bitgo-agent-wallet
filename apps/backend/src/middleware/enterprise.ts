import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from '@bitgo-agent-wallet/shared';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      enterpriseId?: string;
    }
  }
}

/**
 * Resolves which Enterprise a request acts on. An Organization can have more than
 * one Enterprise (see packages/shared/src/types/enterprise.ts), so a user with
 * access to several selects one via the `X-Enterprise-Id` header; omitting it
 * falls back to the user's home enterprise. Every enterprise-scoped route reads
 * `req.enterpriseId`, never `req.user.enterpriseId` directly, so it always
 * respects this selection.
 */
export function resolveEnterprise(req: Request, _res: Response, next: NextFunction): void {
  const requested = req.header('x-enterprise-id');
  const user = req.user!;
  const enterpriseId = requested || user.enterpriseId;
  if (!user.accessibleEnterpriseIds.includes(enterpriseId)) {
    next(new ForbiddenError(`You do not have access to enterprise ${enterpriseId}`));
    return;
  }
  req.enterpriseId = enterpriseId;
  next();
}
