import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from '@bitgo-agent-wallet/shared';
import type { User } from '../store/db.js';
import { userDao } from '../dal/models/user.dao.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

/**
 * Mock bearer-token auth standing in for BitGo's real institutional auth (API keys /
 * OAuth). `authenticate` is one of the required CLI/SDK operations (Section 6.7).
 */
export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  const user = userDao.getByToken(token);
  if (!user) {
    next(new ForbiddenError('Missing or invalid API token. Call authenticate() first.'));
    return;
  }
  req.user = user;
  next();
}

export function requireRole(...roles: User['role'][]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      next(new ForbiddenError(`Requires one of roles: ${roles.join(', ')}`));
      return;
    }
    next();
  };
}
